import { NextRequest, NextResponse } from "next/server";

import { DatabaseConnectionError, connectToDatabase } from "@/lib/mongodb";
import {
  ScriptPayloadValidationError,
  getActorFromRequest,
  getScriptListQuery,
  serializeScript,
  validateScriptPayload,
} from "@/lib/scripts";
import ScriptDefinitionModel from "@/models/ScriptDefinition";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await connectToDatabase();

    const { filter, page, pageSize, sort } = getScriptListQuery(request.nextUrl.searchParams);

    const [items, totalCount] = await Promise.all([
      ScriptDefinitionModel.find(filter)
        .sort(sort)
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      ScriptDefinitionModel.countDocuments(filter),
    ]);

    return NextResponse.json({
      items: items.map((item) => serializeScript(item)),
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

    return NextResponse.json({ error: "Failed to load scripts." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    await connectToDatabase();
    const payload = validateScriptPayload(await request.json());
    const actor = getActorFromRequest(request);

    const item = await ScriptDefinitionModel.create({
      ...payload,
      createdBy: actor,
      updatedBy: actor,
    });

    return NextResponse.json(
      {
        item: serializeScript(item),
        message: "Script created.",
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

    if (error instanceof ScriptPayloadValidationError) {
      return NextResponse.json({ errors: error.errors }, { status: 400 });
    }

    return NextResponse.json(
      { errors: { form: "Failed to create script." } },
      { status: 500 }
    );
  }
}
