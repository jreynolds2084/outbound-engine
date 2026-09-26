/**
 * sendGovernor.ts
 *
 * Volume policy: the ceiling on how much a tenant may send per day, how that
 * ceiling ramps up when a sending configuration is new, and how many new
 * contacts may enter the queue per month.
 *
 * ── Why this module exists ───────────────────────────────────────────────
 * Outreach volume compounds. Each contact receives several touches, so daily
 * send volume is a multiple of the number of new contacts added, not equal to
 * it: at a four-touch sequence, adding 40 contacts a day settles at roughly
 * 160 emails a day, not 40. Sustained volume above roughly 100 a day from one
 * mailbox degrades sender reputation, and that damage lands on the tenant's
 * ordinary business mail — invoices, quotes, client correspondence — not only
 * on outreach. Client agreements therefore state a daily ceiling and a ramp.
 *
 * Before this module the only per-day number in the codebase was
 * `fixedTemplates.batchPerDay`, which staggers TOUCH-1 STARTS when a batch is
 * added and knows nothing about the follow-ups those starts generate over the
 * following fortnight. `followUpCadence` re-anchors those follow-ups with no
 * volume awareness at all. Nothing counted total sends, so the only thing
 * holding a tenant under its contractual ceiling was the rep choosing not to
 * click approve.
 *
 * ── A brake, not an engine ───────────────────────────────────────────────
 * Same discipline as `campaigns.bounceCircuitBroken`: nothing here sends,
 * queues, cancels or reschedules anything. `computeSendAllowance` reports a
 * ceiling and `selectSendable` splits a due list into "may go now" and
 * "waits". Deferred touches keep their rows and their scheduledDate untouched,
 * so they surface again on the next run. The caller decides what to do.
 *
 * ── Priority under a ceiling ─────────────────────────────────────────────
 * When more is due than the ceiling allows, follow-up touches (dayNumber > 1)
 * go before first touches. A deferred first touch costs nothing — the contact
 * has not been contacted and their cadence has not started. A deferred
 * follow-up is a contact mid-sequence going quiet, which is the one thing the
 * queue exists to prevent. Within each class, oldest scheduledDate first, so
 * nothing starves.
 *
 * Pure and DB-free apart from the two thin helpers at the bottom, so the
 * policy is unit-testable without a live database.
 */
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { contacts, outreachEmails, tenants } from "../drizzle/schema";
import { getDb } from "./db";
import { z } from "zod";

/**
 * The zone every window is measured in. A daily cap counted in UTC resets at
 * 16:00 or 17:00 Pacific, mid-afternoon, which hands a tenant two partial
 * allowances in one working day and defeats the point. Matches the
 * `America/Vancouver` precedent in callScheduler.ts; passed as a parameter
 * everywhere so a per-tenant zone column can feed it later without touching
 * this module.
 */
export const DEFAULT_TIME_ZONE = "America/Vancouver";

// ── Policy shape ─────────────────────────────────────────────────────────────

const rampStepSchema = z.object({
  /** First day of the ramp this step applies to, 1-based and inclusive. */
  fromDay: z.number().int().min(1),
  /** Emails allowed per day while this step is in force. */
  ceiling: z.number().int().min(0),
});

const sendPolicySchema = z.object({
  type: z.literal("send-policy"),
  /** Steady-state ceiling on outreach emails per zoned calendar day, tenant-wide. */
  dailyEmailCeiling: z.number().int().min(1),
  /** Ceiling on new contacts entering the queue per zoned calendar month. */
  monthlyContactCeiling: z.number().int().min(1),
  /**
   * Ascending ramp steps. Omitted means no ramp: the steady-state ceiling
   * applies from day one. Each step's ceiling is clamped to
   * `dailyEmailCeiling`, so a policy can never ramp above its own limit.
   */
  ramp: z.array(rampStepSchema).optional(),
  /** IANA zone the daily and monthly windows are measured in. */
  timeZone: z.string().min(1).default(DEFAULT_TIME_ZONE),
});

export type SendPolicy = z.infer<typeof sendPolicySchema>;
export type RampStep = z.infer<typeof rampStepSchema>;

/**
 * The default ramp: a new sending configuration builds volume over about
 * three weeks rather than starting at full rate. Expressed as fractions of
 * the steady-state ceiling so one table serves any ceiling.
 *
 * At a 100/day ceiling this reads: 20 a day for the first three days, then
 * 35, 50, 70, 85, and full rate from day 18.
 */
