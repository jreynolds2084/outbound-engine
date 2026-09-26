/**
 * exportTenantData.ts
 *
 * The exit export: a tenant's contact lists and every piece of outreach copy
 * written for them, as CSV.
 *
 * Service agreements routinely promise that a departing client keeps its
 * contact lists and outreach copy "in a standard spreadsheet format at no
 * charge", usually on a 30-day clock. Before this module the only file output
 * in the codebase was googleDrive.ts, which writes Markdown and reads PDFs.
 * This is the obligation, in code, so honouring it is a function call rather
 * than an afternoon of ad-hoc SQL under time pressure.
 *
 * ── CSV, deliberately ────────────────────────────────────────────────────
 * CSV over XLSX because it needs no dependency, opens in every spreadsheet
 * program, and is what "standard spreadsheet format" means when the recipient
 * may be importing into a CRM rather than reading it.
 *
 * ── Formula injection ────────────────────────────────────────────────────
 * The export is opened in Excel or Sheets by definition, and prospect data is
 * attacker-influenced: a name or email captured from an enrichment provider
 * can begin with `=`, `+`, `-`, `@`, tab or carriage return, which those
 * programs execute as a formula. `escapeCsvField` prefixes a single quote to
 * any such value. The character is visible in the cell but inert, which is the
 * right trade for a file being handed to a client on their way out.
 */
import { asc, eq } from "drizzle-orm";
import { accounts, contacts, outreachEmails, tenants } from "../drizzle/schema";
import { getDb } from "./db";

/** Characters a spreadsheet treats as the start of a formula. */
const FORMULA_PREFIXES = ["=", "+", "-", "@", "\t", "\r"];

/**
 * Quote and escape one field for CSV, neutralising spreadsheet formulas.
 *
 * Null and undefined become an empty field rather than the strings "null" or
 * "undefined", which is what a spreadsheet user means by a blank cell.
 */
export function escapeCsvField(value: unknown): string {
  // A quoted empty field, not a bare one: every field this function emits is
  // quoted, and a row that mixes the two conventions is harder to eyeball when
  // someone is diffing an export against a client's own list.
  if (value === null || value === undefined) return '""';
  let text: string;
  if (value instanceof Date) text = value.toISOString();
  else if (typeof value === "boolean") text = value ? "true" : "false";
  else text = String(value);

  if (text.length > 0 && FORMULA_PREFIXES.some((p) => text.startsWith(p))) {
    text = `'${text}`;
  }
  // Always quote. Cheaper than deciding, and immune to a delimiter or newline
  // appearing in body copy, which in an outreach export it certainly will.
  return `"${text.replace(/"/g, '""')}"`;
}

/** One CSV row, with CRLF line endings as RFC 4180 specifies. */
export function toCsvRow(fields: unknown[]): string {
  return fields.map(escapeCsvField).join(",") + "\r\n";
}

/** A full CSV document from a header row and its data rows. */
export function toCsv(headers: string[], rows: unknown[][]): string {
  return [toCsvRow(headers), ...rows.map(toCsvRow)].join("");
}

// ── Table shapes ─────────────────────────────────────────────────────────────

export const CONTACT_HEADERS = [
  "contact_id",
  "account",
  "account_domain",
  "account_industry",
  "account_city",
  "account_province",
  "name",
  "role",
  "email",
  "email_verification",
  "phone",
  "linkedin_url",
  "status",
  "opted_out",
  "opted_out_at",
  "first_send_at",
  "last_send_at",
  "created_at",
] as const;

export const OUTREACH_HEADERS = [
  "outreach_id",
  "contact_id",
  "contact_name",
  "contact_email",
  "account",
  "touch_number",
  "touch_label",
  "subject",
  "body",
  "status",
  "scheduled_date",
  "sent_at",
  "created_at",
] as const;

export interface TenantExport {
  tenantSlug: string;
  tenantName: string;
  generatedAt: Date;
  /** Filename → CSV content, ready to write to disk or stream into a zip. */
  files: Record<string, string>;
  counts: { contacts: number; outreachEmails: number };
}

