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
// Track which custom fields actually exist in Attio (confirmed after creation/check)
const _confirmedCustomFields = new Set<string>();

export function resetFieldsCache(): void {
    _fieldsEnsured = false;
    _dealStageOptions = null;
    _workspaceMemberId = null;
    _pipelineParentObject = null;
    _confirmedCustomFields.clear();
}

export function resetDedupeCache(): void {
    _contactCacheByEmail.clear();
    _contactCacheByName.clear();
    _companyCache.clear();
}

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

  // First, get all existing People attributes to see what's there
  try {
        const existingResp = await fetch(`${ATTIO_BASE_URL}/objects/people/attributes`, {
                headers: { Authorization: `Bearer ${config.ATTIO_API_KEY}` },
        });
        if (existingResp.ok) {
                const existingData = await existingResp.json() as { data: Array<{ api_slug: string }> };
                const existingSlugs = new Set((existingData.data || []).map(a => a.api_slug));
                logger.info("Existing People attributes", { slugs: [...existingSlugs].join(", ") });
                // Mark already-existing custom fields as confirmed
          for (const field of peopleFields) {
                    if (existingSlugs.has(field.api_slug)) {
                                _confirmedCustomFields.add(field.api_slug);
                                logger.info(`Custom field already exists: ${field.api_slug}`);
                    }
          }
        }
  } catch (err) {
        logger.warn("Could not list existing People attributes", { error: String(err) });
  }

  // Create any missing custom fields
  for (const field of peopleFields) {
        if (_confirmedCustomFields.has(field.api_slug)) continue; // already exists
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
                        _confirmedCustomFields.add(field.api_slug);
              } else {
                        const body = await resp.text();
                        if (resp.status === 409 || body.includes("already") || body.includes("exists")) {
                                    // If 409, the field likely exists but wasn't in the list — mark as confirmed anyway
                          logger.info(`People field ${field.api_slug} already exists (409)`);
                                    _confirmedCustomFields.add(field.api_slug);
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
    }

  // 3. Ensure deal stage statuses exist on the Deals object's "stage" attribute
  try {
        const listResp = await fetch(`${ATTIO_BASE_URL}/objects/deals/attributes/stage/statuses`, {
                headers: { Authorization: `Bearer ${config.ATTIO_API_KEY}` },
        });
        let existingTitles: string[] = [];
        if (listResp.ok) {
                const listData = await listResp.json() as { data: Array<{ title: string }> };
                existingTitles = (listData.data || []).map(s => s.title);
                logger.info("Existing deal stage statuses", { statuses: existingTitles });
        }

      const desiredStages = [
              "Open",
              "Replied / Showed Interest",
              "Call or Meeting Booked",
              "Discovery Completed",
              "Proposal Sent",
              "Negotiating",
              "Closed Won",
              "Closed Lost",
              "Nurture",
            ];

      const missingStages = desiredStages.filter(s => !existingTitles.includes(s));
        if (missingStages.length > 0) {
                logger.info("Creating missing deal stage statuses", { missing: missingStages });
                for (const title of missingStages) {
                          try {
                                      const createResp = await fetch(`${ATTIO_BASE_URL}/objects/deals/attributes/stage/statuses`, {
                                                    method: "POST",
                                                    headers,
                                                    body: JSON.stringify({
                                                                    data: {
                                                                                      title,
                                                                                      celebration_enabled: title === "Closed Won",
                                                                    },
                                                    }),
                                      });
                                      if (createResp.ok) {
                                                    logger.info(`Created deal stage status: ${title}`);
                                      } else {
                                                    const body = await createResp.text();
                                                    if (createResp.status === 409 || body.includes("already") || body.includes("exists")) {
                                                                    // Already exists
                                                    } else {
                                                                    logger.warn(`Failed to create deal stage status: ${title}`, { status: createResp.status, body });
                                                    }
                                      }
                          } catch (err) {
                                      logger.warn(`Error creating deal stage status: ${title}`, { error: String(err) });
                          }
                }
                _dealStageOptions = null; // reset cache
        } else {
                logger.info("All deal stage statuses already exist");
        }
  } catch (err) {
        logger.warn("Could not check/create deal stage statuses", { error: String(err) });
  }

  _fieldsEnsured = true;
    logger.info("Attio field setup complete", { confirmedCustomFields: [..._confirmedCustomFields] });
}

