import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql2 from "mysql2";
import {
  campaignMemberships,
  campaigns,
  contacts,
  outreachEmails,
  productProfiles,
  type InsertOutreachEmail,
} from "../drizzle/schema";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      // An explicit pool, so parallel LLM-driven account processing does not
      // queue behind a single connection.
      const pool = mysql2.createPool({
        uri: process.env.DATABASE_URL,
        connectionLimit: 20,
        waitForConnections: true,
        queueLimit: 0,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _db = drizzle(pool.promise() as any);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

// =====================================================================
// Contacts
// =====================================================================

export async function updateContactStatus(
  contactId: number,
  patch: Partial<{
    status: "Pending" | "Sent" | "Bounced" | "Replied" | "Warm";
    sequenceDay: number;
    threadId: string;
    lastSendAt: Date;
    bouncedEmail: string;
  }>,
) {
  const db = await getDb();
  if (!db) return;
  await db.update(contacts).set(patch).where(eq(contacts.id, contactId));
}

// =====================================================================
// Outreach emails
// =====================================================================

export async function listEmailsForContact(contactId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(outreachEmails)
    .where(eq(outreachEmails.contactId, contactId))
    .orderBy(outreachEmails.dayNumber);
}

/**
 * Insert one sequence touch. Idempotent per (contact, day): if an unsent touch
 * already exists for that day, its id is returned instead of a duplicate.
 */
export async function insertOutreachEmail(input: InsertOutreachEmail) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (input.contactId && input.dayNumber) {
    const existing = await db
      .select({ id: outreachEmails.id })
      .from(outreachEmails)
      .where(
        and(
          eq(outreachEmails.contactId, input.contactId),
          eq(outreachEmails.dayNumber, input.dayNumber),
          sql`${outreachEmails.status} != 'Sent'`,
        ),
      )
      .limit(1);
    if (existing.length > 0) return existing[0].id;
  }
  const result = await db.insert(outreachEmails).values(input).$returningId();
  return result[0].id;
}

// =====================================================================
// Product profiles
// =====================================================================

/**
 * Resolve the default product profile ID for a tenant.
 * Returns undefined if no profiles exist.
 */
export async function resolveDefaultProductProfileId(tenantId: number): Promise<number | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db
    .select({ id: productProfiles.id })
    .from(productProfiles)
    .where(and(eq(productProfiles.tenantId, tenantId), eq(productProfiles.isDefault, true)))
    .limit(1);
  if (rows.length > 0) return rows[0].id;
  // Fall back to the first profile if none is marked default.
  const fallback = await db
    .select({ id: productProfiles.id })
    .from(productProfiles)
    .where(eq(productProfiles.tenantId, tenantId))
    .limit(1);
  return fallback[0]?.id;
}

/**
 * Which product profile a generated sequence should use, most specific first:
 *   explicit override → account.productProfileId → campaign.productProfileId
 *   (via the contact's campaign membership) → tenant default.
 */
export async function resolveProductProfileId(params: {
  tenantId: number;
  explicitOverride?: number | null;
  accountProductProfileId?: number | null;
  contactId?: number | null;
}): Promise<number | undefined> {
  if (params.explicitOverride) return params.explicitOverride;
  if (params.accountProductProfileId) return params.accountProductProfileId;

  if (params.contactId) {
    const db = await getDb();
    if (db) {
      const membershipRows = await db
        .select({ campaignId: campaignMemberships.campaignId })
        .from(campaignMemberships)
        .where(eq(campaignMemberships.contactId, params.contactId))
        .limit(1);
      const campaignId = membershipRows[0]?.campaignId;
      if (campaignId) {
        const campaignRows = await db
          .select({ productProfileId: campaigns.productProfileId })
          .from(campaigns)
          .where(eq(campaigns.id, campaignId))
          .limit(1);
        if (campaignRows[0]?.productProfileId) return campaignRows[0].productProfileId;
      }
    }
  }

  return resolveDefaultProductProfileId(params.tenantId);
}

/**
 * The fields a resolved product profile contributes to generation config.
 * Profiles currently store only a name, which is merged into the tenant
 * config as a positioning hint.
 */
export async function getProductProfileFields(profileId: number): Promise<{ name: string } | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db
    .select({ name: productProfiles.name })
    .from(productProfiles)
    .where(eq(productProfiles.id, profileId))
    .limit(1);
  return rows[0];
}
