import { NextRequest, NextResponse } from "next/server";

import { DatabaseConnectionError, connectToDatabase } from "@/lib/mongodb";
import { getSystemLogById } from "@/lib/system-logs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getParams(context: { params: Promise<{ logId: string }> }) {
  return context.params;
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ logId: string }> }
) {
  try {
    await connectToDatabase();

    const { logId } = await getParams(context);
    const item = await getSystemLogById(logId);

    if (!item) {
      return NextResponse.json({ error: "System log not found." }, { status: 404 });
    }

    return NextResponse.json({ item });
  } catch (error) {
    if (error instanceof DatabaseConnectionError) {
      return NextResponse.json(
        {
          error: "Database unavailable.",
          details: error.message,
        },
        { status: 503 }
      );
    }

    return NextResponse.json({ error: "Failed to load system log." }, { status: 500 });
  }
}