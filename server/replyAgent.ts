/**
 * Reply Agent
 * ─────────────────────────────────────────
 * Polls the Microsoft Graph inbox for replies to tracked outreach threads,
 * classifies them into branches:
 *
 *   1. CASL opt-out (Tier 1 regex via optOutClassifier, or Tier 2 LLM
 *      "Negative"/"Opt-Out") → suppress contact + cancel all pending touches,
 *      send a bilingual confirmation, stop.
 *   2. Referral / timing deferral / classifier failure → record for human
 *      review (acknowledged=false), no auto-response.
 *   3. Everything else → acknowledge the reply, redirect to the booking link.
 *
 * Voice rules for the seller's replies:
 *   - Direct, short, no jargon.
 *   - No em dashes. No "just" or "hopefully" as filler.
 *   - Own the next step, never leave the ball in the prospect's court.
 *   - One-line acknowledgment of what they actually said before pivoting.
 *   - No breakup / "closing the loop" language. Stay persistent and warm.
 *   - Never name other clients. Offer unnamed comparable cases only.
 *   - Sign off "Many thanks."
 */

import { getDb, updateContactStatus } from "./db";
import { calls, contacts, linkedinTasks, outreachEmails, replies, tenants } from "../drizzle/schema";
import { eq, and, isNotNull } from "drizzle-orm";
import { invokeLLM } from "./_core/llm";
import { pollGraphInbox, sendGraphReply, type GraphMessage } from "./microsoftGraph";
import { notifyOwner } from "./_core/notification";
import { classifyReply } from "./optOutClassifier";

/** The seller the agent writes as, and the fallback booking link. Configured per deployment. */
const SELLER_NAME = process.env.SENDER_NAME ?? "Your Name";
const BRAND_NAME = process.env.BRAND_NAME ?? "Outbound Beast";
const DEFAULT_BOOKING_URL = process.env.BOOKING_URL ?? "https://example.com/book";
/** Messages from this domain are our own sends and are never treated as replies. */
const OWN_DOMAIN = (process.env.SENDER_ADDRESS ?? "you@example.com").split("@")[1]?.toLowerCase() ?? "";

// ─── CASL opt-out detection ──────────────────────────────────────────────────
// Tier 1 (regex) lives in ./optOutClassifier, see the design rule there:
// opt-out detection MAY over-trigger, it must NEVER under-trigger.
// Tier 2 (LLM backstop) is classifyReplySentiment below: when the regex does
// not match, the sentiment classifier runs BEFORE any reply is generated, and
// "Negative" / "Opt-Out" results are treated as opt-out-equivalent.

// ─── Reply sentiment classifier (H2 fix 2026-07) ─────────────────────────────
// Classifies the prospect's reply into a sentiment bucket used to decide
// whether to push the Calendly booking link or simply acknowledge.

type ReplySentiment = "Interested" | "Not Now" | "Referral" | "Negative" | "Opt-Out" | "Unclassified";

/**
 * Tier-2 LLM backstop classifier.
 *
 * THROWS when the LLM call fails, callers must catch and route the reply to
 * human review instead of auto-sending anything. (Previously the catch here
 * returned "Unclassified", which silently fell through to an auto-pitch.)
 */
async function classifyReplySentiment(
  replyBody: string,
  prospectName: string,
): Promise<ReplySentiment> {
  const response = await invokeLLM({
    model: "claude-sonnet-4-6",
    max_tokens: 64,
    messages: [
      {
        role: "system",
        content:
          "Classify the following cold-email reply into exactly one of these categories:\n" +
          "Interested — prospect is open to a meeting or asking for more info\n" +
          "Not Now — timing issue, budget freeze, or 'check back later'\n" +
          "Referral — prospect is redirecting to another person\n" +
          "Negative — prospect is dismissive, rude, or clearly not interested but did not opt out\n" +
          "Opt-Out — prospect asks to stop receiving emails, unsubscribe, or be removed from the list (in any language)\n" +
          "Unclassified — cannot determine intent\n\n" +
          "Return ONLY the category name, nothing else.",
      },
      {
        role: "user",
        content: `Reply from ${prospectName}:\n${replyBody.slice(0, 800)}`,
      },
    ],
  });
  const raw = (response.choices?.[0]?.message?.content ?? "").toString().trim();
  const valid: ReplySentiment[] = ["Interested", "Not Now", "Referral", "Negative", "Opt-Out", "Unclassified"];
  return valid.includes(raw as ReplySentiment) ? (raw as ReplySentiment) : "Unclassified";
}

