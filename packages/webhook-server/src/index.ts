import express from "express";
import cron from "node-cron";
import { getConfig } from "./config";
import { logger } from "./utils/logger";

// Webhook handlers
import { smartleadRouter } from "./webhooks/smartlead";
import { heyreachRouter } from "./webhooks/heyreach";
import { zoomRouter } from "./webhooks/zoom";
import { gmailRouter } from "./webhooks/gmail";

// API routes
import { reviewRouter } from "./routes/review";
import { nurtureRouter } from "./routes/nurture";
import { queryRouter } from "./routes/query";
import { backfillRouter } from "./routes/backfill";

// Background jobs
import { processEventQueue } from "./processors/event-pipeline";
import { runNurtureCheck } from "./jobs/nurture-engine";
import { setupGmailWatch } from "./services/gmail";
import { runStartupBackfill } from "./jobs/startup-backfill";
import { ensureAttioFieldsExist } from "./services/attio";

const app = express();

// Middleware
app.use(express.json({ limit: "10mb" }));

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Webhook endpoints
app.use("/webhooks/smartlead", smartleadRouter);
app.use("/webhooks/heyreach", heyreachRouter);
app.use("/webhooks/zoom", zoomRouter);
app.use("/webhooks/gmail", gmailRouter);

// API endpoints
app.use("/api/review-queue", reviewRouter);
app.use("/api/nurture", nurtureRouter);
app.use("/api/query", queryRouter);
app.use("/api/backfill", backfillRouter);

