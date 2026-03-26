# CRM Autopilot - System Architecture

## Overview

A fully automated personal CRM system that eliminates manual data entry from a B2B outbound sales workflow. The system captures events from SmartLead, HeyReach, Zoom Phone, Zoom Meetings, and Gmail (Google Workspace) — uses Claude to interpret each event — and updates Attio CRM automatically.

## System Components

```
SmartLead ──webhook──┐
HeyReach ──webhook──┤
Zoom Phone ─webhook─┤    ┌──────────────┐    ┌───────────┐    ┌───────┐
Zoom Meetings─wh────┼───>│ Webhook      │───>│ Claude AI │───>│ Attio │
Gmail ──Pub/Sub push┘    │ Server       │    │ Processor │    │ CRM   │
                         │ (Railway)    │    └───────────┘    └───────┘
                         │              │
                         │ Supabase DB  │<── Nurture Engine (cron)
                         │              │
                         └──────────────┘
                               │
                         ┌─────┴──────┐
                         │ Query App  │
                         │ (Vercel)   │
                         └────────────┘
```

## Component Details

### 1. Webhook Server (Railway - Node.js/Express)
- Receives webhooks from SmartLead, HeyReach, Zoom
- Validates webhook signatures
- Stores raw events in Supabase
- Queues events for AI processing
- Runs nurture cron job

### 2. AI Event Processor (Claude API)
- Interprets each event: sentiment, deal stage, next action
- Generates human-readable summaries
- Determines Attio updates (contact, deal, note, task)
- Review mode: queues proposed changes for approval

### 3. Attio CRM Integration
- Creates/updates contacts and companies
- Creates/updates deals with pipeline stages
- Logs interaction notes with AI summaries
- Creates follow-up tasks

### 4. Nurture Engine
- Runs every hour via cron
- Checks for deals with 5+ days of silence after positive engagement
- Moves qualifying deals to Nurture stage with full context
- Creates re-engagement tasks

### 5. Query Interface (Vercel - Next.js)
- Natural language pipeline questions
- Claude queries Supabase + Attio to answer
- Conversational responses, not raw data dumps

### 6. Supabase (Supporting Data Store)
- Raw webhook events
- Processed event log
- Interaction timeline per deal
- Review queue (pending Attio writes)
- Nurture tracking state

## Deal Stages (Attio Pipeline)

| Stage | Trigger |
|-------|---------|
| Replied / Showed Interest | First positive reply from cold email, LinkedIn accept/reply, or cold call interest |
| Call/Meeting Booked | Calendar invite sent or meeting scheduled |
| Discovery Completed | Discovery call/meeting completed |
| Proposal Sent | Proposal/pricing discussed or sent |
| Negotiating | Back-and-forth on terms |
| Closed Won | Deal signed |
| Closed Lost | Explicit rejection or disqualification |
| Nurture | Engaged then went silent 5+ days (see nurture rules) |

## API Keys & Configuration Needed

| Service | What's Needed |
|---------|--------------|
| SmartLead | API key (for MCP server + webhook verification) |
| HeyReach | API key + webhook secret |
| Zoom | OAuth app credentials (Client ID, Client Secret, Account ID) for Server-to-Server OAuth |
| Attio | API key (for MCP server / REST API) |
| Anthropic | API key for Claude |
| Supabase | Project URL + service role key |

## Deployment

- **Webhook Server**: Railway (always-on, receives webhooks)
- **Query App**: Vercel (Next.js, on-demand)
- **Database**: Supabase (managed Postgres)
- **Cron**: Railway cron job or Supabase pg_cron
