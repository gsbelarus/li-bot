import { NextRequest, NextResponse } from "next/server";

import { DatabaseConnectionError, connectToDatabase } from "@/lib/mongodb";
import { getSystemLogListQuery, listSystemLogs } from "@/lib/system-logs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await connectToDatabase();

    const { filter, page, pageSize } = getSystemLogListQuery(request.nextUrl.searchParams);
    const response = await listSystemLogs({ filter, page, pageSize });

    return NextResponse.json(response);
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

    return NextResponse.json({ error: "Failed to load system logs." }, { status: 500 });
  }
}
