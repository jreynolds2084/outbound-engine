/**
 * unsubscribe.ts
 *
 * One-click List-Unsubscribe support (RFC 8058): builds the per-contact URL
 * and header values every send path attaches, and verifies the token the
 * landing endpoint (unsubscribeHandler.ts) receives back.
 *
 * Deliberately wired into the suppression mechanism that already exists,
 * suppressContact() in replyAgent.ts, the same permanent opt-out cascade the
 * reply-based CASL flow uses (commit 4e52c34). This module only builds the
 * trigger (the link); it is not a second suppression mechanism.
 *
 * Token: a stateless, signed JWT carrying { contactId, tenantId }, using the
 * same secret already used to sign local-auth session cookies
 * (ENV.cookieSecret / JWT_SECRET). No new DB table, no schema migration,
 * the token itself is the credential. Long-lived (10 years): the link is
 * embedded in mail that can sit unread in an inbox for months, and an
 * expired unsubscribe link is worse than a permanent one, CASL requires the
 * mechanism to keep working, not to lapse.
 */
import { SignJWT, jwtVerify } from "jose";
import { ENV } from "./_core/env";

const TOKEN_TYPE = "unsub";
const TEN_YEARS_MS = 1000 * 60 * 60 * 24 * 365 * 10;

function getSecret() {
  return new TextEncoder().encode(ENV.cookieSecret);
}

/**
 * Same PUBLIC_BASE_URL convention gmailSender.ts uses for asset URLs, kept
 * as a local copy rather than importing/exporting across modules for a
 * two-line constant (no refactor of a working file for this).
 */
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? "https://app.example.com").replace(/\/$/, "");

/** RFC 8058's required header value, marks the link as safe for an automatic one-click POST. */
export const LIST_UNSUBSCRIBE_POST_VALUE = "List-Unsubscribe=One-Click";

export async function signUnsubscribeToken(contactId: number, tenantId: number): Promise<string> {
  const expiresAt = Math.floor((Date.now() + TEN_YEARS_MS) / 1000);
  return new SignJWT({ sub: String(contactId), tid: String(tenantId), typ: TOKEN_TYPE })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setExpirationTime(expiresAt)
    .sign(getSecret());
}

export interface UnsubscribeClaims {
  contactId: number;
  tenantId: number;
}

/** Verifies signature + shape. Returns null on any failure, never throws. */
export async function verifyUnsubscribeToken(token: string): Promise<UnsubscribeClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ["HS256"] });
    if (payload.typ !== TOKEN_TYPE || !payload.sub) return null;
    const contactId = parseInt(String(payload.sub), 10);
    const tenantId = parseInt(String(payload.tid ?? ""), 10);
    if (isNaN(contactId) || isNaN(tenantId)) return null;
    return { contactId, tenantId };
  } catch {
    return null;
  }
}

export interface ListUnsubscribeHeaders {
  /** Full https URL, the one-click POST target, and the fallback for a plain click. */
  url: string;
  /** Value for the `List-Unsubscribe` header, RFC 2369 angle-bracket form. */
  listUnsubscribe: string;
  /** Value for the `List-Unsubscribe-Post` header (RFC 8058). */
  listUnsubscribePost: string;
}

/**
 * Build the one-click unsubscribe URL + header values for a contact. Every
 * send path (Gmail, Graph, relayed sends) calls this and
 * wires the result into its own header-setting mechanism.
 */
export async function buildListUnsubscribeHeaders(
  contactId: number,
  tenantId: number,
): Promise<ListUnsubscribeHeaders> {
  const token = await signUnsubscribeToken(contactId, tenantId);
  const url = `${PUBLIC_BASE_URL}/api/unsubscribe/${token}`;
  return {
    url,
    listUnsubscribe: `<${url}>`,
    listUnsubscribePost: LIST_UNSUBSCRIBE_POST_VALUE,
  };
}