/**
 * Map the in-code sentiment to the replies.sentiment DB enum.
 * TODO(schema): the replies.sentiment enum has no "Opt-Out" value, adding one
 * requires a migration. Until then opt-outs are stored as "Negative".
 */
function toDbSentiment(
  s: ReplySentiment,
): "Interested" | "Not Now" | "Referral" | "Negative" | "Unclassified" {
  return s === "Opt-Out" ? "Negative" : s;
}

// ─── Reply writer (Claude Sonnet) ─────────────────────────────────────────────

const REPLY_SYSTEM_PROMPT = `You are writing email replies as ${SELLER_NAME} of ${BRAND_NAME}, responding to a prospect who replied to a cold outreach sequence.

VOICE
- Direct, short, no corporate jargon. Say the thing plainly.
- Never use "just" or "hopefully" as filler softeners.
- Never use em dashes. Use periods or commas instead.
- Own the next step yourself. End with what you will do, not an open-ended ask.
- No hard breakup or "closing the loop" language, ever. Stay persistent and warm even on a cold or negative reply.
- Give the prospect's specific reply a real one-line acknowledgment before pivoting. No generic "thanks for your reply" filler.
- Never name other specific clients by name. Offer an unnamed comparable case instead if social proof is useful.
- Personalize to the prospect's actual vertical and the pain point they raised in their reply.
- If a new subject line is needed, use a pattern-interrupt subject, not a descriptive one.
- Sign off "Many thanks." — nothing after that. No name, no title, no phone number. The signature is added automatically.
- Do NOT open with "Good morning," "Good afternoon," or "Good evening." These are time-sensitive and will be wrong when read.
- Do NOT start any sentence with "I" as the first word of the email.

BEHAVIOR
- Every reply that is not an unsubscribe/opt-out request ends with a push to book a meeting or demo via the Calendly link provided.
- If the reply is an unsubscribe/opt-out request, do not pitch. Confirm removal in one short line and stop. (This case is handled separately — you will not receive opt-out replies.)
- Keep the reply to 3-5 sentences maximum. Short is better.

OUTPUT FORMAT
Return a JSON object with two fields:
{
  "subject": "Re: [original subject or a new pattern-interrupt subject if appropriate]",
  "body": "The plain-text email body. No HTML. No signature."
}`;

