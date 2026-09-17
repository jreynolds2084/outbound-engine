/**
 * followUpCadence.test.ts
 *
 * Sending an email starts the countdown: every send re-anchors a contact's
 * remaining Pending follow-up touches from the moment it actually went out,
 * using the cumulative interval table in server/followUpCadence.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  FOLLOW_UP_INTERVAL_DAYS,
  computeFollowUpReschedules,
  rescheduleFollowUpTouches,
  type FollowUpCandidate,
} from "./followUpCadence";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("FOLLOW_UP_INTERVAL_DAYS", () => {
  it("locks in the cumulative gaps: 2/2/4/4 days", () => {
    expect(FOLLOW_UP_INTERVAL_DAYS).toEqual({ 1: 2, 2: 2, 3: 4, 4: 4 });
  });
});

describe("computeFollowUpReschedules, pure interval math", () => {
  it("Touch 1 send: Touch 2/3/4/5 land at S+2d / S+4d / S+8d / S+12d", () => {
    const S = new Date("2026-08-05T18:33:46.000Z");
    const candidates: FollowUpCandidate[] = [
      { id: 2, dayNumber: 2, status: "Pending" },
      { id: 3, dayNumber: 3, status: "Pending" },
      { id: 4, dayNumber: 4, status: "Pending" },
      { id: 5, dayNumber: 5, status: "Pending" },
    ];
    const result = computeFollowUpReschedules(1, S, candidates);
    const byId = new Map(result.map((r) => [r.id, r.scheduledDate]));
    expect(byId.get(2)?.getTime()).toBe(S.getTime() + 2 * DAY_MS);
    expect(byId.get(3)?.getTime()).toBe(S.getTime() + 4 * DAY_MS);
    expect(byId.get(4)?.getTime()).toBe(S.getTime() + 8 * DAY_MS);
    expect(byId.get(5)?.getTime()).toBe(S.getTime() + 12 * DAY_MS);
  });

  it("Touch 2 send (late approval): remaining touches re-anchor from the actual sentAt, self-correcting the drift", () => {
    // Worked example: Touch 1 sent at S, but Touch 2 wasn't
    // approved until S2 (later than its original S+2d schedule). Touch 2
    // sending at S2 must still leave a 2/6/10-day cumulative gap for 3/4/5,
    // regardless of how late S2 was relative to Touch 1.
    const S2 = new Date("2026-08-10T09:00:00.000Z"); // Monday, later than original Aug 8 schedule
    const candidates: FollowUpCandidate[] = [
      { id: 1, dayNumber: 1, status: "Sent" }, // already sent, must not appear in output
      { id: 3, dayNumber: 3, status: "Pending" },
      { id: 4, dayNumber: 4, status: "Pending" },
      { id: 5, dayNumber: 5, status: "Pending" },
    ];
    const result = computeFollowUpReschedules(2, S2, candidates);
    expect(result).toHaveLength(3);
    const byId = new Map(result.map((r) => [r.id, r.scheduledDate]));
    expect(byId.get(3)?.getTime()).toBe(S2.getTime() + 2 * DAY_MS);
    expect(byId.get(4)?.getTime()).toBe(S2.getTime() + 6 * DAY_MS);
    expect(byId.get(5)?.getTime()).toBe(S2.getTime() + 10 * DAY_MS);
  });

  it("never reschedules Sent or Skipped rows, even with a higher dayNumber", () => {
    const S = new Date("2026-08-05T00:00:00.000Z");
    const candidates: FollowUpCandidate[] = [
      { id: 2, dayNumber: 2, status: "Sent" },
      { id: 3, dayNumber: 3, status: "Skipped" },
      { id: 4, dayNumber: 4, status: "Bounced" },
      { id: 5, dayNumber: 5, status: "Pending" },
    ];
    const result = computeFollowUpReschedules(1, S, candidates);
    expect(result.map((r) => r.id)).toEqual([5]);
  });

  it("never touches rows with a dayNumber lower than (or equal to) the touch just sent", () => {
    const S = new Date("2026-08-05T00:00:00.000Z");
    const candidates: FollowUpCandidate[] = [
      { id: 1, dayNumber: 1, status: "Pending" }, // equal, must not appear
      { id: 2, dayNumber: 2, status: "Pending" }, // lower than sentDayNumber=3
      { id: 4, dayNumber: 4, status: "Pending" },
    ];
    const result = computeFollowUpReschedules(3, S, candidates);
    expect(result.map((r) => r.id)).toEqual([4]);
  });

  it("skips (does not throw for) a candidate whose dayNumber has no defined interval path, without affecting other candidates", () => {
    const S = new Date("2026-08-05T00:00:00.000Z");
    const candidates: FollowUpCandidate[] = [
      { id: 2, dayNumber: 2, status: "Pending" }, // valid: interval[1] exists
      { id: 10, dayNumber: 10, status: "Pending" }, // invalid: no interval entries for 5..9
    ];
    expect(() => computeFollowUpReschedules(1, S, candidates)).not.toThrow();
    const result = computeFollowUpReschedules(1, S, candidates);
    expect(result.map((r) => r.id)).toEqual([2]);
  });

  it("returns an empty array for an empty candidate list", () => {
    expect(computeFollowUpReschedules(1, new Date(), [])).toEqual([]);
  });
});

// ─── rescheduleFollowUpTouches, DB-touching wrapper ───────────────────────

const h = vi.hoisted(() => ({
  dbAvailable: true as boolean,
  listEmailsForContactImpl: null as null | ((contactId: number) => Promise<unknown[]>),
  listEmailsForContactCalls: [] as number[],
  updateCalls: [] as Array<{ id: number; scheduledDate: Date }>,
  throwOnUpdate: false as boolean,
}));

// drizzle's `eq()` just needs to be callable for the update `.where()` call;
// the fake update chain below never actually evaluates it.
vi.mock("drizzle-orm", () => ({
  eq: (...args: unknown[]) => args,
}));

vi.mock("../drizzle/schema", () => ({
  outreachEmails: { id: "outreachEmails.id" },
}));

vi.mock("./db", () => {
  return {
    getDb: async () => {
      if (!h.dbAvailable) return null;
      return {
        update: () => ({
          set: (patch: { scheduledDate: Date }) => ({
            where: (whereArgs: [{ id: number }, unknown]) => {
              if (h.throwOnUpdate) throw new Error("simulated DB update failure");
              const id = whereArgs[1] as unknown as number;
              h.updateCalls.push({ id, scheduledDate: patch.scheduledDate });
              return Promise.resolve();
            },
          }),
        }),
      };
    },
    listEmailsForContact: async (contactId: number) => {
      h.listEmailsForContactCalls.push(contactId);
      if (!h.listEmailsForContactImpl) throw new Error("listEmailsForContact mock not configured");
      return h.listEmailsForContactImpl(contactId);
    },
  };
});

beforeEach(() => {
  h.dbAvailable = true;
  h.listEmailsForContactImpl = null;
  h.listEmailsForContactCalls = [];
  h.updateCalls = [];
  h.throwOnUpdate = false;
});

describe("rescheduleFollowUpTouches", () => {
  it("only fetches and updates rows for the given contactId (other contacts are never touched)", async () => {
    const S = new Date("2026-08-05T18:33:46.000Z");
    h.listEmailsForContactImpl = async (contactId: number) => {
      expect(contactId).toBe(2370024); // the exact contact passed in below
      return [
        { id: 3270221, dayNumber: 1, status: "Sent" },
        { id: 3270222, dayNumber: 2, status: "Pending" },
        { id: 3270223, dayNumber: 3, status: "Pending" },
        { id: 3270224, dayNumber: 4, status: "Pending" },
        { id: 3270225, dayNumber: 5, status: "Pending" },
      ];
    };

    await rescheduleFollowUpTouches(2370024, 1, S);

    expect(h.listEmailsForContactCalls).toEqual([2370024]);
    const byId = new Map(h.updateCalls.map((u) => [u.id, u.scheduledDate.getTime()]));
    expect(byId.get(3270222)).toBe(S.getTime() + 2 * DAY_MS);
    expect(byId.get(3270223)).toBe(S.getTime() + 4 * DAY_MS);
    expect(byId.get(3270224)).toBe(S.getTime() + 8 * DAY_MS);
    expect(byId.get(3270225)).toBe(S.getTime() + 12 * DAY_MS);
    expect(h.updateCalls).toHaveLength(4);
  });

  it("a reschedule failure is logged and swallowed, never thrown back to the caller", async () => {
    const S = new Date();
    h.listEmailsForContactImpl = async () => [{ id: 1, dayNumber: 2, status: "Pending" }];
    h.throwOnUpdate = true;
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(rescheduleFollowUpTouches(1, 1, S)).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("swallows a missing DB (getDb() returns null) without throwing", async () => {
    h.dbAvailable = false;
    await expect(rescheduleFollowUpTouches(1, 1, new Date())).resolves.toBeUndefined();
    expect(h.listEmailsForContactCalls).toEqual([]);
  });

  it("swallows a listEmailsForContact failure without throwing", async () => {
    h.listEmailsForContactImpl = async () => {
      throw new Error("simulated fetch failure");
    };
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(rescheduleFollowUpTouches(1, 1, new Date())).resolves.toBeUndefined();
    consoleErrorSpy.mockRestore();
  });
});
