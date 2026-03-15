import { NextRequest, NextResponse } from "next/server";

import { connectToDatabase } from "@/lib/mongodb";
import {
  findVpsById,
  getLogListQuery,
  serializeInteractionLog,
} from "@/lib/remote-vps";
import RemoteVpsInteractionLogModel from "@/models/RemoteVpsInteractionLog";

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

  const { filter, page, pageSize } = getLogListQuery(request.nextUrl.searchParams);
  const scopedFilter = { ...filter, vpsId: id };

  const [items, totalCount] = await Promise.all([
    RemoteVpsInteractionLogModel.find(scopedFilter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    RemoteVpsInteractionLogModel.countDocuments(scopedFilter),
  ]);

  return NextResponse.json({
    items: items.map((entry) => serializeInteractionLog(entry)),
    totalCount,
    page,
    pageSize,
  });
}
