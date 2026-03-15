import { NextRequest, NextResponse } from "next/server";

import { connectToDatabase } from "@/lib/mongodb";
import {
  fetchControllerTaskStatus,
  findVpsById,
  getActorFromRequest,
  getControllerConnectionDetails,
} from "@/lib/remote-vps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getParams(context: { params: Promise<{ id: string; taskId: string }> }) {
  return context.params;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string; taskId: string }> }
) {
  await connectToDatabase();

  const { id, taskId } = await getParams(context);
  const item = await findVpsById(id);

  if (!item) {
    return NextResponse.json({ error: "VPS record not found." }, { status: 404 });
  }

  const response = await fetchControllerTaskStatus({
    vps: getControllerConnectionDetails(item),
    taskId,
    initiatedByUserId: getActorFromRequest(request),
  });

  const status = response.responseStatusCode ?? (response.result === "timeout" ? 504 : 502);
  return NextResponse.json(response.responsePayload ?? response, { status });
}