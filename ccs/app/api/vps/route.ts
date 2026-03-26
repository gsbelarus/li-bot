import { NextRequest, NextResponse } from "next/server";

import { DatabaseConnectionError, connectToDatabase } from "@/lib/mongodb";
import { scriptExecutionResultOptions } from "@/lib/remote-vps-shared";
import {
  DuplicateVpsError,
  PayloadValidationError,
  ensureNoActiveDuplicate,
  getActorFromRequest,
  getListQuery,
  serializeVps,
  validateVpsPayload,
} from "@/lib/remote-vps";
import RemoteVpsInteractionLogModel from "@/models/RemoteVpsInteractionLog";
import RemoteVpsModel from "@/models/RemoteVps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await connectToDatabase();

    const { filter, page, pageSize, sort, lastScriptExecutionResult } = getListQuery(request.nextUrl.searchParams);

    if (lastScriptExecutionResult) {
      const matchingLatestScriptResults = await RemoteVpsInteractionLogModel.aggregate<{
        _id: unknown;
        scriptExecutionResult: string | null;
      }>([
        {
          $match: {
            interactionType: "script_result",
            scriptExecutionResult: { $in: [...scriptExecutionResultOptions] },
          },
        },
        {
          $sort: {
            vpsId: 1,
            createdAt: -1,
          },
        },
        {
          $group: {
            _id: "$vpsId",
            scriptExecutionResult: { $first: "$scriptExecutionResult" },
          },
        },
        {
          $match: {
            scriptExecutionResult: lastScriptExecutionResult,
          },
        },
      ]);

      filter._id = {
        $in: matchingLatestScriptResults.map((entry) => entry._id),
      };
    }

    const [items, totalCount] = await Promise.all([
      RemoteVpsModel.find(filter)
        .sort(sort)
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      RemoteVpsModel.countDocuments(filter),
    ]);

    const itemIds = items.map((item) => item._id);
    const latestScriptResults = itemIds.length
      ? await RemoteVpsInteractionLogModel.aggregate<{
        _id: unknown;
        scriptExecutionResult: string | null;
      }>([
        {
          $match: {
            vpsId: { $in: itemIds },
            interactionType: "script_result",
            scriptExecutionResult: { $in: [...scriptExecutionResultOptions] },
          },
        },
        {
          $sort: {
            vpsId: 1,
            createdAt: -1,
          },
        },
        {
          $group: {
            _id: "$vpsId",
            scriptExecutionResult: { $first: "$scriptExecutionResult" },
          },
        },
      ])
      : [];
    const latestScriptResultByVpsId = new Map(
      latestScriptResults.map((entry) => [String(entry._id), entry.scriptExecutionResult])
    );

    return NextResponse.json({
      items: items.map((item) =>
        serializeVps({
          ...item,
          lastScriptExecutionResult: latestScriptResultByVpsId.get(String(item._id)) ?? null,
        })
      ),
      totalCount,
      page,
      pageSize,
    });
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

    return NextResponse.json({ error: "Failed to load VPS records." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    await connectToDatabase();

    const payload = validateVpsPayload(await request.json());
    await ensureNoActiveDuplicate(payload);

    const actor = getActorFromRequest(request);

    const item = await RemoteVpsModel.create({
      ...payload,
      status: payload.isEnabled ? "unknown" : "disabled",
      statusReason: payload.isEnabled
        ? "Awaiting initial controller communication"
        : "Record disabled by operator.",
      alertDetails: null,
      createdBy: actor,
      updatedBy: actor,
    });

    return NextResponse.json(
      {
        item: serializeVps(item),
        message: "VPS record created.",
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof DatabaseConnectionError) {
      return NextResponse.json(
        { errors: { form: error.message } },
        { status: 503 }
      );
    }

    if (error instanceof PayloadValidationError) {
      return NextResponse.json({ errors: error.errors }, { status: 400 });
    }

    if (error instanceof DuplicateVpsError) {
      return NextResponse.json(
        {
          errors: {
            form: "Another active VPS already uses this protocol, host, and port.",
          },
        },
        { status: 409 }
      );
    }

    return NextResponse.json(
      { errors: { form: "Failed to create VPS record." } },
      { status: 500 }
    );
  }
}