// --- Contacts ---

// Find contact by email — uses full fetch + in-code filter to avoid Attio filter syntax issues
export async function findContact(email: string): Promise<{ id: string } | null> {
    if (!email || !email.includes("@")) return null;
    const emailLower = email.toLowerCase();

  try {
        // Use Attio's matching_attribute upsert with no-op values to find by email
      // Actually, safer: query all people and match email in code (small dataset)
      // This avoids Attio's complex email-address filter syntax
      const result = (await attioFetch("/objects/people/records/query", {
              method: "POST",
              body: JSON.stringify({ limit: 500 }),
      })) as { data: Array<{ id: { record_id: string }; values: Record<string, unknown> }> };

      for (const person of result.data) {
              const emails = person.values?.email_addresses as Array<{ email_address?: string }> | undefined;
              if (emails?.some(e => e.email_address?.toLowerCase() === emailLower)) {
                        return { id: person.id.record_id };
              }
      }
  } catch (err) {
        logger.warn("findContact query failed", { email, error: String(err) });
  }
    return null;
}

export async function createContact(contact: AttioContact & { title?: string; lead_source?: string; industry?: string }): Promise<string> {
    // Build values using correct Attio field formats
  const values: Record<string, unknown> = {};

  if (contact.email && contact.email !== "unknown" && contact.email.includes("@")) {
        values.email_addresses = [{ email_address: contact.email }];
  }

  if (contact.first_name || contact.last_name) {
        const first = normalizeName(contact.first_name || "");
        const last = normalizeName(contact.last_name || "");
        values.name = [{ first_name: first, last_name: last, full_name: `${first} ${last}`.trim() }];
  }

  if (contact.phone) values.phone_numbers = [{ original_phone_number: contact.phone }];
    if (contact.title) values.job_title = contact.title;
    if (contact.linkedin_url) values.linkedin = contact.linkedin_url;

  // Only include custom fields if we've confirmed they exist in Attio
  if (contact.lead_source && _confirmedCustomFields.has("lead_source")) {
        values.lead_source = contact.lead_source;
  }
    if (contact.industry && _confirmedCustomFields.has("industry")) {
          values.industry = contact.industry;
    }

  // "company" is a record-reference — must create/find company record first
  if (contact.company) {
        try {
                const companyId = await findOrCreateCompany(contact.company);
                values.company = [{ target_object: "companies", target_record_id: companyId }];
        } catch (err) {
                logger.warn("Could not create/find company, skipping company field", {
                          company: contact.company,
                          error: String(err),
                });
        }
  }

  const data: Record<string, unknown> = { values };
    if (values.email_addresses) {
          data.matching_attribute = "email_addresses";
    }

  logger.info("Creating/upserting Attio contact", {
        email: contact.email,
        name: `${contact.first_name} ${contact.last_name}`,
        company: contact.company,
        hasEmail: !!values.email_addresses,
        customFields: Object.keys(values).filter(k => _confirmedCustomFields.has(k)),
  });

  try {
        const result = (await attioFetch("/objects/people/records", {
                method: "POST",
                body: JSON.stringify({ data }),
        })) as { data: { id: { record_id: string } } };

      logger.info("Upserted Attio contact", {
              email: contact.email,
              name: `${contact.first_name} ${contact.last_name}`,
              id: result.data.id.record_id,
      });
        return result.data.id.record_id;
  } catch (err) {
        // If custom fields caused failure, retry without them
      const errMsg = String(err);
        if (errMsg.includes("value_not_found") || errMsg.includes("Cannot find attribute")) {
                logger.warn("Contact creation failed with custom fields, retrying without them", { error: errMsg });
                // Remove custom fields
          delete values.lead_source;
                delete values.industry;
                const retryResult = (await attioFetch("/objects/people/records", {
                          method: "POST",
                          body: JSON.stringify({ data: { ...data, values } }),
                })) as { data: { id: { record_id: string } } };
                logger.info("Upserted Attio contact (without custom fields)", {
                          email: contact.email,
                          id: retryResult.data.id.record_id,
                });
                return retryResult.data.id.record_id;
        }
        throw err;
  }
}

