/**
 * feedbackEmailClassifier.ts
 *
 * Pure classifier for inbound feedback email: bounces, out-of-office replies,
 * departed contacts and genuine replies. A forwarding flow only hands over the
 * raw sender, subject and body of the original message, and this module
 * decides what it is. Keeping that decision in tested code, rather than in
 * nested expressions inside a no-code flow, is the point.
 *
 * No I/O, no DB, no imports from anywhere else in the app: pure text in,
 * classification out.
 *
 * SAFETY RULE (mirrors optOutClassifier.ts's CASL discipline, mirrored the
 * other direction): misclassifying a real reply as a bounce would kill a
 * live prospect, recoverable if it's wrongly called a "reply" (worst case:
 * marked Replied and the sequence stops), catastrophic if a real reply is
 * wrongly called "bounce" or "departed". "reply" is therefore the safe
 * default whenever no stronger signal fires, and every ambiguity resolves
 * away from bounce/departed, never toward them.
 *
 * BOUNCE, specifically, requires a genuine mail-system signal: the sender
 * address/display name indicates a mail system (postmaster, mailer-daemon,
 * microsoftexchange, mailerdaemon), OR the subject indicates non-delivery
 * (undeliverable, delivery has failed, couldn't be delivered, returned mail,
 * delivery status notification, or the French non remis / échec de la
 * remise). Body phrases like "550" or "recipient not found" can appear in a
 * genuine human reply (a prospect quoting an error code, asking why their
 * own mail bounced, etc.), they are corroboration only and can never, by
 * themselves, trigger a bounce classification. Tightened 2026-08-05 after
 * this exact gap was flagged at build time: see job log.
 */

export type ClassifiedFeedbackType = "bounce" | "departed" | "ooo" | "reply" | "unknown";

export interface ClassifyFeedbackEmailResult {
  type: ClassifiedFeedbackType;
  /** departed only, when the body names a specific replacement contact. */
  replacementEmail?: string;
  /** ooo only, ISO date (YYYY-MM-DD) when a return date could be parsed. */
  returnDate?: string;
}

// ─── Normalization ────────────────────────────────────────────────────────────
// Straighten curly quotes, accent-fold (so a pattern written "etre" matches
// both "etre" and "être"), lowercase. Deliberately does NOT strip quoted
// content the way optOutClassifier.normalizeReplyText does for prospect
// replies, an NDR/auto-reply's entire body IS the forwarded original
// message; stripping "quoted" text would throw away the signal we need.

