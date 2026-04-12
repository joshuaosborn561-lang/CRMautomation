require("dotenv").config();
const fetch = require("node-fetch");
async function main() {
  const res = await fetch("https://api.hubapi.com/crm/v3/pipelines/deals", {
    headers: { Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}` },
  });
  const j = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(j));
  for (const p of j.results || []) {
    console.log("PIPELINE", p.id, p.label);
    for (const s of p.stages || []) {
      console.log("  stage", s.id, s.label);
    }
  }
}
main().catch(console.error);
