/**
 * Email Service
 * ─────────────
 * Transactional email sending via Resend for system emails:
 * onboarding invitations, welcome emails, password resets.
 *
 * Outreach emails (to prospects) go through Gmail or Microsoft Graph;
 * this file is for platform-level emails only.
 */

import { Resend } from "resend";
import { and, eq, or } from "drizzle-orm";
import { contacts } from "../drizzle/schema";
import { ENV } from "./_core/env";
import { getDb } from "./db";

let resendClient: Resend | null = null;

function getResend(): Resend {
  if (!resendClient) {
    resendClient = new Resend(ENV.resendApiKey);
  }
  return resendClient;
}

/** Platform identity for transactional mail. All of it comes from the environment. */
const BRAND_NAME = process.env.BRAND_NAME ?? "Outbound Beast";
const SITE_URL = process.env.PUBLIC_SITE_URL ?? "https://example.com";
const SITE_LABEL = SITE_URL.replace(/^https?:\/\//, "");
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL ?? "support@example.com";
const SENDER_NAME = process.env.SENDER_NAME ?? "Your Name";
const SENDER_ADDRESS = process.env.SENDER_ADDRESS ?? "you@example.com";
const SENDER_PHONE = process.env.SENDER_PHONE ?? "";
const PHONE_SUFFIX = SENDER_PHONE ? ` · ${SENDER_PHONE}` : "";
const PHONE_TEL = SENDER_PHONE.replace(/[^\d+]/g, "");
const BOOKING_URL = process.env.BOOKING_URL ?? "https://example.com/book";
const BOOKING_LABEL = BOOKING_URL.replace(/^https?:\/\//, "");
const FROM_ADDRESS = process.env.TRANSACTIONAL_FROM ?? `${BRAND_NAME} <noreply@example.com>`;

/**
 * CASL gate (defensive): true when the address belongs to an opted-out
 * contact. Checked against both email and hunterEmail columns.
 * Prospect-facing sends (Calendly follow-up) are blocked on a match;
 * customer-transactional sends (onboarding, welcome) only log a warning,
 * those go out on explicit signup consent, which supersedes a prior
 * prospect-list opt-out.
 */
async function isOptedOutRecipient(toEmail: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const rows = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        or(eq(contacts.email, toEmail), eq(contacts.hunterEmail, toEmail)),
        eq(contacts.optedOut, true),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export interface OnboardingInviteParams {
  toEmail: string;
  companyName: string;
  inviteUrl: string;
  expiresInDays?: number;
}

/**
 * Sends the onboarding invitation email to a new customer.
 * Contains the unique token link to start the wizard.
 */
export async function sendOnboardingInvite(
  params: OnboardingInviteParams
): Promise<{ success: boolean; error?: string }> {
  const { toEmail, companyName, inviteUrl, expiresInDays = 7 } = params;

  // CASL check (warn-only): onboarding invites are transactional and sent on
  // explicit signup consent, so a prior prospect-list opt-out does not block
  // them, but flag the collision so it can be reviewed.
  try {
    if (await isOptedOutRecipient(toEmail)) {
      console.warn(`[EmailService] NOTE: onboarding invite recipient ${toEmail} matches an opted-out contact (CASL) — sending anyway (transactional, signup consent)`);
    }
  } catch {
    // warn-only path, never block a transactional invite on a failed check
  }

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Welcome to ${BRAND_NAME}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
          <!-- Header -->
          <tr>
            <td style="background-color:#1A1A2E;padding:32px 40px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <span style="color:#F9A825;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;">${BRAND_NAME}</span>
                    <h1 style="color:#ffffff;margin:8px 0 0;font-size:24px;font-weight:700;letter-spacing:-0.5px;">${BRAND_NAME}</h1>
                  </td>
                  <td align="right">
                    <span style="background-color:#DA0000;color:#ffffff;font-size:11px;font-weight:700;letter-spacing:1px;padding:4px 12px;border-radius:4px;text-transform:uppercase;">New Client Setup</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:40px;">
              <h2 style="color:#1A1A2E;margin:0 0 16px;font-size:20px;font-weight:600;">Welcome, ${companyName}</h2>
              <p style="color:#374151;margin:0 0 16px;font-size:15px;line-height:1.6;">
                Your ${BRAND_NAME} account has been created. To get started, you need to complete a short setup wizard. It takes about 5 minutes and tells the AI agent everything it needs to know about your company, your buyers, and your outreach style.
              </p>
              <p style="color:#374151;margin:0 0 24px;font-size:15px;line-height:1.6;">
                Once complete, your dashboard will be active and your first research run can begin.
              </p>
              <!-- CTA Button -->
              <table cellpadding="0" cellspacing="0" style="margin:0 0 32px;">
                <tr>
                  <td style="background-color:#DA0000;border-radius:6px;">
                    <a href="${inviteUrl}" style="display:inline-block;padding:14px 32px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;letter-spacing:0.3px;">Start Setup Wizard →</a>
                  </td>
                </tr>
              </table>
              <p style="color:#6b7280;margin:0 0 8px;font-size:13px;">
                This link expires in ${expiresInDays} days. If you need a new link, contact <a href="mailto:${SUPPORT_EMAIL}" style="color:#1A1A2E;">${SUPPORT_EMAIL}</a>.
              </p>
              <p style="color:#9ca3af;margin:0;font-size:12px;word-break:break-all;">
                ${inviteUrl}
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background-color:#f9fafb;padding:24px 40px;border-top:1px solid #e5e7eb;">
              <p style="color:#9ca3af;margin:0;font-size:12px;line-height:1.5;">
                Sent by <strong>${SENDER_NAME}</strong> · ${BRAND_NAME}${PHONE_SUFFIX}<br />
                <a href="${BOOKING_URL}" style="color:#1A1A2E;">Book a call</a> · <a href="${SITE_URL}" style="color:#1A1A2E;">${SITE_LABEL}</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  try {
    const resend = getResend();
    const { error } = await resend.emails.send({
      from: FROM_ADDRESS,
      to: toEmail,
      subject: `${companyName}: your ${BRAND_NAME} setup link`,
      html,
    });

    if (error) {
      console.error("[EmailService] Resend error:", error);
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[EmailService] Failed to send onboarding invite:", message);
    return { success: false, error: message };
  }
}

export interface CalendlyFollowUpParams {
  toEmail: string;
  prospectFirstName: string;
  companyName: string;
}

/**
 * Sends the Calendly self-booking link to a prospect after the AI voice agent
 * confirms a meeting on a call. The prospect picks their own time slot.
 *
 * Triggered by the ElevenLabs webhook when call_outcome = "meeting_booked"
 * and prospect_email is present in the data_collection output.
 */
export async function sendCalendlyFollowUp(
  params: CalendlyFollowUpParams
): Promise<{ success: boolean; error?: string }> {
  const { toEmail, prospectFirstName, companyName } = params;

  // CASL gate: this email goes to a prospect, never send to an opted-out contact.
  try {
    if (await isOptedOutRecipient(toEmail)) {
      console.warn(`[EmailService] Calendly follow-up blocked: ${toEmail} has opted out (CASL)`);
      return { success: false, error: "Recipient has opted out (CASL). Send blocked." };
    }
  } catch (gateErr) {
    // Fail closed, suppression may over-trigger, never under-trigger.
    const message = gateErr instanceof Error ? gateErr.message : String(gateErr);
    console.error("[EmailService] CASL opt-out check failed — send blocked:", message);
    return { success: false, error: `CASL opt-out check failed, send blocked: ${message}` };
  }

  const firstName = prospectFirstName || companyName || "there";

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Book your 30-minute demo</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
          <!-- Header -->
          <tr>
            <td style="background-color:#1A1A2E;padding:28px 40px;">
              <span style="color:#F9A825;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;">${BRAND_NAME}</span>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:40px;">
              <p style="color:#374151;margin:0 0 16px;font-size:15px;line-height:1.6;">Hi ${firstName},</p>
              <p style="color:#374151;margin:0 0 16px;font-size:15px;line-height:1.6;">
                Good speaking with you. Here is the link to book your 30-minute demo at a time that works for you.
              </p>
              <!-- CTA Button -->
              <table cellpadding="0" cellspacing="0" style="margin:24px 0;">
                <tr>
                  <td style="background-color:#DA0000;border-radius:6px;">
                    <a href="${BOOKING_URL}" style="display:inline-block;padding:14px 32px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;letter-spacing:0.3px;">Book your 30-minute demo</a>
                  </td>
                </tr>
              </table>
              <p style="color:#374151;margin:0 0 8px;font-size:15px;line-height:1.6;">
                Many thanks.
              </p>
              <p style="color:#374151;margin:0;font-size:15px;line-height:1.6;">
                ${SENDER_NAME}<br />
                <span style="color:#6b7280;font-size:13px;">${BRAND_NAME}${PHONE_SUFFIX}</span>
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background-color:#f9fafb;padding:20px 40px;border-top:1px solid #e5e7eb;">
              <p style="color:#9ca3af;margin:0;font-size:12px;line-height:1.5;">
                <a href="${BOOKING_URL}" style="color:#1A1A2E;">${BOOKING_LABEL}</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  try {
    const resend = getResend();
    const { error } = await resend.emails.send({
      from: `${SENDER_NAME} <${SENDER_ADDRESS}>`,
      to: toEmail,
      subject: `Your ${BRAND_NAME} demo link`,
      html,
    });

    if (error) {
      console.error("[EmailService] Resend error sending Calendly follow-up:", error);
      return { success: false, error: error.message };
    }

    console.log(`[EmailService] Calendly follow-up sent to ${toEmail}`);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[EmailService] Failed to send Calendly follow-up:", message);
    return { success: false, error: message };
  }
}

export interface WelcomeEmailParams {
  toEmail: string;
  companyName: string;
  dashboardUrl: string;
  tempPassword: string;
}

/**
 * Sends the welcome email after wizard completion.
 * Includes dashboard URL and temporary credentials.
 */
export async function sendWelcomeEmail(
  params: WelcomeEmailParams
): Promise<{ success: boolean; error?: string }> {
  const { toEmail, companyName, dashboardUrl, tempPassword } = params;

  // CASL check (warn-only): welcome emails are transactional (wizard just
  // completed), flag an opt-out collision but do not block.
  try {
    if (await isOptedOutRecipient(toEmail)) {
      console.warn(`[EmailService] NOTE: welcome email recipient ${toEmail} matches an opted-out contact (CASL) — sending anyway (transactional, signup consent)`);
    }
  } catch {
    // warn-only path, never block a transactional welcome on a failed check
  }

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Your ${BRAND_NAME} dashboard is ready</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
          <tr>
            <td style="background-color:#1A1A2E;padding:32px 40px;">
              <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:700;">Your dashboard is ready</h1>
              <p style="color:#F9A825;margin:8px 0 0;font-size:13px;font-weight:600;letter-spacing:1px;text-transform:uppercase;">${BRAND_NAME} · ${companyName}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:40px;">
              <p style="color:#374151;margin:0 0 24px;font-size:15px;line-height:1.6;">
                Setup is complete. Your ${BRAND_NAME} dashboard is active and ready for your first research run.
              </p>
              <table cellpadding="0" cellspacing="0" style="background-color:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;margin:0 0 24px;width:100%;">
                <tr>
                  <td style="padding:20px;">
                    <p style="color:#6b7280;margin:0 0 4px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:1px;">Login credentials</p>
                    <p style="color:#1A1A2E;margin:0 0 8px;font-size:14px;"><strong>Email:</strong> ${toEmail}</p>
                    <p style="color:#1A1A2E;margin:0 0 8px;font-size:14px;"><strong>Temporary password:</strong> <code style="background:#e5e7eb;padding:2px 6px;border-radius:3px;">${tempPassword}</code></p>
                    <p style="color:#9ca3af;margin:0;font-size:12px;">Change your password after first login.</p>
                  </td>
                </tr>
              </table>
              <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
                <tr>
                  <td style="background-color:#DA0000;border-radius:6px;">
                    <a href="${dashboardUrl}" style="display:inline-block;padding:14px 32px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">Open Dashboard →</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background-color:#f9fafb;padding:24px 40px;border-top:1px solid #e5e7eb;">
              <p style="color:#9ca3af;margin:0;font-size:12px;">
                Questions? Reply to this email${SENDER_PHONE ? ` or call <a href="tel:${PHONE_TEL}" style="color:#1A1A2E;">${SENDER_PHONE}</a>` : ""}.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  try {
    const resend = getResend();
    const { error } = await resend.emails.send({
      from: FROM_ADDRESS,
      to: toEmail,
      subject: `Your ${BRAND_NAME} dashboard is ready: ${companyName}`,
      html,
    });

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}
