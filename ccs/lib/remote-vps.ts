import { randomUUID } from "node:crypto";

import { Types } from "mongoose";

import RemoteVpsInteractionLogModel from "@/models/RemoteVpsInteractionLog";
import RemoteVpsModel, { RemoteVpsDocument } from "@/models/RemoteVps";
import {
  ControllerCommand,
  LogInteractionType,
  LogResult,
  OpenClawDaemonStatus,
  OpenClawGatewayStatus,
  RemoteVpsInteractionLogRecord,
  RemoteVpsInteractionLogTimestampWarning,
  RemoteVpsRecord,
  RemoteVpsTimestampWarning,
  ScriptExecutionResult,
  VpsAlertDetails,
  VpsNotCompletedDetails,
  VpsEnvironment,
  VpsProtocol,
  VpsStatus,
  controllerCommandOptions,
  openClawDaemonStatusOptions,
  openClawGatewayStatusOptions,
  logInteractionTypeOptions,
  logResultOptions,
  scriptExecutionResultOptions,
  vpsEnvironmentOptions,
  vpsProtocolOptions,
} from "@/lib/remote-vps-shared";
import type { ScriptEngineMode } from "@/lib/scripts-shared";
import { normalizeStructuredInstructions } from "@/lib/scripts";

const actorFallback = "operator@control-center";
const fallbackIsoTimestamp = new Date(0).toISOString();
const DEFAULT_MOUSE_ACTIVITY_MIN_INTERVAL_MS = 9000;
const DEFAULT_MOUSE_ACTIVITY_MAX_INTERVAL_MS = 22000;
const DEFAULT_MOUSE_ACTIVITY_MAX_OFFSET_PX = 48;

const sensitiveKeyPattern = /(password|secret|token|authorization|cookie|apiKey|accessKey|privateKey)/i;

const safeString = (value: unknown, fallback = "") =>
  typeof value === "string" ? value.trim() : fallback;

interface NormalizedVisitedProfile {
  profileKey: string;
  profileUrl: string;
  visitedAt: Date;
}

interface NormalizedProcessedPost {
  postUrl: string;
  profileUrl: string;
  processedAt: Date;
  ageDays: number | null;
  publishedAtIso: Date | null;
  publishedAtText: string;
  textPreview: string;
}

function normalizeLinkedInProfileKey(value: unknown) {
  const raw = safeString(value);

  if (!raw) {
    return "";
  }

  try {
    const parsed = new URL(raw);
    const hostname = parsed.hostname.toLowerCase();

    if (hostname !== "linkedin.com" && !hostname.endsWith(".linkedin.com")) {
      return "";
    }

    const segments = parsed.pathname
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean);

    if (segments.length < 2) {
      return "";
    }

    const [profileType, profileSlug] = segments;

    if ((profileType !== "in" && profileType !== "creator") || !profileSlug) {
      return "";
    }

    return `/${profileType}/${profileSlug}`.toLowerCase();
  } catch {
    return "";
  }
}

function normalizeLinkedInProfileUrl(value: unknown) {
  const profileKey = normalizeLinkedInProfileKey(value);
  return profileKey ? `https://www.linkedin.com${profileKey}` : "";
}

function normalizeLinkedInPostUrl(value: unknown) {
  const raw = safeString(value);

  if (!raw) {
    return "";
  }

  try {
    const parsed = new URL(raw, "https://www.linkedin.com");
    const hostname = parsed.hostname.toLowerCase();

    if (hostname !== "linkedin.com" && !hostname.endsWith(".linkedin.com")) {
      return "";
    }

    const pathname = parsed.pathname.replace(/\/+$/g, "") || "/";

    if (!/(?:\/feed\/update\/|\/posts\/|\/activity\/)/i.test(pathname)) {
      return "";
    }

    return `https://www.linkedin.com${pathname}`;
  } catch {
    return "";
  }
}

function extractVisitedProfilesFromResultPayload(payload: unknown) {
  if (!isPlainObject(payload) || !isPlainObject(payload.result) || !Array.isArray(payload.result.visitedProfiles)) {
    return [] as NormalizedVisitedProfile[];
  }

  const visitedProfiles = payload.result.visitedProfiles.reduce<NormalizedVisitedProfile[]>((accumulator, entry) => {
    if (!isPlainObject(entry)) {
      return accumulator;
    }

    const profileUrl = normalizeLinkedInProfileUrl(entry.profileUrl);
    const profileKey = normalizeLinkedInProfileKey(profileUrl || entry.profileKey);

    if (!profileUrl || !profileKey) {
      return accumulator;
    }

    const visitedAtValue = entry.visitedAt instanceof Date ? entry.visitedAt : new Date(entry.visitedAt as string);
    const visitedAt = Number.isNaN(visitedAtValue.getTime()) ? new Date() : visitedAtValue;

    if (accumulator.some((item) => item.profileKey === profileKey)) {
      return accumulator;
    }

    accumulator.push({
      profileKey,
      profileUrl,
      visitedAt,
    });

    return accumulator;
  }, []);

  return visitedProfiles;
}

function extractProcessedPostsFromResultPayload(payload: unknown) {
  if (!isPlainObject(payload) || !isPlainObject(payload.result) || !Array.isArray(payload.result.processedPosts)) {
    return [] as NormalizedProcessedPost[];
  }

  const processedPosts = payload.result.processedPosts.reduce<NormalizedProcessedPost[]>((accumulator, entry) => {
    if (!isPlainObject(entry)) {
      return accumulator;
    }

    const postUrl = normalizeLinkedInPostUrl(entry.postUrl);

    if (!postUrl || accumulator.some((item) => item.postUrl === postUrl)) {
      return accumulator;
    }

    const profileUrl = normalizeLinkedInProfileUrl(entry.profileUrl);
    const processedAtValue = entry.processedAt instanceof Date ? entry.processedAt : new Date(entry.processedAt as string);
    const processedAt = Number.isNaN(processedAtValue.getTime()) ? new Date() : processedAtValue;
    const publishedAtIsoValue = entry.publishedAtIso instanceof Date
      ? entry.publishedAtIso
      : entry.publishedAtIso
        ? new Date(entry.publishedAtIso as string)
        : null;

    accumulator.push({
      postUrl,
      profileUrl,
      processedAt,
      ageDays:
        typeof entry.ageDays === "number" && Number.isFinite(entry.ageDays)
          ? entry.ageDays
          : null,
      publishedAtIso:
        publishedAtIsoValue && !Number.isNaN(publishedAtIsoValue.getTime())
          ? publishedAtIsoValue
          : null,
      publishedAtText: safeString(entry.publishedAtText),
      textPreview: safeString(entry.textPreview),
    });

    return accumulator;
  }, []);

  return processedPosts;
}

function normalizeScriptExecutionResult(value: unknown): ScriptExecutionResult | null {
  const normalized = safeString(value) as ScriptExecutionResult;
  return scriptExecutionResultOptions.includes(normalized) ? normalized : null;
}

function normalizeOpenClawDaemonStatus(value: unknown): OpenClawDaemonStatus {
  const normalized = safeString(value) as OpenClawDaemonStatus;
  return openClawDaemonStatusOptions.includes(normalized) ? normalized : "unknown";
}

function normalizeOpenClawGatewayStatus(value: unknown): OpenClawGatewayStatus {
  const normalized = safeString(value) as OpenClawGatewayStatus;
  return openClawGatewayStatusOptions.includes(normalized) ? normalized : "unknown";
}

function normalizeAlertStepOrder(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : null;
}

function getControllerTaskAlertDetails(options: {
  payload: unknown;
  taskId?: string;
  detectedAt?: Date | string | null;
}) {
  const state = getControllerTaskResultState(options.payload);

  if (!state.alerted || !state.alert) {
    return null;
  }

  const detectedAt = toNullableIsoResult("createdAt", options.detectedAt ?? null).value;
  const reason = safeString(state.alert.reason);
  const stepKind = safeString(state.alert.stepKind);
  const instruction = safeString(state.alert.instruction);
  const stepOrder = normalizeAlertStepOrder(state.alert.stepOrder);
  const message = reason
    ? `Alert condition detected: ${reason}`
    : "Alert condition detected during script execution.";

  return {
    taskId: safeString(options.taskId),
    message,
    reason,
    stepOrder,
    stepKind,
    instruction,
    detectedAt,
  } satisfies VpsAlertDetails;
}

