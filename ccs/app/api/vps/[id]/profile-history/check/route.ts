import { NextRequest, NextResponse } from "next/server";

import { DatabaseConnectionError, connectToDatabase } from "@/lib/mongodb";
import {
  findRecentProfileVisit,
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
  try {
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

    const profileUrl = request.nextUrl.searchParams.get("profileUrl") ?? "";
    const lookbackDays = Number.parseInt(request.nextUrl.searchParams.get("lookbackDays") ?? "30", 10);

    if (!profileUrl.trim()) {
      return NextResponse.json({ error: "profileUrl is required." }, { status: 400 });
    }

    const result = await findRecentProfileVisit({
      profileUrl,
      lookbackDays: Number.isFinite(lookbackDays) && lookbackDays > 0 ? lookbackDays : 30,
    });

    if (!result.profileKey) {
      return NextResponse.json({ error: "profileUrl must be a LinkedIn profile URL." }, { status: 400 });
    }

    return NextResponse.json(result);
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

    return NextResponse.json({ error: "Failed to look up profile visit history." }, { status: 500 });
  }
}