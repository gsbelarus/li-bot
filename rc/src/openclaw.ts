import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";

import type {
  ExecutionEngineMode,
  ScriptInstructions,
  ScriptStep,
} from "./script-contract.js";

const windowsShell = process.env.ComSpec || "cmd.exe";
const currentFilePath = fileURLToPath(import.meta.url);
const currentDirectory = dirname(currentFilePath);
const projectRoot = resolve(currentDirectory, "..");
const logsDirectory = resolve(projectRoot, "logs");

function isTaskLoggingEnabled() {
  return !/^(?:0|false|off|no)$/i.test(process.env.OPENCLAW_TASK_LOGGING_ENABLED || "1");
}

function getOpenAiApiKey() {
  return process.env.OPENAI_API_KEY || "";
}

function getOpenAiProjectKey() {
  return process.env.OPENAI_PROJECT_KEY || "";
}

function getRemoteControllerSecretKey() {
  return process.env.REMOTE_CONTROLLER_SECRET_KEY || "";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInteger(min: number, max: number) {
  const lower = Math.ceil(Math.min(min, max));
  const upper = Math.floor(Math.max(min, max));
  return Math.floor(Math.random() * (upper - lower + 1)) + lower;
}

function scalarString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function scalarNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function scalarBoolean(value: unknown, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function scalarStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map((entry) => scalarString(entry).trim()).filter(Boolean)
    : [];
}

type BrowserTargetEntry = Record<string, unknown> & {
  targetId?: unknown;
  id?: unknown;
  url?: unknown;
  title?: unknown;
  type?: unknown;
  focused?: unknown;
  active?: unknown;
  selected?: unknown;
};

function boundedPositiveInteger(value: unknown, fallback: number, minimum = 1) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(minimum, Math.floor(value));
}

function parseJsonish(value: unknown) {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return trimmed;
  }

  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }

  return value;
}

function maskCommandArgs(args: string[]) {
  const maskedArgs = [...args];

  for (let index = 0; index < maskedArgs.length; index += 1) {
    if (maskedArgs[index] === "--token" && index + 1 < maskedArgs.length) {
      maskedArgs[index + 1] = "[masked]";
    }
  }

  return maskedArgs;
}

export interface StepExecutionRecord {
  order: number;
  kind: ScriptStep["kind"];
  instruction: string;
  durationMs: number;
  resolution: StepResolutionRecord | null;
  output: unknown;
}

interface ExecutionContext {
  taskId?: string;
  engineMode?: ExecutionEngineMode;
  engineStats?: ExecutionEngineStats;
  profileVisitLookupUrlTemplate?: string;
  runtimeState?: RuntimeState;
}

interface ExecuteScriptOptions extends ExecutionContext {
  engineMode?: ExecutionEngineMode;
  targetId?: string;
}

interface VisitedProfileRecord {
  profileKey: string;
  profileUrl: string;
  visitedAt: string;
}

interface ProfileCardSelectionState {
  step: ScriptStep;
  currentIndex: number;
  sourcePageUrl: string;
}

interface RuntimeState {
  visitedProfiles: Map<string, VisitedProfileRecord>;
  profileCardSelection: ProfileCardSelectionState | null;
}

interface OpenClawInvocation {
  command: string;
  commandArgsPrefix: string[];
}

interface ExecutionEngineStats {
  aiSelections: number;
  deterministicSelections: number;
  aiFallbacks: number;
  aiErrors: number;
}

interface BrowserSnapshotRef {
  role?: string;
  name?: string;
  [key: string]: unknown;
}

interface BrowserSnapshot {
  ok?: boolean;
  format?: string;
  snapshot?: string;
  refs?: Record<string, BrowserSnapshotRef>;
  targetId?: string;
  url?: string;
  truncated?: boolean;
}

interface ResolvedSnapshotRef {
  ref: string;
  role: string;
  name: string;
  candidateCount: number;
  resolution: StepResolutionRecord;
}

interface StepResolutionRecord {
  requestedMode: ExecutionEngineMode;
  resolver: "deterministic" | "ai_driven" | "deterministic_fallback";
  usedAi: boolean;
  fallbackReason: string | null;
  matchedRef: string | null;
  candidateCount: number | null;
}

interface AiResolutionCandidate {
  ref: string;
  role: string;
  name: string;
  lineIndex: number;
  score: number;
  context: string;
  nearbyContext: string;
}

interface BranchStepResult {
  ok: true;
  action: "branch_if_missing" | "branch_if_visible";
  branchAction: "end_script" | "alert" | null;
  conditionMet: boolean;
  reason?: string;
  matched?: ResolvedSnapshotRef;
}

interface AlertStopResult {
  detected: true;
  reason: string;
  stepOrder: number;
  stepKind: ScriptStep["kind"];
  instruction: string;
}

interface EarlyExitResult {
  detected: true;
  reason: string;
  stepOrder: number;
  stepKind: ScriptStep["kind"];
  instruction: string;
}

class StepExecutionError extends Error {
  readonly stepOrder: number;
  readonly stepKind: ScriptStep["kind"];
  readonly instruction: string;
  readonly causeMessage: string | null;

  constructor(step: ScriptStep, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`Step ${step.order} (${step.kind}) failed: ${causeMessage}`);
    this.name = "StepExecutionError";
    this.stepOrder = step.order;
    this.stepKind = step.kind;
    this.instruction = step.instruction;
    this.causeMessage = causeMessage;
  }
}

class SnapshotRefNotFoundError extends Error {
  readonly stepOrder: number;

  constructor(step: ScriptStep) {
    super(`Could not resolve an OpenClaw ref for step ${step.order}.`);
    this.name = "SnapshotRefNotFoundError";
    this.stepOrder = step.order;
  }
}

function normalizeSearchText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function asBrowserTargetEntry(value: unknown): BrowserTargetEntry | null {
  return typeof value === "object" && value !== null ? (value as BrowserTargetEntry) : null;
}

function isTopLevelPageTarget(entry: BrowserTargetEntry) {
  const type = normalizeSearchText(entry.type);
  return !type || type === "page" || type === "tab";
}

function isWebPageUrl(value: unknown) {
  const url = scalarString(value).trim().toLowerCase();
  return url.startsWith("http://") || url.startsWith("https://");
}

function isInternalBrowserUrl(value: unknown) {
  const url = scalarString(value).trim().toLowerCase();
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("devtools://")
  );
}

function scoreBrowserTarget(entry: BrowserTargetEntry) {
  const url = scalarString(entry.url);
  let score = 0;

  if (isTopLevelPageTarget(entry)) {
    score += 1_000;
  }

  if (isWebPageUrl(url)) {
    score += 200;
  }

  if (/linkedin\.com/i.test(url)) {
    score += 50;
  }

  if (scalarBoolean(entry.focused) || scalarBoolean(entry.active) || scalarBoolean(entry.selected)) {
    score += 25;
  }

  if (isInternalBrowserUrl(url)) {
    score -= 150;
  }

  return score;
}

function cloneScriptStep(step: ScriptStep): ScriptStep {
  return {
    ...step,
    target: step.target
      ? {
        ...step.target,
        selectors: [...step.target.selectors],
        alternativeTexts: [...scalarStringArray(step.target.alternativeTexts)],
      }
      : null,
    params: Object.fromEntries(
      Object.entries(step.params).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value])
    ),
  };
}

function normalizeLinkedInProfileKey(value: unknown) {
  const raw = scalarString(value).trim();

  if (!raw) {
    return "";
  }

  try {
    const parsed = new URL(raw);
    const hostname = parsed.hostname.toLowerCase();

    if (!hostname.endsWith("linkedin.com")) {
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

function isProfileCardStep(step: ScriptStep) {
  const role = normalizeSearchText(step.target?.role);
  const combined = normalizeSearchText(
    [step.instruction, step.target?.description, step.target?.text].filter(Boolean).join(" ")
  );

  return (
    role === "link" &&
    /profile card|creator card|creator profile|person profile|person or creator profile|open the first profile|first profile/.test(combined)
  );
}

function isHeaderActionLink(name: string) {
  return /^(show all|manage all|see all|view all)\b/.test(normalizeSearchText(name));
}

function isPostActionMenuStep(step: ScriptStep) {
  const role = normalizeSearchText(step.target?.role);
  const combined = normalizeSearchText(
    [step.instruction, step.target?.description, step.target?.text, ...scalarStringArray(step.target?.alternativeTexts)]
      .filter(Boolean)
      .join(" ")
  );

  return (
    role === "button" &&
    /\bpost\b/.test(combined) &&
    /\bmore\b|more actions|more options|control menu/.test(combined)
  );
}

function isExpandableContentControl(name: string, context: string) {
  const combined = `${normalizeSearchText(name)} ${normalizeSearchText(context)}`;

  return /\bsee more\b|\bshow more\b|\bload more\b|visually reveals content which is already detected by screen readers/.test(combined);
}

function isLikelyPostActionMenuControl(name: string, context: string) {
  const combined = `${normalizeSearchText(name)} ${normalizeSearchText(context)}`;

  return /open control menu for post|open control menu for .* post|\bmore actions\b|\bmore options\b/.test(combined);
}

function hasNearbyLineMatch(lines: string[], lineIndex: number, before: number, after: number, pattern: RegExp) {
  const start = Math.max(0, lineIndex - before);
  const end = Math.min(lines.length, lineIndex + after);

  return lines.slice(start, end).some((line) => pattern.test(normalizeSearchText(line)));
}

function buildLineWindow(lines: string[], lineIndex: number, before: number, after: number) {
  return normalizeSearchText(
    lines.slice(Math.max(0, lineIndex - before), Math.min(lines.length, lineIndex + after)).join(" ")
  );
}

function normalizeTextPatterns(primary: unknown, alternatives: unknown) {
  return [scalarString(primary), ...scalarStringArray(alternatives)]
    .map((entry) => normalizeSearchText(entry))
    .filter(Boolean);
}

function scoreTextPattern(candidate: string, context: string, pattern: string) {
  const normalizedPattern = normalizeSearchText(pattern);

  if (!normalizedPattern) {
    return null;
  }

  const wildcardPrefix = normalizedPattern.replace(/\s*(?:\.\.\.|…)\s*$/, "").trim();
  const isWildcardPrefix = wildcardPrefix.length > 0 && wildcardPrefix !== normalizedPattern;

  if (isWildcardPrefix) {
    if (candidate.startsWith(wildcardPrefix)) {
      return 140;
    }

    if (candidate.includes(wildcardPrefix)) {
      return 100;
    }

    if (context.includes(wildcardPrefix)) {
      return 40;
    }

    return null;
  }

  if (candidate === normalizedPattern) {
    return 140;
  }

  if (candidate.includes(normalizedPattern)) {
    return 100;
  }

  if (context.includes(normalizedPattern)) {
    return 40;
  }

  return null;
}

function scoreAnyTextPattern(candidate: string, context: string, patterns: string[]) {
  let bestScore: number | null = null;

  for (const pattern of patterns) {
    const score = scoreTextPattern(candidate, context, pattern);

    if (score !== null && (bestScore === null || score > bestScore)) {
      bestScore = score;
    }
  }

  return bestScore;
}

function serializeUnknownError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null,
    };
  }

  return {
    name: typeof error,
    message: String(error),
    stack: null,
  };
}

