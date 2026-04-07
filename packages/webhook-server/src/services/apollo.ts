import { getConfig } from "../config";
import { logger } from "../utils/logger";

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

/**
 * Search the user's saved contacts in Apollo by phone number.
 * This searches the user's CRM, not the global database.
 */
export async function searchContactByPhone(phone: string): Promise<ApolloContact | null> {
  // Try the contacts search endpoint (user's saved contacts)
  const result = (await apolloFetch("/contacts/search", {
    q_keywords: phone,
    per_page: 1,
  })) as { contacts?: Array<Record<string, unknown>> } | null;

  if (result?.contacts && result.contacts.length > 0) {
    const c = result.contacts[0];
    const org = c.organization as Record<string, unknown> | undefined;
    return {
      email: c.email as string | undefined,
      first_name: c.first_name as string | undefined,
      last_name: c.last_name as string | undefined,
      name: c.name as string | undefined,
      title: c.title as string | undefined,
      company: (org?.name || c.organization_name) as string | undefined,
      linkedin_url: c.linkedin_url as string | undefined,
      phone: phone,
    };
  }

  // Fallback: try people search with phone as keyword
  const peopleResult = (await apolloFetch("/mixed_people/api_search", {
    q_keywords: phone,
    per_page: 1,
  })) as { people?: Array<Record<string, unknown>> } | null;

  if (peopleResult?.people && peopleResult.people.length > 0) {
    const p = peopleResult.people[0];
    const org = p.organization as Record<string, unknown> | undefined;
    return {
      email: p.email as string | undefined,
      first_name: p.first_name as string | undefined,
      last_name: p.last_name as string | undefined,
      name: p.name as string | undefined,
      title: p.title as string | undefined,
      company: (org?.name || p.organization_name) as string | undefined,
      linkedin_url: p.linkedin_url as string | undefined,
      phone: phone,
    };
  }

  return null;
}

/**
 * Enrich a person via Apollo People Match (the real enrichment endpoint).
 * Uses reveal flags to return personal email and phone numbers.
 * Accepts any combination of: email, name+domain, name+company, linkedin_url.
 */
export async function enrichPerson(input: {
  email?: string;
  first_name?: string;
  last_name?: string;
  name?: string;
  domain?: string;
  organization_name?: string;
  linkedin_url?: string;
}): Promise<ApolloContact | null> {
  const body: Record<string, unknown> = {
    reveal_personal_emails: true,
    reveal_phone_number: true,
  };
  if (input.email) body.email = input.email;
  if (input.first_name) body.first_name = input.first_name;
  if (input.last_name) body.last_name = input.last_name;
  if (input.name) body.name = input.name;
  if (input.domain) body.domain = input.domain;
  if (input.organization_name) body.organization_name = input.organization_name;
  if (input.linkedin_url) body.linkedin_url = input.linkedin_url;

  const result = (await apolloFetch("/people/match", body)) as { person?: Record<string, unknown> } | null;
  const p = result?.person;
  if (!p) return null;

  const org = p.organization as Record<string, unknown> | undefined;
  const phones = p.phone_numbers as Array<{ sanitized_number?: string; raw_number?: string }> | undefined;
  const phone = phones && phones.length > 0 ? (phones[0].sanitized_number || phones[0].raw_number) : undefined;

  return {
    email: (p.email || p.personal_email) as string | undefined,
    first_name: p.first_name as string | undefined,
    last_name: p.last_name as string | undefined,
    name: p.name as string | undefined,
    title: p.title as string | undefined,
    company: (org?.name || p.organization_name) as string | undefined,
    linkedin_url: p.linkedin_url as string | undefined,
    phone: phone as string | undefined,
  };
}

/**
 * Search for a person by name in Apollo's database.
 */
export async function searchContactByName(
  firstName: string,
  lastName: string
): Promise<ApolloContact | null> {
  const result = (await apolloFetch("/mixed_people/api_search", {
    q_keywords: `${firstName} ${lastName}`,
    per_page: 1,
  })) as { people?: Array<Record<string, unknown>> } | null;

  if (result?.people && result.people.length > 0) {
    const p = result.people[0];
    const org = p.organization as Record<string, unknown> | undefined;
    return {
      email: p.email as string | undefined,
      first_name: p.first_name as string | undefined,
      last_name: p.last_name as string | undefined,
      name: p.name as string | undefined,
      title: p.title as string | undefined,
      company: (org?.name || p.organization_name) as string | undefined,
      linkedin_url: p.linkedin_url as string | undefined,
    };
  }

  // Also try contacts search (user's saved contacts)
  const contactResult = (await apolloFetch("/contacts/search", {
    q_keywords: `${firstName} ${lastName}`,
    per_page: 1,
  })) as { contacts?: Array<Record<string, unknown>> } | null;

  if (contactResult?.contacts && contactResult.contacts.length > 0) {
    const c = contactResult.contacts[0];
    const org = c.organization as Record<string, unknown> | undefined;
    return {
      email: c.email as string | undefined,
      first_name: c.first_name as string | undefined,
      last_name: c.last_name as string | undefined,
      name: c.name as string | undefined,
      title: c.title as string | undefined,
      company: (org?.name || c.organization_name) as string | undefined,
      linkedin_url: c.linkedin_url as string | undefined,
    };
  }

  return null;
}
