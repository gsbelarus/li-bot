export const scriptActionKinds = [
  "navigate",
  "click",
  "skip_if_profile_recently_visited",
  "branch_if_missing",
  "branch_if_visible",
  "hover",
  "wait",
  "wait_for_page",
  "move_mouse",
  "scroll",
  "type",
  "press_key",
  "extract_text",
  "assert_visible",
  "custom",
] as const;

export type ScriptActionKind = (typeof scriptActionKinds)[number];

export interface ScriptTarget {
  description: string;
  selectors: string[];
  text: string;
  role: string;
  alternativeTexts?: string[];
}

export type ScriptParamValue = string | number | boolean | null | string[];

export interface ScriptStep {
  order: number;
  kind: ScriptActionKind;
  instruction: string;
  delayAfterMs: number;
  timeoutMs: number;
  target: ScriptTarget | null;
  params: Record<string, ScriptParamValue>;
}

export interface ScriptInstructions {
  version: 1;
  summary: string;
  defaultDelayMs: number;
  steps: ScriptStep[];
}

export const executionEngineModes = ["deterministic", "ai_driven"] as const;

export type ExecutionEngineMode = (typeof executionEngineModes)[number];

export interface ExecuteScriptCallbackConfig {
  taskResultWebhookUrlTemplate: string;
  profileVisitLookupUrlTemplate?: string;
}

export interface MouseActivityConfig {
  minIntervalMs?: number;
  maxIntervalMs?: number;
  maxOffsetPx?: number;
}

export interface ExecuteScriptCommandPayload {
  command: "executeScript";
  script: ScriptInstructions;
  engineMode: ExecutionEngineMode;
  mouseActivityEnabled?: boolean;
  mouseActivityConfig?: MouseActivityConfig;
  targetId?: string;
  callback?: ExecuteScriptCallbackConfig;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeString(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function normalizeExecutionEngineMode(value: unknown): ExecutionEngineMode {
  const mode = safeString(value, "deterministic") as ExecutionEngineMode;
  return executionEngineModes.includes(mode) ? mode : "deterministic";
}

function normalizeOptionalBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeMouseActivityConfig(value: unknown): MouseActivityConfig | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const config: MouseActivityConfig = {};

  if (typeof value.minIntervalMs === "number" && Number.isFinite(value.minIntervalMs)) {
    config.minIntervalMs = Math.max(250, Math.floor(value.minIntervalMs));
  }

  if (typeof value.maxIntervalMs === "number" && Number.isFinite(value.maxIntervalMs)) {
    config.maxIntervalMs = Math.max(250, Math.floor(value.maxIntervalMs));
  }

  if (typeof value.maxOffsetPx === "number" && Number.isFinite(value.maxOffsetPx)) {
    config.maxOffsetPx = Math.max(1, Math.floor(value.maxOffsetPx));
  }

  if (
    config.minIntervalMs !== undefined &&
    config.maxIntervalMs !== undefined &&
    config.maxIntervalMs < config.minIntervalMs
  ) {
    config.maxIntervalMs = config.minIntervalMs;
  }

  return Object.keys(config).length > 0 ? config : undefined;
}

function normalizeCallbackConfig(value: unknown): ExecuteScriptCallbackConfig | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const taskResultWebhookUrlTemplate = safeString(value.taskResultWebhookUrlTemplate);
  const profileVisitLookupUrlTemplate = safeString(value.profileVisitLookupUrlTemplate);

  if (!taskResultWebhookUrlTemplate && !profileVisitLookupUrlTemplate) {
    return undefined;
  }

  return {
    taskResultWebhookUrlTemplate,
    profileVisitLookupUrlTemplate: profileVisitLookupUrlTemplate || undefined,
  };
}

function normalizeTarget(value: unknown): ScriptTarget | null {
  if (!isPlainObject(value)) {
    return null;
  }

  return {
    description: safeString(value.description),
    selectors: Array.isArray(value.selectors)
      ? value.selectors.map((entry) => safeString(entry)).filter(Boolean)
      : [],
    text: safeString(value.text),
    role: safeString(value.role),
    alternativeTexts: Array.isArray(value.alternativeTexts)
      ? value.alternativeTexts.map((entry) => safeString(entry)).filter(Boolean)
      : [],
  };
}

function normalizeStep(value: unknown, index: number): ScriptStep {
  const source = isPlainObject(value) ? value : {};
  const kind = safeString(source.kind, "custom") as ScriptActionKind;
  const fallbackDelayAfterMs =
    kind === "navigate" ||
      kind === "wait" ||
      kind === "wait_for_page" ||
      kind === "branch_if_missing" ||
      kind === "branch_if_visible"
      ? 0
      : 1000;
  const params = isPlainObject(source.params)
    ? Object.entries(source.params).reduce<ScriptStep["params"]>((accumulator, [key, entry]) => {
      if (
        typeof entry === "string" ||
        typeof entry === "number" ||
        typeof entry === "boolean" ||
        entry === null
      ) {
        accumulator[key] = entry;
      } else if (Array.isArray(entry) && entry.every((item) => typeof item === "string")) {
        accumulator[key] = entry.map((item) => safeString(item)).filter(Boolean);
      }

      return accumulator;
    }, {})
    : {};

  return {
    order: Number.isInteger(source.order) ? Number(source.order) : index + 1,
    kind: scriptActionKinds.includes(kind) ? kind : "custom",
    instruction: safeString(source.instruction),
    delayAfterMs:
      Number.isFinite(source.delayAfterMs) && Number(source.delayAfterMs) >= 0
        ? Number(source.delayAfterMs)
        : fallbackDelayAfterMs,
    timeoutMs:
      Number.isFinite(source.timeoutMs) && Number(source.timeoutMs) > 0
        ? Number(source.timeoutMs)
        : 10000,
    target: normalizeTarget(source.target),
    params,
  };
}

export function normalizeStructuredInstructions(value: unknown): ScriptInstructions {
  const source = isPlainObject(value) ? value : {};
  const steps = Array.isArray(source.steps)
    ? source.steps.map((step, index) => normalizeStep(step, index))
    : [];

  return {
    version: 1,
    summary: safeString(source.summary),
    defaultDelayMs:
      Number.isFinite(source.defaultDelayMs) && Number(source.defaultDelayMs) >= 0
        ? Number(source.defaultDelayMs)
        : 1000,
    steps,
  };
}

export function validateExecuteScriptCommandPayload(
  value: unknown
): ExecuteScriptCommandPayload {
  if (!isPlainObject(value)) {
    throw new Error("Request body must be a JSON object.");
  }

  if (value.command !== "executeScript") {
    throw new Error("Only the executeScript command is supported.");
  }

  return {
    command: "executeScript",
    script: normalizeStructuredInstructions(value.script),
    engineMode: normalizeExecutionEngineMode(value.engineMode),
    mouseActivityEnabled: normalizeOptionalBoolean(value.mouseActivityEnabled),
    mouseActivityConfig: normalizeMouseActivityConfig(value.mouseActivityConfig),
    targetId: safeString(value.targetId) || undefined,
    callback: normalizeCallbackConfig(value.callback),
  };
}