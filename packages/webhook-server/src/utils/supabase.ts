import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { getConfig } from "../config";

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!_client) {
    const config = getConfig();
    _client = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY);
  }
  return _client;
}
