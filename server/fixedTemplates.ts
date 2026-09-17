/**
 * fixedTemplates.ts
 *
 * Fixed per-campaign email sequences: the template engine behind manual
 * contact intake and bulk loading.
 *
 * Templates live on `campaigns.sequenceConfigJsonOverride`. That column was
 * earmarked at the holding-tanks build as the campaign-level sequence config
 * and until now was read by NOTHING (followUpCadence.ts:44-58 documents it as
 * storage-only). This module defines its first real shape. A campaign row with
 * `{"type":"fixed-templates",...}` gets fixed copy expanded per contact at add
 * time; any other value (null, "[]", legacy blobs) is ignored, parse returns
 * null and callers fall back to "no templates on this campaign".
 *
 * Conventions enforced here, matching followUpCadence.ts:
 *   - `dayNumber` is a TOUCH INDEX (1..N, N <= 5), never a calendar offset.
 *     The +2/+2/+4/+4 re-anchor table is keyed by consecutive touch numbers
 *     and silently skips anything else.
 *   - Personalization is baked at insert time ({{firstName}}, {{company}}).
 *     The send path has no interpolation, a leftover placeholder would be
 *     emailed literally, so buildSequenceRows throws on unresolved tokens.
 */
import { z } from "zod";

// ── Config shape ─────────────────────────────────────────────────────────────

const touchSchema = z.object({
  subject: z.string().min(1),
  body: z.string().min(1),
});

const fixedTemplatesSchema = z.object({
  type: z.literal("fixed-templates"),
  /** Touch-1s released into the queue per calendar day when a batch is added. */
  batchPerDay: z.number().int().min(1).max(50).default(8),
  /**
   * Provisional gap (days) between touch 1 and each later touch, used only for
   * the initial scheduledDate. Real dates come from send-time re-anchoring.
   */
  provisionalOffsets: z.record(z.string(), z.number()).optional(),
  /** Copy tracks. Contacts at the same account alternate A/B by add order. */
  tracks: z.object({
    A: z.array(touchSchema).min(1).max(5),
    B: z.array(touchSchema).min(1).max(5),
  }),
});

export type FixedTemplateConfig = z.infer<typeof fixedTemplatesSchema>;
export type TemplateTrack = "A" | "B";

export const DEFAULT_PROVISIONAL_OFFSETS: Record<number, number> = { 1: 0, 2: 2, 3: 4, 4: 8, 5: 16 };

// ── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Parse a campaign's sequenceConfigJsonOverride into a template config.
 * Returns null for null/empty/legacy/other-shaped values, callers treat that
 * as "this campaign has no fixed templates", never as an error.
 */
export function parseFixedTemplates(json: string | null | undefined): FixedTemplateConfig | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = fixedTemplatesSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// ── Interpolation ────────────────────────────────────────────────────────────

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function interpolate(text: string, fields: Record<string, string>): string {
  return text.replace(PLACEHOLDER_RE, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : match,
  );
}

/** Any {{tokens}} left after interpolation, these would be sent literally. */
export function findUnresolvedPlaceholders(text: string): string[] {
  const found: string[] = [];
  text.replace(PLACEHOLDER_RE, (match, key: string) => {
    found.push(key);
    return match;
  });
  return found;
}

// ── Assignment & scheduling ──────────────────────────────────────────────────

/** Contacts at the same account alternate tracks by how many exist already. */
export function trackForContactIndex(existingContactCount: number): TemplateTrack {
  return existingContactCount % 2 === 0 ? "A" : "B";
}

/** Which day (0-based) a batch member's touch 1 lands on, at batchPerDay a day. */
export function staggerDayForIndex(indexInBatch: number, batchPerDay: number): number {
  return Math.floor(indexInBatch / Math.max(1, batchPerDay));
}

// ── Row building ─────────────────────────────────────────────────────────────

export type SequenceRow = {
  dayNumber: number; // touch index 1..N
  subject: string;
  body: string;
  scheduledDate: Date;
  touch: string; // display label, "Touch N"
};

/**
 * Expand one track of a template config into insert-ready outreach_emails
 * fields for one contact. Throws if any placeholder survives interpolation,
 * a template asking for a field we don't have must fail loudly at add time,
 * not send literally later.
 */
export function buildSequenceRows(
  config: FixedTemplateConfig,
  track: TemplateTrack,
  fields: { firstName: string; company: string },
  touch1Date: Date,
): SequenceRow[] {
  const touches = config.tracks[track];
  const offsets = { ...DEFAULT_PROVISIONAL_OFFSETS };
  for (const [k, v] of Object.entries(config.provisionalOffsets ?? {})) {
    offsets[Number(k)] = v;
  }

  return touches.map((tpl, i) => {
    const dayNumber = i + 1; // touch index, see module header
    const subject = interpolate(tpl.subject, fields);
    const body = interpolate(tpl.body, fields);
    // Well-formed leftovers, plus any stray "{{" a malformed token would
    // leave behind ("{{ firstName" never matches the placeholder pattern, so
    // it interpolates to nothing and would otherwise be emailed literally).
    const leftovers = [...findUnresolvedPlaceholders(subject), ...findUnresolvedPlaceholders(body)];
    if (subject.includes("{{") || body.includes("{{")) {
      leftovers.push("malformed token");
    }
    if (leftovers.length > 0) {
      throw new Error(
        `Template track ${track} touch ${dayNumber} has unresolved placeholders: ${leftovers.join(", ")}`,
      );
    }
    const offsetDays = (offsets[dayNumber] ?? 0) - (offsets[1] ?? 0);
    return {
      dayNumber,
      subject,
      body,
      scheduledDate: new Date(touch1Date.getTime() + offsetDays * 86_400_000),
      touch: `Touch ${dayNumber}`,
    };
  });
}

/** First name for interpolation, same derivation the loaders use. */
export function firstNameOf(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? "";
}
