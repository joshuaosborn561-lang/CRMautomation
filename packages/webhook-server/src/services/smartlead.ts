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
