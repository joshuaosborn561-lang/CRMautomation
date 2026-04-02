import { getConfig } from "../config";
import { logger } from "../utils/logger";

const SMARTLEAD_BASE_URL = "https://server.smartlead.ai/api/v1";

async function smartleadFetch(
  path: string,
  options: RequestInit = {}
): Promise<unknown> {
  const config = getConfig();
  const separator = path.includes("?") ? "&" : "?";
  const url = `${SMARTLEAD_BASE_URL}${path}${separator}api_key=${config.SMARTLEAD_API_KEY}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    logger.error("SmartLead API error", { status: response.status, path, body });
    throw new Error(`SmartLead API error: ${response.status} ${body}`);
  }

  return response.json();
}

// --- Campaigns ---

export async function listCampaigns(): Promise<
  Array<{ id: number; name: string; status: string }>
> {
  const data = (await smartleadFetch("/campaigns")) as Array<{
    id: number;
    name: string;
    status: string;
  }>;
  return data;
}

export async function getCampaign(campaignId: number): Promise<{
  id: number;
  name: string;
  status: string;
}> {
  return (await smartleadFetch(`/campaigns/${campaignId}`)) as {
    id: number;
    name: string;
    status: string;
  };
}

// --- Add Lead to Nurture Campaign ---

export async function addLeadToCampaign(
  campaignId: number,
  lead: {
    email: string;
    first_name?: string;
    last_name?: string;
    company?: string;
    custom_fields?: Record<string, string>;
  }
): Promise<void> {
  await smartleadFetch(`/campaigns/${campaignId}/leads`, {
    method: "POST",
    body: JSON.stringify({
      lead_list: [
        {
          email: lead.email,
          first_name: lead.first_name || "",
          last_name: lead.last_name || "",
          company_name: lead.company || "",
          custom_fields: lead.custom_fields || {},
        },
      ],
      settings: {
        ignore_global_block_list: false,
        ignore_unsubscribe_list: false,
        ignore_duplicate_leads_in_other_campaigns: false,
      },
    }),
  });

  logger.info("Added lead to SmartLead campaign", {
    campaignId,
    email: lead.email,
  });
}

// --- Campaign Leads with Replies (for backfill) ---

export async function getCampaignLeadsWithReplies(
  campaignId: number
): Promise<
  Array<{
    id: number;
    email: string;
    first_name?: string;
    last_name?: string;
    company_name?: string;
    status: string;
    reply?: string;
    reply_category?: string;
    replied_at?: string;
  }>
> {
  try {
    // Get all leads from the campaign
    const leads = (await smartleadFetch(
      `/campaigns/${campaignId}/leads?limit=100&offset=0`
    )) as Array<{
      id: number;
      email: string;
      first_name?: string;
      last_name?: string;
      company_name?: string;
      lead_status: string;
    }>;

    // Filter for leads that replied
    const repliedLeads = [];
    for (const lead of leads || []) {
      if (
        lead.lead_status === "REPLIED" ||
        lead.lead_status === "INTERESTED" ||
        lead.lead_status === "MEETING_BOOKED"
      ) {
        // Fetch the lead's message history
        try {
          const history = (await smartleadFetch(
            `/campaigns/${campaignId}/leads/${lead.id}/message-history`
          )) as Array<{
            type: string;
            text: string;
            time: string;
            category?: string;
          }>;

          // Find their reply
          const reply = history?.find((m) => m.type === "REPLY" || m.type === "reply");
          repliedLeads.push({
            id: lead.id,
            email: lead.email,
            first_name: lead.first_name,
            last_name: lead.last_name,
            company_name: lead.company_name,
            status: lead.lead_status,
            reply: reply?.text,
            reply_category: reply?.category,
            replied_at: reply?.time,
          });
        } catch {
          // Still include the lead even without message history
          repliedLeads.push({
            id: lead.id,
            email: lead.email,
            first_name: lead.first_name,
            last_name: lead.last_name,
            company_name: lead.company_name,
            status: lead.lead_status,
          });
        }

        // Rate limit
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    return repliedLeads;
  } catch (err) {
    logger.error("Failed to get campaign leads with replies", { campaignId, error: String(err) });
    return [];
  }
}

// --- Lead Lookup ---

export async function getLeadByEmail(
  campaignId: number,
  email: string
): Promise<{ id: number; email: string; status: string } | null> {
  try {
    const data = (await smartleadFetch(
      `/campaigns/${campaignId}/leads?email=${encodeURIComponent(email)}`
    )) as Array<{ id: number; email: string; status: string }>;
    return data.length > 0 ? data[0] : null;
  } catch {
    return null;
  }
}