function normalize(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

// ─── Pattern lists ─────────────────────────────────────────────────────────────

// These two groups are the ONLY signals that can trigger a bounce
// classification, see the SAFETY RULE above. A message must carry a
// genuine mail-system signal (sender OR subject) to classify as bounce.
const BOUNCE_SENDER_PATTERNS: RegExp[] = [/postmaster/, /mailer-daemon/, /mailerdaemon/, /microsoftexchange/];

const BOUNCE_SUBJECT_PATTERNS: RegExp[] = [
  /undeliverable/,
  /delivery has failed/,
  /couldn'?t be delivered/,
  /returned mail/,
  /delivery status notification/,
  // French (accent-folded, "échec" normalizes to "echec")
  /non remis/,
  /echec de la remise/,
];

// Corroboration only, see the SAFETY RULE above. These body phrases used to
// be sufficient on their own to trigger "bounce", which is exactly the false
// positive this classifier exists to prevent (a human reply that happens to
// mention "550" or "recipient not found" is not a bounce). They are kept
// here as a named, documented list for readability and any future
// corroboration/logging use, but NONE of them independently sets isBounce,
// only BOUNCE_SENDER_PATTERNS / BOUNCE_SUBJECT_PATTERNS do that.
const BOUNCE_BODY_PATTERNS: RegExp[] = [
  /wasn'?t found at/,
  /\b550\b/,
  /recipient not found/,
  // French (accent-folded, "être" normalizes to "etre")
  /non remis/,
  /n'a pas pu etre remis/,
  /introuvable/,
];

/**
 * "no longer in use" is not a classic departed keyword, but a real auto-reply
 * ("This mailbox is no longer in use, please contact ...") needed it, so it is
 * covered here and pinned by a test.
 */
const DEPARTED_BODY_PATTERNS: RegExp[] = [
  /no longer with/,
  /has left/,
  /no longer employed/,
  /is no longer at/,
  /no longer in use/,
  // French
  /ne travaille plus/,
];

/**
 * Exchange and Outlook prefix machine-generated absence replies with
 * "Automatic reply:". A human does not type that. It is the single most
 * reliable OOO signal there is, and the classifier originally never looked at
 * the subject for OOO at all, only for bounces. Four real auto-replies fell
 * straight through to the "reply" default and had their sequences permanently
 * cancelled.
 */
const OOO_SUBJECT_PATTERNS: RegExp[] = [
  /^\s*(re:\s*)?automatic reply/,
  /^\s*(re:\s*)?auto-?reply/,
  /^\s*(re:\s*)?out of office/,
  // French / Quebec tenants
  /^\s*(re:\s*)?r[ée]ponse automatique/,
];

/**
 * Body phrasings. The originals demanded "out of THE office" and "will
 * return", so "out of office", "away from the office", "I am away",
 * "will be back" and "upon my return" all missed. Every one of those is a
 * phrasing found in a real auto-reply this system misclassified.
 *
 * Deliberately still anchored to absence constructions rather than loose
 * keywords: the failure mode in the other direction (a live prospect's real
 * reply read as an absence, so the cadence keeps emailing them) is its own
 * kind of damage.
 */
const OOO_BODY_PATTERNS: RegExp[] = [
  /out of (the )?office/,
  /away from (the|my) (office|desk)/,
  /(i am|i'm|we are|we're|will be) away/,
  /on vacation/,
  /on (annual|parental|maternity|paternity|sick|medical|extended|study) leave/,
  /will (return|be back)/,
  /upon (my|his|her|their) return/,
  /not (be )?(checking|monitoring|reading) (my )?(e-?mail|messages)/,
  /limited access to (my )?(e-?mail|messages)/,
  // French
  /absent du bureau/,
  /en cong[ée]/,
];

const REPLACEMENT_MARKER_PATTERN = /(please\s+contact|re-?direct|contact)/;
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// ─── Extraction helpers (exported for direct testing) ──────────────────────────

/**
 * Best-effort replacement-contact extraction for a "departed" NDR/auto-reply.
 * Excludes any address matching the original sender itself (an auto-reply
 * quoting its own mailbox address is not a replacement, it's the departed
 * contact we already matched). Prefers the first email appearing after a
 * contact/re-direct marker when there are multiple candidates; falls back to
 * the sole candidate when there's exactly one, which is what all of today's
 * real examples look like.
 */
export function extractReplacementEmail(body: string, originalSender: string): string | undefined {
  const senderLower = (originalSender ?? "").trim().toLowerCase();
  const matches = Array.from((body ?? "").matchAll(EMAIL_PATTERN)).filter((m) => m[0].toLowerCase() !== senderLower);
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0][0].toLowerCase();

  const markerMatch = normalize(body ?? "").match(REPLACEMENT_MARKER_PATTERN);
  if (markerMatch && markerMatch.index !== undefined) {
    const after = matches.find((m) => (m.index ?? 0) >= markerMatch.index!);
    if (after) return after[0].toLowerCase();
  }
  return matches[0][0].toLowerCase();
}

const MONTH_NAMES: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

const ISO_DATE_PATTERN = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const MONTH_DAY_YEAR_PATTERN =
  /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i;
const NUMERIC_DATE_PATTERN = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/;
const MONTH_DAY_PATTERN =
  /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i;

/**
 * Build an ISO (YYYY-MM-DD) string from explicit UTC components, validating
 * that the day didn't overflow (e.g. Feb 30 rolling into March). Using
 * Date.UTC explicitly, rather than `new Date(dateString)`, sidesteps the
 * JS Date constructor's local-timezone parsing of non-ISO date strings,
 * which can shift the calendar day by ±1 depending on the runtime's TZ.
 */
function isoFromUtc(year: number, monthIndex: number, day: number): string | undefined {
  if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) return undefined;
  const d = new Date(Date.UTC(year, monthIndex, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== monthIndex || d.getUTCDate() !== day) return undefined;
  return d.toISOString().slice(0, 10);
}

/**
 * Best-effort OOO return-date extraction. Requires a full date INCLUDING a
 * year, a bare "back Monday" or "return August 10" with no year is
 * deliberately left unparsed rather than guessing which year is meant.
 * Returns undefined (never throws) when nothing parseable is found.
 */
