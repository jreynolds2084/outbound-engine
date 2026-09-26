import { describe, it, expect } from "vitest";
import {
  averageDailySends,
  DEFAULT_STALL_GRACE_DAYS,
  findStalledTouches,
  renderMonthlyReport,
  stalledContactCount,
  TERMINAL_CONTACT_STATUSES,
  type MonthlyReport,
  type StallCandidate,
} from "./reporting";

const NOW = new Date("2026-06-20T17:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * DAY_MS);
}

function candidate(overrides: Partial<StallCandidate> = {}): StallCandidate {
  return {
    emailId: 1,
    contactId: 10,
    contactName: "Dana Reyes",
    contactStatus: "Sent",
    optedOut: false,
    dayNumber: 2,
    status: "Pending",
    scheduledDate: daysAgo(10),
    ...overrides,
  };
}

describe("findStalledTouches", () => {
  it("flags a Pending touch well past its scheduled date", () => {
    const stalled = findStalledTouches([candidate()], NOW);
    expect(stalled).toHaveLength(1);
    expect(stalled[0].daysLate).toBe(10);
  });

  it("ignores a touch still inside the grace period", () => {
    expect(findStalledTouches([candidate({ scheduledDate: daysAgo(2) })], NOW)).toHaveLength(0);
  });

  it("leaves a weekend alone at the default grace, so Friday-due is not a failure on Monday", () => {
    expect(DEFAULT_STALL_GRACE_DAYS).toBeGreaterThanOrEqual(3);
    expect(findStalledTouches([candidate({ scheduledDate: daysAgo(DEFAULT_STALL_GRACE_DAYS - 1) })], NOW)).toHaveLength(0);
  });

  it("ignores a touch scheduled in the future", () => {
    expect(findStalledTouches([candidate({ scheduledDate: new Date(NOW.getTime() + 5 * DAY_MS) })], NOW)).toHaveLength(0);
  });

  it("ignores touches that are not Pending", () => {
    for (const status of ["Sent", "Skipped", "Bounced"]) {
      expect(findStalledTouches([candidate({ status })], NOW)).toHaveLength(0);
    }
  });

  it("ignores contacts in a terminal status, whose pending touches are meant to sit", () => {
    for (const contactStatus of TERMINAL_CONTACT_STATUSES) {
      expect(findStalledTouches([candidate({ contactStatus })], NOW)).toHaveLength(0);
    }
  });

  it("ignores contacts who opted out", () => {
    expect(findStalledTouches([candidate({ optedOut: true })], NOW)).toHaveLength(0);
  });

  it("still flags a contact whose status is an in-progress one", () => {
    for (const contactStatus of ["Pending", "Sent", "Warm"]) {
      expect(findStalledTouches([candidate({ contactStatus })], NOW)).toHaveLength(1);
    }
  });

  it("ignores touches the caller says were throttled by policy, not dropped", () => {
    const due = [candidate({ emailId: 1 }), candidate({ emailId: 2, contactId: 11 })];
    const stalled = findStalledTouches(due, NOW, { excludeIds: [1] });
    expect(stalled.map((s) => s.emailId)).toEqual([2]);
  });

  it("honours a caller-supplied grace period", () => {
    const due = [candidate({ scheduledDate: daysAgo(10) })];
    expect(findStalledTouches(due, NOW, { graceDays: 14 })).toHaveLength(0);
    expect(findStalledTouches(due, NOW, { graceDays: 1 })).toHaveLength(1);
  });

  it("returns the worst first", () => {
    const due = [
      candidate({ emailId: 1, contactId: 10, scheduledDate: daysAgo(5) }),
      candidate({ emailId: 2, contactId: 11, scheduledDate: daysAgo(19) }),
      candidate({ emailId: 3, contactId: 12, scheduledDate: daysAgo(12) }),
    ];
    expect(findStalledTouches(due, NOW).map((s) => s.emailId)).toEqual([2, 3, 1]);
  });

  it("orders deterministically when two contacts are equally late", () => {
    const due = [
      candidate({ emailId: 9, contactId: 99, scheduledDate: daysAgo(7) }),
      candidate({ emailId: 8, contactId: 12, scheduledDate: daysAgo(7) }),
    ];
    expect(findStalledTouches(due, NOW).map((s) => s.contactId)).toEqual([12, 99]);
  });

  it("handles an empty candidate list", () => {
    expect(findStalledTouches([], NOW)).toEqual([]);
  });
});

