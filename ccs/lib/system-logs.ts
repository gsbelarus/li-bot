import { Types } from "mongoose";

import {
  LogResult,
  RemoteVpsInteractionLogRecord,
  SystemLogFilterOption,
  SystemLogQueryOptions,
  SystemLogRecord,
} from "@/lib/remote-vps-shared";
import { serializeInteractionLog } from "@/lib/remote-vps";
import RemoteVpsInteractionLogModel from "@/models/RemoteVpsInteractionLog";
import RemoteVpsModel from "@/models/RemoteVps";

const safeString = (value: unknown, fallback = "") =>
  typeof value === "string" ? value.trim() : fallback;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePositiveIntegerParam(
  value: string | null,
  fallback: number,
  { min = 1, max }: { min?: number; max?: number } = {}
) {
  const parsed = Number.parseInt(value ?? "", 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const normalized = Math.max(min, parsed);
  return typeof max === "number" ? Math.min(max, normalized) : normalized;
}

function parseBooleanSearchParam(value: string | null) {
  const normalized = safeString(value).toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractScriptName(log: RemoteVpsInteractionLogRecord) {
  if (isPlainObject(log.requestPayload)) {
    const requestScriptName = safeString(log.requestPayload.scriptName);

    if (requestScriptName) {
      return requestScriptName;
    }
  }

  if (isPlainObject(log.responsePayload) && isPlainObject(log.responsePayload.requestPayload)) {
    return safeString(log.responsePayload.requestPayload.scriptName);
  }

  return "";
}

function formatResultFallback(result: LogResult) {
  switch (result) {
    case "success":
      return "Completed without reported errors.";
    case "pending":
      return "Result is still pending.";
    case "timeout":
      return "Request timed out.";
    case "failed":
      return "Operation failed.";
    case "rejected":
      return "Request was rejected.";
    case "retrying":
      return "Operation is retrying.";
    default:
      return result;
  }
}

function buildLogMessage(log: RemoteVpsInteractionLogRecord) {
  if (log.errorMessage) {
    return log.errorMessage;
  }

  if (log.scriptExecutionResult === "COMPLETED") {
    return "Script goal achieved.";
  }

  if (log.scriptExecutionResult === "NOT_COMPLETED") {
    return "Script finished without achieving the goal.";
  }

  if (log.scriptExecutionResult === "ALERT") {
    return "The script stopped because an alert condition was detected and the VPS requires manual review.";
  }

  if (log.scriptExecutionResult === "ERROR") {
    return "There was an error during script execution.";
  }

  if (typeof log.responseStatusCode === "number" && log.responseStatusCode >= 400) {
    return `Remote controller responded with HTTP ${log.responseStatusCode}.`;
  }

  return formatResultFallback(log.result);
}

function buildVpsAddress(source: Record<string, unknown> | undefined) {
  if (!source) {
    return "Unknown endpoint";
  }

  const host = safeString(source.host, "unknown-host");
  const port = typeof source.port === "number" ? source.port : null;
  return port ? `${host}:${port}` : host;
}

function buildVpsLabel(source: Record<string, unknown> | undefined) {
  if (!source) {
    return "Unknown VPS";
  }

  const name = safeString(source.name, "Unknown VPS");
  const address = buildVpsAddress(source);
  return `${name} (${address})`;
}

function toSystemLogRecord(
  log: Record<string, unknown>,
  vpsById: Map<string, Record<string, unknown>>
): SystemLogRecord {
  const base = serializeInteractionLog(log);
  const vps = vpsById.get(base.vpsId);

  return {
    ...base,
    vpsName: safeString(vps?.name, "Unknown VPS"),
    vpsAddress: buildVpsAddress(vps),
    vpsLabel: buildVpsLabel(vps),
    scriptName: extractScriptName(base),
    logMessage: buildLogMessage(base),
  };
}

export function getSystemLogListQuery(searchParams: URLSearchParams) {
  const page = parsePositiveIntegerParam(searchParams.get("page"), 1);
  const pageSize = parsePositiveIntegerParam(searchParams.get("pageSize"), 20, {
    max: 100,
  });
  const vpsId = safeString(searchParams.get("vpsId"));
  const scriptName = safeString(searchParams.get("scriptName"));
  const startAt = safeString(searchParams.get("startAt"));
  const endAt = safeString(searchParams.get("endAt"));
  const scriptResultsOnly = parseBooleanSearchParam(searchParams.get("scriptResultsOnly"));
  const search = safeString(searchParams.get("search"));

  const filter: Record<string, unknown> = {};

  if (vpsId && Types.ObjectId.isValid(vpsId)) {
    filter.vpsId = vpsId;
  }

  if (scriptName) {
    filter["requestPayload.scriptName"] = scriptName;
  }

  if (scriptResultsOnly) {
    filter.interactionType = "script_result";
  }

  if (search) {
    const regex = new RegExp(escapeRegex(search), "i");
    filter.$or = [
      { errorMessage: regex },
      { taskLogText: regex },
      { requestPath: regex },
      { interactionType: regex },
      { result: regex },
      { scriptExecutionResult: regex },
      { "requestPayload.scriptName": regex },
      { initiatedByUserId: regex },
    ];
  }

  const createdAtFilter: { $gte?: Date; $lte?: Date } = {};

  if (startAt) {
    createdAtFilter.$gte = new Date(startAt);
  }

  if (endAt) {
    createdAtFilter.$lte = new Date(endAt);
  }

  if (Object.keys(createdAtFilter).length > 0) {
    filter.createdAt = createdAtFilter;
  }

  return {
    filter,
    page,
    pageSize,
    query: {
      vpsId,
      scriptName,
      startAt,
      endAt,
      scriptResultsOnly,
      search,
    } satisfies SystemLogQueryOptions,
  };
}

export async function listSystemLogs(options: {
  filter: Record<string, unknown>;
  page: number;
  pageSize: number;
}) {
  const [items, totalCount, vpsRows, scriptOptions] = await Promise.all([
    RemoteVpsInteractionLogModel.find(options.filter)
      .sort({ createdAt: -1 })
      .skip((options.page - 1) * options.pageSize)
      .limit(options.pageSize)
      .lean(),
    RemoteVpsInteractionLogModel.countDocuments(options.filter),
    RemoteVpsModel.find({}, { name: 1, host: 1, port: 1 }).sort({ name: 1 }).lean(),
    RemoteVpsInteractionLogModel.distinct("requestPayload.scriptName", {
      "requestPayload.scriptName": { $type: "string", $ne: "" },
    }),
  ]);

  const vpsById = new Map<string, Record<string, unknown>>(
    vpsRows.map((entry) => [String(entry._id), entry as unknown as Record<string, unknown>])
  );

  return {
    items: items.map((item) => toSystemLogRecord(item as unknown as Record<string, unknown>, vpsById)),
    totalCount,
    page: options.page,
    pageSize: options.pageSize,
    vpsOptions: vpsRows.map((entry) => ({
      value: String(entry._id),
      label: buildVpsLabel(entry as unknown as Record<string, unknown>),
    })) satisfies SystemLogFilterOption[],
    scriptOptions: scriptOptions
      .map((entry) => safeString(entry))
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right)),
  };
}