// Normalize name to Title Case for consistent matching
function normalizeName(name: string): string {
    return name.trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

export async function findContactByName(firstName: string, lastName: string): Promise<{ id: string; hasEmail: boolean } | null> {
    const searchName = normalizeName(`${firstName} ${lastName}`.trim());
    if (!searchName) return null;

  try {
        const result = (await attioFetch("/objects/people/records/query", {
              method: "POST",
              body: JSON.stringify({ limit: 500 }),
      })) as { data: Array<{ id: { record_id: string }; values: Record<string, unknown> }> };

      const searchLower = searchName.toLowerCase();
        for (const person of result.data) {
                const nameValues = person.values?.name as Array<{ full_name?: string; first_name?: string; last_name?: string }> | undefined;
                if (nameValues) {
                          for (const nv of nameValues) {
                                      const fullName = (nv.full_name || `${nv.first_name || ""} ${nv.last_name || ""}`).trim().toLowerCase();
                                      if (fullName === searchLower) {
                                                    const emails = person.values?.email_addresses as Array<unknown> | undefined;
                                                    return { id: person.id.record_id, hasEmail: !!(emails && emails.length > 0) };
                                      }
                          }
                }
        }
  } catch (err) {
        logger.warn("findContactByName query failed", { name: searchName, error: String(err) });
  }
    return null;
}

// In-memory contact cache: email → recordId and name → recordId
const _contactCacheByEmail = new Map<string, string>();
const _contactCacheByName = new Map<string, string>();

export async function findOrCreateContact(contact: AttioContact & { title?: string; lead_source?: string; industry?: string }): Promise<string> {
    const email = contact.email && contact.email !== "unknown" && contact.email.includes("@") ? contact.email.toLowerCase() : null;
    const fullName = contact.first_name && contact.last_name
      ? normalizeName(`${contact.first_name} ${contact.last_name}`)
          : null;

  // RULE: email is ground truth. If we have an email, ONLY match by email.
  // Two records with different emails are ALWAYS different people, even if names match.
  if (email) {
        if (_contactCacheByEmail.has(email)) {
              const cachedId = _contactCacheByEmail.get(email)!;
              logger.info("Contact found in cache by email", { email, id: cachedId });
              await updateExistingContact(cachedId, contact);
              return cachedId;
        }
        const existing = await findContact(email);
        if (existing) {
              logger.info("Found existing Attio contact by email — updating", { email, id: existing.id });
              _contactCacheByEmail.set(email, existing.id);
              if (fullName) _contactCacheByName.set(fullName, existing.id);
              await updateExistingContact(existing.id, contact);
              return existing.id;
        }
        // Email provided but not found anywhere → create new. Do NOT name-match.
        const newId = await createContact(contact);
        _contactCacheByEmail.set(email, newId);
        if (fullName) _contactCacheByName.set(fullName, newId);
        return newId;
  }

  // No email → fall back to name matching, but only to records that ALSO have no email
  // (so we don't silently merge a no-email new contact onto someone with a different email).
  if (fullName && _contactCacheByName.has(fullName)) {
        const cachedId = _contactCacheByName.get(fullName)!;
        logger.info("Contact found in cache by name", { name: fullName, id: cachedId });
        await updateExistingContact(cachedId, contact);
        return cachedId;
  }

  if (contact.first_name && contact.last_name) {
        const existing = await findContactByName(contact.first_name, contact.last_name);
        if (existing && !existing.hasEmail) {
              logger.info("Found existing Attio contact by name (no email conflict) — updating", { name: fullName, id: existing.id });
              if (fullName) _contactCacheByName.set(fullName, existing.id);
              await updateExistingContact(existing.id, contact);
              return existing.id;
        }
        if (existing && existing.hasEmail) {
              logger.info("Name match found but existing record has email — creating new record to avoid merging different people", { name: fullName });
        }
  }

  // Create new contact
  const newId = await createContact(contact);
    if (fullName) _contactCacheByName.set(fullName, newId);
    return newId;
}

// Update an existing contact with any new data we have
async function updateExistingContact(
    recordId: string,
    contact: AttioContact & { title?: string; lead_source?: string; industry?: string }
  ): Promise<void> {
    const values: Record<string, unknown> = {};

  if (contact.email && contact.email !== "unknown" && contact.email.includes("@")) {
        values.email_addresses = [{ email_address: contact.email }];
  }
    if (contact.phone) values.phone_numbers = [{ original_phone_number: contact.phone }];
    if (contact.title) values.job_title = contact.title;
    if (contact.linkedin_url) values.linkedin = contact.linkedin_url;

  // Only include custom fields if confirmed
  if (contact.lead_source && _confirmedCustomFields.has("lead_source")) {
        values.lead_source = contact.lead_source;
  }
    if (contact.industry && _confirmedCustomFields.has("industry")) {
          values.industry = contact.industry;
    }

  if (contact.company) {
        try {
                const companyId = await findOrCreateCompany(contact.company);
                values.company = [{ target_object: "companies", target_record_id: companyId }];
        } catch (err) {
                logger.warn("Could not set company on update", { error: String(err) });
        }
  }

  if (Object.keys(values).length === 0) return;

  try {
        await attioFetch(`/objects/people/records/${recordId}`, {
                method: "PATCH",
                body: JSON.stringify({ data: { values } }),
        });
        logger.info("Updated existing contact", { recordId, fields: Object.keys(values) });
  } catch (err) {
        // Retry without custom fields if they caused the error
      const errMsg = String(err);
        if (errMsg.includes("value_not_found") || errMsg.includes("Cannot find attribute")) {
                delete values.lead_source;
                delete values.industry;
                if (Object.keys(values).length === 0) return;
                try {
                          await attioFetch(`/objects/people/records/${recordId}`, {
                                      method: "PATCH",
                                      body: JSON.stringify({ data: { values } }),
                          });
                          logger.info("Updated existing contact (without custom fields)", { recordId });
                } catch (e) {
                          logger.warn("Failed to update existing contact", { recordId, error: String(e) });
                }
        } else {
                logger.warn("Failed to update existing contact", { recordId, error: String(err) });
        }
  }
}

// --- Companies ---
const _companyCache = new Map<string, string>();

export async function findOrCreateCompany(name: string): Promise<string> {
    const normalizedName = normalizeName(name);

  if (_companyCache.has(normalizedName)) {
        return _companyCache.get(normalizedName)!;
  }

  const result = (await attioFetch("/objects/companies/records", {
        method: "POST",
        body: JSON.stringify({
                data: {
                          values: { name: [{ value: normalizedName }] },
                          matching_attribute: "name",
                },
        }),
  })) as { data: { id: { record_id: string } } };

  const id = result.data.id.record_id;
    _companyCache.set(normalizedName, id);
    logger.info("Found/created Attio company", { name: normalizedName, id });
    return id;
}

// --- Workspace Members ---
let _workspaceMemberId: string | null = null;

async function getWorkspaceMemberId(): Promise<string | null> {
    if (_workspaceMemberId) return _workspaceMemberId;
    try {
          const result = (await attioFetch("/workspace_members", {
                  method: "GET",
          })) as { data: Array<{ id: { workspace_member_id: string } }> };
          if (result.data && result.data.length > 0) {
                  _workspaceMemberId = result.data[0].id.workspace_member_id;
                  logger.info("Got workspace member ID", { id: _workspaceMemberId });
                  return _workspaceMemberId;
          }
    } catch (err) {
          logger.warn("Failed to get workspace member ID", { error: String(err) });
    }
    return null;
}

// --- Deal Stage Options ---
let _dealStageOptions: Array<{ title: string; id: string }> | null = null;

async function getDealStageOptions(): Promise<Array<{ title: string; id: string }>> {
    if (_dealStageOptions) return _dealStageOptions;
    try {
          const result = (await attioFetch("/objects/deals/attributes/stage/statuses", {
                  method: "GET",
          })) as { data: Array<{ title: string; id: { status_id: string } }> };
          _dealStageOptions = (result.data || []).map(s => ({
                  title: s.title,
                  id: s.id?.status_id || "",
          }));
          logger.info("Got deal stage options", { options: _dealStageOptions.map(s => s.title) });
          return _dealStageOptions;
    } catch (err) {
          logger.warn("Failed to get deal stage options", { error: String(err) });
          return [];
    }
}

// --- Deals ---
export async function findDealByContact(contactId: string): Promise<{ id: string; stage: string } | null> {
    try {
          const result = (await attioFetch("/objects/deals/records/query", {
                  method: "POST",
                  body: JSON.stringify({ limit: 500 }),
          })) as {
                  data: Array<{
                            id: { record_id: string };
                            values: Record<string, unknown>;
                  }>;
          };

      for (const deal of result.data) {
              const people = deal.values?.associated_people as Array<{
                        target_object: string;
                        target_record_id: string;
              }> | undefined;
              if (people?.some(p => p.target_record_id === contactId)) {
                        const stageValues = deal.values?.stage as Array<{ status?: { title: string } }> | undefined;
                        const stageName = stageValues?.[0]?.status?.title || "unknown";
                        logger.info("Found existing deal for contact", { contactId, dealId: deal.id.record_id, stage: stageName });
                        return { id: deal.id.record_id, stage: stageName };
              }
      }
    } catch (err) {
          logger.warn("findDealByContact query failed", { contactId, error: String(err) });
    }
    return null;
}

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
                  const data = await resp.json() as { data?: { parent_object?: string | string[] } };
                  const raw = data.data?.parent_object;
                  _pipelineParentObject = Array.isArray(raw) ? raw[0] : (raw || "people");
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

  const stageName = STAGE_MAP[deal.stage];

  const [ownerId, stageOptions] = await Promise.all([
        getWorkspaceMemberId(),
        getDealStageOptions(),
      ]);

  const dealValues: Record<string, unknown> = {
        name: deal.name || "Untitled Deal",
  };

  if (stageOptions.length > 0) {
        const matchedStage = stageOptions.find(
                s => s.title.toLowerCase().includes(stageName.toLowerCase()) ||
                             stageName.toLowerCase().includes(s.title.toLowerCase())
              );
        const stageTitle = matchedStage?.title || stageOptions[0].title;
        dealValues.stage = [{ status: stageTitle }];
        logger.info("Setting deal stage", { requested: stageName, matched: stageTitle });
  }

  if (ownerId) {
        dealValues.owner = [{ referenced_actor_type: "workspace-member", referenced_actor_id: ownerId }];
  }

  if (deal.contact_id) {
        dealValues.associated_people = [{ target_object: "people", target_record_id: deal.contact_id }];
  }

  if (deal.company) {
        try {
                const companyId = await findOrCreateCompany(deal.company);
                dealValues.associated_company = [{ target_object: "companies", target_record_id: companyId }];
        } catch { /* skip */ }
  }

  if (deal.value) {
        dealValues.value = [{ currency_value: deal.value, currency_code: "USD" }];
  }

  logger.info("Creating deal record", {
        name: dealValues.name,
        hasStage: !!dealValues.stage,
        hasOwner: !!dealValues.owner,
  });

  let dealRecordId: string;
    try {
          const dealRecord = (await attioFetch("/objects/deals/records", {
                  method: "POST",
                  body: JSON.stringify({ data: { values: dealValues } }),
          })) as { data: { id: { record_id: string } } };
          dealRecordId = dealRecord.data.id.record_id;
          logger.info("Created deal record", { name: deal.name, dealRecordId });
    } catch (err) {
          logger.warn("Deal creation failed, trying minimal required fields", { error: String(err) });
          const minimalValues: Record<string, unknown> = { name: dealValues.name };
          if (dealValues.stage) minimalValues.stage = dealValues.stage;
          if (dealValues.owner) minimalValues.owner = dealValues.owner;
          const dealRecord = (await attioFetch("/objects/deals/records", {
                  method: "POST",
                  body: JSON.stringify({ data: { values: minimalValues } }),
          })) as { data: { id: { record_id: string } } };
          dealRecordId = dealRecord.data.id.record_id;
          logger.info("Created deal record (minimal)", { name: deal.name, dealRecordId });
    }

  // Create pipeline entry
  let result: { data: { entry_id?: string; id?: { entry_id?: string } } };
    try {
          result = (await attioFetch(`/lists/${pipelineId}/entries`, {
                  method: "POST",
                  body: JSON.stringify({
                            data: {
                                        parent_object: "deals",
                                        parent_record_id: dealRecordId,
                                        entry_values: {},
                                        current_status_title: stageName,
                            },
                  }),
          })) as typeof result;
    } catch (err) {
          logger.warn("Pipeline entry with stage failed, trying without", { error: String(err) });
          result = (await attioFetch(`/lists/${pipelineId}/entries`, {
                  method: "POST",
                  body: JSON.stringify({
                            data: {
                                        parent_object: "deals",
                                        parent_record_id: dealRecordId,
                                        entry_values: {},
                            },
                  }),
          })) as typeof result;
    }

  const entryId = result.data?.entry_id || result.data?.id?.entry_id;
    logger.info("Created Attio deal", {
          name: deal.name,
          stage: stageName,
          value: deal.value,
          dealRecordId,
          pipelineEntryId: entryId,
    });

  return dealRecordId;
}

