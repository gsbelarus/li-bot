import { NextRequest, NextResponse } from "next/server";

import { connectToDatabase } from "@/lib/mongodb";
import {
  findVpsById,
  getActorFromRequest,
  performControllerProbe,
  serializeVps,
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

  const probe = await performControllerProbe({
    vps: serializeVps(item),
    interactionType: "manual_test",
    requestPath: "/",
    initiatedByUserId: getActorFromRequest(request),
  });

  const updatedItem = await findVpsById(id);

  return NextResponse.json({
    item: updatedItem ? serializeVps(updatedItem) : serializeVps(item),
    interaction: probe,
  });
}
