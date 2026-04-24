# Fireflies → Gemini → HubSpot (Railway)

## Endpoint
- **POST** `/fireflies-webhook`
- Returns **200 immediately**, processes asynchronously.

## Required environment variables
- `FIREFLIES_API_KEY`
- `GEMINI_API_KEY`
- `HUBSPOT_ACCESS_TOKEN`
- `HUBSPOT_PIPELINE_ID`
- `HUBSPOT_STAGE_DISCOVERY_COMPLETED`
- `HUBSPOT_STAGE_NURTURE`
- `SLACK_WEBHOOK_URL` (optional at runtime; if unset the app will skip Slack notification)
- `CALENDLY_API_KEY` (optional today, reserved for Calendly enrichment path)

## CRM architecture

- This repository is now Fireflies + HubSpot centered.
- Legacy webhook-server/query-app components were removed from the working branch.
- The active ingestion route is `POST /fireflies-webhook` in `server.js`.

## Recommended (optional) environment variable
- `HUBSPOT_STAGE_DISCOVERY_SCHEDULED`
  - **Optional.** Comma‑separated internal stage IDs are allowed (e.g. `repliedId,discoveryBookedId`). The app will **prefer** a contact’s deal in one of those stages within `HUBSPOT_PIPELINE_ID`.
  - If **no** deal matches (wrong stage, stale ID, or Calendly/HubSpot moved the deal first), the app **falls back** to the **most recently modified** deal for that contact **in the same pipeline** so Fireflies can still set **Nurture** (no-show) or **Discovery Completed** instead of `SKIP_NO_TARGET_DEAL`.
  - If **unset**, the most recently modified deal in the pipeline is used when multiple exist.

## Reliability / tuning (optional)

| Variable | Default | Purpose |
|----------|---------|---------|
| `STARTUP_VALIDATE_HUBSPOT` | `true` | On boot, verify `HUBSPOT_PIPELINE_ID` and stage IDs exist (exits process on failure). Set `false` to skip. |
| `STARTUP_VALIDATE_FIREFLIES` | `false` | If `true`, run a minimal Fireflies `transcripts` query on boot. |
| `FIREFLIES_INITIAL_WAIT_MS` | `15000` | Wait before first transcript fetch (Fireflies indexing). |
| `FIREFLIES_RETRY_WAIT_MS` | `30000` | Second-attempt wait after a failed fetch. |
| `FIREFLIES_MAX_RETRIES` | `4` | Retries per GraphQL call for transient HTTP errors. |
| `HUBSPOT_MAX_RETRIES` | `5` | Retries for HubSpot `429` / `502` / `503` / `504`. |
| `GEMINI_TIMEOUT_MS` | `45000` | Per-attempt timeout for Gemini. |
| `GEMINI_MAX_RETRIES` | `3` | Gemini classification retries. |
| `WEBHOOK_IDEMPOTENCY_TTL_MS` | `604800000` (7d) | Skip duplicate processing for the same `meetingId` within this window. |
| `WEBHOOK_IDEMPOTENCY_MAX` | `2000` | Max idempotency entries kept in memory. |

- **Correlation:** send header `X-Correlation-Id` on POST; otherwise a UUID is generated. All logs for that run include `[cid=…]`.
- **Replay same meeting:** JSON body may include `"forceReplay": true` to bypass idempotency (use sparingly).

## Run locally
```bash
npm install
npm start
```

Health check: **GET** `/healthz`

## GitHub (`main`)

Canonical copy for this service lives in the **CRMautomation** monorepo:

[github.com/joshuaosborn561-lang/CRMautomation](https://github.com/joshuaosborn561-lang/CRMautomation) → `packages/fireflies-railway-webhook/`

From the monorepo root:

```bash
npm run start:fireflies
npm run test:fireflies-rules
```