function cloneStepResolution(resolution: StepResolutionRecord): StepResolutionRecord {
  return {
    requestedMode: resolution.requestedMode,
    resolver: resolution.resolver,
    usedAi: resolution.usedAi,
    fallbackReason: resolution.fallbackReason,
    matchedRef: resolution.matchedRef,
    candidateCount: resolution.candidateCount,
  };
}

function extractStepResolution(output: unknown) {
  if (
    typeof output === "object" &&
    output !== null &&
    "matched" in output &&
    typeof (output as { matched?: unknown }).matched === "object" &&
    (output as { matched?: unknown }).matched !== null &&
    "resolution" in ((output as { matched: { resolution?: unknown } }).matched)
  ) {
    const resolution = (output as {
      matched: { resolution?: StepResolutionRecord };
    }).matched.resolution;

    return resolution ? cloneStepResolution(resolution) : null;
  }

  return null;
}

function inferInstructionIndex(instruction: string) {
  const normalized = normalizeSearchText(instruction);

  if (normalized.includes("first")) {
    return 1;
  }

  if (normalized.includes("second")) {
    return 2;
  }

  if (normalized.includes("third")) {
    return 3;
  }

  if (normalized.includes("fourth")) {
    return 4;
  }

  if (normalized.includes("fifth")) {
    return 5;
  }

  return 0;
}

function getOrdinalPostContextIndex(step: ScriptStep) {
  const explicitIndex = Number(step.params.index);
  const inferredIndex = Number.isFinite(explicitIndex) && explicitIndex > 0
    ? Math.floor(explicitIndex)
    : inferInstructionIndex(step.instruction);

  if (inferredIndex <= 0) {
    return 0;
  }

  const combined = normalizeSearchText(
    [step.instruction, step.target?.description, step.target?.text, step.target?.role].filter(Boolean).join(" ")
  );

  return /\bpost\b/.test(combined) || normalizeSearchText(step.target?.role) === "article"
    ? inferredIndex
    : 0;
}

function hasExplicitTargetIndex(step: ScriptStep) {
  const explicitIndex = Number(step.params.index);

  return Number.isFinite(explicitIndex) && explicitIndex > 0;
}

function shouldAutoScrollSearch(step: ScriptStep) {
  const role = normalizeSearchText(step.target?.role);
  const explicitIndex = Number(step.params.index);
  const hasIndexedArticleTarget = role === "article" && Number.isFinite(explicitIndex) && explicitIndex > 1;

  return hasIndexedArticleTarget;
}

function appendTaskLog(taskId: string | undefined, message: string) {
  if (!taskId || !isTaskLoggingEnabled()) {
    return;
  }

  try {
    mkdirSync(logsDirectory, { recursive: true });

    appendFileSync(
      resolve(logsDirectory, `${taskId}.log`),
      `[${new Date().toISOString()}] ${message}\n`,
      "utf8"
    );
  } catch {
    // Logging must remain best-effort so task execution does not depend on log file write access.
  }
}

function initializeTaskLog(taskId: string | undefined, payload: Record<string, unknown>) {
  if (!taskId || !isTaskLoggingEnabled()) {
    return;
  }

  try {
    mkdirSync(logsDirectory, { recursive: true });

    writeFileSync(
      resolve(logsDirectory, `${taskId}.log`),
      `${JSON.stringify(payload, null, 2)}\n\n`,
      "utf8"
    );
  } catch {
    // Logging must remain best-effort so task execution does not depend on log file write access.
  }
}

export class OpenClawRuntime {
  private readonly browserProfile = (process.env.OPENCLAW_BROWSER_PROFILE || "").trim();
  private readonly gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || "";
  private readonly gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || "";
  private readonly openClawBin = process.env.OPENCLAW_BIN || "openclaw";
  private readonly aiModel = process.env.OPENCLAW_AI_MODEL || "gpt-4.1-mini";
  private readonly aiCandidateLimit = Math.max(5, Number(process.env.OPENCLAW_AI_CANDIDATE_LIMIT || 24));
  private readonly aiSnapshotExcerptChars = Math.max(1200, Number(process.env.OPENCLAW_AI_SNAPSHOT_EXCERPT_CHARS || 2500));
  private windowsInvocation: OpenClawInvocation | null = null;
  private openAiClient: OpenAI | null | undefined;

  executeScript(script: ScriptInstructions, options?: string | ExecuteScriptOptions) {
    if (typeof options === "string") {
      return this.runScript(script, { targetId: options, engineMode: "deterministic" });
    }

    const normalizedOptions: ExecuteScriptOptions = {
      ...options,
      engineMode: options?.engineMode === "ai_driven" ? "ai_driven" : "deterministic",
    };

    if (normalizedOptions.engineMode === "ai_driven") {
      return this.runAiDrivenScript(script, normalizedOptions);
    }

    return this.runScript(script, normalizedOptions);
  }

  private async runAiDrivenScript(script: ScriptInstructions, options: ExecuteScriptOptions = {}) {
    appendTaskLog(options.taskId, `ENGINE_MODE ${JSON.stringify({
      taskId: options.taskId ?? null,
      requestedEngineMode: "ai_driven",
      resolver: "ai_driven",
      note: "AI-driven resolver enabled for snapshot target selection with deterministic action execution.",
      recordedAt: new Date().toISOString(),
    })}`);

    return this.runScript(script, { ...options, engineMode: "ai_driven" });
  }

  private getOpenAiClient() {
    if (this.openAiClient !== undefined) {
      return this.openAiClient;
    }

    const openAiApiKey = getOpenAiApiKey();

    if (!openAiApiKey) {
      this.openAiClient = null;
      return this.openAiClient;
    }

    this.openAiClient = new OpenAI({
      apiKey: openAiApiKey,
      project: getOpenAiProjectKey() || undefined,
    });

    return this.openAiClient;
  }

  private resolveWindowsOpenClawPath() {
    if (isAbsolute(this.openClawBin) && existsSync(this.openClawBin)) {
      return this.openClawBin;
    }

    const result = spawnSync("where.exe", [this.openClawBin], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });

    if (result.status !== 0) {
      return null;
    }

