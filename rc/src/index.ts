import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import express, { type NextFunction, type Request, type Response } from "express";
import dotenv from "dotenv";

import { log, serializeError } from "./logger.js";
import { OpenClawRuntime } from "./openclaw.js";
import { validateExecuteScriptCommandPayload } from "./script-contract.js";
import { TaskQueue, type TaskRecord } from "./task-queue.js";

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirectory = dirname(currentFilePath);
const projectRoot = resolve(currentDirectory, "..");
const taskLogsDirectory = resolve(projectRoot, "logs");

dotenv.config({ path: resolve(projectRoot, ".env") });
dotenv.config({ path: resolve(projectRoot, ".env.local"), override: true });

console.log(
  `[rc] OPENAI_API_KEY=${process.env.OPENAI_API_KEY ? "set" : "not set"}; OPENAI_PROJECT_KEY=${process.env.OPENAI_PROJECT_KEY ? "set" : "not set"}`
);

const port = Number(process.env.PORT || 3100);
const remoteControllerSecretKey = process.env.REMOTE_CONTROLLER_SECRET_KEY || "";
const controllerVersion = process.env.npm_package_version || "0.1.0";
const maxRetainedTasks = Number(process.env.REMOTE_CONTROLLER_MAX_RETAINED_TASKS || 200);
const finishedTaskTtlMs = Number(process.env.REMOTE_CONTROLLER_FINISHED_TASK_TTL_MS || 6 * 60 * 60 * 1000);
const taskCleanupIntervalMs = Number(process.env.REMOTE_CONTROLLER_TASK_CLEANUP_INTERVAL_MS || 5 * 60 * 1000);
const resultLogChunkSize = Math.max(200, Number(process.env.REMOTE_CONTROLLER_RESULT_LOG_CHUNK_SIZE || 600));
const resultLogMaxChars = Math.max(resultLogChunkSize, Number(process.env.REMOTE_CONTROLLER_RESULT_LOG_MAX_CHARS || 120_000));

if (!remoteControllerSecretKey) {
  throw new Error("REMOTE_CONTROLLER_SECRET_KEY must be configured.");
}

const runtime = new OpenClawRuntime();

function buildCompletedTaskResultPayload(task: TaskRecord) {
  if (task.status === "failed") {
    return {
      taskId: task.id,
      status: task.status,
      error: task.failure ?? task.error,
      result: task.result,
      taskLog: buildTaskLogPayload(task.id),
    };
  }

  return {
    taskId: task.id,
    status: task.status,
    result: task.result,
    taskLog: buildTaskLogPayload(task.id),
  };
}

function resolveTaskResultWebhookUrl(task: TaskRecord) {
  const template = task.input.callback?.taskResultWebhookUrlTemplate?.trim() || "";

  if (!template) {
    return "";
  }

  return template.replace("{taskId}", encodeURIComponent(task.id));
}

async function publishTaskResultToWebhook(task: TaskRecord) {
  const webhookUrl = resolveTaskResultWebhookUrl(task);

  if (!webhookUrl || (task.status !== "completed" && task.status !== "failed")) {
    return;
  }

  const payload = buildCompletedTaskResultPayload(task);

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-remote-controller-secret-key": remoteControllerSecretKey,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Webhook responded with HTTP ${response.status}.`);
    }

    log("info", "task.result_webhook.delivered", {
      taskId: task.id,
      status: task.status,
      webhookUrl,
    });
  } catch (error) {
    log("warn", "task.result_webhook.failed", {
      taskId: task.id,
      status: task.status,
      webhookUrl,
      error: serializeError(error),
    });
  }
}

const queue = new TaskQueue(async (task) => {
  return runtime.executeScript(task.input.script, {
    engineMode: task.input.engineMode,
    targetId: task.input.targetId,
    taskId: task.id,
  });
}, {
  maxRetainedTasks,
  finishedTaskTtlMs,
  cleanupIntervalMs: taskCleanupIntervalMs,
  onTaskFinished: publishTaskResultToWebhook,
});

class RequestValidationError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "RequestValidationError";
  }
}

function isJsonParseError(error: unknown): error is SyntaxError & { status: number } {
  return (
    error instanceof SyntaxError &&
    typeof (error as { status?: unknown }).status === "number" &&
    (error as { status?: number }).status === 400
  );
}

function getProvidedSecret(request: Request) {
  const headerSecret = request.header("x-remote-controller-secret-key")?.trim();

  if (headerSecret) {
    return headerSecret;
  }

  const authorization = request.header("authorization")?.trim() || "";

  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }

  return "";
}

