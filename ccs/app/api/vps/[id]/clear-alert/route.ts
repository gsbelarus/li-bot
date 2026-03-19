import { NextRequest, NextResponse } from "next/server";

import { connectToDatabase } from "@/lib/mongodb";
import {
  clearVpsAlertStatus,
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

  const response = await clearVpsAlertStatus({
    vps: getControllerConnectionDetails(item),
    initiatedByUserId: getActorFromRequest(request),
  });

  return NextResponse.json(response);
}