function getControllerTaskNotCompletedDetails(options: {
  payload: unknown;
  taskLogText?: string;
  taskId?: string;
  detectedAt?: Date | string | null;
}) {
  const state = getControllerTaskResultState(options.payload);

  if (!state.endedEarly) {
    return null;
  }

  const resultPayload = isPlainObject(options.payload) && isPlainObject(options.payload.result)
    ? options.payload.result
    : null;
  const earlyExit = resultPayload && isPlainObject(resultPayload.earlyExit)
    ? resultPayload.earlyExit
    : null;
  const logMatch = safeString(options.taskLogText).match(/TASK_BRANCH_END\s+(\{[^\r\n]*\})/);
  const logEntry = (() => {
    if (!logMatch) {
      return null;
    }

    try {
      const parsed = JSON.parse(logMatch[1]);
      return isPlainObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  })();
  const stepSource = earlyExit ?? (isPlainObject(logEntry?.step) ? logEntry.step : null);
  const detectedAtInput =
    options.detectedAt instanceof Date || typeof options.detectedAt === "string"
      ? options.detectedAt
      : typeof logEntry?.endedAt === "string"
        ? logEntry.endedAt
        : typeof resultPayload?.finishedAt === "string"
          ? resultPayload.finishedAt
          : null;
  const detectedAt = toNullableIsoResult(
    "createdAt",
    detectedAtInput
  ).value;
  const reason = safeString(earlyExit?.reason || logEntry?.reason);
  const stepKind = safeString(earlyExit?.stepKind || stepSource?.kind);
  const instruction = safeString(earlyExit?.instruction || stepSource?.instruction);
  const stepOrder = normalizeAlertStepOrder(earlyExit?.stepOrder ?? stepSource?.order);
  const message = reason
    ? `Script completed and ended early through branch logic. Cause: ${reason}`
    : "Script completed and ended early through branch logic.";

  return {
    taskId: safeString(options.taskId),
    message,
    reason,
    stepOrder,
    stepKind,
    instruction,
    detectedAt,
  } satisfies VpsNotCompletedDetails;
}

function maskSecret(secret: string) {
  if (!secret) {
    return "";
  }

  if (secret.length <= 8) {
    return "*".repeat(secret.length);
  }

  return `${secret.slice(0, 4)}${"*".repeat(Math.max(4, secret.length - 8))}${secret.slice(-4)}`;
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

function parseBooleanInput(
  value: unknown,
  fallback: boolean
): { value: boolean; isValid: boolean } {
  if (value === undefined || value === null || value === "") {
    return { value: fallback, isValid: true };
  }

  if (typeof value === "boolean") {
    return { value, isValid: true };
  }

  if (typeof value === "number") {
    if (value === 1) {
      return { value: true, isValid: true };
    }

    if (value === 0) {
      return { value: false, isValid: true };
    }

    return { value: fallback, isValid: false };
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();

    if (normalized === "true" || normalized === "1") {
      return { value: true, isValid: true };
    }

    if (normalized === "false" || normalized === "0") {
      return { value: false, isValid: true };
    }

    return { value: fallback, isValid: false };
  }

  return { value: fallback, isValid: false };
}

function parseIntegerInput(
  value: unknown,
  fallback: number,
  { min = 1, max }: { min?: number; max?: number } = {}
): { value: number; isValid: boolean } {
  if (value === undefined || value === null || value === "") {
    return { value: fallback, isValid: true };
  }

  let parsed: number | null = null;

  if (typeof value === "number" && Number.isFinite(value)) {
    parsed = Math.floor(value);
  } else if (typeof value === "string") {
    const normalized = value.trim();

    if (!normalized) {
      return { value: fallback, isValid: true };
    }

    const candidate = Number.parseInt(normalized, 10);

    if (Number.isFinite(candidate)) {
      parsed = candidate;
    }
  }

  if (parsed === null) {
    return { value: fallback, isValid: false };
  }

  const normalized = Math.max(min, parsed);
  return {
    value: typeof max === "number" ? Math.min(max, normalized) : normalized,
    isValid: true,
  };
}

const toIsoResult = <TWarning extends string>(
  warning: TWarning,
  value: Date | string | null | undefined,
  fallback = fallbackIsoTimestamp
): { value: string; warning?: TWarning } => {
  if (value === null || value === undefined) {
    return { value: fallback, warning };
  }

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return { value: fallback, warning };
  }

  return { value: date.toISOString() };
};

const toNullableIsoResult = <TWarning extends string>(
  warning: TWarning,
  value: Date | string | null | undefined
): { value: string | null; warning?: TWarning } => {
  if (value === null || value === undefined) {
    return { value: null };
  }

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return { value: null, warning };
  }

  return { value: date.toISOString() };
};

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
  value: RemoteVpsDocument | RemoteVpsRecord | Record<string, unknown>
): value is RemoteVpsDocument & { toObject(): Record<string, unknown> } {
  return typeof (value as { toObject?: unknown }).toObject === "function";
}

export function serializeVps(document: RemoteVpsDocument | RemoteVpsRecord | Record<string, unknown>) {
  const source = hasToObject(document) ? document.toObject() : document;
  const sourceRecord = source as Record<string, unknown>;
  const serializedId =
    sourceRecord._id === null || sourceRecord._id === undefined
      ? safeString(sourceRecord.id)
      : String(sourceRecord._id);
  const controllerSecretKey = safeString(sourceRecord.controllerSecretKey);
  const lastSeenAt = toNullableIsoResult("lastSeenAt", source.lastSeenAt as Date | string | null | undefined);
  const lastHealthCheckAt = toNullableIsoResult(
    "lastHealthCheckAt",
    source.lastHealthCheckAt as Date | string | null | undefined
  );
  const createdAt = toIsoResult("createdAt", source.createdAt as Date | string | null | undefined);
  const updatedAt = toIsoResult("updatedAt", source.updatedAt as Date | string | null | undefined);
  const alertDetailsSource = isPlainObject(source.alertDetails) ? source.alertDetails : null;
  const alertDetectedAt = toNullableIsoResult(
    "updatedAt",
    alertDetailsSource?.detectedAt as Date | string | null | undefined
  );
  const timestampWarnings = [
    lastSeenAt.warning,
    lastHealthCheckAt.warning,
    createdAt.warning,
    updatedAt.warning,
  ].filter((warning): warning is RemoteVpsTimestampWarning => Boolean(warning));

  return {
    id: serializedId,
    name: safeString(source.name),
    host: safeString(source.host),
    port: Number(source.port),
    protocol: source.protocol as VpsProtocol,
    environment: source.environment as VpsEnvironment,
    region: safeString(source.region),
    provider: safeString(source.provider),
    defaultMouseActivityEnabled: Boolean(source.defaultMouseActivityEnabled),
    defaultMouseActivityMinIntervalMs: parsePositiveIntegerParam(
      typeof source.defaultMouseActivityMinIntervalMs === "number"
        ? String(source.defaultMouseActivityMinIntervalMs)
        : null,
      DEFAULT_MOUSE_ACTIVITY_MIN_INTERVAL_MS,
      { min: 250 }
    ),
    defaultMouseActivityMaxIntervalMs: parsePositiveIntegerParam(
      typeof source.defaultMouseActivityMaxIntervalMs === "number"
        ? String(source.defaultMouseActivityMaxIntervalMs)
        : null,
      DEFAULT_MOUSE_ACTIVITY_MAX_INTERVAL_MS,
      { min: 250 }
    ),
    defaultMouseActivityMaxOffsetPx: parsePositiveIntegerParam(
      typeof source.defaultMouseActivityMaxOffsetPx === "number"
        ? String(source.defaultMouseActivityMaxOffsetPx)
        : null,
      DEFAULT_MOUSE_ACTIVITY_MAX_OFFSET_PX,
      { min: 1 }
    ),
    hasControllerSecret: Boolean(controllerSecretKey),
    controllerSecretKeyMasked: maskSecret(controllerSecretKey),
    controllerVersion: safeString(source.controllerVersion),
    openClawDaemonStatus: normalizeOpenClawDaemonStatus(source.openClawDaemonStatus),
    openClawVersion: safeString(source.openClawVersion),
    openClawGatewayStatus: normalizeOpenClawGatewayStatus(source.openClawGatewayStatus),
    status: source.status as VpsStatus,
    statusReason: safeString(source.statusReason),
    alertDetails: alertDetailsSource
      ? {
        taskId: safeString(alertDetailsSource.taskId),
        message: safeString(alertDetailsSource.message),
        reason: safeString(alertDetailsSource.reason),
        stepOrder: normalizeAlertStepOrder(alertDetailsSource.stepOrder),
        stepKind: safeString(alertDetailsSource.stepKind),
        instruction: safeString(alertDetailsSource.instruction),
        detectedAt: alertDetectedAt.value,
      }
      : null,
    lastScriptExecutionResult: normalizeScriptExecutionResult(sourceRecord.lastScriptExecutionResult),
    lastSeenAt: lastSeenAt.value,
    lastHealthCheckAt: lastHealthCheckAt.value,
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
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
    createdBy: safeString(source.createdBy),
    updatedBy: safeString(source.updatedBy),
    timestampWarnings,
  } satisfies RemoteVpsRecord;
}

