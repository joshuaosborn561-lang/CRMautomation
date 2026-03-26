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
