import { NextRequest, NextResponse } from "next/server";

import { connectToDatabase } from "@/lib/mongodb";
import {
  findRecentProcessedPost,
  findVpsById,
  getControllerConnectionDetails,
  getProvidedControllerSecret,
} from "@/lib/remote-vps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getId(context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return id;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  await connectToDatabase();

  const id = await getId(context);
  const item = await findVpsById(id, true);

  if (!item) {
    return NextResponse.json({ error: "VPS record not found." }, { status: 404 });
  }

  const providedSecret = getProvidedControllerSecret(request);
  const expectedSecret = getControllerConnectionDetails(item).controllerSecretKey;

  if (!providedSecret || !expectedSecret || providedSecret !== expectedSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const postUrl = request.nextUrl.searchParams.get("postUrl") ?? "";
  const lookbackDays = Number.parseInt(request.nextUrl.searchParams.get("lookbackDays") ?? "3650", 10);

  if (!postUrl.trim()) {
    return NextResponse.json({ error: "postUrl is required." }, { status: 400 });
  }

  const result = await findRecentProcessedPost({
    postUrl,
    lookbackDays: Number.isFinite(lookbackDays) && lookbackDays > 0 ? lookbackDays : 3650,
  });

  if (!result.postUrl) {
    return NextResponse.json({ error: "postUrl must be a LinkedIn post URL." }, { status: 400 });
  }

  return NextResponse.json(result);
}
