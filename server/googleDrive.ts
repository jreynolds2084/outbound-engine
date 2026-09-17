/**
 * googleDrive.ts
 *
 * Handles Google OAuth 2.0 token management and Drive API calls.
 * Tokens are stored in the `google_tokens` database table so they persist
 * across restarts and redeploys.
 */

import { google } from "googleapis";
import { getDb } from "./db";
import { googleTokens } from "../drizzle/schema";
import { desc, eq, isNull } from "drizzle-orm";

const SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
];

/** Build an OAuth2 client from env-injected credentials */
export function getOAuth2Client() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  // Must match a URI registered in Google Cloud Console exactly. Set
  // GOOGLE_OAUTH_REDIRECT_URI to your origin's callback; the fallback only
  // suits local development.
  const redirectUri =
    process.env.GOOGLE_OAUTH_REDIRECT_URI ??
    "http://localhost:3000/api/oauth/google/callback";

  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_OAUTH_CLIENT_ID or GOOGLE_OAUTH_CLIENT_SECRET not set.");
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/**
 * Generate the Google authorization URL.
 *
 * `state` carries the tenant slug through the round trip so the callback knows
 * which tenant just connected, the same pattern microsoftOAuthRoutes uses.
 */
export function getAuthUrl(state?: string): string {
  const oauth2 = getOAuth2Client();
  return oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // force refresh_token to be returned every time
    scope: SCOPES,
    ...(state ? { state } : {}),
  });
}

/**
 * Exchange an authorization code for tokens and persist them for one tenant.
 *
 * Scoped delete, not a table wipe: connecting Google for one tenant must not
 * disconnect another. Passing no tenantId writes the legacy shared row
 * (tenantId NULL), which is what every existing caller gets.
 *
 * Returns the Google account that was actually authorized, so the caller can
 * tell the user who they just connected as rather than assuming.
 */
export async function exchangeCodeAndStore(code: string, tenantId?: number): Promise<{ accountEmail: string | null }> {
  const oauth2 = getOAuth2Client();
  const { tokens } = await oauth2.getToken(code);

  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error("Google did not return both access_token and refresh_token.");
  }

  // Ask Google which mailbox this is. Cheap, and it turns "connected" from a
  // boolean into a checkable fact.
  let accountEmail: string | null = null;
  try {
    const probe = getOAuth2Client();
    probe.setCredentials({ access_token: tokens.access_token });
    const profile = await google.gmail({ version: "v1", auth: probe }).users.getProfile({ userId: "me" });
    accountEmail = profile.data.emailAddress ?? null;
  } catch {
    // Non-fatal: the token is still good, we just cannot label it.
  }

  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .delete(googleTokens)
    .where(tenantId == null ? isNull(googleTokens.tenantId) : eq(googleTokens.tenantId, tenantId));
  await db.insert(googleTokens).values({
    tenantId: tenantId ?? null,
    accountEmail,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: new Date(tokens.expiry_date ?? Date.now() + 3600 * 1000),
    scope: tokens.scope ?? SCOPES.join(" "),
  });
  return { accountEmail };
}

/**
 * Load a stored token and return an authenticated OAuth2 client.
 *
 * Prefers the tenant's own Google account and falls back to the shared row, so
 * tenants that never connected their own keep working exactly as before.
 */
export async function getAuthenticatedClient(tenantId?: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  let rows: (typeof googleTokens.$inferSelect)[] = [];
  if (tenantId != null) {
    rows = await db
      .select()
      .from(googleTokens)
      .where(eq(googleTokens.tenantId, tenantId))
      .orderBy(desc(googleTokens.createdAt))
      .limit(1);
  }
  if (rows.length === 0) {
    rows = await db
      .select()
      .from(googleTokens)
      .where(isNull(googleTokens.tenantId))
      .orderBy(desc(googleTokens.createdAt))
      .limit(1);
  }
  if (rows.length === 0) {
    // Last resort: any row at all, preserving pre-2026-08-09 behaviour for a
    // database where the shared row was written with a tenantId by accident.
    rows = await db.select().from(googleTokens).orderBy(desc(googleTokens.createdAt)).limit(1);
  }
  if (rows.length === 0) {
    throw new Error("No Google token stored. Please connect a Google account first.");
  }
  const row = rows[0];
  const oauth2 = getOAuth2Client();
  oauth2.setCredentials({
    access_token: row.accessToken,
    refresh_token: row.refreshToken,
    expiry_date: row.expiresAt.getTime(),
  });

  // Auto-refresh if expired
  oauth2.on("tokens", async (newTokens) => {
    if (newTokens.access_token) {
      const db2 = await getDb();
      if (!db2) return;
      await db2
        .update(googleTokens)
        .set({
          accessToken: newTokens.access_token,
          expiresAt: new Date(newTokens.expiry_date ?? Date.now() + 3600 * 1000),
        })
        .where(eq(googleTokens.id, row.id));
    }
  });

  return oauth2;
}

