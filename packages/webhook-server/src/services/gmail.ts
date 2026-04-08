import { getConfig } from "../config";
import { logger } from "../utils/logger";

// Gmail API using Google Workspace service account or OAuth2
// Uses Gmail Push Notifications via Google Cloud Pub/Sub for real-time events

const GMAIL_BASE_URL = "https://gmail.googleapis.com/gmail/v1";

let _accessToken: string | null = null;
let _tokenExpiry: number = 0;

async function getGmailAccessToken(): Promise<string> {
  if (_accessToken && Date.now() < _tokenExpiry) {
    return _accessToken;
  }

  const config = getConfig();

  // Use OAuth2 refresh token flow
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

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google OAuth error: ${response.status} ${body}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };

  _accessToken = data.access_token;
  _tokenExpiry = Date.now() + (data.expires_in - 300) * 1000;

  return _accessToken;
}

async function gmailFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  const token = await getGmailAccessToken();
  const config = getConfig();
  const userId = config.GMAIL_USER_EMAIL || "me";
  const url = `${GMAIL_BASE_URL}/users/${userId}${path}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    logger.error("Gmail API error", { status: response.status, path, body });
    throw new Error(`Gmail API error: ${response.status} ${body}`);
  }

  return response.json();
}

// --- Message Reading ---

export async function getMessage(messageId: string): Promise<{
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
  snippet: string;
}> {
  const data = (await gmailFetch(`/messages/${messageId}?format=full`)) as {
    id: string;
    threadId: string;
    snippet: string;
    payload: {
      headers: Array<{ name: string; value: string }>;
      body?: { data?: string };
      parts?: Array<{
        mimeType: string;
        body?: { data?: string };
      }>;
    };
  };

  const headers = data.payload.headers;
  const getHeader = (name: string) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

  // Decode body from base64url
  let body = "";
  if (data.payload.body?.data) {
    body = Buffer.from(data.payload.body.data, "base64url").toString("utf-8");
  } else if (data.payload.parts) {
    const textPart = data.payload.parts.find(
      (p) => p.mimeType === "text/plain"
    );
    const htmlPart = data.payload.parts.find(
      (p) => p.mimeType === "text/html"
    );
    const part = textPart || htmlPart;
    if (part?.body?.data) {
      body = Buffer.from(part.body.data, "base64url").toString("utf-8");
    }
  }

  // Strip HTML tags if we got HTML
  body = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

  return {
    id: data.id,
    threadId: data.threadId,
    from: getHeader("From"),
    to: getHeader("To"),
    subject: getHeader("Subject"),
    date: getHeader("Date"),
    body,
    snippet: data.snippet,
  };
}

export async function getThread(threadId: string): Promise<{
  id: string;
  messages: Array<{
    id: string;
    from: string;
    to: string;
    subject: string;
    date: string;
    snippet: string;
  }>;
}> {
  const data = (await gmailFetch(`/threads/${threadId}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`)) as {
    id: string;
    messages: Array<{
      id: string;
      snippet: string;
      payload: {
        headers: Array<{ name: string; value: string }>;
      };
    }>;
  };

  return {
    id: data.id,
    messages: data.messages.map((msg) => {
      const getHeader = (name: string) =>
        msg.payload.headers.find(
          (h) => h.name.toLowerCase() === name.toLowerCase()
        )?.value || "";
      return {
        id: msg.id,
        from: getHeader("From"),
        to: getHeader("To"),
        subject: getHeader("Subject"),
        date: getHeader("Date"),
        snippet: msg.snippet,
      };
    }),
  };
}

// --- Push Notification Setup ---
// Gmail uses Google Cloud Pub/Sub for push notifications.
// Call this once at startup to watch for new emails.

export async function setupGmailWatch(): Promise<{
  historyId: string;
  expiration: string;
}> {
  const config = getConfig();
  const topicName = config.GOOGLE_PUBSUB_TOPIC;
  if (!topicName) {
    logger.warn("GOOGLE_PUBSUB_TOPIC not configured, Gmail push notifications disabled");
    return { historyId: "0", expiration: "0" };
  }

  const result = (await gmailFetch("/watch", {
    method: "POST",
    body: JSON.stringify({
      topicName,
      labelIds: ["INBOX"],
    }),
  })) as { historyId: string; expiration: string };

  logger.info("Gmail watch configured", {
    historyId: result.historyId,
    expiration: new Date(Number(result.expiration)).toISOString(),
  });

  return result;
}

// --- Search ---
// Gmail search query syntax: https://support.google.com/mail/answer/7190
// Searches ALL mail (sent + received + archives), not just the INBOX watch.

export async function searchMessages(
  q: string,
  maxResults = 5
): Promise<Array<{ id: string; threadId: string }>> {
  try {
    const params = new URLSearchParams({ q, maxResults: String(maxResults) });
    const data = (await gmailFetch(`/messages?${params}`)) as {
      messages?: Array<{ id: string; threadId: string }>;
    };
    return data.messages || [];
  } catch (err) {
    logger.warn("Gmail searchMessages failed", { q, error: String(err) });
    return [];
  }
}

/**
 * Given a message id, scan the body and headers for the attendee email.
 *
 * For Zoom-scheduled meetings, the user receives a confirmation email from
 * Zoom (no-reply@zoom.us) that contains the invitee's email address in the
 * body. This function extracts the first non-own-domain, non-Zoom, non-Google
 * calendar address from: body text → subject → To: header.
 */
export async function extractAttendeeEmailFromMessage(messageId: string): Promise<string | null> {
  const ownDomain = (process.env.OWN_EMAIL_DOMAIN || "salesglidergrowth.com").toLowerCase();
  const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;

  const isExternal = (addr: string): boolean => {
    const a = addr.toLowerCase();
    if (a.endsWith(`@${ownDomain}`)) return false;
    if (a.endsWith("@zoom.us") || a.endsWith(".zoom.us")) return false;
    if (a.includes("no-reply@") || a.includes("noreply@")) return false;
    if (a.includes("calendar-notification@google.com")) return false;
    if (a.includes("mailer-daemon")) return false;
    if (a.includes("@google.com")) return false;
    return true;
  };

  try {
    const msg = await getMessage(messageId);
    // 1. Scan the body first — Zoom confirmation emails embed the invitee here.
    const bodyMatches = (msg.body || "").match(EMAIL_RE) || [];
    for (const raw of bodyMatches) {
      if (isExternal(raw)) return raw.toLowerCase();
    }
    // 2. Subject line
    const subjectMatches = (msg.subject || "").match(EMAIL_RE) || [];
    for (const raw of subjectMatches) {
      if (isExternal(raw)) return raw.toLowerCase();
    }
    // 3. To: header (for the case where the user forwarded an invite themselves)
    const toMatches = (msg.to || "").match(EMAIL_RE) || [];
    for (const raw of toMatches) {
      if (isExternal(raw)) return raw.toLowerCase();
    }
  } catch (err) {
    logger.warn("extractAttendeeEmailFromMessage failed", { messageId, error: String(err) });
  }
  return null;
}

// --- History Sync ---
// When we receive a Pub/Sub push, it includes a historyId.
// We use history.list to get what changed since our last known historyId.

export async function getHistoryChanges(
  startHistoryId: string
): Promise<Array<{ messageId: string; action: "added" | "labelChanged" }>> {
  try {
    const data = (await gmailFetch(
      `/history?startHistoryId=${startHistoryId}&historyTypes=messageAdded`
    )) as {
      history?: Array<{
        messagesAdded?: Array<{ message: { id: string } }>;
      }>;
      historyId: string;
    };

    const changes: Array<{ messageId: string; action: "added" | "labelChanged" }> = [];
    for (const entry of data.history || []) {
      for (const added of entry.messagesAdded || []) {
        changes.push({ messageId: added.message.id, action: "added" });
      }
    }

    return changes;
  } catch (err) {
    logger.warn("Could not fetch Gmail history", { startHistoryId, error: String(err) });
    return [];
  }
}
