import { describe, it, expect } from "vitest";
import { scrubText, scrubEmail } from "./scrubber";

describe("scrubText", () => {
  it("replaces em-dashes with comma + space", () => {
    const result = scrubText("Hello—world");
    expect(result.text).toBe("Hello, world");
    expect(result.replacements).toBeGreaterThan(0);
  });

  it("replaces en-dashes with comma + space", () => {
    const result = scrubText("Hello–world");
    expect(result.text).toBe("Hello, world");
  });

  it("converts smart double quotes to straight", () => {
    const result = scrubText("\u201Chello\u201D");
    expect(result.text).toBe('"hello"');
  });

  it("converts smart single quotes to straight", () => {
    const result = scrubText("it\u2019s working");
    expect(result.text).toBe("it's working");
  });

  it("removes AI fingerprint phrases", () => {
    const result = scrubText("In today's fast-paced world of business. Our team rocks.");
    expect(result.text).not.toMatch(/fast-paced world/i);
  });

  it("returns no replacements for clean input", () => {
    const result = scrubText("Hello, world. This is fine.");
    expect(result.replacements).toBe(0);
  });
});

describe("scrubEmail", () => {
  it("scrubs both subject and body", () => {
    const r = scrubEmail({
      subject: "Quick note—follow up",
      body: "Hi Sam—just checking in. It\u2019s been a while.",
    });
    expect(r.subject).toBe("Quick note, follow up");
    expect(r.body).toContain("Hi Sam, just checking in.");
    expect(r.body).toContain("It's been a while");
    expect(r.totalReplacements).toBeGreaterThan(0);
  });

  it("trims subject whitespace", () => {
    const r = scrubEmail({ subject: "   spaced   ", body: "ok" });
    expect(r.subject).toBe("spaced");
  });
});