/** Check whether a Google token is stored (tenant's own, or the shared one). */
export async function isDriveConnected(tenantId?: number): Promise<boolean> {
  return (await getConnectedAccount(tenantId)) !== null;
}

/**
 * Which Google account this tenant will send as, and whether it is the tenant's
 * own or the shared fallback. Returns null when nothing is connected.
 *
 * The distinction matters: a tenant silently inheriting the shared mailbox
 * looks identical to one properly connected, and that is exactly how a personal
 * email would go out from a sales address.
 */
export async function getConnectedAccount(
  tenantId?: number,
): Promise<{ accountEmail: string | null; own: boolean } | null> {
  const db = await getDb();
  if (!db) return null;
  if (tenantId != null) {
    const own = await db
      .select({ accountEmail: googleTokens.accountEmail })
      .from(googleTokens)
      .where(eq(googleTokens.tenantId, tenantId))
      .limit(1);
    if (own.length) return { accountEmail: own[0].accountEmail, own: true };
  }
  const shared = await db
    .select({ accountEmail: googleTokens.accountEmail })
    .from(googleTokens)
    .where(isNull(googleTokens.tenantId))
    .limit(1);
  if (shared.length) return { accountEmail: shared[0].accountEmail, own: false };
  const any = await db.select({ accountEmail: googleTokens.accountEmail }).from(googleTokens).limit(1);
  return any.length ? { accountEmail: any[0].accountEmail, own: false } : null;
}

/** List sub-folders inside a parent folder */
export async function listSubFolders(
  parentFolderId: string
): Promise<Array<{ id: string; name: string }>> {
  const auth = await getAuthenticatedClient();
  const drive = google.drive({ version: "v3", auth });
  const res = await drive.files.list({
    q: `"${parentFolderId}" in parents and mimeType="application/vnd.google-apps.folder" and trashed=false`,
    fields: "files(id,name)",
    pageSize: 100,
  });
  return (res.data.files ?? []) as Array<{ id: string; name: string }>;
}

/** List files by name inside a folder */
export async function listFilesInFolder(
  folderId: string,
  fileName: string
): Promise<Array<{ id: string; name: string }>> {
  const auth = await getAuthenticatedClient();
  const drive = google.drive({ version: "v3", auth });
  const res = await drive.files.list({
    q: `"${folderId}" in parents and name="${fileName}" and trashed=false`,
    fields: "files(id,name)",
    pageSize: 10,
  });
  return (res.data.files ?? []) as Array<{ id: string; name: string }>;
}

/** Tier → filename stem mapping */
export const TIER_FILE_STEM: Record<string, string> = {
  budget: "PROSPECT-ANALYSIS-BUDGET",
  hybrid: "PROSPECT-ANALYSIS-HYBRID",
  full: "PROSPECT-ANALYSIS-FULL",
  legacy: "PROSPECT-ANALYSIS", // files created before tier-specific naming
};

/**
 * Find the tier-specific PDF in a folder (e.g. PROSPECT-ANALYSIS-FULL.pdf).
 * Falls back to PROSPECT-ANALYSIS.pdf (legacy) if tier-specific file not found.
 * Returns the first matching file or null.
 */
export async function findTierPdfInFolder(
  folderId: string,
  tier: string
): Promise<{ id: string; name: string } | null> {
  const stem = TIER_FILE_STEM[tier] ?? TIER_FILE_STEM.hybrid;
  const auth = await getAuthenticatedClient();
  const drive = google.drive({ version: "v3", auth });
  // Try tier-specific first
  const res = await drive.files.list({
    q: `"${folderId}" in parents and name="${stem}.pdf" and trashed=false`,
    fields: "files(id,name)",
    pageSize: 5,
  });
  const files = (res.data.files ?? []) as Array<{ id: string; name: string }>;
  if (files.length > 0) return files[0];
  // Legacy fallback
  if (tier !== "legacy") {
    const legacyRes = await drive.files.list({
      q: `"${folderId}" in parents and name="PROSPECT-ANALYSIS.pdf" and trashed=false`,
      fields: "files(id,name)",
      pageSize: 5,
    });
    const legacyFiles = (legacyRes.data.files ?? []) as Array<{ id: string; name: string }>;
    if (legacyFiles.length > 0) return legacyFiles[0];
  }
  return null;
}

