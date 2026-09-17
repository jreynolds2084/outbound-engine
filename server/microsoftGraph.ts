/**
 * Microsoft Graph OAuth + Mail.Send
 * ──────────────────────────────────
 * Handles the full OAuth 2.0 authorization code flow for Microsoft 365.
 * Tokens are stored encrypted in the tenant row (microsoftOAuthJson).
 *
 * Flow:
 *   1. getAuthUrl(tenantSlug, redirectBase) → redirect user to Microsoft login
 *   2. handleCallback(code, state) → exchange code for tokens, store in tenant row
 *   3. sendEmail(tenantSlug, to, subject, html) → send via Graph API, auto-refresh token
 */

import { ENV } from "./_core/env";
import { getDb } from "./db";
import { tenants } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { LIST_UNSUBSCRIBE_POST_VALUE } from "./unsubscribe";

const GRAPH_SCOPES = ["Mail.Send", "Mail.Read", "Mail.ReadWrite", "offline_access", "User.Read"].join(" ");
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const AUTH_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const GRAPH_SEND_URL = "https://graph.microsoft.com/v1.0/me/sendMail";

/**
 * Fixed callback URI: all tenants share one callback, and `state` carries the
 * tenant slug. Every tenant's Microsoft connect flow routes through it, so it
 * lives in config, not code.
 *
 * Must match a Redirect URI registered on the app in Entra ID (Azure AD)
 * exactly; Microsoft rejects any value that is not pre-registered. The
 * fallback only suits local development.
 */
const REDIRECT_URI =
  process.env.MICROSOFT_OAUTH_REDIRECT_URI ??
  "http://localhost:3000/api/oauth/microsoft/callback";

type TokenSet = {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix ms
  email?: string;
};

// ─── Build the authorization URL ─────────────────────────────────────────────
export function getMicrosoftAuthUrl(tenantSlug: string): string {
  if (!ENV.microsoftClientId) throw new Error("MICROSOFT_CLIENT_ID not configured");
  const params = new URLSearchParams({
    client_id: ENV.microsoftClientId,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: GRAPH_SCOPES,
    state: tenantSlug,
    prompt: "select_account",
  });
  return `${AUTH_URL}?${params.toString()}`;
}

// ─── Exchange authorization code for tokens ───────────────────────────────────
export async function handleMicrosoftCallback(
  code: string,
  tenantSlug: string
): Promise<{ email: string }> {
  const body = new URLSearchParams({
    client_id: ENV.microsoftClientId,
    client_secret: ENV.microsoftClientSecret,
    code,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
    scope: GRAPH_SCOPES,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Microsoft token exchange failed: ${err}`);
  }

  const data = await res.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  // Fetch the user's email from Graph
  const meRes = await fetch("https://graph.microsoft.com/v1.0/me", {
    headers: { Authorization: `Bearer ${data.access_token}` },
  });
  const me = await meRes.json() as { mail?: string; userPrincipalName?: string };
  const email = me.mail ?? me.userPrincipalName ?? "";

  const tokenSet: TokenSet = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    email,
  };

  // Store in tenant row
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(tenants)
    .set({ microsoftOAuthJson: JSON.stringify(tokenSet) })
    .where(eq(tenants.slug, tenantSlug));

  return { email };
}

// ─── Get a valid access token (auto-refresh if expired) ───────────────────────
async function getValidAccessToken(tenantSlug: string): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db.select().from(tenants).where(eq(tenants.slug, tenantSlug)).limit(1);
  const tenant = rows[0];
  if (!tenant?.microsoftOAuthJson) {
    throw new Error(`Tenant ${tenantSlug} has no Microsoft OAuth tokens`);
  }

  const tokens = JSON.parse(tenant.microsoftOAuthJson) as TokenSet;

  // Refresh if token expires within 5 minutes
  if (tokens.expires_at - Date.now() < 5 * 60 * 1000) {
    const body = new URLSearchParams({
      client_id: ENV.microsoftClientId,
      client_secret: ENV.microsoftClientSecret,
      refresh_token: tokens.refresh_token,
      grant_type: "refresh_token",
      scope: GRAPH_SCOPES,
    });

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Microsoft token refresh failed: ${err}`);
    }

    const data = await res.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    tokens.access_token = data.access_token;
    if (data.refresh_token) tokens.refresh_token = data.refresh_token;
    tokens.expires_at = Date.now() + data.expires_in * 1000;

    await db
      .update(tenants)
      .set({ microsoftOAuthJson: JSON.stringify(tokens) })
      .where(eq(tenants.slug, tenantSlug));

  }

  return tokens.access_token;
}

