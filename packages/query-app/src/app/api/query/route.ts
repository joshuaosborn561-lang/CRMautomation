import { NextRequest, NextResponse } from "next/server";

const WEBHOOK_SERVER_URL =
  process.env.WEBHOOK_SERVER_URL || "http://localhost:3000";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const response = await fetch(`${WEBHOOK_SERVER_URL}/api/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to reach webhook server" },
      { status: 502 }
    );
  }
}
