import { NextRequest, NextResponse } from "next/server";

import { connectToDatabase } from "@/lib/mongodb";
import {
  buildSystemLogsCsv,
  buildSystemLogsJson,
  getSystemLogExportSize,
  getSystemLogListQuery,
  listAllSystemLogs,
  maxSystemLogExportBytes,
} from "@/lib/system-logs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  await connectToDatabase();

  const format = request.nextUrl.searchParams.get("format") === "csv" ? "csv" : "json";
  const { filter } = getSystemLogListQuery(request.nextUrl.searchParams);
  const exportInfo = await getSystemLogExportSize(filter);

  if (exportInfo.totalDocumentBytes > maxSystemLogExportBytes) {
    return NextResponse.json(
      {
        error: "Export exceeds the 40 MB limit. Narrow the filters and try again.",
        maxExportBytes: maxSystemLogExportBytes,
        estimatedBytes: exportInfo.totalDocumentBytes,
        matchingLogCount: exportInfo.count,
      },
      {
        status: 413,
        headers: {
          "cache-control": "no-store",
        },
      }
    );
  }

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