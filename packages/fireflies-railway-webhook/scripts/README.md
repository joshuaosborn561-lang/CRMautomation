# Scripts

| Script | Purpose | Mutates data? |
|--------|---------|----------------|
| `print-webhook-payload-for-hubspot-test.js` | Lists Fireflies transcripts and prints a sample webhook JSON. | No |
| `test-gemini-classification.js` | Rule + Gemini classification checks. Needs `GEMINI_API_KEY`. | No |
| `ci-rule-tests.js` | Fast rule + duration checks for CI (no API keys). | No |
| `hubspot-ensure-contact-deal.js` | Creates HubSpot contact + deal for E2E testing. | **Yes** |
| `hubspot-patch-deal-stage.js` | `node … <dealId> <dealstage>` — PATCH deal stage. | **Yes** |
| `hubspot-get-deal.js` | Read deal properties. | No |
| `hubspot-list-pipelines.js` | List deal pipelines and stages. | No |
| `hubspot-diagnose-deal.js` | `node … <email>` — contact + deals for an email. | No |
| `fireflies-fetch-one.js` | `node … <transcriptId>` — minimal Fireflies fetch. | No |

Run with Railway env: `railway run node scripts/<name>.js …`