/**
 * Build a raw RFC 2822 MIME message carrying arbitrary Internet message
 * headers. Needed because Graph's JSON message object (`internetMessageHeaders`)
 * rejects any header not prefixed "x-"/"X-", which rules out setting the
 * real `List-Unsubscribe` and `List-Unsubscribe-Post` header names that way
 * (confirmed against Microsoft Graph docs/forum reports, 2026-08).
 * Graph does document a MIME create path instead: POST /me/messages with
 * `Content-Type: text/plain` and a base64-encoded raw message body, see
 * usage in sendViaGraph() below. Exported for unit testing.
 */
export function buildGraphMimeMessage(params: {
  to: string;
  subject: string;
  html: string;
  listUnsubscribeUrl?: string;
}): string {
  const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  // Crude plain-text fallback derived from the HTML body, mirrors the
  // multipart/alternative shape gmailSender.ts builds for its own sends.
  const plainBody = params.html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const headerLines: string[] = [
    `To: ${params.to}`,
    `Subject: ${params.subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];

  if (params.listUnsubscribeUrl) {
    headerLines.push(`List-Unsubscribe: <${params.listUnsubscribeUrl}>`);
    headerLines.push(`List-Unsubscribe-Post: ${LIST_UNSUBSCRIBE_POST_VALUE}`);
  }

  const plainPart = [
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    plainBody,
  ].join("\r\n");

  const htmlPart = [
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    params.html,
  ].join("\r\n");

  const closingBoundary = `--${boundary}--`;

  return [...headerLines, "", plainPart, "", htmlPart, "", closingBoundary].join("\r\n");
}

// ─── Send an email via Microsoft Graph ───────────────────────────────────────
/**
 * Sends an email via Microsoft Graph using a two-step create-then-send flow.
 * Returns { messageId, conversationId } so callers can store them for reply matching.
 * The /me/sendMail endpoint returns 202 with no body, so we cannot get IDs from it.
 * Instead: POST /me/messages (create draft) → POST /me/messages/{id}/send.
 *
 * When `listUnsubscribeUrl` is set, step 1 creates the draft from raw MIME
 * (see buildGraphMimeMessage) instead of the plain JSON message object, so
 * the List-Unsubscribe / List-Unsubscribe-Post headers can be attached at
 * all. Step 2 (send) is unchanged either way, it sends whatever draft id
 * came back from step 1.
 */
export async function sendViaGraph(params: {
  tenantSlug: string;
  to: string;
  subject: string;
  html: string;
  fromName?: string;
  /** RFC 8058 one-click unsubscribe URL, see unsubscribe.ts. Omit to send with no List-Unsubscribe headers. */
  listUnsubscribeUrl?: string;
}): Promise<{ messageId: string; conversationId: string }> {
  const accessToken = await getValidAccessToken(params.tenantSlug);

  // Step 1: Create a draft, Graph returns the full message object including conversationId
  const createUrl = "https://graph.microsoft.com/v1.0/me/messages";

  let createRes: Response;
  if (params.listUnsubscribeUrl) {
    const mime = buildGraphMimeMessage({
      to: params.to,
      subject: params.subject,
      html: params.html,
      listUnsubscribeUrl: params.listUnsubscribeUrl,
    });
    const base64Mime = Buffer.from(mime, "utf-8").toString("base64");
    createRes = await fetch(createUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "text/plain",
      },
      body: base64Mime,
    });
  } else {
    const message = {
      subject: params.subject,
      body: { contentType: "HTML", content: params.html },
      toRecipients: [{ emailAddress: { address: params.to } }],
    };
    createRes = await fetch(createUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(message),
    });
  }

  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(`Microsoft Graph create draft failed: ${err}`);
  }

  const draft = await createRes.json() as { id: string; conversationId: string };
  const draftId = draft.id;
  const conversationId = draft.conversationId;

  // Step 2: Send the draft
  const sendUrl = `https://graph.microsoft.com/v1.0/me/messages/${draftId}/send`;
  const sendRes = await fetch(sendUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!sendRes.ok) {
    const err = await sendRes.text();
    throw new Error(`Microsoft Graph send draft failed: ${err}`);
  }

  return { messageId: draftId, conversationId };
}

// ─── Poll inbox for recent messages ─────────────────────────────────────────

export type GraphMessage = {
  messageId: string;
  conversationId: string | undefined;
  subject: string | undefined;
  fromAddress: string | undefined;
  bodyPreview: string | undefined;
  bodyText: string | undefined;
  receivedAt: string | undefined;
};

/**
 * Poll the Microsoft Graph inbox for messages received in the last `hoursBack` hours.
 * Returns only messages NOT sent by the tenant's own account (inbound only).
 */
export async function pollGraphInbox(
  tenantSlug: string,
  hoursBack = 24
): Promise<GraphMessage[]> {
  const accessToken = await getValidAccessToken(tenantSlug);

  const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
  const filter = encodeURIComponent(`receivedDateTime ge ${since}`);
  const url = `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$filter=${filter}&$top=50&$select=id,conversationId,subject,from,bodyPreview,body,receivedDateTime`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Microsoft Graph inbox poll failed: ${err}`);
  }

  const data = await res.json() as {
    value: Array<{
      id: string;
      conversationId?: string;
      subject?: string;
      from?: { emailAddress?: { address?: string } };
      bodyPreview?: string;
      body?: { content?: string; contentType?: string };
      receivedDateTime?: string;
    }>;
  };

  return (data.value ?? []).map((msg) => ({
    messageId: msg.id,
    conversationId: msg.conversationId,
    subject: msg.subject,
    fromAddress: msg.from?.emailAddress?.address,
    bodyPreview: msg.bodyPreview,
    bodyText: msg.body?.contentType === "text"
      ? msg.body.content
      : msg.body?.content?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    receivedAt: msg.receivedDateTime,
  }));
}

// ─── Reply to a message in an existing conversation ───────────────────────────

export async function sendGraphReply(params: {
  tenantSlug: string;
  conversationId: string;
  messageId: string;
  to: string;
  subject: string;
  body: string;
}): Promise<void> {
  const accessToken = await getValidAccessToken(params.tenantSlug);

  // Use the reply endpoint on the original message
  const url = `https://graph.microsoft.com/v1.0/me/messages/${params.messageId}/reply`;

  const htmlBody = params.body
    .split(/\r?\n/)
    .map((line) => (line.trim() === "" ? "<br>" : `<p style="margin:0 0 12px 0;">${line}</p>`))
    .join("");

  const payload = {
    message: {
      subject: params.subject,
      body: { contentType: "HTML", content: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#222;">${htmlBody}</div>` },
      toRecipients: [{ emailAddress: { address: params.to } }],
    },
    comment: "",
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Microsoft Graph reply failed: ${err}`);
  }
}

// ─── Mail folder filing (2026-08-05: keep the inbound-feedback mailbox clean) ─

/**
 * Resolved mail-folder id, cached per `${tenantSlug}:${folderName}` for the
 * life of the process, callers (e.g. the inbound-feedback poller, once per
 * message) don't need their own cache. Cleared only by
 * `_resetMailFolderCacheForTests`.
 */
const mailFolderIdCache = new Map<string, string>();

/** Test-only: clear the in-process folder-id cache between test cases. */
export function _resetMailFolderCacheForTests(): void {
  mailFolderIdCache.clear();
}

/**
 * Resolve a mail folder's id by display name under /me/mailFolders, creating
 * it if it doesn't exist yet. Cached in-process per tenantSlug+folderName so
 * a caller filing many messages in one poll only resolves it once.
 */
export async function getOrCreateMailFolderId(tenantSlug: string, folderName: string): Promise<string> {
  const cacheKey = `${tenantSlug}:${folderName}`;
  const cached = mailFolderIdCache.get(cacheKey);
  if (cached) return cached;

  const accessToken = await getValidAccessToken(tenantSlug);

  // Look up by exact display name. Single quotes in the name are escaped by
  // doubling, per OData filter syntax.
  const escapedName = folderName.replace(/'/g, "''");
  const listUrl = `https://graph.microsoft.com/v1.0/me/mailFolders?$filter=${encodeURIComponent(`displayName eq '${escapedName}'`)}`;
  const listRes = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!listRes.ok) {
    const err = await listRes.text();
    throw new Error(`Microsoft Graph mail folder lookup failed: ${err}`);
  }
  const listData = (await listRes.json()) as { value: Array<{ id: string; displayName: string }> };
  const existing = listData.value?.find((f) => f.displayName === folderName);
  if (existing) {
    mailFolderIdCache.set(cacheKey, existing.id);
    return existing.id;
  }

  const createRes = await fetch("https://graph.microsoft.com/v1.0/me/mailFolders", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ displayName: folderName }),
  });
  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(`Microsoft Graph mail folder create failed: ${err}`);
  }
  const created = (await createRes.json()) as { id: string };
  mailFolderIdCache.set(cacheKey, created.id);
  return created.id;
}

/**
 * Move a message into another folder, POST /me/messages/{id}/move. Never
 * deletes anything; the message still exists, just relocated. Throws on
 * failure so callers can decide how to handle it (the inbound-feedback
 * poller catches and logs rather than letting a filing failure break ingest).
 */
export async function moveGraphMessage(tenantSlug: string, messageId: string, destinationFolderId: string): Promise<void> {
  const accessToken = await getValidAccessToken(tenantSlug);
  const url = `https://graph.microsoft.com/v1.0/me/messages/${messageId}/move`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ destinationId: destinationFolderId }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Microsoft Graph move message failed: ${err}`);
  }
}

// ─── Check if a tenant has Microsoft OAuth connected ─────────────────────────
export async function isMicrosoftConnected(tenantSlug: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const rows = await db.select({ microsoftOAuthJson: tenants.microsoftOAuthJson })
    .from(tenants)
    .where(eq(tenants.slug, tenantSlug))
    .limit(1);
  return !!rows[0]?.microsoftOAuthJson;
}