async function generateReply(params: {
  prospectName: string;
  prospectRole: string;
  companyName: string;
  industry: string;
  replyBody: string;
  originalSubject: string;
  calendlyLink: string;
}): Promise<{ subject: string; body: string }> {
  const userPrompt = `Prospect: ${params.prospectName}, ${params.prospectRole} at ${params.companyName} (${params.industry})
Original email subject: ${params.originalSubject}
Their reply:
---
${params.replyBody.slice(0, 1500)}
---
Calendly booking link: ${params.calendlyLink}

Write a reply that acknowledges what they said and redirects to booking a meeting via the Calendly link.`;

  const response = await invokeLLM({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [
      { role: "system", content: REPLY_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
  });

  const raw = (response.choices?.[0]?.message?.content ?? "").toString().trim();
  // Strip markdown fences if present
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  try {
    const parsed = JSON.parse(cleaned) as { subject: string; body: string };
    return parsed;
  } catch {
    // Fallback: return raw as body
    return {
      subject: `Re: ${params.originalSubject}`,
      body: cleaned,
    };
  }
}

// ─── Opt-out confirmation ─────────────────────────────────────────────────────

/**
 * Bilingual (EN + FR) confirmation, language detection does not exist yet, so
 * both lines always go out. Keep both lines short.
 */
export function buildOptOutConfirmation(prospectName: string): { subject: string; body: string } {
  const firstName = prospectName.split(" ")[0] ?? prospectName;
  return {
    subject: "Removed from our list / Retiré de notre liste",
    body:
      `Hi ${firstName},\n\n` +
      `You have been removed from our outreach list. You will not hear from us again.\n` +
      `Vous avez été retiré de notre liste d'envoi. Vous ne recevrez plus de courriels de notre part.\n\n` +
      `Many thanks.`,
  };
}

// ─── Suppress contact (CASL) ──────────────────────────────────────────────────

/**
 * Suppress a contact after an opt-out request. Single transaction:
 *   1. Flag the contact (optedOut, optedOutAt, status Unreachable).
 *   2. Cancel every pending touch on every channel, Pending outreach emails,
 *      Scheduled calls, Pending LinkedIn tasks.
 *
 * The terminal status is "Skipped" (not a new "Suppressed" value) because all
 * three status columns are strict MySQL enums, adding "Suppressed" would need
 * a migration on each table. The bounce-retry restore loop carries an
 * optedOut guard so a Skipped-by-suppression email can never be resurrected.
 */
export async function suppressContact(contactId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.transaction(async (tx) => {
    await tx
      .update(contacts)
      .set({ optedOut: true, optedOutAt: new Date(), status: "Unreachable" })
      .where(eq(contacts.id, contactId));
    await tx
      .update(outreachEmails)
      .set({ status: "Skipped" })
      .where(and(eq(outreachEmails.contactId, contactId), eq(outreachEmails.status, "Pending")));
    await tx
      .update(calls)
      .set({ status: "Skipped", completedAt: new Date(), notes: "Suppressed: contact opted out (CASL)" })
      .where(and(eq(calls.contactId, contactId), eq(calls.status, "Scheduled")));
    await tx
      .update(linkedinTasks)
      .set({ status: "Skipped" })
      .where(and(eq(linkedinTasks.contactId, contactId), eq(linkedinTasks.status, "Pending")));
  });
}

// ─── Cascade a plain reply (terminal for automation, not for the contact) ────

/**
 * Stop every pending automated touch after an ordinary reply, same cascade
 * reach as suppressContact() (pending outreach emails, scheduled calls,
 * pending LinkedIn tasks, all flipped to "Skipped"), but deliberately NOT the
 * same function and NOT the same permanence.
 *
 * suppressContact() is opt-out only: it sets optedOut + status="Unreachable"
 * and is meant to be permanent (standing rule: never pursue past a no).
 * cascadeReplyStop() never touches optedOut and never marks the contact
 * unreachable. A plain reply is terminal for the *sequence*, nothing queued
 * keeps firing over a live conversation, but the contact is not suppressed
 * and stays reachable by a human going forward. Do not merge these
 * two functions; keeping them distinct is what stops opt-out from ever being
 * weakened into "just stop this sequence."
 *
 * Call this any time a reply sets contacts.status = "Replied".
 */
export async function cascadeReplyStop(contactId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.transaction(async (tx) => {
    await tx
      .update(outreachEmails)
      .set({ status: "Skipped" })
      .where(and(eq(outreachEmails.contactId, contactId), eq(outreachEmails.status, "Pending")));
    await tx
      .update(calls)
      .set({ status: "Skipped", completedAt: new Date(), notes: "Skipped: contact replied, sequence stopped" })
      .where(and(eq(calls.contactId, contactId), eq(calls.status, "Scheduled")));
    await tx
      .update(linkedinTasks)
      .set({ status: "Skipped" })
      .where(and(eq(linkedinTasks.contactId, contactId), eq(linkedinTasks.status, "Pending")));
  });
}

// ─── Main reply agent loop ────────────────────────────────────────────────────

export async function runReplyAgent(tenantSlug: string): Promise<void> {
  const db = await getDb();
  if (!db) return;

  // Only run for tenants using Microsoft Graph
  const tenantRows = await db
    .select()
    .from(tenants)
    .where(eq(tenants.slug, tenantSlug))
    .limit(1);
  const tenant = tenantRows[0];
  if (!tenant?.microsoftOAuthJson) {
    console.log(`[ReplyAgent] Tenant ${tenantSlug} has no Microsoft OAuth — skipping`);
    return;
  }

  // Get the Calendly link from the tenant config
  let calendlyLink = tenant.sellerCalendlyUrl ?? DEFAULT_BOOKING_URL;
  if (!calendlyLink || calendlyLink.trim() === "") {
    calendlyLink = DEFAULT_BOOKING_URL;
  }

  // Poll inbox for new messages in the last 24 hours
  let messages: GraphMessage[];
  try {
    messages = await pollGraphInbox(tenantSlug, 24);
  } catch (err) {
    console.warn(`[ReplyAgent] Inbox poll failed for ${tenantSlug}:`, err);
    return;
  }

  if (messages.length === 0) return;

  // Build a map of conversationId → contactId for fast lookup
  const emailRows = await db
    .select({
      contactId: outreachEmails.contactId,
      conversationId: outreachEmails.gmailThreadId,
    })
    .from(outreachEmails)
    .where(and(
      eq(outreachEmails.tenantId, tenant.id),
      isNotNull(outreachEmails.gmailThreadId),
    ));

  const conversationMap = new Map<string, number>();
  for (const row of emailRows) {
    if (row.conversationId) {
      conversationMap.set(row.conversationId, row.contactId);
    }
  }

  // Build a fallback map of email address → contactId for messages where
  // conversationId was not stored (emails sent before the two-step Graph fix).
  const contactEmailRows = await db
    .select({ id: contacts.id, email: contacts.email })
    .from(contacts)
    .innerJoin(outreachEmails, eq(outreachEmails.contactId, contacts.id))
    .where(eq(outreachEmails.tenantId, tenant.id));

  const contactByEmail = new Map<string, number>();
  for (const row of contactEmailRows) {
    if (row.email) {
      contactByEmail.set(row.email.toLowerCase(), row.id);
    }
  }

  for (const msg of messages) {
    // Primary match: conversationId stored in outreachEmails.gmailThreadId
    let contactId = msg.conversationId ? conversationMap.get(msg.conversationId) : undefined;

    // Fallback match: sender email address (handles emails sent before conversationId was stored)
    if (!contactId && msg.fromAddress) {
      contactId = contactByEmail.get(msg.fromAddress.toLowerCase());
    }

    if (!contactId) continue;

    // Load contact + account
    const contactRows = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .limit(1);
    const contact = contactRows[0];
    if (!contact) continue;

    // Skip if already opted out
    if (contact.optedOut) continue;

    // Skip if this message was sent by us (avoid replying to our own sends)
    if (OWN_DOMAIN && msg.fromAddress?.toLowerCase().includes(OWN_DOMAIN)) continue;

    // Check if we already processed this message (by message ID stored in replies)
    const existingReply = await db
      .select({ id: replies.id })
      .from(replies)
      .where(eq(replies.gmailMessageId, msg.messageId))
      .limit(1);
    if (existingReply.length > 0) continue;

    const replyBody = msg.bodyText ?? msg.bodyPreview ?? "";

    // Shared helper: suppress the contact, send the bilingual confirmation,
    // record the reply, notify. Used by Tier 1 (regex) and Tier 2 (LLM).
    const handleOptOut = async (tier: string): Promise<void> => {
      await suppressContact(contactId!);

      const confirmation = buildOptOutConfirmation(contact.name);
      try {
        await sendGraphReply({
          tenantSlug,
          conversationId: msg.conversationId ?? "",
          messageId: msg.messageId,
          to: msg.fromAddress ?? contact.email ?? "",
          subject: confirmation.subject,
          body: confirmation.body,
        });
      } catch (err) {
        console.warn(`[ReplyAgent] Failed to send opt-out confirmation to ${contact.email}:`, err);
      }

      // Record the reply. TODO(schema): replies.sentiment has no "Opt-Out"
      // enum value (needs a migration), stored as "Negative" until then.
      await db.insert(replies).values({
        contactId,
        subject: msg.subject ?? "",
        body: replyBody.slice(0, 5000),
        sentiment: toDbSentiment("Opt-Out"),
        receivedAt: new Date(),
        gmailMessageId: msg.messageId,
        acknowledged: true,
      });

      await notifyOwner({
        title: `CASL opt-out: ${contact.name} (${tenantSlug})`,
        content: `${contact.name} at ${contact.email} requested removal (${tier}). Contact suppressed, pending touches cancelled.`,
      }).catch(() => {});

      console.log(`[ReplyAgent] Opt-out processed for contact ${contactId} (${tier})`);
    };

    // Shared helper: record the reply for human review, no auto-send, no
    // suppression. acknowledged=false surfaces it in the Replies page banner
    // (replies.unacknowledgedCount) until a human clears it.
    const routeToHumanReview = async (
      dbSentiment: "Interested" | "Not Now" | "Referral" | "Negative" | "Unclassified",
      reason: string,
    ): Promise<void> => {
      await db.insert(replies).values({
        contactId,
        subject: msg.subject ?? "",
        body: replyBody.slice(0, 5000),
        sentiment: dbSentiment,
        receivedAt: new Date(),
        gmailMessageId: msg.messageId,
        acknowledged: false,
      });

      await updateContactStatus(contactId!, { status: "Replied" });
      // A reply, even one routed to a human for review, is terminal for
      // automation. Stop everything already queued so nothing fires over it.
      await cascadeReplyStop(contactId!);

      await notifyOwner({
        title: `Reply needs review: ${contact.name} (${tenantSlug}) [${dbSentiment}]`,
        content: `${contact.name} at ${contact.email} replied — ${reason}. No auto-response sent. Review it in the Replies tab.

Their reply:
${replyBody.slice(0, 500)}`,
      }).catch(() => {});

      console.log(`[ReplyAgent] Reply from contact ${contactId} routed to human review (${reason})`);
    };

    // ── Tier 1: regex classification (see optOutClassifier.ts) ───────────────
    const tier1 = classifyReply(replyBody);

    if (tier1 === "OptOut") {
      await handleOptOut("Tier 1 regex");
      continue;
    }

    if (tier1 === "Referral") {
      // Wrong person, never suppress (the redirect target may be a lead) and
      // never auto-pitch the wrong person. Human decides the next step.
      await routeToHumanReview("Referral", "prospect redirected to someone else");
      continue;
    }

    if (tier1 === "NotNow") {
      // Timing deferral ("not looking until Q3"), not an opt-out, but a
      // canned pitch would burn the thread. Human decides the next step.
      await routeToHumanReview("Not Now", "timing deferral detected");
      continue;
    }

    // ── Tier 2: LLM backstop, runs BEFORE any reply is generated ────────────
    // H2 fix (2026-07) + CASL hardening: Negative / Opt-Out results are
    // opt-out-equivalent. An LLM failure routes to human review, it must
    // never fall through to an auto-pitch.
    let sentiment: ReplySentiment;
    try {
      sentiment = await classifyReplySentiment(replyBody, contact.name);
    } catch (err) {
      console.warn(`[ReplyAgent] Sentiment classification failed for contact ${contactId} — routing to human review:`, err);
      await routeToHumanReview("Unclassified", "sentiment classifier unavailable");
      continue;
    }

    if (sentiment === "Negative" || sentiment === "Opt-Out") {
      await handleOptOut(`Tier 2 LLM (${sentiment})`);
      continue;
    }

    if (sentiment === "Referral") {
      await routeToHumanReview("Referral", "prospect redirected to someone else");
      continue;
    }

    // ── Auto-reply branch: Interested / Not Now / Unclassified ───────────────
    // Load account for context
    const { accounts: accountsTable } = await import("../drizzle/schema");
    const accountRows = await db
      .select()
      .from(accountsTable)
      .where(eq(accountsTable.id, contact.accountId))
      .limit(1);
    const account = accountRows[0];

    let generatedReply: { subject: string; body: string };
    try {
      generatedReply = await generateReply({
        prospectName: contact.name,
        prospectRole: contact.role ?? "Decision Maker",
        companyName: account?.name ?? "your company",
        industry: account?.industry ?? "your industry",
        replyBody,
        originalSubject: msg.subject ?? "our outreach",
        calendlyLink,
      });
    } catch (err) {
      console.warn(`[ReplyAgent] LLM reply generation failed for contact ${contactId}:`, err);
      continue;
    }

    // Send the reply
    try {
      await sendGraphReply({
        tenantSlug,
        conversationId: msg.conversationId ?? "",
        messageId: msg.messageId,
        to: msg.fromAddress ?? contact.email ?? "",
        subject: generatedReply.subject,
        body: generatedReply.body,
      });
    } catch (err) {
      console.warn(`[ReplyAgent] Failed to send reply to ${contact.email}:`, err);
      continue;
    }

    // Update contact status to Replied
    await updateContactStatus(contactId, { status: "Replied" });
    // Same cascade as the human-review branch: an auto-acknowledged reply
    // still stops the automated sequence, the pitch reply is a one-off
    // response to this message, not a resumed cadence.
    await cascadeReplyStop(contactId);

    // Record the inbound reply with real sentiment
    await db.insert(replies).values({
      contactId,
      subject: msg.subject ?? "",
      body: replyBody.slice(0, 5000),
      sentiment: toDbSentiment(sentiment),
      receivedAt: new Date(),
      gmailMessageId: msg.messageId,
      acknowledged: true,
    });

    await notifyOwner({
      title: `Reply handled: ${contact.name} (${tenantSlug}) [${sentiment}]`,
      content: `${contact.name} at ${account?.name ?? "Unknown"} replied. Sentiment: ${sentiment}. Auto-response sent with Calendly link.

Their reply:
${replyBody.slice(0, 500)}`,
    }).catch(() => {});

    console.log(`[ReplyAgent] Auto-reply sent to contact ${contactId} (sentiment: ${sentiment})`);
  }
}