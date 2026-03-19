import { NextRequest, NextResponse } from "next/server";

import { connectToDatabase } from "@/lib/mongodb";
import { getSystemLogListQuery, listSystemLogs } from "@/lib/system-logs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  await connectToDatabase();

  const { filter, page, pageSize } = getSystemLogListQuery(request.nextUrl.searchParams);
  const response = await listSystemLogs({ filter, page, pageSize });

  return NextResponse.json(response);
}