export function extractReturnDate(body: string): string | undefined {
  const text = body ?? "";

  const iso = text.match(ISO_DATE_PATTERN);
  if (iso) {
    const result = isoFromUtc(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    if (result) return result;
  }

  const monthDayYear = text.match(MONTH_DAY_YEAR_PATTERN);
  if (monthDayYear) {
    const monthIndex = MONTH_NAMES[monthDayYear[1].toLowerCase()];
    if (monthIndex !== undefined) {
      const result = isoFromUtc(Number(monthDayYear[3]), monthIndex, Number(monthDayYear[2]));
      if (result) return result;
    }
  }

  // Month + day with NO year, "back August 24", "returning Tuesday,
  // September 1". Originally refused outright rather than guess the year.
  // In practice almost every auto-reply omits the year, so refusing meant
  // the OOO push never fired and the feature was decorative.
  //
  // Resolved to the NEXT occurrence from today, accepted only if it lands
  // within 300 days, so a December reply naming "January 5" rolls forward
  // correctly, and a stale date cannot push a touch a year into the future.
  const monthDayOnly = text.match(MONTH_DAY_PATTERN);
  if (monthDayOnly) {
    const monthIndex = MONTH_NAMES[monthDayOnly[1].toLowerCase()];
    const day = Number(monthDayOnly[2]);
    if (monthIndex !== undefined) {
      const now = new Date();
      for (const year of [now.getUTCFullYear(), now.getUTCFullYear() + 1]) {
        const candidate = isoFromUtc(year, monthIndex, day);
        if (!candidate) continue;
        const deltaDays = (Date.parse(candidate + "T00:00:00Z") - now.getTime()) / 86400000;
        if (deltaDays >= -1 && deltaDays <= 300) return candidate;
      }
    }
  }

  // M/D/Y, North American convention, matching the rest of the codebase's en-CA usage.
  const numeric = text.match(NUMERIC_DATE_PATTERN);
  if (numeric) {
    const result = isoFromUtc(Number(numeric[3]), Number(numeric[1]) - 1, Number(numeric[2]));
    if (result) return result;
  }

  return undefined;
}

// ─── Classifier ────────────────────────────────────────────────────────────────

/**
 * Classify a forwarded feedback email. Pure, no I/O, never throws.
 * Precedence: bounce > departed > ooo > reply (default) > unknown (only
 * when there is nothing at all to classify, see the file header's safety
 * rule for why "reply" and not "bounce"/"departed" is the fallback for
 * everything else).
 */
export function classifyFeedbackEmail(from: string, subject: string, body: string): ClassifyFeedbackEmailResult {
  const rawFrom = from ?? "";
  const rawBody = body ?? "";
  const nFrom = normalize(rawFrom);
  const nSubject = normalize(subject ?? "");
  const nBody = normalize(rawBody);

  if (nFrom.trim().length === 0 && nBody.trim().length === 0) {
    return { type: "unknown" };
  }

  // Bounce requires a genuine mail-system signal, sender OR subject.
  // BOUNCE_BODY_PATTERNS is deliberately NOT part of this check: body
  // keywords alone (e.g. a human reply that quotes "550") must never be
  // sufficient to classify as bounce. See the SAFETY RULE above.
  const isBounce =
    BOUNCE_SENDER_PATTERNS.some((p) => p.test(nFrom)) || BOUNCE_SUBJECT_PATTERNS.some((p) => p.test(nSubject));
  if (isBounce) return { type: "bounce" };

  const isDeparted = DEPARTED_BODY_PATTERNS.some((p) => p.test(nBody));
  if (isDeparted) {
    return { type: "departed", replacementEmail: extractReplacementEmail(rawBody, rawFrom) };
  }

  // Subject first: "Automatic reply:" is machine-generated and unambiguous.
  // Checked AFTER departed on purpose, a "no longer with the company"
  // auto-reply also carries that subject, and departed must win.
  const isOoo =
    OOO_SUBJECT_PATTERNS.some((p) => p.test(nSubject)) || OOO_BODY_PATTERNS.some((p) => p.test(nBody));
  if (isOoo) {
    return { type: "ooo", returnDate: extractReturnDate(rawBody) };
  }

  return { type: "reply" };
}
