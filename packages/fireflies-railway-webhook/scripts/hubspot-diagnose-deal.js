/**
 * One-off: find HubSpot contact + deals for an email (env from Railway / .env).
 * Usage: railway run node scripts/hubspot-diagnose-deal.js jackie@kellyroofing.com
 */
require("dotenv").config();
const fetch = require("node-fetch");

const email = (process.argv[2] || "").trim().toLowerCase();
if (!email) {
  console.error("Usage: node scripts/hubspot-diagnose-deal.js <email>");
  process.exit(1);
}

async function hubspot(path, body, method = "POST") {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) throw new Error("Missing HUBSPOT_ACCESS_TOKEN");
  const res = await fetch(`https://api.hubapi.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {}
  if (!res.ok) {
    throw new Error(`HubSpot ${res.status} ${path}: ${text.slice(0, 800)}`);
  }
  return json;
}

async function main() {
  const search = await hubspot("/crm/v3/objects/contacts/search", {
    filterGroups: [
      { filters: [{ propertyName: "email", operator: "EQ", value: email }] },
    ],
    properties: ["email", "firstname", "lastname"],
    limit: 1,
  });
  const contact = search?.results?.[0];
  if (!contact) {
    console.log("NO_CONTACT");
    return;
  }
  console.log("CONTACT_ID", contact.id);
  const assoc = await hubspot(
    `/crm/v4/objects/contacts/${contact.id}/associations/deals?limit=100`,
    null,
    "GET",
  );
  const dealIds = (assoc?.results || []).map((r) => r.toObjectId).filter(Boolean);
  console.log("DEAL_IDS", dealIds.join(",") || "(none)");
  if (!dealIds.length) return;

  const batch = await hubspot("/crm/v3/objects/deals/batch/read", {
    properties: ["dealname", "dealstage", "pipeline", "amount"],
    inputs: dealIds.map((id) => ({ id: String(id) })),
  });
  for (const d of batch.results || []) {
    console.log(
      "DEAL",
      d.id,
      "| pipeline=",
      d.properties?.pipeline,
      "| dealstage=",
      d.properties?.dealstage,
      "| name=",
      d.properties?.dealname,
    );
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
