# CRM Automation Architecture (Current)

## Primary Workflow

This repository now centers on a Fireflies -> HubSpot pipeline:

1. Fireflies sends a webhook to `POST /fireflies-webhook`
2. Service fetches transcript details from Fireflies GraphQL
3. Classification determines `COMPLETED` vs `NO_SHOW` (rules first, Gemini fallback)
4. HubSpot contact is resolved by email
5. Existing HubSpot deal in configured pipeline is advanced to the correct stage
6. Contact notes/tasks and optional Slack notifications are written

Implementation lives in:

- `packages/fireflies-railway-webhook/server.js`
- `packages/fireflies-railway-webhook/lib/*`
- `packages/fireflies-railway-webhook/scripts/*`

## Integrations

- Fireflies API
- HubSpot CRM API
- Gemini (classification fallback)
- Slack webhook (optional)

## Environment Variables (Core)

- `FIREFLIES_API_KEY`
- `HUBSPOT_ACCESS_TOKEN`
- `HUBSPOT_PIPELINE_ID`
- `HUBSPOT_STAGE_DISCOVERY_COMPLETED`
- `HUBSPOT_STAGE_NURTURE`
- `GEMINI_API_KEY`

Optional:

- `HUBSPOT_STAGE_DISCOVERY_SCHEDULED`
- `SLACK_WEBHOOK_URL`

## Legacy Components

Legacy CRM components removed from this branch.
