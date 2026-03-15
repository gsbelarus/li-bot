export type LogLevel = "info" | "warn" | "error";

export function log(level: LogLevel, event: string, details?: Record<string, unknown>) {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...(details ?? {}),
  };

  const line = JSON.stringify(payload);

  if (level === "error") {
    console.error(line);
    return;
  }

  console.log(line);
}

export function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    name: typeof error,
    message: String(error),
    stack: undefined,
  };
}