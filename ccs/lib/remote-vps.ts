import { randomUUID } from "node:crypto";

import { Types } from "mongoose";

import RemoteVpsInteractionLogModel from "@/models/RemoteVpsInteractionLog";
import RemoteVpsModel, { RemoteVpsDocument } from "@/models/RemoteVps";
import {
  LogInteractionType,
  LogResult,
  RemoteVpsInteractionLogRecord,
  RemoteVpsRecord,
  VpsEnvironment,
  VpsProtocol,
  VpsStatus,
  logInteractionTypeOptions,
  logResultOptions,
  vpsEnvironmentOptions,
  vpsProtocolOptions,
} from "@/lib/remote-vps-shared";

const actorFallback = "operator@control-center";

const sensitiveKeyPattern = /(password|secret|token|authorization|cookie|apiKey|accessKey|privateKey)/i;

const safeString = (value: unknown, fallback = "") =>
  typeof value === "string" ? value.trim() : fallback;

const toNullableIso = (value: Date | string | null | undefined) =>
  value ? new Date(value).toISOString() : null;

function truncateString(value: string, maxLength = 600) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}...`;
}

export function sanitizePayload(value: unknown, depth = 0): unknown {
  if (depth > 5) {
    return "[truncated-depth]";
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return truncateString(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 25).map((entry) => sanitizePayload(entry, depth + 1));
  }

  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).reduce<
      Record<string, unknown>
    >((accumulator, [key, entry]) => {
      accumulator[key] = sensitiveKeyPattern.test(key)
        ? "[masked]"
        : sanitizePayload(entry, depth + 1);
      return accumulator;
    }, {});
  }

  return String(value);
}

function hasToObject(
  value: RemoteVpsDocument | Record<string, unknown>
): value is RemoteVpsDocument & { toObject(): Record<string, unknown> } {
  return typeof (value as { toObject?: unknown }).toObject === "function";
}

export function serializeVps(document: RemoteVpsDocument | Record<string, unknown>) {
  const source = hasToObject(document) ? document.toObject() : document;

  return {
    id: String(source._id),
    name: safeString(source.name),
    host: safeString(source.host),
    port: Number(source.port),
    protocol: source.protocol as VpsProtocol,
    environment: source.environment as VpsEnvironment,
    region: safeString(source.region),
    provider: safeString(source.provider),
    controllerVersion: safeString(source.controllerVersion),
    status: source.status as VpsStatus,
    statusReason: safeString(source.statusReason),
    lastSeenAt: toNullableIso(source.lastSeenAt as Date | string | null),
    lastHealthCheckAt: toNullableIso(
      source.lastHealthCheckAt as Date | string | null
    ),
    lastHealthCheckResult: source.lastHealthCheckResult as
      | "success"
      | "failed"
      | "timeout"
      | "unknown",
    tags: Array.isArray(source.tags)
      ? source.tags.map((tag) => String(tag))
      : [],
    notes: safeString(source.notes),
    isEnabled: Boolean(source.isEnabled),
    createdAt: new Date(source.createdAt as Date | string).toISOString(),
    updatedAt: new Date(source.updatedAt as Date | string).toISOString(),
    createdBy: safeString(source.createdBy),
    updatedBy: safeString(source.updatedBy),
  } satisfies RemoteVpsRecord;
}

export function serializeInteractionLog(
  document: Record<string, unknown>
): RemoteVpsInteractionLogRecord {
  return {
    id: String(document._id),
    vpsId: String(document.vpsId),
    correlationId: safeString(document.correlationId),
    direction: document.direction as RemoteVpsInteractionLogRecord["direction"],
    interactionType:
      document.interactionType as RemoteVpsInteractionLogRecord["interactionType"],
    requestMethod: safeString(document.requestMethod, "GET"),
    requestPath: safeString(document.requestPath, "/"),
    requestPayload: document.requestPayload ?? null,
    responseStatusCode:
      typeof document.responseStatusCode === "number"
        ? document.responseStatusCode
        : null,
    responsePayload: document.responsePayload ?? null,
    result: document.result as LogResult,
    errorCode: safeString(document.errorCode),
    errorMessage: safeString(document.errorMessage),
    durationMs:
      typeof document.durationMs === "number" ? document.durationMs : null,
    attempt: typeof document.attempt === "number" ? document.attempt : 1,
    initiatedBy:
      document.initiatedBy as RemoteVpsInteractionLogRecord["initiatedBy"],
    initiatedByUserId: safeString(document.initiatedByUserId),
    createdAt: new Date(document.createdAt as Date | string).toISOString(),
  };
}

function normalizeTags(input: unknown) {
  if (Array.isArray(input)) {
    return input
      .map((tag) => safeString(tag))
      .filter(Boolean)
      .slice(0, 20);
  }

  if (typeof input === "string") {
    return input
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 20);
  }

  return [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface VpsPayload {
  name: string;
  host: string;
  port: number;
  protocol: VpsProtocol;
  environment: VpsEnvironment;
  region: string;
  provider: string;
  tags: string[];
  notes: string;
  isEnabled: boolean;
}

export class PayloadValidationError extends Error {
  constructor(public errors: Record<string, string>) {
    super("Invalid VPS payload");
  }
}

export class DuplicateVpsError extends Error {
  constructor() {
    super("An active VPS already uses this protocol, host, and port.");
  }
}

export function validateVpsPayload(input: unknown): VpsPayload {
  if (!isPlainObject(input)) {
    throw new PayloadValidationError({
      form: "Request body must be a JSON object.",
    });
  }

  const errors: Record<string, string> = {};
  const name = safeString(input.name);
  const host = safeString(input.host).toLowerCase();
  const protocol = safeString(input.protocol) as VpsProtocol;
  const environment = safeString(input.environment) as VpsEnvironment;
  const provider = safeString(input.provider);
  const region = safeString(input.region);
  const notes = safeString(input.notes);
  const portNumber = Number(input.port);
  const tags = normalizeTags(input.tags);
  const isEnabled =
    typeof input.isEnabled === "boolean" ? input.isEnabled : Boolean(input.isEnabled);

  if (!name) {
    errors.name = "Name is required.";
  }

  if (!host) {
    errors.host = "Host is required.";
  }

  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    errors.port = "Port must be a valid TCP port.";
  }

  if (!vpsProtocolOptions.includes(protocol)) {
    errors.protocol = "Protocol must be http or https.";
  }

  if (!vpsEnvironmentOptions.includes(environment)) {
    errors.environment = "Environment is required.";
  }

  if (!provider) {
    errors.provider = "Provider is required.";
  }

  if (Object.keys(errors).length > 0) {
    throw new PayloadValidationError(errors);
  }

  return {
    name,
    host,
    port: portNumber,
    protocol,
    environment,
    region,
    provider,
    tags,
    notes,
    isEnabled,
  };
}

export async function ensureNoActiveDuplicate(
  payload: Pick<VpsPayload, "protocol" | "host" | "port">,
  excludeId?: string
) {
  const query: Record<string, unknown> = {
    protocol: payload.protocol,
    host: payload.host,
    port: payload.port,
    isDeleted: false,
  };

  if (excludeId) {
    query._id = { $ne: excludeId };
  }

  const existing = await RemoteVpsModel.findOne(query).lean();

  if (existing) {
    throw new DuplicateVpsError();
  }
}

export function getActorFromRequest(request: Request) {
  return (
    request.headers.get("x-operator-id") ??
    request.headers.get("x-user-id") ??
    actorFallback
  );
}

export function getListQuery(searchParams: URLSearchParams) {
  const page = Math.max(1, Number(searchParams.get("page") ?? 1));
  const pageSize = Math.min(
    100,
    Math.max(1, Number(searchParams.get("pageSize") ?? 10))
  );
  const search = safeString(searchParams.get("search"));
  const status = safeString(searchParams.get("status"));
  const environment = safeString(searchParams.get("environment"));
  const sortField = safeString(searchParams.get("sortField"), "updatedAt");
  const sortDirection = safeString(searchParams.get("sortDirection"), "desc");

  const filter: Record<string, unknown> = { isDeleted: false };

  if (status) {
    filter.status = status;
  }

  if (environment) {
    filter.environment = environment;
  }

  if (search) {
    const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [
      { name: regex },
      { host: regex },
      { provider: regex },
      { tags: regex },
    ];
  }

  const sortFieldMap: Record<string, string> = {
    name: "name",
    status: "status",
    createdAt: "createdAt",
    lastSeenAt: "lastSeenAt",
    updatedAt: "updatedAt",
  };

  const sort: Record<string, 1 | -1> = {
    [sortFieldMap[sortField] ?? "updatedAt"]:
      sortDirection === "asc" ? 1 : -1,
  };

  return { filter, page, pageSize, sort };
}

export function getLogListQuery(searchParams: URLSearchParams) {
  const page = Math.max(1, Number(searchParams.get("page") ?? 1));
  const pageSize = Math.min(
    100,
    Math.max(1, Number(searchParams.get("pageSize") ?? 20))
  );
  const result = safeString(searchParams.get("result"));
  const interactionType = safeString(searchParams.get("interactionType"));
  const startAt = safeString(searchParams.get("startAt"));
  const endAt = safeString(searchParams.get("endAt"));

  const filter: Record<string, unknown> = {};

  if (logResultOptions.includes(result as LogResult)) {
    filter.result = result;
  }

  if (logInteractionTypeOptions.includes(interactionType as LogInteractionType)) {
    filter.interactionType = interactionType;
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

  return { filter, page, pageSize };
}

export async function findVpsById(id: string, includeDeleted = false) {
  if (!Types.ObjectId.isValid(id)) {
    return null;
  }

  return RemoteVpsModel.findOne({
    _id: id,
    ...(includeDeleted ? {} : { isDeleted: false }),
  });
}

export async function createInteractionLog(entry: {
  vpsId: string;
  correlationId: string;
  direction: "outbound_request" | "inbound_response" | "internal_event";
  interactionType: LogInteractionType;
  requestMethod?: string;
  requestPath?: string;
  requestPayload?: unknown;
  responseStatusCode?: number | null;
  responsePayload?: unknown;
  result: LogResult;
  errorCode?: string;
  errorMessage?: string;
  durationMs?: number | null;
  attempt?: number;
  initiatedBy?: "system" | "operator" | "scheduler";
  initiatedByUserId?: string;
  createdAt?: Date;
}) {
  await RemoteVpsInteractionLogModel.create({
    ...entry,
    requestMethod: entry.requestMethod ?? "GET",
    requestPath: entry.requestPath ?? "/",
    requestPayload: sanitizePayload(entry.requestPayload ?? null),
    responseStatusCode: entry.responseStatusCode ?? null,
    responsePayload: sanitizePayload(entry.responsePayload ?? null),
    errorCode: entry.errorCode ?? "",
    errorMessage: entry.errorMessage ?? "",
    durationMs: entry.durationMs ?? null,
    attempt: entry.attempt ?? 1,
    initiatedBy: entry.initiatedBy ?? "operator",
    initiatedByUserId: entry.initiatedByUserId ?? actorFallback,
    createdAt: entry.createdAt ?? new Date(),
  });
}

export function buildBaseUrl(vps: Pick<RemoteVpsRecord, "protocol" | "host" | "port">) {
  return `${vps.protocol}://${vps.host}:${vps.port}`;
}

