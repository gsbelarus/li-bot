export const vpsStatusOptions = [
  "online",
  "degraded",
  "offline",
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

export const logDirectionOptions = [
  "outbound_request",
  "inbound_response",
  "internal_event",
] as const;

export const logInteractionTypeOptions = [
  "health_check",
  "command_dispatch",
  "status_pull",
  "script_result",
  "configuration_update",
  "registration",
  "manual_test",
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
  "ERROR",
  "NOT_COMPLETED",
  "COMPLETED",
] as const;

export const initiatedByOptions = ["system", "operator", "scheduler"] as const;

export type VpsStatus = (typeof vpsStatusOptions)[number];
export type VpsEnvironment = (typeof vpsEnvironmentOptions)[number];
export type VpsProtocol = (typeof vpsProtocolOptions)[number];
export type LogDirection = (typeof logDirectionOptions)[number];
export type LogInteractionType = (typeof logInteractionTypeOptions)[number];
export type LogResult = (typeof logResultOptions)[number];
export type ScriptExecutionResult = (typeof scriptExecutionResultOptions)[number];
export type InitiatedBy = (typeof initiatedByOptions)[number];

export type RemoteVpsTimestampWarning =
  | "createdAt"
  | "updatedAt"
  | "lastSeenAt"
  | "lastHealthCheckAt";

export type RemoteVpsInteractionLogTimestampWarning = "createdAt";

export interface RemoteVpsRecord {
  id: string;
  name: string;
  host: string;
  port: number;
  protocol: VpsProtocol;
  environment: VpsEnvironment;
  region: string;
  provider: string;
  hasControllerSecret: boolean;
  controllerSecretKeyMasked: string;
  controllerVersion: string;
  status: VpsStatus;
  statusReason: string;
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
