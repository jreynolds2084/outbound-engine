/**
 * Gmail sender.
 *
 * Sends outreach email through the Gmail API with a tenant's stored Google
 * OAuth token. A tenant can connect its own Google account; tenants without one
 * fall back to the shared mailbox named by SENDER_ADDRESS.
 *
 * The token must have been granted the `gmail.send` scope. If the stored token
 * pre-dates the scope expansion, the user must re-authorize via the
 * "Connect Google Account" button on the Pipeline page.
 */

import { google } from "googleapis";
import { and, eq, or } from "drizzle-orm";
import { contacts } from "../drizzle/schema";
import { getAuthenticatedClient } from "./googleDrive";
import { getDb } from "./db";
import { invokeLLM } from "./_core/llm";

/** Default sender identity and signature details, used when a request names no sender. */
const SENDER_ADDRESS = process.env.SENDER_ADDRESS ?? "you@example.com";
const SENDER_NAME = process.env.SENDER_NAME ?? "Your Name";
const SENDER_TITLE = process.env.SENDER_TITLE ?? "Account Executive";
const SENDER_PHONE = process.env.SENDER_PHONE ?? "";
const BRAND_NAME = process.env.BRAND_NAME ?? "Outbound Beast";


export interface SendEmailRequest {
  to: string;
  subject: string;
  body: string;
  /**
   * Tenant whose Google account should send this. Omit for the shared mailbox.
   * Without this every tenant sent from the shared address regardless of
   * configuration, because both the address and the token were global.
   */
  tenantId?: number;
  /** Overrides the default From. `{ name, address }`, e.g. Sam Seller <sam@example.com>. */
  from?: { name: string; address: string };
  /**
   * Set false for mail that must read as one person writing to another. The
   * branded signature block (logo, job title, booking link) suits cold sales
   * mail and reads wrong on a personal note.
   */
  includeSignature?: boolean;
  /**
   * A plain-text signature to append instead of the branded block. Newlines are
   * preserved, and bare URLs and email addresses become links in the HTML part.
   *
   * Kept separate from includeSignature because "no marketing footer" and "no
   * signature at all" are different things: a personal email still ends with a
   * name and a way to reach the sender.
   */
  signature?: string | null;
  /** Gmail thread ID, if set, the message is sent as a reply in that thread */
  threadId?: string;
  /** Gmail message ID of the last message in the thread (for In-Reply-To / References headers) */
  inReplyToMessageId?: string;
  /** RFC 2369 `List-Unsubscribe` header value, e.g. "<https://.../api/unsubscribe/TOKEN>". Omit to skip, see unsubscribe.ts. */
  listUnsubscribeHeader?: string;
  /** RFC 8058 `List-Unsubscribe-Post` header value ("List-Unsubscribe=One-Click"). Omit to skip. */
  listUnsubscribePostHeader?: string;
}

export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  threadId?: string;
  error?: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strip any old inline plain-text signature from the body.
 * Matches patterns like:
 *  , Your Name, Title, Company / email | phone
 *   Your Name\nTitle, Company\nemail | phone
 *   ...what it finds?, Your Name, Title, Company / email | phone
 */
const INLINE_SIGNATURE = new RegExp(`[,\\s]*[\\u2014\\-]?\\s*${escapeRegExp(SENDER_NAME)}[\\s\\S]*`, "i");

function stripInlineSignature(body: string): string {
  // Remove everything from the first occurrence of the sender name,
  // whether it appears after a newline, an em-dash, or a comma mid-sentence.
  return body.replace(INLINE_SIGNATURE, "").trimEnd();
}

/**
 * Absolute origin used to build asset URLs inside outbound email. Email clients
 * cannot resolve relative paths, so this has to be a full origin: set it to
 * the tenant's public URL (e.g. https://app.example.com).
 */
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? "https://app.example.com").replace(/\/$/, "");

/**
 * Signature logo, served from the app's own origin out of client/public/brand/.
 * A third-party image host can disappear, and mail already sitting in
 * prospects' inboxes would then show a broken image.
 */
const LOGO_URL = `${PUBLIC_BASE_URL}/brand/email-logo.png`;
const BOOKING_URL = process.env.BOOKING_URL ?? "https://example.com/book";

/**
 * Turn a plain-text signature into HTML: preserve the line breaks, and make
 * URLs, email addresses and phone numbers clickable. Deliberately minimal,
 * no table, no logo, no colour. A personal email's signature should look like
 * something a person typed.
 */
