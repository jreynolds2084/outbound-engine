/**
 * reporting.ts
 *
 * The monthly service report: what was loaded, what was queued, what was sent,
 * and — the one that actually matters — whether anybody fell out of cadence.
 *
 * ── Why "none dropped" needs code ────────────────────────────────────────
 * A service agreement's commitments are usually about the system's output
 * rather than the client's close rate: contacts loaded, sequences queued,
 * every prospect resurfaced on cadence with none dropped, a queue that stays
 * current. Three of those four are counts. The fourth is a claim that nothing
 * went quiet, and there is no way to make that claim honestly by looking at a
 * queue, because a contact who fell out of cadence is invisible precisely
 * BECAUSE nothing is happening to them. They have to be searched for.
 *
 * `findStalledTouches` is that search: Pending touches whose scheduledDate has
 * passed by more than a grace period. Everything else here is arithmetic.
 *
 * ── Stalled is not the same as stopped ───────────────────────────────────
 * A contact who replied, bounced, opted out or was marked unreachable is
 * SUPPOSED to have pending touches sitting untouched forever — `bounceShared`
 * and the reply path deliberately leave those rows alone rather than deleting
 * them. Counting those as drops would make every healthy month look broken, so
 * `findStalledTouches` takes the contact's status and excludes the terminal
 * ones.
 *
 * Nor is stalled the same as throttled. A touch held back by the volume
 * ceiling in sendGovernor.ts is overdue by design and will go out as soon as
 * the ceiling allows. Callers pass those ids in `excludeIds` so a deliberate
 * deferral is never reported as a dropped prospect.
 *
 * Pure apart from the DB-backed builder at the bottom.
 */
import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { contacts, outreachEmails, tenants } from "../drizzle/schema";
import { getDb } from "./db";
import { parseSendPolicy, zonedMonthWindow, DEFAULT_TIME_ZONE, type TimeWindow } from "./sendGovernor";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far past its scheduledDate a Pending touch may sit before it counts as
 * stalled.
 *
 * Three days, not one. The cadence is approval-driven and deliberately not
 * business-day aware (see followUpCadence.ts): a touch that falls due on a
 * Saturday waits in the queue until someone approves it on Monday, and that is
 * the system working as designed. A one-day grace would flag every weekend as
 * a service failure.
 */
export const DEFAULT_STALL_GRACE_DAYS = 3;

/**
 * Contact statuses where pending touches are meant to stay untouched. These
 * are outcomes, not neglect.
 */
export const TERMINAL_CONTACT_STATUSES: ReadonlySet<string> = new Set([
  "Bounced",
  "Replied",
  "Meeting Booked",
  "Unreachable",
]);

// ── Stall detection ──────────────────────────────────────────────────────────

/** Minimal shape this module needs from a Pending touch joined to its contact. */
export interface StallCandidate {
  emailId: number;
  contactId: number;
  contactName: string;
  contactStatus: string;
  optedOut: boolean;
  dayNumber: number;
  status: string;
  scheduledDate: Date;
}

export interface StalledTouch {
  emailId: number;
  contactId: number;
  contactName: string;
  dayNumber: number;
  scheduledDate: Date;
  /** Whole days past the scheduled date, rounded down. */
  daysLate: number;
}

/**
 * Pending touches that have gone quiet.
 *
 * Excluded, in order: anything not Pending; contacts in a terminal status;
 * contacts who opted out; touches the caller names in `excludeIds` (throttled
 * by policy); and anything still inside the grace period.
 *
 * Returned worst-first, because a report that leads with the contact who has
 * been waiting nineteen days is read differently from one that leads with the
 * contact who has been waiting four.
 */
export function findStalledTouches(
  candidates: StallCandidate[],
  now: Date,
  options: { graceDays?: number; excludeIds?: Iterable<number> } = {},
): StalledTouch[] {
  const graceDays = options.graceDays ?? DEFAULT_STALL_GRACE_DAYS;
  const excluded = new Set(options.excludeIds ?? []);
  const cutoff = now.getTime() - graceDays * DAY_MS;

  const stalled: StalledTouch[] = [];
  for (const c of candidates) {
    if (c.status !== "Pending") continue;
    if (TERMINAL_CONTACT_STATUSES.has(c.contactStatus)) continue;
    if (c.optedOut) continue;
    if (excluded.has(c.emailId)) continue;
    const scheduled = c.scheduledDate.getTime();
    if (scheduled > cutoff) continue;
    stalled.push({
      emailId: c.emailId,
      contactId: c.contactId,
      contactName: c.contactName,
      dayNumber: c.dayNumber,
      scheduledDate: c.scheduledDate,
      daysLate: Math.floor((now.getTime() - scheduled) / DAY_MS),
    });
  }
  return stalled.sort((a, b) => b.daysLate - a.daysLate || a.contactId - b.contactId);
}

