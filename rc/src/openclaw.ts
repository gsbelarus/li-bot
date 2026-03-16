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
}

interface ExecuteScriptOptions extends ExecutionContext {
  engineMode?: ExecutionEngineMode;
  targetId?: string;
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
  action: "branch_if_missing";
  branchAction: "end_script" | null;
  conditionMet: boolean;
  matched?: ResolvedSnapshotRef;
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
  private readonly browserProfile = process.env.OPENCLAW_BROWSER_PROFILE || "chrome";
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
    const fullArgs = ["browser", "--browser-profile", this.browserProfile];

    if (this.gatewayUrl) {
      fullArgs.push("--url", this.gatewayUrl);
    }

    if (this.gatewayToken) {
      fullArgs.push("--token", this.gatewayToken);
    }

    fullArgs.push(...args);

    if (json) {
      fullArgs.push("--json");
    }

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

    const active = list.find((entry) => entry?.focused || entry?.active || entry?.selected) || list[0];
    const id = active?.targetId || active?.id;

    if (!id) {
      throw new Error("Could not determine targetId from OpenClaw tabs output.");
    }

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
    let previousScrollY = Number.NaN;

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
        const pageState = await this.getPageState(targetId, context);
        const currentScrollY = scalarNumber(pageState.scrollY, Number.NaN);
        const nextScroll = await this.evaluate(
          targetId,
          `() => {
            const viewportHeight = Math.max(window.innerHeight || 0, 1);
            const delta = Math.max(500, Math.floor(viewportHeight * 0.85));
            window.scrollBy({ top: delta, behavior: "auto" });
            return { scrollY: window.scrollY, delta };
          }`,
          context
        ) as { scrollY?: number; delta?: number };

        const nextScrollY = scalarNumber(nextScroll?.scrollY, currentScrollY);

        if (Number.isFinite(previousScrollY) && nextScrollY <= previousScrollY) {
          break;
        }

        previousScrollY = nextScrollY;
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
    let previousScrollY = Number.NaN;

    while (Date.now() <= deadline) {
      const snapshot = await this.getSnapshot(targetId, context);
      const candidates = this.buildAiResolutionCandidates(snapshot, step);
      const resolved = await this.selectSnapshotRefWithAi(step, snapshot, candidates, context);

      if (resolved) {
        return resolved;
      }

      if (shouldAutoScrollSearch(step)) {
        const pageState = await this.getPageState(targetId, context);
        const currentScrollY = scalarNumber(pageState.scrollY, Number.NaN);
        const nextScroll = await this.evaluate(
          targetId,
          `() => {
            const viewportHeight = Math.max(window.innerHeight || 0, 1);
            const delta = Math.max(500, Math.floor(viewportHeight * 0.85));
            window.scrollBy({ top: delta, behavior: "auto" });
            return { scrollY: window.scrollY, delta };
          }`,
          context
        ) as { scrollY?: number; delta?: number };

        const nextScrollY = scalarNumber(nextScroll?.scrollY, currentScrollY);

        if (Number.isFinite(previousScrollY) && nextScrollY <= previousScrollY) {
          break;
        }

        previousScrollY = nextScrollY;
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
    return await this.evaluate(
      targetId,
      `() => {
        const viewportWidth = Math.max(window.innerWidth || 0, 1);
        const viewportHeight = Math.max(window.innerHeight || 0, 1);
        const clientX = Math.floor(Math.random() * Math.max(1, viewportWidth - 1));
        const clientY = Math.floor(Math.random() * Math.max(1, viewportHeight - 1));
        const element = document.elementFromPoint(clientX, clientY) || document.body;
        const eventInit = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX,
          clientY,
        };

        element.dispatchEvent(new MouseEvent("mouseover", eventInit));
        element.dispatchEvent(new MouseEvent("mousemove", eventInit));

        return {
          clientX,
          clientY,
          tagName: element instanceof Element ? element.tagName.toLowerCase() : "body",
        };
      }`,
      context
    );
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

    return await this.evaluate(
      targetId,
      `() => {
        window.scrollBy({
          top: ${direction === "up" ? -1 : 1} * Math.abs(${JSON.stringify(amount)}),
          behavior: ${JSON.stringify(behavior)}
        });
        return { ok: true, action: "scroll", scrollY: window.scrollY };
      }`,
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
        await this.oc(["hover", resolved.ref, "--target-id", targetId], context);
        return { ok: true, action: step.kind, matched: resolved };
      }

      return await this.moveMouseRandomly(targetId, context);
    }

    if (step.kind === "hover") {
      const resolved = await this.resolveSnapshotRef(targetId, step, context);
      await this.oc(["hover", resolved.ref, "--target-id", targetId], context);
      return { ok: true, action: step.kind, matched: resolved };
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
    const { targetId, taskId, engineMode = "deterministic" } = options;
    const engineStats: ExecutionEngineStats = {
      aiSelections: 0,
      deterministicSelections: 0,
      aiFallbacks: 0,
      aiErrors: 0,
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

    for (const step of [...script.steps].sort((left, right) => left.order - right.order)) {
      try {
        const stepResult = await this.runStep(activeTargetId, step, {
          taskId,
          engineMode,
          engineStats,
        });
        stepResults.push(stepResult);

        const branchAction =
          typeof stepResult.output === "object" &&
            stepResult.output !== null &&
            "branchAction" in stepResult.output
            ? scalarString((stepResult.output as { branchAction?: unknown }).branchAction)
            : "";

        if (branchAction === "end_script") {
          endedEarly = true;
          appendTaskLog(taskId, `TASK_BRANCH_END ${JSON.stringify({
            taskId: taskId ?? null,
            endedAt: new Date().toISOString(),
            step: {
              order: step.order,
              kind: step.kind,
              instruction: step.instruction,
            },
            reason: "target_missing",
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
      currentPage: await this.getPageState(activeTargetId, { taskId, engineMode, engineStats }),
      steps: stepResults,
    };

    appendTaskLog(taskId, `TASK_RESULT ${JSON.stringify(result)}`);
    return result;
  }
}