export const DEFAULT_RAMP_FRACTIONS: ReadonlyArray<{ fromDay: number; fraction: number }> = Object.freeze([
  { fromDay: 1, fraction: 0.2 },
  { fromDay: 4, fraction: 0.35 },
  { fromDay: 8, fraction: 0.5 },
  { fromDay: 11, fraction: 0.7 },
  { fromDay: 15, fraction: 0.85 },
  { fromDay: 18, fraction: 1 },
]);

/** The default ramp expressed as absolute ceilings for a given steady-state ceiling. */
export function defaultRampFor(dailyEmailCeiling: number): RampStep[] {
  return DEFAULT_RAMP_FRACTIONS.map((step) => ({
    fromDay: step.fromDay,
    // Round up, never below 1: a ramp step of 0 would stall the queue entirely.
    ceiling: Math.max(1, Math.ceil(dailyEmailCeiling * step.fraction)),
  }));
}

/**
 * Parse `tenants.sendPolicyJson`.
 *
 * Returns null for null, empty, malformed or other-shaped values. Callers MUST
 * treat null as "this tenant is ungoverned" and NOT substitute a default:
 * quietly throttling a tenant that was never configured for a ceiling would
 * change behaviour for every existing row the moment this column shipped, and
 * the column's whole point is that it changes nothing until set. Ungoverned
 * tenants are surfaced by `reporting.ts` (`ungovernedTenants`) so the gap is
 * visible rather than silent.
 */
export function parseSendPolicy(json: string | null | undefined): SendPolicy | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = sendPolicySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// ── Zoned windows ────────────────────────────────────────────────────────────