/**
 * Collapse stalled touches to one row per contact, keeping their worst.
 *
 * A contact mid-sequence has several Pending touches, and re-anchoring means
 * they all drift together when one is missed. Reporting five stalled touches
 * for one neglected contact overstates the problem fivefold; the honest unit
 * is prospects who went quiet.
 */
export function stalledContactCount(stalled: StalledTouch[]): number {
  return new Set(stalled.map((s) => s.contactId)).size;
}

// ── Monthly figures ──────────────────────────────────────────────────────────

export interface QueueCounts {
  /** Contacts created in the period. */
  contactsLoaded: number;
  /** Of those, with an email address that passed verification. */
  contactsVerified: number;
  /** Touches created in the period, whatever their status now. */
  touchesQueued: number;
  /** Touches sent in the period. */
  touchesSent: number;
  /** Touches awaiting approval right now, regardless of when they were written. */
  touchesAwaitingApproval: number;
}

export interface MonthlyReport {
  tenantId: number;
  tenantName: string;
  period: TimeWindow;
  counts: QueueCounts;
  /** Prospects who went quiet, worst first. Empty is the number to aim for. */
  stalled: StalledTouch[];
  /** Distinct prospects behind `stalled`. */
  stalledContacts: number;
  /** Average daily send rate over the period's elapsed days. */
  averageDailySends: number;
  /** The daily ceiling in force, or null when this tenant has no policy set. */
  dailyEmailCeiling: number | null;
  /** The monthly contact ceiling, or null when this tenant has no policy set. */
  monthlyContactCeiling: number | null;
  /**
   * True when no send policy is configured. A report that says "no ceiling was
   * ever set" is far more useful than one that silently omits the line.
   */
  ungoverned: boolean;
}

/**
 * Mean sends per elapsed day in the period, so a report run mid-month is not
 * divided by a month that has not happened yet. Elapsed days are counted from
 * the period start to whichever comes first, `now` or the period end.
 */
export function averageDailySends(touchesSent: number, period: TimeWindow, now: Date): number {
  const endOfElapsed = Math.min(now.getTime(), period.end.getTime());
  const elapsedDays = Math.max(1, (endOfElapsed - period.start.getTime()) / DAY_MS);
  return Math.round((touchesSent / elapsedDays) * 10) / 10;
}

// ── DB-backed builders ───────────────────────────────────────────────────────

/**
 * Counting helpers are written per table rather than as one generic taking a
 * table argument: drizzle's `.from()` resolves its column types from the table
 * it is given, and a union parameter widens them away, which costs the query
 * builder every type guarantee it exists to provide.
 */
async function countContacts(where: ReturnType<typeof and>): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db.select({ count: sql<number>`count(*)` }).from(contacts).where(where);
  return Number(rows[0]?.count ?? 0);
}

async function countOutreach(where: ReturnType<typeof and>): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db.select({ count: sql<number>`count(*)` }).from(outreachEmails).where(where);
  return Number(rows[0]?.count ?? 0);
}

/** The five headline counts for one tenant over one window. */
export async function getQueueCounts(tenantId: number, period: TimeWindow): Promise<QueueCounts> {
  const [contactsLoaded, contactsVerified, touchesQueued, touchesSent, touchesAwaitingApproval] = await Promise.all([
    countContacts(
      and(eq(contacts.tenantId, tenantId), gte(contacts.createdAt, period.start), lt(contacts.createdAt, period.end)),
    ),
    countContacts(
      and(
        eq(contacts.tenantId, tenantId),
        gte(contacts.createdAt, period.start),
        lt(contacts.createdAt, period.end),
        sql`${contacts.emailVerification} in ('Verified', 'Verified-corrected')`,
      ),
    ),
    countOutreach(
      and(
        eq(outreachEmails.tenantId, tenantId),
        gte(outreachEmails.createdAt, period.start),
        lt(outreachEmails.createdAt, period.end),
      ),
    ),
    countOutreach(
      and(
        eq(outreachEmails.tenantId, tenantId),
        eq(outreachEmails.status, "Sent"),
        gte(outreachEmails.sentAt, period.start),
        lt(outreachEmails.sentAt, period.end),
      ),
    ),
    countOutreach(
      and(eq(outreachEmails.tenantId, tenantId), eq(outreachEmails.status, "Pending"), isNull(outreachEmails.sentAt)),
    ),
  ]);
  return { contactsLoaded, contactsVerified, touchesQueued, touchesSent, touchesAwaitingApproval };
}

