import { getConfig } from "../config";
import { logger } from "../utils/logger";

let _accessToken: string | null = null;
let _tokenExpiry: number = 0;

export async function getZoomAccessToken(): Promise<string> {
  if (_accessToken && Date.now() < _tokenExpiry) {
    return _accessToken;
  }

  const config = getConfig();
  const credentials = Buffer.from(
    `${config.ZOOM_CLIENT_ID}:${config.ZOOM_CLIENT_SECRET}`
  ).toString("base64");

  const response = await fetch("https://zoom.us/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "account_credentials",
      account_id: config.ZOOM_ACCOUNT_ID,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Zoom OAuth error: ${response.status} ${body}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };

  _accessToken = data.access_token;
  // Refresh 5 minutes before expiry
  _tokenExpiry = Date.now() + (data.expires_in - 300) * 1000;

  return _accessToken;
}

async function zoomFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  const token = await getZoomAccessToken();
  const response = await fetch(`https://api.zoom.us/v2${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    logger.error("Zoom API error", { status: response.status, path, body });
    throw new Error(`Zoom API error: ${response.status} ${body}`);
  }

  return response.json();
}

// --- Phone ---

export async function getCallRecording(callId: string): Promise<{
  download_url?: string;
  file_url?: string;
}> {
  return (await zoomFetch(`/phone/call_history/${callId}/recordings`)) as {
    download_url?: string;
    file_url?: string;
  };
}

export async function getCallLog(callId: string): Promise<{
  id: string;
  caller_number: string;
  callee_number: string;
  direction: string;
  duration: number;
  date_time: string;
  caller_name?: string;
  callee_name?: string;
}> {
  return (await zoomFetch(`/phone/call_history/${callId}`)) as ReturnType<
    typeof getCallLog
  > extends Promise<infer T>
    ? T
    : never;
}

// --- Meetings ---

export async function getMeetingRecordings(meetingId: string): Promise<{
  recording_files: Array<{
    id: string;
    file_type: string;
    download_url: string;
    recording_type: string;
    status: string;
  }>;
}> {
  // Zoom UUIDs with / or = need double URL encoding
  const encodedId = meetingId.includes("/") || meetingId.includes("=")
    ? encodeURIComponent(encodeURIComponent(meetingId))
    : meetingId;

  try {
    return (await zoomFetch(`/meetings/${encodedId}/recordings`)) as {
      recording_files: Array<{
        id: string;
        file_type: string;
        download_url: string;
        recording_type: string;
        status: string;
      }>;
    };
  } catch (err) {
    // 404 = no recordings for this meeting — not an error
    if (err instanceof Error && err.message.includes("404")) {
      return { recording_files: [] };
    }
    throw err;
  }
}

export async function getMeetingTranscript(meetingId: string): Promise<string | null> {
  try {
    const recordings = await getMeetingRecordings(meetingId);
    // Zoom transcript files can have different type combinations
    const transcript = recordings.recording_files?.find(
      (f) =>
        f.file_type === "TRANSCRIPT" ||
        f.recording_type === "audio_transcript" ||
        (f.file_type === "JSON" && f.recording_type === "audio_transcript") ||
        f.file_type === "VTT"
    );

    if (!transcript?.download_url) {
      logger.info("No transcript file found in recordings", {
        meetingId,
        fileCount: recordings.recording_files?.length || 0,
        fileTypes: recordings.recording_files?.map(f => `${f.file_type}/${f.recording_type}`) || [],
      });
      return null;
    }

    const token = await getZoomAccessToken();
    const response = await fetch(
      `${transcript.download_url}?access_token=${token}`
    );

    if (!response.ok) {
      logger.warn("Transcript download failed", { meetingId, status: response.status });
      return null;
    }
    return await response.text();
  } catch (err) {
    logger.warn("Could not fetch meeting transcript", { meetingId, error: String(err) });
    return null;
  }
}

/**
 * Get all recording file metadata for a meeting.
 * Useful for debugging what files are available.
 */
export async function getMeetingRecordingFiles(meetingId: string): Promise<Array<{
  file_type: string;
  recording_type: string;
  download_url: string;
  status: string;
}>> {
  try {
    const recordings = await getMeetingRecordings(meetingId);
    return recordings.recording_files || [];
  } catch {
    return [];
  }
}

export async function getPhoneCallTranscript(callId: string): Promise<string | null> {
  // Try the dedicated transcript download endpoint first
  try {
    const token = await getZoomAccessToken();
    const response = await fetch(
      `https://api.zoom.us/v2/phone/call_history/${callId}/recordings/transcript?access_token=${token}`
    );
    if (response.ok) {
      const text = await response.text();
      if (text && text.trim().length > 0) return text;
    }
  } catch {
    // Fall through to recording-based approach
  }

  // Fallback: try to get transcript from recording files
  try {
    const recording = await getCallRecording(callId);
    if (!recording.download_url) return null;

    const token = await getZoomAccessToken();
    const response = await fetch(
      `${recording.download_url}?access_token=${token}`
    );

    if (!response.ok) return null;
    return await response.text();
  } catch (err) {
    logger.warn("Could not fetch phone call transcript", { callId, error: String(err) });
    return null;
  }
}