export async function updateDealStage(dealRecordId: string, stage: DealStage): Promise<void> {
    const config = getConfig();
    const pipelineId = config.ATTIO_PIPELINE_ID;
    if (!pipelineId) throw new Error("ATTIO_PIPELINE_ID not configured");

  const stageName = STAGE_MAP[stage];

  try {
        const stageOptions = await getDealStageOptions();
        const matchedStage = stageOptions.find(
                s => s.title.toLowerCase().includes(stageName.toLowerCase()) ||
                             stageName.toLowerCase().includes(s.title.toLowerCase())
              );
        const stageTitle = matchedStage?.title || stageOptions[0]?.title;
        if (stageTitle) {
                await attioFetch(`/objects/deals/records/${dealRecordId}`, {
                          method: "PATCH",
                          body: JSON.stringify({ data: { values: { stage: [{ status: stageTitle }] } } }),
                });
        }
  } catch (err) {
        logger.warn("Failed to update deal record stage", { dealRecordId, error: String(err) });
  }

  try {
        const entries = (await attioFetch(`/lists/${pipelineId}/entries/query`, {
                method: "POST",
                body: JSON.stringify({ filter: {} }),
        })) as { data: Array<{ entry_id?: string; id?: { entry_id?: string }; parent_record_id: string }> };

      const entry = entries.data.find(e => e.parent_record_id === dealRecordId);
        if (entry) {
                const entryId = entry.entry_id || entry.id?.entry_id;
                if (entryId) {
                          await attioFetch(`/lists/${pipelineId}/entries/${entryId}`, {
                                      method: "PATCH",
                                      body: JSON.stringify({ data: { current_status_title: stageName } }),
                          });
                          logger.info("Updated Attio deal stage", { dealRecordId, entryId, stage: stageName });
                }
        }
  } catch (err) {
        logger.warn("Failed to update pipeline entry stage", { dealRecordId, stage: stageName, error: String(err) });
  }
}

