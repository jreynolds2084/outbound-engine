/**
 * fixedTemplates.test.ts
 *
 * The fixed-template engine behind Add Contacts. The two invariants that must
 * never drift:
 *   1. dayNumber is a touch index 1..N, followUpCadence's re-anchor table is
 *      keyed by consecutive touch numbers and silently skips anything else.
 *   2. No placeholder survives to a stored row, the send path interpolates
 *      nothing, so a leftover {{token}} would be emailed literally.
 */
import { describe, expect, it } from "vitest";
import {
  buildSequenceRows,
  findUnresolvedPlaceholders,
  firstNameOf,
  interpolate,
  parseFixedTemplates,
  staggerDayForIndex,
  trackForContactIndex,
  type FixedTemplateConfig,
} from "./fixedTemplates";

const CONFIG: FixedTemplateConfig = {
  type: "fixed-templates",
  batchPerDay: 8,
  provisionalOffsets: { "1": 0, "2": 2, "3": 4, "4": 8 },
  tracks: {
    A: [
      { subject: "Introduction", body: "Hi {{firstName}}, I work with {{company}}." },
      { subject: "Planning", body: "Hi {{firstName}}, still thinking of {{company}}." },
      { subject: "Wrong door?", body: "Hi {{firstName}}." },
      { subject: "Open door", body: "Hi {{firstName}}, door stays open for {{company}}." },
    ],
    B: [
      { subject: "Introduction", body: "Hi {{firstName}}, different angle on {{company}}." },
      { subject: "Check", body: "Hi {{firstName}}." },
      { subject: "Worth fixing", body: "Hi {{firstName}}." },
      { subject: "One question", body: "Hi {{firstName}}." },
    ],
  },
};

describe("parseFixedTemplates", () => {
  it("parses a valid fixed-templates config", () => {
    const parsed = parseFixedTemplates(JSON.stringify(CONFIG));
    expect(parsed).not.toBeNull();
    expect(parsed!.tracks.A).toHaveLength(4);
  });

  it("returns null for null, empty, and legacy values instead of throwing", () => {
    // "[]" is a live legacy value in existing tenant rows; "{}" and random blobs are
    // plausible future states of the shared column. All must read as
    // "no templates", never as an error.
    for (const legacy of [null, undefined, "", "[]", "{}", "not json", '{"type":"other"}']) {
      expect(parseFixedTemplates(legacy)).toBeNull();
    }
  });

  it("rejects a config with more than 5 touches, the cadence table stops at 5", () => {
    const sixTouches = {
      ...CONFIG,
      tracks: {
        A: Array.from({ length: 6 }, (_, i) => ({ subject: `S${i}`, body: "Hi {{firstName}}" })),
        B: CONFIG.tracks.B,
      },
    };
    expect(parseFixedTemplates(JSON.stringify(sixTouches))).toBeNull();
  });
});

describe("interpolate", () => {
  it("replaces known fields and leaves unknown tokens intact", () => {
    expect(interpolate("Hi {{firstName}} of {{company}}, re {{mystery}}", { firstName: "Jane", company: "Acme" }))
      .toBe("Hi Jane of Acme, re {{mystery}}");
  });

  it("findUnresolvedPlaceholders reports leftover tokens", () => {
    expect(findUnresolvedPlaceholders("Hi {{firstName}}, {{weird}}")).toEqual(["firstName", "weird"]);
    expect(findUnresolvedPlaceholders("clean text")).toEqual([]);
  });
});

describe("trackForContactIndex", () => {
  it("alternates A/B by existing contact count at the account", () => {
    expect(trackForContactIndex(0)).toBe("A");
    expect(trackForContactIndex(1)).toBe("B");
    expect(trackForContactIndex(2)).toBe("A");
    expect(trackForContactIndex(3)).toBe("B");
  });
});

describe("staggerDayForIndex", () => {
  it("releases batchPerDay touch-1s per day", () => {
    expect(staggerDayForIndex(0, 8)).toBe(0);
    expect(staggerDayForIndex(7, 8)).toBe(0);
    expect(staggerDayForIndex(8, 8)).toBe(1);
    expect(staggerDayForIndex(23, 8)).toBe(2);
  });

  it("survives a zero/invalid batchPerDay without dividing by zero", () => {
    expect(staggerDayForIndex(5, 0)).toBe(5);
  });
});

describe("buildSequenceRows", () => {
  const t1 = new Date("2026-08-17T20:00:00Z");

  it("writes dayNumber as consecutive touch indexes 1..N, never day offsets", () => {
    const rows = buildSequenceRows(CONFIG, "A", { firstName: "Jane", company: "Acme" }, t1);
    expect(rows.map((r) => r.dayNumber)).toEqual([1, 2, 3, 4]);
    expect(rows.map((r) => r.touch)).toEqual(["Touch 1", "Touch 2", "Touch 3", "Touch 4"]);
  });

  it("interpolates firstName and company into every touch", () => {
    const rows = buildSequenceRows(CONFIG, "A", { firstName: "Jane", company: "Acme" }, t1);
    expect(rows[0].body).toBe("Hi Jane, I work with Acme.");
    expect(rows[3].body).toBe("Hi Jane, door stays open for Acme.");
  });

  it("dates touch 1 at the given date and later touches at provisional offsets", () => {
    const rows = buildSequenceRows(CONFIG, "B", { firstName: "Jane", company: "Acme" }, t1);
    expect(rows[0].scheduledDate.getTime()).toBe(t1.getTime());
    expect(rows[1].scheduledDate.getTime()).toBe(t1.getTime() + 2 * 86_400_000);
    expect(rows[2].scheduledDate.getTime()).toBe(t1.getTime() + 4 * 86_400_000);
    expect(rows[3].scheduledDate.getTime()).toBe(t1.getTime() + 8 * 86_400_000);
  });

  it("throws on a malformed token the placeholder pattern cannot match", () => {
    // "{{ firstName" interpolates to nothing and matches no pattern, so
    // without the stray-brace check it would be emailed literally.
    const malformed: FixedTemplateConfig = {
      ...CONFIG,
      tracks: {
        A: [{ subject: "Hi", body: "Hi {{ firstName, quick note" }],
        B: [{ subject: "Hi", body: "ok {{firstName}}" }],
      },
    };
    expect(() => buildSequenceRows(malformed, "A", { firstName: "Jane", company: "Acme" }, t1)).toThrow(
      /malformed token/,
    );
  });

  it("throws on unresolved placeholders instead of storing them", () => {
    const bad: FixedTemplateConfig = {
      ...CONFIG,
      tracks: {
        A: [{ subject: "Hi", body: "Dear {{fullTitle}}" }],
        B: [{ subject: "Hi", body: "ok {{firstName}}" }],
      },
    };
    expect(() => buildSequenceRows(bad, "A", { firstName: "Jane", company: "Acme" }, t1)).toThrow(
      /unresolved placeholders: fullTitle/,
    );
  });
});

describe("firstNameOf", () => {
  it("takes the first whitespace-separated token", () => {
    expect(firstNameOf("Jane Q. Doe")).toBe("Jane");
    expect(firstNameOf("  Jane   ")).toBe("Jane");
    expect(firstNameOf("")).toBe("");
  });
});
