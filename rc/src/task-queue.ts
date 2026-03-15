import { randomUUID } from "node:crypto";

import type { ExecuteScriptCommandPayload } from "./script-contract.js";

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed";

export interface TaskRecord {
  id: string;
  command: ExecuteScriptCommandPayload["command"];
  status: TaskStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  result: unknown;
  error: string | null;
  input: ExecuteScriptCommandPayload;
}

interface TaskQueueOptions {
  maxRetainedTasks?: number;
  finishedTaskTtlMs?: number;
  cleanupIntervalMs?: number;
}

function parseIsoTime(value: string | null) {
  if (!value) {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isFinishedTask(task: TaskRecord) {
  return task.status === "completed" || task.status === "failed";
}

export class TaskQueue {
  private readonly tasks = new Map<string, TaskRecord>();
  private chain: Promise<void> = Promise.resolve();
  private readonly maxRetainedTasks: number;
  private readonly finishedTaskTtlMs: number;
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(
    private readonly worker: (task: TaskRecord) => Promise<unknown>,
    options: TaskQueueOptions = {}
  ) {
    this.maxRetainedTasks = Math.max(1, options.maxRetainedTasks ?? 200);
    this.finishedTaskTtlMs = Math.max(60_000, options.finishedTaskTtlMs ?? 6 * 60 * 60 * 1000);
    const cleanupIntervalMs = Math.max(30_000, options.cleanupIntervalMs ?? 5 * 60 * 1000);

    this.cleanupTimer = setInterval(() => {
      this.prune();
    }, cleanupIntervalMs);
    this.cleanupTimer.unref();
  }

  enqueue(input: ExecuteScriptCommandPayload) {
    this.prune();

    const task: TaskRecord = {
      id: randomUUID(),
      command: input.command,
      status: "pending",
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
      input,
    };

    this.tasks.set(task.id, task);
    this.chain = this.chain.then(() => this.run(task)).catch(() => undefined);

    return task;
  }

  get(taskId: string) {
    this.prune();
    return this.tasks.get(taskId) ?? null;
  }

  getStats() {
    this.prune();
    const values = Array.from(this.tasks.values());

    return {
      total: values.length,
      pending: values.filter((task) => task.status === "pending").length,
      inProgress: values.filter((task) => task.status === "in_progress").length,
      completed: values.filter((task) => task.status === "completed").length,
      failed: values.filter((task) => task.status === "failed").length,
    };
  }

  private async run(task: TaskRecord) {
    task.status = "in_progress";
    task.startedAt = new Date().toISOString();

    try {
      task.result = await this.worker(task);
      task.status = "completed";
    } catch (error) {
      task.status = "failed";
      task.error = error instanceof Error ? error.message : String(error);
      task.result = null;
    } finally {
      task.finishedAt = new Date().toISOString();
      this.prune();
    }
  }

  private prune() {
    this.pruneExpiredFinishedTasks();
    this.pruneOverflowFinishedTasks();
  }

  private pruneExpiredFinishedTasks() {
    const cutoff = Date.now() - this.finishedTaskTtlMs;

    for (const [taskId, task] of this.tasks.entries()) {
      if (!isFinishedTask(task)) {
        continue;
      }

      const finishedAt = parseIsoTime(task.finishedAt);

      if (finishedAt > 0 && finishedAt < cutoff) {
        this.tasks.delete(taskId);
      }
    }
  }

  private pruneOverflowFinishedTasks() {
    if (this.tasks.size <= this.maxRetainedTasks) {
      return;
    }

    const finishedTasks = Array.from(this.tasks.entries())
      .filter(([, task]) => isFinishedTask(task))
      .sort((left, right) => {
        const leftFinishedAt = parseIsoTime(left[1].finishedAt);
        const rightFinishedAt = parseIsoTime(right[1].finishedAt);

        if (leftFinishedAt !== rightFinishedAt) {
          return leftFinishedAt - rightFinishedAt;
        }

        return parseIsoTime(left[1].createdAt) - parseIsoTime(right[1].createdAt);
      });

    while (this.tasks.size > this.maxRetainedTasks && finishedTasks.length > 0) {
      const oldestFinishedTask = finishedTasks.shift();

      if (!oldestFinishedTask) {
        break;
      }

      this.tasks.delete(oldestFinishedTask[0]);
    }
  }
}