/** Every Pending touch for a tenant, joined to the bit of its contact stall detection needs. */
export async function loadStallCandidates(tenantId: number): Promise<StallCandidate[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({
      emailId: outreachEmails.id,
      contactId: contacts.id,
      contactName: contacts.name,
      contactStatus: contacts.status,
      optedOut: contacts.optedOut,
      dayNumber: outreachEmails.dayNumber,
      status: outreachEmails.status,
      scheduledDate: outreachEmails.scheduledDate,
    })
    .from(outreachEmails)
    .innerJoin(contacts, eq(outreachEmails.contactId, contacts.id))
    .where(and(eq(outreachEmails.tenantId, tenantId), eq(outreachEmails.status, "Pending")));
  return rows;
}

/**
 * Build the monthly report for one tenant.
 *
 * `now` defaults to the present and decides which month is reported and how
 * many days have elapsed within it; pass it explicitly to re-run a closed
 * month.
 */
export async function buildMonthlyReport(
  tenantId: number,
  now: Date = new Date(),
  options: { graceDays?: number; excludeIds?: Iterable<number> } = {},
): Promise<MonthlyReport | null> {
  const db = await getDb();
  if (!db) return null;
  const tenantRows = await db
    .select({ id: tenants.id, displayName: tenants.displayName, sendPolicyJson: tenants.sendPolicyJson })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  const tenant = tenantRows[0];
  if (!tenant) return null;

  const policy = parseSendPolicy(tenant.sendPolicyJson);
  const timeZone = policy?.timeZone ?? DEFAULT_TIME_ZONE;
  const period = zonedMonthWindow(now, timeZone);

  const counts = await getQueueCounts(tenantId, period);
  const stalled = findStalledTouches(await loadStallCandidates(tenantId), now, options);

  return {
    tenantId,
    tenantName: tenant.displayName,
    period,
    counts,
    stalled,
    stalledContacts: stalledContactCount(stalled),
    averageDailySends: averageDailySends(counts.touchesSent, period, now),
    dailyEmailCeiling: policy?.dailyEmailCeiling ?? null,
    monthlyContactCeiling: policy?.monthlyContactCeiling ?? null,
    ungoverned: policy === null,
  };
}

/**
 * Active tenants with no send policy configured.
 *
 * The counterpart to `parseSendPolicy` returning null rather than a default:
 * an ungoverned tenant is a tenant whose contractual ceiling nothing is
 * enforcing, and the only thing worse than not having a ceiling is not knowing
 * you don't have one.
 */
export async function ungovernedTenants(): Promise<Array<{ id: number; displayName: string }>> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({ id: tenants.id, displayName: tenants.displayName, sendPolicyJson: tenants.sendPolicyJson })
    .from(tenants)
    .where(eq(tenants.active, true));
  return rows.filter((r) => parseSendPolicy(r.sendPolicyJson) === null).map((r) => ({ id: r.id, displayName: r.displayName }));
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** "1 Jun 2026" in the report's zone, for a human-readable period line. */
function formatDay(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, day: "numeric", month: "short", year: "numeric" }).format(d);
}

/**
 * Render a report as plain text, in the order the four service commitments are
 * usually written: what was loaded, what was queued, whether anything was
 * dropped, whether the queue is current.
 */
export function renderMonthlyReport(report: MonthlyReport, timeZone: string = DEFAULT_TIME_ZONE): string {
  const { counts } = report;
  const periodEnd = new Date(report.period.end.getTime() - DAY_MS);
  const lines: string[] = [
    `Service report: ${report.tenantName}`,
    `Period: ${formatDay(report.period.start, timeZone)} to ${formatDay(periodEnd, timeZone)}`,
    "",
    `Contacts identified and loaded:      ${counts.contactsLoaded}`,
    `  of which email-verified:           ${counts.contactsVerified}`,
    `Outreach touches written and queued: ${counts.touchesQueued}`,
    `Touches sent:                        ${counts.touchesSent}`,
    `Average per day:                     ${report.averageDailySends}`,
    `Awaiting approval now:               ${counts.touchesAwaitingApproval}`,
    "",
  ];

  if (report.stalled.length === 0) {
    lines.push("Prospects out of cadence:            none");
  } else {
    lines.push(`Prospects out of cadence:            ${report.stalledContacts}`);
    for (const s of report.stalled.slice(0, 10)) {
      lines.push(`  - ${s.contactName}, touch ${s.dayNumber}, ${s.daysLate} days late`);
    }
    if (report.stalled.length > 10) lines.push(`  ...and ${report.stalled.length - 10} more touches`);
  }

  lines.push("");
  if (report.ungoverned) {
    lines.push("Volume policy:                       NOT CONFIGURED — no ceiling is being enforced");
  } else {
    lines.push(`Volume policy:                       ${report.dailyEmailCeiling}/day, ${report.monthlyContactCeiling} contacts/month`);
    if (report.monthlyContactCeiling !== null && counts.contactsLoaded > report.monthlyContactCeiling) {
      lines.push(`  WARNING: contacts loaded exceeded the monthly ceiling by ${counts.contactsLoaded - report.monthlyContactCeiling}`);
    }
  }
  return lines.join("\n");
}
