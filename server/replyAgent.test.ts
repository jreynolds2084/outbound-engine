/**
 * replyAgent.test.ts
 * Behavioral tests for the reply agent's CASL branches using a fake drizzle
 * db and mocked Graph / LLM / notification modules.
 *
 * Invariants under test:
 *   - Tier-1 opt-out → contact suppressed in a transaction, ALL pending
 *     touches cancelled, bilingual confirmation sent, no pitch generated.
 *   - Tier-2 "Negative"/"Opt-Out" → same suppression path.
 *   - Referral → human review (acknowledged=false), no suppression, no send.
 *   - LLM classifier failure → human review, nothing auto-sent.
 *   - gmailMessageId guard → already-processed messages are skipped entirely.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";
import {
  calls,
  contacts,
  linkedinTasks,
  outreachEmails,
  replies,
  tenants,
  accounts,
} from "../drizzle/schema";

// ─── Hoisted mock state ──────────────────────────────────────────────────────

const h = vi.hoisted(() => {
  const state = {
    db: null as unknown,
    pollResult: [] as unknown[],
    pollCalls: [] as unknown[],
    graphReplies: [] as Array<Record<string, unknown>>,
    sendGraphReplyError: null as Error | null,
    llmCalls: [] as Array<Record<string, unknown>>,
    llmImpl: null as null | ((params: Record<string, unknown>) => Promise<unknown>),
    notifications: [] as Array<Record<string, unknown>>,
    statusUpdates: [] as Array<{ contactId: number; patch: Record<string, unknown> }>,
  };
  return state;
});

vi.mock("./db", () => ({
  getDb: async () => h.db,
  updateContactStatus: async (contactId: number, patch: Record<string, unknown>) => {
    h.statusUpdates.push({ contactId, patch });
  },
}));

vi.mock("./microsoftGraph", () => ({
  pollGraphInbox: async (...args: unknown[]) => {
    h.pollCalls.push(args);
    return h.pollResult;
  },
  sendGraphReply: async (params: Record<string, unknown>) => {
    if (h.sendGraphReplyError) throw h.sendGraphReplyError;
    h.graphReplies.push(params);
  },
}));

vi.mock("./_core/llm", () => ({
  invokeLLM: async (params: Record<string, unknown>) => {
    h.llmCalls.push(params);
    if (!h.llmImpl) throw new Error("invokeLLM mock not configured");
    return h.llmImpl(params);
  },
}));

vi.mock("./_core/notification", () => ({
  notifyOwner: async (params: Record<string, unknown>) => {
    h.notifications.push(params);
  },
}));

import { runReplyAgent, suppressContact, cascadeReplyStop } from "./replyAgent";

// ─── Fake drizzle db ─────────────────────────────────────────────────────────

type FakeDb = {
  select: (...args: unknown[]) => unknown;
  update: (table: unknown) => unknown;
  insert: (table: unknown) => unknown;
  transaction: (fn: (tx: unknown) => Promise<void>) => Promise<void>;
  __updates: Array<{ table: unknown; set: Record<string, unknown>; inTx: boolean }>;
  __inserts: Array<{ table: unknown; values: Record<string, unknown> }>;
  __txCount: number;
};

/**
 * Minimal chainable stand-in for the drizzle mysql2 client.
 * Select results are keyed by the schema table object passed to .from().
 */
