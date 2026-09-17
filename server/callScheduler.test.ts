import { describe, it, expect } from "vitest";
import { nextBusinessSlot } from "./callScheduler";

/**
 * Helper: given a UTC date, return the weekday name in America/Vancouver.
 */
function pacificWeekday(d: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Vancouver",
    weekday: "long",
  }).format(d);
}

/**
 * Helper: return "HH:MM" in America/Vancouver for a UTC Date.
 */
function pacificTime(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Vancouver",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

describe("nextBusinessSlot", () => {
  it("returns 10:00 Pacific on the result date", () => {
    // Any weekday as base
    const monday = new Date("2026-06-01T17:00:00Z"); // Mon Jun 1 2026 10:00 Pacific
    const result = nextBusinessSlot(monday, 1);
    expect(pacificTime(result)).toBe("10:00");
  });

  it("+1 business day from Monday lands on Tuesday", () => {
    const monday = new Date("2026-06-01T17:00:00Z"); // Mon
    const result = nextBusinessSlot(monday, 1);
    expect(pacificWeekday(result)).toBe("Tuesday");
  });

  it("+2 business days from Monday lands on Wednesday", () => {
    const monday = new Date("2026-06-01T17:00:00Z");
    const result = nextBusinessSlot(monday, 2);
    expect(pacificWeekday(result)).toBe("Wednesday");
  });

  it("+1 business day from Friday skips the weekend and lands on Monday", () => {
    const friday = new Date("2026-06-05T17:00:00Z"); // Fri Jun 5
    const result = nextBusinessSlot(friday, 1);
    expect(pacificWeekday(result)).toBe("Monday");
  });

  it("+2 business days from Friday lands on Tuesday", () => {
    const friday = new Date("2026-06-05T17:00:00Z");
    const result = nextBusinessSlot(friday, 2);
    expect(pacificWeekday(result)).toBe("Tuesday");
  });

  it("+1 business day from Thursday lands on Friday", () => {
    const thursday = new Date("2026-06-04T17:00:00Z");
    const result = nextBusinessSlot(thursday, 1);
    expect(pacificWeekday(result)).toBe("Friday");
  });

  it("result is always at least 1 calendar day after the input", () => {
    const now = new Date();
    const result = nextBusinessSlot(now, 1);
    // The result must be strictly after now
    expect(result.getTime()).toBeGreaterThan(now.getTime());
    // The result must be on a different calendar day than now (in Pacific time,
    // since nextBusinessSlot schedules at 10:00 America/Vancouver)
    const toPacificDay = (d: Date) =>
      d.toLocaleDateString("en-CA", { timeZone: "America/Vancouver" });
    expect(toPacificDay(result)).not.toBe(toPacificDay(now));
    // The result time must be 10:00 Pacific (verify it is not midnight or arbitrary time)
    // We just check it is a reasonable hour: between 16:00 and 20:00 UTC (10:00 PDT = 17:00 UTC, 10:00 PST = 18:00 UTC)
    const resultHourUTC = result.getUTCHours();
    expect(resultHourUTC).toBeGreaterThanOrEqual(16);
    expect(resultHourUTC).toBeLessThanOrEqual(19);
  });
});
