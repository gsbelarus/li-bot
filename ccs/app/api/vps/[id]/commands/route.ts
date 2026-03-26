import { NextRequest, NextResponse } from "next/server";

import { connectToDatabase } from "@/lib/mongodb";
import {
  AlertLockedVpsError,
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

  try {
    const controller = getControllerConnectionDetails(item);
    const rawMouseConfig = (body as { mouseActivityConfig?: unknown }).mouseActivityConfig;
    const requestMouseConfig =
      rawMouseConfig && typeof rawMouseConfig === "object" && !Array.isArray(rawMouseConfig)
        ? (rawMouseConfig as {
          minIntervalMs?: unknown;
          maxIntervalMs?: unknown;
          maxOffsetPx?: unknown;
        })
        : null;
    const mouseActivityConfig = {
      minIntervalMs:
        typeof requestMouseConfig?.minIntervalMs === "number" && Number.isFinite(requestMouseConfig.minIntervalMs)
          ? Math.max(250, Math.floor(requestMouseConfig.minIntervalMs))
          : controller.defaultMouseActivityMinIntervalMs,
      maxIntervalMs:
        typeof requestMouseConfig?.maxIntervalMs === "number" && Number.isFinite(requestMouseConfig.maxIntervalMs)
          ? Math.max(250, Math.floor(requestMouseConfig.maxIntervalMs))
          : controller.defaultMouseActivityMaxIntervalMs,
      maxOffsetPx:
        typeof requestMouseConfig?.maxOffsetPx === "number" && Number.isFinite(requestMouseConfig.maxOffsetPx)
          ? Math.max(1, Math.floor(requestMouseConfig.maxOffsetPx))
          : controller.defaultMouseActivityMaxOffsetPx,
    };

    if (mouseActivityConfig.maxIntervalMs < mouseActivityConfig.minIntervalMs) {
      return NextResponse.json(
        {
          error: "Mouse maximum interval must be greater than or equal to the minimum interval.",
        },
        { status: 400 }
      );
    }

    const response = await dispatchExecuteScriptCommand({
      vps: controller,
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
      mouseActivityEnabled:
        typeof (body as { mouseActivityEnabled?: unknown }).mouseActivityEnabled === "boolean"
          ? (body as { mouseActivityEnabled: boolean }).mouseActivityEnabled
          : controller.defaultMouseActivityEnabled,
      mouseActivityConfig,
      script: (body as { script?: unknown }).script,
      taskResultWebhookUrlTemplate: `${request.nextUrl.origin}/api/vps/${id}/commands/{taskId}/results`,
      profileVisitLookupUrlTemplate:
        `${request.nextUrl.origin}/api/vps/${id}/profile-history/check` +
        `?profileUrl={profileUrl}&lookbackDays={lookbackDays}`,
      postHistoryLookupUrlTemplate:
        `${request.nextUrl.origin}/api/vps/${id}/post-history/check` +
        `?postUrl={postUrl}&lookbackDays={lookbackDays}`,
      initiatedByUserId: getActorFromRequest(request),
    });

    const status = response.responseStatusCode ?? (response.result === "timeout" ? 504 : 502);
    return NextResponse.json(response.responsePayload ?? response, { status });
  } catch (error) {
    if (error instanceof AlertLockedVpsError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }

    throw error;
  }
}