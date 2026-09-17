/**
 * callScheduler.ts
 *
 * Business rules for scheduling phone-call reminders:
 *   - After email 2 → +2 business days at 10:00 America/Vancouver
 *   - After email 3 → +2 business days at 10:00 America/Vancouver
 *   - After email 4 → +2 business days at 10:00 America/Vancouver
 *   - After email 5 → +2 business days at 10:00 America/Vancouver
 *   - After email 6 → +2 business days at 10:00 America/Vancouver (breakup tone)
 *   - On any reply  → next business morning at 10:00 America/Vancouver
 *   - Manual        → caller-supplied date, clamped to 08:00–16:00 Mon–Fri
 *
 * All times are stored as UTC timestamps in MySQL.
 * Display layer converts to America/Vancouver for the user.
 */

import { eq, desc, and, gte, sql } from "drizzle-orm";
import { calls, contacts, type InsertCall } from "../drizzle/schema";
import { getDb } from "./db";
// M1 fix (2026-07): invokeLLM import removed, voicemail script generation
// was dead code (ElevenLabs dialer never used the stored script). Scripts are
// now generated upstream in the sequence generator and stored there.

// ─── Business-day logic ─────────────────────────────────────────────────────

const PACIFIC_TZ = "America/Vancouver";

/**
 * Returns the next business day (Mon–Fri) that is at least `addDays` calendar
 * days from `fromDate`, with the time set to 10:00 America/Vancouver.
 *
 * Uses the Intl API to determine the weekday in Pacific time, so it handles
 * DST transitions correctly without a heavy library.
 */
export function nextBusinessSlot(fromDate: Date, addDays: number): Date {
  // Walk forward one calendar day at a time, counting only Mon–Fri.
  // We always advance at least 1 day so the result is strictly after fromDate.
  let daysAdded = 0;
  let candidate = new Date(fromDate);

  while (daysAdded < addDays) {
    // Advance by exactly one calendar day
    candidate = new Date(candidate.getTime() + 86_400_000);
    const weekday = getWeekdayInPacific(candidate);
    if (weekday >= 1 && weekday <= 5) {
      // Mon=1 … Fri=5
      daysAdded++;
    }
    // Weekends don't count toward addDays; we just skip over them
  }

  // Set 10:00 Pacific on the resulting day
  return setTimeInPacific(candidate, 10, 0);
}

/** Returns the ISO weekday (1=Mon … 7=Sun) for a UTC Date in Pacific time. */
function getWeekdayInPacific(utcDate: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TZ,
    weekday: "short",
  }).formatToParts(utcDate);
  const day = parts.find((p) => p.type === "weekday")?.value;
  const map: Record<string, number> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  };
  return map[day ?? "Sun"] ?? 7;
}

/** Returns a UTC Date representing HH:MM on the same calendar day in Pacific time. */
function setTimeInPacific(utcDate: Date, hour: number, minute: number): Date {
  // Format the date in Pacific to get the calendar date string
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: PACIFIC_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const dateStr = formatter.format(utcDate); // "YYYY-MM-DD"
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  // Construct an ISO string with the Pacific offset so the JS engine treats it
  // as local Pacific time and converts to UTC correctly.
  // We determine the current UTC offset for this date in Pacific time.
  const tempUtc = new Date(`${dateStr}T${hh}:${mm}:00Z`);
  // Get what Pacific time thinks the UTC offset is for this date
  const offsetParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PACIFIC_TZ,
    timeZoneName: "shortOffset",
  })
    .formatToParts(tempUtc)
    .find((p) => p.type === "timeZoneName");
  // offsetParts.value is like "GMT-7" or "GMT-8"
  const offsetStr = offsetParts?.value ?? "GMT-8";
  const match = offsetStr.match(/GMT([+-])(\d+)/);
  const sign = match?.[1] === "-" ? 1 : -1; // invert: GMT-7 means UTC+7 hours ahead
  const offsetHours = parseInt(match?.[2] ?? "8", 10);
  const offsetMs = sign * offsetHours * 60 * 60 * 1000;
  // Parse as UTC then shift by the Pacific offset
  return new Date(tempUtc.getTime() + offsetMs);
}