function buildPlainSignatureHtml(signature: string): string {
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const linked = escape(signature.trim())
    .replace(/\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?)/gi, (m) =>
      // Skip anything that is part of an email address.
      m.includes("@") ? m : `<a href="${m.startsWith("http") ? m : `https://${m}`}" style="color:#222;">${m}</a>`)
    .replace(/\b([\w.+-]+@[\w-]+\.[\w.]+)\b/g, `<a href="mailto:$1" style="color:#222;">$1</a>`)
    .replace(/\b(\+?\d[\d\s().-]{7,}\d)\b/g, (m) => `<a href="tel:${m.replace(/[^\d+]/g, "")}" style="color:#222;">${m}</a>`)
    .replace(/\n/g, "<br>");

  return `<br><div style="font-family:Arial,sans-serif;font-size:13px;color:#555;">${linked}</div>`;
}

/**
 * HTML signature block.
 *
 * Takes the sender so it cannot contradict the From header. It used to hardcode
 * one address, which meant a message sent from one address could carry a
 * signature advertising another.
 */
function buildSignatureHtml(name: string, address: string): string {
  return `
<br><br>
<table cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,sans-serif;font-size:13px;color:#222;">
  <tr>
    <td style="padding-right:14px;vertical-align:middle;">
      <img src="${LOGO_URL}" alt="${BRAND_NAME}" width="80" height="60" style="display:block;" />
    </td>
    <td style="vertical-align:middle;border-left:2px solid #cccccc;padding-left:14px;">
      <strong style="font-size:14px;">${name}</strong><br>
      <span style="color:#555;">${SENDER_TITLE}</span><br>
      <span>E: <a href="mailto:${address}" style="color:#222;text-decoration:none;">${address}</a></span><br>
      ${SENDER_PHONE ? `<span>P: <a href="tel:${SENDER_PHONE.replace(/[^\d+]/g, "")}" style="color:#222;text-decoration:none;">${SENDER_PHONE}</a></span><br>` : ""}
      <a href="${BOOKING_URL}" style="color:#DA0000;font-weight:bold;text-decoration:none;">Schedule a Meeting</a>
    </td>
  </tr>
</table>`.trim();
}

/**
 * Build a multipart/alternative RFC 2822 message.
 * The HTML part includes the embedded Good signature so it is always
 * present regardless of Gmail API signature-append behaviour.
 * Exported for unit testing.
 */
export function buildRawMessage(request: SendEmailRequest): string {
  const fromName = request.from?.name ?? SENDER_NAME;
  const fromAddress = request.from?.address ?? SENDER_ADDRESS;
  const from = `${fromName} <${fromAddress}>`;
  const withSignature = request.includeSignature !== false;
  const boundary = `----=_Part_${Date.now()}`;

  // Strip an old inline sign-off baked into stored bodies. Only
  // meaningful when we are appending the block signature, a personal email
  // ends with the sender's own words and must be left exactly as written.
  const cleanBody = withSignature ? stripInlineSignature(request.body) : request.body;

  const customSig = request.signature?.trim() || null;

  // Plain-text part. The branded block is HTML-only, but a typed signature is
  // text and belongs in both parts, otherwise a plain-text client sees an
  // email that ends without a name.
  const plainPart = [
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    customSig ? `${cleanBody}\r\n\r\n${customSig}` : cleanBody,
  ].join("\r\n");

  // HTML part: body paragraphs + signature
  const htmlBody = cleanBody
    .split(/\r?\n/)
    .map((line) => (line.trim() === "" ? "<br>" : `<p style="margin:0 0 12px 0;">${line}</p>`))
    .join("\r\n");
  const htmlPart = [
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#222;">${htmlBody}${
      customSig ? buildPlainSignatureHtml(customSig) : withSignature ? buildSignatureHtml(fromName, fromAddress) : ""
    }</div>`,
  ].join("\r\n");

  const closingBoundary = `--${boundary}--`;

  const headerLines: string[] = [
    `From: ${from}`,
    `To: ${request.to}`,
    `Subject: ${request.subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];

  if (request.inReplyToMessageId) {
    headerLines.push(`In-Reply-To: ${request.inReplyToMessageId}`);
    headerLines.push(`References: ${request.inReplyToMessageId}`);
  }

  if (request.listUnsubscribeHeader) {
    headerLines.push(`List-Unsubscribe: ${request.listUnsubscribeHeader}`);
  }
  if (request.listUnsubscribePostHeader) {
    headerLines.push(`List-Unsubscribe-Post: ${request.listUnsubscribePostHeader}`);
  }

  const raw = [...headerLines, "", plainPart, "", htmlPart, "", closingBoundary].join("\r\n");
  // Base64url encode (Gmail API requirement)
  return Buffer.from(raw)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Send an email via the Gmail API.
 *
 * Sends from `request.from` using the Google account connected for
 * `request.tenantId`, falling back to SENDER_ADDRESS on the shared mailbox
 * when neither is supplied.
 *
 * Note the From header must match the authorized mailbox (or one of its
 * verified aliases), or Gmail rewrites it. Connecting the right account is what
 * makes the right From stick; setting the header alone is not enough.
 */
export async function sendEmail(request: SendEmailRequest): Promise<SendEmailResult> {
  // CASL gate (defensive): refuse to send to any address that belongs to an
  // opted-out contact. Checked against both email and hunterEmail columns.
  // If the check itself errors, fail CLOSED, opt-out detection may
  // over-trigger, it must never under-trigger.
  try {
    const db = await getDb();
    if (db) {
      const optedOutRows = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            or(eq(contacts.email, request.to), eq(contacts.hunterEmail, request.to)),
            eq(contacts.optedOut, true),
          ),
        )
        .limit(1);
      if (optedOutRows.length > 0) {
        console.warn(`[Gmail] Send blocked: ${request.to} belongs to opted-out contact ${optedOutRows[0].id} (CASL)`);
        return { success: false, error: "Recipient has opted out (CASL). Send blocked." };
      }
    }
  } catch (gateErr) {
    const gateMessage = gateErr instanceof Error ? gateErr.message : String(gateErr);
    console.error("[Gmail] CASL opt-out check failed — send blocked:", gateMessage);
    return { success: false, error: `CASL opt-out check failed, send blocked: ${gateMessage}` };
  }

  try {
    const auth = await getAuthenticatedClient(request.tenantId);
    const gmail = google.gmail({ version: "v1", auth });

    const raw = buildRawMessage(request);

    const requestBody: { raw: string; threadId?: string } = { raw };
    if (request.threadId) {
      requestBody.threadId = request.threadId;
    }

    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody,
    });

    return {
      success: true,
      messageId: res.data.id ?? undefined,
      threadId: res.data.threadId ?? undefined,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Gmail] Send failed:", message);

    // Surface a clear error if the scope is missing
    if (message.includes("insufficient authentication scopes") || message.includes("403")) {
      return {
        success: false,
        error:
          "Gmail send permission not granted. Please click 'Connect Google Account' on the Pipeline page to re-authorize with Gmail access.",
      };
    }

    return { success: false, error: message };
  }
}

