import { getConfig } from "../config";
import { logger } from "../utils/logger";

const GMAIL_BASE_URL = "https://gmail.googleapis.com/gmail/v1";

let _accessToken: string | null = null;
let _tokenExpiry: number = 0;

async function getAccessToken(): Promise<string> {
  if (_accessToken && Date.now() < _tokenExpiry) {
    return _accessToken;
  }
  const config = getConfig();
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID,
      client_secret: config.GOOGLE_CLIENT_SECRET,
      refresh_token: config.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) throw new Error(`OAuth error: ${response.status}`);
  const data = (await response.json()) as { access_token: string; expires_in: number };
  _accessToken = data.access_token;
  _tokenExpiry = Date.now() + (data.expires_in - 300) * 1000;
  return _accessToken;
}

/**
 * Send an email via Gmail API.
 * Uses the authenticated user's account (your Google Workspace).
 */
export async function sendEmail(
  to: string,
  subject: string,
  body: string
): Promise<void> {
  const config = getConfig();
  const from = config.GMAIL_USER_EMAIL || "me";

  // Build RFC 2822 email
  const email = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: text/html; charset=utf-8`,
    "",
    body,
  ].join("\r\n");

  // Base64url encode
  const encoded = Buffer.from(email)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const token = await getAccessToken();
  const userId = config.GMAIL_USER_EMAIL || "me";

  const response = await fetch(
    `${GMAIL_BASE_URL}/users/${userId}/messages/send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: encoded }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    logger.error("Failed to send email", { status: response.status, body: text });
    throw new Error(`Gmail send error: ${response.status}`);
  }

  logger.info("Email sent", { to, subject });
}

/**
 * Send a nurture approval email with approve/reject links.
 */
export async function sendNurtureApprovalEmail(nurture: {
  id: string;
  contact_email: string;
  contact_first_name?: string;
  contact_last_name?: string;
  contact_company?: string;
  nurture_reason: string;
  days_silent: number;
  last_positive_summary: string;
}): Promise<void> {
  const config = getConfig();
  const notifyEmail = config.NOTIFICATION_EMAIL;
  if (!notifyEmail) {
    logger.warn("NOTIFICATION_EMAIL not set, skipping nurture notification");
    return;
  }

  const serverUrl = config.SERVER_URL || `http://localhost:${config.PORT}`;
  const approveUrl = `${serverUrl}/api/nurture/${nurture.id}/approve`;
  const rejectUrl = `${serverUrl}/api/nurture/${nurture.id}/reject`;

  const contactName = [nurture.contact_first_name, nurture.contact_last_name]
    .filter(Boolean)
    .join(" ") || nurture.contact_email;

  const subject = `Nurture? ${contactName}${nurture.contact_company ? ` (${nurture.contact_company})` : ""} — ${nurture.days_silent} days silent`;

  const body = `
<div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
  <h2 style="color: #333;">Nurture Approval Needed</h2>

  <div style="background: #f5f5f5; padding: 16px; border-radius: 8px; margin: 16px 0;">
    <p style="margin: 4px 0;"><strong>Contact:</strong> ${contactName}</p>
    <p style="margin: 4px 0;"><strong>Email:</strong> ${nurture.contact_email}</p>
    ${nurture.contact_company ? `<p style="margin: 4px 0;"><strong>Company:</strong> ${nurture.contact_company}</p>` : ""}
    <p style="margin: 4px 0;"><strong>Silent for:</strong> ${nurture.days_silent} days</p>
  </div>

  <div style="background: #fff; border: 1px solid #ddd; padding: 16px; border-radius: 8px; margin: 16px 0;">
    <h3 style="margin-top: 0;">Why Nurture?</h3>
    <p style="white-space: pre-line;">${nurture.nurture_reason}</p>
  </div>

  <div style="background: #fff; border: 1px solid #ddd; padding: 16px; border-radius: 8px; margin: 16px 0;">
    <h3 style="margin-top: 0;">Last Positive Interaction</h3>
    <p>${nurture.last_positive_summary}</p>
  </div>

  <div style="margin: 24px 0; text-align: center;">
    <a href="${approveUrl}" style="background: #22c55e; color: white; padding: 12px 32px; border-radius: 6px; text-decoration: none; font-weight: bold; margin-right: 12px;">Yes, Nurture</a>
    <a href="${rejectUrl}" style="background: #ef4444; color: white; padding: 12px 32px; border-radius: 6px; text-decoration: none; font-weight: bold;">No, Skip</a>
  </div>

  <p style="color: #888; font-size: 12px;">Approving will push this lead into your SmartLead nurture campaign and update their deal stage to Nurture in Attio.</p>
</div>`;

  await sendEmail(notifyEmail, subject, body);
}

/**
 * Send a daily digest or alert email.
 */
export async function sendAlertEmail(
  subject: string,
  body: string
): Promise<void> {
  const config = getConfig();
  const notifyEmail = config.NOTIFICATION_EMAIL;
  if (!notifyEmail) return;

  await sendEmail(notifyEmail, subject, body);
}