// Status endpoint — overview of system state
app.get("/api/status", async (_req, res) => {
  try {
    const config = getConfig();
    const { getSupabase } = await import("./utils/supabase");
    const supabase = getSupabase();

    // Count events by status
    const { count: totalEvents } = await supabase
      .from("webhook_events")
      .select("*", { count: "exact", head: true });
    const { count: unprocessed } = await supabase
      .from("webhook_events")
      .select("*", { count: "exact", head: true })
      .eq("processed", false);
    const { count: processed } = await supabase
      .from("webhook_events")
      .select("*", { count: "exact", head: true })
      .eq("processed", true);

    // Count by source
    const { data: sourceCounts } = await supabase
      .from("webhook_events")
      .select("source, processed");

    const bySource: Record<string, { total: number; processed: number; unprocessed: number }> = {};
    for (const row of sourceCounts || []) {
      if (!bySource[row.source]) bySource[row.source] = { total: 0, processed: 0, unprocessed: 0 };
      bySource[row.source].total++;
      if (row.processed) bySource[row.source].processed++;
      else bySource[row.source].unprocessed++;
    }

    // Recent interaction log entries (last 10)
    const { data: recentInteractions } = await supabase
      .from("interaction_log")
      .select("contact_email, source, event_type, sentiment, occurred_at")
      .order("occurred_at", { ascending: false })
      .limit(10);

    res.json({
      review_mode: config.REVIEW_MODE,
      environment: config.NODE_ENV,
      uptime: process.uptime(),
      events: { total: totalEvents, processed, unprocessed },
      by_source: bySource,
      recent_interactions: recentInteractions || [],
      credentials_set: {
        anthropic: !!config.ANTHROPIC_API_KEY && !config.ANTHROPIC_API_KEY.includes("your-"),
        attio: !!config.ATTIO_API_KEY && !config.ATTIO_API_KEY.includes("your-"),
        attio_pipeline: !!config.ATTIO_PIPELINE_ID && config.ATTIO_PIPELINE_ID.length > 0,
        supabase: !!config.SUPABASE_URL && !config.SUPABASE_URL.includes("your-"),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Diagnostic endpoint — test every external API connection
app.get("/api/diag", async (_req, res) => {
  const config = getConfig();
  const results: Record<string, unknown> = {};

  // Supabase
  try {
    const { getSupabase } = await import("./utils/supabase");
    const supabase = getSupabase();
    const { count, error } = await supabase
      .from("webhook_events")
      .select("*", { count: "exact", head: true });
    results.supabase = error ? { status: "FAIL", error: error.message } : { status: "OK", event_count: count };
  } catch (err) {
    results.supabase = { status: "FAIL", error: String(err) };
  }

  // Attio
  try {
    const resp = await fetch("https://api.attio.com/v2/self", {
      headers: { Authorization: `Bearer ${config.ATTIO_API_KEY}` },
    });
    const body = await resp.text();
    results.attio = resp.ok
      ? { status: "OK", response: JSON.parse(body) }
      : { status: "FAIL", http: resp.status, body };
  } catch (err) {
    results.attio = { status: "FAIL", error: String(err) };
  }

  // Attio pipeline
  try {
    if (config.ATTIO_PIPELINE_ID) {
      const resp = await fetch(`https://api.attio.com/v2/lists/${config.ATTIO_PIPELINE_ID}`, {
        headers: { Authorization: `Bearer ${config.ATTIO_API_KEY}` },
      });
      const body = await resp.text();
      results.attio_pipeline = resp.ok
        ? { status: "OK", pipeline: JSON.parse(body) }
        : { status: "FAIL", http: resp.status, body };
    } else {
      results.attio_pipeline = { status: "FAIL", error: "ATTIO_PIPELINE_ID not set" };
    }
  } catch (err) {
    results.attio_pipeline = { status: "FAIL", error: String(err) };
  }

  // Anthropic
  try {
    const keyPrefix = config.ANTHROPIC_API_KEY.substring(0, 10) + "...";
    results.anthropic = { status: "OK", key_prefix: keyPrefix };
  } catch (err) {
    results.anthropic = { status: "FAIL", error: String(err) };
  }

  // Config summary
  results.config = {
    review_mode: config.REVIEW_MODE,
    has_attio_key: !!config.ATTIO_API_KEY && config.ATTIO_API_KEY.length > 10,
    has_attio_pipeline: !!config.ATTIO_PIPELINE_ID && config.ATTIO_PIPELINE_ID.length > 5,
    has_anthropic_key: !!config.ANTHROPIC_API_KEY && config.ANTHROPIC_API_KEY.length > 10,
    has_smartlead_key: !!config.SMARTLEAD_API_KEY && config.SMARTLEAD_API_KEY.length > 5,
    has_heyreach_key: !!config.HEYREACH_API_KEY && config.HEYREACH_API_KEY.length > 5,
    has_zoom_creds: !!config.ZOOM_CLIENT_ID && !!config.ZOOM_CLIENT_SECRET,
    has_google_creds: !!config.GOOGLE_CLIENT_ID && !!config.GOOGLE_REFRESH_TOKEN,
    has_leadmagic_key: !!config.LEADMAGIC_API_KEY,
    run_startup_backfill: process.env.RUN_STARTUP_BACKFILL,
  };

  res.json(results);
});

// Clear events by source and reset others for reprocessing
app.all("/api/fix", async (_req, res) => {
  try {
    const { getSupabase } = await import("./utils/supabase");
    const supabase = getSupabase();
    const results: Record<string, unknown> = {};

    // 1. Delete all gmail events and their linked data
    const { data: gmailEvents } = await supabase
      .from("webhook_events")
      .select("id")
      .eq("source", "gmail");
    const gmailIds = (gmailEvents || []).map((e: { id: string }) => e.id);

    if (gmailIds.length > 0) {
      for (let i = 0; i < gmailIds.length; i += 200) {
        const chunk = gmailIds.slice(i, i + 200);
        await supabase.from("review_queue").delete().in("event_id", chunk);
        await supabase.from("interaction_log").delete().in("raw_event_id", chunk);
      }
      await supabase.from("webhook_events").delete().eq("source", "gmail");
    }
    results.gmail_deleted = gmailIds.length;

    // 2. Reset all non-gmail processed events to unprocessed (so they re-run with correct config)
    const { error: resetErr } = await supabase
      .from("webhook_events")
      .update({ processed: false, processed_at: null })
      .eq("processed", true);
    results.events_reset = resetErr ? `Error: ${resetErr.message}` : "OK";

    // 3. Clear interaction_log entries with "unknown" email (failed enrichment)
    const { error: clearErr } = await supabase
      .from("interaction_log")
      .delete()
      .eq("contact_email", "unknown");
    results.unknown_interactions_cleared = clearErr ? `Error: ${clearErr.message}` : "OK";

    // 3b. Delete events with empty payloads or "unknown" event types (broken events)
    const { error: emptyErr } = await supabase
      .from("webhook_events")
      .delete()
      .eq("event_type", "unknown");
    results.empty_events_deleted = emptyErr ? `Error: ${emptyErr.message}` : "OK";

    // 4. Show what's left
    const { count: remaining } = await supabase
      .from("webhook_events")
      .select("*", { count: "exact", head: true });
    results.remaining_events = remaining;

    // 5. Show Attio pipeline stages for debugging
    const config = getConfig();
    try {
      const pipelineResp = await fetch(
        `https://api.attio.com/v2/lists/${config.ATTIO_PIPELINE_ID}/attributes`,
        { headers: { Authorization: `Bearer ${config.ATTIO_API_KEY}` } }
      );
      if (pipelineResp.ok) {
        const pipelineData = await pipelineResp.json();
        results.attio_pipeline_stages = pipelineData;
      } else {
        results.attio_pipeline_stages = `Error: ${pipelineResp.status} ${await pipelineResp.text()}`;
      }
    } catch (err) {
      results.attio_pipeline_stages = `Error: ${String(err)}`;
    }

    // 6. Check LeadMagic key
    results.leadmagic_key_set = !!config.LEADMAGIC_API_KEY && config.LEADMAGIC_API_KEY.length > 5;
    results.leadmagic_action_needed = !results.leadmagic_key_set
      ? "SET LEADMAGIC_API_KEY in Railway env vars to: 43599068e8e9a1fdfad0046b44e2b7fb"
      : "Key is set";

    res.json({
      message: "Gmail events cleared, remaining events reset for reprocessing",
      ...results,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Diagnostic: try to create a test contact in Attio to verify API works
app.get("/api/debug/test-attio-write", async (_req, res) => {
  const steps: Array<{ step: string; status: string; details?: unknown }> = [];
  const config = getConfig();
  const headers = {
    Authorization: `Bearer ${config.ATTIO_API_KEY}`,
    "Content-Type": "application/json",
  };

  // Step 1: Test read access
  try {
    const resp = await fetch("https://api.attio.com/v2/objects/people/records/query", {
      method: "POST", headers, body: JSON.stringify({ limit: 1 }),
    });
    const body = await resp.text();
    steps.push({ step: "read_people", status: resp.ok ? "OK" : "FAIL", details: { http: resp.status, body: body.substring(0, 300) } });
  } catch (err) {
    steps.push({ step: "read_people", status: "ERROR", details: String(err) });
  }

  // Step 2: Test write access — create a test contact with ONLY core fields
  let testContactId: string | null = null;
  try {
    const resp = await fetch("https://api.attio.com/v2/objects/people/records", {
      method: "POST", headers,
      body: JSON.stringify({
        data: {
          values: {
            email_addresses: [{ email_address: "test-debug@crm-autopilot-test.com" }],
            name: [{ first_name: "CRM", last_name: "Test", full_name: "CRM Test" }],
          },
        },
      }),
    });
    const body = await resp.text();
    if (resp.ok) {
      const parsed = JSON.parse(body);
      testContactId = parsed?.data?.id?.record_id;
      steps.push({ step: "create_contact_core", status: "OK", details: { id: testContactId, http: resp.status } });
    } else {
      steps.push({ step: "create_contact_core", status: "FAIL", details: { http: resp.status, body: body.substring(0, 500) } });
    }
  } catch (err) {
    steps.push({ step: "create_contact_core", status: "ERROR", details: String(err) });
  }

  // Step 3: Test custom field write
  if (testContactId) {
    // Test job_title (built-in text field)
    try {
      const resp = await fetch(`https://api.attio.com/v2/objects/people/records/${testContactId}`, {
        method: "PATCH", headers,
        body: JSON.stringify({
          data: { values: { job_title: "Test CEO" } },
        }),
      });
      const body = await resp.text();
      steps.push({ step: "update_job_title", status: resp.ok ? "OK" : "FAIL", details: { http: resp.status, body: body.substring(0, 200) } });
    } catch (err) {
      steps.push({ step: "update_job_title", status: "ERROR", details: String(err) });
    }

    // Test company as record-reference (create company first, then link)
    try {
      const { findOrCreateCompany } = await import("./services/attio");
      const companyId = await findOrCreateCompany("Test Debug Company");
      const resp = await fetch(`https://api.attio.com/v2/objects/people/records/${testContactId}`, {
        method: "PATCH", headers,
        body: JSON.stringify({
          data: { values: { company: [{ target_object: "companies", target_record_id: companyId }] } },
        }),
      });
      const body = await resp.text();
      steps.push({ step: "update_company_ref", status: resp.ok ? "OK" : "FAIL", details: { http: resp.status, companyId, body: body.substring(0, 200) } });
    } catch (err) {
      steps.push({ step: "update_company_ref", status: "ERROR", details: String(err) });
    }

    // Step 4: Get pipeline config to see what parent objects it accepts
    let pipelineParentObject: string | null = null;
    if (config.ATTIO_PIPELINE_ID) {
      try {
        const listResp = await fetch(`https://api.attio.com/v2/lists/${config.ATTIO_PIPELINE_ID}`, {
          headers: { Authorization: `Bearer ${config.ATTIO_API_KEY}` },
        });
        const listBody = await listResp.text();
        if (listResp.ok) {
          const listData = JSON.parse(listBody);
          pipelineParentObject = listData?.data?.parent_object;
          steps.push({ step: "pipeline_config", status: "OK", details: {
            parent_object: listData?.data?.parent_object,
            name: listData?.data?.name,
            statuses: listData?.data?.statuses?.map((s: any) => s.title),
          }});
        } else {
          steps.push({ step: "pipeline_config", status: "FAIL", details: { http: listResp.status, body: listBody.substring(0, 300) } });
        }
      } catch (err) {
        steps.push({ step: "pipeline_config", status: "ERROR", details: String(err) });
      }

      // Step 4a: Get workspace member ID for owner field
      let testOwnerId: string | null = null;
      try {
        const wmResp = await fetch("https://api.attio.com/v2/workspace_members", {
          headers: { Authorization: `Bearer ${config.ATTIO_API_KEY}` },
        });
        if (wmResp.ok) {
          const wmData = await wmResp.json() as { data: Array<{ id: { workspace_member_id: string }; name?: string }> };
          if (wmData.data?.length > 0) {
            testOwnerId = wmData.data[0].id.workspace_member_id;
            steps.push({ step: "get_workspace_member", status: "OK", details: { id: testOwnerId, count: wmData.data.length } });
          }
        } else {
          steps.push({ step: "get_workspace_member", status: "FAIL", details: { http: wmResp.status } });
        }
      } catch (err) {
        steps.push({ step: "get_workspace_member", status: "ERROR", details: String(err) });
      }

      // Step 4b: Ensure deal stages exist via dedicated statuses endpoint, then get them
      let testStageTitle: string | null = null;
      try {
        // Run ensureAttioFieldsExist to create stages via POST /objects/deals/attributes/stage/statuses
        const { ensureAttioFieldsExist: ensureFields, resetFieldsCache } = await import("./services/attio");
        resetFieldsCache(); // Reset so it actually runs
        await ensureFields();

        // Now list the statuses to confirm they exist
        const listResp = await fetch("https://api.attio.com/v2/objects/deals/attributes/stage/statuses", {
          headers: { Authorization: `Bearer ${config.ATTIO_API_KEY}` },
        });
        if (listResp.ok) {
          const listData = await listResp.json() as { data: Array<{ title: string }> };
          const statuses = listData.data || [];
          testStageTitle = statuses[0]?.title || null;
          steps.push({ step: "get_deal_stages", status: statuses.length > 0 ? "OK" : "WARN (no stages)", details: { stages: statuses.map(s => s.title), using: testStageTitle } });
        } else {
          const body = await listResp.text();
          steps.push({ step: "get_deal_stages", status: "FAIL", details: { http: listResp.status, body: body.substring(0, 300) } });
        }
      } catch (err) {
        steps.push({ step: "get_deal_stages", status: "ERROR", details: String(err) });
      }

      // Step 4c: Create a deal record with ALL required fields (name, stage, owner)
      let testDealRecordId: string | null = null;
      try {
        const dealValues: Record<string, unknown> = { name: "Test Deal - CRM Debug" };
        if (testStageTitle) dealValues.stage = [{ status: testStageTitle }];
        if (testOwnerId) dealValues.owner = [{ referenced_actor_type: "workspace-member", referenced_actor_id: testOwnerId }];

        const dealResp = await fetch("https://api.attio.com/v2/objects/deals/records", {
          method: "POST", headers,
          body: JSON.stringify({ data: { values: dealValues } }),
        });
        const dealBody = await dealResp.text();
        if (dealResp.ok) {
          const dealData = JSON.parse(dealBody);
          testDealRecordId = dealData?.data?.id?.record_id;
          steps.push({ step: "create_deal_record", status: "OK", details: { dealRecordId: testDealRecordId, sentValues: Object.keys(dealValues) } });
        } else {
          steps.push({ step: "create_deal_record", status: "FAIL", details: { http: dealResp.status, body: dealBody.substring(0, 500), sentValues: dealValues } });
        }
      } catch (err) {
        steps.push({ step: "create_deal_record", status: "ERROR", details: String(err) });
      }

      // Step 4b: Create pipeline entry for the deal record
      if (testDealRecordId) {
        try {
          const resp = await fetch(`https://api.attio.com/v2/lists/${config.ATTIO_PIPELINE_ID}/entries`, {
            method: "POST", headers,
            body: JSON.stringify({
              data: {
                parent_object: "deals",
                parent_record_id: testDealRecordId,
                entry_values: {},
              },
            }),
          });
          const body = await resp.text();
          steps.push({ step: "create_pipeline_entry", status: resp.ok ? "OK" : "FAIL", details: { http: resp.status, body: body.substring(0, 500) } });

          // Clean up pipeline entry + deal record
          if (resp.ok) {
            const entryData = JSON.parse(body);
            const entryId = entryData?.data?.entry_id;
            if (entryId) {
              await fetch(`https://api.attio.com/v2/lists/${config.ATTIO_PIPELINE_ID}/entries/${entryId}`, {
                method: "DELETE", headers: { Authorization: `Bearer ${config.ATTIO_API_KEY}` },
              });
            }
          }
          // Clean up deal record
          await fetch(`https://api.attio.com/v2/objects/deals/records/${testDealRecordId}`, {
            method: "DELETE", headers,
          });
        } catch (err) {
          steps.push({ step: "create_pipeline_entry", status: "ERROR", details: String(err) });
        }
      }
    } else {
      steps.push({ step: "create_deal", status: "SKIP", details: "ATTIO_PIPELINE_ID not configured" });
    }

    // Step 5: Clean up test contact
    try {
      await fetch(`https://api.attio.com/v2/objects/people/records/${testContactId}`, {
        method: "DELETE", headers,
      });
      steps.push({ step: "cleanup", status: "OK" });
    } catch {
      steps.push({ step: "cleanup", status: "FAIL" });
    }
  }

  // Step 6: List People + Deals object attributes
  for (const obj of ["people", "deals"]) {
    try {
      const resp = await fetch(`https://api.attio.com/v2/objects/${obj}/attributes`, {
        method: "GET", headers: { Authorization: `Bearer ${config.ATTIO_API_KEY}` },
      });
      if (resp.ok) {
        const data = await resp.json() as { data: Array<{ api_slug: string; title: string; type: string; id: string; is_required: boolean }> };
        const attrs = data.data?.map(a => `${a.api_slug} (${a.type}${a.is_required ? ", REQUIRED" : ""}) [${typeof a.id === 'string' ? a.id.substring(0,8) : JSON.stringify(a.id).substring(0,30)}]`).join(", ");
        steps.push({ step: `list_${obj}_attributes`, status: "OK", details: attrs });
      } else {
        steps.push({ step: `list_${obj}_attributes`, status: "FAIL", details: { http: resp.status } });
      }
    } catch (err) {
      steps.push({ step: `list_${obj}_attributes`, status: "ERROR", details: String(err) });
    }
  }

  res.json({ steps });
});

// Test processing: classifies a single event via the rule engine (no Attio mutation).
app.get("/api/debug/test-one", async (_req, res) => {
  try {
    const { getSupabase } = await import("./utils/supabase");
    const supabase = getSupabase();

    const { data: events } = await supabase
      .from("webhook_events")
      .select("*")
      .eq("processed", false)
      .neq("source", "gmail")
      .neq("payload", "{}")
      .neq("event_type", "unknown")
      .order("received_at", { ascending: true })
      .limit(5);

    if (!events || events.length === 0) {
      res.json({ message: "No unprocessed non-gmail events to test" });
      return;
    }

    const event = events.find((e: any) => e.payload && Object.keys(e.payload).length > 0) || events[0];
    const { classifyEvent, extractContactFromEvent, buildNoteBody } = await import("./services/rules");
    res.json({
      event_id: event.id,
      source: event.source,
      event_type: event.event_type,
      identity_key: event.identity_key,
      classification: classifyEvent(event),
      contact: extractContactFromEvent(event),
      note_body_preview: buildNoteBody(event).slice(0, 500),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Debug: Check what's actually in Attio
app.get("/api/debug/attio-check", async (_req, res) => {
  try {
    const config = getConfig();
    const results: Record<string, unknown> = {};

    // Check contacts (people)
    const peopleResp = await fetch("https://api.attio.com/v2/objects/people/records/query", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.ATTIO_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ limit: 10 }),
    });
    if (peopleResp.ok) {
      const people = await peopleResp.json() as { data: unknown[] };
      results.people_count = people.data?.length || 0;
      results.recent_people = people.data?.slice(0, 5);
    } else {
      results.people_error = `${peopleResp.status}: ${await peopleResp.text()}`;
    }

    // Check deals (pipeline entries)
    if (config.ATTIO_PIPELINE_ID) {
      const dealsResp = await fetch(`https://api.attio.com/v2/lists/${config.ATTIO_PIPELINE_ID}/entries/query`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.ATTIO_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ limit: 10 }),
      });
      if (dealsResp.ok) {
        const deals = await dealsResp.json() as { data: unknown[] };
        results.deals_count = deals.data?.length || 0;
        results.recent_deals = deals.data?.slice(0, 5);
      } else {
        results.deals_error = `${dealsResp.status}: ${await dealsResp.text()}`;
      }
    }

    // Check interaction log for non-unknown emails
    const { getSupabase } = await import("./utils/supabase");
    const supabase = getSupabase();
    const { data: validInteractions } = await supabase
      .from("interaction_log")
      .select("contact_email, source, sentiment")
      .neq("contact_email", "unknown")
      .order("occurred_at", { ascending: false })
      .limit(20);
    results.valid_interactions = validInteractions;

    // Count how many have "unknown" email
    const { count: unknownCount } = await supabase
      .from("interaction_log")
      .select("*", { count: "exact", head: true })
      .eq("contact_email", "unknown");
    const { count: totalCount } = await supabase
      .from("interaction_log")
      .select("*", { count: "exact", head: true });
    results.interaction_stats = {
      total: totalCount,
      unknown_email: unknownCount,
      valid_email: (totalCount || 0) - (unknownCount || 0),
    };

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Nuke ALL people and deals from Attio (clean slate)
app.post("/api/cleanup-attio", async (_req, res) => {
  try {
    const config = getConfig();
    let peopleDeleted = 0;
    let dealsDeleted = 0;

    // 1. Delete all pipeline entries (deals) first
    const pipelineId = config.ATTIO_PIPELINE_ID;
    if (pipelineId) {
      while (true) {
        const dealsResp = await fetch(`https://api.attio.com/v2/lists/${pipelineId}/entries/query`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.ATTIO_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ limit: 50 }),
        });
        if (!dealsResp.ok) break;
        const dealsData = await dealsResp.json() as { data: Array<Record<string, unknown>> };
        if (!dealsData.data || dealsData.data.length === 0) break;

        for (const deal of dealsData.data) {
          try {
            await fetch(`https://api.attio.com/v2/lists/${pipelineId}/entries/${deal.entry_id}`, {
              method: "DELETE",
              headers: { Authorization: `Bearer ${config.ATTIO_API_KEY}` },
            });
            dealsDeleted++;
          } catch { /* continue */ }
        }
      }
    }

    // 2. Delete all people
    while (true) {
      const resp = await fetch("https://api.attio.com/v2/objects/people/records/query", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.ATTIO_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ limit: 50 }),
      });
      if (!resp.ok) break;
      const data = await resp.json() as { data: Array<Record<string, unknown>> };
      if (!data.data || data.data.length === 0) break;

      for (const person of data.data) {
        const id = (person.id as Record<string, string>)?.record_id;
        try {
          await fetch(`https://api.attio.com/v2/objects/people/records/${id}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${config.ATTIO_API_KEY}` },
          });
          peopleDeleted++;
        } catch { /* continue */ }
      }
    }

    res.json({
      message: `Attio wiped clean. ${peopleDeleted} people deleted, ${dealsDeleted} deals deleted. Ready for fresh reprocess.`,
      peopleDeleted,
      dealsDeleted,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Debug: Show raw event payloads to diagnose data issues
app.get("/api/debug/sample-events", async (_req, res) => {
  try {
    const { getSupabase } = await import("./utils/supabase");
    const supabase = getSupabase();

    // Get a sample of each source type
    const sources = ["zoom_phone", "zoom_meeting", "smartlead", "heyreach"];
    const samples: Record<string, unknown> = {};

    for (const source of sources) {
      const { data } = await supabase
        .from("webhook_events")
        .select("id, source, event_type, payload, received_at")
        .eq("source", source)
        .limit(2);
      samples[source] = (data || []).map((e: any) => ({
        id: e.id,
        event_type: e.event_type,
        received_at: e.received_at,
        // Show the full zoom object so we can see field names
        zoom_object: e.payload?.payload?.object || null,
        // Show full payload for non-zoom events (smartlead, heyreach)
        full_payload: source === "smartlead" || source === "heyreach" ? e.payload : undefined,
        enriched_contact: e.payload?.enriched_contact || null,
        has_transcript: !!e.payload?.transcript,
        has_call_details: !!e.payload?.call_details,
        payload_keys: Object.keys(e.payload || {}),
      }));
    }

    res.json(samples);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Debug: list all stored zoom_meeting events with their meeting IDs + resolution status.
// Read-only. Used to pick a meeting ID to test the Gmail cascade against.
app.get("/api/debug/zoom-transcripts", async (_req, res) => {
  try {
    const { getSupabase } = await import("./utils/supabase");
    const supabase = getSupabase();
    const limit = Math.min(500, Math.max(1, Number(_req.query.limit || 200)));
    const { data } = await supabase
      .from("webhook_events")
      .select("id, event_type, payload, received_at")
      .eq("source", "zoom_meeting")
      .order("received_at", { ascending: false })
      .limit(limit);
    const rows = (data || []).map((row: any) => {
      const obj = row.payload?.payload?.object || {};
      return {
        id: row.id,
        event_type: row.event_type,
        received_at: row.received_at,
        meeting_id: obj.id ? String(obj.id) : null,
        meeting_uuid: obj.uuid || null,
        topic: obj.topic || null,
        host_id: obj.host_id || null,
        resolved_attendee_email: row.payload?.resolved_attendee_email || null,
        resolved_via: row.payload?.resolved_via || null,
        has_transcript_text: typeof row.payload?.transcript === "string" && row.payload.transcript.length > 0,
      };
    });
    const actionable = rows.filter((r) => r.event_type === "recording.transcript_completed");
    res.json({ count: rows.length, actionable_transcripts: actionable.length, rows });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Debug: run the Gmail+Zoom identity cascade for ONE meeting ID and return
// a step-by-step trace. Non-destructive — does not write to webhook_events
// or meeting_links. Used to diagnose why the dry-run's meeting resolution
// returns 0.
//
// Usage:
//   GET /api/debug/test-gmail-cascade?meetingId=84095267037
//   GET /api/debug/test-gmail-cascade            (auto-picks first unresolved transcript)
app.get("/api/debug/test-gmail-cascade", async (req, res) => {
  try {
    const { getSupabase } = await import("./utils/supabase");
    const gmailService = await import("./services/gmail");
    const zoomService = await import("./services/zoom");
    const { lookupMeetingLink } = await import("./services/identity");

    const supabase = getSupabase();
    let meetingId = (req.query.meetingId as string) || "";
    const rowIdParam = (req.query.eventId as string) || (req.query.rowId as string) || "";
    let sourceRowId: string | null = null;
    let sourceTopic: string | null = null;

    // Auto-pick first unresolved transcript if no meetingId given.
    if (!meetingId && rowIdParam) {
      const { data: byId } = await supabase
        .from("webhook_events")
        .select("id, payload")
        .eq("id", rowIdParam)
        .maybeSingle();
      if (!byId) {
        return res.status(404).json({ error: "event_not_found", event_id: rowIdParam });
      }
      const obj = (byId as any).payload?.payload?.object || {};
      meetingId = obj.id ? String(obj.id) : "";
      sourceRowId = (byId as any).id;
      sourceTopic = obj.topic || null;
      if (!meetingId) {
        return res.status(400).json({ error: "event_has_no_meeting_id", event_id: rowIdParam });
      }
    }

    if (!meetingId) {
      const { data } = await supabase
        .from("webhook_events")
        .select("id, payload")
        .eq("source", "zoom_meeting")
        .eq("event_type", "recording.transcript_completed")
        .order("received_at", { ascending: false })
        .limit(10);
      const pick = (data || []).find((row: any) => !row.payload?.resolved_attendee_email);
      if (!pick) {
        return res.json({ error: "no_unresolved_transcripts_found" });
      }
      const obj = pick.payload?.payload?.object || {};
      meetingId = obj.id ? String(obj.id) : "";
      sourceRowId = pick.id;
      sourceTopic = obj.topic || null;
      if (!meetingId) return res.json({ error: "picked_row_has_no_meeting_id", row_id: pick.id });
    }

    const ownDomain = (process.env.OWN_EMAIL_DOMAIN || "salesglidergrowth.com").toLowerCase();
    const trace: Record<string, unknown> = {
      meeting_id: meetingId,
      source_row_id: sourceRowId,
      source_topic: sourceTopic,
      own_domain: ownDomain,
    };

    // Step 1: meeting_links cache
    const cached = await lookupMeetingLink(meetingId);
    trace.step1_meeting_links_cache = cached || "miss";

    // Step 2: Gmail — three query variants, per-message body extraction
    const queries = [
      `from:zoom.us ${meetingId}`,
      `from:no-reply@zoom.us ${meetingId}`,
      `"${meetingId}"`,
    ];
    const gmailResults: Array<Record<string, unknown>> = [];
    for (const q of queries) {
      try {
        const hits = await gmailService.searchMessages(q, 5);
        const perMessage: Array<Record<string, unknown>> = [];
        for (const hit of hits) {
          try {
            const msg = await gmailService.getMessage(hit.id);
            const extracted = await gmailService.extractAttendeeEmailFromMessage(hit.id);
            perMessage.push({
              message_id: hit.id,
              thread_id: hit.threadId,
              from: msg.from,
              to: msg.to,
              subject: msg.subject,
              snippet: msg.snippet,
              body_first_400: (msg.body || "").slice(0, 400),
              extracted_email: extracted,
            });
          } catch (msgErr) {
            perMessage.push({
              message_id: hit.id,
              error: String(msgErr),
            });
          }
        }
        gmailResults.push({ query: q, hit_count: hits.length, messages: perMessage });
      } catch (qErr) {
        gmailResults.push({ query: q, error: String(qErr) });
      }
    }
    trace.step2_gmail = gmailResults;

    // Step 3: Zoom meeting settings
    try {
      const settings = await zoomService.getMeetingSettings(meetingId);
      trace.step3_zoom_meeting_settings = settings || "null_or_missing";
    } catch (zErr) {
      trace.step3_zoom_meeting_settings = { error: String(zErr) };
    }

    // Step 3b: Zoom participants (past meeting participant list)
    try {
      const participants = await zoomService.getMeetingParticipants(meetingId);
      trace.step3b_zoom_participants = {
        count: participants.length,
        first_25: participants.slice(0, 25),
      };
    } catch (zErr) {
      trace.step3b_zoom_participants = { error: String(zErr) };
    }

    // Step 4: transcript regex (if we have a transcript stored on the row)
    if (sourceRowId) {
      const { data: row } = await supabase
        .from("webhook_events")
        .select("payload")
        .eq("id", sourceRowId)
        .maybeSingle();
      const transcript = row?.payload?.transcript;
      if (typeof transcript === "string" && transcript.length > 0) {
        const re = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
        const matches = Array.from(new Set((transcript.match(re) || []).map((e) => e.toLowerCase())));
        const external = matches.filter(
          (e) =>
            !e.endsWith(`@${ownDomain}`) &&
            !e.endsWith("@zoom.us") &&
            !e.includes("calendar-notification@google.com")
        );
        trace.step4_transcript = {
          transcript_length: transcript.length,
          all_matches: matches,
          external_matches: external,
          first_external: external[0] || null,
        };
      } else {
        trace.step4_transcript = "no_transcript_text_on_row";
      }
    } else {
      trace.step4_transcript = "no_source_row_passed";
    }

    res.json(trace);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Re-enrich zoom_phone events with LeadMagic (for events that missed enrichment at webhook time)
app.post("/api/re-enrich", async (_req, res) => {
  try {
    const { getSupabase } = await import("./utils/supabase");
    const { enrichContact } = await import("./services/leadmagic");
    const supabase = getSupabase();

    // Get all zoom_phone events that don't have enriched_contact
    const { data: events } = await supabase
      .from("webhook_events")
      .select("id, payload")
      .eq("source", "zoom_phone");

    let enriched = 0;
    let skipped = 0;
    let failed = 0;
    const results: Array<{ id: string; phone: string | null; email: string | null; status: string }> = [];

    for (const event of events || []) {
      // Skip if already enriched
      if (event.payload?.enriched_contact?.email) {
        skipped++;
        continue;
      }

      // Extract phone number from payload (Zoom nested structure: object.caller/callee)
      const obj = (event.payload?.payload as Record<string, unknown>)?.object as Record<string, unknown> | undefined;
      const caller = obj?.caller as Record<string, unknown> | undefined;
      const callee = obj?.callee as Record<string, unknown> | undefined;

      // External party has extension_type "pstn", internal has "user"
      let phone: string | null = null;
      let name = "";
      if (callee?.extension_type === "pstn") {
        phone = (callee?.phone_number || "") as string || null;
        name = (callee?.name || "") as string;
      } else if (caller?.extension_type === "pstn") {
        phone = (caller?.phone_number || "") as string || null;
        name = (caller?.name || "") as string;
      } else {
        // Fallback: try both
        const calleeNum = (callee?.phone_number || "") as string;
        const callerNum = (caller?.phone_number || "") as string;
        phone = calleeNum.length > 6 ? calleeNum : callerNum.length > 6 ? callerNum : null;
        name = (callee?.name || caller?.name || "") as string;
      }

      if (!phone) {
        results.push({ id: event.id, phone: null, email: null, status: "no_phone" });
        failed++;
        continue;
      }

      try {
        const result = await enrichContact({
          phone,
          first_name: name ? name.split(" ")[0] : undefined,
          last_name: name ? name.split(" ").slice(1).join(" ") : undefined,
        });

        if (result.enriched && result.email) {
          // Update the event payload with enriched contact
          const updatedPayload = {
            ...event.payload,
            enriched_contact: {
              email: result.email,
              first_name: result.first_name,
              last_name: result.last_name,
              company: result.company,
              title: result.title,
              linkedin_url: result.linkedin_url,
              phone,
            },
          };
          await supabase
            .from("webhook_events")
            .update({ payload: updatedPayload, processed: false, processed_at: null })
            .eq("id", event.id);
          enriched++;
          results.push({ id: event.id, phone, email: result.email, status: "enriched" });
        } else {
          results.push({ id: event.id, phone, email: null, status: "no_match" });
          failed++;
        }
      } catch (err) {
        results.push({ id: event.id, phone, email: null, status: `error: ${String(err)}` });
        failed++;
      }
    }

    res.json({
      message: `Re-enrichment complete. ${enriched} enriched, ${skipped} already had data, ${failed} no match.`,
      enriched,
      skipped,
      failed,
      total: events?.length || 0,
      sample_results: results.slice(0, 20),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Re-enrich zoom_meeting events: fetch transcripts and AI summaries from Zoom API
app.post("/api/re-enrich-meetings", async (_req, res) => {
  try {
    const { getSupabase } = await import("./utils/supabase");
    const zoomService = await import("./services/zoom");
    const supabase = getSupabase();

    const { data: events } = await supabase
      .from("webhook_events")
      .select("id, payload, event_type")
      .eq("source", "zoom_meeting")
      .neq("event_type", "unknown");

    let transcriptFound = 0;
    let aiSummaryFound = 0;
    let noData = 0;
    let alreadyHad = 0;
    const results: Array<{ id: string; topic: string; transcript: boolean; ai_summary: boolean; ids_tried?: unknown; status: string }> = [];

    for (const event of events || []) {
      const obj = (event.payload?.payload as Record<string, unknown>)?.object as Record<string, unknown> | undefined;
      // Prefer UUID over numeric ID — Zoom recordings API needs UUID for past meetings
      const meetingUuid = obj?.uuid as string | undefined;
      const meetingNumericId = obj?.id as string | number | undefined;
      const meetingId = meetingUuid || meetingNumericId;
      const topic = (obj?.topic || "unknown") as string;

      if (!meetingId) {
        results.push({ id: event.id, topic, transcript: false, ai_summary: false, status: "no_meeting_id" });
        noData++;
        continue;
      }

      // Skip if already has transcript
      if (event.payload?.transcript) {
        alreadyHad++;
        continue;
      }

      try {
        // First check if recording_files are already in the payload (from recording.completed webhook)
        let transcript: string | null = null;
        const recordingFiles = obj?.recording_files as Array<Record<string, unknown>> | undefined;
        if (recordingFiles && recordingFiles.length > 0) {
          const transcriptFile = recordingFiles.find(
            (f) =>
              f.file_type === "TRANSCRIPT" ||
              f.recording_type === "audio_transcript" ||
              f.file_type === "VTT"
          );
          if (transcriptFile?.download_url) {
            try {
              const token = await (await import("./services/zoom")).getZoomAccessToken();
              const resp = await fetch(`${transcriptFile.download_url}?access_token=${token}`);
              if (resp.ok) transcript = await resp.text();
            } catch { /* fall through to API fetch */ }
          }
        }

        // If no transcript from payload, try Zoom API (try UUID first, then numeric ID)
        let aiSummary: { summary_url?: string; summary?: string } | null = null;
        if (!transcript) {
          const idsToTry = meetingUuid
            ? [String(meetingUuid), ...(meetingNumericId ? [String(meetingNumericId)] : [])]
            : [String(meetingId)];

          for (const id of idsToTry) {
            if (transcript) break;
            try {
              transcript = await zoomService.getMeetingTranscript(id);
            } catch { /* try next ID */ }
          }
        }

        // Fetch AI summary
        const summaryId = meetingUuid ? String(meetingUuid) : String(meetingId);
        try {
          aiSummary = await zoomService.getMeetingSummary(summaryId);
        } catch { /* not critical */ }

        const updates: Record<string, unknown> = {};
        let hasUpdate = false;

        if (transcript) {
          updates.transcript = transcript;
          transcriptFound++;
          hasUpdate = true;
        }
        if (aiSummary?.summary_url) {
          updates.zoom_ai_summary_url = aiSummary.summary_url;
          aiSummaryFound++;
          hasUpdate = true;
        }
        if (aiSummary?.summary) {
          updates.zoom_ai_summary = aiSummary.summary;
          hasUpdate = true;
        }

        if (hasUpdate) {
          await supabase
            .from("webhook_events")
            .update({ payload: { ...event.payload, ...updates }, processed: false, processed_at: null })
            .eq("id", event.id);
        }

        results.push({
          id: event.id,
          topic,
          transcript: !!transcript,
          ai_summary: !!aiSummary?.summary_url,
          ids_tried: { uuid: meetingUuid, numeric: meetingNumericId },
          status: hasUpdate ? "updated" : "no_transcript_found",
        });

        if (!hasUpdate) noData++;
      } catch (err) {
        results.push({ id: event.id, topic, transcript: false, ai_summary: false, status: `error: ${String(err)}` });
        noData++;
      }
    }

    res.json({
      message: `Meeting re-enrichment complete. ${transcriptFound} transcripts, ${aiSummaryFound} AI summaries found.`,
      transcriptFound,
      aiSummaryFound,
      alreadyHad,
      noData,
      total: events?.length || 0,
      sample_results: results.slice(0, 20),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// One-time setup: create custom attributes on People object + pipeline
app.get("/api/setup-attio-fields", async (_req, res) => {
  try {
    const config = getConfig();
    const pipelineId = config.ATTIO_PIPELINE_ID;
    const results: Record<string, unknown> = {};

    // --- People object custom fields ---
    const peopleFields = [
      { title: "Company", api_slug: "company", type: "text" },
      { title: "Job Title", api_slug: "job_title", type: "text" },
      { title: "LinkedIn URL", api_slug: "linkedin_url", type: "text" },
      { title: "Lead Source", api_slug: "lead_source", type: "text" },
      { title: "Industry", api_slug: "industry", type: "text" },
    ];

    for (const field of peopleFields) {
      try {
        const resp = await fetch("https://api.attio.com/v2/objects/people/attributes", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.ATTIO_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            data: {
              title: field.title,
              api_slug: field.api_slug,
              type: field.type,
              is_required: false,
              is_unique: false,
              is_multiselect: false,
            },
          }),
        });
        const body = await resp.text();
        if (resp.ok) {
          results[`people.${field.api_slug}`] = { status: "CREATED" };
        } else if (resp.status === 409 || body.includes("already exists")) {
          results[`people.${field.api_slug}`] = { status: "ALREADY_EXISTS" };
        } else {
          results[`people.${field.api_slug}`] = { status: "FAIL", http: resp.status, body };
        }
      } catch (err) {
        results[`people.${field.api_slug}`] = { status: "FAIL", error: String(err) };
      }
    }

    // --- Pipeline (deals) custom fields ---

    const fieldsToCreate = [
      {
        title: "Deal Name",
        api_slug: "deal_name",
        type: "text",
        description: "Name of the deal (e.g. Company - Service)",
        is_required: false,
        is_unique: false,
        is_multiselect: false,
        config: {},
      },
      {
        title: "Deal Value",
        api_slug: "deal_value",
        type: "currency",
        description: "Monthly deal value in USD",
        is_required: false,
        is_unique: false,
        is_multiselect: false,
        config: { currency: { default_currency_code: "USD", display_type: "symbol" } },
      },
      {
        title: "Term Length",
        api_slug: "term_length",
        type: "number",
        description: "Contract term in months",
        is_required: false,
        is_unique: false,
        is_multiselect: false,
        config: {},
      },
    ];

    for (const field of fieldsToCreate) {
      try {
        const resp = await fetch(
          `https://api.attio.com/v2/lists/${pipelineId}/attributes`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.ATTIO_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ data: field }),
          }
        );

        const body = await resp.text();
        if (resp.ok) {
          results[field.api_slug] = { status: "CREATED", response: JSON.parse(body) };
        } else if (resp.status === 409) {
          results[field.api_slug] = { status: "ALREADY_EXISTS" };
        } else {
          results[field.api_slug] = { status: "FAIL", http: resp.status, body };
        }
      } catch (err) {
        results[field.api_slug] = { status: "FAIL", error: String(err) };
      }
    }

    res.json({ message: "Attio field setup complete", fields: results });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Setup Attio pipeline stages
app.get("/api/setup-attio-stages", async (_req, res) => {
  try {
    const config = getConfig();
    const pipelineId = config.ATTIO_PIPELINE_ID;
    const results: Record<string, unknown> = {};

    // First, get existing statuses
    const listResp = await fetch(
      `https://api.attio.com/v2/lists/${pipelineId}`,
      { headers: { Authorization: `Bearer ${config.ATTIO_API_KEY}` } }
    );
    const listData = await listResp.json();
    results.existing_list = listData;

    // Try to get statuses
    const statusResp = await fetch(
      `https://api.attio.com/v2/lists/${pipelineId}/entries/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.ATTIO_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ filter: {}, limit: 1 }),
      }
    );
    const statusData = await statusResp.json();
    results.sample_entry = statusData;

    // Create each stage
    const stages = [
      "Replied / Showed Interest",
      "Call or Meeting Booked",
      "Discovery Completed",
      "Proposal Sent",
      "Negotiating",
      "Closed Won",
      "Closed Lost",
      "Nurture",
    ];

    const stageResults: Record<string, unknown> = {};
    for (const stage of stages) {
      try {
        const resp = await fetch(
          `https://api.attio.com/v2/lists/${pipelineId}/statuses`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.ATTIO_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ data: { title: stage } }),
          }
        );
        const body = await resp.text();
        stageResults[stage] = resp.ok
          ? { status: "CREATED" }
          : { status: resp.status, body };
      } catch (err) {
        stageResults[stage] = { error: String(err) };
      }
    }
    results.stages = stageResults;

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Reprocess events — reset processed events so the cron picks them up again
app.post("/api/reprocess", async (req, res) => {
  try {
    const { getSupabase } = await import("./utils/supabase");
    const supabase = getSupabase();
    const source = req.query.source as string | undefined;

    let query = supabase
      .from("webhook_events")
      .update({ processed: false, processed_at: null })
      .eq("processed", true);

    if (source) {
      query = query.eq("source", source);
    }

    const { error } = await query;
    if (error) throw error;

    res.json({
      message: `Reset events to unprocessed. The cron job will re-process them within 30 seconds.`,
      source: source || "all",
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Force process queue now (don't wait for cron)
app.post("/api/process-now", async (_req, res) => {
  try {
    await processEventQueue();
    res.json({ message: "Event queue processed" });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ============================================================
// Three-phase rebuild: dry-run → wipe → replay.
// Each endpoint is independent; wipe requires confirm=true.
// ============================================================
let rebuildStatus: {
  running: boolean;
  phase?: "dry-run" | "wipe" | "replay";
  result?: unknown;
  error?: string;
} = { running: false };

app.get("/api/rebuild/dry-run", async (_req, res) => {
  try {
    const { dryRun } = await import("./jobs/full-rebuild");
    const report = await dryRun();
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/rebuild/wipe", async (req, res) => {
  if (req.query.confirm !== "true") {
    return res.status(400).json({
      error: "Destructive operation. Retry with ?confirm=true to proceed.",
    });
  }
  if (rebuildStatus.running) {
    return res.status(409).json({ error: "A rebuild phase is already running", status: rebuildStatus });
  }
  rebuildStatus = { running: true, phase: "wipe" };
  res.json({ status: "wipe_started", poll: "/api/rebuild/status" });
  (async () => {
    try {
      const { wipe } = await import("./jobs/full-rebuild");
      rebuildStatus.result = await wipe();
    } catch (err) {
      rebuildStatus.error = err instanceof Error ? err.message : String(err);
    } finally {
      rebuildStatus.running = false;
    }
  })();
});

app.post("/api/rebuild/replay", async (_req, res) => {
  if (rebuildStatus.running) {
    return res.status(409).json({ error: "A rebuild phase is already running", status: rebuildStatus });
  }
  rebuildStatus = { running: true, phase: "replay" };
  res.json({ status: "replay_started", poll: "/api/rebuild/status" });
  (async () => {
    try {
      const { replay } = await import("./jobs/full-rebuild");
      rebuildStatus.result = await replay();
    } catch (err) {
      rebuildStatus.error = err instanceof Error ? err.message : String(err);
    } finally {
      rebuildStatus.running = false;
    }
  })();
});

app.get("/api/rebuild/status", (_req, res) => {
  res.json(rebuildStatus);
});

// Legacy route removed — use /api/rebuild/{dry-run,wipe,replay} instead.
app.post("/api/full-rebuild", (_req, res) => {
  res.status(410).json({
    error: "Deprecated",
    use: ["/api/rebuild/dry-run", "/api/rebuild/wipe?confirm=true", "/api/rebuild/replay"],
  });
});

app.get("/api/rebuild-status", async (_req, res) => {
  const { getSupabase } = await import("./utils/supabase");
  const supabase = getSupabase();
  const config = getConfig();

  const { count: processedCount } = await supabase.from("webhook_events").select("*", { count: "exact", head: true }).eq("processed", true);
  const { count: unprocessedCount } = await supabase.from("webhook_events").select("*", { count: "exact", head: true }).eq("processed", false);

  let attio: Record<string, unknown> = {};
  try {
    const peopleResp = await fetch("https://api.attio.com/v2/objects/people/records/query", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.ATTIO_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 500 }),
    });
    if (peopleResp.ok) {
      const p = await peopleResp.json() as { data: unknown[] };
      attio.people_count = p.data?.length || 0;
    }
    if (config.ATTIO_PIPELINE_ID) {
      const dealsResp = await fetch(`https://api.attio.com/v2/lists/${config.ATTIO_PIPELINE_ID}/entries/query`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.ATTIO_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 1 }),
      });
      if (dealsResp.ok) {
        const d = await dealsResp.json() as { data: unknown[] };
        attio.deals_count = d.data?.length || 0;
      }
    }
  } catch { /* ignore */ }

  res.json({
    rebuild: rebuildStatus,
    events: { processed: processedCount, unprocessed: unprocessedCount },
    attio,
  });
});

// Start server
const config = getConfig();
const port = parseInt(config.PORT, 10);

app.listen(port, () => {
  logger.info(`CRM Autopilot webhook server running on port ${port}`);
  logger.info(`Review mode: ${config.REVIEW_MODE ? "ON" : "OFF"}`);

  // Ensure Attio custom fields exist on startup
  ensureAttioFieldsExist().catch((err) =>
    logger.warn("Attio field setup failed on startup (will retry on first use)", { error: String(err) })
  );
});

// --- Gmail Watch Setup ---
// Gmail push notifications expire every 7 days, so set up on boot and renew daily
setupGmailWatch().catch((err) =>
  logger.warn("Gmail watch setup failed (will retry via cron)", { error: String(err) })
);

// --- One-time startup backfill (DISABLED — use POST /api/backfill/all manually) ---
// Was burning too many API credits running automatically.
// To run manually: POST /api/backfill/all then POST /api/process-now
// setTimeout(() => {
//   runStartupBackfill().catch((err) =>
//     logger.error("Startup backfill failed", { error: String(err) })
//   );
// }, 5000);

// --- Background Jobs ---

// Process event queue every 30 seconds
// Tracks consecutive AI failures to back off when rate-limited
let consecutiveAiFailures = 0;
cron.schedule("*/30 * * * * *", async () => {
  // Back off if AI is rate-limited (exponential: 1 skip, 2 skips, 4 skips... up to 60 = ~30 min)
  if (consecutiveAiFailures > 0) {
    const skipCycles = Math.min(Math.pow(2, consecutiveAiFailures - 1), 60);
    consecutiveAiFailures++;
    if (consecutiveAiFailures % skipCycles !== 0) {
      return; // skip this cycle
    }
  }
  try {
    await processEventQueue();
    consecutiveAiFailures = 0; // reset on success
  } catch (err) {
    const errMsg = String(err);
    if (errMsg.includes("429") || errMsg.includes("quota") || errMsg.includes("rate")) {
      consecutiveAiFailures++;
      logger.warn("AI rate limited, backing off", { failures: consecutiveAiFailures });
    } else {
      logger.error("Event queue processing failed", { error: errMsg });
    }
  }
});

// Run nurture check every hour
cron.schedule("0 * * * *", async () => {
  try {
    await runNurtureCheck();
  } catch (err) {
    logger.error("Nurture check failed", { error: String(err) });
  }
});

// Renew Gmail watch daily (expires every 7 days)
cron.schedule("0 3 * * *", async () => {
  try {
    await setupGmailWatch();
    logger.info("Gmail watch renewed");
  } catch (err) {
    logger.error("Gmail watch renewal failed", { error: String(err) });
  }
});

logger.info("Background jobs scheduled:");
logger.info("  Event queue processing: every 30 seconds");
logger.info("  Nurture engine: every hour");
logger.info("  Gmail watch renewal: daily at 3 AM");