describe("stalledContactCount", () => {
  it("counts prospects, not touches, so one neglected contact is not reported five times", () => {
    const due = [
      candidate({ emailId: 1, contactId: 10, dayNumber: 2 }),
      candidate({ emailId: 2, contactId: 10, dayNumber: 3 }),
      candidate({ emailId: 3, contactId: 10, dayNumber: 4 }),
      candidate({ emailId: 4, contactId: 11, dayNumber: 2 }),
    ];
    const stalled = findStalledTouches(due, NOW);
    expect(stalled).toHaveLength(4);
    expect(stalledContactCount(stalled)).toBe(2);
  });

  it("is zero for an empty list", () => {
    expect(stalledContactCount([])).toBe(0);
  });
});

describe("averageDailySends", () => {
  const period = { start: new Date("2026-06-01T07:00:00Z"), end: new Date("2026-07-01T07:00:00Z") };

  it("divides by elapsed days, not by the whole month, when run mid-month", () => {
    // 10 days elapsed at 2026-06-11.
    expect(averageDailySends(950, period, new Date("2026-06-11T07:00:00Z"))).toBe(95);
  });

  it("divides by the full period once the month has closed", () => {
    expect(averageDailySends(3000, period, new Date("2026-07-15T07:00:00Z"))).toBe(100);
  });

  it("does not divide by zero on the first instant of the period", () => {
    expect(averageDailySends(0, period, period.start)).toBe(0);
    expect(Number.isFinite(averageDailySends(5, period, period.start))).toBe(true);
  });
});

describe("renderMonthlyReport", () => {
  const base: MonthlyReport = {
    tenantId: 1,
    tenantName: "Example Client",
    period: { start: new Date("2026-06-01T07:00:00Z"), end: new Date("2026-07-01T07:00:00Z") },
    counts: {
      contactsLoaded: 480,
      contactsVerified: 441,
      touchesQueued: 1920,
      touchesSent: 1870,
      touchesAwaitingApproval: 64,
    },
    stalled: [],
    stalledContacts: 0,
    averageDailySends: 93.5,
    dailyEmailCeiling: 100,
    monthlyContactCeiling: 500,
    ungoverned: false,
  };

  it("reports a clean month as none out of cadence", () => {
    const text = renderMonthlyReport(base);
    expect(text).toContain("Prospects out of cadence:            none");
    expect(text).toContain("480");
    expect(text).toContain("100/day, 500 contacts/month");
  });

  it("names the worst offenders when prospects went quiet", () => {
    const text = renderMonthlyReport({
      ...base,
      stalled: [
        { emailId: 1, contactId: 10, contactName: "Dana Reyes", dayNumber: 3, scheduledDate: daysAgo(19), daysLate: 19 },
        { emailId: 2, contactId: 11, contactName: "Sam Okafor", dayNumber: 2, scheduledDate: daysAgo(6), daysLate: 6 },
      ],
      stalledContacts: 2,
    });
    expect(text).toContain("Prospects out of cadence:            2");
    expect(text).toContain("Dana Reyes, touch 3, 19 days late");
    expect(text).toContain("Sam Okafor, touch 2, 6 days late");
  });

  it("truncates a long stall list rather than printing hundreds of lines", () => {
    const stalled = Array.from({ length: 25 }, (_, i) => ({
      emailId: i + 1,
      contactId: i + 1,
      contactName: `Contact ${i + 1}`,
      dayNumber: 2,
      scheduledDate: daysAgo(10),
      daysLate: 10,
    }));
    const text = renderMonthlyReport({ ...base, stalled, stalledContacts: 25 });
    expect(text).toContain("...and 15 more touches");
  });

  it("says plainly when no ceiling is configured", () => {
    const text = renderMonthlyReport({
      ...base,
      dailyEmailCeiling: null,
      monthlyContactCeiling: null,
      ungoverned: true,
    });
    expect(text).toContain("NOT CONFIGURED");
  });

  it("warns when the monthly contact ceiling was exceeded", () => {
    const text = renderMonthlyReport({ ...base, counts: { ...base.counts, contactsLoaded: 560 } });
    expect(text).toContain("exceeded the monthly ceiling by 60");
  });

  it("prints the period as an inclusive range ending on the last day of the month", () => {
    const text = renderMonthlyReport(base, "America/Vancouver");
    expect(text).toContain("Jun 1, 2026");
    expect(text).toContain("Jun 30, 2026");
  });
});
