require("dotenv").config();
const fetch = require("node-fetch");
const id = process.argv[2];
fetch(`https://api.hubapi.com/crm/v3/objects/deals/${id}?properties=dealstage,pipeline,dealname`, {
  headers: { Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}` },
})
  .then((r) => r.json())
  .then((j) => console.log(JSON.stringify(j, null, 2)));
