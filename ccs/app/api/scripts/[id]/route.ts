import { NextRequest, NextResponse } from "next/server";

import { connectToDatabase } from "@/lib/mongodb";
import {
  ScriptPayloadValidationError,
  findScriptById,
  getActorFromRequest,
  serializeScript,
  validateScriptPayload,
} from "@/lib/scripts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getId(context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return id;
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  await connectToDatabase();
  const id = await getId(context);
  const item = await findScriptById(id);

  if (!item) {
    return NextResponse.json({ error: "Script not found." }, { status: 404 });
  }

  return NextResponse.json({ item: serializeScript(item) });
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    await connectToDatabase();
    const id = await getId(context);
    const item = await findScriptById(id);

    if (!item) {
      return NextResponse.json({ error: "Script not found." }, { status: 404 });
    }

    const currentObject = item.toObject();
    const body = await request.json();
    const payload = validateScriptPayload({ ...currentObject, ...body });

    item.set({
      ...payload,
      updatedBy: getActorFromRequest(request),
    });

    await item.save();

    return NextResponse.json({
      item: serializeScript(item),
      message: "Script updated.",
    });
  } catch (error) {
    if (error instanceof ScriptPayloadValidationError) {
      return NextResponse.json({ errors: error.errors }, { status: 400 });
    }

    return NextResponse.json(
      { errors: { form: "Failed to update script." } },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  await connectToDatabase();
  const id = await getId(context);
  const item = await findScriptById(id);

  if (!item) {
    return NextResponse.json({ error: "Script not found." }, { status: 404 });
  }

  item.set({
    isDeleted: true,
    deletedAt: new Date(),
    updatedBy: getActorFromRequest(request),
  });

  await item.save();

  return NextResponse.json({ message: "Script deleted." });
}
