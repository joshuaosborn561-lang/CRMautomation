import { getConfig } from "../config";
import { logger } from "../utils/logger";

const BASE_URL = "https://api.leadmagic.io/v1";

export interface LeadMagicPerson {
  email?: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  professional_title?: string;
  company_name?: string;
  company_domain?: string;
  linkedin_url?: string;
  profile_url?: string;
  bio?: string;
  mobile_number?: string;
}

export interface LeadMagicCompany {
  companyName?: string;
  companyId?: string;
  industry?: string;
  employeeCount?: number;
  employeeRange?: string;
  founded?: number;
  headquarters?: string;
}

async function leadmagicFetch(
  path: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const config = getConfig();
  if (!config.LEADMAGIC_API_KEY) {
    logger.warn("LEADMAGIC_API_KEY not configured, skipping enrichment");
    return null;
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "X-API-Key": config.LEADMAGIC_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    // 402 = insufficient credits, 404 = not found — don't throw
    if (response.status === 402) {
      logger.warn("LeadMagic: insufficient credits", { path });
      return null;
    }
    if (response.status === 404) {
      return null;
    }
    logger.error("LeadMagic API error", { status: response.status, path, body: text });
    return null;
  }

  return response.json();
}

/**
 * Find a work email by first name, last name, and company domain.
 * Cost: 1 credit.
 */
export async function findEmail(
  firstName: string,
  lastName: string,
  domain: string
): Promise<{ email?: string; verified?: boolean } | null> {
  const result = (await leadmagicFetch("/people/email-finder", {
    first_name: firstName,
    last_name: lastName,
    domain,
  })) as { email?: string; employment_verified?: boolean } | null;

  if (!result?.email) return null;

  logger.info("LeadMagic: found email", { firstName, lastName, domain, email: result.email });
  return { email: result.email, verified: result.employment_verified };
}

/**
 * Enrich a person by LinkedIn profile URL.
 * Cost: 1 credit.
 */
export async function enrichByLinkedIn(profileUrl: string): Promise<LeadMagicPerson | null> {
  const result = (await leadmagicFetch("/people/profile-search", {
    profile_url: profileUrl,
  })) as Record<string, unknown> | null;

  if (!result) return null;

  const person: LeadMagicPerson = {
    first_name: result.first_name as string,
    last_name: result.last_name as string,
    full_name: result.full_name as string,
    professional_title: result.professional_title as string,
    company_name: result.company_name as string,
    bio: result.bio as string,
    profile_url: result.profile_url as string,
    linkedin_url: result.profile_url as string,
  };

  logger.info("LeadMagic: enriched by LinkedIn", {
    profileUrl,
    name: person.full_name,
    company: person.company_name,
  });

  return person;
}

/**
 * Enrich a company by domain or name.
 * Cost: 1 credit.
 */
export async function enrichCompany(
  domain?: string,
  name?: string
): Promise<LeadMagicCompany | null> {
  const body: Record<string, string> = {};
  if (domain) body.company_domain = domain;
  if (name) body.company_name = name;

  if (!domain && !name) return null;

  const result = (await leadmagicFetch("/companies/company-search", body)) as Record<string, unknown> | null;

  if (!result) return null;

  const company: LeadMagicCompany = {
    companyName: result.companyName as string,
    companyId: result.companyId as string,
    industry: result.industry as string,
    employeeCount: result.employeeCount as number,
    employeeRange: result.employeeRange as string,
    founded: result.founded as number,
    headquarters: result.headquarters as string,
  };

  logger.info("LeadMagic: enriched company", { domain, name, company: company.companyName });
  return company;
}

/**
 * Find mobile number from email or LinkedIn.
 * Cost: 5 credits — use sparingly.
 */
export async function findMobile(
  options: { profileUrl?: string; workEmail?: string; personalEmail?: string }
): Promise<string | null> {
  const body: Record<string, string> = {};
  if (options.profileUrl) body.profile_url = options.profileUrl;
  if (options.workEmail) body.work_email = options.workEmail;
  if (options.personalEmail) body.personal_email = options.personalEmail;

  const result = (await leadmagicFetch("/people/mobile-finder", body)) as {
    mobile_number?: string;
  } | null;

  if (!result?.mobile_number) return null;

  logger.info("LeadMagic: found mobile", { mobile: result.mobile_number });
  return result.mobile_number;
}

