require("dotenv").config();
const fetch = require("node-fetch");
const id = process.argv[2];
const query = `
  query GetTranscript($id: String!) {
    transcript(id: $id) {
      id
      duration
    }
  }
`;
fetch("https://api.fireflies.ai/graphql", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.FIREFLIES_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ query, variables: { id } }),
})
  .then((r) => r.json())
  .then((j) => console.log(JSON.stringify(j, null, 2).slice(0, 1500)));