export function getSenderAddress(): string {
  return SENDER_ADDRESS;
}

/**
 * Poll Gmail inbox for a Mail Delivery Subsystem bounce notification.
 *
 * Primary strategy: search by the sent message's Gmail message ID in the
 * bounce body. This prevents cross-contamination when multiple retries fire
 * simultaneously. Falls back to recipient address matching if no messageId
 * is provided.
 *
 * @param recipientEmail  The address the email was sent to (fallback search)
 * @param delayMs         How long to wait before checking (default 20s)
 * @param sentMessageId   The Gmail message ID returned by the send call.
 *                        When provided, bounce detection matches on this ID
 *                        rather than the recipient address string.
 */
/**
 * Poll a tenant's Gmail inbox for delivery-failure notices.
 *
 * Shaped to match pollGraphInbox() so the bounce check can run the same
 * extraction and contact-marking logic for both transports. Gmail-sending
 * tenants previously had NO bounce detection at all, the bounce and departed
 * handlers both filtered on sendingMethod = 'microsoft_graph', so a dead
 * address failed silently and the cadence carried on as though delivered.
 *
 * Needs the gmail.readonly scope, which is already in the token's scope list.
 *
 * @param tenantId   Whose mailbox to read.
 * @param hoursBack  Lookback window. The cron runs three times a day, so 1.5h
 *                   per run is enough to cover each send window.
 */
export async function pollGmailInbox(
  tenantId: number,
  hoursBack: number,
): Promise<Array<{ subject?: string; bodyText?: string; bodyPreview?: string }>> {
  const auth = await getAuthenticatedClient(tenantId);
  const gmail = google.gmail({ version: "v1", auth });

  const after = Math.floor((Date.now() - hoursBack * 60 * 60 * 1000) / 1000);
  // Cast wide on sender: Gmail uses mailer-daemon@googlemail.com, but relayed
  // and forwarded bounces arrive from postmaster@ at the receiving domain.
  const query = `in:anywhere (from:mailer-daemon OR from:postmaster) after:${after}`;

  const listRes = await gmail.users.messages.list({ userId: "me", q: query, maxResults: 50 });
  const messages = listRes.data.messages ?? [];
  const out: Array<{ subject?: string; bodyText?: string; bodyPreview?: string }> = [];

  for (const msg of messages) {
    if (!msg.id) continue;
    const full = await gmail.users.messages.get({ userId: "me", id: msg.id, format: "full" });
    const headers = full.data.payload?.headers ?? [];
    const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value ?? undefined;

    let bodyText = full.data.snippet ?? "";
    type GmailPart = NonNullable<NonNullable<typeof full.data.payload>["parts"]>[number];
    const walk = (parts: GmailPart[] | undefined): void => {
      for (const part of parts ?? []) {
        if (part.mimeType === "text/plain" && part.body?.data) {
          bodyText += Buffer.from(part.body.data, "base64").toString("utf-8");
        }
        if (part.parts) walk(part.parts);
      }
    };
    walk(full.data.payload?.parts);

    out.push({ subject, bodyText, bodyPreview: full.data.snippet ?? undefined });
  }
  return out;
}

