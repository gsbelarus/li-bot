import { NextRequest, NextResponse } from "next/server";

import { connectToDatabase } from "@/lib/mongodb";
import {
  DuplicateVpsError,
  PayloadValidationError,
  ensureNoActiveDuplicate,
  getActorFromRequest,
  getListQuery,
  serializeVps,
  validateVpsPayload,
} from "@/lib/remote-vps";
import RemoteVpsModel from "@/models/RemoteVps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  await connectToDatabase();

  const { filter, page, pageSize, sort } = getListQuery(request.nextUrl.searchParams);

  const [items, totalCount] = await Promise.all([
    RemoteVpsModel.find(filter)
      .sort(sort)
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    RemoteVpsModel.countDocuments(filter),
  ]);

  return NextResponse.json({
    items: items.map((item) => serializeVps(item)),
    totalCount,
    page,
    pageSize,
  });
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
