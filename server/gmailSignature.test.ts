/**
 * The tenant-config signature.
 *
 * Personal mail suppresses the branded signature block, which is right, but
 * "no marketing footer" and "no signature at all" are different things, and
 * the first such send went out ending on a bare first name.
 */
import { describe, it, expect } from "vitest";
import { buildRawMessage } from "./gmailSender";

const decode = (raw: string) =>
  Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

const SIG = "Sam Seller\n555-010-0199\nlinkedin.com/in/sam-seller\nsellersite.example";
const base = {
  to: "parker@prospect.example",
  subject: "Quick question",
  body: "Hi Parker,\n\nSomething specific.\n\nMany thanks,\nSam",
};

describe("typed signature", () => {
  it("appears in both the plain-text and HTML parts", () => {
    const msg = decode(buildRawMessage({ ...base, includeSignature: false, signature: SIG }));
    // Plain part: a text-only client must still see a name and a phone number.
    expect(msg).toContain("555-010-0199");
    expect(msg.match(/sellersite\.example/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("links the website, profile and phone without inventing a logo or a title", () => {
    const msg = decode(buildRawMessage({ ...base, includeSignature: false, signature: SIG }));
    expect(msg).toContain('href="https://sellersite.example"');
    expect(msg).toContain('href="https://linkedin.com/in/sam-seller"');
    expect(msg).toContain('href="tel:5550100199"');
    expect(msg).not.toContain("Account Executive");
    expect(msg).not.toContain("email-logo.png");
  });

  it("never lets the branded block ride along with it", () => {
    const msg = decode(buildRawMessage({ ...base, includeSignature: true, signature: SIG }));
    expect(msg).toContain("555-010-0199");
    expect(msg).not.toContain("Schedule a Meeting");
    expect(msg).not.toContain("example.com/book");
  });

  it("leaves the body untouched, the sign-off the sender wrote still stands", () => {
    const msg = decode(buildRawMessage({ ...base, includeSignature: false, signature: SIG }));
    expect(msg).toContain("Many thanks,");
    expect(msg).toContain("Something specific.");
  });

  it("changes nothing when no signature is configured", () => {
    const msg = decode(buildRawMessage({ ...base, includeSignature: false }));
    expect(msg).not.toContain("555-010-0199");
    expect(msg).not.toContain("Schedule a Meeting");
  });
});
