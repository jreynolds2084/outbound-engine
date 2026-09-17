/**
 * microsoftGraph.test.ts
 * Covers buildGraphMimeMessage and the List-Unsubscribe wiring in
 * sendViaGraph. Graph's JSON message object (internetMessageHeaders) rejects
 * any header not prefixed "x-"/"X-", which rules out List-Unsubscribe and
 * List-Unsubscribe-Post by name, confirmed against Microsoft Graph docs/
 * forum reports, 2026-08. The raw-MIME create path (documented at
 * learn.microsoft.com/en-us/graph/outlook-send-mime-message) is the
 * workaround: POST /me/messages with Content-Type: text/plain and a
 * base64-encoded RFC 2822 message preserves arbitrary headers untouched.
 *
 * This is NOT verified against a live Microsoft mailbox, no Graph-connected
 * tenant credential is available in this environment. These tests confirm
 * the code builds the documented request shape; they do not confirm Graph's
 * production behaviour actually honours it end to end.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  tenantRow: null as null | { microsoftOAuthJson: string },
}));

vi.mock("./db", () => ({
  getDb: async () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (h.tenantRow ? [h.tenantRow] : []),
        }),
      }),
    }),
  }),
}));

import { buildGraphMimeMessage, sendViaGraph, getOrCreateMailFolderId, moveGraphMessage, _resetMailFolderCacheForTests } from "./microsoftGraph";

function decodeBase64(s: string): string {
  return Buffer.from(s, "base64").toString("utf-8");
}

beforeEach(() => {
  h.tenantRow = {
    microsoftOAuthJson: JSON.stringify({
      access_token: "test-access-token",
      refresh_token: "test-refresh-token",
      expires_at: Date.now() + 60 * 60 * 1000, // 1hr out, no refresh branch triggered
    }),
  };
  _resetMailFolderCacheForTests();
});

describe("buildGraphMimeMessage", () => {
  it("omits List-Unsubscribe headers when no URL is supplied", () => {
    const mime = buildGraphMimeMessage({ to: "a@b.test", subject: "Hi", html: "<p>Body</p>" });
    expect(mime).not.toContain("List-Unsubscribe");
  });

  it("includes both headers with the exact RFC 8058 one-click value when a URL is supplied", () => {
    const mime = buildGraphMimeMessage({
      to: "a@b.test",
      subject: "Hi",
      html: "<p>Body</p>",
      listUnsubscribeUrl: "https://app.example.com/api/unsubscribe/TOKEN",
    });
    expect(mime).toContain("List-Unsubscribe: <https://app.example.com/api/unsubscribe/TOKEN>");
    expect(mime).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  });

  it("carries To/Subject and a multipart/alternative body with both a plain and an html part", () => {
    const mime = buildGraphMimeMessage({ to: "a@b.test", subject: "Test Subject", html: "<p>Hello</p>" });
    expect(mime).toContain("To: a@b.test");
    expect(mime).toContain("Subject: Test Subject");
    expect(mime).toContain("Content-Type: multipart/alternative");
    expect(mime).toContain("Content-Type: text/html");
    expect(mime).toContain("Content-Type: text/plain");
    expect(mime).toContain("<p>Hello</p>");
  });
});

describe("sendViaGraph", () => {
  it("creates the draft via raw MIME (text/plain, base64 body) when listUnsubscribeUrl is set", async () => {
    let createCall: { url: string; init: Record<string, unknown> } | null = null;
    let sendCall: { url: string; init: Record<string, unknown> } | null = null;
    let callCount = 0;
    global.fetch = vi.fn(async (url: unknown, init: unknown) => {
      callCount++;
      if (callCount === 1) {
        createCall = { url: url as string, init: init as Record<string, unknown> };
        return { ok: true, json: async () => ({ id: "draft-1", conversationId: "conv-1" }) } as unknown as Response;
      }
      sendCall = { url: url as string, init: init as Record<string, unknown> };
      return { ok: true, text: async () => "" } as unknown as Response;
    }) as unknown as typeof fetch;

    const result = await sendViaGraph({
      tenantSlug: "ob",
      to: "prospect@acme.test",
      subject: "Hello",
      html: "<p>Hi</p>",
      listUnsubscribeUrl: "https://app.example.com/api/unsubscribe/TOKEN",
    });

    expect(result).toEqual({ messageId: "draft-1", conversationId: "conv-1" });
    expect(createCall).not.toBeNull();
    expect(createCall!.url).toBe("https://graph.microsoft.com/v1.0/me/messages");
    expect((createCall!.init.headers as Record<string, string>)["Content-Type"]).toBe("text/plain");
    const decodedBody = decodeBase64(createCall!.init.body as string);
    expect(decodedBody).toContain("List-Unsubscribe: <https://app.example.com/api/unsubscribe/TOKEN>");
    expect(decodedBody).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    expect(sendCall!.url).toBe("https://graph.microsoft.com/v1.0/me/messages/draft-1/send");
  });

  it("creates the draft via the plain JSON object when listUnsubscribeUrl is omitted (unchanged behaviour)", async () => {
    let createCall: { url: string; init: Record<string, unknown> } | null = null;
    let callCount = 0;
    global.fetch = vi.fn(async (url: unknown, init: unknown) => {
      callCount++;
      if (callCount === 1) {
        createCall = { url: url as string, init: init as Record<string, unknown> };
        return { ok: true, json: async () => ({ id: "draft-2", conversationId: "conv-2" }) } as unknown as Response;
      }
      return { ok: true, text: async () => "" } as unknown as Response;
    }) as unknown as typeof fetch;

    await sendViaGraph({ tenantSlug: "ob", to: "prospect@acme.test", subject: "Hello", html: "<p>Hi</p>" });

    expect((createCall!.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    const parsed = JSON.parse(createCall!.init.body as string) as {
      subject: string;
      toRecipients: Array<{ emailAddress: { address: string } }>;
    };
    expect(parsed.subject).toBe("Hello");
    expect(parsed.toRecipients[0].emailAddress.address).toBe("prospect@acme.test");
  });
});

describe("getOrCreateMailFolderId", () => {
  it("returns the existing folder's id without creating a new one when the lookup finds it", async () => {
    const calls: string[] = [];
    global.fetch = vi.fn(async (url: unknown) => {
      calls.push(url as string);
      return {
        ok: true,
        json: async () => ({ value: [{ id: "folder-existing", displayName: "OB Feedback" }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const id = await getOrCreateMailFolderId("ob", "OB Feedback");

    expect(id).toBe("folder-existing");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/me/mailFolders?");
    expect(calls[0]).toContain(encodeURIComponent("displayName eq 'OB Feedback'"));
  });

  it("creates the folder when the lookup finds nothing", async () => {
    const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
    global.fetch = vi.fn(async (url: unknown, init: unknown) => {
      calls.push({ url: url as string, init: (init ?? {}) as Record<string, unknown> });
      if (calls.length === 1) {
        return { ok: true, json: async () => ({ value: [] }) } as unknown as Response;
      }
      return { ok: true, json: async () => ({ id: "folder-new" }) } as unknown as Response;
    }) as unknown as typeof fetch;

    const id = await getOrCreateMailFolderId("ob", "OB Feedback");

    expect(id).toBe("folder-new");
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe("https://graph.microsoft.com/v1.0/me/mailFolders");
    expect(calls[1].init.method).toBe("POST");
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ displayName: "OB Feedback" });
  });

  it("resolves once and reuses the cached id on a second call, no second Graph round trip", async () => {
    let fetchCount = 0;
    global.fetch = vi.fn(async () => {
      fetchCount++;
      return { ok: true, json: async () => ({ value: [{ id: "folder-cached", displayName: "OB Feedback" }] }) } as unknown as Response;
    }) as unknown as typeof fetch;

    const first = await getOrCreateMailFolderId("ob", "OB Feedback");
    const second = await getOrCreateMailFolderId("ob", "OB Feedback");

    expect(first).toBe("folder-cached");
    expect(second).toBe("folder-cached");
    expect(fetchCount).toBe(1);
  });

  it("throws when the lookup request fails", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, text: async () => "boom" } as unknown as Response)) as unknown as typeof fetch;
    await expect(getOrCreateMailFolderId("ob", "OB Feedback")).rejects.toThrow(/mail folder lookup failed/);
  });
});

describe("moveGraphMessage", () => {
  it("POSTs to /me/messages/{id}/move with the destination folder id", async () => {
    let call: { url: string; init: Record<string, unknown> } | null = null;
    global.fetch = vi.fn(async (url: unknown, init: unknown) => {
      call = { url: url as string, init: init as Record<string, unknown> };
      return { ok: true, text: async () => "" } as unknown as Response;
    }) as unknown as typeof fetch;

    await moveGraphMessage("ob", "msg-1", "folder-1");

    expect(call).not.toBeNull();
    expect(call!.url).toBe("https://graph.microsoft.com/v1.0/me/messages/msg-1/move");
    expect(call!.init.method).toBe("POST");
    expect(JSON.parse(call!.init.body as string)).toEqual({ destinationId: "folder-1" });
  });

  it("throws (never silently no-ops) when Graph rejects the move", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, text: async () => "not found" } as unknown as Response)) as unknown as typeof fetch;
    await expect(moveGraphMessage("ob", "msg-1", "folder-1")).rejects.toThrow(/move message failed/);
  });
});
