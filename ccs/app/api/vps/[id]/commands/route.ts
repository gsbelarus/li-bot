import { NextRequest, NextResponse } from "next/server";

import { connectToDatabase } from "@/lib/mongodb";
import {
  dispatchExecuteScriptCommand,
  findVpsById,
  getActorFromRequest,
  getControllerConnectionDetails,
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
  const item = await findVpsById(id);

  if (!item) {
    return NextResponse.json({ error: "VPS record not found." }, { status: 404 });
  }

  const body = await request.json().catch(() => null);

  if (!body || typeof body !== "object" || body.command !== "executeScript") {
    return NextResponse.json(
      { error: "Only the executeScript command is currently supported." },
      { status: 400 }
    );
  }

  const response = await dispatchExecuteScriptCommand({
    vps: getControllerConnectionDetails(item),
    scriptId:
      typeof (body as { scriptId?: unknown }).scriptId === "string"
        ? (body as { scriptId: string }).scriptId
        : "",
    scriptName:
      typeof (body as { scriptName?: unknown }).scriptName === "string"
        ? (body as { scriptName: string }).scriptName
        : "",
    engineMode:
      (body as { engineMode?: unknown }).engineMode === "ai_driven"
        ? "ai_driven"
        : "deterministic",
    script: (body as { script?: unknown }).script,
    taskResultWebhookUrlTemplate: `${request.nextUrl.origin}/api/vps/${id}/commands/{taskId}/results`,
    initiatedByUserId: getActorFromRequest(request),
  });

  const status = response.responseStatusCode ?? (response.result === "timeout" ? 504 : 502);
  return NextResponse.json(response.responsePayload ?? response, { status });
}