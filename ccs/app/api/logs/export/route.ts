import { NextRequest, NextResponse } from "next/server";

import { connectToDatabase } from "@/lib/mongodb";
import {
  buildSystemLogsCsv,
  buildSystemLogsJson,
  getSystemLogListQuery,
  listAllSystemLogs,
} from "@/lib/system-logs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  await connectToDatabase();

  const format = request.nextUrl.searchParams.get("format") === "csv" ? "csv" : "json";
  const { filter } = getSystemLogListQuery(request.nextUrl.searchParams);
  const logs = await listAllSystemLogs(filter);

  const body = format === "csv" ? buildSystemLogsCsv(logs) : buildSystemLogsJson(logs);
  const contentType = format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8";
  const fileName = `system-logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${format}`;

  return new NextResponse(body, {
    headers: {
      "content-type": contentType,
      "content-disposition": `attachment; filename="${fileName}"`,
      "cache-control": "no-store",
    },
  });
}