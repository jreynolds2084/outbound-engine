import { TRPCError } from "@trpc/server";
import { ENV } from "./env";

export type NotificationPayload = {
  title: string;
  content: string;
};

const TITLE_MAX_LENGTH = 1200;
const CONTENT_MAX_LENGTH = 20000;

const trimValue = (value: string): string => value.trim();
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const buildEndpointUrl = (baseUrl: string): string => {
  const normalizedBase = baseUrl.endsWith("/")
    ? baseUrl
    : `${baseUrl}/`;
  return new URL(
    "webdevtoken.v1.WebDevService/SendNotification",
    normalizedBase
  ).toString();
};

const validatePayload = (input: NotificationPayload): NotificationPayload => {
  if (!isNonEmptyString(input.title)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Notification title is required.",
    });
  }
  if (!isNonEmptyString(input.content)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Notification content is required.",
    });
  }

  const title = trimValue(input.title);
  const content = trimValue(input.content);

  if (title.length > TITLE_MAX_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Notification title must be at most ${TITLE_MAX_LENGTH} characters.`,
    });
  }

  if (content.length > CONTENT_MAX_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Notification content must be at most ${CONTENT_MAX_LENGTH} characters.`,
    });
  }

  return { title, content };
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/**
 * Dispatches an owner notification by email via Resend.
 *
 * Returns `true` when accepted and `false` when the transport is unreachable
 * (callers treat notifications as best-effort), and throws TRPCError on an
 * invalid payload.
 *
 * Set OWNER_NOTIFICATION_EMAIL to control the recipient.
 */
export async function notifyOwner(
  payload: NotificationPayload
): Promise<boolean> {
  const { title, content } = validatePayload(payload);

  const to = process.env.OWNER_NOTIFICATION_EMAIL ?? "owner@example.com";
  const from = process.env.OWNER_NOTIFICATION_FROM ?? "noreply@example.com";

  if (!ENV.resendApiKey) {
    console.warn(
      "[Notification] RESEND_API_KEY is not set — dropping owner notification:",
      title
    );
    return false;
  }

  try {
    const { Resend } = await import("resend");
    const resend = new Resend(ENV.resendApiKey);

    const { error } = await resend.emails.send({
      from,
      to,
      subject: title,
      html: `<pre style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;white-space:pre-wrap;word-break:break-word;">${escapeHtml(
        content
      )}</pre>`,
    });

    if (error) {
      console.warn("[Notification] Resend rejected owner notification:", error);
      return false;
    }

    return true;
  } catch (error) {
    console.warn("[Notification] Error sending owner notification:", error);
    return false;
  }
}