/**
 * Find the tier-specific MD file in a folder (e.g. PROSPECT-ANALYSIS-FULL.md).
 * Falls back to PROSPECT-ANALYSIS.md (legacy) if tier-specific file not found.
 * Returns the first matching file or null.
 */
export async function findTierMdInFolder(
  folderId: string,
  tier: string
): Promise<{ id: string; name: string } | null> {
  const stem = TIER_FILE_STEM[tier] ?? TIER_FILE_STEM.hybrid;
  const auth = await getAuthenticatedClient();
  const drive = google.drive({ version: "v3", auth });
  // Try tier-specific first
  const res = await drive.files.list({
    q: `"${folderId}" in parents and name="${stem}.md" and trashed=false`,
    fields: "files(id,name)",
    pageSize: 5,
  });
  const files = (res.data.files ?? []) as Array<{ id: string; name: string }>;
  if (files.length > 0) return files[0];
  // Legacy fallback
  if (tier !== "legacy") {
    const legacyRes = await drive.files.list({
      q: `"${folderId}" in parents and name="PROSPECT-ANALYSIS.md" and trashed=false`,
      fields: "files(id,name)",
      pageSize: 5,
    });
    const legacyFiles = (legacyRes.data.files ?? []) as Array<{ id: string; name: string }>;
    if (legacyFiles.length > 0) return legacyFiles[0];
  }
  return null;
}

/** Find PDF files inside a folder (by mimeType) */
export async function listPdfsInFolder(
  folderId: string
): Promise<Array<{ id: string; name: string }>> {
  const auth = await getAuthenticatedClient();
  const drive = google.drive({ version: "v3", auth });
  const res = await drive.files.list({
    q: `"${folderId}" in parents and mimeType="application/pdf" and trashed=false`,
    fields: "files(id,name)",
    pageSize: 10,
  });
  return (res.data.files ?? []) as Array<{ id: string; name: string }>;
}

/**
 * Update an email address in a PROSPECT-ANALYSIS.md file stored in Drive.
 * Replaces all occurrences of oldEmail with newEmail in the file content,
 * then writes the updated content back using the drive.file scope.
 */
export async function writeEmailToDrive(
  fileId: string,
  oldEmail: string,
  newEmail: string,
): Promise<void> {
  const auth = await getAuthenticatedClient();
  const drive = google.drive({ version: "v3", auth });
  // Download current content
  const current = await downloadFileContent(fileId);
  // Replace all occurrences of the old email (case-insensitive)
  const updated = current.replace(new RegExp(oldEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), newEmail);
  if (updated === current) return; // nothing to change
  // Upload updated content back
  await drive.files.update({
    fileId,
    requestBody: {},
    media: {
      mimeType: "text/markdown",
      body: updated,
    },
  });
}

/** Create a sub-folder inside a parent folder. Returns the new folder's ID. */
export async function createFolderInParent(
  parentFolderId: string,
  folderName: string
): Promise<string> {
  const auth = await getAuthenticatedClient();
  const drive = google.drive({ version: "v3", auth });
  const res = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentFolderId],
    },
    fields: "id",
  });
  const id = res.data.id;
  if (!id) throw new Error("Drive folder creation returned no ID");
  return id;
}

/** Upload a markdown string as PROSPECT-ANALYSIS.md inside a folder. Returns the file ID and web URL. */
export async function uploadMarkdownFile(
  folderId: string,
  content: string
): Promise<{ fileId: string; webViewLink: string }> {
  const auth = await getAuthenticatedClient();
  const drive = google.drive({ version: "v3", auth });
  const { Readable } = await import("stream");
  const res = await drive.files.create({
    requestBody: {
      name: "PROSPECT-ANALYSIS.md",
      parents: [folderId],
      mimeType: "text/markdown",
    },
    media: {
      mimeType: "text/markdown",
      body: Readable.from([content]),
    },
    fields: "id,webViewLink",
  });
  const fileId = res.data.id;
  const webViewLink = res.data.webViewLink ?? "";
  if (!fileId) throw new Error("Drive file upload returned no ID");
  return { fileId, webViewLink };
}

/** Download a file's text content */
export async function downloadFileContent(fileId: string): Promise<string> {
  const auth = await getAuthenticatedClient();
  const drive = google.drive({ version: "v3", auth });
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "text" }
  );
  return res.data as string;
}
