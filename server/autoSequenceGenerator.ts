/**
 * autoSequenceGenerator.ts
 *
 * Server-side sequence generation for tenants with auto-approve enabled.
 * Called by the daily drip job after it moves accounts from holding to queued.
 *
 * Same generation logic as the interactive account queue, but it runs without
 * a request context (no user session required).
 */

import { getDb, insertOutreachEmail, resolveProductProfileId, getProductProfileFields } from "./db";
import { insertCall } from "./callScheduler";
import {
  accounts,
  contacts,
  outreachEmails,
  linkedinTasks,
  calls,
  tenants,
  campaignMemberships,
} from "../drizzle/schema";
import { and, eq } from "drizzle-orm";
import { invokeLLM } from "./_core/llm";
import { scrubText } from "./scrubber";
import { notifyOwner } from "./_core/notification";

// ─── Tenant YAML helper ───────────────────────────────────────────────────────

async function getTenantYaml(tenantId: number): Promise<Record<string, unknown>> {
  const db = await getDb();
  if (!db) return {};
  const rows = await db
    .select({ tenantConfigYaml: tenants.tenantConfigYaml })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  const yaml = rows[0]?.tenantConfigYaml;
  if (!yaml) return {};
  try {
    const { parse } = await import("yaml") as { parse: (s: string) => Record<string, unknown> };
    return parse(yaml) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ─── Sequence generator (mirrors the interactive account-queue logic) ─────────

interface SequenceResult {
  emails: Array<{
    touch: string;
    day_number: number;
    subject: string;
    body: string;
  }>;
  linkedinTasks: Array<{
    send_day: number;
    message_type: string;
    message_body: string;
  }>;
  calls: Array<{
    day_number: number;
    opening: string;
    value_statement: string;
    voicemail_script: string;
  }>;
}

async function generateSequence(params: {
  companyName: string;
  contactName: string;
  contactTitle: string;
  tenantConfig: Record<string, unknown>;
}): Promise<SequenceResult> {
  const { companyName, contactName, contactTitle, tenantConfig } = params;

  const systemPrompt = `You are an expert B2B cold outreach copywriter. Generate a complete multi-touch outreach sequence.

VOICE RULES (non-negotiable):
- Direct and short. No corporate jargon, no filler phrases. Get to the point in the first sentence.
- No em dashes. Use periods, commas, or split into two sentences.
- Cut hedge words like "just" and "hopefully" unless there is a real reason to soften something.
- Never name a specific customer or client by name. Instead offer proof without naming: "a similar [vertical] client," "happy to share specifics live."
- No vague social proof. Either give a concrete, unnamed detail (timeline, outcome, mechanism) or do not claim it at all.
- Every touch needs a distinct angle or new piece of information. Never repeat the same pitch sentence.
- Subject lines are pattern-interrupt, not descriptive.
- Always own the next step. End with what the sender will do, not an open-ended ask.
- Personalize to the prospect's actual business and vertical.
- No hard breakup or "closing the loop" emails. Stay persistent.
- Do NOT open with "Good morning," "Good afternoon," or "Good evening."
- Sign off "Many thanks." — nothing after that. No name, no title, no phone number.

Return a JSON object with this exact schema:
{
  "emails": [
    { "touch": "Email 1", "day_number": 1, "subject": "...", "body": "..." },
    { "touch": "Email 2", "day_number": 3, "subject": "Re: ...", "body": "..." },
    { "touch": "Email 3", "day_number": 7, "subject": "...", "body": "..." },
    { "touch": "Email 4", "day_number": 14, "subject": "...", "body": "..." }
  ],
  "linkedinTasks": [
    { "send_day": 2, "message_type": "Connection Request", "message_body": "..." },
    { "send_day": 8, "message_type": "Follow-up DM", "message_body": "..." }
  ],
  "calls": [
    { "day_number": 4, "opening": "...", "value_statement": "...", "voicemail_script": "..." },
    { "day_number": 10, "opening": "...", "value_statement": "...", "voicemail_script": "..." }
  ]
}`;

  const userPrompt = `Company: ${companyName}
Contact: ${contactName}, ${contactTitle}
Tenant config (product/ICP context):
${JSON.stringify(tenantConfig, null, 2).slice(0, 2000)}

Generate a complete outreach sequence following the voice rules exactly.`;

  const response = await invokeLLM({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const raw = (response.choices?.[0]?.message?.content ?? "").toString().trim();
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  return JSON.parse(cleaned) as SequenceResult;
}

// ─── Scrub helper ─────────────────────────────────────────────────────────────

function scrubEmail(email: { subject: string; body: string }): { subject: string; body: string } {
  return {
    subject: email.subject.replace(/—/g, "-").trim(),
    body: email.body
      .replace(/—/g, "-")
      .replace(/\bGood morning[,.]?/gi, "")
      .replace(/\bGood afternoon[,.]?/gi, "")
      .replace(/\bGood evening[,.]?/gi, "")
      .trim(),
  };
}

// ─── Main auto-sequence function ──────────────────────────────────────────────

/**
 * Generate sequences for all contacts in a newly-queued account.
 * Called by the daily drip job after accounts are moved to queued.
 */
export async function autoGenerateSequencesForAccount(
  accountId: number,
  tenantId: number
): Promise<{ contactsProcessed: number; errors: string[] }> {
  const db = await getDb();
  if (!db) return { contactsProcessed: 0, errors: ["Database unavailable"] };

  const errors: string[] = [];
  let contactsProcessed = 0;

  const [acct] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.tenantId, tenantId)))
    .limit(1);
  if (!acct) return { contactsProcessed: 0, errors: ["Account not found"] };

  // Get the primary contact (first active contact)
  const contactRows = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.accountId, accountId), eq(contacts.pipelineStatus, "active")))
    .limit(1);

  if (contactRows.length === 0) {
    return { contactsProcessed: 0, errors: ["No active contacts found"] };
  }

  const tenantConfig = await getTenantYaml(tenantId);

  for (const contact of contactRows) {
    try {
      // Skip opted-out contacts
      if (contact.optedOut) continue;

      // Resolve the product profile, most specific first: explicit
      // override (none available in this auto-pilot path) → account.productProfileId
      // → campaign.productProfileId (via the contact's campaign membership) →
      // tenant default. Merge over tenantConfig, don't replace it.
      const resolvedProfileId = await resolveProductProfileId({
        tenantId,
        accountProductProfileId: acct.productProfileId,
        contactId: contact.id,
      });
      const resolvedTenantConfig: Record<string, unknown> = { ...tenantConfig };
      if (resolvedProfileId) {
        const profileFields = await getProductProfileFields(resolvedProfileId);
        if (profileFields) {
          resolvedTenantConfig.product_profile_id = resolvedProfileId;
          resolvedTenantConfig.product_profile_name = profileFields.name;
        }
      }

      // Resolve which campaign (holding tank), if any, this contact belongs
      // to, set once on every send-artifact row created below (design doc §3).
      const membershipRows = await db
        .select({ campaignId: campaignMemberships.campaignId })
        .from(campaignMemberships)
        .where(eq(campaignMemberships.contactId, contact.id))
        .limit(1);
      const resolvedCampaignId = membershipRows[0]?.campaignId ?? null;

      // Generate sequence OUTSIDE the transaction (LLM call can be slow)
      const sequence = await generateSequence({
        companyName: acct.name,
        contactName: contact.name,
        contactTitle: contact.role ?? "",
        tenantConfig: resolvedTenantConfig,
      });

      // H5 fix (2026-07): Wrap delete+insert in a transaction so a partial write
      // never leaves the contact with some old emails and some new ones.
      // Use tx.insert directly (not helper functions that call getDb() internally).
      await db.transaction(async (tx) => {
        // Clear any existing sequence for this contact
        await tx.delete(outreachEmails).where(eq(outreachEmails.contactId, contact.id));
        await tx.delete(linkedinTasks).where(eq(linkedinTasks.contactId, contact.id));
        await tx.delete(calls).where(eq(calls.contactId, contact.id));

        // Insert emails
        for (const email of sequence.emails) {
          const scheduled = new Date(Date.now() + (email.day_number - 1) * 24 * 60 * 60 * 1000);
          const scrubbed = scrubEmail({ subject: email.subject, body: email.body });
          await tx.insert(outreachEmails).values({
            contactId: contact.id,
            dayNumber: email.day_number,
            subject: scrubbed.subject,
            body: scrubbed.body,
            scheduledDate: scheduled,
            touch: email.touch?.slice(0, 99) ?? null,
            tenantId,
            campaignId: resolvedCampaignId,
          });
        }

        // Insert LinkedIn tasks (deduplicated by day)
        const insertedLiDays = new Set<number>();
        for (const lt of sequence.linkedinTasks) {
          if (insertedLiDays.has(lt.send_day)) continue;
          insertedLiDays.add(lt.send_day);
          const liScheduled = new Date(Date.now() + (lt.send_day - 1) * 24 * 60 * 60 * 1000);
          await tx.insert(linkedinTasks).values({
            contactId: contact.id,
            accountId,
            linkedinSearchUrl: contact.linkedinUrl ?? null,
            sendDay: lt.send_day,
            scheduledDate: liScheduled,
            messageType: lt.message_type.slice(0, 99),
            messageBody: scrubText(lt.message_body).text,
            status: "Pending",
            tenantId,
            campaignId: resolvedCampaignId,
          });
        }

        // Insert calls (deduplicated by day)
        const insertedCallDays = new Set<number>();
        for (const c of sequence.calls) {
          if (insertedCallDays.has(c.day_number)) continue;
          insertedCallDays.add(c.day_number);
          const callScheduled = new Date(Date.now() + (c.day_number - 1) * 24 * 60 * 60 * 1000);
          await tx.insert(calls).values({
            tenantId,
            contactId: contact.id,
            accountId,
            scheduledFor: callScheduled,
            status: "Scheduled",
            source: "Manual",
            opening: c.opening ?? null,
            valueStatement: c.value_statement ?? null,
            voicemailScript: c.voicemail_script ?? null,
            campaignId: resolvedCampaignId,
          });
        }
      }); // end transaction

      contactsProcessed++;
    } catch (err) {
      const msg = `Contact ${contact.id} (${contact.name}): ${String(err)}`;
      console.error(`[AutoSequence] ${msg}`);
      errors.push(msg);
    }
  }

  // Move account to active after sequences are generated
  await db
    .update(accounts)
    .set({ pipelineStatus: "active" })
    .where(eq(accounts.id, accountId));

  await db
    .update(contacts)
    .set({ pipelineStatus: "active" })
    .where(eq(contacts.accountId, accountId));

  return { contactsProcessed, errors };
}
