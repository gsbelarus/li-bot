import { NextRequest, NextResponse } from "next/server";

import { connectToDatabase } from "@/lib/mongodb";
import {
  fetchControllerTaskResults,
  findVpsById,
  getActorFromRequest,
  getControllerConnectionDetails,
  getProvidedControllerSecret,
  persistControllerTaskResultLog,
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

  const response = await fetchControllerTaskResults({
    vps: getControllerConnectionDetails(item),
    taskId,
    initiatedByUserId: getActorFromRequest(request),
  });

  const status = response.responseStatusCode ?? (response.result === "timeout" ? 504 : 502);
  return NextResponse.json(response.responsePayload ?? response, { status });
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string; taskId: string }> }
) {
  await connectToDatabase();

  const { id, taskId } = await getParams(context);
  const item = await findVpsById(id, true);

  if (!item) {
    return NextResponse.json({ error: "VPS record not found." }, { status: 404 });
  }

  const providedSecret = getProvidedControllerSecret(request);
  const expectedSecret = getControllerConnectionDetails(item).controllerSecretKey;

  if (!providedSecret || !expectedSecret || providedSecret !== expectedSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Result payload must be a JSON object." }, { status: 400 });
  }

  await persistControllerTaskResultLog({
    vpsId: id,
    taskId,
    responseStatusCode: 200,
    responsePayload: body,
    initiatedByUserId: "system@remote-controller",
    createdAt: new Date(),
  });

  return NextResponse.json({ ok: true }, { status: 202 });
}