function createFakeDb(resultsByTable: Map<unknown, unknown[] | (() => unknown[])>): FakeDb {
  const updates: FakeDb["__updates"] = [];
  const inserts: FakeDb["__inserts"] = [];
  const db: Partial<FakeDb> & Record<string, unknown> = {};

  const makeSelectChain = () => {
    let table: unknown = null;
    const chain: Record<string, unknown> = {};
    const passthrough = ["where", "limit", "orderBy", "innerJoin", "leftJoin", "for"];
    chain.from = (t: unknown) => {
      table = t;
      return chain;
    };
    for (const m of passthrough) {
      chain[m] = () => chain;
    }
    chain.then = (resolve: (rows: unknown[]) => unknown, reject: (err: unknown) => unknown) => {
      const entry = resultsByTable.get(table);
      const rows = typeof entry === "function" ? entry() : (entry ?? []);
      return Promise.resolve(rows).then(resolve, reject);
    };
    return chain;
  };

  const makeUpdateChain = (table: unknown, inTx: boolean) => {
    const record = { table, set: {} as Record<string, unknown>, inTx };
    const chain: Record<string, unknown> = {};
    chain.set = (patch: Record<string, unknown>) => {
      record.set = patch;
      return chain;
    };
    chain.where = () => {
      updates.push(record);
      return chain;
    };
    chain.then = (resolve: (v: unknown) => unknown, reject: (err: unknown) => unknown) =>
      Promise.resolve(undefined).then(resolve, reject);
    return chain;
  };

  const makeInsertChain = (table: unknown) => {
    const chain: Record<string, unknown> = {};
    chain.values = (values: Record<string, unknown>) => {
      inserts.push({ table, values });
      return chain;
    };
    chain.$returningId = () => Promise.resolve([{ id: 1 }]);
    chain.then = (resolve: (v: unknown) => unknown, reject: (err: unknown) => unknown) =>
      Promise.resolve(undefined).then(resolve, reject);
    return chain;
  };

  db.select = () => makeSelectChain();
  db.update = (table: unknown) => makeUpdateChain(table, false);
  db.insert = (table: unknown) => makeInsertChain(table);
  db.__txCount = 0;
  db.transaction = async (fn: (tx: unknown) => Promise<void>) => {
    (db.__txCount as number)++;
    const tx = {
      select: () => makeSelectChain(),
      update: (table: unknown) => makeUpdateChain(table, true),
      insert: (table: unknown) => makeInsertChain(table),
    };
    await fn(tx);
  };
  db.__updates = updates;
  db.__inserts = inserts;

  return db as FakeDb;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TENANT = {
  id: 1,
  slug: "ob",
  microsoftOAuthJson: '{"access_token":"x"}',
  sellerCalendlyUrl: "https://calendly.com/sam-seller/30min",
};

const CONTACT = {
  id: 42,
  tenantId: 1,
  accountId: 7,
  name: "Jane Prospect",
  email: "jane@prospectco.test",
  role: "VP Ops",
  optedOut: false,
};

const ACCOUNT = { id: 7, name: "Prospect Co", industry: "Logistics" };

function makeMessage(bodyText: string): Record<string, unknown> {
  return {
    messageId: "msg-1",
    conversationId: "conv-1",
    subject: "Re: quick question",
    fromAddress: "jane@prospectco.test",
    bodyPreview: bodyText.slice(0, 100),
    bodyText,
    receivedAt: new Date().toISOString(),
  };
}

function standardResults(overrides?: {
  contact?: Record<string, unknown>;
  existingReplies?: unknown[];
}): Map<unknown, unknown[] | (() => unknown[])> {
  return new Map<unknown, unknown[] | (() => unknown[])>([
    [tenants, [TENANT]],
    [outreachEmails, [{ contactId: CONTACT.id, conversationId: "conv-1" }]],
    [contacts, [overrides?.contact ?? CONTACT]],
    [replies, overrides?.existingReplies ?? []],
    [accounts, [ACCOUNT]],
  ]);
}

function updatesFor(db: FakeDb, table: unknown) {
  return db.__updates.filter((u) => u.table === table);
}

function insertsFor(db: FakeDb, table: unknown) {
  return db.__inserts.filter((i) => i.table === table);
}

beforeEach(() => {
  h.db = null;
  h.pollResult = [];
  h.pollCalls = [];
  h.graphReplies = [];
  h.sendGraphReplyError = null;
  h.llmCalls = [];
  h.llmImpl = null;
  h.notifications = [];
  h.statusUpdates = [];
});

// ─── Tier-1 opt-out: suppression side effects ───────────────────────────────

describe("runReplyAgent, Tier-1 opt-out suppression", () => {
  it("suppresses the contact and cancels every pending touch in one transaction", async () => {
    const db = createFakeDb(standardResults());
    h.db = db;
    h.pollResult = [makeMessage("Not interested. Please remove me.")];

    await runReplyAgent("ob");

    // One transaction wrapping the whole suppression
    expect(db.__txCount).toBe(1);

    // Contact flagged
    const contactUpdates = updatesFor(db, contacts);
    expect(contactUpdates).toHaveLength(1);
    expect(contactUpdates[0].inTx).toBe(true);
    expect(contactUpdates[0].set.optedOut).toBe(true);
    expect(contactUpdates[0].set.optedOutAt).toBeInstanceOf(Date);
    expect(contactUpdates[0].set.status).toBe("Unreachable");

    // Pending emails, scheduled calls, pending LinkedIn tasks all terminal
    const emailUpdates = updatesFor(db, outreachEmails);
    expect(emailUpdates).toHaveLength(1);
    expect(emailUpdates[0].inTx).toBe(true);
    expect(emailUpdates[0].set.status).toBe("Skipped");

    const callUpdates = updatesFor(db, calls);
    expect(callUpdates).toHaveLength(1);
    expect(callUpdates[0].inTx).toBe(true);
    expect(callUpdates[0].set.status).toBe("Skipped");

    const liUpdates = updatesFor(db, linkedinTasks);
    expect(liUpdates).toHaveLength(1);
    expect(liUpdates[0].inTx).toBe(true);
    expect(liUpdates[0].set.status).toBe("Skipped");
  });

  it("sends the bilingual confirmation and never invokes the LLM", async () => {
    const db = createFakeDb(standardResults());
    h.db = db;
    h.pollResult = [makeMessage("unsubscribe")];

    await runReplyAgent("ob");

    // No LLM call at all, no classification, no generated pitch
    expect(h.llmCalls).toHaveLength(0);

    // Exactly one outbound message: the opt-out confirmation
    expect(h.graphReplies).toHaveLength(1);
    const confirmation = h.graphReplies[0];
    expect(String(confirmation.subject)).toContain("Removed from our list");
    expect(String(confirmation.subject)).toContain("Retiré de notre liste");
    expect(String(confirmation.body)).toContain("removed from our outreach list");
    expect(String(confirmation.body)).toContain("Vous avez été retiré");
    // No Calendly pitch in an opt-out confirmation
    expect(String(confirmation.body)).not.toContain("calendly");
  });

  it("records the reply as processed (gmailMessageId set, acknowledged)", async () => {
    const db = createFakeDb(standardResults());
    h.db = db;
    h.pollResult = [makeMessage("Stop.")];

    await runReplyAgent("ob");

    const replyInserts = insertsFor(db, replies);
    expect(replyInserts).toHaveLength(1);
    expect(replyInserts[0].values.gmailMessageId).toBe("msg-1");
    expect(replyInserts[0].values.acknowledged).toBe(true);
    // TODO(schema): stored as "Negative" until an "Opt-Out" enum value exists
    expect(replyInserts[0].values.sentiment).toBe("Negative");
  });

  it("French opt-out follows the same suppression path", async () => {
    const db = createFakeDb(standardResults());
    h.db = db;
    h.pollResult = [makeMessage("Pas intéressé, retirez-moi de votre liste.")];

    await runReplyAgent("ob");

    expect(db.__txCount).toBe(1);
    expect(updatesFor(db, contacts)[0].set.optedOut).toBe(true);
    expect(h.llmCalls).toHaveLength(0);
    expect(h.graphReplies).toHaveLength(1);
  });
});

// ─── Tier-2 LLM backstop ─────────────────────────────────────────────────────

describe("runReplyAgent, Tier-2 LLM backstop", () => {
  it("treats an LLM 'Negative' as opt-out-equivalent (suppress, confirm, no pitch)", async () => {
    const db = createFakeDb(standardResults());
    h.db = db;
    h.pollResult = [makeMessage("Honestly this is a waste of my inbox space.")];
    h.llmImpl = async () => ({
      choices: [{ message: { content: "Negative" } }],
    });

    await runReplyAgent("ob");

    // One LLM call (classification), and no second call for a pitch
    expect(h.llmCalls).toHaveLength(1);
    expect(db.__txCount).toBe(1);
    expect(updatesFor(db, contacts)[0].set.optedOut).toBe(true);
    expect(h.graphReplies).toHaveLength(1);
    expect(String(h.graphReplies[0].subject)).toContain("Removed from our list");
  });

  it("treats an LLM 'Opt-Out' as an opt-out", async () => {
    const db = createFakeDb(standardResults());
    h.db = db;
    h.pollResult = [makeMessage("Some phrasing the regexes do not cover.")];
    h.llmImpl = async () => ({
      choices: [{ message: { content: "Opt-Out" } }],
    });

    await runReplyAgent("ob");

    expect(db.__txCount).toBe(1);
    expect(updatesFor(db, contacts)[0].set.optedOut).toBe(true);
    expect(h.graphReplies).toHaveLength(1);
  });

  it("routes to human review when the LLM call throws, nothing auto-sent", async () => {
    const db = createFakeDb(standardResults());
    h.db = db;
    h.pollResult = [makeMessage("Hmm, tell me more maybe?")];
    h.llmImpl = async () => {
      throw new Error("LLM unavailable");
    };

    await runReplyAgent("ob");

    // No pitch, no opt-out suppression, but routeToHumanReview still
    // cascades a reply-stop (the contact is not opted out, contacts table
    // itself is untouched here since status goes through updateContactStatus).
    expect(h.graphReplies).toHaveLength(0);
    expect(db.__txCount).toBe(1);
    expect(updatesFor(db, contacts)).toHaveLength(0);
    expect(updatesFor(db, outreachEmails)[0].set.status).toBe("Skipped");
    expect(updatesFor(db, calls)[0].set.status).toBe("Skipped");
    expect(updatesFor(db, linkedinTasks)[0].set.status).toBe("Skipped");
    expect(h.statusUpdates).toContainEqual({ contactId: 42, patch: { status: "Replied" } });

    // Reply recorded for human review
    const replyInserts = insertsFor(db, replies);
    expect(replyInserts).toHaveLength(1);
    expect(replyInserts[0].values.acknowledged).toBe(false);
    expect(replyInserts[0].values.sentiment).toBe("Unclassified");
  });

  it("auto-replies with the Calendly pitch for 'Interested'", async () => {
    const db = createFakeDb(standardResults());
    h.db = db;
    h.pollResult = [makeMessage("This could be useful, how does it work?")];
    let call = 0;
    h.llmImpl = async () => {
      call++;
      if (call === 1) return { choices: [{ message: { content: "Interested" } }] };
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({ subject: "Re: quick question", body: "Great. Book here." }),
            },
          },
        ],
      };
    };

    await runReplyAgent("ob");

    expect(h.llmCalls).toHaveLength(2); // classify + generate
    // No opt-out suppression, but the reply-cascade fix means the auto-pitch
    // branch still stops the automated sequence, the pitch is a one-off
    // reply, not permission for the cadence to keep firing.
    expect(db.__txCount).toBe(1);
    expect(updatesFor(db, contacts)).toHaveLength(0); // not opted out / not Unreachable
    expect(updatesFor(db, outreachEmails)[0].set.status).toBe("Skipped");
    expect(updatesFor(db, calls)[0].set.status).toBe("Skipped");
    expect(updatesFor(db, linkedinTasks)[0].set.status).toBe("Skipped");
    expect(h.statusUpdates).toContainEqual({ contactId: 42, patch: { status: "Replied" } });
    expect(h.graphReplies).toHaveLength(1);
    expect(h.graphReplies[0].body).toBe("Great. Book here.");
    const replyInserts = insertsFor(db, replies);
    expect(replyInserts).toHaveLength(1);
    expect(replyInserts[0].values.sentiment).toBe("Interested");
    expect(replyInserts[0].values.acknowledged).toBe(true);
  });
});

