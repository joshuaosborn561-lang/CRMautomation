import { z } from "zod";

const envSchema = z.object({
  PORT: z.string().default("3000"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  REVIEW_MODE: z
    .string()
    .default("false")
    .transform((v) => v === "true"),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_KEY: z.string().min(1),

  ANTHROPIC_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().min(1),

  ATTIO_API_KEY: z.string().min(1),
  ATTIO_PIPELINE_ID: z.string().optional(),

  SMARTLEAD_API_KEY: z.string().min(1),
  SMARTLEAD_WEBHOOK_SECRET: z.string().optional(),
  SMARTLEAD_NURTURE_CAMPAIGN_ID: z.string().optional(),

  HEYREACH_API_KEY: z.string().min(1),
  HEYREACH_WEBHOOK_SECRET: z.string().optional(),

  ZOOM_CLIENT_ID: z.string().min(1),
  ZOOM_CLIENT_SECRET: z.string().min(1),
  ZOOM_ACCOUNT_ID: z.string().min(1),
  ZOOM_WEBHOOK_SECRET_TOKEN: z.string().optional(),
  ZOOM_WEBHOOK_VERIFICATION_TOKEN: z.string().optional(),

  // Google Workspace / Gmail
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REFRESH_TOKEN: z.string().min(1),
  GMAIL_USER_EMAIL: z.string().optional(),
  GOOGLE_PUBSUB_TOPIC: z.string().optional(),

  // LeadMagic (lead enrichment)
  LEADMAGIC_API_KEY: z.string().min(1),

  // Notifications
  NOTIFICATION_EMAIL: z.string().optional(),
  SERVER_URL: z.string().optional(),
});

export type Config = z.infer<typeof envSchema>;

let _config: Config | null = null;

export function getConfig(): Config {
  if (!_config) {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
      console.error("Invalid environment variables:");
      console.error(result.error.format());
      process.exit(1);
    }
    _config = result.data;
  }
  return _config;
}
