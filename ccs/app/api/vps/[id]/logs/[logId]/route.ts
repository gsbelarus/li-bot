import { NextRequest, NextResponse } from "next/server";

import { connectToDatabase } from "@/lib/mongodb";
import { serializeInteractionLog } from "@/lib/remote-vps";
import RemoteVpsInteractionLogModel from "@/models/RemoteVpsInteractionLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getParams(context: {
  params: Promise<{ id: string; logId: string }>;
}) {
  return context.params;
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string; logId: string }> }
) {
  await connectToDatabase();
  const { id, logId } = await getParams(context);
  const item = await RemoteVpsInteractionLogModel.findOne({
    _id: logId,
    vpsId: id,
  }).lean();

  if (!item) {
    return NextResponse.json({ error: "Interaction log not found." }, { status: 404 });
  }

  return NextResponse.json({ item: serializeInteractionLog(item) });
}
