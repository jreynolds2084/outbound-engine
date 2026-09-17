import { int, tinyint, mysqlEnum, mysqlTable, text, timestamp, varchar, boolean, uniqueIndex, index } from "drizzle-orm/mysql-core";

// Product profiles, named selling contexts per tenant (e.g. "General", "Enterprise")
export const productProfiles = mysqlTable("product_profiles", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull() /* C1: no default — callers must supply explicit tenantId */,
  name: varchar("name", { length: 200 }).notNull(),
  isDefault: boolean("isDefault").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type ProductProfile = typeof productProfiles.$inferSelect;
export type InsertProductProfile = typeof productProfiles.$inferInsert;

// Accounts represent prospect companies (e.g., UniUni, Apply Digital, Pacific Blue Cross)
export const accounts = mysqlTable("accounts", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull() /* C1: no default — callers must supply explicit tenantId */,
  name: varchar("name", { length: 200 }).notNull(),
  status: mysqlEnum("status", ["Active", "Bounced", "Replied"]).default("Active").notNull(),
  industry: varchar("industry", { length: 200 }),
  notes: text("notes"),
  sourceFile: varchar("sourceFile", { length: 400 }),
  researchTier: mysqlEnum("researchTier", ["budget", "hybrid", "full"]),
  driveFileId: varchar("driveFileId", { length: 400 }),
  /** JSON array of buying signals from the ### Trigger Events section of the prospect analysis */
  triggerEventsJson: text("triggerEventsJson"),
  /**
   * Custom fields parsed from the ### Custom Fields section of the prospect analysis.
   * Shape: Record<string, string>, keys are field labels, values are raw strings.
   * The renderer uses the tenant config `type` to decide how to display each field.
   */
  customFieldsJson: text("customFieldsJson"),
  /**
   * Holding tank pipeline status.
   * 'holding' = in holding tank, invisible to all queues/pipeline
   * 'queued'  = in Account Queue batch, visible to rep for contact selection
   * 'active'  = in active pipeline, fully visible everywhere
   */
  pipelineStatus: mysqlEnum("pipelineStatus", ["holding", "queued", "active"]).default("active").notNull(),
  /** 1 = bulk upload (highest priority), 2 = auto-populated (Phase 2+), NULL = not in holding tank */
  holdingPriority: int("holdingPriority"),
  /** Company domain, e.g. "leavitt.ca", used for Hunter lookups and duplicate checks */
  domain: varchar("domain", { length: 300 }),
  /** Contact selected by rep on Account Queue Accept */
  selectedContactId: int("selectedContactId"),
  /** Product profile used when generating Haiku sequence */
  productProfileId: int("productProfileId"),
  /** City of the prospect company, sourced from data provider at List Builder insert time */
  city: varchar("city", { length: 200 }),
  /** Province/state of the prospect company, sourced from data provider at List Builder insert time */
  province: varchar("province", { length: 200 }),
  /** Employee headcount range, e.g. "50-200", sourced from data provider */
  employeeRange: varchar("employeeRange", { length: 100 }),
  /** Revenue range, e.g. "$1M-$10M", sourced from data provider */
  revenueRange: varchar("revenueRange", { length: 100 }),
  /** Head office phone number, auto-enriched via Tavily on account accept */
  phone: varchar("phone", { length: 40 }),
  /**
   * Archived, set true to make an account (and its contacts) disappear from
   * every tank, queue, count, and list without deleting anything. Orthogonal
   * to `pipelineStatus`: archiving does NOT change pipelineStatus, so
   * un-archiving restores the account to exactly the queue/tank it was in
   * before, with no need to remember or reconstruct its prior state.
   * `outreach_emails`/`calls`/`linkedin_tasks` history is untouched either
   * way, archived only gates listing queries, never deletes rows.
   * Default false so every existing row is unaffected by this column's
   * addition.
   */
  archived: boolean("archived").default(false).notNull(),
  /** Set only when `archived` flips true; cleared back to null on un-archive. Audit trail. */
  archivedAt: timestamp("archivedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Account = typeof accounts.$inferSelect;
export type InsertAccount = typeof accounts.$inferInsert;

// Contacts are the individuals at each account being targeted
export const contacts = mysqlTable("contacts", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull() /* C1: no default — callers must supply explicit tenantId */,
  accountId: int("accountId").notNull(),
  name: varchar("name", { length: 200 }).notNull(),
  email: varchar("email", { length: 320 }),
  role: varchar("role", { length: 200 }),
  phone: varchar("phone", { length: 40 }),
  sequenceDay: int("sequenceDay").default(0).notNull(),
  status: mysqlEnum("status", ["Pending", "Sent", "Bounced", "Replied", "Meeting Booked", "Unreachable", "Warm"]).default("Pending").notNull(),
  threadId: varchar("threadId", { length: 200 }),
  bouncedEmail: varchar("bouncedEmail", { length: 320 }),
  triedEmails: text("triedEmails"), // JSON array of previously attempted+bounced addresses
  hunterChecked: boolean("hunterChecked").default(false).notNull(),
  hunterEmail: varchar("hunterEmail", { length: 320 }),
  hunterScore: int("hunterScore"),
  emailVerification: mysqlEnum("emailVerification", ["Verified", "Verified-corrected", "Unverified", "Invalid"]),
  lastSendAt: timestamp("lastSendAt"),
  startedAt: timestamp("startedAt"),
  /** One-sentence cold-call intel note from Agent 2 (v2 payload, field 6) */
  callIntel: text("callIntel"),
  /**
   * Pipeline status mirroring the parent account.
   * Set to 'holding' when created from bulk upload; updated to 'queued'/'active' with account.
   */
  pipelineStatus: mysqlEnum("pipelineStatus", ["holding", "queued", "active"]).default("active").notNull(),
  /** LinkedIn profile URL returned by Hunter.io */
  linkedinUrl: varchar("linkedinUrl", { length: 500 }),
  /**
   * X (Twitter) handle, stored without the leading @.
   *
   * A third outreach channel beside email and LinkedIn. A follow needs
   * nobody's approval, unlike a connection request, which can sit pending
   * for months.
   */
  xHandle: varchar("xHandle", { length: 100 }),
  /** CASL opt-out flag, set to true when contact requests removal. Suppresses all future sends. */
  optedOut: boolean("optedOut").default(false).notNull(),
  /** Timestamp when the contact opted out */
  optedOutAt: timestamp("optedOutAt"),
  /** Phone 2, company main line from Google Places (copied from accounts.phone at enrich time) */
  phone2: varchar("phone2", { length: 40 }),
  /** Phone 3, manually entered fallback */
  phone3: varchar("phone3", { length: 40 }),
  /** Source of phone1, 'hunter_direct' | 'google_places' | 'manual' */
  phoneSource: varchar("phoneSource", { length: 50 }),
  /** Whether Hunter.io has been queried for a direct-dial phone number */
  hunterPhoneChecked: boolean("hunterPhoneChecked").default(false).notNull(),
  /** True when the prospect has accepted a LinkedIn connection request */
  linkedInConnected: boolean("linkedInConnected").default(false).notNull(),
  /** Timestamp when the LinkedIn connection was marked */
  linkedInConnectedAt: timestamp("linkedInConnectedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Contact = typeof contacts.$inferSelect;
export type InsertContact = typeof contacts.$inferInsert;

// Outreach emails, both queued (Pending) and historical (Sent/Bounced)
export const outreachEmails = mysqlTable("outreach_emails", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull() /* C1: no default — callers must supply explicit tenantId */,
  contactId: int("contactId").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  dayNumber: int("dayNumber").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  scheduledDate: timestamp("scheduledDate").notNull(),
  sentAt: timestamp("sentAt"),
  /**
   * When delivery was actually confirmed by a downstream `send_confirmed`
   * event. Distinct from `sentAt`, which on a relayed send path only means
   * the first hop accepted the message. Null until that event arrives.
   */
  deliveryConfirmedAt: timestamp("deliveryConfirmedAt"),
  status: mysqlEnum("status", ["Pending", "Sent", "Bounced", "Skipped"]).default("Pending").notNull(),
  /** Stores the Microsoft Graph messageId (or Gmail messageId for legacy gmail path). Column name is historical. */
  gmailMessageId: varchar("gmailMessageId", { length: 200 }),
  /** Stores the Microsoft Graph conversationId (or Gmail threadId for legacy gmail path). Column name is historical. */
  gmailThreadId: varchar("gmailThreadId", { length: 200 }),
  /** Format C: touch type, hook | bump | pattern_interrupt | goodbye | etc. */
  touch: varchar("touch", { length: 100 }),
  /** Format C: persona × industry angle applied to this email */
  personaAngle: text("personaAngle"),
  /** v2 payload: alternate shorter subject line (Subject Line B) */
  subjectB: text("subjectB"),
  /**
   * Campaign (holding tank) this email was generated under, set once at creation
   * time. Nullable: legacy rows have no campaign. A direct column rather than
   * a join through campaign_memberships, because a contact can belong to more
   * than one campaign, and a pending email must stay tied to the one it was
   * generated under. Queue filtering is then a plain WHERE with no join.
   */
  campaignId: int("campaignId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type OutreachEmail = typeof outreachEmails.$inferSelect;
export type InsertOutreachEmail = typeof outreachEmails.$inferInsert;

// Replies received from prospects
export const replies = mysqlTable("replies", {
  id: int("id").autoincrement().primaryKey(),
  contactId: int("contactId").notNull(),
  subject: text("subject"),
  body: text("body"),
  sentiment: mysqlEnum("sentiment", ["Interested", "Not Now", "Referral", "Negative", "Unclassified"]).default("Unclassified").notNull(),
  receivedAt: timestamp("receivedAt").notNull(),
  acknowledged: boolean("acknowledged").default(false).notNull(),
  /** Stores the Microsoft Graph messageId (or Gmail messageId for legacy gmail path). Column name is historical. */
  gmailMessageId: varchar("gmailMessageId", { length: 200 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Reply = typeof replies.$inferSelect;
export type InsertReply = typeof replies.$inferInsert;

// Phone-call reminders queued for the seller to dial. A human places every call.
export const calls = mysqlTable("calls", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull() /* C1: no default — callers must supply explicit tenantId */,
  contactId: int("contactId").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  accountId: int("accountId").notNull(),
  scheduledFor: timestamp("scheduledFor").notNull(),
  status: mysqlEnum("status", ["Scheduled", "Voicemail", "No Answer", "Spoke", "Meeting Booked", "Skipped"]).default("Scheduled").notNull(),
  source: mysqlEnum("source", ["AfterEmail2", "AfterEmail3", "AfterEmail4", "AfterEmail5", "AfterEmail6", "ReplyTrigger", "Manual"]).notNull(),
  triggerEmailId: int("triggerEmailId"),
  triggerReplyId: int("triggerReplyId"),
  voicemailScript: text("voicemailScript"),
  /** v2 CALL block: one-sentence opening script */
  opening: text("opening"),
  /** v2 CALL block: 30-second value statement */
  valueStatement: text("valueStatement"),
  /** v2 CALL block: objection doubles as JSON array of {trigger, response} */
  objectionDoubles: text("objectionDoubles"),
  notes: text("notes"),
  completedAt: timestamp("completedAt"),
  /** ElevenLabs conversation_id returned by the outbound-call API */
  elevenLabsConversationId: varchar("elevenLabsConversationId", { length: 200 }),
  /** Twilio callSid returned by the outbound-call API */
  elevenLabsCallSid: varchar("elevenLabsCallSid", { length: 200 }),
  /** The phone number that was actually dialed (E.164) */
  dialedPhone: varchar("dialedPhone", { length: 40 }),
  /** Number of dial attempts made for this call record */
  attemptCount: int("attemptCount").default(0).notNull(),
  /** Set false to skip auto-dial for this specific call */
  autoDialEnabled: boolean("autoDialEnabled").default(true).notNull(),
  /** Outcome from ElevenLabs data_collection: 'live_person' | 'voicemail' | 'automated' | 'failed' */
  callOutcome: varchar("callOutcome", { length: 50 }),
  /** When the ElevenLabs post-call webhook was received */
  webhookReceivedAt: timestamp("webhookReceivedAt"),
  /** Campaign (holding tank) this call was generated under. Nullable, see outreach_emails.campaignId. */
  campaignId: int("campaignId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Call = typeof calls.$inferSelect;
export type InsertCall = typeof calls.$inferInsert;

// Stores the Google OAuth refresh token so the server can call Google APIs
// (Gmail, Drive) on a tenant's behalf.
export const googleTokens = mysqlTable("google_tokens", {
  id: int("id").autoincrement().primaryKey(),
  /**
   * Which tenant this Google account belongs to. NULL is the legacy shared
   * token, the one every tenant used before this column existed, and still
   * the fallback for any tenant without its own.
   *
   * Per-tenant tokens exist because a single shared row meant reconnecting
   * Google for one tenant disconnected every other tenant, and two tenants
   * can need to send as different people.
   */
  tenantId: int("tenantId"),
  /** The Google account actually authorized, e.g. seller@example.com. Read back from the API at connect time so the UI can show who it will send as rather than guessing. */
  accountEmail: varchar("accountEmail", { length: 320 }),
  accessToken: text("accessToken").notNull(),
  refreshToken: text("refreshToken").notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  scope: text("scope"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type GoogleToken = typeof googleTokens.$inferSelect;
export type InsertGoogleToken = typeof googleTokens.$inferInsert;

// LinkedIn outreach tasks, connection requests and messages parsed from prospect analysis
export const linkedinTasks = mysqlTable("linkedin_tasks", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull() /* C1: no default — callers must supply explicit tenantId */,
  contactId: int("contactId").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  accountId: int("accountId").notNull(),
  linkedinSearchUrl: text("linkedinSearchUrl"),
  /**
   * Which social channel this task belongs to: 'linkedin' or 'x'.
   *
   * The table keeps its name for compatibility, but it is now the social-touch
   * queue rather than a LinkedIn-only one. Without this column an X touch would
   * surface in the LinkedIn Queue, which is how a rep ends up looking for a
   * connection request that does not exist.
   */
  channel: varchar("channel", { length: 20 }).default("linkedin").notNull(),
  sendDay: int("sendDay").notNull().default(1),
  scheduledDate: timestamp("scheduledDate").notNull(),
  messageType: varchar("messageType", { length: 100 }).notNull().default("Connection Request"),
  messageBody: text("messageBody").notNull(),
  /** Format C: Active | Inactive | Unknown */
  linkedinPresence: varchar("linkedinPresence", { length: 200 }),
  /** Format C: true if this touch is optional due to low LinkedIn activity */
  optional: tinyint("optional").default(0),
  status: mysqlEnum("status", ["Pending", "Sent", "Skipped"]).default("Pending").notNull(),
  /** Campaign (holding tank) this task was generated under. Nullable, see outreach_emails.campaignId. */
  campaignId: int("campaignId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type LinkedinTask = typeof linkedinTasks.$inferSelect;
export type InsertLinkedinTask = typeof linkedinTasks.$inferInsert;

// ─── Tenant infrastructure ──────────────────────────────────────────────────
// Each row represents one client workspace. All config is stored
// as JSON columns, no hardcoding anywhere in the codebase.
export const tenants = mysqlTable("tenants", {
  id: int("id").autoincrement().primaryKey(),
  /** URL-safe slug used in subdomain routing, e.g. "acme" */
  slug: varchar("slug", { length: 64 }).notNull().unique(),
  /** Display name shown in the dashboard header */
  displayName: varchar("displayName", { length: 200 }).notNull(),
  /** Optional subdomain, e.g. "acme.example.com" */
  subdomain: varchar("subdomain", { length: 300 }),
  /** Primary brand colour (hex), e.g. "#1A1A2E" */
  primaryColor: varchar("primaryColor", { length: 20 }).default("#1A1A2E"),
  /** Accent colour (hex), e.g. "#F9A825" */
  accentColor: varchar("accentColor", { length: 20 }).default("#F9A825"),
  /** URL to logo image (object storage) */
  logoUrl: text("logoUrl"),
  /**
   * Email sending method: "resend" (default) or "microsoft_graph".
   * When "microsoft_graph", microsoftOAuthJson must be populated.
   */
  sendingMethod: mysqlEnum("sendingMethod", ["resend", "microsoft_graph", "gmail"]).default("resend").notNull(),
  /** Serialised Microsoft Graph OAuth tokens (encrypted at rest) */
  microsoftOAuthJson: text("microsoftOAuthJson"),
  /** From-address used when sendingMethod = "resend" */
  resendFromAddress: varchar("resendFromAddress", { length: 320 }),
  /**
   * Sequence config JSON, defines the channel mix and cadence for this tenant.
   * Shape: Array<{ channel: 'email'|'linkedin'|'call'|'door_knock', day: number, optional?: boolean }>
   */
  sequenceConfigJson: text("sequenceConfigJson"),
  /**
   * Custom fields JSON, tenant-specific research directives.
   * Shape: Array<{ key: string, label: string, researchDirective: string }>
   * These are passed in the POST body to the analysis engine.
   */
  customFieldsJson: text("customFieldsJson"),
  /** Seller identity, whose name/email/phone appears on outreach emails */
  sellerName: varchar("sellerName", { length: 200 }),
  sellerEmail: varchar("sellerEmail", { length: 320 }),
  sellerPhone: varchar("sellerPhone", { length: 50 }),
  sellerTitle: varchar("sellerTitle", { length: 200 }),
  sellerCalendlyUrl: varchar("sellerCalendlyUrl", { length: 500 }),
  /** URL to seller logo image for email signature */
  sellerLogoUrl: text("sellerLogoUrl"),
  /**
   * Tenant's ICP industries mapped to the current data provider's category taxonomy.
   * Shape: string[], category strings as accepted by the data provider's search API.
   * Set once via the List Builder industry mapping step; reused on every subsequent pull.
   * Provider-agnostic: if the data provider changes, only server/vibeProspecting.ts changes,
   * not this column or any downstream references.
   */
  mappedIndustriesJson: text("mappedIndustriesJson"),
  /** Heartbeat task UID for the reply agent cron job (stored so we can update/delete it) */
  replyAgentTaskUid: varchar("replyAgentTaskUid", { length: 128 }),
  /** Heartbeat task UID for the auto-pilot accept cron job */
  autoPilotAcceptTaskUid: varchar("autoPilotAcceptTaskUid", { length: 128 }),
  /** Heartbeat task UID for the auto-pilot send cron job (legacy, single daily send) */
  autoPilotSendTaskUid: varchar("autoPilotSendTaskUid", { length: 128 }),
  /** Heartbeat task UID for the AM send job (fires after AM accept, sends Day 1 + follow-ups) */
  autoPilotSendAmTaskUid: varchar("autoPilotSendAmTaskUid", { length: 128 }),
  /** Heartbeat task UID for the PM send job (fires after PM accept, sends Day 1 for PM batch) */
  autoPilotSendPmTaskUid: varchar("autoPilotSendPmTaskUid", { length: 128 }),
  /** Heartbeat task UID for the autonomous outbound dialer cron job */
  autoDialTaskUid: varchar("autoDialTaskUid", { length: 128 }),
  /** Heartbeat task UID for the departed-employee check cron job */
  departedCheckTaskUid: varchar("departedCheckTaskUid", { length: 128 }),
  /** Whether auto-pilot is enabled, auto-accept accounts + auto-send emails without manual approval */
  autoPilot: boolean("autoPilot").default(false).notNull(),
  /** Number of new accounts to accept per batch when auto-pilot is on (default 10) */
  dailyNewAccountLimit: int("dailyNewAccountLimit").default(10).notNull(),
  /** Whether this tenant is active */
  active: boolean("active").default(true).notNull(),
  /**
   * H3 (2026-07): Whether the AI reply agent is allowed to auto-respond for this tenant.
   * Default false. Set to true explicitly for tenants that have opted in.
   * The replyAgent.ts handler checks this before sending any auto-reply.
   */
  autoReplyEnabled: boolean("autoReplyEnabled").default(false).notNull(),
  /** Whether the customer has completed the onboarding wizard */
  onboardingCompleted: boolean("onboardingCompleted").default(false).notNull(),
  /** Raw wizard answers stored as JSON while onboarding is in progress */
  wizardData: text("wizardData"),
  /** Generated YAML config for the Cloud Run agent */
  tenantConfigYaml: text("tenantConfigYaml"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Tenant = typeof tenants.$inferSelect;
export type InsertTenant = typeof tenants.$inferInsert;

// ─── Campaigns (Holding Tanks) ──────────────────────────────────────────────
// A campaign is a holding tank beneath a tenant. One tenant (one sending
// identity) can run several campaigns, each with its own list, sequence and
// cadence.
export const campaigns = mysqlTable(
  "campaigns",
  {
    id: int("id").autoincrement().primaryKey(),
    tenantId: int("tenantId").notNull() /* C1: no default — callers must supply explicit tenantId, same discipline as accounts/contacts */,
    /** URL-safe slug, unique per tenant, e.g. "q3-renewals", "new-logo" */
    slug: varchar("slug", { length: 64 }).notNull(),
    /** Display name shown in the UI, e.g. "Q3 Renewals" */
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description"),
    /**
     * Campaign-scoped copy/positioning. Points at an existing productProfiles
     * row (see design doc §2, no new copy-storage table needed). NULL falls
     * back to the tenant's default product profile at generation time.
     */
    productProfileId: int("productProfileId"),
    /**
     * Campaign-level override of tenant.sequenceConfigJson (channel mix/cadence).
     * NULL = inherit the tenant's sequence config unchanged.
     */
    sequenceConfigJsonOverride: text("sequenceConfigJsonOverride"),
    /**
     * Campaign-level override of tenant.customFieldsJson (research directives).
     * NULL = inherit the tenant's custom fields unchanged.
     */
    customFieldsJsonOverride: text("customFieldsJsonOverride"),
    /**
     * AUTOPILOT, hard requirement: every campaign is created with this false,
     * and the column has no other default anywhere in the codebase. See §6 of
     * the design doc for the arming guardrail; this column alone is not the
     * guardrail, campaigns.arm (server/routers/campaignsRouter.ts) is the only
     * code path allowed to write true.
     */
    autoPilot: boolean("autoPilot").default(false).notNull(),
    /** Set only by the explicit arm mutation, null means "never armed". Audit trail. */
    autoPilotArmedAt: timestamp("autoPilotArmedAt"),
    autoPilotArmedByEmail: varchar("autoPilotArmedByEmail", { length: 320 }),
    /**
     * Circuit breaker, set true when an inbound bounce event finds this
     * campaign's bounce rate
     * among sent emails over 30% (subject to a minimum sample size, see
     * computeCircuitBreakerTrip). A brake, not an engine: tripping this flag
     * never sends or unsends anything by itself, listPendingEmailsDue()
     * (server/db.ts) excludes a broken campaign's Pending emails from both
     * auto-send and the Approval Queue list until a human clears it.
     */
    bounceCircuitBroken: boolean("bounceCircuitBroken").default(false).notNull(),
    /** Set only when the breaker trips; cleared back to null when a human resets it. Audit trail. */
    bounceCircuitTrippedAt: timestamp("bounceCircuitTrippedAt"),
    active: boolean("active").default(true).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [uniqueIndex("campaigns_tenant_slug_unique").on(table.tenantId, table.slug)],
);

export type Campaign = typeof campaigns.$inferSelect;
export type InsertCampaign = typeof campaigns.$inferInsert;

// Contact-level many-to-many junction between campaigns and contacts. Deliberately
// NOT account-level, a company can have some contacts in one tank and other
// contacts in a different tank (design doc §1.2).
export const campaignMemberships = mysqlTable(
  "campaign_memberships",
  {
    id: int("id").autoincrement().primaryKey(),
    campaignId: int("campaignId").notNull(), // FK campaigns.id
    tenantId: int("tenantId").notNull(), // denormalized, must equal campaigns.tenantId, cheap sanity check + avoids a join for tenant-scoped queries
    accountId: int("accountId").notNull(), // FK accounts.id, denormalized from contact for account-level rollups without an extra join
    contactId: int("contactId").notNull(), // FK contacts.id, the actual membership key
    addedAt: timestamp("addedAt").defaultNow().notNull(),
    /** Where this membership came from, 'list_builder' | 'bulk_upload' | 'add_account' | 'manual' | 'migration' */
    addedVia: varchar("addedVia", { length: 50 }).notNull(),
    addedByEmail: varchar("addedByEmail", { length: 320 }),
  },
  (table) => [
    // A contact can't be double-added to the same tank, but CAN have separate
    // rows for two different campaignIds (the multi-tank case).
    uniqueIndex("campaign_memberships_campaign_contact_unique").on(table.campaignId, table.contactId),
    index("campaign_memberships_campaign_idx").on(table.campaignId),
    index("campaign_memberships_contact_idx").on(table.contactId),
    index("campaign_memberships_account_idx").on(table.accountId),
  ],
);

export type CampaignMembership = typeof campaignMemberships.$inferSelect;
export type InsertCampaignMembership = typeof campaignMemberships.$inferInsert;
