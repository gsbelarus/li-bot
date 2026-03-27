import { NextRequest, NextResponse } from "next/server";

import { DatabaseConnectionError, connectToDatabase } from "@/lib/mongodb";
import { deleteSystemLogs, getSystemLogListQuery, listSystemLogs } from "@/lib/system-logs";

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

export async function DELETE(request: NextRequest) {
  try {
    await connectToDatabase();

    const { filter } = getSystemLogListQuery(request.nextUrl.searchParams);
    const result = await deleteSystemLogs(filter);

    return NextResponse.json({
      deletedCount: result.deletedCount,
      message:
        result.deletedCount === 1
          ? "1 log record deleted."
          : `${result.deletedCount} log records deleted.`,
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

    return NextResponse.json({ error: "Failed to clear system logs." }, { status: 500 });
  }
}
