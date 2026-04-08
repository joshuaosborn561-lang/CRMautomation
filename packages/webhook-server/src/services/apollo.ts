import { getConfig } from "../config";
import { logger } from "../utils/logger";

// Apollo is demoted to email-anchored fallback only. All name/phone/linkedin
// discovery is handled by LeadMagic (services/leadmagic.ts).

const BASE_URL = "https://api.apollo.io/api/v1";

async function apolloFetch(
  path: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const config = getConfig();
  if (!config.APOLLO_API_KEY) {
    logger.warn("APOLLO_API_KEY not configured, skipping Apollo lookup");
    return null;
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "x-api-key": config.APOLLO_API_KEY,
      "Content-Type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 429) {
      logger.warn("Apollo rate limited", { path });
      return null;
    }
    logger.error("Apollo API error", { status: response.status, path, body: text });
    return null;
  }

  return response.json();
}

export interface ApolloContact {
  email?: string;
  first_name?: string;
  last_name?: string;
  name?: string;
  title?: string;
  company?: string;
  linkedin_url?: string;
  phone?: string;
}

function mapApolloContact(c: Record<string, unknown>): ApolloContact {
  const org = c.organization as Record<string, unknown> | undefined;
  const phones = (c.phone_numbers as Array<Record<string, unknown>> | undefined) || [];
  const phone = phones.length > 0
    ? ((phones[0].sanitized_number || phones[0].raw_number) as string | undefined)
    : (c.sanitized_phone as string | undefined) || (c.direct_phone as string | undefined) || (c.mobile_phone as string | undefined);
  return {
    email: (c.email || c.personal_email || c.work_email) as string | undefined,
    first_name: c.first_name as string | undefined,
    last_name: c.last_name as string | undefined,
    name: c.name as string | undefined,
    title: c.title as string | undefined,
    company: (org?.name || c.organization_name || c.account_name) as string | undefined,
    linkedin_url: c.linkedin_url as string | undefined,
    phone,
  };
}

/**
 * Enrich a person via Apollo People Match. Email-only call — the name/company
 * fallback variants were unreliable for unlocked contacts and have been removed.
 */
export async function enrichPerson(input: { email: string }): Promise<ApolloContact | null> {
  if (!input.email) return null;
  const body: Record<string, unknown> = {
    reveal_personal_emails: true,
    reveal_phone_number: true,
    email: input.email,
  };

  const result = (await apolloFetch("/people/match", body)) as { person?: Record<string, unknown> } | null;
  const p = result?.person;
  if (!p) {
    logger.info("Apollo /people/match returned no person", { email: input.email });
    return null;
  }
  logger.info("Apollo /people/match hit", {
    email: input.email,
    hasPhone: !!(p.phone_numbers as Array<unknown> | undefined)?.length,
    hasLinkedin: !!p.linkedin_url,
  });
  return mapApolloContact(p);
}