/**
 * Build the export for one tenant.
 *
 * Everything is included: opted-out and bounced contacts too. The client's
 * list is the client's list, and an export that silently omitted the people
 * who said no would hand them back a list that looks clean and is not —
 * suppression records are the most important rows in the file, not the least.
 * `opted_out` is a column so the recipient can honour it.
 *
 * Returns null when the tenant does not exist, so the caller can tell "no such
 * tenant" from "a tenant with nothing in it".
 */
export async function buildTenantExport(tenantId: number, now: Date = new Date()): Promise<TenantExport | null> {
  const db = await getDb();
  if (!db) return null;

  const tenantRows = await db
    .select({ slug: tenants.slug, displayName: tenants.displayName })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  const tenant = tenantRows[0];
  if (!tenant) return null;

  const contactRows = await db
    .select({
      contactId: contacts.id,
      account: accounts.name,
      accountDomain: accounts.domain,
      accountIndustry: accounts.industry,
      accountCity: accounts.city,
      accountProvince: accounts.province,
      name: contacts.name,
      role: contacts.role,
      email: contacts.email,
      emailVerification: contacts.emailVerification,
      phone: contacts.phone,
      linkedinUrl: contacts.linkedinUrl,
      status: contacts.status,
      optedOut: contacts.optedOut,
      optedOutAt: contacts.optedOutAt,
      startedAt: contacts.startedAt,
      lastSendAt: contacts.lastSendAt,
      createdAt: contacts.createdAt,
    })
    .from(contacts)
    .innerJoin(accounts, eq(contacts.accountId, accounts.id))
    .where(eq(contacts.tenantId, tenantId))
    .orderBy(asc(accounts.name), asc(contacts.id));

  const outreachRows = await db
    .select({
      outreachId: outreachEmails.id,
      contactId: contacts.id,
      contactName: contacts.name,
      contactEmail: contacts.email,
      account: accounts.name,
      dayNumber: outreachEmails.dayNumber,
      touch: outreachEmails.touch,
      subject: outreachEmails.subject,
      body: outreachEmails.body,
      status: outreachEmails.status,
      scheduledDate: outreachEmails.scheduledDate,
      sentAt: outreachEmails.sentAt,
      createdAt: outreachEmails.createdAt,
    })
    .from(outreachEmails)
    .innerJoin(contacts, eq(outreachEmails.contactId, contacts.id))
    .innerJoin(accounts, eq(contacts.accountId, accounts.id))
    .where(eq(outreachEmails.tenantId, tenantId))
    .orderBy(asc(contacts.id), asc(outreachEmails.dayNumber));

  const contactsCsv = toCsv(
    [...CONTACT_HEADERS],
    contactRows.map((r) => [
      r.contactId,
      r.account,
      r.accountDomain,
      r.accountIndustry,
      r.accountCity,
      r.accountProvince,
      r.name,
      r.role,
      r.email,
      r.emailVerification,
      r.phone,
      r.linkedinUrl,
      r.status,
      r.optedOut,
      r.optedOutAt,
      r.startedAt,
      r.lastSendAt,
      r.createdAt,
    ]),
  );

  const outreachCsv = toCsv(
    [...OUTREACH_HEADERS],
    outreachRows.map((r) => [
      r.outreachId,
      r.contactId,
      r.contactName,
      r.contactEmail,
      r.account,
      r.dayNumber,
      r.touch,
      r.subject,
      r.body,
      r.status,
      r.scheduledDate,
      r.sentAt,
      r.createdAt,
    ]),
  );

  const stamp = now.toISOString().slice(0, 10);
  return {
    tenantSlug: tenant.slug,
    tenantName: tenant.displayName,
    generatedAt: now,
    files: {
      [`${tenant.slug}-contacts-${stamp}.csv`]: contactsCsv,
      [`${tenant.slug}-outreach-${stamp}.csv`]: outreachCsv,
    },
    counts: { contacts: contactRows.length, outreachEmails: outreachRows.length },
  };
}
