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

export class TaskQueue {
  private readonly tasks = new Map<string, TaskRecord>();
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly worker: (task: TaskRecord) => Promise<unknown>
  ) { }

  enqueue(input: ExecuteScriptCommandPayload) {
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
    return this.tasks.get(taskId) ?? null;
  }

  getStats() {
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
    }
  }
}