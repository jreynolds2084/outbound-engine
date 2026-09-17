/**
 * Tests for the approveSend override fields logic.
 *
 * The approveSend mutation accepts optional overrideSubject and overrideBody.
 * When provided, these replace the stored email content before the scrubber runs.
 * When omitted, the stored content is used as-is.
 *
 * We test this at the scrubber layer (the only pure function involved) since
 * the full tRPC mutation requires a live DB. The key invariant is:
 *   scrubEmail(override ?? stored) === what gets sent
 */

import { describe, it, expect } from "vitest";
import { scrubEmail } from "./scrubber";

function simulateApproveSend(
  stored: { subject: string; body: string },
  override?: { subject?: string; body?: string },
) {
  const subjectToSend = override?.subject ?? stored.subject;
  const bodyToSend = override?.body ?? stored.body;
  return scrubEmail({ subject: subjectToSend, body: bodyToSend });
}

describe("approveSend override fields", () => {
  it("uses stored content when no override is provided", () => {
    const stored = { subject: "Original subject", body: "Original body" };
    const result = simulateApproveSend(stored);
    expect(result.subject).toBe("Original subject");
    expect(result.body).toBe("Original body");
  });

  it("uses overrideSubject when provided, keeps stored body", () => {
    const stored = { subject: "Original subject", body: "Original body" };
    const result = simulateApproveSend(stored, { subject: "Edited subject" });
    expect(result.subject).toBe("Edited subject");
    expect(result.body).toBe("Original body");
  });

  it("uses overrideBody when provided, keeps stored subject", () => {
    const stored = { subject: "Original subject", body: "Original body" };
    const result = simulateApproveSend(stored, { body: "Edited body" });
    expect(result.subject).toBe("Original subject");
    expect(result.body).toBe("Edited body");
  });

  it("uses both overrides when both are provided", () => {
    const stored = { subject: "Original subject", body: "Original body" };
    const result = simulateApproveSend(stored, {
      subject: "Edited subject",
      body: "Edited body",
    });
    expect(result.subject).toBe("Edited subject");
    expect(result.body).toBe("Edited body");
  });

  it("scrubber still runs on overridden content", () => {
    const stored = { subject: "Original", body: "Original" };
    const result = simulateApproveSend(stored, {
      subject: "Quick note\u2014follow up",
      body: "Hi Sam\u2014just checking in.",
    });
    // Em-dashes in the override should be scrubbed
    expect(result.subject).toBe("Quick note, follow up");
    expect(result.body).toContain("Hi Sam, just checking in.");
    expect(result.totalReplacements).toBeGreaterThan(0);
  });

  it("empty string override is treated as an override (not fallback to stored)", () => {
    const stored = { subject: "Original subject", body: "Original body" };
    // An empty string is a valid override, user deliberately cleared the field
    const result = simulateApproveSend(stored, { subject: "" });
    // scrubEmail trims, so empty string → empty string
    expect(result.subject).toBe("");
  });
});
