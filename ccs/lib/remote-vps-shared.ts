export const vpsStatusOptions = [
  "online",
  "degraded",
  "offline",
  "alert",
  "disabled",
  "unknown",
] as const;

export const vpsEnvironmentOptions = [
  "production",
  "staging",
  "test",
  "other",
] as const;

export const vpsProtocolOptions = ["http", "https"] as const;

export const openClawDaemonStatusOptions = [
  "running",
  "not_installed",
  "error",
  "unknown",
] as const;

export const openClawGatewayStatusOptions = [
  "reachable",
  "unreachable",
  "not_configured",
  "unknown",
] as const;

export const logDirectionOptions = [
  "outbound_request",
  "inbound_response",
  "internal_event",
] as const;

export const logInteractionTypeOptions = [
  "health_check",
  "command_dispatch",
  "command_result",
  "status_pull",
  "script_result",
  "configuration_update",
  "registration",
  "manual_test",
] as const;

export const controllerCommandOptions = [
  "executeScript",
  "openclawUpdate",
  "openclawGatewayRestart",
] as const;

export const logResultOptions = [
  "success",
  "failed",
  "timeout",
  "rejected",
  "retrying",
  "pending",
] as const;

export const scriptExecutionResultOptions = [
  "COMPLETED",
  "NOT_COMPLETED",
  "ERROR",
  "ALERT",
] as const;

export const initiatedByOptions = ["system", "operator", "scheduler"] as const;

export type VpsStatus = (typeof vpsStatusOptions)[number];
export type VpsEnvironment = (typeof vpsEnvironmentOptions)[number];
export type VpsProtocol = (typeof vpsProtocolOptions)[number];
export type OpenClawDaemonStatus = (typeof openClawDaemonStatusOptions)[number];
export type OpenClawGatewayStatus = (typeof openClawGatewayStatusOptions)[number];
export type LogDirection = (typeof logDirectionOptions)[number];
export type LogInteractionType = (typeof logInteractionTypeOptions)[number];
export type ControllerCommand = (typeof controllerCommandOptions)[number];
export type LogResult = (typeof logResultOptions)[number];
export type ScriptExecutionResult = (typeof scriptExecutionResultOptions)[number];
export type InitiatedBy = (typeof initiatedByOptions)[number];

export type RemoteVpsTimestampWarning =
  | "createdAt"
  | "updatedAt"
  | "lastSeenAt"
  | "lastHealthCheckAt";

export type RemoteVpsInteractionLogTimestampWarning = "createdAt";

export interface VpsAlertDetails {
  taskId: string;
  message: string;
  reason: string;
  stepOrder: number | null;
  stepKind: string;
  instruction: string;
  detectedAt: string | null;
}

export interface VpsNotCompletedDetails {
  taskId: string;
  message: string;
  reason: string;
  stepOrder: number | null;
  stepKind: string;
  instruction: string;
  detectedAt: string | null;
}

export interface RemoteVpsRecord {
  id: string;
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
  hasControllerSecret: boolean;
  controllerSecretKeyMasked: string;
  controllerVersion: string;
  openClawDaemonStatus: OpenClawDaemonStatus;
  openClawVersion: string;
  openClawGatewayStatus: OpenClawGatewayStatus;
  status: VpsStatus;
  statusReason: string;
  alertDetails: VpsAlertDetails | null;
  lastScriptExecutionResult: ScriptExecutionResult | null;
  lastSeenAt: string | null;
  lastHealthCheckAt: string | null;
  lastHealthCheckResult: "success" | "failed" | "timeout" | "unknown";
  tags: string[];
  notes: string;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
  timestampWarnings: RemoteVpsTimestampWarning[];
}

export interface RemoteVpsInteractionLogRecord {
  id: string;
  vpsId: string;
  correlationId: string;
  direction: LogDirection;
  interactionType: LogInteractionType;
  requestMethod: string;
  requestPath: string;
  requestPayload: unknown;
  responseStatusCode: number | null;
  responsePayload: unknown;
  result: LogResult;
  scriptExecutionResult: ScriptExecutionResult | null;
  notCompletedDetails: VpsNotCompletedDetails | null;
  errorCode: string;
  errorMessage: string;
  durationMs: number | null;
  attempt: number;
  initiatedBy: InitiatedBy;
  initiatedByUserId: string;
  taskLogText: string;
  createdAt: string;
  timestampWarnings: RemoteVpsInteractionLogTimestampWarning[];
}

export interface VpsListResponse {
  items: RemoteVpsRecord[];
  totalCount: number;
  page: number;
  pageSize: number;
}

export interface VpsLogListResponse {
  items: RemoteVpsInteractionLogRecord[];
  totalCount: number;
  page: number;
  pageSize: number;
}

export interface VpsMutationResponse {
  item: RemoteVpsRecord;
  message: string;
}

export interface SystemLogFilterOption {
  value: string;
  label: string;
}

export interface SystemLogRecord extends RemoteVpsInteractionLogRecord {
  vpsName: string;
  vpsAddress: string;
  vpsLabel: string;
  scriptName: string;
  logMessage: string;
}

export interface SystemLogListResponse {
  items: SystemLogRecord[];
  totalCount: number;
  page: number;
  pageSize: number;
  vpsOptions: SystemLogFilterOption[];
  scriptOptions: string[];
}

export interface SystemLogBulkDeleteResponse {
  deletedCount: number;
  message: string;
}

export interface SystemLogQueryOptions {
  vpsId: string;
  scriptName: string;
  startAt: string;
  endAt: string;
  scriptResultsOnly: boolean;
  search: string;
}
