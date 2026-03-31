import { getConfig } from "../config";
import { logger } from "../utils/logger";

export interface ApolloContact {
  id: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  name?: string;
  organization_name?: string;
  title?: string;
  phone_numbers?: Array<{ raw_number: string; sanitized_number: string }>;
  linkedin_url?: string;
}

async function apolloFetch(
  path: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const config = getConfig();
  if (!config.APOLLO_API_KEY) {
    logger.warn("APOLLO_API_KEY not configured, skipping Apollo lookup");
    return null;
  }

  const response = await fetch(`https://api.apollo.io/api/v1${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": config.APOLLO_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    logger.error("Apollo API error", { status: response.status, path, body: text });
    return null;
  }

  return response.json();
}

/**
 * Search Apollo for a contact by phone number.
 * Normalizes the number (strips formatting) before searching.
 */
export async function findContactByPhone(phoneNumber: string): Promise<ApolloContact | null> {
  // Normalize: strip everything except digits and leading +
  const normalized = phoneNumber.replace(/[^\d+]/g, "");
  if (!normalized || normalized.length < 7) {
    logger.warn("Phone number too short for Apollo lookup", { phoneNumber });
    return null;
  }

  try {
    // Apollo's people/search endpoint with phone number filter
    const result = (await apolloFetch("/mixed_people/search", {
      q_phone_number: normalized,
      page: 1,
      per_page: 1,
    })) as { people?: ApolloContact[] } | null;

    if (!result?.people || result.people.length === 0) {
      // Try without country code if it starts with +1
      if (normalized.startsWith("+1") && normalized.length > 11) {
        const withoutCountry = normalized.substring(2);
        const retry = (await apolloFetch("/mixed_people/search", {
          q_phone_number: withoutCountry,
          page: 1,
          per_page: 1,
        })) as { people?: ApolloContact[] } | null;

        if (retry?.people && retry.people.length > 0) {
          const contact = retry.people[0];
          logger.info("Apollo: found contact by phone (retry without +1)", {
            phone: phoneNumber,
            name: contact.name,
            email: contact.email,
          });
          return contact;
        }
      }

      logger.info("Apollo: no contact found for phone", { phone: phoneNumber });
      return null;
    }

    const contact = result.people[0];
    logger.info("Apollo: found contact by phone", {
      phone: phoneNumber,
      name: contact.name,
      email: contact.email,
      company: contact.organization_name,
    });
    return contact;
  } catch (err) {
    logger.error("Apollo lookup failed", { phone: phoneNumber, error: String(err) });
    return null;
  }
}

/**
 * Enrich a contact - given an email, pull full Apollo profile.
 */
export async function enrichContactByEmail(email: string): Promise<ApolloContact | null> {
  try {
    const result = (await apolloFetch("/people/match", {
      email,
    })) as { person?: ApolloContact } | null;

    if (!result?.person) {
      logger.info("Apollo: no enrichment found for email", { email });
      return null;
    }

    logger.info("Apollo: enriched contact by email", {
      email,
      name: result.person.name,
      company: result.person.organization_name,
    });
    return result.person;
  } catch (err) {
    logger.error("Apollo enrichment failed", { email, error: String(err) });
    return null;
  }
}
