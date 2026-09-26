import { describe, it, expect } from "vitest";
import {
  ceilingForRampDay,
  checkPolicyCoherence,
  computeContactAllowance,
  computeSendAllowance,
  defaultRampFor,
  parseSendPolicy,
  rampDayIndex,
  selectSendable,
  zonedDayWindow,
  zonedMonthWindow,
  type SendPolicy,
} from "./sendGovernor";

/** The policy a 100/day, 500/month agreement produces. */
const POLICY: SendPolicy = {
  type: "send-policy",
  dailyEmailCeiling: 100,
  monthlyContactCeiling: 500,
  ramp: defaultRampFor(100),
  timeZone: "America/Vancouver",
};

const NO_RAMP: SendPolicy = { ...POLICY, ramp: undefined };

/** "YYYY-MM-DD HH:MM" for a UTC Date in America/Vancouver. */
function pacific(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Vancouver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour").replace("24", "00")}:${get("minute")}`;
}

describe("parseSendPolicy", () => {
  it("returns null for null, empty and malformed JSON", () => {
    expect(parseSendPolicy(null)).toBeNull();
    expect(parseSendPolicy(undefined)).toBeNull();
    expect(parseSendPolicy("")).toBeNull();
    expect(parseSendPolicy("{not json")).toBeNull();
  });

  it("returns null for legacy or other-shaped config in the column", () => {
    expect(parseSendPolicy("[]")).toBeNull();
    expect(parseSendPolicy(JSON.stringify({ type: "fixed-templates" }))).toBeNull();
  });

  it("parses a valid policy and defaults the time zone", () => {
    const parsed = parseSendPolicy(
      JSON.stringify({ type: "send-policy", dailyEmailCeiling: 100, monthlyContactCeiling: 500 }),
    );
    expect(parsed?.dailyEmailCeiling).toBe(100);
    expect(parsed?.monthlyContactCeiling).toBe(500);
    expect(parsed?.timeZone).toBe("America/Vancouver");
  });

  it("rejects a zero or negative ceiling rather than accepting a queue that can never send", () => {
    expect(parseSendPolicy(JSON.stringify({ type: "send-policy", dailyEmailCeiling: 0, monthlyContactCeiling: 500 }))).toBeNull();
    expect(parseSendPolicy(JSON.stringify({ type: "send-policy", dailyEmailCeiling: 100, monthlyContactCeiling: -1 }))).toBeNull();
  });
});

describe("defaultRampFor", () => {
  it("reaches exactly the steady-state ceiling on the last step", () => {
    const ramp = defaultRampFor(100);
    expect(ramp[ramp.length - 1]).toEqual({ fromDay: 18, ceiling: 100 });
  });

  it("starts well below the ceiling", () => {
    expect(defaultRampFor(100)[0]).toEqual({ fromDay: 1, ceiling: 20 });
  });

  it("never produces a zero ceiling, which would stall the queue", () => {
    for (const step of defaultRampFor(1)) {
      expect(step.ceiling).toBeGreaterThanOrEqual(1);
    }
  });

  it("ascends monotonically", () => {
    const ramp = defaultRampFor(250);
    for (let i = 1; i < ramp.length; i++) {
      expect(ramp[i].ceiling).toBeGreaterThanOrEqual(ramp[i - 1].ceiling);
      expect(ramp[i].fromDay).toBeGreaterThan(ramp[i - 1].fromDay);
    }
  });
});

describe("ceilingForRampDay", () => {
  it("applies the step in force for the day", () => {
    expect(ceilingForRampDay(POLICY, 1)).toBe(20);
    expect(ceilingForRampDay(POLICY, 3)).toBe(20);
    expect(ceilingForRampDay(POLICY, 4)).toBe(35);
    expect(ceilingForRampDay(POLICY, 10)).toBe(50);
    expect(ceilingForRampDay(POLICY, 14)).toBe(70);
    expect(ceilingForRampDay(POLICY, 17)).toBe(85);
    expect(ceilingForRampDay(POLICY, 18)).toBe(100);
  });

  it("holds at the steady-state ceiling long after the ramp ends", () => {
    expect(ceilingForRampDay(POLICY, 400)).toBe(100);
  });

  it("returns the steady-state ceiling when the policy has no ramp", () => {
    expect(ceilingForRampDay(NO_RAMP, 1)).toBe(100);
  });

  it("clamps a ramp step that exceeds the policy's own ceiling", () => {
    const overreaching: SendPolicy = { ...POLICY, ramp: [{ fromDay: 1, ceiling: 5000 }] };
    expect(ceilingForRampDay(overreaching, 1)).toBe(100);
  });

  it("reads unsorted ramp steps correctly", () => {
    const unsorted: SendPolicy = {
      ...POLICY,
      ramp: [
        { fromDay: 10, ceiling: 60 },
        { fromDay: 1, ceiling: 20 },
        { fromDay: 5, ceiling: 40 },
      ],
    };
    expect(ceilingForRampDay(unsorted, 1)).toBe(20);
    expect(ceilingForRampDay(unsorted, 6)).toBe(40);
    expect(ceilingForRampDay(unsorted, 11)).toBe(60);
  });
});

