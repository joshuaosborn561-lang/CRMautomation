/**
 * Prints a webhook JSON body that can reach HubSpot, using a real Fireflies transcript id.
 *
 * Usage:
 *   node scripts/print-webhook-payload-for-hubspot-test.js
 *   node scripts/print-webhook-payload-for-hubspot-test.js you@company.com
 *
 * Requires FIREFLIES_API_KEY in .env (same as server).
 *
 * HubSpot will only update if:
 * - pickProspectEmail() resolves to an email that exists as a HubSpot contact
 * - That contact has a deal in HUBSPOT_PIPELINE_ID (and stage HUBSPOT_STAGE_DISCOVERY_SCHEDULED when set)
 */
require("dotenv").config();
const fetch = require("node-fetch");

async function firefliesGraphQL(query, variables) {
  const key = process.env.FIREFLIES_API_KEY;
  if (!key) throw new Error("Missing FIREFLIES_API_KEY in .env");

  const res = await fetch("https://api.fireflies.ai/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 1500)}`);
  }
  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors).slice(0, 1500)}`);
  }
  return json.data;
}

function lower(s) {
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}

function attendeeEmails(meeting_attendees) {
  if (!Array.isArray(meeting_attendees)) return [];
  return meeting_attendees
    .map((a) => lower(a?.email))
    .filter(Boolean);
}

function pickOrganizerForPayload(t) {
  return lower(t.organizer_email) || lower(t.host_email) || "";
}

function pickProspectPreview(organizerEmail, meeting_attendees) {
  const mine = lower(organizerEmail);
  const emails = [...new Set(attendeeEmails(meeting_attendees))];
  const other = emails.find((e) => (mine ? e !== mine : true));
  return other || emails[0] || null;
}

async function main() {
  const organizerArg = (process.argv[2] || "").trim();

  const fields = `
    id
    title
    host_email
    organizer_email
    meeting_attendees {
      email
      displayName
      name
    }
  `;

  let list;
  if (organizerArg) {
    try {
      const data = await firefliesGraphQL(
        `
      query ($limit: Int!, $organizers: [String!]) {
        transcripts(limit: $limit, organizers: $organizers) {
          ${fields}
        }
      }
    `,
        { limit: 10, organizers: [organizerArg] },
      );
      list = data.transcripts || [];
    } catch (e) {
      const data = await firefliesGraphQL(
        `
      query ($limit: Int!) {
        transcripts(limit: $limit) {
          ${fields}
        }
      }
    `,
        { limit: 25 },
      );
      const mine = lower(organizerArg);
      list = (data.transcripts || []).filter(
        (t) => lower(t.organizer_email) === mine || lower(t.host_email) === mine,
      );
      if (!list.length) throw e;
    }
  } else {
    const data = await firefliesGraphQL(
      `
      query ($limit: Int!) {
        transcripts(limit: $limit) {
          ${fields}
        }
      }
    `,
      { limit: 10 },
    );
    list = data.transcripts || [];
  }

  if (!list.length) {
    console.error("No transcripts returned. Try passing your organizer email as the first argument.");
    process.exit(1);
  }

  console.log("--- Recent transcripts (newest first in API order) ---\n");
  for (const t of list) {
    const org = pickOrganizerForPayload(t);
    const prospect = pickProspectPreview(org, t.meeting_attendees);
    console.log(`id: ${t.id}`);
    console.log(`  title: ${t.title || "(no title)"}`);
    console.log(`  organizer/host: ${org || "(unknown — set organizerEmail in payload to your email)"}`);
    console.log(`  attendee emails: ${attendeeEmails(t.meeting_attendees).join(", ") || "(none)"}`);
    console.log(`  likely prospectEmail for HubSpot: ${prospect || "(none — add calendar emails or pick another meeting)"}`);
    console.log("");
  }

  const best =
    list.find((t) => pickProspectPreview(pickOrganizerForPayload(t), t.meeting_attendees)) || list[0];
  const organizerEmail = organizerArg || pickOrganizerForPayload(best) || "your-email@domain.com";
  const prospectHint = pickProspectPreview(lower(organizerEmail), best.meeting_attendees);

  const payload = {
    meetingId: best.id,
    organizerEmail: organizerEmail || undefined,
  };

  console.log("--- Copy this POST body (application/json) ---\n");
  console.log(JSON.stringify(payload, null, 2));
  console.log("\n--- Checks before HubSpot will update ---");
  console.log(`1) Fireflies transcript loads (meetingId is real): ${best.id}`);
  console.log(
    `2) HubSpot contact exists for prospect email the server will choose: ${prospectHint || "(resolve attendees / organizerEmail first)"}`,
  );
  console.log("3) That contact has a deal in HUBSPOT_PIPELINE_ID (and discovery-scheduled stage if env is set)");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
