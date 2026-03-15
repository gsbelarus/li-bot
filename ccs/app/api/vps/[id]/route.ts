import { NextRequest, NextResponse } from "next/server";

import { connectToDatabase } from "@/lib/mongodb";
import {
  DuplicateVpsError,
  PayloadValidationError,
  ensureNoActiveDuplicate,
  findVpsById,
  getActorFromRequest,
  serializeVps,
  validateVpsPayload,
} from "@/lib/remote-vps";

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
  const item = await findVpsById(id);

  if (!item) {
    return NextResponse.json({ error: "VPS record not found." }, { status: 404 });
  }

  return NextResponse.json({ item: serializeVps(item) });
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    await connectToDatabase();
    const id = await getId(context);
    const current = await findVpsById(id);

    if (!current) {
      return NextResponse.json({ error: "VPS record not found." }, { status: 404 });
    }

    const body = await request.json();
    const currentObject = current.toObject();
    const payload = validateVpsPayload({
      ...currentObject,
      ...body,
      tags: body.tags ?? currentObject.tags,
    });

    await ensureNoActiveDuplicate(payload, id);

    const actor = getActorFromRequest(request);
    const nextStatus = payload.isEnabled
      ? current.status === "disabled"
        ? "unknown"
        : current.status
      : "disabled";
    const nextStatusReason = payload.isEnabled
      ? current.status === "disabled"
        ? "Re-enabled. Awaiting fresh controller communication."
        : current.statusReason
      : "Record disabled by operator.";

    current.set({
      ...payload,
      status: nextStatus,
      statusReason: nextStatusReason,
      updatedBy: actor,
    });

    await current.save();

    return NextResponse.json({
      item: serializeVps(current),
      message: "VPS record updated.",
    });
  } catch (error) {
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
      { errors: { form: "Failed to update VPS record." } },
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
  const item = await findVpsById(id);

  if (!item) {
    return NextResponse.json({ error: "VPS record not found." }, { status: 404 });
  }

  item.set({
    isDeleted: true,
    deletedAt: new Date(),
    isEnabled: false,
    status: "disabled",
    statusReason: "Soft deleted by operator.",
    updatedBy: getActorFromRequest(request),
  });

  await item.save();

  return NextResponse.json({
    message: "VPS record deleted. Interaction logs were preserved.",
  });
}