// ─── Referral / NotNow routing ───────────────────────────────────────────────

describe("runReplyAgent, Referral and NotNow routing", () => {
  it("Tier-1 Referral: no opt-out suppression, no auto-pitch, cascade stops the sequence, flagged for review", async () => {
    const db = createFakeDb(standardResults());
    h.db = db;
    h.pollResult = [makeMessage("I'm not the right person, talk to Dave.")];

    await runReplyAgent("ob");

    // Not opted out (contacts table untouched directly; status flows through
    // the mocked updateContactStatus instead), but the reply is still
    // terminal for automation, the cascade transaction fires.
    expect(db.__txCount).toBe(1);
    expect(updatesFor(db, contacts)).toHaveLength(0);
    expect(updatesFor(db, outreachEmails)[0].set.status).toBe("Skipped");
    expect(updatesFor(db, calls)[0].set.status).toBe("Skipped");
    expect(updatesFor(db, linkedinTasks)[0].set.status).toBe("Skipped");
    expect(h.statusUpdates).toContainEqual({ contactId: 42, patch: { status: "Replied" } });
    expect(h.graphReplies).toHaveLength(0);
    expect(h.llmCalls).toHaveLength(0);

    const replyInserts = insertsFor(db, replies);
    expect(replyInserts).toHaveLength(1);
    expect(replyInserts[0].values.sentiment).toBe("Referral");
    expect(replyInserts[0].values.acknowledged).toBe(false);
  });

  it("Tier-1 NotNow (time-qualified deferral): review, not suppression, cascade stops the sequence, not pitch", async () => {
    const db = createFakeDb(standardResults());
    h.db = db;
    h.pollResult = [makeMessage("Not right now, check back in Q1.")];

    await runReplyAgent("ob");

    expect(db.__txCount).toBe(1);
    expect(updatesFor(db, contacts)).toHaveLength(0);
    expect(updatesFor(db, outreachEmails)[0].set.status).toBe("Skipped");
    expect(updatesFor(db, calls)[0].set.status).toBe("Skipped");
    expect(updatesFor(db, linkedinTasks)[0].set.status).toBe("Skipped");
    expect(h.statusUpdates).toContainEqual({ contactId: 42, patch: { status: "Replied" } });
    expect(h.graphReplies).toHaveLength(0);
    expect(h.llmCalls).toHaveLength(0);

    const replyInserts = insertsFor(db, replies);
    expect(replyInserts).toHaveLength(1);
    expect(replyInserts[0].values.sentiment).toBe("Not Now");
    expect(replyInserts[0].values.acknowledged).toBe(false);
  });
});

