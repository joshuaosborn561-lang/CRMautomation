/**
 * Ensures a HubSpot contact + deal exist for E2E webhook testing.
 * Usage: railway run node scripts/hubspot-ensure-contact-deal.js <email> [firstname] [lastname]
 */
require("dotenv").config();
const fetch = require("node-fetch");

const email = (process.argv[2] || "").trim().toLowerCase();
const first = (process.argv[3] || "Jackie").trim();
const last = (process.argv[4] || "TestContact").trim();

if (!email) {
  console.error("Usage: node scripts/hubspot-ensure-contact-deal.js email@x.com [First] [Last]");
  process.exit(1);
}

async function hubspot(path, opts = {}) {
  const method = opts.method || "POST";
  const res = await fetch(`https://api.hubapi.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
      ...(method === "GET" ? {} : { "Content-Type": "application/json" }),
      ...(opts.headers || {}),
    },
    body: method === "GET" || opts.body == null ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {}
  if (!res.ok) throw new Error(`${path} ${res.status}: ${text.slice(0, 900)}`);
  return json;
}

async function main() {
  const pipe = process.env.HUBSPOT_PIPELINE_ID || "default";
  const stage = process.env.HUBSPOT_STAGE_DISCOVERY_SCHEDULED || "qualifiedtobuy";

  const search = await hubspot("/crm/v3/objects/contacts/search", {
    body: {
      filterGroups: [
        { filters: [{ propertyName: "email", operator: "EQ", value: email }] },
      ],
      properties: ["email", "firstname", "lastname"],
      limit: 1,
    },
  });

  let contactId = search?.results?.[0]?.id;
  if (!contactId) {
    const created = await hubspot("/crm/v3/objects/contacts", {
      body: {
        properties: {
          email,
          firstname: first,
          lastname: last,
        },
      },
    });
    contactId = created.id;
    console.log("created contact", contactId);
  } else {
    console.log("existing contact", contactId);
  }

  const assoc = await hubspot(`/crm/v4/objects/contacts/${contactId}/associations/deals?limit=100`, {
    method: "GET",
  });
  const dealIds = (assoc?.results || []).map((r) => r.toObjectId).filter(Boolean);
  let deals = [];
  if (dealIds.length) {
    const batch = await hubspot("/crm/v3/objects/deals/batch/read", {
      body: {
        properties: ["dealname", "dealstage", "pipeline"],
        inputs: dealIds.map((id) => ({ id: String(id) })),
      },
    });
    deals = batch.results || [];
  }

  const already = deals.find((d) => d.properties?.pipeline === pipe && d.properties?.dealstage === stage);
  if (already) {
    console.log("deal already in target stage:", already.id, already.properties?.dealname);
    return;
  }

  const deal = await hubspot("/crm/v3/objects/deals", {
    body: {
      properties: {
        dealname: `Fireflies webhook test — ${email}`,
        pipeline: pipe,
        dealstage: stage,
      },
      associations: [
        {
          to: { id: String(contactId) },
          types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 }],
        },
      ],
    },
  });
  console.log("created deal", deal.id, "pipeline", pipe, "stage", stage);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
