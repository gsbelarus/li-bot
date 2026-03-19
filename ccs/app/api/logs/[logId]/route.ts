import { NextRequest, NextResponse } from "next/server";

import { connectToDatabase } from "@/lib/mongodb";
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
  await connectToDatabase();

  const { logId } = await getParams(context);
  const item = await getSystemLogById(logId);

  if (!item) {
    return NextResponse.json({ error: "System log not found." }, { status: 404 });
  }

  return NextResponse.json({ item });
}