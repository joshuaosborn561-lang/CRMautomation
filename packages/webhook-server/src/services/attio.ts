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
  const values: Record<string, unknown> = {};
  // Only add email if it's a real email
  if (contact.email && contact.email !== "unknown" && contact.email.includes("@")) {
    values.email_addresses = [{ email_address: contact.email }];
  }
  // Attio uses a single "name" attribute with first_name/last_name subfields
  if (contact.first_name || contact.last_name) {
    values.name = [{
      first_name: contact.first_name || "",
      last_name: contact.last_name || "",
      full_name: `${contact.first_name || ""} ${contact.last_name || ""}`.trim(),
    }];
  }
  if (contact.phone) values.phone_numbers = [{ original_phone_number: contact.phone }];
  // Custom fields on People object
  if (contact.company) values.company = contact.company;
  if (contact.linkedin_url) values.linkedin_url = contact.linkedin_url;
  if (contact.title) values.job_title = contact.title;
  if (contact.lead_source) values.lead_source = contact.lead_source;
  if (contact.industry) values.industry = contact.industry;

  const result = (await attioFetch("/objects/people/records", {
    method: "POST",
    body: JSON.stringify({ data: { values } }),
  })) as { data: { id: { record_id: string } } };

  logger.info("Created Attio contact", { email: contact.email, id: result.data.id.record_id });
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
  const result = (await attioFetch("/objects/companies/records/query", {
    method: "POST",
    body: JSON.stringify({
      filter: { name: { contains: name } },
    }),
  })) as { data: Array<{ id: { record_id: string } }> };

  if (result.data.length > 0) {
    return result.data[0].id.record_id;
  }

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

export async function createDeal(deal: AttioDeal & { value?: number; term_months?: number }): Promise<string> {
  const config = getConfig();
  const pipelineId = config.ATTIO_PIPELINE_ID;
  if (!pipelineId) throw new Error("ATTIO_PIPELINE_ID not configured");

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

  // Try with stage first, fall back to no stage if it fails
  let result: { data: { entry_id: string } };
  try {
    result = (await attioFetch(`/lists/${pipelineId}/entries`, {
      method: "POST",
      body: JSON.stringify({
        data: {
          parent_object: "people",
          parent_record_id: deal.contact_id,
          entry_values: Object.keys(entryValues).length > 0 ? entryValues : undefined,
          current_status_title: stageName,
        },
      }),
    })) as { data: { entry_id: string } };
  } catch (err) {
    // Stage name might not exist — retry without it
    logger.warn("Deal creation failed with stage, retrying without", {
      stage: stageName,
      error: String(err),
    });
    result = (await attioFetch(`/lists/${pipelineId}/entries`, {
      method: "POST",
      body: JSON.stringify({
        data: {
          parent_object: "people",
          parent_record_id: deal.contact_id,
          entry_values: Object.keys(entryValues).length > 0 ? entryValues : undefined,
        },
      }),
    })) as { data: { entry_id: string } };
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
