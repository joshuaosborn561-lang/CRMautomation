import { NextResponse } from "next/server";

const WEBHOOK_SERVER_URL =
  process.env.WEBHOOK_SERVER_URL || "http://localhost:3000";

export async function GET() {
  try {
    const response = await fetch(`${WEBHOOK_SERVER_URL}/api/nurture`);
    const data = await response.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { error: "Failed to reach webhook server", prospects: [] },
      { status: 502 }
    );
  }
}
