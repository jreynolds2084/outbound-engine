/**
 * gmailSender.test.ts
 * Covers only the List-Unsubscribe / List-Unsubscribe-Post header wiring in
 * buildRawMessage, no existing test file covered this module, and a full
 * suite (Gmail API mocking, checkBounce, signature stripping) is out of
 * scope for this change.
 */
import { describe, it, expect } from "vitest";
import { buildRawMessage } from "./gmailSender";

function decodeRaw(raw: string): string {
  return Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

describe("buildRawMessage, List-Unsubscribe headers", () => {
  it("omits both headers when neither is supplied (backward compatible)", () => {
    const decoded = decodeRaw(buildRawMessage({ to: "a@b.test", subject: "Hi", body: "Body" }));
    expect(decoded).not.toContain("List-Unsubscribe");
  });

  it("includes List-Unsubscribe in RFC 2369 angle-bracket form when supplied", () => {
    const decoded = decodeRaw(
      buildRawMessage({
        to: "a@b.test",
        subject: "Hi",
        body: "Body",
        listUnsubscribeHeader: "<https://app.example.com/api/unsubscribe/TOKEN>",
      }),
    );
    expect(decoded).toContain("List-Unsubscribe: <https://app.example.com/api/unsubscribe/TOKEN>");
  });

  it("includes List-Unsubscribe-Post with the exact RFC 8058 one-click value when supplied", () => {
    const decoded = decodeRaw(
      buildRawMessage({
        to: "a@b.test",
        subject: "Hi",
        body: "Body",
        listUnsubscribePostHeader: "List-Unsubscribe=One-Click",
      }),
    );
    expect(decoded).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  });

  it("includes only the header actually supplied, the two are independent", () => {
    const decoded = decodeRaw(
      buildRawMessage({
        to: "a@b.test",
        subject: "Hi",
        body: "Body",
        listUnsubscribeHeader: "<https://example.com/u/1>",
      }),
    );
    expect(decoded).toContain("List-Unsubscribe: <https://example.com/u/1>");
    expect(decoded).not.toContain("List-Unsubscribe-Post");
  });
});
