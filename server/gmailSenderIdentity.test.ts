/**
 * The From address, the signature and the unsubscribe headers were all global
 * constants, so every tenant sent as one address with one branded signature and
 * booking link. That suits cold sales mail and reads wrong on a personal note.
 *
 * These tests pin the parts that decide what a recipient actually sees.
 */
import { describe, it, expect } from "vitest";
import { buildRawMessage } from "./gmailSender";

function decode(raw: string): string {
  return Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

const base = { to: "someone@example.com", subject: "Quick question", body: "Hi Parker,\n\nMany thanks,\nSam" };

describe("gmail sender identity", () => {
  it("defaults to the configured identity when no sender is given", () => {
    const msg = decode(buildRawMessage({ ...base }));
    expect(msg).toContain("From: Your Name <you@example.com>");
  });

  it("sends from the tenant's own identity when one is supplied", () => {
    const msg = decode(
      buildRawMessage({ ...base, from: { name: "Sam Seller", address: "sam@seller.example" } }),
    );
    expect(msg).toContain("From: Sam Seller <sam@seller.example>");
    expect(msg).not.toContain("you@example.com");
  });

  it("omits the branded signature, logo and booking link on personal mail", () => {
    const msg = decode(buildRawMessage({ ...base, includeSignature: false }));
    expect(msg).not.toContain("example.com/book");
    expect(msg).not.toContain("Account Executive");
    expect(msg).not.toContain("brand/email-logo.png");
    expect(msg).not.toContain("Schedule a Meeting");
  });

  it("still carries the signature by default, so sales mail is unchanged", () => {
    const msg = decode(buildRawMessage({ ...base }));
    expect(msg).toContain("Schedule a Meeting");
  });

  it("leaves a personal body exactly as written, sign-off included", () => {
    // The inline-signature stripper deletes everything from the sender's name
    // onward. It must not run on mail the sender wrote by hand.
    const body = "Hi Parker,\n\nSomething specific about Your Name's product.\n\nMany thanks,\nSam";
    const msg = decode(buildRawMessage({ ...base, body, includeSignature: false }));
    expect(msg).toContain("Many thanks,");
    expect(msg).toContain("Something specific about Your Name's product.");
  });

  it("omits List-Unsubscribe headers when they are not supplied", () => {
    const msg = decode(buildRawMessage({ ...base, includeSignature: false }));
    expect(msg).not.toContain("List-Unsubscribe");
  });

  it("still writes List-Unsubscribe headers when they are supplied", () => {
    const msg = decode(
      buildRawMessage({
        ...base,
        listUnsubscribeHeader: "<https://example.com/u/abc>",
        listUnsubscribePostHeader: "List-Unsubscribe=One-Click",
      }),
    );
    expect(msg).toContain("List-Unsubscribe: <https://example.com/u/abc>");
    expect(msg).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  });
});
