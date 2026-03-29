import { NextRequest, NextResponse } from "next/server";

const WEBHOOK_SERVER_URL =
  process.env.WEBHOOK_SERVER_URL || "http://localhost:3000";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; action: string }> }
) {
  try {
    const { id, action } = await params;

    if (action !== "approve" && action !== "reject") {
      return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }

    const response = await fetch(
      `${WEBHOOK_SERVER_URL}/api/nurture/${id}/${action}`,
      { method: "POST", headers: { "Content-Type": "application/json" } }
    );

    const data = await response.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { error: "Failed to reach webhook server" },
      { status: 502 }
    );
  }
}
