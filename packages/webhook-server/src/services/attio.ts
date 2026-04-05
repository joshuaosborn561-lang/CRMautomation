import { getConfig } from "../config";
import { logger } from "../utils/logger";
import type {
  AttioContact,
  AttioDeal,
  AttioNote,
  AttioTask,
  DealStage,
} from "@crm-autopilot/shared";

const ATTIO_BASE_URL = "https://api.attio.com/v2";

// Map our deal stages to Attio pipeline stage names
// These must match the stage names configured in your Attio pipeline
const STAGE_MAP: Record<DealStage, string> = {
  replied_showed_interest: "Replied / Showed Interest",
  call_meeting_booked: "Call or Meeting Booked",
  discovery_completed: "Discovery Completed",
  proposal_sent: "Proposal Sent",
  negotiating: "Negotiating",
  closed_won: "Closed Won",
  closed_lost: "Closed Lost",
  nurture: "Nurture",
};

async function attioFetch(
  path: string,
  options: RequestInit = {}
): Promise<unknown> {
  const config = getConfig();
  const url = `${ATTIO_BASE_URL}${path}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.ATTIO_API_KEY}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    logger.error("Attio API error", {
      status: response.status,
      path,
      body,
    });
    throw new Error(`Attio API error: ${response.status} ${body}`);
  }

  return response.json();
}

// --- Field Setup (ensure custom attributes exist before we use them) ---

let _fieldsEnsured = false;

export async function ensureAttioFieldsExist(): Promise<void> {
  if (_fieldsEnsured) return;

  const config = getConfig();
  const headers = {
    Authorization: `Bearer ${config.ATTIO_API_KEY}`,
    "Content-Type": "application/json",
  };

  // 1. Create custom attributes on People object
  // NOTE: company (record-reference), job_title (text), linkedin (text) are BUILT-IN — do NOT recreate
  // Only create truly custom fields that don't exist yet
  const peopleFields = [
    { title: "Lead Source", api_slug: "lead_source", type: "text" },
    { title: "Industry", api_slug: "industry", type: "text" },
  ];

  for (const field of peopleFields) {
    try {
      const resp = await fetch(`${ATTIO_BASE_URL}/objects/people/attributes`, {
        method: "POST",
        headers,
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
      if (resp.ok) {
        logger.info(`Created Attio People field: ${field.api_slug}`);
      } else {
        const body = await resp.text();
        if (resp.status === 409 || body.includes("already") || body.includes("exists")) {
          // Already exists — fine
        } else {
          logger.warn(`Failed to create People field ${field.api_slug}: ${resp.status} ${body}`);
        }
      }
    } catch (err) {
      logger.warn(`Error creating People field ${field.api_slug}`, { error: String(err) });
    }
  }

  // 2. Create pipeline attributes (deal fields)
  const pipelineId = config.ATTIO_PIPELINE_ID;
  if (pipelineId) {
    const pipelineFields = [
      { title: "Deal Name", api_slug: "deal_name", type: "text" },
      { title: "Deal Value", api_slug: "deal_value", type: "number" },
      { title: "Term Length", api_slug: "term_length", type: "number" },
    ];

    for (const field of pipelineFields) {
      try {
        const resp = await fetch(`${ATTIO_BASE_URL}/lists/${pipelineId}/attributes`, {
          method: "POST",
          headers,
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
        if (resp.ok) {
          logger.info(`Created Attio pipeline field: ${field.api_slug}`);
        } else {
          const body = await resp.text();
          if (resp.status === 409 || body.includes("already") || body.includes("exists")) {
            // Already exists
          } else {
            logger.warn(`Failed to create pipeline field ${field.api_slug}: ${resp.status} ${body}`);
          }
        }
      } catch (err) {
        logger.warn(`Error creating pipeline field ${field.api_slug}`, { error: String(err) });
      }
    }

    // 3. Create pipeline stages
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

    // Get existing statuses first
    try {
      const listResp = await fetch(`${ATTIO_BASE_URL}/lists/${pipelineId}`, {
        headers: { Authorization: `Bearer ${config.ATTIO_API_KEY}` },
      });
      if (listResp.ok) {
        const listData = await listResp.json() as { data?: { statuses?: Array<{ title: string }> } };
        const existingStages = (listData.data?.statuses || []).map(s => s.title);
        const missingStages = stages.filter(s => !existingStages.includes(s));
        if (missingStages.length > 0) {
          logger.info(`Missing pipeline stages: ${missingStages.join(", ")}. You may need to create these manually in Attio.`);
        } else {
          logger.info("All pipeline stages exist");
        }
      }
    } catch (err) {
      logger.warn("Could not check pipeline stages", { error: String(err) });
    }
  }

  _fieldsEnsured = true;
  logger.info("Attio field setup complete");
}

// --- Contacts ---

export async function findContact(email: string): Promise<{ id: string } | null> {
  const result = (await attioFetch("/objects/people/records/query", {
    method: "POST",
    body: JSON.stringify({
      filter: {
        email_addresses: { contains: email },
      },
    }),
  })) as { data: Array<{ id: { record_id: string } }> };

  if (result.data.length > 0) {
    return { id: result.data[0].id.record_id };
  }
  return null;
}

export async function createContact(contact: AttioContact & { title?: string; lead_source?: string; industry?: string }): Promise<string> {
  // Build values using correct Attio field formats
  // (from /api/debug/test-attio-write: company=record-reference, job_title=text, linkedin=text)
  const values: Record<string, unknown> = {};

  if (contact.email && contact.email !== "unknown" && contact.email.includes("@")) {
    values.email_addresses = [{ email_address: contact.email }];
  }
  if (contact.first_name || contact.last_name) {
    values.name = [{
      first_name: contact.first_name || "",
      last_name: contact.last_name || "",
      full_name: `${contact.first_name || ""} ${contact.last_name || ""}`.trim(),
    }];
  }
  if (contact.phone) values.phone_numbers = [{ original_phone_number: contact.phone }];

  // Built-in text fields (these already exist on People object)
  if (contact.title) values.job_title = contact.title;
  if (contact.linkedin_url) values.linkedin = contact.linkedin_url;

  // "company" is a record-reference — must create/find company record first
  let companyId: string | null = null;
  if (contact.company) {
    try {
      companyId = await findOrCreateCompany(contact.company);
      values.company = [{ target_object: "companies", target_record_id: companyId }];
    } catch (err) {
      logger.warn("Could not create/find company, skipping company field", {
        company: contact.company,
        error: String(err),
      });
    }
  }

  // Use matching_attribute for built-in dedup:
  // - If contact has email, match on email (prevents duplicates)
  // - Attio will update existing record or create new one
  const data: Record<string, unknown> = { values };
  if (values.email_addresses) {
    data.matching_attribute = "email_addresses";
  }

  const result = (await attioFetch("/objects/people/records", {
    method: "POST",
    body: JSON.stringify({ data }),
  })) as { data: { id: { record_id: string } } };

  logger.info("Upserted Attio contact", {
    email: contact.email,
    name: `${contact.first_name} ${contact.last_name}`,
    company: contact.company,
    id: result.data.id.record_id,
  });
  return result.data.id.record_id;
}

export async function findContactByName(firstName: string, lastName: string): Promise<{ id: string } | null> {
  try {
    const result = (await attioFetch("/objects/people/records/query", {
      method: "POST",
      body: JSON.stringify({
        filter: {
          name: { full_name: { contains: `${firstName} ${lastName}`.trim() } },
        },
      }),
    })) as { data: Array<{ id: { record_id: string } }> };

    if (result.data.length > 0) {
      return { id: result.data[0].id.record_id };
    }
  } catch (err) {
    logger.warn("Name-based contact search failed", { error: String(err) });
  }
  return null;
}

export async function findOrCreateContact(contact: AttioContact & { title?: string; lead_source?: string; industry?: string }): Promise<string> {
  // Try finding by email first
  if (contact.email && contact.email !== "unknown") {
    const existing = await findContact(contact.email);
    if (existing) {
      logger.info("Found existing Attio contact by email", { email: contact.email, id: existing.id });
      return existing.id;
    }
  }

  // Try finding by name (prevents duplicates for contacts without email)
  if (contact.first_name && contact.last_name) {
    const existing = await findContactByName(contact.first_name, contact.last_name);
    if (existing) {
      logger.info("Found existing Attio contact by name", {
        name: `${contact.first_name} ${contact.last_name}`,
        id: existing.id,
      });
      return existing.id;
    }
  }

  return createContact(contact);
}

// --- Companies ---

export async function findOrCreateCompany(name: string): Promise<string> {
  // Use Attio's upsert: matching_attribute finds existing by name or creates new
  try {
    const result = (await attioFetch("/objects/companies/records", {
      method: "POST",
      body: JSON.stringify({
        data: {
          values: { name: [{ value: name }] },
          matching_attribute: "name",
        },
      }),
    })) as { data: { id: { record_id: string } } };

    logger.info("Found/created Attio company", { name, id: result.data.id.record_id });
    return result.data.id.record_id;
  } catch (err) {
    // Fallback: try without matching_attribute (just create)
    logger.warn("Company upsert failed, creating new", { name, error: String(err) });
    const created = (await attioFetch("/objects/companies/records", {
      method: "POST",
      body: JSON.stringify({
        data: {
          values: { name: [{ value: name }] },
        },
      }),
    })) as { data: { id: { record_id: string } } };

    logger.info("Created Attio company", { name, id: created.data.id.record_id });
    return created.data.id.record_id;
  }
}

// --- Deals ---

export async function findDealByContact(contactId: string): Promise<{ id: string; stage: string } | null> {
  const config = getConfig();
  const pipelineId = config.ATTIO_PIPELINE_ID;
  if (!pipelineId) return null;

  const result = (await attioFetch(`/lists/${pipelineId}/entries/query`, {
    method: "POST",
    body: JSON.stringify({
      filter: {},
    }),
  })) as {
    data: Array<{
      entry_id: string;
      parent_record_id: string;
      current_status?: { title: string };
    }>;
  };

  const entry = result.data.find((e) => e.parent_record_id === contactId);
  if (entry) {
    return {
      id: entry.entry_id,
      stage: entry.current_status?.title || "unknown",
    };
  }
  return null;
}

// Cache the pipeline's parent_object so we only fetch it once
let _pipelineParentObject: string | null = null;

async function getPipelineParentObject(): Promise<string> {
  if (_pipelineParentObject) return _pipelineParentObject;
  const config = getConfig();
  const pipelineId = config.ATTIO_PIPELINE_ID;
  if (!pipelineId) return "people";
  try {
    const resp = await fetch(`${ATTIO_BASE_URL}/lists/${pipelineId}`, {
      headers: { Authorization: `Bearer ${config.ATTIO_API_KEY}` },
    });
    if (resp.ok) {
      const data = await resp.json() as { data?: { parent_object?: string } };
      _pipelineParentObject = data.data?.parent_object || "people";
      logger.info("Pipeline parent_object", { parent: _pipelineParentObject });
      return _pipelineParentObject;
    }
  } catch {
    // fallback
  }
  return "people";
}

export async function createDeal(deal: AttioDeal & { value?: number; term_months?: number }): Promise<string> {
  const config = getConfig();
  const pipelineId = config.ATTIO_PIPELINE_ID;
  if (!pipelineId) throw new Error("ATTIO_PIPELINE_ID not configured");

  const parentObject = await getPipelineParentObject();
  const stageName = STAGE_MAP[deal.stage];

  const entryValues: Record<string, unknown> = {};
  if (deal.name) {
    entryValues.deal_name = [{ value: deal.name }];
  }
  if (deal.value) {
    entryValues.deal_value = [{ currency_value: deal.value, currency_code: "USD" }];
  }
  if (deal.term_months) {
    entryValues.term_length = [{ value: deal.term_months }];
  }

  // entry_values MUST be an object (not undefined) — Attio requires it
  let result: { data: { entry_id: string } };
  try {
    result = (await attioFetch(`/lists/${pipelineId}/entries`, {
      method: "POST",
      body: JSON.stringify({
        data: {
          parent_object: parentObject,
          parent_record_id: deal.contact_id,
          entry_values: entryValues,
          current_status_title: stageName,
        },
      }),
    })) as { data: { entry_id: string } };
  } catch (err) {
    // Custom entry_values or stage might not exist — try with just empty values + stage
    logger.warn("Deal creation failed, retrying with empty values", {
      stage: stageName,
      error: String(err),
    });
    try {
      result = (await attioFetch(`/lists/${pipelineId}/entries`, {
        method: "POST",
        body: JSON.stringify({
          data: {
            parent_object: parentObject,
            parent_record_id: deal.contact_id,
            entry_values: {},
            current_status_title: stageName,
          },
        }),
      })) as { data: { entry_id: string } };
    } catch (err2) {
      // Stage name might not exist either — bare minimum with empty entry_values
      logger.warn("Deal creation failed with stage too, retrying bare minimum", {
        stage: stageName,
        error: String(err2),
      });
      result = (await attioFetch(`/lists/${pipelineId}/entries`, {
        method: "POST",
        body: JSON.stringify({
          data: {
            parent_object: parentObject,
            parent_record_id: deal.contact_id,
            entry_values: {},
          },
        }),
      })) as { data: { entry_id: string } };
    }
  }

  logger.info("Created Attio deal", {
    name: deal.name,
    stage: stageName,
    value: deal.value,
    term_months: deal.term_months,
    id: result.data.entry_id,
  });
  return result.data.entry_id;
}

export async function updateDealStage(dealId: string, stage: DealStage): Promise<void> {
  const config = getConfig();
  const pipelineId = config.ATTIO_PIPELINE_ID;
  if (!pipelineId) throw new Error("ATTIO_PIPELINE_ID not configured");

  const stageName = STAGE_MAP[stage];

  try {
    await attioFetch(`/lists/${pipelineId}/entries/${dealId}`, {
      method: "PATCH",
      body: JSON.stringify({
        data: {
          current_status_title: stageName,
        },
      }),
    });
    logger.info("Updated Attio deal stage", { dealId, stage: stageName });
  } catch (err) {
    logger.warn("Failed to update deal stage (stage may not exist in Attio)", {
      dealId,
      stage: stageName,
      error: String(err),
    });
  }
}

// --- Notes ---

export async function createNote(note: AttioNote): Promise<void> {
  await attioFetch("/notes", {
    method: "POST",
    body: JSON.stringify({
      data: {
        parent_object: note.parent_object === "deals" ? "lists" : "people",
        parent_record_id: note.parent_id,
        title: note.title,
        content: [
          {
            type: "paragraph",
            children: [{ text: note.content }],
          },
        ],
      },
    }),
  });

  logger.info("Created Attio note", { parentId: note.parent_id, title: note.title });
}

// --- Tasks ---

export async function createTask(task: AttioTask): Promise<void> {
  await attioFetch("/tasks", {
    method: "POST",
    body: JSON.stringify({
      data: {
        content: task.title,
        deadline: task.due_date || null,
        is_completed: false,
        linked_records: task.linked_deal_id
          ? [{ target_record_id: task.linked_deal_id }]
          : [],
      },
    }),
  });

  logger.info("Created Attio task", { title: task.title });
}

// --- Query helpers ---

export async function getAllDeals(): Promise<
  Array<{
    entry_id: string;
    parent_record_id: string;
    values: Record<string, unknown>;
    current_status?: { title: string };
  }>
> {
  const config = getConfig();
  const pipelineId = config.ATTIO_PIPELINE_ID;
  if (!pipelineId) return [];

  const result = (await attioFetch(`/lists/${pipelineId}/entries/query`, {
    method: "POST",
    body: JSON.stringify({ filter: {} }),
  })) as { data: Array<Record<string, unknown>> };

  return result.data as ReturnType<typeof getAllDeals> extends Promise<infer T> ? T : never;
}