function buildTaskLogPayload(taskId: string) {
  const logPath = resolve(taskLogsDirectory, `${taskId}.log`);
  const unavailablePayload = {
    available: false,
    path: `logs/${taskId}.log`,
    chunkSize: resultLogChunkSize,
    chunkCount: 0,
    totalChars: 0,
    truncated: false,
    chunks: {},
  };

  if (!existsSync(logPath)) {
    return unavailablePayload;
  }

  try {
    const fullText = readFileSync(logPath, "utf8");
    const truncated = fullText.length > resultLogMaxChars;
    const text = truncated ? fullText.slice(0, resultLogMaxChars) : fullText;
    const chunks: Record<string, string> = {};

    for (let index = 0; index < text.length; index += resultLogChunkSize) {
      const chunkNumber = Math.floor(index / resultLogChunkSize) + 1;
      chunks[String(chunkNumber)] = text.slice(index, index + resultLogChunkSize);
    }

    return {
      available: true,
      path: `logs/${taskId}.log`,
      chunkSize: resultLogChunkSize,
      chunkCount: Object.keys(chunks).length,
      totalChars: fullText.length,
      truncated,
      chunks,
    };
  } catch (error) {
    log("warn", "task.log.read_failed", {
      taskId,
      logPath,
      error: serializeError(error),
    });

    return {
      ...unavailablePayload,
      error: "Task log could not be read.",
    };
  }
}

const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.use((request, response, next) => {
  const startedAt = Date.now();

  response.on("finish", () => {
    log("info", "http.request", {
      method: request.method,
      path: request.originalUrl,
      statusCode: response.statusCode,
      durationMs: Date.now() - startedAt,
      remoteAddress: request.ip,
    });
  });

  next();
});

app.use((request, response, next) => {
  const providedSecret = getProvidedSecret(request);

  if (!providedSecret || providedSecret !== remoteControllerSecretKey) {
    log("warn", "auth.rejected", {
      method: request.method,
      path: request.originalUrl,
      hasSecret: Boolean(providedSecret),
    });

    response.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
});

app.get("/", (_request, response) => {
  response.json({
    status: "ok",
    controller: {
      name: "remote-controller",
      version: controllerVersion,
    },
    queue: queue.getStats(),
  });
});

app.get("/health", (_request, response) => {
  response.json({
    status: "ok",
    version: controllerVersion,
    queue: queue.getStats(),
  });
});

app.post("/api/commands", (request, response, next) => {
  try {
    const payload = validateExecuteScriptCommandPayload(request.body);
    const task = queue.enqueue(payload);

    log("info", "command.enqueued", {
      taskId: task.id,
      command: payload.command,
      stepCount: payload.script.steps.length,
    });

    response.status(202).json({
      taskId: task.id,
      status: task.status,
      command: task.command,
      createdAt: task.createdAt,
    });
  } catch (error) {
    if (error instanceof Error) {
      next(new RequestValidationError(error.message));
      return;
    }

    next(error);
  }
});

app.get("/api/commands/:taskId/status", (request, response) => {
  const task = queue.get(request.params.taskId);

  if (!task) {
    response.status(404).json({ error: "Task not found." });
    return;
  }

  response.json({
    taskId: task.id,
    command: task.command,
    status: task.status,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    error: task.failure ?? task.error,
  });
});

app.get("/api/commands/:taskId/results", (request, response) => {
  const task = queue.get(request.params.taskId);

  if (!task) {
    response.status(404).json({ error: "Task not found." });
    return;
  }

  if (task.status === "pending" || task.status === "in_progress") {
    response.status(202).json({
      taskId: task.id,
      status: task.status,
      message: "Results are not available yet.",
    });
    return;
  }

  if (task.status === "failed") {
    response.status(200).json(buildCompletedTaskResultPayload(task));
    return;
  }

  response.json(buildCompletedTaskResultPayload(task));
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  log("error", "request.failed", serializeError(error));

  if (error instanceof RequestValidationError) {
    response.status(error.statusCode).json({
      error: error.message,
    });
    return;
  }

  if (isJsonParseError(error)) {
    response.status(400).json({
      error: "Request body must contain valid JSON.",
    });
    return;
  }

  response.status(500).json({
    error: "Internal server error",
  });
});

app.listen(port, () => {
  log("info", "server.started", {
    port,
    version: controllerVersion,
  });
});