export async function checkBounce(
  recipientEmail: string,
  delayMs = 20000,
  sentMessageId?: string,
): Promise<boolean> {
  // Wait for the bounce to arrive
  await new Promise((resolve) => setTimeout(resolve, delayMs));

  try {
    const auth = await getAuthenticatedClient();
    const gmail = google.gmail({ version: "v1", auth });

    // Search for delivery failure messages in the last 10 minutes
    const after = Math.floor((Date.now() - 10 * 60 * 1000) / 1000);
    const query = `in:inbox from:mailer-daemon@googlemail.com after:${after}`;

    const listRes = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 30,
    });

    const messages = listRes.data.messages ?? [];
    if (messages.length === 0) return false;

    for (const msg of messages) {
      if (!msg.id) continue;
      const full = await gmail.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "full",
      });

      // Collect all text content from the bounce notification
      const snippet = full.data.snippet ?? "";
      const bodyParts = full.data.payload?.parts ?? [];
      let bodyText = snippet;
      for (const part of bodyParts) {
        if (part.mimeType === "text/plain" && part.body?.data) {
          bodyText += Buffer.from(part.body.data, "base64").toString("utf-8");
        }
        // Some bounce messages nest parts inside a multipart container
        if (part.parts) {
          for (const subPart of part.parts) {
            if (subPart.mimeType === "text/plain" && subPart.body?.data) {
              bodyText += Buffer.from(subPart.body.data, "base64").toString("utf-8");
            }
          }
        }
      }

      // Primary: match by sent message ID (prevents cross-contamination)
      if (sentMessageId && bodyText.includes(sentMessageId)) {
        console.log(`[checkBounce] Bounce confirmed by messageId ${sentMessageId}`);
        return true;
      }

      // Fallback: match by recipient address string
      if (!sentMessageId && bodyText.toLowerCase().includes(recipientEmail.toLowerCase())) {
        console.log(`[checkBounce] Bounce confirmed by address match for ${recipientEmail}`);
        return true;
      }
    }

    return false;
  } catch (err) {
    console.warn("[checkBounce] Gmail poll failed:", err);
    return false;
  }
}

/**
 * Use the LLM to classify a reply's sentiment into one of
 * Interested / Not Now / Referral / Unclassified.
 *
 * NOTE (CASL hardening): this is the LEGACY classifier, used only by an
 * unscheduled inbox-monitor endpoint.
 * It was deliberately NOT folded into replyAgent's Tier-2 classifier because
 * the two diverge meaningfully: this one returns values that feed the
 * replies.sentiment DB enum directly (which has no "Opt-Out" member), swallows
 * LLM errors as "Unclassified" (its caller only records, never auto-sends, so
 * that is safe), and applies fuzzy fallback matching on malformed output.
 */
export async function classifyReplySentiment(body: string): Promise<
  "Interested" | "Not Now" | "Referral" | "Negative" | "Unclassified"
> {
  if (!body || body.trim().length === 0) return "Unclassified";
  try {
    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content:
            "Classify the following email reply into exactly one of: Interested, Not Now, Referral, Negative, Unclassified. Reply with only the label.",
        },
        { role: "user", content: body.slice(0, 2000) },
      ],
    });
    const raw = (response.choices?.[0]?.message?.content ?? "").toString().trim();
    const VALID_SENTIMENTS = ["Interested", "Not Now", "Referral", "Negative", "Unclassified"] as const;
    if (VALID_SENTIMENTS.includes(raw as typeof VALID_SENTIMENTS[number])) return raw as typeof VALID_SENTIMENTS[number];
    if (/not\s*now/i.test(raw)) return "Not Now";
    if (/referral/i.test(raw)) return "Referral";
    return "Unclassified";
  } catch (error) {
    console.warn("[Sentiment] classification failed:", error);
    return "Unclassified";
  }
}