// ─── Call DB helpers ─────────────────────────────────────────────────────────

export async function listCalls() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(calls).orderBy(calls.scheduledFor);
}

export async function listUpcomingCalls() {
  const db = await getDb();
  if (!db) return [];
  const now = new Date();
  return db
    .select()
    .from(calls)
    .where(and(eq(calls.status, "Scheduled"), gte(calls.scheduledFor, now)))
    .orderBy(calls.scheduledFor);
}

export async function insertCall(input: InsertCall): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  // CASL gate: never schedule a call touch for an opted-out contact.
  // Returns 0 (no call created), callers treat the id as informational only.
  if (input.contactId) {
    const optOutRows = await db
      .select({ optedOut: contacts.optedOut })
      .from(contacts)
      .where(eq(contacts.id, input.contactId))
      .limit(1);
    if (optOutRows[0]?.optedOut) {
      console.log(`[CallScheduler] Contact ${input.contactId} has opted out (CASL) — call not scheduled`);
      return 0;
    }
  }
  // Guard against duplicates: skip if same contact already has a call on the same day.
  // L2 fix (2026-07): Compute the day window in Pacific time to match scheduledFor.
  // Using server-local setHours() was wrong near midnight Pacific.
  if (input.contactId && input.scheduledFor) {
    const dayStart = setTimeInPacific(input.scheduledFor, 0, 0);
    const dayEnd = setTimeInPacific(input.scheduledFor, 23, 59);
    const existing = await db
      .select({ id: calls.id })
      .from(calls)
      .where(
        and(
          eq(calls.contactId, input.contactId),
          sql`${calls.scheduledFor} >= ${dayStart} AND ${calls.scheduledFor} <= ${dayEnd}`,
        ),
      )
      .limit(1);
    if (existing.length > 0) return existing[0].id;
  }
  const result = await db.insert(calls).values(input).$returningId();
  return result[0].id;
}

export async function recordCallOutcome(
  callId: number,
  status: "Voicemail" | "No Answer" | "Spoke" | "Meeting Booked" | "Skipped",
  notes?: string,
) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(calls)
    .set({
      status,
      notes: notes ?? null,
      completedAt: new Date(),
    })
    .where(eq(calls.id, callId));
}

export async function rescheduleCall(callId: number, newDate: Date) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(calls)
    .set({ scheduledFor: newDate, status: "Scheduled" })
    .where(eq(calls.id, callId));
}

export async function updateContactPhone(contactId: number, phone: string) {
  const db = await getDb();
  if (!db) return;
  await db.update(contacts).set({ phone }).where(eq(contacts.id, contactId));
}

/**
 * Auto-schedule a call after an email is marked Sent.
 * Queues for email sequence numbers 2–6, all +2 business days.
 *
 * M1 fix (2026-07): Removed the per-send voicemail script generation.
 * The ElevenLabs dialer never read the script stored here; scripts are
 * generated upstream in the sequence generator. This removes a redundant
 * LLM call on every email send.
 */
export async function maybeQueueCallAfterEmail(
  contactId: number,
  accountId: number,
  emailId: number,
  emailNumber: number,
  sentAt: Date,
  tenantId: number,
) {
  const offsetMap: Record<number, InsertCall["source"]> = {
    2: "AfterEmail2",
    3: "AfterEmail3",
    4: "AfterEmail4",
    5: "AfterEmail5",
    6: "AfterEmail6",
  };
  const source = offsetMap[emailNumber];
  if (!source) return;

  const scheduledFor = nextBusinessSlot(sentAt, 2);

  await insertCall({
    contactId,
    accountId,
    tenantId,
    scheduledFor,
    source,
    triggerEmailId: emailId,
  });
}

/**
 * Auto-schedule a call when a reply is received.
 * Queues for the next business morning at 10:00 Pacific.
 */
export async function queueCallAfterReply(
  contactId: number,
  accountId: number,
  replyId: number,
  tenantId: number,
) {
  const scheduledFor = nextBusinessSlot(new Date(), 1);
  await insertCall({
    contactId,
    accountId,
    tenantId,
    scheduledFor,
    source: "ReplyTrigger",
    triggerReplyId: replyId,
  });
}
