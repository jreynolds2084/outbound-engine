/**
 * unsubscribe.test.ts
 * Token round-trip, tamper rejection, and header-format tests for the
 * one-click List-Unsubscribe support (RFC 8058).
 *
 * Mocks ./_core/env the same way localAuth.test.ts does, ENV is a plain
 * object resolved once at import time from process.env, so mutating
 * process.env after the (hoisted) import would be too late to affect it.
 */
import { describe, it, expect, vi } from "vitest";

const TEST_SECRET = "test-secret-at-least-32-chars-long!!";

vi.mock("./_core/env", () => ({
  ENV: {
    cookieSecret: TEST_SECRET,
    appId: "test",
    databaseUrl: "",
    oAuthServerUrl: "",
    ownerOpenId: "",
    isProduction: false,
    llmApiKey: "",
    llmApiUrl: "",
    ngrokTriggerUrl: "",
    ngrokTriggerToken: "",
    hunterApiKey: "",
  },
}));

const {
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  buildListUnsubscribeHeaders,
  LIST_UNSUBSCRIBE_POST_VALUE,
} = await import("./unsubscribe");

describe("signUnsubscribeToken / verifyUnsubscribeToken", () => {
  it("round-trips contactId and tenantId", async () => {
    const token = await signUnsubscribeToken(42, 7);
    const claims = await verifyUnsubscribeToken(token);
    expect(claims).toEqual({ contactId: 42, tenantId: 7 });
  });

  it("rejects an empty token", async () => {
    expect(await verifyUnsubscribeToken("")).toBeNull();
  });

  it("rejects a garbage token", async () => {
    expect(await verifyUnsubscribeToken("not-a-real-jwt")).toBeNull();
  });

  it("rejects a tampered token (signature no longer matches)", async () => {
    const token = await signUnsubscribeToken(42, 7);
    const tampered = token.slice(0, -4) + "abcd";
    expect(await verifyUnsubscribeToken(tampered)).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const { SignJWT } = await import("jose");
    const otherSecret = new TextEncoder().encode("a-completely-different-secret-value");
    const token = await new SignJWT({ sub: "42", tid: "7", typ: "unsub" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(otherSecret);
    expect(await verifyUnsubscribeToken(token)).toBeNull();
  });

  it("rejects a token of the wrong type (e.g. a local-auth session token shape)", async () => {
    const { SignJWT } = await import("jose");
    const secret = new TextEncoder().encode(TEST_SECRET);
    const wrongTypeToken = await new SignJWT({ sub: "42", typ: "local" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(secret);
    expect(await verifyUnsubscribeToken(wrongTypeToken)).toBeNull();
  });
});

describe("buildListUnsubscribeHeaders", () => {
  // PUBLIC_BASE_URL is resolved once at module load (same load-time-constant
  // convention gmailSender.ts already uses for the same env var), so its
  // per-deploy value, not per-call switching, is what's actually exercised
  // here; the default value is what this test environment gets.
  it("builds a URL under the public base URL", async () => {
    const headers = await buildListUnsubscribeHeaders(1, 1);
    expect(headers.url).toMatch(/^https:\/\/app\.example\.com\/api\/unsubscribe\/.+/);
  });

  it("wraps the URL in angle brackets for the List-Unsubscribe header (RFC 2369)", async () => {
    const headers = await buildListUnsubscribeHeaders(1, 1);
    expect(headers.listUnsubscribe).toBe(`<${headers.url}>`);
  });

  it("uses the exact RFC 8058 one-click value for List-Unsubscribe-Post", async () => {
    const headers = await buildListUnsubscribeHeaders(1, 1);
    expect(headers.listUnsubscribePost).toBe("List-Unsubscribe=One-Click");
    expect(headers.listUnsubscribePost).toBe(LIST_UNSUBSCRIBE_POST_VALUE);
  });

  it("produces a token that verifies back to the same contact/tenant", async () => {
    const headers = await buildListUnsubscribeHeaders(99, 3);
    const token = headers.url.split("/api/unsubscribe/")[1];
    const claims = await verifyUnsubscribeToken(token);
    expect(claims).toEqual({ contactId: 99, tenantId: 3 });
  });
});