export async function listAllSystemLogs(filter: Record<string, unknown>) {
  const [items, vpsRows] = await Promise.all([
    RemoteVpsInteractionLogModel.find(filter).sort({ createdAt: -1 }).lean(),
    RemoteVpsModel.find({}, { name: 1, host: 1, port: 1 }).sort({ name: 1 }).lean(),
  ]);

  const vpsById = new Map<string, Record<string, unknown>>(
    vpsRows.map((entry) => [String(entry._id), entry as unknown as Record<string, unknown>])
  );

  return items.map((item) => toSystemLogRecord(item as unknown as Record<string, unknown>, vpsById));
}

function stringifyStructuredValue(value: unknown) {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value ?? null);
}

function escapeCsvCell(value: string) {
  const normalized = value.replace(/\r?\n/g, " ");
  if (/[",]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }

  return normalized;
}

export function buildSystemLogsCsv(logs: SystemLogRecord[]) {
  const header = ["timestamp", "vps", "script", "logType", "logMessage", "result"];
  const rows = logs.map((log) => [
    log.createdAt,
    log.vpsLabel,
    log.scriptName,
    log.interactionType,
    log.logMessage,
    log.scriptExecutionResult || log.result,
  ]);

  return [header, ...rows]
    .map((row) => row.map((cell) => escapeCsvCell(String(cell ?? ""))).join(","))
    .join("\n");
}

export function buildSystemLogsJson(logs: SystemLogRecord[]) {
  return JSON.stringify(
    logs.map((log) => ({
      timestamp: log.createdAt,
      vps: log.vpsLabel,
      script: log.scriptName,
      logType: log.interactionType,
      logMessage: log.logMessage,
      result: log.scriptExecutionResult || log.result,
      record: {
        ...log,
        requestPayload: stringifyStructuredValue(log.requestPayload),
        responsePayload: stringifyStructuredValue(log.responsePayload),
      },
    })),
    null,
    2
  );
}

export async function getSystemLogById(logId: string) {
  if (!Types.ObjectId.isValid(logId)) {
    return null;
  }

  const item = await RemoteVpsInteractionLogModel.findById(logId).lean();

  if (!item) {
    return null;
  }

  const vps = await RemoteVpsModel.findById(item.vpsId, { name: 1, host: 1, port: 1 }).lean();
  const vpsById = new Map<string, Record<string, unknown>>(
    vps ? [[String(vps._id), vps as unknown as Record<string, unknown>]] : []
  );

  return toSystemLogRecord(item as unknown as Record<string, unknown>, vpsById);
}