// ─── Idempotency and skip guards ─────────────────────────────────────────────

describe("runReplyAgent, guards", () => {
  it("gmailMessageId guard: an already-processed message is skipped entirely", async () => {
    const db = createFakeDb(
      standardResults({ existingReplies: [{ id: 99 }] }),
    );
    h.db = db;
    h.pollResult = [makeMessage("unsubscribe")];

    await runReplyAgent("ob");

    expect(db.__txCount).toBe(0);
    expect(db.__updates).toHaveLength(0);
    expect(db.__inserts).toHaveLength(0);
    expect(h.graphReplies).toHaveLength(0);
    expect(h.llmCalls).toHaveLength(0);
  });

  it("already-opted-out contacts are never processed again", async () => {
    const db = createFakeDb(
      standardResults({ contact: { ...CONTACT, optedOut: true } }),
    );
    h.db = db;
    h.pollResult = [makeMessage("unsubscribe")];

    await runReplyAgent("ob");

    expect(db.__txCount).toBe(0);
    expect(db.__inserts).toHaveLength(0);
    expect(h.graphReplies).toHaveLength(0);
  });
});

// ─── suppressContact direct ──────────────────────────────────────────────────

describe("suppressContact", () => {
  it("wraps the contact flag and all three touch cancellations in a transaction", async () => {
    const db = createFakeDb(new Map());
    h.db = db;

    await suppressContact(42);

    expect(db.__txCount).toBe(1);
    expect(db.__updates).toHaveLength(4);
    expect(db.__updates.every((u) => u.inTx)).toBe(true);
    const tablesTouched = new Set(db.__updates.map((u) => u.table));
    expect(tablesTouched.has(contacts)).toBe(true);
    expect(tablesTouched.has(outreachEmails)).toBe(true);
    expect(tablesTouched.has(calls)).toBe(true);
    expect(tablesTouched.has(linkedinTasks)).toBe(true);
  });
});

