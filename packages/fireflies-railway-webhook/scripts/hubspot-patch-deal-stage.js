require("dotenv").config();
const fetch = require("node-fetch");
const dealId = process.argv[2];
const stage = process.argv[3];
if (!dealId || !stage) {
  console.error("Usage: node scripts/hubspot-patch-deal-stage.js <dealId> <dealstage>");
  process.exit(1);
}
fetch(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}`, {
  method: "PATCH",
  headers: {
    Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ properties: { dealstage: stage } }),
})
  .then((r) => r.text())
  .then((t) => console.log(t));
