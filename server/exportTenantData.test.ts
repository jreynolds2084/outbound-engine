import { describe, it, expect } from "vitest";
import { CONTACT_HEADERS, OUTREACH_HEADERS, escapeCsvField, toCsv, toCsvRow } from "./exportTenantData";

describe("escapeCsvField", () => {
  it("quotes every field, so a delimiter in body copy can never split a row", () => {
    expect(escapeCsvField("plain")).toBe('"plain"');
    expect(escapeCsvField("Vancouver, BC")).toBe('"Vancouver, BC"');
  });

  it("doubles embedded quotes", () => {
    expect(escapeCsvField('He said "hello"')).toBe('"He said ""hello"""');
  });

  it("keeps newlines inside the quoted field, as outreach bodies contain them", () => {
    expect(escapeCsvField("Hi Dana,\n\nQuick question.")).toBe('"Hi Dana,\n\nQuick question."');
  });

  it("renders null and undefined as an empty cell, not the word null", () => {
    expect(escapeCsvField(null)).toBe('""');
    expect(escapeCsvField(undefined)).toBe('""');
  });

  it("renders numbers, booleans and dates predictably", () => {
    expect(escapeCsvField(42)).toBe('"42"');
    expect(escapeCsvField(0)).toBe('"0"');
    expect(escapeCsvField(true)).toBe('"true"');
    expect(escapeCsvField(false)).toBe('"false"');
    expect(escapeCsvField(new Date("2026-06-01T17:00:00Z"))).toBe('"2026-06-01T17:00:00.000Z"');
  });

  it("neutralises a formula, because this file is opened in a spreadsheet by definition", () => {
    expect(escapeCsvField("=1+1")).toBe(`"'=1+1"`);
    expect(escapeCsvField("=HYPERLINK(\"http://evil.test\",\"click\")")).toContain(`"'=HYPERLINK(`);
  });

  it("neutralises the other spreadsheet formula prefixes", () => {
    expect(escapeCsvField("+44 7700 900000")).toBe(`"'+44 7700 900000"`);
    expect(escapeCsvField("-lead")).toBe(`"'-lead"`);
    expect(escapeCsvField("@channel")).toBe(`"'@channel"`);
    expect(escapeCsvField("\tTabbed")).toBe(`"'\tTabbed"`);
    expect(escapeCsvField("\rReturn")).toBe(`"'\rReturn"`);
  });

  it("leaves a formula character alone when it is not the first character", () => {
    expect(escapeCsvField("Smith-Jones")).toBe('"Smith-Jones"');
    expect(escapeCsvField("dana@example.com")).toBe('"dana@example.com"');
  });

  it("leaves an empty string empty rather than prefixing it", () => {
    expect(escapeCsvField("")).toBe('""');
  });
});

describe("toCsvRow", () => {
  it("joins with commas and terminates with CRLF, per RFC 4180", () => {
    expect(toCsvRow(["a", "b"])).toBe('"a","b"\r\n');
  });

  it("emits an empty row for no fields", () => {
    expect(toCsvRow([])).toBe("\r\n");
  });
});

describe("toCsv", () => {
  it("writes a header row followed by the data rows", () => {
    const csv = toCsv(["id", "name"], [[1, "Dana Reyes"], [2, "Sam Okafor"]]);
    expect(csv).toBe('"id","name"\r\n"1","Dana Reyes"\r\n"2","Sam Okafor"\r\n');
  });

  it("writes a header-only document when there are no rows", () => {
    expect(toCsv(["id"], [])).toBe('"id"\r\n');
  });

  it("survives a body containing commas, quotes and newlines together", () => {
    const body = 'Hi Dana,\n\nWe "handle" HVAC, plumbing, and electrical.\n\nJames';
    const csv = toCsv(["subject", "body"], [["Quick question", body]]);
    const rows = csv.split("\r\n").filter((r) => r.length > 0);
    // Two logical rows even though the body itself contains blank lines.
    expect(rows).toHaveLength(2);
    expect(csv).toContain('""handle""');
  });
});

describe("export table shapes", () => {
  it("keeps the opt-out columns, so a departing client can honour suppressions", () => {
    expect(CONTACT_HEADERS).toContain("opted_out");
    expect(CONTACT_HEADERS).toContain("opted_out_at");
  });

  it("exports the outreach copy itself, not just metadata about it", () => {
    expect(OUTREACH_HEADERS).toContain("subject");
    expect(OUTREACH_HEADERS).toContain("body");
  });

  it("carries the join keys needed to reassemble the two files", () => {
    expect(CONTACT_HEADERS).toContain("contact_id");
    expect(OUTREACH_HEADERS).toContain("contact_id");
  });

  it("has no duplicate column names in either file", () => {
    expect(new Set(CONTACT_HEADERS).size).toBe(CONTACT_HEADERS.length);
    expect(new Set(OUTREACH_HEADERS).size).toBe(OUTREACH_HEADERS.length);
  });
});
