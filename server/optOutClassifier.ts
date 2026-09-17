/**
 * optOutClassifier.ts
 * ───────────────────
 * CASL opt-out detection for inbound prospect replies (Tier 1: regex).
 *
 * ⚠️ COMPLIANCE-CRITICAL DESIGN RULE (Canadian CASL law):
 * Opt-out detection MAY over-trigger; it must NEVER under-trigger.
 * Every ambiguity in this module is resolved toward suppression.
 * A false positive costs one prospect. A false negative is a legal violation.
 *
 * All patterns are matched against NORMALIZED text (see normalizeReplyText):
 *   1. Quoted original message stripped (top segment only), prevents our own
 *      footer's "unsubscribe" from triggering a false opt-out.
 *   2. Whitespace collapsed to single spaces, patterns match across line breaks.
 *   3. Accent-folded and lowercased, one unaccented pattern matches both
 *      "pas intéressé" and "pas interesse".
 *   4. Curly apostrophes/quotes straightened, "don’t" matches /don'?t/.
 *
 * Classifications:
 *   OptOut   → suppress the contact, cancel all pending touches, confirm, stop.
 *   Referral → "wrong person", do NOT suppress, do NOT auto-pitch; human review.
 *   NotNow   → timing deferral, do NOT suppress, do NOT auto-pitch; human review.
 *   None     → no Tier-1 signal; caller falls through to the Tier-2 LLM backstop.
 */

export type ReplyClassification = "OptOut" | "Referral" | "NotNow" | "None";

// ─── Normalization pipeline ──────────────────────────────────────────────────

/** Markers that begin a quoted original message in a reply body. */
const QUOTE_SPLIT = /^(?:On .+ wrote:|-----Original Message-----|_{10,}|From: )/m;

/**
 * Normalize a raw reply body for pattern matching:
 * strip quoted original → straighten curly quotes → accent-fold → lowercase
 * → collapse whitespace → trim.
 */
export function normalizeReplyText(body: string): string {
  const topSegment = body.split(QUOTE_SPLIT)[0] ?? "";
  return topSegment
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Tier-1 pattern lists (exported for tests) ───────────────────────────────
// All patterns assume normalized input: lowercase, accent-folded, single-spaced.

/** English opt-out patterns. Any match → OptOut. */
export const OPT_OUT_PATTERNS_EN: RegExp[] = [
  /\bunsubscribe\b/,
  /\bopt.?out\b/,
  /\bopt\s+me\s+out\b/,
  /\bremove\s+me\b/,
  /\bstop\s+emailing\b/,
  /\bstop\s+sending\b/,
  /\bquit\s+emailing\b/,
  /\bdo\s+not\s+contact\b/,
  /\bdon'?t\s+contact\b/,
  /\bnever\s+contact\b/,
  /\bdon'?t\s+email\s+me\b/,
  /\bplease\s+remove\b/,
  /\btake\s+me\s+off\b/,
  /\btake\s+my\s+name\s+off\b/,
  /\bdelete\s+my\s+(email|address|info)\b/,
  /\blose\s+my\s+number\b/,
  /\bno\s+longer\s+wish\b/,
  /\bdo\s+not\s+send\b/,
  /\bstop\s+contacting\b/,
  /\bstop\s+reaching\s+out\b/,
  /\bno\s+more\s+emails?\b/,
  /\bplease\s+stop\b/,
  /\bleave\s+me\s+alone\b/,
  /\bnot\s+interested\b/,
  /\bno\s+interest\b/,
  /\bnot\s+a\s+fit\b/,
  /\bnot\s+the\s+right\s+fit\b/,
  /\bwe\s+don'?t\s+need\b/,
  /\bno\s+thank\s+you\b/,
  /\bno\s+thanks\b/,
];

/**
 * French opt-out patterns. Matched against accent-folded text, so all patterns
 * are written unaccented ("desabonn" matches "Désabonnez-moi").
 */
export const OPT_OUT_PATTERNS_FR: RegExp[] = [
  /desabonn/,
  /retirez[- ]moi/,
  /enlevez[- ]moi/,
  /pas\s+interess/,
  /aucun\s+inter[ei]t/,
  /ne\s+(me\s+|nous\s+)?contactez\s+plus/,
  /cessez\s+de/,
  /arret(ez|er)/,
  /plus\s+de\s+courriels?/,
  /\bnon\s+merci\b/,
];

/** Combined opt-out list (exported for tests). */
export const OPT_OUT_PATTERNS: RegExp[] = [...OPT_OUT_PATTERNS_EN, ...OPT_OUT_PATTERNS_FR];

/**
 * Bare "stop", the entire (normalized) top segment is just the word stop,
 * optionally followed by punctuation. Anchored so "Can you stop by our
 * office?" does not trip it.
 */
export const BARE_STOP_PATTERN = /^\s*stop\W*$/;

/**
 * Referral patterns, prospect is redirecting to someone else.
 * Must NOT suppress (the redirect target may be a legitimate lead) and must
 * NOT auto-pitch the wrong person. Routed to human review.
 */
export const REFERRAL_PATTERNS: RegExp[] = [
  /\bwrong\s+person\b/,
  /\bnot\s+the\s+right\s+person\b/,
  /mauvaise\s+personne/,
];

/**
 * "not looking (for|at|to)" is an opt-out UNLESS a time qualifier is present
 * ("not looking to switch until Q3" is a deferral, not a removal request).
 */
export const NOT_LOOKING_PATTERN = /\bnot\s+looking\s+(for|at|to)\b/;
export const TIME_QUALIFIER_PATTERN =
  /\b(until|till|before|q[1-4]|next\s+(year|quarter|month))\b/;

/** Explicit timing-deferral phrases → NotNow (human review, no pitch, no suppress). */
export const NOT_NOW_PATTERNS: RegExp[] = [
  /\bnot\s+right\s+now\b/,
  /\bcheck\s+back\b/,
  /\bcircle\s+back\b/,
];

// ─── Tier-1 classifier ───────────────────────────────────────────────────────

/**
 * Classify a raw reply body using the Tier-1 regex patterns.
 * Precedence is deliberate and biased toward suppression:
 * OptOut > Referral > NotNow > None.
 */
export function classifyReply(body: string): ReplyClassification {
  const text = normalizeReplyText(body);
  if (text.length === 0) return "None";

  if (OPT_OUT_PATTERNS.some((p) => p.test(text))) return "OptOut";
  if (BARE_STOP_PATTERN.test(text)) return "OptOut";

  // "not looking ...", opt-out unless a time qualifier turns it into a deferral
  if (NOT_LOOKING_PATTERN.test(text)) {
    return TIME_QUALIFIER_PATTERN.test(text) ? "NotNow" : "OptOut";
  }

  if (REFERRAL_PATTERNS.some((p) => p.test(text))) return "Referral";
  if (NOT_NOW_PATTERNS.some((p) => p.test(text))) return "NotNow";

  return "None";
}

/** True when the reply is a CASL opt-out request (Tier-1 regex). */
export function isOptOut(body: string): boolean {
  return classifyReply(body) === "OptOut";
}