/**
 * The offset of `timeZone` from UTC at `instant`, in milliseconds, positive
 * when the zone is ahead of UTC. Derived by formatting the instant in the zone
 * and reading the wall-clock back, which is correct across DST without a
 * library.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(instant);
  const read = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  // en-CA with hour12:false emits hour 24 for midnight in some engines.
  const hour = read("hour") % 24;
  const wallClockAsUtc = Date.UTC(read("year"), read("month") - 1, read("day"), hour, read("minute"), read("second"));
  return wallClockAsUtc - instant.getTime();
}

/** The zoned calendar date of `instant`, as {year, month (1-12), day}. */
export function zonedCalendarDate(instant: Date, timeZone: string = DEFAULT_TIME_ZONE): {
  year: number;
  month: number;
  day: number;
} {
  const shifted = new Date(instant.getTime() + zoneOffsetMs(instant, timeZone));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/**
 * Turn a zoned wall-clock midnight into the UTC instant it happened at.
 * The offset is resolved twice because the offset at the midnight itself can
 * differ from the offset at the reference instant when a DST change falls
 * between them.
 */
function zonedMidnightToUtc(year: number, month: number, day: number, timeZone: string): Date {
  const wallClockAsUtc = Date.UTC(year, month - 1, day);
  const firstGuess = new Date(wallClockAsUtc - zoneOffsetMs(new Date(wallClockAsUtc), timeZone));
  const settledOffset = zoneOffsetMs(firstGuess, timeZone);
  return new Date(wallClockAsUtc - settledOffset);
}

/** Half-open [start, end) window, the convention every count below uses. */
export interface TimeWindow {
  start: Date;
  end: Date;
}

/** The zoned calendar day containing `instant`, as a UTC half-open window. */
export function zonedDayWindow(instant: Date, timeZone: string = DEFAULT_TIME_ZONE): TimeWindow {
  const { year, month, day } = zonedCalendarDate(instant, timeZone);
  const start = zonedMidnightToUtc(year, month, day, timeZone);
  // Add 26h to the wall-clock date and re-derive, so a 23h or 25h DST day
  // still resolves to the following calendar date's midnight.
  const nextDay = new Date(Date.UTC(year, month - 1, day) + 26 * 60 * 60 * 1000);
  const end = zonedMidnightToUtc(nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate(), timeZone);
  return { start, end };
}

/** The zoned calendar month containing `instant`, as a UTC half-open window. */
export function zonedMonthWindow(instant: Date, timeZone: string = DEFAULT_TIME_ZONE): TimeWindow {
  const { year, month } = zonedCalendarDate(instant, timeZone);
  const start = zonedMidnightToUtc(year, month, 1, timeZone);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const end = zonedMidnightToUtc(nextYear, nextMonth, 1, timeZone);
  return { start, end };
}

/**
 * Which day of the ramp `now` falls on, 1-based: the ramp start day is day 1.
 * Counted in zoned calendar days, not elapsed hours, so a go-live at 16:00
 * does not make day 2 begin eight hours later.
 */
export function rampDayIndex(rampStartedAt: Date, now: Date, timeZone: string = DEFAULT_TIME_ZONE): number {
  const startDay = zonedDayWindow(rampStartedAt, timeZone).start.getTime();
  const currentDay = zonedDayWindow(now, timeZone).start.getTime();
  const days = Math.round((currentDay - startDay) / (24 * 60 * 60 * 1000));
  // A `now` before the ramp start is day 1, never day 0 or negative: the most
  // conservative ceiling is the right answer for a clock we don't trust.
  return Math.max(1, days + 1);
}

// ── Daily email allowance ────────────────────────────────────────────────────

export interface SendAllowance {
  /** Emails permitted in this zoned day in total. */
  ceiling: number;
  /** Emails already counted against that ceiling. */
  used: number;
  /** Emails that may still go out today. Never negative. */
  remaining: number;
  /** True when nothing more may send today. */
  exhausted: boolean;
  /** Which ramp day this is, or null when the tenant is at steady state. */
  rampDay: number | null;
  /** The steady-state ceiling, for reporting how far into the ramp a tenant is. */
  steadyStateCeiling: number;
}

/**
 * The ceiling in force on a given ramp day. The highest step whose `fromDay`
 * has been reached wins; a day before the first step falls back to that first
 * step. Every step is clamped to the steady-state ceiling, so a mis-entered
 * ramp can never authorise more than the policy's own limit.
 */
export function ceilingForRampDay(policy: SendPolicy, rampDay: number): number {
  const ramp = policy.ramp;
  if (!ramp || ramp.length === 0) return policy.dailyEmailCeiling;
  const sorted = [...ramp].sort((a, b) => a.fromDay - b.fromDay);
  let applicable = sorted[0];
  for (const step of sorted) {
    if (step.fromDay <= rampDay) applicable = step;
    else break;
  }
  return Math.min(applicable.ceiling, policy.dailyEmailCeiling);
}

/**
 * How much this tenant may still send today.
 *
 * `rampStartedAt` is the tenant's go-live: the first day approved outreach was
 * released from their domain. Null means no ramp is being tracked and the
 * steady-state ceiling applies — a tenant already sending at full rate does
 * not get thrown back to day 1 because this column arrived.
 *
 * `sentToday` counts every outreach email already sent in this zoned day.
 * `additionalCountedSends` lets the caller add volume this module cannot see —
 * replyAgent responses to prospects, or a second mailbox counted elsewhere —
 * because sender reputation is built from what actually left the domain, not
 * from what the outreach table happens to record.
 */
export function computeSendAllowance(params: {
  policy: SendPolicy;
  rampStartedAt: Date | null;
  now: Date;
  sentToday: number;
  additionalCountedSends?: number;
}): SendAllowance {
  const { policy, rampStartedAt, now, sentToday } = params;
  const rampDay = rampStartedAt ? rampDayIndex(rampStartedAt, now, policy.timeZone) : null;
  const ceiling = rampDay === null ? policy.dailyEmailCeiling : ceilingForRampDay(policy, rampDay);
  const used = Math.max(0, sentToday) + Math.max(0, params.additionalCountedSends ?? 0);
  const remaining = Math.max(0, ceiling - used);
  const steppedRamp = rampDay !== null && ceiling < policy.dailyEmailCeiling;
  return {
    ceiling,
    used,
    remaining,
    exhausted: remaining === 0,
    rampDay: steppedRamp ? rampDay : null,
    steadyStateCeiling: policy.dailyEmailCeiling,
  };
}

// ── Selecting what may send ──────────────────────────────────────────────────

/** Minimal shape this module needs from a due outreach_emails row. */
export interface SendCandidate {
  id: number;
  dayNumber: number;
  scheduledDate: Date;
}

export interface SendSelection<T extends SendCandidate> {
  /** May send now, in the order they should be released. */
  allowed: T[];
  /** Held back by the ceiling. Rows and dates untouched; they resurface next run. */
  deferred: T[];
}

/**
 * Split the due list at the ceiling.
 *
 * Follow-ups (dayNumber > 1) first, then first touches; oldest scheduledDate
 * first within each class, with `id` as the tiebreak so the order is stable
 * across runs and two candidates scheduled to the same millisecond cannot
 * swap places between calls.
 *
 * `remaining` of 0 defers everything. A ceiling is never exceeded to squeeze
 * one more touch through, because the cost of overreaching lands on the
 * tenant's domain reputation rather than on this queue.
 */
export function selectSendable<T extends SendCandidate>(candidates: T[], remaining: number): SendSelection<T> {
  const ordered = [...candidates].sort((a, b) => {
    const aFollowUp = a.dayNumber > 1 ? 0 : 1;
    const bFollowUp = b.dayNumber > 1 ? 0 : 1;
    if (aFollowUp !== bFollowUp) return aFollowUp - bFollowUp;
    const byDate = a.scheduledDate.getTime() - b.scheduledDate.getTime();
    if (byDate !== 0) return byDate;
    return a.id - b.id;
  });
  const cut = Math.max(0, Math.min(remaining, ordered.length));
  return { allowed: ordered.slice(0, cut), deferred: ordered.slice(cut) };
}

// ── Monthly contact allowance ────────────────────────────────────────────────

export interface ContactAllowance {
  ceiling: number;
  used: number;
  remaining: number;
  exhausted: boolean;
  /** How many of `requested` may be added now. */
  grant: number;
  /** How many of `requested` must wait for next month. */
  withheld: number;
}

/**
 * How many of `requested` new contacts may enter the queue this zoned month.
 *
 * Partial grants are deliberate: a list-building run that would take a tenant
 * from 480 to 520 loads 20 and reports 20 withheld, rather than failing whole
 * and loading nothing.
 */
export function computeContactAllowance(params: {
  policy: SendPolicy;
  addedThisMonth: number;
  requested: number;
}): ContactAllowance {
  const ceiling = params.policy.monthlyContactCeiling;
  const used = Math.max(0, params.addedThisMonth);
  const remaining = Math.max(0, ceiling - used);
  const requested = Math.max(0, params.requested);
  const grant = Math.min(requested, remaining);
  return {
    ceiling,
    used,
    remaining,
    exhausted: remaining === 0,
    grant,
    withheld: requested - grant,
  };
}

/**
 * Whether a sequence of `touchesPerContact` touches is sustainable at
 * `monthlyContactCeiling` under `dailyEmailCeiling`.
 *
 * Exists because the two ceilings in a service agreement are usually written
 * down independently and are only compatible at certain sequence lengths. At
 * 500 contacts a month and 100 emails a day, a four-touch sequence settles at
 * about 95 a day and fits; a five-touch sequence settles at about 119 and does
 * not. Whoever agrees the sequence during implementation should be told which
 * one they just picked, before the mismatch turns up as a throttled queue in
 * month two.
 */
export function checkPolicyCoherence(
  policy: SendPolicy,
  touchesPerContact: number,
  workingDaysPerMonth = 21,
): { sustainable: boolean; impliedEmailsPerDay: number; headroom: number } {
  const perDay = (policy.monthlyContactCeiling * touchesPerContact) / Math.max(1, workingDaysPerMonth);
  const impliedEmailsPerDay = Math.ceil(perDay);
  return {
    sustainable: impliedEmailsPerDay <= policy.dailyEmailCeiling,
    impliedEmailsPerDay,
    headroom: policy.dailyEmailCeiling - impliedEmailsPerDay,
  };
}

// ── DB-backed helpers ────────────────────────────────────────────────────────

/** Outreach emails this tenant has sent in the zoned day containing `now`. */
export async function countSentInDay(tenantId: number, now: Date, timeZone: string = DEFAULT_TIME_ZONE): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const { start, end } = zonedDayWindow(now, timeZone);
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(outreachEmails)
    .where(
      and(
        eq(outreachEmails.tenantId, tenantId),
        eq(outreachEmails.status, "Sent"),
        gte(outreachEmails.sentAt, start),
        lt(outreachEmails.sentAt, end),
      ),
    );
  return Number(rows[0]?.count ?? 0);
}

/** Contacts created for this tenant in the zoned month containing `now`. */
export async function countContactsAddedInMonth(
  tenantId: number,
  now: Date,
  timeZone: string = DEFAULT_TIME_ZONE,
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const { start, end } = zonedMonthWindow(now, timeZone);
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), gte(contacts.createdAt, start), lt(contacts.createdAt, end)))
    .limit(1);
  return Number(rows[0]?.count ?? 0);
}

/**
 * Read a tenant's policy and today's usage and return the allowance.
 *
 * Returns null when the tenant has no policy configured, which callers must
 * distinguish from an exhausted allowance: null is "no ceiling was ever set
 * for this tenant", not "nothing may send". Both are worth logging, for
 * opposite reasons.
 */
export async function getSendAllowance(
  tenantId: number,
  now: Date = new Date(),
): Promise<SendAllowance | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select({ sendPolicyJson: tenants.sendPolicyJson, goLiveAt: tenants.goLiveAt })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  const policy = parseSendPolicy(rows[0]?.sendPolicyJson);
  if (!policy) return null;
  const sentToday = await countSentInDay(tenantId, now, policy.timeZone);
  return computeSendAllowance({ policy, rampStartedAt: rows[0]?.goLiveAt ?? null, now, sentToday });
}
