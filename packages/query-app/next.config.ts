import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The webhook server URL (Railway)
  env: {
    WEBHOOK_SERVER_URL: process.env.WEBHOOK_SERVER_URL || "http://localhost:3000",
  },
};

export default nextConfig;
