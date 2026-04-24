# SalesGlider Auto-CRM — Architecture Brief (HubSpot-first)

This document is the canonical “how the system works” reference for this repository and for future work in Cursor.

## System overview

This is an automated sales pipeline for a B2B outbound agency (**SalesGlider Growth**). Leads enter through cold email and LinkedIn, get processed through integrations and (where needed) a small Railway-hosted service, and land in **HubSpot** as contacts and deals — staged and actioned with minimal manual input.

The system spans:

- **HubSpot** (CRM + automation brain)
- **SmartLead** (cold email engine)
- **HeyReach** (LinkedIn outbound)
- **Zapier** (glue for non-native connections)
- **Railway** (hosted Node.js endpoint for Fireflies post-call classification)

> Note: This repo’s active HubSpot-writing service is `packages/fireflies-railway-webhook/`. It is **not** responsible for SmartLead/HeyReach ingestion; those are primarily native integrations + Zapier in your live stack.

## Tool roles

### HubSpot (CRM + automation brain)

HubSpot stores contacts and deals and runs the Sales Pipeline with stages such as:

Replied → Discovery Scheduled → Discovery Completed → Nurture → Proposal Sent → Signed → Closed Won / Paid

Native integrations handle (examples):

- Zoom Phone call logging
- Zoom Meetings transcript sync
- Fireflies notes
- Gmail thread logging
- Cal.com booking → deal stage move
- DocuSign signed → stage move
- Stripe payment → Paid stage

Workflows (no-code) handle:

- Deal stage progression on triggers
- No-show task creation + nurture enrollment
- Auto-enrichment (example: Breeze AI)

API access is enabled via a **Private App token** with scopes such as:

- contacts read/write
- deals read/write
- notes write
- tasks write

### SmartLead (cold email engine)

SmartLead sends cold email campaigns at scale.

**Native HubSpot integration:** when a prospect replies, SmartLead automatically creates/updates the HubSpot contact and creates a deal at the **Replied** stage.

SmartLead also fires webhooks on reply events (used for broader AI reply/intent systems — separate from the core CRM ingestion path described here).

### Zapier (glue for non-native connections)

Active Zaps (as of this brief):

- **HeyReach → HubSpot** — when a LinkedIn prospect accepts/replies, Zapier creates the HubSpot contact and logs a note with message content
- **HeyReach → HubSpot deal** — creates a deal at **Replied** for LinkedIn-sourced contacts
- **DocuSign → HubSpot** — when a document is signed, Zapier moves the associated deal to **Signed**

What Zapier is **not** doing:

- SmartLead (native)
- Fireflies (native)
- Zoom (native)
- Cal.com (native)
- Stripe (native Commerce Hub)

### Railway Node.js endpoint (AI classification layer)

A deployed Express app receives **Fireflies** webhooks when a Zoom discovery call transcription completes.

Flow:

1. Fireflies webhook fires
2. Endpoint receives it (`POST /fireflies-webhook`)
3. Waits (configured delay) and fetches transcript via Fireflies GraphQL
4. Classifies meeting as `COMPLETED` or `NO_SHOW` (rules first, Gemini fallback)
5. Calls HubSpot API to update deal stage accordingly
6. Logs a note on the HubSpot contact record

Stage mapping (configured via env vars):

- If `COMPLETED` → deal moves to **Discovery Completed**
- If `NO_SHOW` → deal moves to **No show** (separate from long-term nurture; HubSpot workflows may still add tasks)

Environment variables (service):

- `HUBSPOT_ACCESS_TOKEN`
- `FIREFLIES_API_KEY`
- `GEMINI_API_KEY`
- `HUBSPOT_PIPELINE_ID`
- `HUBSPOT_STAGE_DISCOVERY_SCHEDULED` (optional but recommended)
- `HUBSPOT_STAGE_DISCOVERY_COMPLETED`
- `HUBSPOT_STAGE_NO_SHOW` (or legacy `HUBSPOT_STAGE_NURTURE` if unset)
- `SLACK_WEBHOOK_URL` (optional)

## Event → action map (who owns it)

| Event | Tool handling it | Result in HubSpot |
|---|---|---|
| Prospect replies to cold email | SmartLead native | Contact created/updated; deal at **Replied** |
| LinkedIn accept/reply | Zapier (HeyReach → HS) | Contact + note; deal at **Replied** |
| Prospect books discovery | Cal.com native | Deal → **Discovery Scheduled**; Zoom link generated |
| Discovery call occurs | Fireflies native | Transcript/summary logged (native behavior) |
| Post-call Fireflies webhook | Railway endpoint | Deal → **Discovery Completed** or **No show** + HubSpot note |
| No-show follow-up | HubSpot workflows | Tasks + nurture enrollment |
| Zoom Phone calls | Zoom Phone native | Call logged with recording on contact |
| Gmail thread | HubSpot Gmail sync | Email on contact timeline |
| Quote/proposal | HubSpot native | Deal → **Proposal Sent** |
| DocuSign signed | Zapier | Deal → **Signed** |
| Stripe paid | HubSpot Commerce Hub | Deal → **Paid** |
| New contact enrichment | Breeze AI (HubSpot) | Enrichment fields populated |

## Operational notes (debugging)

### “Something isn’t working” — fast triage

1. **Identify the owner** from the table above (native vs Zapier vs Railway).
2. If it’s Railway/Fireflies:
   - confirm the webhook is reaching `POST /fireflies-webhook`
   - confirm HubSpot contact exists for the resolved prospect email
   - confirm a target deal exists in the configured pipeline/stage (otherwise the service logs `SKIP_NO_TARGET_DEAL`)
3. If it’s Zapier:
   - verify Zap history + mapped fields + duplicate deal creation rules
4. If it’s HubSpot workflows:
   - verify enrollment triggers, branch conditions, and conflicting automations (common source of duplicate deals)

### Repo reality check

This repo intentionally focuses on the **Fireflies → HubSpot** microservice. Replacing Zapier generally means implementing new webhook endpoints + idempotency + HubSpot writes + observability for each former Zap.