describe("zonedDayWindow", () => {
  it("brackets the Pacific calendar day, not the UTC one", () => {
    // 2026-06-10 23:30 Pacific is already 2026-06-11 in UTC.
    const lateEvening = new Date("2026-06-11T06:30:00Z");
    const { start, end } = zonedDayWindow(lateEvening);
    expect(pacific(start)).toBe("2026-06-10 00:00");
    expect(pacific(end)).toBe("2026-06-11 00:00");
    expect(lateEvening.getTime()).toBeGreaterThanOrEqual(start.getTime());
    expect(lateEvening.getTime()).toBeLessThan(end.getTime());
  });

  it("does not roll the day over at 17:00 Pacific, when UTC midnight passes", () => {
    const beforeUtcMidnight = new Date("2026-06-10T23:00:00Z"); // 16:00 Pacific
    const afterUtcMidnight = new Date("2026-06-11T01:00:00Z"); // 18:00 Pacific, same Pacific day
    expect(zonedDayWindow(beforeUtcMidnight).start.getTime()).toBe(zonedDayWindow(afterUtcMidnight).start.getTime());
  });

  it("handles the 23-hour spring-forward day", () => {
    // DST begins 2026-03-08 in America/Vancouver.
    const duringShortDay = new Date("2026-03-08T20:00:00Z"); // 13:00 PDT
    const { start, end } = zonedDayWindow(duringShortDay);
    expect(pacific(start)).toBe("2026-03-08 00:00");
    expect(pacific(end)).toBe("2026-03-09 00:00");
    expect(end.getTime() - start.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  it("handles the 25-hour fall-back day", () => {
    // DST ends 2026-11-01 in America/Vancouver.
    const duringLongDay = new Date("2026-11-01T20:00:00Z"); // 12:00 PST
    const { start, end } = zonedDayWindow(duringLongDay);
    expect(pacific(start)).toBe("2026-11-01 00:00");
    expect(pacific(end)).toBe("2026-11-02 00:00");
    expect(end.getTime() - start.getTime()).toBe(25 * 60 * 60 * 1000);
  });
});

describe("zonedMonthWindow", () => {
  it("brackets the Pacific calendar month", () => {
    const midMonth = new Date("2026-06-15T19:00:00Z");
    const { start, end } = zonedMonthWindow(midMonth);
    expect(pacific(start)).toBe("2026-06-01 00:00");
    expect(pacific(end)).toBe("2026-07-01 00:00");
  });

  it("rolls December into January of the next year", () => {
    const december = new Date("2026-12-20T19:00:00Z");
    const { start, end } = zonedMonthWindow(december);
    expect(pacific(start)).toBe("2026-12-01 00:00");
    expect(pacific(end)).toBe("2027-01-01 00:00");
  });

  it("puts a send at 23:00 Pacific on the last of the month in that month, not the next", () => {
    // 2026-06-30 23:00 Pacific is 2026-07-01 06:00 UTC.
    const lastEvening = new Date("2026-07-01T06:00:00Z");
    const { start, end } = zonedMonthWindow(lastEvening);
    expect(pacific(start)).toBe("2026-06-01 00:00");
    expect(lastEvening.getTime()).toBeLessThan(end.getTime());
  });
});

describe("rampDayIndex", () => {
  const goLive = new Date("2026-06-01T17:00:00Z"); // Mon Jun 1, 10:00 Pacific

  it("counts the go-live day as day 1", () => {
    expect(rampDayIndex(goLive, goLive)).toBe(1);
  });

  it("stays on day 1 for the rest of the go-live day", () => {
    expect(rampDayIndex(goLive, new Date("2026-06-02T06:00:00Z"))).toBe(1); // 23:00 Pacific Jun 1
  });

  it("advances to day 2 at Pacific midnight, not at the 24-hour mark", () => {
    expect(rampDayIndex(goLive, new Date("2026-06-02T08:00:00Z"))).toBe(2); // 01:00 Pacific Jun 2
  });

  it("counts calendar days, so a late go-live does not shift every later boundary", () => {
    const lateGoLive = new Date("2026-06-02T02:00:00Z"); // Mon Jun 1, 19:00 Pacific
    expect(rampDayIndex(lateGoLive, new Date("2026-06-02T18:00:00Z"))).toBe(2);
  });

  it("counts across a DST transition without drifting", () => {
    const beforeDst = new Date("2026-03-01T18:00:00Z"); // Sun Mar 1, 10:00 PST
    expect(rampDayIndex(beforeDst, new Date("2026-03-18T17:00:00Z"))).toBe(18); // Wed Mar 18, 10:00 PDT
  });

  it("clamps a now before the ramp start to day 1 rather than going negative", () => {
    expect(rampDayIndex(goLive, new Date("2026-05-01T17:00:00Z"))).toBe(1);
  });
});

describe("computeSendAllowance", () => {
  const goLive = new Date("2026-06-01T17:00:00Z");

  it("throttles to the ramp ceiling on day 1", () => {
    const a = computeSendAllowance({ policy: POLICY, rampStartedAt: goLive, now: goLive, sentToday: 0 });
    expect(a.ceiling).toBe(20);
    expect(a.remaining).toBe(20);
    expect(a.rampDay).toBe(1);
    expect(a.steadyStateCeiling).toBe(100);
    expect(a.exhausted).toBe(false);
  });

  it("reaches the full ceiling once the ramp completes", () => {
    const day18 = new Date("2026-06-18T17:00:00Z");
    const a = computeSendAllowance({ policy: POLICY, rampStartedAt: goLive, now: day18, sentToday: 0 });
    expect(a.ceiling).toBe(100);
    expect(a.rampDay).toBeNull(); // no longer stepped: reporting treats this as steady state
  });

  it("subtracts what has already gone out today", () => {
    const day18 = new Date("2026-06-18T17:00:00Z");
    const a = computeSendAllowance({ policy: POLICY, rampStartedAt: goLive, now: day18, sentToday: 88 });
    expect(a.used).toBe(88);
    expect(a.remaining).toBe(12);
  });

  it("reports exhausted rather than a negative remaining when the ceiling is already passed", () => {
    const a = computeSendAllowance({ policy: POLICY, rampStartedAt: goLive, now: goLive, sentToday: 45 });
    expect(a.remaining).toBe(0);
    expect(a.exhausted).toBe(true);
  });

  it("counts sends this module cannot see, such as reply-agent responses", () => {
    const day18 = new Date("2026-06-18T17:00:00Z");
    const a = computeSendAllowance({
      policy: POLICY,
      rampStartedAt: goLive,
      now: day18,
      sentToday: 90,
      additionalCountedSends: 15,
    });
    expect(a.used).toBe(105);
    expect(a.remaining).toBe(0);
    expect(a.exhausted).toBe(true);
  });

  it("applies the steady-state ceiling when no ramp is being tracked", () => {
    const a = computeSendAllowance({ policy: POLICY, rampStartedAt: null, now: new Date(), sentToday: 0 });
    expect(a.ceiling).toBe(100);
    expect(a.rampDay).toBeNull();
  });

  it("ignores a nonsensical negative send count instead of inflating the allowance", () => {
    const a = computeSendAllowance({ policy: NO_RAMP, rampStartedAt: null, now: new Date(), sentToday: -50 });
    expect(a.used).toBe(0);
    expect(a.remaining).toBe(100);
  });
});

describe("selectSendable", () => {
  const candidate = (id: number, dayNumber: number, iso: string) => ({
    id,
    dayNumber,
    scheduledDate: new Date(iso),
  });

  it("releases everything when the allowance covers it", () => {
    const due = [candidate(1, 1, "2026-06-01T17:00:00Z"), candidate(2, 2, "2026-06-01T17:00:00Z")];
    const { allowed, deferred } = selectSendable(due, 10);
    expect(allowed).toHaveLength(2);
    expect(deferred).toHaveLength(0);
  });

  it("puts follow-ups ahead of first touches when the ceiling bites", () => {
    const due = [
      candidate(1, 1, "2026-06-01T00:00:00Z"), // first touch, oldest
      candidate(2, 3, "2026-06-05T00:00:00Z"), // follow-up, newer
    ];
    const { allowed, deferred } = selectSendable(due, 1);
    expect(allowed.map((c) => c.id)).toEqual([2]);
    expect(deferred.map((c) => c.id)).toEqual([1]);
  });

  it("takes the oldest first within the same class, so nothing starves", () => {
    const due = [
      candidate(1, 2, "2026-06-05T00:00:00Z"),
      candidate(2, 4, "2026-06-01T00:00:00Z"),
      candidate(3, 3, "2026-06-03T00:00:00Z"),
    ];
    expect(selectSendable(due, 2).allowed.map((c) => c.id)).toEqual([2, 3]);
  });

  it("breaks an exact scheduledDate tie by id, so the order is stable between runs", () => {
    const sameInstant = "2026-06-01T17:00:00Z";
    const due = [candidate(9, 2, sameInstant), candidate(4, 2, sameInstant), candidate(7, 2, sameInstant)];
    const first = selectSendable(due, 2).allowed.map((c) => c.id);
    const second = selectSendable([...due].reverse(), 2).allowed.map((c) => c.id);
    expect(first).toEqual([4, 7]);
    expect(second).toEqual(first);
  });

  it("defers everything when the allowance is exhausted", () => {
    const due = [candidate(1, 2, "2026-06-01T00:00:00Z")];
    const { allowed, deferred } = selectSendable(due, 0);
    expect(allowed).toHaveLength(0);
    expect(deferred).toHaveLength(1);
  });

  it("never exceeds the ceiling to squeeze one more touch through", () => {
    const due = Array.from({ length: 140 }, (_, i) => candidate(i + 1, 2, "2026-06-01T00:00:00Z"));
    const { allowed, deferred } = selectSendable(due, 100);
    expect(allowed).toHaveLength(100);
    expect(deferred).toHaveLength(40);
  });

  it("does not mutate the caller's array or the candidates' dates", () => {
    const due = [candidate(2, 1, "2026-06-05T00:00:00Z"), candidate(1, 3, "2026-06-01T00:00:00Z")];
    const originalOrder = due.map((c) => c.id);
    const originalDate = due[0].scheduledDate.getTime();
    selectSendable(due, 1);
    expect(due.map((c) => c.id)).toEqual(originalOrder);
    expect(due[0].scheduledDate.getTime()).toBe(originalDate);
  });

  it("handles an empty due list", () => {
    expect(selectSendable([], 100)).toEqual({ allowed: [], deferred: [] });
  });
});

describe("computeContactAllowance", () => {
  it("grants the full request when there is room", () => {
    const a = computeContactAllowance({ policy: POLICY, addedThisMonth: 100, requested: 50 });
    expect(a.grant).toBe(50);
    expect(a.withheld).toBe(0);
    expect(a.remaining).toBe(400);
  });

  it("grants partially rather than failing whole at the boundary", () => {
    const a = computeContactAllowance({ policy: POLICY, addedThisMonth: 480, requested: 40 });
    expect(a.grant).toBe(20);
    expect(a.withheld).toBe(20);
  });

  it("grants nothing once the month's ceiling is reached", () => {
    const a = computeContactAllowance({ policy: POLICY, addedThisMonth: 500, requested: 25 });
    expect(a.grant).toBe(0);
    expect(a.withheld).toBe(25);
    expect(a.exhausted).toBe(true);
  });

  it("does not go negative when the ceiling was already overshot", () => {
    const a = computeContactAllowance({ policy: POLICY, addedThisMonth: 620, requested: 10 });
    expect(a.remaining).toBe(0);
    expect(a.grant).toBe(0);
  });
});

describe("checkPolicyCoherence", () => {
  it("finds a four-touch sequence sustainable at 500 contacts and 100 a day", () => {
    const result = checkPolicyCoherence(POLICY, 4);
    expect(result.impliedEmailsPerDay).toBe(96);
    expect(result.sustainable).toBe(true);
    expect(result.headroom).toBe(4);
  });

  it("finds a five-touch sequence unsustainable under the same ceilings", () => {
    const result = checkPolicyCoherence(POLICY, 5);
    expect(result.impliedEmailsPerDay).toBe(120);
    expect(result.sustainable).toBe(false);
    expect(result.headroom).toBeLessThan(0);
  });

  it("finds a three-touch sequence comfortable", () => {
    expect(checkPolicyCoherence(POLICY, 3).headroom).toBeGreaterThan(20);
  });
});