export interface ControllerConnectionDetails extends RemoteVpsRecord {
  controllerSecretKey: string;
}

export function getControllerConnectionDetails(
  document: RemoteVpsDocument | RemoteVpsRecord | Record<string, unknown>
): ControllerConnectionDetails {
  const source = hasToObject(document) ? document.toObject() : document;
  const sourceRecord = source as Record<string, unknown>;

  return {
    ...serializeVps(source),
    controllerSecretKey: safeString(sourceRecord.controllerSecretKey),
  };
}

export function serializeInteractionLog(
  document: Record<string, unknown>
): RemoteVpsInteractionLogRecord {
  const createdAt = toIsoResult("createdAt", document.createdAt as Date | string | null | undefined);
  const notCompletedDetailsSource = isPlainObject(document.notCompletedDetails)
    ? document.notCompletedDetails
    : null;
  const notCompletedDetectedAt = toNullableIsoResult(
    "createdAt",
    notCompletedDetailsSource?.detectedAt as Date | string | null | undefined
  );

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
    scriptExecutionResult: normalizeScriptExecutionResult(document.scriptExecutionResult),
    notCompletedDetails: notCompletedDetailsSource
      ? {
        taskId: safeString(notCompletedDetailsSource.taskId),
        message: safeString(notCompletedDetailsSource.message),
        reason: safeString(notCompletedDetailsSource.reason),
        stepOrder: normalizeAlertStepOrder(notCompletedDetailsSource.stepOrder),
        stepKind: safeString(notCompletedDetailsSource.stepKind),
        instruction: safeString(notCompletedDetailsSource.instruction),
        detectedAt: notCompletedDetectedAt.value,
      }
      : null,
    errorCode: safeString(document.errorCode),
    errorMessage: safeString(document.errorMessage),
    durationMs:
      typeof document.durationMs === "number" ? document.durationMs : null,
    attempt: typeof document.attempt === "number" ? document.attempt : 1,
    initiatedBy:
      document.initiatedBy as RemoteVpsInteractionLogRecord["initiatedBy"],
    initiatedByUserId: safeString(document.initiatedByUserId),
    taskLogText: safeString(document.taskLogText),
    createdAt: createdAt.value,
    timestampWarnings: createdAt.warning
      ? [createdAt.warning as RemoteVpsInteractionLogTimestampWarning]
      : [],
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

function toNotCompletedDetailsRecord(details: VpsNotCompletedDetails | null | undefined) {
  if (!details) {
    return null;
  }

  return {
    taskId: details.taskId,
    message: details.message,
    reason: details.reason,
    stepOrder: details.stepOrder,
    stepKind: details.stepKind,
    instruction: details.instruction,
    detectedAt: details.detectedAt ? new Date(details.detectedAt) : null,
  };
}

function getControllerTaskResultState(payload: unknown) {
  if (!isPlainObject(payload)) {
    return {
      status: "unknown",
      endedEarly: false,
      alerted: false,
      alert: null as Record<string, unknown> | null,
      error: null as unknown,
    };
  }

  const resultPayload = isPlainObject(payload.result) ? payload.result : null;

  return {
    status: safeString(payload.status),
    endedEarly: Boolean(resultPayload?.endedEarly === true),
    alerted: Boolean(resultPayload?.alerted === true),
    alert: isPlainObject(resultPayload?.alert) ? resultPayload.alert : null,
    error: payload.error ?? null,
  };
}

function getControllerTaskResultLogResult(payload: unknown): LogResult {
  const { status } = getControllerTaskResultState(payload);

  if (status === "completed") {
    return "success";
  }

  if (status === "failed") {
    return "failed";
  }

  if (status === "pending" || status === "in_progress") {
    return "pending";
  }

  return "failed";
}

function getControllerTaskResultMessage(payload: unknown) {
  const { status, endedEarly, alerted, alert, error } = getControllerTaskResultState(payload);
  const alertDetails = getControllerTaskAlertDetails({ payload });
  const notCompletedDetails = getControllerTaskNotCompletedDetails({ payload });

  if (status === "completed" && alerted) {
    if (alertDetails?.message) {
      return alertDetails.message;
    }

    if (typeof alert?.reason === "string" && alert.reason) {
      return `Alert condition detected: ${alert.reason}`;
    }

    return "Alert condition detected during script execution.";
  }

  if (status === "completed") {
    if (endedEarly) {
      return notCompletedDetails?.message || "Script completed and ended early through branch logic.";
    }

    return "Script completed successfully.";
  }

  if (status === "failed") {
    if (typeof error === "string") {
      return error;
    }

    if (isPlainObject(error) && typeof error.message === "string") {
      return error.message;
    }

    return "Script execution failed.";
  }

  if (status === "pending" || status === "in_progress") {
    return "Script results are not available yet.";
  }

  return "Script result payload was not recognized.";
}

function getTaskLogText(payload: unknown) {
  if (!isPlainObject(payload) || !isPlainObject(payload.taskLog) || !isPlainObject(payload.taskLog.chunks)) {
    return "";
  }

  return Object.entries(payload.taskLog.chunks)
    .sort((left, right) => Number(left[0]) - Number(right[0]))
    .map(([, chunk]) => (typeof chunk === "string" ? chunk : ""))
    .join("");
}

function getStructuredScriptStepCount(script: unknown) {
  if (!isPlainObject(script)) {
    return null;
  }

  return normalizeStructuredInstructions(script).steps.length;
}

function getExecutedStepCount(payload: unknown) {
  if (!isPlainObject(payload) || !isPlainObject(payload.result) || !Array.isArray(payload.result.steps)) {
    return null;
  }

  return payload.result.steps.length;
}

function evaluateScriptExecutionResult(options: {
  initialScript: unknown;
  resultPayload: unknown;
  taskLogText: string;
}): ScriptExecutionResult | null {
  const { status, error, alerted } = getControllerTaskResultState(options.resultPayload);

  if (status === "failed") {
    return "ERROR";
  }

  if (status !== "completed") {
    return null;
  }

  const taskLogText = options.taskLogText;
  const hasAlertLog = /\bTASK_ALERT\b/.test(taskLogText);
  const hasLoggedTaskError = /\bTASK_ERROR\b/.test(taskLogText);

  if (alerted || hasAlertLog) {
    return "ALERT";
  }

  if (hasLoggedTaskError || Boolean(error)) {
    return "ERROR";
  }

  const endedEarly = Boolean(
    isPlainObject(options.resultPayload) &&
    isPlainObject(options.resultPayload.result) &&
    options.resultPayload.result.endedEarly === true
  );

  if (endedEarly || /\bTASK_BRANCH_END\b/.test(taskLogText)) {
    return "NOT_COMPLETED";
  }

  const expectedStepCount = getStructuredScriptStepCount(options.initialScript);
  const executedStepCount = getExecutedStepCount(options.resultPayload);

  if (
    typeof expectedStepCount === "number" &&
    typeof executedStepCount === "number" &&
    executedStepCount < expectedStepCount
  ) {
    return "NOT_COMPLETED";
  }

  return "COMPLETED";
}

interface ControllerTaskDispatchContext {
  scriptId: string;
  scriptName: string;
  engineMode: ScriptEngineMode;
  mouseActivityEnabled: boolean;
  mouseActivityConfig: {
    minIntervalMs: number | null;
    maxIntervalMs: number | null;
    maxOffsetPx: number | null;
  };
  script: unknown;
}

interface ControllerCommandDispatchLogContext {
  correlationId: string;
  requestPayload: Record<string, unknown> | null;
}

function normalizeControllerCommand(value: unknown): ControllerCommand | null {
  const normalized = safeString(value) as ControllerCommand;
  return controllerCommandOptions.includes(normalized) ? normalized : null;
}

function isScriptCommand(command: ControllerCommand | null) {
  return command === "executeScript";
}

function getControllerCommandLabel(command: ControllerCommand | null) {
  switch (command) {
    case "executeScript":
      return "Script execution";
    case "openclawUpdate":
      return "OpenClaw update";
    case "openclawGatewayRestart":
      return "OpenClaw gateway restart";
    default:
      return "Remote command";
  }
}

function extractControllerCommandFromPayload(payload: unknown) {
  if (!isPlainObject(payload)) {
    return null;
  }

  const directCommand = normalizeControllerCommand(payload.command);

  if (directCommand) {
    return directCommand;
  }

  if (isPlainObject(payload.result)) {
    return normalizeControllerCommand(payload.result.command);
  }

  return null;
}

async function findCommandDispatchLogContext(vpsId: string, taskId: string) {
  const dispatchResponseLog = await RemoteVpsInteractionLogModel.findOne({
    vpsId,
    interactionType: "command_dispatch",
    direction: "inbound_response",
    "responsePayload.taskId": taskId,
  })
    .sort({ createdAt: -1 })
    .lean();

  if (!dispatchResponseLog?.correlationId) {
    return null;
  }

  const dispatchRequestLog = await RemoteVpsInteractionLogModel.findOne({
    vpsId,
    interactionType: "command_dispatch",
    direction: "outbound_request",
    correlationId: dispatchResponseLog.correlationId,
  })
    .sort({ createdAt: -1 })
    .lean();

  return {
    correlationId: dispatchResponseLog.correlationId,
    requestPayload: isPlainObject(dispatchRequestLog?.requestPayload)
      ? dispatchRequestLog.requestPayload
      : null,
  } satisfies ControllerCommandDispatchLogContext;
}

async function findCommandDispatchContext(vpsId: string, taskId: string) {
  const dispatchContext = await findCommandDispatchLogContext(vpsId, taskId);

  if (!dispatchContext?.requestPayload) {
    return null;
  }

  const requestPayload = dispatchContext.requestPayload;

  return {
    scriptId: safeString(requestPayload.scriptId),
    scriptName: safeString(requestPayload.scriptName),
    engineMode:
      requestPayload.engineMode === "ai_driven" ? "ai_driven" : "deterministic",
    mouseActivityEnabled: requestPayload.mouseActivityEnabled === true,
    mouseActivityConfig: isPlainObject(requestPayload.mouseActivityConfig)
      ? {
        minIntervalMs:
          typeof requestPayload.mouseActivityConfig.minIntervalMs === "number"
            ? requestPayload.mouseActivityConfig.minIntervalMs
            : null,
        maxIntervalMs:
          typeof requestPayload.mouseActivityConfig.maxIntervalMs === "number"
            ? requestPayload.mouseActivityConfig.maxIntervalMs
            : null,
        maxOffsetPx:
          typeof requestPayload.mouseActivityConfig.maxOffsetPx === "number"
            ? requestPayload.mouseActivityConfig.maxOffsetPx
            : null,
      }
      : {
        minIntervalMs: null,
        maxIntervalMs: null,
        maxOffsetPx: null,
      },
    script: requestPayload.script ?? null,
  } satisfies ControllerTaskDispatchContext;
}

function buildScriptResultRequestPayload(
  taskId: string,
  dispatchContext: ControllerTaskDispatchContext | null
) {
  return {
    taskId,
    scriptId: dispatchContext?.scriptId ?? "",
    scriptName: dispatchContext?.scriptName ?? "",
    engineMode: dispatchContext?.engineMode ?? "deterministic",
    mouseActivityEnabled: dispatchContext?.mouseActivityEnabled ?? false,
    mouseActivityConfig: dispatchContext?.mouseActivityConfig ?? {
      minIntervalMs: null,
      maxIntervalMs: null,
      maxOffsetPx: null,
    },
    script: dispatchContext?.script ?? null,
  };
}

function getControllerCommandResultMessage(payload: unknown) {
  const { status, error } = getControllerTaskResultState(payload);
  const command = extractControllerCommandFromPayload(payload);
  const commandLabel = getControllerCommandLabel(command);
  const resultPayload = isPlainObject(payload) && isPlainObject(payload.result)
    ? payload.result
    : null;
  const summary = safeString(resultPayload?.summary || resultPayload?.message);

  if (status === "completed") {
    return summary || `${commandLabel} completed successfully.`;
  }

  if (status === "failed") {
    if (typeof error === "string") {
      return error;
    }

    if (isPlainObject(error) && typeof error.message === "string") {
      return error.message;
    }

    return `${commandLabel} failed.`;
  }

  if (status === "pending" || status === "in_progress") {
    return `${commandLabel} results are not available yet.`;
  }

  return `${commandLabel} result payload was not recognized.`;
}

function buildCommandResultLogDocument(options: {
  taskId: string;
  dispatchContext: ControllerCommandDispatchLogContext | null;
  responseStatusCode: number | null;
  responsePayload: unknown;
  durationMs: number | null;
  initiatedByUserId: string;
  taskLogText: string;
}) {
  const requestPayload = options.dispatchContext?.requestPayload ?? null;

  return {
    direction: "internal_event" as const,
    interactionType: "command_result" as const,
    requestMethod: "GET",
    requestPath: `/api/commands/${encodeURIComponent(options.taskId)}/results`,
    requestPayload: sanitizePayload(
      requestPayload
        ? {
          ...requestPayload,
          taskId: options.taskId,
        }
        : {
          taskId: options.taskId,
          command: extractControllerCommandFromPayload(options.responsePayload),
        }
    ),
    responseStatusCode: options.responseStatusCode,
    responsePayload: sanitizePayload(options.responsePayload),
    result: getControllerTaskResultLogResult(options.responsePayload),
    scriptExecutionResult: null,
    notCompletedDetails: null,
    durationMs: options.durationMs,
    initiatedBy: "operator" as const,
    initiatedByUserId: options.initiatedByUserId,
    taskLogText: options.taskLogText,
    errorCode:
      getControllerTaskResultState(options.responsePayload).status === "failed"
        ? "COMMAND_FAILED"
        : "",
    errorMessage: getControllerCommandResultMessage(options.responsePayload),
  };
}

function buildScriptResultLogDocument(options: {
  taskId: string;
  dispatchContext: ControllerTaskDispatchContext | null;
  responseStatusCode: number | null;
  responsePayload: unknown;
  durationMs: number | null;
  initiatedByUserId: string;
  taskLogText: string;
}) {
  const visitedProfiles = extractVisitedProfilesFromResultPayload(options.responsePayload);
  const processedPosts = extractProcessedPostsFromResultPayload(options.responsePayload);
  const notCompletedDetails = getControllerTaskNotCompletedDetails({
    payload: options.responsePayload,
    taskLogText: options.taskLogText,
    taskId: options.taskId,
    detectedAt: new Date(),
  });

  return {
    direction: "internal_event" as const,
    interactionType: "script_result" as const,
    requestMethod: "GET",
    requestPath: `/api/commands/${encodeURIComponent(options.taskId)}/results`,
    requestPayload: sanitizePayload(
      buildScriptResultRequestPayload(options.taskId, options.dispatchContext)
    ),
    responseStatusCode: options.responseStatusCode,
    responsePayload: sanitizePayload(options.responsePayload),
    result: getControllerTaskResultLogResult(options.responsePayload),
    scriptExecutionResult: evaluateScriptExecutionResult({
      initialScript: options.dispatchContext?.script ?? null,
      resultPayload: options.responsePayload,
      taskLogText: options.taskLogText,
    }),
    notCompletedDetails,
    durationMs: options.durationMs,
    initiatedBy: "operator" as const,
    initiatedByUserId: options.initiatedByUserId,
    taskLogText: options.taskLogText,
    visitedProfiles,
    visitedProfileKeys: visitedProfiles.map((entry) => entry.profileKey),
    processedPosts,
    processedPostUrls: processedPosts.map((entry) => entry.postUrl),
    errorCode:
      getControllerTaskResultState(options.responsePayload).alerted
        ? "TASK_ALERT"
        : getControllerTaskResultState(options.responsePayload).status === "failed"
          ? "TASK_FAILED"
          : "",
    errorMessage: getControllerTaskResultMessage(options.responsePayload),
  };
}

async function applyAlertStatusFromScriptResult(options: {
  vpsId: string;
  taskId: string;
  scriptExecutionResult: ScriptExecutionResult | null;
  responsePayload: unknown;
  detectedAt?: Date | string | null;
  alertMessage: string;
  updatedBy: string;
}) {
  if (options.scriptExecutionResult !== "ALERT") {
    return;
  }

  const alertDetails = getControllerTaskAlertDetails({
    payload: options.responsePayload,
    taskId: options.taskId,
    detectedAt: options.detectedAt ?? new Date(),
  });

  await RemoteVpsModel.findByIdAndUpdate(options.vpsId, {
    status: "alert",
    statusReason:
      options.alertMessage ||
      "Script execution detected a CAPTCHA or verification screen. Manual review is required.",
    alertDetails,
    updatedBy: options.updatedBy,
  });
}

export async function persistControllerTaskResultLog(options: {
  vpsId: string;
  taskId: string;
  responseStatusCode?: number | null;
  responsePayload: unknown;
  durationMs?: number | null;
  initiatedByUserId: string;
  taskLogText?: string;
  logId?: string;
  createdAt?: Date;
}) {
  const dispatchLogContext = await findCommandDispatchLogContext(options.vpsId, options.taskId);
  const command = normalizeControllerCommand(dispatchLogContext?.requestPayload?.command)
    ?? extractControllerCommandFromPayload(options.responsePayload);

  if (!isScriptCommand(command)) {
    return persistControllerCommandResultLog({
      ...options,
      dispatchContext: dispatchLogContext,
    });
  }

  const dispatchContext = await findCommandDispatchContext(options.vpsId, options.taskId);
  const taskLogText = options.taskLogText ?? getTaskLogText(options.responsePayload);
  const document = buildScriptResultLogDocument({
    taskId: options.taskId,
    dispatchContext,
    responseStatusCode: options.responseStatusCode ?? null,
    responsePayload: options.responsePayload,
    durationMs: options.durationMs ?? null,
    initiatedByUserId: options.initiatedByUserId,
    taskLogText,
  });

  await applyAlertStatusFromScriptResult({
    vpsId: options.vpsId,
    taskId: options.taskId,
    scriptExecutionResult: document.scriptExecutionResult,
    responsePayload: options.responsePayload,
    detectedAt: options.createdAt ?? new Date(),
    alertMessage: document.errorMessage,
    updatedBy: options.initiatedByUserId,
  });

  if (options.logId) {
    await RemoteVpsInteractionLogModel.findOneAndUpdate(
      { _id: options.logId, vpsId: options.vpsId },
      { $set: document },
      { returnDocument: "after" }
    );
    return;
  }

  await RemoteVpsInteractionLogModel.findOneAndUpdate(
    {
      vpsId: options.vpsId,
      correlationId: options.taskId,
      direction: "internal_event",
      interactionType: "script_result",
    },
    {
      $set: document,
      $setOnInsert: {
        vpsId: options.vpsId,
        correlationId: options.taskId,
        createdAt: options.createdAt ?? new Date(),
      },
    },
    {
      upsert: true,
      returnDocument: "after",
      setDefaultsOnInsert: true,
    }
  );
}

export async function persistControllerCommandResultLog(options: {
  vpsId: string;
  taskId: string;
  responseStatusCode?: number | null;
  responsePayload: unknown;
  durationMs?: number | null;
  initiatedByUserId: string;
  taskLogText?: string;
  logId?: string;
  createdAt?: Date;
  dispatchContext?: ControllerCommandDispatchLogContext | null;
}) {
  const dispatchContext = options.dispatchContext
    ?? await findCommandDispatchLogContext(options.vpsId, options.taskId);
  const taskLogText = options.taskLogText ?? getTaskLogText(options.responsePayload);
  const document = buildCommandResultLogDocument({
    taskId: options.taskId,
    dispatchContext,
    responseStatusCode: options.responseStatusCode ?? null,
    responsePayload: options.responsePayload,
    durationMs: options.durationMs ?? null,
    initiatedByUserId: options.initiatedByUserId,
    taskLogText,
  });
  const openClawHealth = extractOpenClawHealth(options.responsePayload);
  const current = await RemoteVpsModel.findById(options.vpsId, {
    status: 1,
    statusReason: 1,
    alertDetails: 1,
    openClawDaemonStatus: 1,
    openClawVersion: 1,
    openClawGatewayStatus: 1,
  }).lean();
  const currentStatus = (current?.status as VpsStatus | undefined) ?? "unknown";
  const statusUpdate = buildStatusUpdate({
    currentStatus,
    currentReason: safeString(current?.statusReason),
    currentAlertDetails: current?.alertDetails,
    preserveAlertStatus: true,
    nextStatus:
      currentStatus === "disabled"
        ? "disabled"
        : document.result === "failed"
          ? "degraded"
          : currentStatus === "unknown"
            ? "online"
            : currentStatus,
    nextReason:
      document.result === "failed"
        ? document.errorMessage || "Remote command failed."
        : safeString(current?.statusReason) || "Remote command completed successfully.",
  });

  if (options.logId) {
    await RemoteVpsInteractionLogModel.findOneAndUpdate(
      { _id: options.logId, vpsId: options.vpsId },
      { $set: document },
      { returnDocument: "after" }
    );
  } else {
    await RemoteVpsInteractionLogModel.findOneAndUpdate(
      {
        vpsId: options.vpsId,
        correlationId: options.taskId,
        direction: "internal_event",
        interactionType: "command_result",
      },
      {
        $set: document,
        $setOnInsert: {
          vpsId: options.vpsId,
          correlationId: options.taskId,
          createdAt: options.createdAt ?? new Date(),
        },
      },
      {
        upsert: true,
        returnDocument: "after",
        setDefaultsOnInsert: true,
      }
    );
  }

  await RemoteVpsModel.findByIdAndUpdate(options.vpsId, {
    ...statusUpdate,
    lastSeenAt: document.result === "success" ? options.createdAt ?? new Date() : undefined,
    openClawDaemonStatus:
      openClawHealth?.daemonStatus ??
      normalizeOpenClawDaemonStatus(current?.openClawDaemonStatus),
    openClawVersion: openClawHealth?.version || safeString(current?.openClawVersion),
    openClawGatewayStatus:
      openClawHealth?.gatewayStatus ??
      normalizeOpenClawGatewayStatus(current?.openClawGatewayStatus),
    updatedBy: options.initiatedByUserId,
  });
}

function buildStatusUpdate(options: {
  currentStatus: VpsStatus;
  currentReason: string;
  currentAlertDetails: unknown;
  preserveAlertStatus: boolean;
  nextStatus: VpsStatus;
  nextReason: string;
  nextAlertDetails?: VpsAlertDetails | null;
}) {
  if (options.preserveAlertStatus && options.currentStatus === "alert") {
    return {
      status: "alert" as const,
      statusReason:
        options.currentReason ||
        "Script execution detected a CAPTCHA or verification screen. Manual review is required.",
      alertDetails: isPlainObject(options.currentAlertDetails)
        ? options.currentAlertDetails
        : null,
    };
  }

  return {
    status: options.nextStatus,
    statusReason: options.nextReason,
    alertDetails: options.nextStatus === "alert" ? options.nextAlertDetails ?? null : null,
  };
}

export async function backfillScriptResultLogsForVps(options: {
  vpsId: string;
  initiatedByUserId: string;
}) {
  const items = await RemoteVpsInteractionLogModel.find({
    vpsId: options.vpsId,
    interactionType: "script_result",
  })
    .sort({ createdAt: -1 })
    .lean();

  let updatedCount = 0;
  let skippedCount = 0;

  for (const item of items) {
    const taskId = safeString(item.correlationId);

    if (!taskId) {
      skippedCount += 1;
      continue;
    }

    await persistControllerTaskResultLog({
      vpsId: options.vpsId,
      taskId,
      responseStatusCode:
        typeof item.responseStatusCode === "number" ? item.responseStatusCode : null,
      responsePayload: item.responsePayload ?? null,
      durationMs: typeof item.durationMs === "number" ? item.durationMs : null,
      initiatedByUserId: options.initiatedByUserId,
      taskLogText: safeString(item.taskLogText) || getTaskLogText(item.responsePayload),
      logId: String(item._id),
    });

    updatedCount += 1;
  }

  return {
    scannedCount: items.length,
    updatedCount,
    skippedCount,
  };
}

export async function findRecentProfileVisit(options: {
  profileUrl: string;
  lookbackDays: number;
}) {
  const profileUrl = normalizeLinkedInProfileUrl(options.profileUrl);
  const profileKey = normalizeLinkedInProfileKey(profileUrl);

  if (!profileUrl || !profileKey) {
    return {
      profileUrl: "",
      profileKey: "",
      lookbackDays: options.lookbackDays,
      recentlyVisited: false,
      latestVisitedAt: null,
    };
  }

  const lookbackDays = Math.max(1, Math.floor(options.lookbackDays || 30));
  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const item = await RemoteVpsInteractionLogModel.findOne({
    interactionType: "script_result",
    visitedProfileKeys: profileKey,
    createdAt: { $gte: cutoff },
  })
    .sort({ createdAt: -1 })
    .select({ createdAt: 1, visitedProfiles: 1 })
    .lean();

  const matchedVisitedAt = Array.isArray(item?.visitedProfiles)
    ? item.visitedProfiles.find((entry) => isPlainObject(entry) && safeString(entry.profileKey) === profileKey)
    : null;
  const latestVisitedAt = matchedVisitedAt && isPlainObject(matchedVisitedAt)
    ? toNullableIsoResult("createdAt", matchedVisitedAt.visitedAt as Date | string | null | undefined).value
    : toNullableIsoResult("createdAt", item?.createdAt as Date | string | null | undefined).value;

  return {
    profileUrl,
    profileKey,
    lookbackDays,
    recentlyVisited: Boolean(item),
    latestVisitedAt,
  };
}

export async function findRecentProcessedPost(options: {
  postUrl: string;
  lookbackDays: number;
}) {
  const postUrl = normalizeLinkedInPostUrl(options.postUrl);

  if (!postUrl) {
    return {
      postUrl: "",
      lookbackDays: options.lookbackDays,
      recentlyProcessed: false,
      latestProcessedAt: null,
    };
  }

  const lookbackDays = Math.max(1, Math.floor(options.lookbackDays || 3650));
  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const item = await RemoteVpsInteractionLogModel.findOne({
    interactionType: "script_result",
    processedPostUrls: postUrl,
    createdAt: { $gte: cutoff },
  })
    .sort({ createdAt: -1 })
    .select({ createdAt: 1, processedPosts: 1 })
    .lean();

  const matchedProcessedAt = Array.isArray(item?.processedPosts)
    ? item.processedPosts.find((entry) => isPlainObject(entry) && safeString(entry.postUrl) === postUrl)
    : null;
  const latestProcessedAt = matchedProcessedAt && isPlainObject(matchedProcessedAt)
    ? toNullableIsoResult("createdAt", matchedProcessedAt.processedAt as Date | string | null | undefined).value
    : toNullableIsoResult("createdAt", item?.createdAt as Date | string | null | undefined).value;

  return {
    postUrl,
    lookbackDays,
    recentlyProcessed: Boolean(item),
    latestProcessedAt,
  };
}

export interface VpsPayload {
  name: string;
  host: string;
  port: number;
  protocol: VpsProtocol;
  environment: VpsEnvironment;
  region: string;
  provider: string;
  defaultMouseActivityEnabled: boolean;
  defaultMouseActivityMinIntervalMs: number;
  defaultMouseActivityMaxIntervalMs: number;
  defaultMouseActivityMaxOffsetPx: number;
  controllerSecretKey: string;
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
  const defaultMouseActivityEnabled = parseBooleanInput(input.defaultMouseActivityEnabled, false);
  const defaultMouseActivityMinIntervalMs = parseIntegerInput(
    input.defaultMouseActivityMinIntervalMs,
    DEFAULT_MOUSE_ACTIVITY_MIN_INTERVAL_MS,
    { min: 250 }
  );
  const defaultMouseActivityMaxIntervalMs = parseIntegerInput(
    input.defaultMouseActivityMaxIntervalMs,
    DEFAULT_MOUSE_ACTIVITY_MAX_INTERVAL_MS,
    { min: 250 }
  );
  const defaultMouseActivityMaxOffsetPx = parseIntegerInput(
    input.defaultMouseActivityMaxOffsetPx,
    DEFAULT_MOUSE_ACTIVITY_MAX_OFFSET_PX,
    { min: 1 }
  );
  const controllerSecretKey = safeString(input.controllerSecretKey);
  const notes = safeString(input.notes);
  const portNumber = Number(input.port);
  const tags = normalizeTags(input.tags);
  const isEnabled = parseBooleanInput(input.isEnabled, false);

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

  if (
    input.controllerSecretKey !== undefined &&
    input.controllerSecretKey !== null &&
    typeof input.controllerSecretKey !== "string"
  ) {
    errors.controllerSecretKey = "Controller secret must be a string.";
  }

  if (!defaultMouseActivityEnabled.isValid) {
    errors.defaultMouseActivityEnabled = "Default mouse activity must be a boolean, 'true'/'false', or 1/0.";
  }

  if (!defaultMouseActivityMinIntervalMs.isValid) {
    errors.defaultMouseActivityMinIntervalMs = "Default minimum mouse interval must be an integer of at least 250 ms.";
  }

  if (!defaultMouseActivityMaxIntervalMs.isValid) {
    errors.defaultMouseActivityMaxIntervalMs = "Default maximum mouse interval must be an integer of at least 250 ms.";
  }

  if (!defaultMouseActivityMaxOffsetPx.isValid) {
    errors.defaultMouseActivityMaxOffsetPx = "Default mouse offset must be an integer of at least 1 px.";
  }

  if (defaultMouseActivityMaxIntervalMs.value < defaultMouseActivityMinIntervalMs.value) {
    errors.defaultMouseActivityMaxIntervalMs = "Default maximum mouse interval must be greater than or equal to the default minimum interval.";
  }

  if (!isEnabled.isValid) {
    errors.isEnabled = "Enabled status must be a boolean, 'true'/'false', or 1/0.";
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
    defaultMouseActivityEnabled: defaultMouseActivityEnabled.value,
    defaultMouseActivityMinIntervalMs: defaultMouseActivityMinIntervalMs.value,
    defaultMouseActivityMaxIntervalMs: defaultMouseActivityMaxIntervalMs.value,
    defaultMouseActivityMaxOffsetPx: defaultMouseActivityMaxOffsetPx.value,
    controllerSecretKey,
    tags,
    notes,
    isEnabled: isEnabled.value,
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

export function getProvidedControllerSecret(request: Request) {
  const headerSecret = request.headers.get("x-remote-controller-secret-key")?.trim();

  if (headerSecret) {
    return headerSecret;
  }

  const authorization = request.headers.get("authorization")?.trim() || "";

  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }

  return "";
}

export function getListQuery(searchParams: URLSearchParams) {
  const page = parsePositiveIntegerParam(searchParams.get("page"), 1);
  const pageSize = parsePositiveIntegerParam(searchParams.get("pageSize"), 10, {
    max: 100,
  });
  const search = safeString(searchParams.get("search"));
  const status = safeString(searchParams.get("status"));
  const environment = safeString(searchParams.get("environment"));
  const lastScriptExecutionResult = safeString(searchParams.get("lastScriptExecutionResult"));
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

  return {
    filter,
    page,
    pageSize,
    sort,
    lastScriptExecutionResult: scriptExecutionResultOptions.includes(
      lastScriptExecutionResult as ScriptExecutionResult
    )
      ? (lastScriptExecutionResult as ScriptExecutionResult)
      : "",
  };
}

export function getLogListQuery(searchParams: URLSearchParams) {
  const page = parsePositiveIntegerParam(searchParams.get("page"), 1);
  const pageSize = parsePositiveIntegerParam(searchParams.get("pageSize"), 20, {
    max: 100,
  });
  const result = safeString(searchParams.get("result"));
  const interactionType = safeString(searchParams.get("interactionType"));
  const scriptExecutionResult = safeString(searchParams.get("scriptExecutionResult"));
  const startAt = safeString(searchParams.get("startAt"));
  const endAt = safeString(searchParams.get("endAt"));

  const filter: Record<string, unknown> = {};

  if (logResultOptions.includes(result as LogResult)) {
    filter.result = result;
  }

  if (logInteractionTypeOptions.includes(interactionType as LogInteractionType)) {
    filter.interactionType = interactionType;
  }

  if (scriptExecutionResultOptions.includes(scriptExecutionResult as ScriptExecutionResult)) {
    filter.scriptExecutionResult = scriptExecutionResult;
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
  scriptExecutionResult?: ScriptExecutionResult | null;
  notCompletedDetails?: VpsNotCompletedDetails | null;
  errorCode?: string;
  errorMessage?: string;
  durationMs?: number | null;
  attempt?: number;
  initiatedBy?: "system" | "operator" | "scheduler";
  initiatedByUserId?: string;
  taskLogText?: string;
  createdAt?: Date;
}) {
  await RemoteVpsInteractionLogModel.create({
    ...entry,
    requestMethod: entry.requestMethod ?? "GET",
    requestPath: entry.requestPath ?? "/",
    requestPayload: sanitizePayload(entry.requestPayload ?? null),
    responseStatusCode: entry.responseStatusCode ?? null,
    responsePayload: sanitizePayload(entry.responsePayload ?? null),
    scriptExecutionResult: entry.scriptExecutionResult ?? null,
    notCompletedDetails: toNotCompletedDetailsRecord(entry.notCompletedDetails),
    errorCode: entry.errorCode ?? "",
    errorMessage: entry.errorMessage ?? "",
    durationMs: entry.durationMs ?? null,
    attempt: entry.attempt ?? 1,
    initiatedBy: entry.initiatedBy ?? "operator",
    initiatedByUserId: entry.initiatedByUserId ?? actorFallback,
    taskLogText: entry.taskLogText ?? "",
    createdAt: entry.createdAt ?? new Date(),
  });
}

export function buildBaseUrl(vps: Pick<RemoteVpsRecord, "protocol" | "host" | "port">) {
  return `${vps.protocol}://${vps.host}:${vps.port}`;
}

function buildControllerHeaders(secret: string, init?: HeadersInit) {
  const headers = new Headers(init);

  headers.set("accept", "application/json, text/plain;q=0.9, */*;q=0.8");

  if (secret) {
    headers.set("x-remote-controller-secret-key", secret);
  }

  return headers;
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

function extractOpenClawHealth(payload: unknown) {
  if (!isPlainObject(payload)) {
    return null;
  }

  const resultPayload = isPlainObject(payload.result) ? payload.result : null;
  const nestedHealth = isPlainObject(resultPayload?.openclaw)
    ? resultPayload.openclaw
    : isPlainObject(resultPayload?.health)
      ? resultPayload.health
      : null;
  const openclaw = isPlainObject(payload.openclaw)
    ? payload.openclaw
    : nestedHealth;
  const daemonStatus = normalizeOpenClawDaemonStatus(
    openclaw?.daemonStatus ??
    resultPayload?.openClawDaemonStatus ??
    payload.openClawDaemonStatus
  );
  const version = safeString(
    openclaw?.version ?? resultPayload?.openClawVersion ?? payload.openClawVersion
  );
  const gatewayStatus = normalizeOpenClawGatewayStatus(
    openclaw?.gatewayStatus ??
    resultPayload?.openClawGatewayStatus ??
    payload.openClawGatewayStatus
  );

  if (!openclaw && !version && daemonStatus === "unknown" && gatewayStatus === "unknown") {
    return null;
  }

  return {
    daemonStatus,
    version,
    gatewayStatus,
  };
}

function isTimeoutError(error: unknown) {
  if (error instanceof Error) {
    return error.name === "TimeoutError" || error.name === "AbortError";
  }

  return false;
}

export async function performControllerProbe(options: {
  vps: ControllerConnectionDetails;
  interactionType: Extract<LogInteractionType, "health_check" | "manual_test">;
  requestPath: string;
  initiatedByUserId: string;
  preserveAlertStatus?: boolean;
  clearAlertMode?: boolean;
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
      headers: buildControllerHeaders(options.vps.controllerSecretKey),
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });

    const durationMs = Date.now() - startedAt;
    const responsePayload = await parseResponsePayload(response);
    const controllerVersion = extractControllerVersion(responsePayload);
    const openClawHealth = extractOpenClawHealth(responsePayload);
    const result: LogResult = response.ok ? "success" : "failed";
    const now = new Date();
    const current = await RemoteVpsModel.findById(options.vps.id, { status: 1, statusReason: 1, alertDetails: 1 }).lean();
    const statusUpdate = buildStatusUpdate({
      currentStatus: (current?.status as VpsStatus | undefined) ?? options.vps.status,
      currentReason: safeString(current?.statusReason, options.vps.statusReason),
      currentAlertDetails: current?.alertDetails,
      preserveAlertStatus: options.preserveAlertStatus !== false,
      nextStatus: options.vps.isEnabled
        ? response.ok
          ? "online"
          : options.clearAlertMode
            ? "offline"
            : "degraded"
        : "disabled",
      nextReason: options.vps.isEnabled
        ? response.ok
          ? `Last ${options.interactionType.replace("_", " ")} completed successfully.`
          : options.clearAlertMode
            ? "Manual alert clear failed because the remote controller is not healthy."
            : `Remote controller returned HTTP ${response.status}.`
        : "Record disabled by operator.",
    });

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
      ...statusUpdate,
      lastSeenAt: response.ok ? now : options.vps.lastSeenAt,
      lastHealthCheckAt: now,
      lastHealthCheckResult: response.ok ? "success" : "failed",
      controllerVersion: controllerVersion || options.vps.controllerVersion,
      openClawDaemonStatus: openClawHealth?.daemonStatus ?? options.vps.openClawDaemonStatus,
      openClawVersion: openClawHealth?.version || options.vps.openClawVersion,
      openClawGatewayStatus: openClawHealth?.gatewayStatus ?? options.vps.openClawGatewayStatus,
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
    const current = await RemoteVpsModel.findById(options.vps.id, { status: 1, statusReason: 1, alertDetails: 1 }).lean();
    const statusUpdate = buildStatusUpdate({
      currentStatus: (current?.status as VpsStatus | undefined) ?? options.vps.status,
      currentReason: safeString(current?.statusReason, options.vps.statusReason),
      currentAlertDetails: current?.alertDetails,
      preserveAlertStatus: options.preserveAlertStatus !== false,
      nextStatus: options.vps.isEnabled ? "offline" : "disabled",
      nextReason: timeout
        ? options.clearAlertMode
          ? "Manual alert clear failed because the remote controller timed out."
          : "Remote controller timed out during the latest probe."
        : options.clearAlertMode
          ? "Manual alert clear failed because the remote controller could not be reached."
          : "Remote controller could not be reached.",
    });

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
      ...statusUpdate,
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

async function performControllerRequest(options: {
  vps: ControllerConnectionDetails;
  interactionType: Extract<LogInteractionType, "command_dispatch" | "status_pull">;
  requestMethod: "GET" | "POST";
  requestPath: string;
  requestPayload?: unknown;
  initiatedByUserId: string;
  preserveAlertStatus?: boolean;
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
    requestMethod: options.requestMethod,
    requestPath: options.requestPath,
    requestPayload: options.requestPayload ?? null,
    result: "pending",
    initiatedBy: "operator",
    initiatedByUserId: options.initiatedByUserId,
    createdAt,
  });

  try {
    const response = await fetch(requestUrl, {
      method: options.requestMethod,
      headers: buildControllerHeaders(
        options.vps.controllerSecretKey,
        options.requestMethod === "POST" ? { "content-type": "application/json" } : undefined
      ),
      body:
        options.requestMethod === "POST"
          ? JSON.stringify(options.requestPayload ?? null)
          : undefined,
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    });

    const durationMs = Date.now() - startedAt;
    const responsePayload = await parseResponsePayload(response);
    const controllerVersion = extractControllerVersion(responsePayload);
    const result: LogResult = response.ok ? "success" : "failed";
    const now = new Date();
    const current = await RemoteVpsModel.findById(options.vps.id, { status: 1, statusReason: 1, alertDetails: 1 }).lean();
    const statusUpdate = buildStatusUpdate({
      currentStatus: (current?.status as VpsStatus | undefined) ?? options.vps.status,
      currentReason: safeString(current?.statusReason, options.vps.statusReason),
      currentAlertDetails: current?.alertDetails,
      preserveAlertStatus: options.preserveAlertStatus !== false,
      nextStatus: options.vps.isEnabled ? (response.ok ? "online" : "degraded") : "disabled",
      nextReason: options.vps.isEnabled
        ? response.ok
          ? `Last ${options.interactionType.replace("_", " ")} completed successfully.`
          : `Remote controller returned HTTP ${response.status}.`
        : "Record disabled by operator.",
    });

    await createInteractionLog({
      vpsId: options.vps.id,
      correlationId,
      direction: "inbound_response",
      interactionType: options.interactionType,
      requestMethod: options.requestMethod,
      requestPath: options.requestPath,
      responseStatusCode: response.status,
      responsePayload,
      result,
      durationMs,
      initiatedBy: "operator",
      initiatedByUserId: options.initiatedByUserId,
      errorMessage: response.ok ? "" : `Remote controller responded with ${response.status}.`,
      createdAt: now,
    });

    await RemoteVpsModel.findByIdAndUpdate(options.vps.id, {
      ...statusUpdate,
      lastSeenAt: response.ok ? now : options.vps.lastSeenAt,
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
    const errorMessage = error instanceof Error ? error.message : "Unknown controller request failure";
    const current = await RemoteVpsModel.findById(options.vps.id, { status: 1, statusReason: 1, alertDetails: 1 }).lean();
    const statusUpdate = buildStatusUpdate({
      currentStatus: (current?.status as VpsStatus | undefined) ?? options.vps.status,
      currentReason: safeString(current?.statusReason, options.vps.statusReason),
      currentAlertDetails: current?.alertDetails,
      preserveAlertStatus: options.preserveAlertStatus !== false,
      nextStatus: options.vps.isEnabled ? "offline" : "disabled",
      nextReason: timeout
        ? "Remote controller timed out during the latest request."
        : "Remote controller could not be reached.",
    });

    await createInteractionLog({
      vpsId: options.vps.id,
      correlationId,
      direction: "internal_event",
      interactionType: options.interactionType,
      requestMethod: options.requestMethod,
      requestPath: options.requestPath,
      requestPayload: options.requestPayload ?? null,
      result: timeout ? "timeout" : "failed",
      durationMs,
      initiatedBy: "operator",
      initiatedByUserId: options.initiatedByUserId,
      errorCode: timeout ? "REQUEST_TIMEOUT" : "FETCH_FAILED",
      errorMessage,
      createdAt: now,
    });

    await RemoteVpsModel.findByIdAndUpdate(options.vps.id, {
      ...statusUpdate,
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

export class AlertLockedVpsError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}

export async function dispatchExecuteScriptCommand(options: {
  vps: ControllerConnectionDetails;
  script: unknown;
  scriptId?: string;
  scriptName?: string;
  engineMode?: ScriptEngineMode;
  mouseActivityEnabled?: boolean;
  mouseActivityConfig?: {
    minIntervalMs?: number;
    maxIntervalMs?: number;
    maxOffsetPx?: number;
  };
  taskResultWebhookUrlTemplate?: string;
  profileVisitLookupUrlTemplate?: string;
  postHistoryLookupUrlTemplate?: string;
  initiatedByUserId: string;
}) {
  if (options.vps.status === "alert") {
    throw new AlertLockedVpsError(
      options.vps.statusReason ||
      "This VPS is in alert status. Clear the alert and verify controller health before running more scripts."
    );
  }

  const structuredInstructions = normalizeStructuredInstructions(options.script);

  return performControllerRequest({
    vps: options.vps,
    interactionType: "command_dispatch",
    requestMethod: "POST",
    requestPath: "/api/commands",
    requestPayload: {
      command: "executeScript",
      scriptId: safeString(options.scriptId),
      scriptName: safeString(options.scriptName),
      engineMode: options.engineMode ?? "deterministic",
      mouseActivityEnabled: options.mouseActivityEnabled === true,
      mouseActivityConfig: options.mouseActivityConfig
        ? {
          minIntervalMs:
            typeof options.mouseActivityConfig.minIntervalMs === "number"
              ? options.mouseActivityConfig.minIntervalMs
              : undefined,
          maxIntervalMs:
            typeof options.mouseActivityConfig.maxIntervalMs === "number"
              ? options.mouseActivityConfig.maxIntervalMs
              : undefined,
          maxOffsetPx:
            typeof options.mouseActivityConfig.maxOffsetPx === "number"
              ? options.mouseActivityConfig.maxOffsetPx
              : undefined,
        }
        : undefined,
      script: structuredInstructions,
      callback:
        options.taskResultWebhookUrlTemplate ||
          options.profileVisitLookupUrlTemplate ||
          options.postHistoryLookupUrlTemplate
          ? {
            taskResultWebhookUrlTemplate: options.taskResultWebhookUrlTemplate,
            profileVisitLookupUrlTemplate: options.profileVisitLookupUrlTemplate,
            postHistoryLookupUrlTemplate: options.postHistoryLookupUrlTemplate,
          }
          : undefined,
    },
    initiatedByUserId: options.initiatedByUserId,
  });
}

export async function fetchControllerTaskStatus(options: {
  vps: ControllerConnectionDetails;
  taskId: string;
  initiatedByUserId: string;
}) {
  return performControllerRequest({
    vps: options.vps,
    interactionType: "status_pull",
    requestMethod: "GET",
    requestPath: `/api/commands/${encodeURIComponent(options.taskId)}/status`,
    initiatedByUserId: options.initiatedByUserId,
  });
}

export async function fetchControllerTaskResults(options: {
  vps: ControllerConnectionDetails;
  taskId: string;
  initiatedByUserId: string;
}) {
  const response = await performControllerRequest({
    vps: options.vps,
    interactionType: "status_pull",
    requestMethod: "GET",
    requestPath: `/api/commands/${encodeURIComponent(options.taskId)}/results`,
    initiatedByUserId: options.initiatedByUserId,
  });

  const command = extractControllerCommandFromPayload(response.responsePayload);

  if (isScriptCommand(command)) {
    await persistControllerTaskResultLog({
      vpsId: options.vps.id,
      taskId: options.taskId,
      responseStatusCode: response.responseStatusCode,
      responsePayload: response.responsePayload,
      durationMs: response.durationMs,
      initiatedByUserId: options.initiatedByUserId,
      createdAt: new Date(),
    });
  } else {
    await persistControllerCommandResultLog({
      vpsId: options.vps.id,
      taskId: options.taskId,
      responseStatusCode: response.responseStatusCode,
      responsePayload: response.responsePayload,
      durationMs: response.durationMs,
      initiatedByUserId: options.initiatedByUserId,
      createdAt: new Date(),
    });
  }

  return response;
}

export async function dispatchOpenClawUpdateCommand(options: {
  vps: ControllerConnectionDetails;
  taskResultWebhookUrlTemplate?: string;
  initiatedByUserId: string;
}) {
  return performControllerRequest({
    vps: options.vps,
    interactionType: "command_dispatch",
    requestMethod: "POST",
    requestPath: "/api/commands",
    requestPayload: {
      command: "openclawUpdate",
      callback: options.taskResultWebhookUrlTemplate
        ? {
          taskResultWebhookUrlTemplate: options.taskResultWebhookUrlTemplate,
        }
        : undefined,
    },
    initiatedByUserId: options.initiatedByUserId,
  });
}

export async function dispatchOpenClawGatewayRestartCommand(options: {
  vps: ControllerConnectionDetails;
  taskResultWebhookUrlTemplate?: string;
  initiatedByUserId: string;
}) {
  return performControllerRequest({
    vps: options.vps,
    interactionType: "command_dispatch",
    requestMethod: "POST",
    requestPath: "/api/commands",
    requestPayload: {
      command: "openclawGatewayRestart",
      callback: options.taskResultWebhookUrlTemplate
        ? {
          taskResultWebhookUrlTemplate: options.taskResultWebhookUrlTemplate,
        }
        : undefined,
    },
    initiatedByUserId: options.initiatedByUserId,
  });
}

export async function clearVpsAlertStatus(options: {
  vps: ControllerConnectionDetails;
  initiatedByUserId: string;
}) {
  const response = await performControllerProbe({
    vps: options.vps,
    interactionType: "health_check",
    requestPath: "/health",
    initiatedByUserId: options.initiatedByUserId,
    preserveAlertStatus: false,
    clearAlertMode: true,
  });

  const refreshed = await findVpsById(options.vps.id);

  return {
    item: refreshed ? serializeVps(refreshed) : serializeVps(options.vps),
    interaction: response,
    message:
      response.result === "success"
        ? "Alert cleared. Controller is reachable and the VPS is back online."
        : "Alert cleared, but the controller is offline.",
  };
}