// Fetch full call details for enriching webhook events
export async function getPhoneCallDetails(callId: string): Promise<{
  call_id: string;
  caller_number?: string;
  callee_number?: string;
  caller_name?: string;
  callee_name?: string;
  direction?: string;
  duration?: number;
  date_time?: string;
  result?: string;
} | null> {
  try {
    const data = await zoomFetch(`/phone/call_history/${callId}`);
    return data as ReturnType<typeof getPhoneCallDetails> extends Promise<infer T> ? T : never;
  } catch (err) {
    logger.warn("Could not fetch phone call details", { callId, error: String(err) });
    return null;
  }
}

// --- Meeting Summary (Zoom AI Companion) ---

export async function getMeetingSummary(meetingId: string): Promise<{
  summary_url?: string;
  summary?: string;
} | null> {
  const encodedId = meetingId.includes("/") || meetingId.includes("=")
    ? encodeURIComponent(encodeURIComponent(meetingId))
    : meetingId;

  try {
    const data = (await zoomFetch(`/meetings/${encodedId}/meeting_summary`)) as Record<string, unknown>;
    return {
      summary_url: data.share_url as string | undefined,
      summary: data.summary_overview as string | undefined,
    };
  } catch (err) {
    // 404 = no AI summary available
    if (err instanceof Error && err.message.includes("404")) {
      return null;
    }
    logger.warn("Could not fetch meeting summary", { meetingId, error: String(err) });
    return null;
  }
}

// --- Meeting Settings (invitees fallback for identity cascade) ---

/**
 * Fetch meeting settings, including `meeting_invitees[]` for the identity
 * cascade fallback. Requires user-scope `meeting:read`, no admin scope.
 * Returns null on 404 or any error.
 */
export async function getMeetingSettings(meetingId: string): Promise<{
  invitees: Array<{ email: string }>;
  topic?: string;
} | null> {
  const encodedId = meetingId.includes("/") || meetingId.includes("=")
    ? encodeURIComponent(encodeURIComponent(meetingId))
    : meetingId;

  try {
    const data = (await zoomFetch(`/meetings/${encodedId}`)) as {
      topic?: string;
      settings?: {
        meeting_invitees?: Array<{ email: string }>;
      };
    };
    return {
      invitees: data.settings?.meeting_invitees || [],
      topic: data.topic,
    };
  } catch (err) {
    if (err instanceof Error && err.message.includes("404")) return null;
    logger.warn("Could not fetch meeting settings", { meetingId, error: String(err) });
    return null;
  }
}

// --- Meeting Participants (fallback for attendee email identity) ---

/**
 * Fetch meeting participants (from past meetings/reporting data).
 * Returns a flat list of participants with whatever identity fields Zoom provides.
 * Non-fatal: on error, returns [].
 */
export async function getMeetingParticipants(meetingId: string): Promise<Array<{
  id?: string;
  name?: string;
  user_email?: string;
  email?: string;
}>> {
  const encodedId = meetingId.includes("/") || meetingId.includes("=")
    ? encodeURIComponent(encodeURIComponent(meetingId))
    : meetingId;
  try {
    const first = (await zoomFetch(`/past_meetings/${encodedId}/participants?page_size=300`)) as {
      participants?: Array<{
        id?: string;
        name?: string;
        user_email?: string;
        email?: string;
      }>;
      next_page_token?: string;
    };
    const all: Array<{
      id?: string;
      name?: string;
      user_email?: string;
      email?: string;
    }> = [...(first.participants || [])];
    let token = first.next_page_token || "";
    let guard = 0;
    while (token && guard < 5) {
      guard += 1;
      const next = (await zoomFetch(
        `/past_meetings/${encodedId}/participants?page_size=300&next_page_token=${encodeURIComponent(token)}`
      )) as {
        participants?: Array<{
          id?: string;
          name?: string;
          user_email?: string;
          email?: string;
        }>;
        next_page_token?: string;
      };
      all.push(...(next.participants || []));
      token = next.next_page_token || "";
    }
    return all;
  } catch (err) {
    logger.warn("Could not fetch meeting participants", { meetingId, error: String(err) });
    return [];
  }
}

// --- Webhook Verification ---

import crypto from "crypto";

export function verifyZoomWebhook(
  payload: string,
  timestamp: string,
  signature: string
): boolean {
  const config = getConfig();
  const secretToken = config.ZOOM_WEBHOOK_SECRET_TOKEN;
  if (!secretToken) return true; // Skip verification if no secret configured

  const message = `v0:${timestamp}:${payload}`;
  const hashForVerify = crypto
    .createHmac("sha256", secretToken)
    .update(message)
    .digest("hex");
  const expectedSignature = `v0=${hashForVerify}`;

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

// Handle Zoom's URL validation challenge
export function handleZoomChallenge(
  plainToken: string
): { plainToken: string; encryptedToken: string } {
  const config = getConfig();
  const secretToken = config.ZOOM_WEBHOOK_SECRET_TOKEN || "";

  const encryptedToken = crypto
    .createHmac("sha256", secretToken)
    .update(plainToken)
    .digest("hex");

  return { plainToken, encryptedToken };
}