// --- Notes ---
export async function createNote(note: AttioNote): Promise<void> {
    const parentObject = note.parent_object === "contacts" ? "people" : note.parent_object;

  try {
    await attioFetch("/notes", {
      method: "POST",
      body: JSON.stringify({
        data: {
          parent_object: parentObject,
          parent_record_id: note.parent_id,
          title: note.title,
          format: "plaintext",
          content: note.content,
        },
      }),
    });
    logger.info("Created Attio note", { parentObject, parentId: note.parent_id, title: note.title });
  } catch (err) {
        logger.warn("Note creation failed", { parentObject, parentId: note.parent_id, error: String(err) });
  }
}

// --- Tasks ---
export async function createTask(task: AttioTask): Promise<void> {
  let deadlineAt: string | null = null;
  if (task.due_date) {
    const d = new Date(task.due_date);
    if (!isNaN(d.getTime())) deadlineAt = d.toISOString();
  }

  let assigneeId: string | null = null;
  try {
    assigneeId = await getWorkspaceMemberId();
  } catch (err) {
    logger.warn("Could not fetch workspace member for task assignee", { error: String(err) });
  }

  try {
    await attioFetch("/tasks", {
      method: "POST",
      body: JSON.stringify({
        data: {
          content: `${task.title}\n\n${task.description || ""}`.trim(),
          format: "plaintext",
          deadline_at: deadlineAt,
          is_completed: false,
          linked_records: task.linked_deal_id
            ? [{ target_object: "deals", target_record_id: task.linked_deal_id }]
            : [],
          assignees: assigneeId
            ? [{ referenced_actor_type: "workspace-member", referenced_actor_id: assigneeId }]
            : [],
        },
      }),
    });
    logger.info("Created Attio task", { title: task.title });
  } catch (err) {
    logger.warn("Task creation failed", { title: task.title, error: String(err) });
  }
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