async function parseResponsePayload(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    return sanitizePayload(await response.json());
  }

  return {
    body: truncateString(await response.text(), 1200),
  };
}

function extractControllerVersion(payload: unknown) {
  if (!isPlainObject(payload)) {
    return "";
  }

  if (typeof payload.version === "string") {
    return payload.version;
  }

  if (typeof payload.controllerVersion === "string") {
    return payload.controllerVersion;
  }

  if (isPlainObject(payload.controller) && typeof payload.controller.version === "string") {
    return payload.controller.version;
  }

  return "";
}

function isTimeoutError(error: unknown) {
  if (error instanceof Error) {
    return error.name === "TimeoutError" || error.name === "AbortError";
  }

  return false;
}

export async function performControllerProbe(options: {
  vps: RemoteVpsRecord;
  interactionType: Extract<LogInteractionType, "health_check" | "manual_test">;
  requestPath: string;
  initiatedByUserId: string;
}) {
  const correlationId = randomUUID();
  const startedAt = Date.now();
  const createdAt = new Date();
  const requestUrl = new URL(options.requestPath, buildBaseUrl(options.vps)).toString();

  await createInteractionLog({
    vpsId: options.vps.id,
    correlationId,
    direction: "outbound_request",
    interactionType: options.interactionType,
    requestMethod: "GET",
    requestPath: options.requestPath,
    requestPayload: null,
    result: "pending",
    initiatedBy: "operator",
    initiatedByUserId: options.initiatedByUserId,
    createdAt,
  });

  try {
    const response = await fetch(requestUrl, {
      method: "GET",
      headers: {
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      },
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });

    const durationMs = Date.now() - startedAt;
    const responsePayload = await parseResponsePayload(response);
    const controllerVersion = extractControllerVersion(responsePayload);
    const result: LogResult = response.ok ? "success" : "failed";
    const now = new Date();

    await createInteractionLog({
      vpsId: options.vps.id,
      correlationId,
      direction: "inbound_response",
      interactionType: options.interactionType,
      requestMethod: "GET",
      requestPath: options.requestPath,
      responseStatusCode: response.status,
      responsePayload,
      result,
      durationMs,
      initiatedBy: "operator",
      initiatedByUserId: options.initiatedByUserId,
      errorMessage: response.ok
        ? ""
        : `Remote controller responded with ${response.status}.`,
      createdAt: now,
    });

    await RemoteVpsModel.findByIdAndUpdate(options.vps.id, {
      status: options.vps.isEnabled
        ? response.ok
          ? "online"
          : "degraded"
        : "disabled",
      statusReason: options.vps.isEnabled
        ? response.ok
          ? `Last ${options.interactionType.replace("_", " ")} completed successfully.`
          : `Remote controller returned HTTP ${response.status}.`
        : "Record disabled by operator.",
      lastSeenAt: response.ok ? now : options.vps.lastSeenAt,
      lastHealthCheckAt: now,
      lastHealthCheckResult: response.ok ? "success" : "failed",
      controllerVersion: controllerVersion || options.vps.controllerVersion,
      updatedBy: options.initiatedByUserId,
    });

    return {
      correlationId,
      result,
      responseStatusCode: response.status,
      durationMs,
      responsePayload,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const now = new Date();
    const timeout = isTimeoutError(error);
    const errorMessage = error instanceof Error ? error.message : "Unknown probe failure";

    await createInteractionLog({
      vpsId: options.vps.id,
      correlationId,
      direction: "internal_event",
      interactionType: options.interactionType,
      requestMethod: "GET",
      requestPath: options.requestPath,
      result: timeout ? "timeout" : "failed",
      durationMs,
      initiatedBy: "operator",
      initiatedByUserId: options.initiatedByUserId,
      errorCode: timeout ? "REQUEST_TIMEOUT" : "FETCH_FAILED",
      errorMessage,
      createdAt: now,
    });

    await RemoteVpsModel.findByIdAndUpdate(options.vps.id, {
      status: options.vps.isEnabled ? "offline" : "disabled",
      statusReason: timeout
        ? "Remote controller timed out during the latest probe."
        : "Remote controller could not be reached.",
      lastHealthCheckAt: now,
      lastHealthCheckResult: timeout ? "timeout" : "failed",
      updatedBy: options.initiatedByUserId,
    });

    return {
      correlationId,
      result: timeout ? "timeout" : "failed",
      responseStatusCode: null,
      durationMs,
      responsePayload: null,
      errorMessage,
    };
  }
}