/**
 * Find email from LinkedIn profile URL.
 * Cost: 5 credits.
 */
export async function findEmailByLinkedIn(profileUrl: string): Promise<string | null> {
  const result = (await leadmagicFetch("/people/b2b-profile-email", {
    profile_url: profileUrl,
  })) as { email?: string } | null;

  if (!result?.email) return null;

  logger.info("LeadMagic: found email from LinkedIn", { profileUrl, email: result.email });
  return result.email;
}

/**
 * Validate an email address.
 * Cost: 0.25 credits.
 */
export async function validateEmail(email: string): Promise<{
  valid: boolean;
  status?: string;
} | null> {
  const result = (await leadmagicFetch("/people/email-validation", {
    email,
  })) as { status?: string } | null;

  if (!result) return null;

  const valid = result.status === "valid" || result.status === "deliverable";
  return { valid, status: result.status };
}

/**
 * Check remaining credits.
 */
export async function getCredits(): Promise<number | null> {
  const config = getConfig();
  if (!config.LEADMAGIC_API_KEY) return null;

  try {
    const response = await fetch(`${BASE_URL}/credits`, {
      headers: { "X-API-Key": config.LEADMAGIC_API_KEY },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { credits?: number };
    return data.credits ?? null;
  } catch {
    return null;
  }
}

/**
 * Full enrichment pipeline for a contact.
 * Tries to fill in missing fields using available data.
 * Returns enriched contact data.
 */
export async function enrichContact(contact: {
  email?: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  linkedin_url?: string;
  phone?: string;
}): Promise<{
  email?: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  title?: string;
  linkedin_url?: string;
  phone?: string;
  industry?: string;
  company_size?: string;
  headquarters?: string;
  enriched: boolean;
}> {
  const result = {
    email: contact.email,
    first_name: contact.first_name,
    last_name: contact.last_name,
    company: contact.company,
    title: undefined as string | undefined,
    linkedin_url: contact.linkedin_url,
    phone: contact.phone,
    industry: undefined as string | undefined,
    company_size: undefined as string | undefined,
    headquarters: undefined as string | undefined,
    enriched: false,
  };

  try {
    // Strategy 1: If we have LinkedIn URL, enrich the person
    if (contact.linkedin_url) {
      const person = await enrichByLinkedIn(contact.linkedin_url);
      if (person) {
        result.first_name = result.first_name || person.first_name;
        result.last_name = result.last_name || person.last_name;
        result.company = result.company || person.company_name;
        result.title = person.professional_title;
        result.enriched = true;
      }

      // If we still don't have email, find it via LinkedIn
      if (!result.email) {
        const email = await findEmailByLinkedIn(contact.linkedin_url);
        if (email) {
          result.email = email;
          result.enriched = true;
        }
      }
    }

    // Strategy 2: If we have name + company, find email
    if (!result.email && result.first_name && result.last_name && result.company) {
      // Extract domain from company name (rough heuristic)
      const domain = result.company.toLowerCase().replace(/\s+/g, "").replace(/[^a-z0-9]/g, "") + ".com";
      const found = await findEmail(result.first_name, result.last_name, domain);
      if (found?.email) {
        result.email = found.email;
        result.enriched = true;
      }
    }

    // Strategy 3: Enrich company data
    if (result.company || result.email) {
      const companyDomain = result.email?.split("@")[1];
      // Don't enrich free email domains
      const freeEmails = ["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com"];
      if (companyDomain && !freeEmails.includes(companyDomain)) {
        const company = await enrichCompany(companyDomain, result.company);
        if (company) {
          result.company = result.company || company.companyName;
          result.industry = company.industry;
          result.company_size = company.employeeRange;
          result.headquarters = company.headquarters;
          result.enriched = true;
        }
      }
    }

    logger.info("LeadMagic: enrichment complete", {
      email: result.email,
      name: `${result.first_name} ${result.last_name}`,
      company: result.company,
      enriched: result.enriched,
    });
  } catch (err) {
    logger.warn("LeadMagic enrichment error", { error: String(err) });
  }

  return result;
}
