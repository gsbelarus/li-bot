import { NextRequest, NextResponse } from "next/server";

import { connectToDatabase } from "@/lib/mongodb";
import {
  backfillScriptResultLogsForVps,
  findVpsById,
  getActorFromRequest,
} from "@/lib/remote-vps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getId(context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return id;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  await connectToDatabase();

  const id = await getId(context);
  const item = await findVpsById(id, true);

  if (!item) {
    return NextResponse.json({ error: "VPS record not found." }, { status: 404 });
  }

  const result = await backfillScriptResultLogsForVps({
    vpsId: id,
    initiatedByUserId: getActorFromRequest(request),
  });

  return NextResponse.json({
    ...result,
    message: `Backfilled ${result.updatedCount} script result logs.`,
  });
}