    const candidates = String(result.stdout || "")
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);

    return (
      candidates.find((entry) => entry.toLowerCase().endsWith(".cmd")) ||
      candidates[0] ||
      null
    );
  }

  private resolveOpenClawInvocation(): OpenClawInvocation {
    if (process.platform !== "win32") {
      return {
        command: this.openClawBin,
        commandArgsPrefix: [],
      };
    }

    if (this.windowsInvocation) {
      return this.windowsInvocation;
    }

    const resolvedBinPath = this.resolveWindowsOpenClawPath();

    if (resolvedBinPath) {
      const binDirectory = dirname(resolvedBinPath);
      const nodePath = resolve(binDirectory, "node.exe");
      const cliScriptPath = resolve(binDirectory, "node_modules", "openclaw", "openclaw.mjs");

      if (existsSync(cliScriptPath)) {
        this.windowsInvocation = {
          command: existsSync(nodePath) ? nodePath : process.execPath,
          commandArgsPrefix: [cliScriptPath],
        };

        return this.windowsInvocation;
      }
    }

    this.windowsInvocation = {
      command: windowsShell,
      commandArgsPrefix: ["/d", "/s", "/c", this.openClawBin],
    };

    return this.windowsInvocation;
  }

  private async oc(
    args: string[],
    options: { json?: boolean } & ExecutionContext = {}
  ) {
    const { json = false, taskId } = options;
    const fullArgs = ["browser"];

    if (this.browserProfile) {
      fullArgs.push("--browser-profile", this.browserProfile);
    }

    if (this.gatewayUrl) {
      fullArgs.push("--url", this.gatewayUrl);
    }

    if (this.gatewayToken) {
      fullArgs.push("--token", this.gatewayToken);
    }

    if (json) {
      fullArgs.push("--json");
    }

    fullArgs.push(...args);

    const invocation = this.resolveOpenClawInvocation();
    const command = invocation.command;
    const commandArgs = [...invocation.commandArgsPrefix, ...fullArgs];

    console.log(
      `[openclaw] ${command} ${maskCommandArgs(commandArgs)
        .map((entry) => (entry.includes(" ") ? JSON.stringify(entry) : entry))
        .join(" ")}`
    );
    appendTaskLog(
      taskId,
      `COMMAND ${JSON.stringify({
        command,
        commandArgs: maskCommandArgs(commandArgs),
      })}`
    );

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    const child = spawn(command, commandArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdoutChunks.push(chunk);
    });

    child.stderr.on("data", (chunk: string) => {
      stderrChunks.push(chunk);
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", (error) => {
        reject(error);
      });

      child.once("close", (code) => {
        resolve(code ?? 0);
      });
    });

    const stdout = stdoutChunks.join("").trim();
    const stderr = stderrChunks.join("").trim();

    appendTaskLog(
      taskId,
      `RESPONSE ${JSON.stringify({
        command,
        commandArgs: maskCommandArgs(commandArgs),
        exitCode,
        stdout,
        stderr,
      })}`
    );

    if (exitCode !== 0) {
      throw new Error((stderr || stdout || `OpenClaw exited with code ${exitCode}.`).trim());
    }

    if (!json) {
      return stdout;
    }

    return stdout ? JSON.parse(stdout) : null;
  }

  private async getFocusedTab(context: ExecutionContext = {}) {
    const tabs = await this.oc(["tabs"], { json: true, ...context });
    const list = Array.isArray(tabs) ? tabs : tabs?.tabs || tabs?.items || [];

    if (!Array.isArray(list) || list.length === 0) {
      throw new Error("No browser tabs were returned by OpenClaw.");
    }

    const candidates = list
      .map((entry) => asBrowserTargetEntry(entry))
      .filter((entry): entry is BrowserTargetEntry => Boolean(entry?.targetId || entry?.id));

    if (candidates.length === 0) {
      throw new Error("Could not determine targetId from OpenClaw tabs output.");
    }

    const preferredCandidates = candidates.filter((entry) => isTopLevelPageTarget(entry));
    const rankedCandidates = (preferredCandidates.length > 0 ? preferredCandidates : candidates)
      .map((entry, index) => ({
        entry,
        index,
        score: scoreBrowserTarget(entry),
      }))
      .sort((left, right) => right.score - left.score || left.index - right.index);

    const active = rankedCandidates[0]?.entry;
    const id = active?.targetId || active?.id;

    if (!id) {
      throw new Error("Could not determine targetId from OpenClaw tabs output.");
    }

    appendTaskLog(context.taskId, `TAB_SELECTION ${JSON.stringify({
      selectedTargetId: String(id),
      selectedType: scalarString(active?.type),
      selectedUrl: scalarString(active?.url),
      selectedTitle: scalarString(active?.title),
      candidateCount: candidates.length,
      preferredCandidateCount: preferredCandidates.length,
    })}`);

    return {
      id: String(id),
      url: scalarString(active?.url),
      title: scalarString(active?.title),
    };
  }

  private async evaluate(targetId: string, expression: string, context: ExecutionContext = {}) {
    const response = parseJsonish(
      await this.oc(["evaluate", "--fn", expression, "--target-id", targetId], {
        json: true,
        ...context,
      })
    );

    return typeof response === "object" && response !== null && "result" in response
      ? (response as { result: unknown }).result
      : response;
  }

  private async evaluateRef(
    targetId: string,
    ref: string,
    expression: string,
    context: ExecutionContext = {}
  ) {
    const response = parseJsonish(
      await this.oc(["evaluate", "--fn", expression, "--ref", ref, "--target-id", targetId], {
        json: true,
        ...context,
      })
    );

    return typeof response === "object" && response !== null && "result" in response
      ? (response as { result: unknown }).result
      : response;
  }

  private async getSnapshot(targetId: string, context: ExecutionContext = {}) {
    return await this.oc(["snapshot", "--target-id", targetId, "--limit", "800"], {
      json: true,
      ...context,
    }) as BrowserSnapshot;
  }

  private async getPageState(targetId: string, context: ExecutionContext = {}) {
    return await this.evaluate(
      targetId,
      `() => ({ url: window.location.href, title: document.title, readyState: document.readyState, scrollY: window.scrollY })`,
      context
    ) as {
      url: string;
      title: string;
      readyState: string;
      scrollY: number;
    };
  }

  private getRuntimeState(context: ExecutionContext) {
    if (!context.runtimeState) {
      throw new Error("Runtime state is not available for this script execution.");
    }

    return context.runtimeState;
  }

  private recordVisitedProfile(context: ExecutionContext, profileUrl: string) {
    const runtimeState = this.getRuntimeState(context);
    const normalizedProfileUrl = normalizeLinkedInProfileUrl(profileUrl);
    const profileKey = normalizeLinkedInProfileKey(normalizedProfileUrl);

    if (!normalizedProfileUrl || !profileKey) {
      return null;
    }

    const existing = runtimeState.visitedProfiles.get(profileKey);

    if (existing) {
      return existing;
    }

    const visitedProfile = {
      profileKey,
      profileUrl: normalizedProfileUrl,
      visitedAt: new Date().toISOString(),
    } satisfies VisitedProfileRecord;

    runtimeState.visitedProfiles.set(profileKey, visitedProfile);
    return visitedProfile;
  }

  private buildProfileVisitLookupUrl(template: string, profileUrl: string, lookbackDays: number) {
    if (!template) {
      return "";
    }

    return template
      .replaceAll("{profileUrl}", encodeURIComponent(profileUrl))
      .replaceAll("{lookbackDays}", encodeURIComponent(String(lookbackDays)));
  }

  private async fetchRecentProfileVisit(profileUrl: string, lookbackDays: number, context: ExecutionContext) {
    const template = scalarString(context.profileVisitLookupUrlTemplate).trim();
    const requestUrl = this.buildProfileVisitLookupUrl(template, profileUrl, lookbackDays);

    if (!requestUrl) {
      throw new Error("Profile visit lookup URL is not configured for this script execution.");
    }

    const remoteControllerSecretKey = getRemoteControllerSecretKey();

    if (!remoteControllerSecretKey) {
      throw new Error("REMOTE_CONTROLLER_SECRET_KEY must be configured for profile history lookups.");
    }

    const response = await fetch(requestUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-remote-controller-secret-key": remoteControllerSecretKey,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok || typeof payload !== "object" || payload === null) {
      throw new Error(
        `Profile visit lookup failed${response.status ? ` with HTTP ${response.status}` : ""}.`
      );
    }

    return payload as {
      profileUrl?: string;
      profileKey?: string;
      lookbackDays?: number;
      recentlyVisited?: boolean;
      latestVisitedAt?: string | null;
    };
  }

  private async navigateBackToProfileSourcePage(
    targetId: string,
    currentProfileUrl: string,
    sourcePageUrl: string,
    timeoutMs: number,
    context: ExecutionContext = {}
  ) {
    await this.evaluate(targetId, `() => { window.history.back(); return true; }`, context);

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      await sleep(250);
      const pageState = await this.getPageState(targetId, context);
      const currentUrl = scalarString(pageState.url);

      if (
        currentUrl &&
        currentUrl !== currentProfileUrl &&
        pageState.readyState === "complete" &&
        (!sourcePageUrl || currentUrl === sourcePageUrl || !normalizeLinkedInProfileKey(currentUrl))
      ) {
        return pageState;
      }
    }

    if (sourcePageUrl && sourcePageUrl !== currentProfileUrl) {
      await this.oc(["navigate", sourcePageUrl, "--target-id", targetId], context);
      await this.oc(["wait", "--target-id", targetId, "--timeout-ms", String(timeoutMs), "--load", "load"], context);
      return await this.getPageState(targetId, context);
    }

    throw new Error("Timed out returning to the profile source page.");
  }

  private async waitForLinkedInProfilePage(targetId: string, timeoutMs: number, context: ExecutionContext = {}) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const pageState = await this.getPageState(targetId, context);
      const profileUrl = normalizeLinkedInProfileUrl(pageState.url);

      if (profileUrl && pageState.readyState === "complete") {
        return {
          pageState,
          profileUrl,
          profileKey: normalizeLinkedInProfileKey(profileUrl),
        };
      }

      await sleep(250);
    }

    throw new Error("Timed out waiting for a LinkedIn profile page to load.");
  }

  private async openNextProfileCandidate(targetId: string, timeoutMs: number, context: ExecutionContext = {}) {
    const runtimeState = this.getRuntimeState(context);
    const selection = runtimeState.profileCardSelection;

    if (!selection) {
      throw new Error("No profile card selection context is available to choose the next profile.");
    }

    const nextStep = cloneScriptStep(selection.step);
    nextStep.params.index = selection.currentIndex + 1;

    try {
      const resolved = await this.resolveSnapshotRef(targetId, nextStep, context);
      await this.oc(["click", resolved.ref, "--target-id", targetId], context);
      runtimeState.profileCardSelection = {
        ...selection,
        step: nextStep,
        currentIndex: Number(nextStep.params.index),
      };
      return { resolved, nextIndex: Number(nextStep.params.index) };
    } catch (error) {
      if (error instanceof SnapshotRefNotFoundError) {
        return null;
      }

      if (error instanceof Error && /Could not resolve an OpenClaw ref/.test(error.message)) {
        return null;
      }

      throw error;
    }
  }

  private async skipIfProfileRecentlyVisited(
    targetId: string,
    step: ScriptStep,
    context: ExecutionContext = {}
  ) {
    const lookbackDays = boundedPositiveInteger(step.params.lookbackDays, 30);
    const maxSkips = boundedPositiveInteger(step.params.maxSkips, 25);
    const skippedProfiles: string[] = [];

    for (let attempt = 0; attempt < maxSkips; attempt += 1) {
      const { pageState, profileUrl, profileKey } = await this.waitForLinkedInProfilePage(
        targetId,
        step.timeoutMs,
        context
      );
      this.recordVisitedProfile(context, profileUrl);
      const lookup = await this.fetchRecentProfileVisit(profileUrl, lookbackDays, context);
      const recentlyVisited = lookup.recentlyVisited === true;

      appendTaskLog(context.taskId, `PROFILE_VISIT_CHECK ${JSON.stringify({
        taskId: context.taskId ?? null,
        checkedAt: new Date().toISOString(),
        profileUrl,
        profileKey,
        lookbackDays,
        recentlyVisited,
        latestVisitedAt: lookup.latestVisitedAt ?? null,
      })}`);

      if (!recentlyVisited) {
        return {
          ok: true,
          action: step.kind,
          profileUrl,
          profileKey,
          lookbackDays,
          recentlyVisited: false,
          skippedProfiles,
          currentPage: pageState,
        };
      }

      skippedProfiles.push(profileUrl);
      const runtimeState = this.getRuntimeState(context);
      const sourcePageUrl = runtimeState.profileCardSelection?.sourcePageUrl || "";

      await this.navigateBackToProfileSourcePage(
        targetId,
        profileUrl,
        sourcePageUrl,
        step.timeoutMs,
        context
      );

      const nextCandidate = await this.openNextProfileCandidate(targetId, step.timeoutMs, context);

      if (!nextCandidate) {
        return {
          ok: true,
          action: step.kind,
          profileUrl,
          profileKey,
          lookbackDays,
          recentlyVisited: true,
          skippedProfiles,
          exhausted: true,
          branchAction: "end_script",
        };
      }

      await this.waitForLinkedInProfilePage(targetId, step.timeoutMs, context);
    }

    return {
      ok: true,
      action: step.kind,
      lookbackDays,
      recentlyVisited: true,
      skippedProfiles,
      exhausted: true,
      branchAction: "end_script",
      reason: "max_skips_reached",
    };
  }

  private buildSnapshotLineIndex(snapshotText: string) {
    const lines = snapshotText.split(/\r?\n/);
    const refLines = new Map<string, number>();

    lines.forEach((line, lineIndex) => {
      const matches = line.matchAll(/\[ref=([^\]]+)\]/g);

      for (const match of matches) {
        refLines.set(match[1], lineIndex);
      }
    });

    return { lines, refLines };
  }

  private buildSnapshotRefs(snapshot: BrowserSnapshot, lines: string[]) {
    const mergedRefs = { ...(snapshot.refs || {}) };

    const refPattern = /\[ref=([^\]]+)\]/g;

    lines.forEach((line) => {
      const roleMatch = line.match(/^\s*-\s+'?([a-z_]+)/i);
      const role = roleMatch ? normalizeSearchText(roleMatch[1]) : "";
      const nameMatch = line.match(/\s["']([^"']+)["'](?=\s+\[ref=)/);
      const name = nameMatch ? scalarString(nameMatch[1]) : "";

      for (const match of line.matchAll(refPattern)) {
        const ref = match[1];

        if (mergedRefs[ref]) {
          continue;
        }

        mergedRefs[ref] = {
          role,
          name,
        } satisfies BrowserSnapshotRef;
      }
    });

    return mergedRefs;
  }

  private getCandidateIndex(step: ScriptStep) {
    const explicitIndex = Number(step.params.index);

    if (Number.isFinite(explicitIndex) && explicitIndex > 0) {
      return Math.floor(explicitIndex);
    }

    const inferredIndex = inferInstructionIndex(step.instruction);
    return inferredIndex > 0 ? inferredIndex : 1;
  }

  private getSnapshotMatches(snapshot: BrowserSnapshot, step: ScriptStep) {
    const target = step.target;

    if (!target || target.role === "document") {
      return [];
    }

    const roleNeedle = normalizeSearchText(target.role);
    const targetTextPatterns = normalizeTextPatterns(target.text, target.alternativeTexts);
    const description = normalizeSearchText(target.description);
    const profileCardStep = isProfileCardStep(step);
    const postActionMenuStep = isPostActionMenuStep(step);
    const ordinalPostContextIndex = getOrdinalPostContextIndex(step);
    const postContextNeedle = ordinalPostContextIndex > 0 ? `feed post number ${ordinalPostContextIndex}` : "";
    const containerTextPatterns = normalizeTextPatterns(
      step.params.containerText,
      step.params.containerAlternativeTexts
    );
    const { lines, refLines } = this.buildSnapshotLineIndex(snapshot.snapshot || "");
    const refs = this.buildSnapshotRefs(snapshot, lines);
    const matches = Object.entries(refs)
      .map(([ref, meta]) => {
        const role = normalizeSearchText(meta.role);
        const name = normalizeSearchText(meta.name);

        if (roleNeedle && role !== roleNeedle) {
          return null;
        }

        const lineIndex = refLines.get(ref) ?? Number.MAX_SAFE_INTEGER;
        const nearbyContext = normalizeSearchText(
          lines.slice(Math.max(0, lineIndex - 40), Math.min(lines.length, lineIndex + 6)).join(" ")
        );
        const localContext = buildLineWindow(lines, lineIndex, 8, 18);
        const hasAnyPostContext = /\bfeed post number \d+\b/.test(nearbyContext);
        const hasDesiredPostContext = Boolean(postContextNeedle) && nearbyContext.includes(postContextNeedle);
        const hasListItemAncestor = hasNearbyLineMatch(lines, lineIndex, 8, 0, /\blistitem\b/);
        const hasProfileUrl = /\/url:\s+https:\/\/www\.linkedin\.com\/(?:in|creator)\//.test(localContext);
        const hasPersonCardSignals = /\binvite\b.*\bconnect\b|\bremove\b.*\bsuggestion\b/.test(localContext);
        const expandableContentControl = isExpandableContentControl(name, localContext);
        const likelyPostActionMenuControl = isLikelyPostActionMenuControl(name, localContext);

        if (containerTextPatterns.length > 0 && scoreAnyTextPattern(name, nearbyContext, containerTextPatterns) === null) {
          return null;
        }

        if (profileCardStep && isHeaderActionLink(name)) {
          return null;
        }

        if (postActionMenuStep && expandableContentControl) {
          return null;
        }

        let score = 0;

        if (roleNeedle) {
          score += 40;
        }

        if (targetTextPatterns.length > 0) {
          const interactiveRole = role === "button" || role === "link";
          const textScore = interactiveRole && name
            ? scoreAnyTextPattern(name, name, targetTextPatterns)
            : scoreAnyTextPattern(name, nearbyContext, targetTextPatterns);

          if (textScore === null) {
            return null;
          }

          score += textScore;
        }

        if (description && targetTextPatterns.length === 0) {
          if (name.includes(description)) {
            score += 30;
          } else if (nearbyContext.includes(description)) {
            score += 15;
          }
        }

        if (targetTextPatterns.length === 0 && !description) {
          score += name ? 5 : 1;
        }

        if (containerTextPatterns.length > 0) {
          score += 20;
        }

        if (postContextNeedle) {
          if (hasDesiredPostContext) {
            score += 180;
          } else if (hasAnyPostContext) {
            score -= 180;
          }
        }

        if (profileCardStep) {
          if (hasListItemAncestor) {
            score += 90;
          }

          if (hasProfileUrl) {
            score += 120;
          }

          if (hasPersonCardSignals) {
            score += 45;
          }

          if (/suggestions for /.test(name)) {
            score -= 160;
          }
        }

        if (postActionMenuStep) {
          if (likelyPostActionMenuControl) {
            score += 220;
          }

          if (/open reactions menu/.test(`${name} ${localContext}`)) {
            score -= 120;
          }

          if (name && /\bmore\b/.test(name) && !likelyPostActionMenuControl) {
            score -= 40;
          }
        }

        return {
          ref,
          role,
          name: scalarString(meta.name),
          lineIndex,
          score,
        };
      })
      .filter((entry): entry is { ref: string; role: string; name: string; lineIndex: number; score: number } => Boolean(entry))
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        if (left.lineIndex !== right.lineIndex) {
          return left.lineIndex - right.lineIndex;
        }

        return left.ref.localeCompare(right.ref, undefined, { numeric: true });
      });

    return matches;
  }

  private buildAiResolutionCandidates(snapshot: BrowserSnapshot, step: ScriptStep) {
    const target = step.target;

    if (!target || target.role === "document") {
      return [] as AiResolutionCandidate[];
    }

    const roleNeedle = normalizeSearchText(target.role);
    const targetTextPatterns = normalizeTextPatterns(target.text, target.alternativeTexts);
    const description = normalizeSearchText(target.description);
    const profileCardStep = isProfileCardStep(step);
    const postActionMenuStep = isPostActionMenuStep(step);
    const ordinalPostContextIndex = getOrdinalPostContextIndex(step);
    const postContextNeedle = ordinalPostContextIndex > 0 ? `feed post number ${ordinalPostContextIndex}` : "";
    const containerTextPatterns = normalizeTextPatterns(
      step.params.containerText,
      step.params.containerAlternativeTexts
    );
    const { lines, refLines } = this.buildSnapshotLineIndex(snapshot.snapshot || "");
    const refs = this.buildSnapshotRefs(snapshot, lines);

    return Object.entries(refs)
      .map(([ref, meta]) => {
        const role = normalizeSearchText(meta.role);

        if (roleNeedle && role !== roleNeedle) {
          return null;
        }

        const name = scalarString(meta.name);
        const normalizedName = normalizeSearchText(name);

        if (profileCardStep && isHeaderActionLink(normalizedName)) {
          return null;
        }

        const lineIndex = refLines.get(ref) ?? Number.MAX_SAFE_INTEGER;
        const nearbyContext = buildLineWindow(lines, lineIndex, 10, 24);
        const sourceLine = scalarString(lines[lineIndex]).trim();
        const expandableContentControl = isExpandableContentControl(name, nearbyContext);
        const likelyPostActionMenuControl = isLikelyPostActionMenuControl(name, nearbyContext);

        if (postActionMenuStep && expandableContentControl) {
          return null;
        }

        let score = 0;

        if (roleNeedle) {
          score += 35;
        }

        if (targetTextPatterns.length > 0) {
          const textScore = scoreAnyTextPattern(normalizedName, nearbyContext, targetTextPatterns);

          if (textScore !== null) {
            score += textScore;
          }
        }

        if (description) {
          if (normalizedName.includes(description)) {
            score += 24;
          } else if (nearbyContext.includes(description)) {
            score += 12;
          }
        }

        if (containerTextPatterns.length > 0) {
          const containerScore = scoreAnyTextPattern(normalizedName, nearbyContext, containerTextPatterns);

          if (containerScore !== null) {
            score += Math.max(18, Math.floor(containerScore / 2));
          }
        }

        if (postContextNeedle) {
          if (nearbyContext.includes(postContextNeedle)) {
            score += 80;
          } else if (/\bfeed post number \d+\b/.test(nearbyContext)) {
            score -= 60;
          }
        }

        if (!normalizedName && !sourceLine) {
          score -= 25;
        }

        if (postActionMenuStep) {
          if (likelyPostActionMenuControl) {
            score += 160;
          }

          if (/open reactions menu/.test(`${normalizedName} ${nearbyContext}`)) {
            score -= 120;
          }
        }

        return {
          ref,
          role: role || scalarString(meta.role),
          name,
          lineIndex,
          score,
          context: sourceLine,
          nearbyContext,
        } satisfies AiResolutionCandidate;
      })
      .filter((entry): entry is AiResolutionCandidate => Boolean(entry))
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        if (left.lineIndex !== right.lineIndex) {
          return left.lineIndex - right.lineIndex;
        }

        return left.ref.localeCompare(right.ref, undefined, { numeric: true });
      })
      .slice(0, this.aiCandidateLimit);
  }

  private async selectSnapshotRefWithAi(
    step: ScriptStep,
    snapshot: BrowserSnapshot,
    candidates: AiResolutionCandidate[],
    context: ExecutionContext = {}
  ) {
    const client = this.getOpenAiClient();

    if (!client || candidates.length === 0) {
      return null;
    }

    const snapshotExcerpt = scalarString(snapshot.snapshot).slice(0, this.aiSnapshotExcerptChars);

    try {
      const completion = await client.chat.completions.create({
        model: this.aiModel,
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content: [
              "You select the best OpenClaw snapshot ref for one browser-automation step.",
              "You must choose only from the provided candidates.",
              "Do not invent refs, selectors, actions, or page states.",
              "Prefer the candidate whose role, accessible name, and nearby snapshot context best match the operator intent.",
              "If none of the candidates are a defensible match, return ref=null.",
            ].join(" "),
          },
          {
            role: "user",
            content: JSON.stringify({
              task: "select_snapshot_ref",
              step: {
                order: step.order,
                kind: step.kind,
                instruction: step.instruction,
                target: step.target,
                params: step.params,
              },
              snapshot: {
                url: snapshot.url ?? null,
                truncated: snapshot.truncated === true,
                excerpt: snapshotExcerpt,
              },
              candidates: candidates.map((candidate) => ({
                ref: candidate.ref,
                role: candidate.role,
                name: candidate.name,
                score: candidate.score,
                context: candidate.context,
                nearbyContext: candidate.nearbyContext,
              })),
            }),
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "select_snapshot_ref",
              description: "Choose the single best candidate ref for the step or return null if no candidate fits.",
              parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                  ref: {
                    type: ["string", "null"],
                    description: "The chosen candidate ref, or null if none fit.",
                  },
                  confidence: {
                    type: "string",
                    enum: ["high", "medium", "low"],
                  },
                  reasoning: {
                    type: "string",
                    description: "A short explanation grounded in the candidate names and context.",
                  },
                },
                required: ["ref", "confidence", "reasoning"],
              },
            },
          },
        ],
        tool_choice: {
          type: "function",
          function: { name: "select_snapshot_ref" },
        },
      });

      const toolCall = completion.choices[0]?.message?.tool_calls?.[0];

      if (!toolCall || toolCall.type !== "function") {
        return null;
      }

      const parsed = JSON.parse(toolCall.function.arguments) as {
        ref?: unknown;
        confidence?: unknown;
        reasoning?: unknown;
      };
      const ref = scalarString(parsed.ref);

      if (!ref) {
        appendTaskLog(context.taskId, `AI_RESOLUTION_NO_MATCH ${JSON.stringify({
          taskId: context.taskId ?? null,
          step: { order: step.order, kind: step.kind, instruction: step.instruction },
          confidence: scalarString(parsed.confidence),
          reasoning: scalarString(parsed.reasoning),
        })}`);
        return null;
      }

      const candidate = candidates.find((entry) => entry.ref === ref);

      if (!candidate) {
        appendTaskLog(context.taskId, `AI_RESOLUTION_INVALID_REF ${JSON.stringify({
          taskId: context.taskId ?? null,
          step: { order: step.order, kind: step.kind, instruction: step.instruction },
          returnedRef: ref,
        })}`);
        return null;
      }

      appendTaskLog(context.taskId, `AI_RESOLUTION ${JSON.stringify({
        taskId: context.taskId ?? null,
        step: { order: step.order, kind: step.kind, instruction: step.instruction },
        selected: {
          ref: candidate.ref,
          role: candidate.role,
          name: candidate.name,
        },
        confidence: scalarString(parsed.confidence),
        reasoning: scalarString(parsed.reasoning),
      })}`);

      context.engineStats && (context.engineStats.aiSelections += 1);

      return {
        ref: candidate.ref,
        role: candidate.role,
        name: candidate.name,
        candidateCount: candidates.length,
        resolution: {
          requestedMode: "ai_driven",
          resolver: "ai_driven",
          usedAi: true,
          fallbackReason: null,
          matchedRef: candidate.ref,
          candidateCount: candidates.length,
        },
      } satisfies ResolvedSnapshotRef;
    } catch (error) {
      if (context.engineStats) {
        context.engineStats.aiErrors += 1;
      }

      appendTaskLog(context.taskId, `AI_RESOLUTION_ERROR ${JSON.stringify({
        taskId: context.taskId ?? null,
        step: { order: step.order, kind: step.kind, instruction: step.instruction },
        error: serializeUnknownError(error),
      })}`);

      return null;
    }
  }

  private async resolveSnapshotRefDeterministic(
    targetId: string,
    step: ScriptStep,
    context: ExecutionContext = {}
  ) {
    const deadline = Date.now() + Math.max(250, step.timeoutMs);
    const desiredIndex = this.getCandidateIndex(step);
    const hasExplicitIndex = hasExplicitTargetIndex(step);

    while (Date.now() <= deadline) {
      const snapshot = await this.getSnapshot(targetId, context);
      const matches = this.getSnapshotMatches(snapshot, step);
      const resolved = hasExplicitIndex
        ? matches[desiredIndex - 1] || null
        : matches[desiredIndex - 1] || matches[0] || null;

      if (resolved) {
        if (context.engineStats) {
          context.engineStats.deterministicSelections += 1;
        }

        return {
          ref: resolved.ref,
          role: resolved.role,
          name: resolved.name,
          candidateCount: matches.length,
          resolution: {
            requestedMode: context.engineMode === "ai_driven" ? "ai_driven" : "deterministic",
            resolver: "deterministic",
            usedAi: false,
            fallbackReason: null,
            matchedRef: resolved.ref,
            candidateCount: matches.length,
          },
        } satisfies ResolvedSnapshotRef;
      }

      if (shouldAutoScrollSearch(step)) {
        const nextScroll = await this.scrollPageOrPostContainer(
          targetId,
          { behavior: "auto", direction: "down" },
          context
        );

        if (!nextScroll.moved) {
          break;
        }
      }

      await sleep(Math.min(500, Math.max(100, step.delayAfterMs || 250)));
    }

    throw new SnapshotRefNotFoundError(step);
  }

  private async resolveSnapshotRefWithAi(targetId: string, step: ScriptStep, context: ExecutionContext = {}) {
    const client = this.getOpenAiClient();

    if (!client) {
      if (context.engineStats) {
        context.engineStats.aiFallbacks += 1;
      }

      appendTaskLog(context.taskId, `AI_RESOLUTION_FALLBACK ${JSON.stringify({
        taskId: context.taskId ?? null,
        step: { order: step.order, kind: step.kind, instruction: step.instruction },
        reason: "missing_openai_api_key",
      })}`);
      const deterministicResolution = await this.resolveSnapshotRefDeterministic(targetId, step, context);

      return {
        ...deterministicResolution,
        resolution: {
          requestedMode: "ai_driven",
          resolver: "deterministic_fallback",
          usedAi: false,
          fallbackReason: "missing_openai_api_key",
          matchedRef: deterministicResolution.ref,
          candidateCount: deterministicResolution.candidateCount,
        },
      } satisfies ResolvedSnapshotRef;
    }

    const deadline = Date.now() + Math.max(250, step.timeoutMs);

    while (Date.now() <= deadline) {
      const snapshot = await this.getSnapshot(targetId, context);
      const candidates = this.buildAiResolutionCandidates(snapshot, step);
      const resolved = await this.selectSnapshotRefWithAi(step, snapshot, candidates, context);

      if (resolved) {
        return resolved;
      }

      if (shouldAutoScrollSearch(step)) {
        const nextScroll = await this.scrollPageOrPostContainer(
          targetId,
          { behavior: "auto", direction: "down" },
          context
        );

        if (!nextScroll.moved) {
          break;
        }
      }

      await sleep(Math.min(500, Math.max(100, step.delayAfterMs || 250)));
    }

    if (context.engineStats) {
      context.engineStats.aiFallbacks += 1;
    }

    appendTaskLog(context.taskId, `AI_RESOLUTION_FALLBACK ${JSON.stringify({
      taskId: context.taskId ?? null,
      step: { order: step.order, kind: step.kind, instruction: step.instruction },
      reason: "no_ai_candidate_selected",
    })}`);

    const deterministicResolution = await this.resolveSnapshotRefDeterministic(targetId, step, context);

    return {
      ...deterministicResolution,
      resolution: {
        requestedMode: "ai_driven",
        resolver: "deterministic_fallback",
        usedAi: false,
        fallbackReason: "no_ai_candidate_selected",
        matchedRef: deterministicResolution.ref,
        candidateCount: deterministicResolution.candidateCount,
      },
    } satisfies ResolvedSnapshotRef;
  }

  private async resolveSnapshotRef(targetId: string, step: ScriptStep, context: ExecutionContext = {}) {
    if (context.engineMode === "ai_driven") {
      return this.resolveSnapshotRefWithAi(targetId, step, context);
    }

    return this.resolveSnapshotRefDeterministic(targetId, step, context);
  }

  private async waitForPage(targetId: string, step: ScriptStep, context: ExecutionContext = {}) {
    const timeoutMs = String(step.timeoutMs);
    const readyState = scalarString(step.params.readyState, "complete");
    const urlIncludes = scalarString(step.params.urlIncludes);
    const urlEquals = scalarString(step.params.urlEquals);
    const waitText = scalarString(step.params.text, scalarString(step.target?.text));
    const loadState =
      readyState === "complete"
        ? "load"
        : readyState === "interactive"
          ? "domcontentloaded"
          : readyState === "networkidle"
            ? "networkidle"
            : readyState;

    if (loadState) {
      await this.oc(["wait", "--target-id", targetId, "--timeout-ms", timeoutMs, "--load", loadState], context);
    }

    if (urlEquals || urlIncludes) {
      const deadline = Date.now() + Math.max(250, step.timeoutMs);

      while (Date.now() <= deadline) {
        const pageState = await this.getPageState(targetId, context);
        const currentUrl = scalarString(pageState.url);
        const matchesEquals = !urlEquals || currentUrl === urlEquals;
        const matchesIncludes = !urlIncludes || currentUrl.includes(urlIncludes);

        if (matchesEquals && matchesIncludes) {
          break;
        }

        await sleep(Math.min(500, Math.max(100, step.delayAfterMs || 250)));
      }

      const finalPageState = await this.getPageState(targetId, context);
      const currentUrl = scalarString(finalPageState.url);
      const matchesEquals = !urlEquals || currentUrl === urlEquals;
      const matchesIncludes = !urlIncludes || currentUrl.includes(urlIncludes);

      if (!matchesEquals || !matchesIncludes) {
        throw new Error(
          `Timed out waiting for URL condition on step ${step.order}. Expected ${JSON.stringify({ urlEquals, urlIncludes })}, got ${JSON.stringify(currentUrl)}.`
        );
      }
    }

    if (waitText) {
      await this.oc(["wait", "--target-id", targetId, "--timeout-ms", timeoutMs, "--text", waitText], context);
    }

    return await this.getPageState(targetId, context);
  }

  private async moveMouseRandomly(targetId: string, context: ExecutionContext = {}) {
    const helpers = this.buildSyntheticMouseCurveHelpers();

    return await this.evaluate(
      targetId,
      `async () => {
        ${helpers}
        return await moveSyntheticMouse(() => {
          const viewportWidth = Math.max(window.innerWidth || 0, 1);
          const viewportHeight = Math.max(window.innerHeight || 0, 1);

          return {
            x: Math.floor(Math.random() * Math.max(1, viewportWidth - 1)),
            y: Math.floor(Math.random() * Math.max(1, viewportHeight - 1)),
          };
        });
      }`,
      context
    );
  }

  private buildSyntheticMouseCurveHelpers() {
    return `
      const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
      const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
      const randomBetween = (minimum, maximum) => minimum + (Math.random() * (maximum - minimum));
      const randomInt = (minimum, maximum) => Math.round(randomBetween(minimum, maximum));
      const easeInOut = (progress) => 0.5 - (Math.cos(Math.PI * progress) / 2);
      const getBezierPoint = (startPoint, controlPoint1, controlPoint2, endPoint, progress) => {
        const inverse = 1 - progress;
        const inverseSquared = inverse * inverse;
        const inverseCubed = inverseSquared * inverse;
        const progressSquared = progress * progress;
        const progressCubed = progressSquared * progress;

        return {
          x:
            (inverseCubed * startPoint.x) +
            (3 * inverseSquared * progress * controlPoint1.x) +
            (3 * inverse * progressSquared * controlPoint2.x) +
            (progressCubed * endPoint.x),
          y:
            (inverseCubed * startPoint.y) +
            (3 * inverseSquared * progress * controlPoint1.y) +
            (3 * inverse * progressSquared * controlPoint2.y) +
            (progressCubed * endPoint.y),
        };
      };
      const dispatchPointerEvent = (element, type, eventInit) => {
        if (typeof PointerEvent === "function") {
          element.dispatchEvent(new PointerEvent(type, { pointerType: "mouse", isPrimary: true, ...eventInit }));
        }
      };
      const dispatchMouseTransition = (fromElement, toElement, eventInit) => {
        if (fromElement !== toElement) {
          dispatchPointerEvent(fromElement, "pointerout", eventInit);
          fromElement.dispatchEvent(new MouseEvent("mouseout", eventInit));
          dispatchPointerEvent(toElement, "pointerover", eventInit);
          toElement.dispatchEvent(new MouseEvent("mouseover", eventInit));
        }
      };
      const dispatchMouseMove = (element, eventInit) => {
        dispatchPointerEvent(element, "pointermove", eventInit);
        element.dispatchEvent(new MouseEvent("mousemove", eventInit));
      };
      const getStoredPoint = (viewportWidth, viewportHeight) =>
        window.__remoteControllerSyntheticMousePoint &&
        typeof window.__remoteControllerSyntheticMousePoint.x === "number" &&
        typeof window.__remoteControllerSyntheticMousePoint.y === "number"
          ? {
            x: clamp(Math.round(window.__remoteControllerSyntheticMousePoint.x), 0, Math.max(0, viewportWidth - 1)),
            y: clamp(Math.round(window.__remoteControllerSyntheticMousePoint.y), 0, Math.max(0, viewportHeight - 1)),
          }
          : {
            x: Math.floor(viewportWidth / 2),
            y: Math.floor(viewportHeight / 2),
          };
      const moveSyntheticMouse = async (resolveTargetPoint) => {
        const viewportWidth = Math.max(window.innerWidth || 0, 1);
        const viewportHeight = Math.max(window.innerHeight || 0, 1);
        const previousPoint = getStoredPoint(viewportWidth, viewportHeight);
        const targetPointCandidate = resolveTargetPoint(previousPoint);

        if (!targetPointCandidate || typeof targetPointCandidate.x !== "number" || typeof targetPointCandidate.y !== "number") {
          return {
            clientX: previousPoint.x,
            clientY: previousPoint.y,
            startX: previousPoint.x,
            startY: previousPoint.y,
            steps: 0,
            settleSteps: 0,
            moved: false,
            tagName: (document.elementFromPoint(previousPoint.x, previousPoint.y) || document.body)?.tagName?.toLowerCase?.() || "body",
          };
        }

        const targetPoint = {
          x: clamp(Math.round(targetPointCandidate.x), 0, Math.max(0, viewportWidth - 1)),
          y: clamp(Math.round(targetPointCandidate.y), 0, Math.max(0, viewportHeight - 1)),
        };
        const deltaX = targetPoint.x - previousPoint.x;
        const deltaY = targetPoint.y - previousPoint.y;
        const distance = Math.hypot(deltaX, deltaY);

        if (distance < 1) {
          window.__remoteControllerSyntheticMousePoint = targetPoint;
          const element = document.elementFromPoint(targetPoint.x, targetPoint.y) || document.body;
          return {
            clientX: targetPoint.x,
            clientY: targetPoint.y,
            startX: previousPoint.x,
            startY: previousPoint.y,
            steps: 0,
            settleSteps: 0,
            moved: false,
            tagName: element instanceof Element ? element.tagName.toLowerCase() : "body",
          };
        }

        const steps = Math.max(18, Math.min(42, Math.ceil(distance / 14)));
        const normalX = -deltaY / distance;
        const normalY = deltaX / distance;
        const curveMagnitude = randomBetween(
          Math.min(14, Math.max(6, distance * 0.08)),
          Math.min(56, Math.max(18, distance * 0.18))
        ) * (Math.random() < 0.5 ? -1 : 1);
        const controlPoint1Ratio = randomBetween(0.18, 0.3);
        const controlPoint2Ratio = randomBetween(0.7, 0.84);
        const controlPoint2CurveScale = randomBetween(0.3, 0.7);
        const controlPoint1 = {
          x: previousPoint.x + (deltaX * controlPoint1Ratio) + (normalX * curveMagnitude),
          y: previousPoint.y + (deltaY * controlPoint1Ratio) + (normalY * curveMagnitude),
        };
        const controlPoint2 = {
          x: previousPoint.x + (deltaX * controlPoint2Ratio) + (normalX * curveMagnitude * controlPoint2CurveScale),
          y: previousPoint.y + (deltaY * controlPoint2Ratio) + (normalY * curveMagnitude * controlPoint2CurveScale),
        };
        const trajectory = [];
        const settleSteps = Math.max(2, Math.min(4, Math.ceil(distance / 160) + 1));
        const settleRadiusBase = Math.max(1.25, Math.min(5, distance * 0.03));

        for (let step = 1; step <= steps; step += 1) {
          trajectory.push(getBezierPoint(previousPoint, controlPoint1, controlPoint2, targetPoint, easeInOut(step / steps)));
        }

        for (let settleStep = 0; settleStep < settleSteps; settleStep += 1) {
          const settleProgress = (settleStep + 1) / (settleSteps + 1);
          const settleRadius = settleRadiusBase * (1 - settleProgress);
          const settleDirection = settleStep % 2 === 0 ? 1 : -1;
          trajectory.push({
            x: targetPoint.x + (normalX * settleRadius * settleDirection),
            y: targetPoint.y + (normalY * settleRadius * settleDirection),
          });
        }

        trajectory.push(targetPoint);

        let previousElement = document.elementFromPoint(previousPoint.x, previousPoint.y) || document.body;

        for (const point of trajectory) {
          const clientX = clamp(Math.round(point.x), 0, Math.max(0, viewportWidth - 1));
          const clientY = clamp(Math.round(point.y), 0, Math.max(0, viewportHeight - 1));
          const nextElement = document.elementFromPoint(clientX, clientY) || document.body;
          const eventInit = {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX,
            clientY,
          };

          dispatchMouseTransition(previousElement, nextElement, eventInit);
          dispatchMouseMove(nextElement, eventInit);
          previousElement = nextElement;
          await sleep(randomInt(10, 22));
        }

        window.__remoteControllerSyntheticMousePoint = targetPoint;
        const element = document.elementFromPoint(targetPoint.x, targetPoint.y) || document.body;

        return {
          clientX: targetPoint.x,
          clientY: targetPoint.y,
          startX: previousPoint.x,
          startY: previousPoint.y,
          steps,
          settleSteps,
          moved: true,
          tagName: element instanceof Element ? element.tagName.toLowerCase() : "body",
        };
      };
    `;
  }

  private async moveMouseToResolvedRef(targetId: string, ref: string, context: ExecutionContext = {}) {
    const helpers = this.buildSyntheticMouseCurveHelpers();

    return await this.evaluateRef(
      targetId,
      ref,
      `async (el) => {
        ${helpers}
        return await moveSyntheticMouse(() => {
          if (!(el instanceof Element)) {
            return null;
          }

          const rect = el.getBoundingClientRect();
          const viewportWidth = Math.max(window.innerWidth || 0, 1);
          const viewportHeight = Math.max(window.innerHeight || 0, 1);

          if (rect.width <= 0 && rect.height <= 0) {
            return {
              x: Math.floor(viewportWidth / 2),
              y: Math.floor(viewportHeight / 2),
            };
          }

          const paddingX = Math.min(12, Math.max(2, rect.width * 0.15));
          const paddingY = Math.min(12, Math.max(2, rect.height * 0.15));
          const minX = clamp(rect.left + paddingX, 0, Math.max(0, viewportWidth - 1));
          const maxX = clamp(rect.right - paddingX, 0, Math.max(0, viewportWidth - 1));
          const minY = clamp(rect.top + paddingY, 0, Math.max(0, viewportHeight - 1));
          const maxY = clamp(rect.bottom - paddingY, 0, Math.max(0, viewportHeight - 1));

          return {
            x: minX <= maxX ? randomBetween(minX, maxX) : clamp(rect.left + (rect.width / 2), 0, Math.max(0, viewportWidth - 1)),
            y: minY <= maxY ? randomBetween(minY, maxY) : clamp(rect.top + (rect.height / 2), 0, Math.max(0, viewportHeight - 1)),
          };
        });
      }`,
      context
    );
  }

  private async scrollPageOrPostContainer(
    targetId: string,
    {
      amount,
      direction = "down",
      behavior = "auto",
    }: {
      amount?: number;
      direction?: "up" | "down";
      behavior?: "auto" | "smooth";
    } = {},
    context: ExecutionContext = {}
  ) {
    const normalizedDirection = direction === "up" ? "up" : "down";
    const normalizedBehavior = behavior === "smooth" ? "smooth" : "auto";
    const explicitAmount = Number.isFinite(amount) ? Math.abs(Number(amount)) : 0;

    const result = await this.evaluate(
      targetId,
      `() => {
        const viewportHeight = Math.max(window.innerHeight || 0, 1);
        const delta = ${JSON.stringify(explicitAmount)} > 0
          ? ${JSON.stringify(explicitAmount)}
          : Math.max(500, Math.floor(viewportHeight * 0.85));
        const direction = ${JSON.stringify(normalizedDirection)};
        const behavior = ${JSON.stringify(normalizedBehavior)};
        const directionSign = direction === "up" ? -1 : 1;
        const beforeWindowY = window.scrollY;

        window.scrollBy({
          top: directionSign * delta,
          behavior,
        });

        const afterWindowY = window.scrollY;

        if (afterWindowY !== beforeWindowY) {
          return {
            ok: true,
            action: "scroll",
            moved: true,
            usedContainer: false,
            scrollY: afterWindowY,
            containerScrollTop: null,
            delta,
            direction,
            tagName: null,
            ariaLabel: null,
          };
        }

        const articleSelector = "article, [role='article']";
        const candidateMap = new Map();
        const addCandidate = (element) => {
          if (!(element instanceof HTMLElement) || candidateMap.has(element)) {
            return;
          }

          candidateMap.set(element, true);
        };

        addCandidate(document.querySelector("main"));
        addCandidate(document.querySelector("[role='main']"));

        const articleNodes = Array.from(document.querySelectorAll(articleSelector)).slice(0, 12);

        for (const node of articleNodes) {
          let current = node instanceof HTMLElement ? node : null;
          let depth = 0;

          while (current && depth < 10) {
            addCandidate(current);
            current = current.parentElement;
            depth += 1;
          }
        }

        let bestElement = null;
        let bestScore = Number.NEGATIVE_INFINITY;

        for (const element of candidateMap.keys()) {
          const rect = element.getBoundingClientRect();
          const visibleHeight = Math.max(
            0,
            Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0)
          );
          const scrollRange = Math.max(0, element.scrollHeight - element.clientHeight);

          if (visibleHeight <= 0 || scrollRange < 40) {
            continue;
          }

          const overflowY = window.getComputedStyle(element).overflowY.toLowerCase();
          const overflowScrollable = overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
          const articleCount = element.querySelectorAll(articleSelector).length;
          const signalText = [
            element.getAttribute("aria-label") || "",
            element.getAttribute("data-view-name") || "",
            element.id || "",
            typeof element.className === "string" ? element.className : "",
          ]
            .join(" ")
            .toLowerCase();
          const score =
            Math.min(scrollRange, 4000) +
            visibleHeight +
            (overflowScrollable ? 500 : 0) +
            Math.min(articleCount, 5) * 250 +
            (element.matches("main, [role='main']") ? 150 : 0) +
            (/activity|posts|feed/.test(signalText) ? 120 : 0);

          if (score > bestScore) {
            bestScore = score;
            bestElement = element;
          }
        }

        if (bestElement instanceof HTMLElement) {
          const beforeContainerTop = bestElement.scrollTop;
          bestElement.scrollBy({
            top: directionSign * delta,
            behavior,
          });
          const afterContainerTop = bestElement.scrollTop;

          if (afterContainerTop !== beforeContainerTop) {
            return {
              ok: true,
              action: "scroll",
              moved: true,
              usedContainer: true,
              scrollY: afterWindowY,
              containerScrollTop: afterContainerTop,
              delta,
              direction,
              tagName: bestElement.tagName.toLowerCase(),
              ariaLabel: bestElement.getAttribute("aria-label"),
            };
          }
        }

        return {
          ok: true,
          action: "scroll",
          moved: false,
          usedContainer: false,
          scrollY: afterWindowY,
          containerScrollTop: null,
          delta,
          direction,
          tagName: null,
          ariaLabel: null,
        };
      }`,
      context
    );

    return (typeof result === "object" && result !== null
      ? result
      : {
        ok: true,
        action: "scroll",
        moved: false,
        usedContainer: false,
        scrollY: 0,
        containerScrollTop: null,
        delta: explicitAmount,
        direction: normalizedDirection,
        tagName: null,
        ariaLabel: null,
      }) as {
        ok?: boolean;
        action?: string;
        moved?: boolean;
        usedContainer?: boolean;
        scrollY?: number;
        containerScrollTop?: number | null;
        delta?: number;
        direction?: string;
        tagName?: string | null;
        ariaLabel?: string | null;
      };
  }

  private async performWaitStep(targetId: string, step: ScriptStep, context: ExecutionContext = {}) {
    const explicitDurationMs = scalarNumber(step.params.durationMs, Number.NaN);
    const fallbackWaitMs = Number.isFinite(explicitDurationMs)
      ? explicitDurationMs
      : step.timeoutMs;
    const minDelayMs = scalarNumber(
      step.params.minDelayMs,
      fallbackWaitMs
    );
    const maxDelayMs = scalarNumber(step.params.maxDelayMs, fallbackWaitMs);
    const waitMs = Math.max(0, randomInteger(minDelayMs, maxDelayMs));
    const moveMouse = scalarBoolean(step.params.moveMouse, false);
    const moveCount = moveMouse
      ? boundedPositiveInteger(
        step.params.moveMouseCount,
        Math.max(1, Math.round(waitMs / 3000))
      )
      : 0;

    if (!moveMouse || waitMs === 0) {
      await sleep(waitMs);
      return { ok: true, action: step.kind, waitMs, moveMouse: false, moveCount: 0 };
    }

    const segments = Math.max(1, moveCount);
    const segmentDurationMs = Math.floor(waitMs / segments);

    for (let index = 0; index < segments; index += 1) {
      await this.moveMouseRandomly(targetId, context);

      const remainingMs = waitMs - segmentDurationMs * index;
      const pauseMs = index === segments - 1 ? remainingMs : segmentDurationMs;
      if (pauseMs > 0) {
        await sleep(pauseMs);
      }
    }

    return { ok: true, action: step.kind, waitMs, moveMouse: true, moveCount: segments };
  }

  private async performNavigateStep(targetId: string, step: ScriptStep, context: ExecutionContext = {}) {
    const url = scalarString(step.params.url, scalarString(step.target?.text));

    if (!url) {
      throw new Error(`Step ${step.order} is missing params.url for navigation.`);
    }

    await this.oc(["navigate", url, "--target-id", targetId], context);

    return {
      ok: true,
      action: step.kind,
      url,
    };
  }

  private async assertDocumentVisible(targetId: string, step: ScriptStep, context: ExecutionContext = {}) {
    const pageState = await this.getPageState(targetId, context);
    const waitText = scalarString(step.params.text, scalarString(step.target?.text, scalarString(step.target?.description)));

    if (waitText) {
      const needle = normalizeSearchText(waitText);
      const currentSignal = normalizeSearchText(
        [pageState.title, pageState.url].filter(Boolean).join(" ")
      );

      if (!currentSignal.includes(needle)) {
        const snapshot = await this.getSnapshot(targetId, context);
        const snapshotSignal = normalizeSearchText(
          [snapshot.url, snapshot.snapshot].filter(Boolean).join(" ")
        );

        if (!snapshotSignal.includes(needle)) {
          throw new Error(`Target document signal not found for step ${step.order}.`);
        }
      }
    }

    return {
      ok: true,
      action: step.kind,
      matched: {
        role: "document",
        title: pageState.title,
        url: pageState.url,
      },
    };
  }

  private async performScrollStep(targetId: string, step: ScriptStep, context: ExecutionContext = {}) {
    if (step.target && (step.target.text || step.target.role)) {
      const resolved = await this.resolveSnapshotRef(targetId, step, context);
      await this.oc([
        "scrollintoview",
        resolved.ref,
        "--target-id",
        targetId,
        "--timeout-ms",
        String(step.timeoutMs),
      ], context);

      return {
        ok: true,
        action: step.kind,
        matched: resolved,
      };
    }

    const amount = Number(step.params.amount ?? step.params.pixels ?? 600);
    const direction = String(step.params.direction ?? "down").toLowerCase();
    const behavior = String(step.params.behavior ?? "auto") === "smooth" ? "smooth" : "auto";

    return await this.scrollPageOrPostContainer(
      targetId,
      {
        amount,
        direction: direction === "up" ? "up" : "down",
        behavior,
      },
      context
    );
  }

  private async extractText(targetId: string, step: ScriptStep, context: ExecutionContext = {}) {
    const resolved = await this.resolveSnapshotRef(targetId, step, context);
    const format = String(step.params.format ?? "text");
    const expression =
      format === "html"
        ? `(el) => ({ data: el?.innerHTML ?? null })`
        : format === "value"
          ? `(el) => ({ data: el && typeof el === "object" && "value" in el ? el.value : null })`
          : `(el) => ({ data: (el?.innerText ?? el?.textContent ?? "").replace(/\\s+/g, " ").trim() })`;
    const result = await this.evaluateRef(targetId, resolved.ref, expression, context);

    return {
      ok: true,
      action: step.kind,
      matched: resolved,
      ...(typeof result === "object" && result !== null ? result : { data: result }),
    };
  }

  private async getElementPressedState(
    targetId: string,
    ref: string,
    activeStateTexts: string[] = [],
    context: ExecutionContext = {}
  ) {
    const activeStateTextsLiteral = JSON.stringify(activeStateTexts);
    const result = await this.evaluateRef(
      targetId,
      ref,
      `(el) => {
        const activeStateTexts = ${activeStateTextsLiteral};
        const ariaPressed = el?.getAttribute?.("aria-pressed");
        const dataState = el?.getAttribute?.("data-state");
        const title = typeof el?.getAttribute === "function" ? el.getAttribute("title") : null;
        const ariaLabel = typeof el?.getAttribute === "function" ? el.getAttribute("aria-label") : null;
        const textContent = (el?.innerText ?? el?.textContent ?? "").replace(/\s+/g, " ").trim();
        const normalizedSignals = [ariaPressed, dataState, title, ariaLabel, textContent]
          .filter((value) => typeof value === "string" && value.trim().length > 0)
          .join(" ")
          .toLowerCase();

        const activeStateMatch = activeStateTexts.some((entry) => {
          const normalizedEntry = String(entry ?? "").trim().toLowerCase();
          return normalizedEntry.length > 0 && normalizedSignals.includes(normalizedEntry);
        });

        const pressed =
          ariaPressed === "true" ||
          dataState === "pressed" ||
          activeStateMatch ||
          /\bpressed\b|\bliked\b|\bunlike\b/.test(normalizedSignals);

        return {
          pressed,
          ariaPressed: ariaPressed ?? null,
          dataState: dataState ?? null,
          title: title ?? null,
          ariaLabel: ariaLabel ?? null,
          textContent,
        };
      }`,
      context
    );

    return (typeof result === "object" && result !== null ? result : { pressed: false }) as {
      pressed?: boolean;
      ariaPressed?: string | null;
      dataState?: string | null;
      title?: string | null;
      ariaLabel?: string | null;
      textContent?: string;
    };
  }

  private async verifyElementPressedStateAfterClick(
    targetId: string,
    ref: string,
    activeStateTexts: string[] = [],
    context: ExecutionContext = {}
  ) {
    const attempts = 3;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) {
        await sleep(250);
      }

      try {
        const state = await this.getElementPressedState(targetId, ref, activeStateTexts, context);

        if (state.pressed) {
          return {
            verified: true,
            state,
            attempts: attempt + 1,
          };
        }

        if (attempt === attempts - 1) {
          return {
            verified: false,
            state,
            attempts: attempt + 1,
          };
        }
      } catch (error) {
        if (attempt === attempts - 1) {
          return {
            verified: false,
            state: null,
            attempts: attempt + 1,
            error: serializeUnknownError(error),
          };
        }
      }
    }

    return {
      verified: false,
      state: null,
      attempts,
    };
  }

  private buildCustomFunctionSource(step: ScriptStep, usesRef: boolean) {
    const expression = scalarString(step.params.expression, "return null;").trim();

    if (
      expression.startsWith("(") ||
      expression.startsWith("async (") ||
      expression.startsWith("function") ||
      expression.includes("=>")
    ) {
      return expression;
    }

    const paramsLiteral = JSON.stringify(step.params);
    return usesRef
      ? `(el) => { const element = el; const params = ${paramsLiteral}; ${expression} }`
      : `() => { const params = ${paramsLiteral}; ${expression} }`;
  }

  private async runStepWithOpenClaw(targetId: string, step: ScriptStep, context: ExecutionContext = {}) {
    if (step.kind === "assert_visible" && step.target?.role === "document") {
      return await this.assertDocumentVisible(targetId, step, context);
    }

    if (step.kind === "press_key") {
      const key = scalarString(step.params.key, scalarString(step.target?.text, "Enter"));
      await this.oc(["press", key, "--target-id", targetId], context);
      return { ok: true, action: step.kind, key };
    }

    if (step.kind === "move_mouse") {
      if (step.target && (step.target.text || step.target.role)) {
        const resolved = await this.resolveSnapshotRef(targetId, step, context);
        const movement = await this.moveMouseToResolvedRef(targetId, resolved.ref, context);
        return { ok: true, action: step.kind, matched: resolved, movement };
      }

      return await this.moveMouseRandomly(targetId, context);
    }

    if (step.kind === "hover") {
      const resolved = await this.resolveSnapshotRef(targetId, step, context);
      const movement = await this.moveMouseToResolvedRef(targetId, resolved.ref, context);
      return { ok: true, action: step.kind, matched: resolved, movement };
    }

    if (step.kind === "scroll") {
      return await this.performScrollStep(targetId, step, context);
    }

    if (step.kind === "type") {
      const resolved = await this.resolveSnapshotRef(targetId, step, context);
      const text = scalarString(step.params.text, scalarString(step.params.value, scalarString(step.target?.text)));

      if (!text) {
        throw new Error(`Step ${step.order} is missing text to type.`);
      }

      const args = ["type", resolved.ref, text, "--target-id", targetId];

      if (scalarBoolean(step.params.slowly, false)) {
        args.push("--slowly");
      }

      if (scalarBoolean(step.params.submit, false)) {
        args.push("--submit");
      }

      await this.oc(args, context);
      return { ok: true, action: step.kind, matched: resolved, typedLength: text.length };
    }

    if (step.kind === "click") {
      const profileCardStep = isProfileCardStep(step);
      const sourcePageState = profileCardStep ? await this.getPageState(targetId, context) : null;
      const resolved = await this.resolveSnapshotRef(targetId, step, context);
      const skipIfPressed = scalarBoolean(step.params.skipIfPressed, false);
      const activeStateTexts = scalarStringArray(step.params.activeStateTexts);
      const shouldVerifyPressedAfterClick = skipIfPressed || activeStateTexts.length > 0;

      if (skipIfPressed) {
        const pressedState = await this.getElementPressedState(
          targetId,
          resolved.ref,
          activeStateTexts,
          context
        );

        if (pressedState.pressed) {
          return {
            ok: true,
            action: step.kind,
            matched: resolved,
            skipped: true,
            reason: "already_pressed",
            state: pressedState,
          };
        }
      }

      const args = ["click", resolved.ref, "--target-id", targetId];
      const button = scalarString(step.params.button);

      if (button === "left" || button === "right" || button === "middle") {
        args.push("--button", button);
      }

      if (scalarBoolean(step.params.double, false)) {
        args.push("--double");
      }

      await this.oc(args, context);

      if (profileCardStep && sourcePageState?.url) {
        this.getRuntimeState(context).profileCardSelection = {
          step: cloneScriptStep(step),
          currentIndex: this.getCandidateIndex(step),
          sourcePageUrl: scalarString(sourcePageState.url),
        };
      }

      if (shouldVerifyPressedAfterClick) {
        const verification = await this.verifyElementPressedStateAfterClick(
          targetId,
          resolved.ref,
          activeStateTexts,
          context
        );

        return {
          ok: true,
          action: step.kind,
          matched: resolved,
          verification,
        };
      }

      return { ok: true, action: step.kind, matched: resolved };
    }

    if (step.kind === "skip_if_profile_recently_visited") {
      return await this.skipIfProfileRecentlyVisited(targetId, step, context);
    }

    if (step.kind === "branch_if_missing") {
      const onMissing = scalarString(step.params.onMissing);

      try {
        const resolved = await this.resolveSnapshotRef(targetId, step, context);

        return {
          ok: true,
          action: step.kind,
          branchAction: null,
          conditionMet: false,
          matched: resolved,
        } satisfies BranchStepResult;
      } catch (error) {
        if (!(error instanceof SnapshotRefNotFoundError)) {
          throw error;
        }

        return {
          ok: true,
          action: step.kind,
          branchAction: onMissing === "end_script" ? "end_script" : null,
          conditionMet: true,
          reason: onMissing === "end_script"
            ? `Target was missing for branch step ${step.order}.`
            : undefined,
        } satisfies BranchStepResult;
      }
    }

    if (step.kind === "branch_if_visible") {
      const onVisible = scalarString(step.params.onVisible, "alert");

      try {
        const resolved = await this.resolveSnapshotRef(targetId, step, context);

        return {
          ok: true,
          action: step.kind,
          branchAction:
            onVisible === "alert" || onVisible === "end_script"
              ? onVisible
              : null,
          conditionMet: true,
          reason:
            onVisible === "end_script"
              ? `Target became visible for branch step ${step.order}.`
              : undefined,
          matched: resolved,
        } satisfies BranchStepResult;
      } catch (error) {
        if (!(error instanceof SnapshotRefNotFoundError)) {
          throw error;
        }

        return {
          ok: true,
          action: step.kind,
          branchAction: null,
          conditionMet: false,
        } satisfies BranchStepResult;
      }
    }

    if (step.kind === "assert_visible") {
      const resolved = await this.resolveSnapshotRef(targetId, step, context);
      return { ok: true, action: step.kind, matched: resolved };
    }

    if (step.kind === "extract_text") {
      return await this.extractText(targetId, step, context);
    }

    if (step.kind === "custom") {
      const hasTarget = Boolean(step.target && (step.target.text || step.target.role));

      if (hasTarget) {
        const resolved = await this.resolveSnapshotRef(targetId, step, context);
        const result = await this.evaluateRef(
          targetId,
          resolved.ref,
          this.buildCustomFunctionSource(step, true),
          context
        );

        return { ok: true, action: step.kind, matched: resolved, data: result };
      }

      const result = await this.evaluate(
        targetId,
        this.buildCustomFunctionSource(step, false),
        context
      );

      return { ok: true, action: step.kind, data: result };
    }

    throw new Error(`Unsupported action: ${step.kind}`);
  }

  private async runStep(targetId: string, step: ScriptStep, context: ExecutionContext = {}) {
    const startedAt = Date.now();
    let output: unknown;

    if (step.kind === "wait_for_page") {
      output = await this.waitForPage(targetId, step, context);
    } else if (step.kind === "wait") {
      output = await this.performWaitStep(targetId, step, context);
    } else if (step.kind === "navigate") {
      output = await this.performNavigateStep(targetId, step, context);
    } else {
      output = await this.runStepWithOpenClaw(targetId, step, context);
      if (
        typeof output === "object" &&
        output !== null &&
        "ok" in output &&
        (output as { ok: boolean }).ok === false
      ) {
        throw new Error(
          (output as { error?: string }).error || `Step ${step.order} failed.`
        );
      }
    }

    const durationMs = Date.now() - startedAt;

    return {
      order: step.order,
      kind: step.kind,
      instruction: step.instruction,
      durationMs,
      resolution: extractStepResolution(output),
      output,
    } satisfies StepExecutionRecord;
  }

  private async runScript(script: ScriptInstructions, options: ExecuteScriptOptions = {}) {
    const { targetId, taskId, engineMode = "deterministic", profileVisitLookupUrlTemplate } = options;
    const engineStats: ExecutionEngineStats = {
      aiSelections: 0,
      deterministicSelections: 0,
      aiFallbacks: 0,
      aiErrors: 0,
    };
    const runtimeState: RuntimeState = {
      visitedProfiles: new Map<string, VisitedProfileRecord>(),
      profileCardSelection: null,
    };
    initializeTaskLog(taskId, {
      taskId: taskId ?? null,
      receivedAt: new Date().toISOString(),
      targetId: targetId ?? null,
      engineMode,
      summary: script.summary,
      stepCount: script.steps.length,
      script,
    });

    const activeTargetId = targetId || (await this.getFocusedTab({ taskId })).id;
    const startedAt = new Date().toISOString();
    const stepResults: StepExecutionRecord[] = [];
    let endedEarly = false;
    let alert: AlertStopResult | null = null;
    let earlyExit: EarlyExitResult | null = null;

    for (const step of [...script.steps].sort((left, right) => left.order - right.order)) {
      try {
        const stepResult = await this.runStep(activeTargetId, step, {
          taskId,
          engineMode,
          engineStats,
          profileVisitLookupUrlTemplate,
          runtimeState,
        });
        stepResults.push(stepResult);

        const branchAction =
          typeof stepResult.output === "object" &&
            stepResult.output !== null &&
            "branchAction" in stepResult.output
            ? scalarString((stepResult.output as { branchAction?: unknown }).branchAction)
            : "";

        if (branchAction === "alert") {
          alert = {
            detected: true,
            reason:
              scalarString(step.target?.description).trim() ||
              scalarString(step.target?.text).trim() ||
              "Alert condition detected.",
            stepOrder: step.order,
            stepKind: step.kind,
            instruction: step.instruction,
          };
          appendTaskLog(taskId, `TASK_ALERT ${JSON.stringify({
            taskId: taskId ?? null,
            alertedAt: new Date().toISOString(),
            step: {
              order: step.order,
              kind: step.kind,
              instruction: step.instruction,
            },
            reason: alert.reason,
          })}`);
          break;
        }

        if (branchAction === "end_script") {
          endedEarly = true;
          const reason =
            typeof stepResult.output === "object" &&
              stepResult.output !== null &&
              "reason" in stepResult.output
              ? scalarString((stepResult.output as { reason?: unknown }).reason).trim()
              : "";
          earlyExit = {
            detected: true,
            reason: reason || "Branch condition ended the script early.",
            stepOrder: step.order,
            stepKind: step.kind,
            instruction: step.instruction,
          };
          appendTaskLog(taskId, `TASK_BRANCH_END ${JSON.stringify({
            taskId: taskId ?? null,
            endedAt: new Date().toISOString(),
            step: {
              order: step.order,
              kind: step.kind,
              instruction: step.instruction,
            },
            reason: earlyExit.reason,
          })}`);
          break;
        }

        const delayMs = Math.max(0, step.delayAfterMs || script.defaultDelayMs || 0);

        if (delayMs > 0) {
          await sleep(delayMs);
        }
      } catch (error) {
        appendTaskLog(taskId, `TASK_ERROR ${JSON.stringify({
          taskId: taskId ?? null,
          failedAt: new Date().toISOString(),
          step: {
            order: step.order,
            kind: step.kind,
            instruction: step.instruction,
          },
          error: serializeUnknownError(error),
        })}`);

        throw new StepExecutionError(step, error);
      }
    }

    const result = {
      engine: {
        requestedMode: engineMode,
        resolver:
          engineMode === "ai_driven"
            ? engineStats.aiSelections > 0
              ? "ai_driven"
              : "deterministic_fallback"
            : "deterministic",
        aiSelections: engineStats.aiSelections,
        deterministicSelections: engineStats.deterministicSelections,
        aiFallbacks: engineStats.aiFallbacks,
        aiErrors: engineStats.aiErrors,
      },
      summary: script.summary,
      targetId: activeTargetId,
      startedAt,
      finishedAt: new Date().toISOString(),
      endedEarly,
      earlyExit,
      alerted: Boolean(alert),
      alert,
      visitedProfiles: [...runtimeState.visitedProfiles.values()],
      currentPage: await this.getPageState(activeTargetId, { taskId, engineMode, engineStats }),
      steps: stepResults,
    };

    appendTaskLog(taskId, `TASK_RESULT ${JSON.stringify(result)}`);
    return result;
  }
}