// ─── cascadeReplyStop direct ─────────────────────────────────────────────────

describe("cascadeReplyStop", () => {
  it("cancels pending touches on all three channels in a transaction, matching suppressContact's reach", async () => {
    const db = createFakeDb(new Map());
    h.db = db;

    await cascadeReplyStop(42);

    expect(db.__txCount).toBe(1);
    expect(db.__updates.every((u) => u.inTx)).toBe(true);
    const tablesTouched = new Set(db.__updates.map((u) => u.table));
    expect(tablesTouched.has(outreachEmails)).toBe(true);
    expect(tablesTouched.has(calls)).toBe(true);
    expect(tablesTouched.has(linkedinTasks)).toBe(true);

    const emailUpdate = updatesFor(db, outreachEmails)[0];
    expect(emailUpdate.set.status).toBe("Skipped");
    const callUpdate = updatesFor(db, calls)[0];
    expect(callUpdate.set.status).toBe("Skipped");
    const liUpdate = updatesFor(db, linkedinTasks)[0];
    expect(liUpdate.set.status).toBe("Skipped");
  });

  it("never touches the contacts table, distinct from suppressContact's permanence", async () => {
    const db = createFakeDb(new Map());
    h.db = db;

    await cascadeReplyStop(42);

    // No optedOut, no status="Unreachable", a plain reply is terminal for
    // the sequence only, never for the contact itself.
    expect(updatesFor(db, contacts)).toHaveLength(0);
  });
});
