/**
 * bounceShared.ts
 *
 * Shared "mark this contact bounced" logic, so every bounce detection path
 * (inbox-polled NDRs and relayed feedback events) calls the same code instead
 * of copies drifting apart.
 */
import { and, eq, inArray } from "drizzle-orm";
import { contacts, outreachEmails } from "../drizzle/schema";
import type { getDb } from "./db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * Extract the original recipient email address from an NDR body.
 * NDRs typically contain the original address in patterns like:
 *   "Original-Recipient: rfc822; user@example.com"
 *   "Final-Recipient: rfc822; user@example.com"
 *   "To: user@example.com"
 *   or just an email address in the body text.
 *
 * Lives here so the inbox-polling bounce check and the relayed feedback path
 * share one extractor instead of two copies.
 */
export function extractBouncedEmail(bodyText: string): string | null {
  if (!bodyText) return null;

  // Try RFC 3464 delivery status fields first (most reliable)
  const rfcPatterns = [
    /Final-Recipient:\s*rfc822;\s*([^\s\r\n]+)/i,
    /Original-Recipient:\s*rfc822;\s*([^\s\r\n]+)/i,
  ];
  for (const pattern of rfcPatterns) {
    const match = bodyText.match(pattern);
    if (match?.[1]) return match[1].trim().toLowerCase();
  }

  // Try "To: email@example.com" line in the NDR
  const toMatch = bodyText.match(/^To:\s*([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/m);
  if (toMatch?.[1]) return toMatch[1].trim().toLowerCase();

  // Fallback: find any email address in the body
  const emailMatch = bodyText.match(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/);
  if (emailMatch?.[1]) return emailMatch[1].trim().toLowerCase();

  return null;
}

/**
 * Mark a contact Bounced and skip every Pending outreach email for them.
 * Leaves the account active, other contacts at the same account continue.
 *
 * `appendToTriedEmails` mirrors the manual bounce-retry flow. The inbox-polling
 * bounce check never appended to triedEmails, so it passes the flag as
 * false/omitted; the relayed feedback path opts in because it may be recording
 * a bounce on a guessed address.
 */
export async function markContactBounced(
  db: Db,
  contactId: number,
  bouncedEmail: string,
  opts: { appendToTriedEmails?: boolean } = {},
): Promise<void> {
  const patch: { status: "Bounced"; bouncedEmail: string; triedEmails?: string } = {
    status: "Bounced",
    bouncedEmail,
  };

  if (opts.appendToTriedEmails) {
    const existingRows = await db
      .select({ triedEmails: contacts.triedEmails })
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .limit(1);
    let tried: string[] = [];
    const existingJson = existingRows[0]?.triedEmails;
    if (existingJson) {
      try {
        tried = JSON.parse(existingJson) as string[];
      } catch {
        // ignore malformed existing JSON, start fresh rather than throw
      }
    }
    if (!tried.includes(bouncedEmail)) tried.push(bouncedEmail);
    patch.triedEmails = JSON.stringify(tried);
  }

  await db.update(contacts).set(patch).where(eq(contacts.id, contactId));

  await db
    .update(outreachEmails)
    .set({ status: "Skipped" })
    .where(and(eq(outreachEmails.contactId, contactId), inArray(outreachEmails.status, ["Pending"])));
}
