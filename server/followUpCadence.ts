import { eq } from "drizzle-orm";
import { outreachEmails } from "../drizzle/schema";
import { getDb, listEmailsForContact } from "./db";

/**
 * followUpCadence.ts
 *
 * Shared cadence logic for re-anchoring a contact's remaining follow-up
 * touches every time one of their touches actually sends.
 *
 * ── Background ────────────────────────────────────────────────────────────
 * `outreachEmails.scheduledDate` used to be computed once at import time
 * (import date + a fixed offset per touch) and never recalculated. Any delay
 * approving an earlier touch silently compressed the gap to the next one,
 * e.g. Touch 2 approved two days late still left Touch 3 pinned to its
 * original date, cutting an intended 4-day gap to 2 days.
 *
 * ── The rule ─────────────────────────────────────────────────────────────
 * Sending the email starts the countdown. Approval is the clock, not the
 * calendar: every send re-anchors the contact's remaining Pending touches from
 * the moment it actually went out (`sentAt`), using cumulative intervals
 * counted from that touch.
 *
 * Deliberately NOT business-day-aware. Nothing sends without a human
 * approving it, so a touch that falls due on a Saturday simply waits in the
 * queue until someone approves it on Monday. The queue is a list of what is
 * owed; approval is the clock. Weekday logic was considered and rejected.
 *
 * ── Constant vs. tenant/campaign config ──────────────────────────────────
 * Two existing config surfaces were checked and neither fits:
 *
 *   - `tenants.tenantConfigYaml`'s `touch_cadence` block is per tenant (not
 *     per campaign), mixes email/call/LinkedIn channels, and its `day` field
 *     is an absolute calendar-day anchor used only to prompt the content
 *     generator. It does not reduce to "N intervals for touch index N" the
 *     way `outreachEmails.dayNumber` needs.
 *   - `tenants.sequenceConfigJson` / `campaigns.sequenceConfigJsonOverride`
 *     is the structured field meant for channel-mix and cadence overrides, but
 *     it was empty for the campaigns this change had to correct.
 *
 * So the intervals live in one named constant rather than an invented config
 * surface.
 */

/** Milliseconds in a day, used to turn a day-count into a Date offset. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Cumulative follow-up cadence. Keyed by the
 * touch (`dayNumber`) that was just sent -> number of days until the next
 * touch. This is the ONLY place these numbers live, do not duplicate them.
 *
 *   Touch 1 -> Touch 2 : +2 days
 *   Touch 2 -> Touch 3 : +2 days
 *   Touch 3 -> Touch 4 : +4 days
 *   Touch 4 -> Touch 5 : +4 days
 *
 * Worked example, Touch 1 sent at time S: Touch 2 = S+2d, Touch 3 = S+4d,
 * Touch 4 = S+8d, Touch 5 = S+12d. If Touch 2 instead actually sends late,
 * at S2, Touches 3/4/5 re-anchor to S2+2d, S2+6d, S2+10d.
 */
export const FOLLOW_UP_INTERVAL_DAYS: Readonly<Record<number, number>> = Object.freeze({
  1: 2,
  2: 2,
  3: 4,
  4: 4,
});

/**
 * Sums the cumulative day-gap between two touch numbers using
 * FOLLOW_UP_INTERVAL_DAYS. Throws if any leg of the path (fromDayNumber up
 * to toDayNumber - 1) isn't defined in the table, callers must handle this
 * (see computeFollowUpReschedules, which skips rather than propagates).
 */
function cumulativeDaysBetweenTouches(fromDayNumber: number, toDayNumber: number): number {
  let totalDays = 0;
  for (let n = fromDayNumber; n < toDayNumber; n++) {
    const gap = FOLLOW_UP_INTERVAL_DAYS[n];
    if (gap === undefined) {
      throw new Error(
        `No follow-up interval defined from touch ${n} to touch ${n + 1} (requested ${fromDayNumber} -> ${toDayNumber})`,
      );
    }
    totalDays += gap;
  }
  return totalDays;
}

/** Minimal shape this module needs from an outreach_emails row. */
export interface FollowUpCandidate {
  id: number;
  dayNumber: number;
  status: string;
}

export interface FollowUpReschedule {
  id: number;
  dayNumber: number;
  scheduledDate: Date;
}

/**
 * Given the touch that was just sent (its dayNumber and actual sentAt) and
 * every outreach_emails row for that same contact, returns the new
 * scheduledDate for each remaining touch that should re-anchor.
 *
 * Rules:
 *   - Only `Pending` rows are eligible. `Sent`/`Skipped`/`Bounced` rows are
 *     left alone, a contact whose remaining touches were cancelled (e.g.
 *     they replied) stays cancelled.
 *   - Only rows with a strictly higher dayNumber than the touch just sent.
 *   - A candidate whose cumulative interval can't be computed (dayNumber
 *     sequence doesn't match the defined table, e.g. a jump the table
 *     doesn't cover) is skipped, not thrown, callers should log this, but
 *     it must never abort the rest of the batch or the caller's send.
 *
 * Pure and DB-free by design so it's unit-testable without a live database.
 */
export function computeFollowUpReschedules(
  sentDayNumber: number,
  sentAt: Date,
  contactEmails: FollowUpCandidate[],
): FollowUpReschedule[] {
  const results: FollowUpReschedule[] = [];
  for (const candidate of contactEmails) {
    if (candidate.status !== "Pending") continue;
    if (candidate.dayNumber <= sentDayNumber) continue;
    try {
      const days = cumulativeDaysBetweenTouches(sentDayNumber, candidate.dayNumber);
      results.push({
        id: candidate.id,
        dayNumber: candidate.dayNumber,
        scheduledDate: new Date(sentAt.getTime() + days * DAY_MS),
      });
    } catch (err) {
      // No defined interval path for this dayNumber jump, leave it as-is
      // rather than guessing. Never let one bad candidate block the rest.
      console.warn(
        `[followUpCadence] Skipping reschedule for outreach_emails.id=${candidate.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return results;
}

/**
 * Fetches this contact's touches, recomputes the eligible ones via
 * computeFollowUpReschedules, and persists the new scheduledDate for each.
 *
 * This is the single call both approveSend (real send) and markAlreadySent
 * (manual "mark as sent") use, so the two paths always agree.
 *
 * By design this NEVER throws, any failure (DB error, missing interval,
 * anything) is logged and swallowed. The touch that triggered this has
 * already sent/been marked sent by the time this runs; a rescheduling
 * failure must never be surfaced as a send failure.
 */
export async function rescheduleFollowUpTouches(
  contactId: number,
  sentDayNumber: number,
  sentAt: Date,
): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    const contactEmails = await listEmailsForContact(contactId);
    const reschedules = computeFollowUpReschedules(sentDayNumber, sentAt, contactEmails);
    for (const r of reschedules) {
      await db
        .update(outreachEmails)
        .set({ scheduledDate: r.scheduledDate })
        .where(eq(outreachEmails.id, r.id));
    }
  } catch (err) {
    console.error(
      `[followUpCadence] Failed to reschedule follow-up touches for contactId=${contactId}, sentDayNumber=${sentDayNumber}:`,
      err,
    );
  }
}
