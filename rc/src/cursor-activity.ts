import { spawn, spawnSync, type ChildProcess } from "node:child_process";

import { log, serializeError } from "./logger.js";

interface CursorActivityOptions {
  defaultEnabled: boolean;
  minIntervalMs: number;
  maxIntervalMs: number;
  maxOffsetPx: number;
  minStepCount: number;
  maxStepCount: number;
}

export interface CursorActivityRuntimeOverrides {
  enabled?: boolean;
  minIntervalMs?: number;
  maxIntervalMs?: number;
  maxOffsetPx?: number;
}

function envBoolean(name: string, fallback = false) {
  const raw = process.env[name];

  if (typeof raw !== "string") {
    return fallback;
  }

  if (/^(?:1|true|yes|on)$/i.test(raw)) {
    return true;
  }

  if (/^(?:0|false|no|off)$/i.test(raw)) {
    return false;
  }

  return fallback;
}

function envInteger(name: string, fallback: number, minimum = 0) {
  const raw = Number(process.env[name]);

  if (!Number.isFinite(raw)) {
    return fallback;
  }

  return Math.max(minimum, Math.floor(raw));
}

function encodePowerShell(script: string) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function buildCursorActivityScript(options: CursorActivityOptions) {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class CursorInterop {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT {
    public int X;
    public int Y;
  }

  [DllImport("user32.dll")]
  public static extern bool GetCursorPos(out POINT lpPoint);

  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int x, int y);
}
"@

$random = [System.Random]::new()
$minIntervalMs = ${options.minIntervalMs}
$maxIntervalMs = ${options.maxIntervalMs}
$maxOffsetPx = ${options.maxOffsetPx}
$minStepCount = ${options.minStepCount}
$maxStepCount = ${options.maxStepCount}

function Get-RandomInt([int] $minimum, [int] $maximum) {
  if ($maximum -le $minimum) {
    return $minimum
  }

  return $random.Next($minimum, $maximum + 1)
}

function Clamp([int] $value, [int] $minimum, [int] $maximum) {
  return [Math]::Max($minimum, [Math]::Min($maximum, $value))
}

while ($true) {
  Start-Sleep -Milliseconds (Get-RandomInt $minIntervalMs $maxIntervalMs)

  $point = New-Object CursorInterop+POINT
  [CursorInterop]::GetCursorPos([ref] $point) | Out-Null

  $virtualScreen = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $targetX = Clamp ($point.X + (Get-RandomInt (-1 * $maxOffsetPx) $maxOffsetPx)) $virtualScreen.Left ($virtualScreen.Right - 1)
  $targetY = Clamp ($point.Y + (Get-RandomInt (-1 * $maxOffsetPx) $maxOffsetPx)) $virtualScreen.Top ($virtualScreen.Bottom - 1)

  if ($targetX -eq $point.X -and $targetY -eq $point.Y) {
    continue
  }

  $steps = Get-RandomInt $minStepCount $maxStepCount
  $jitterRange = [Math]::Max(1, [Math]::Floor($maxOffsetPx / 6))

  for ($step = 1; $step -le $steps; $step += 1) {
    $progress = $step / [double] $steps

    if ($progress -lt 0.5) {
      $ease = 2 * $progress * $progress
    } else {
      $ease = 1 - [Math]::Pow(-2 * $progress + 2, 2) / 2
    }

    if ($step -eq $steps) {
      $jitterX = 0
      $jitterY = 0
    } else {
      $jitterX = Get-RandomInt (-1 * $jitterRange) $jitterRange
      $jitterY = Get-RandomInt (-1 * $jitterRange) $jitterRange
    }

    $nextX = Clamp ([int] [Math]::Round($point.X + (($targetX - $point.X) * $ease) + $jitterX)) $virtualScreen.Left ($virtualScreen.Right - 1)
    $nextY = Clamp ([int] [Math]::Round($point.Y + (($targetY - $point.Y) * $ease) + $jitterY)) $virtualScreen.Top ($virtualScreen.Bottom - 1)

    [CursorInterop]::SetCursorPos($nextX, $nextY) | Out-Null
    Start-Sleep -Milliseconds (Get-RandomInt 14 32)
  }
}
`.trim();
}

function loadOptions(): CursorActivityOptions {
  const minIntervalMs = envInteger("REMOTE_CONTROLLER_MOUSE_ACTIVITY_MIN_INTERVAL_MS", 9000, 250);
  const maxIntervalMs = envInteger(
    "REMOTE_CONTROLLER_MOUSE_ACTIVITY_MAX_INTERVAL_MS",
    22000,
    minIntervalMs
  );
  const minStepCount = envInteger("REMOTE_CONTROLLER_MOUSE_ACTIVITY_MIN_STEP_COUNT", 8, 1);
  const maxStepCount = envInteger(
    "REMOTE_CONTROLLER_MOUSE_ACTIVITY_MAX_STEP_COUNT",
    16,
    minStepCount
  );

  return {
    defaultEnabled: envBoolean("REMOTE_CONTROLLER_MOUSE_ACTIVITY_ENABLED", false),
    minIntervalMs,
    maxIntervalMs,
    maxOffsetPx: envInteger("REMOTE_CONTROLLER_MOUSE_ACTIVITY_MAX_OFFSET_PX", 48, 1),
    minStepCount,
    maxStepCount,
  };
}

function terminateProcess(pid: number) {
  const result = spawnSync("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
    stdio: "ignore",
    windowsHide: true,
  });

  return result.status === 0;
}

function resolveRuntimeOptions(
  defaults: CursorActivityOptions,
  overrides: CursorActivityRuntimeOverrides = {}
) {
  const minIntervalMs = typeof overrides.minIntervalMs === "number" && Number.isFinite(overrides.minIntervalMs)
    ? Math.max(250, Math.floor(overrides.minIntervalMs))
    : defaults.minIntervalMs;
  const maxIntervalMs = typeof overrides.maxIntervalMs === "number" && Number.isFinite(overrides.maxIntervalMs)
    ? Math.max(minIntervalMs, Math.floor(overrides.maxIntervalMs))
    : Math.max(minIntervalMs, defaults.maxIntervalMs);
  const maxOffsetPx = typeof overrides.maxOffsetPx === "number" && Number.isFinite(overrides.maxOffsetPx)
    ? Math.max(1, Math.floor(overrides.maxOffsetPx))
    : defaults.maxOffsetPx;

  return {
    ...defaults,
    defaultEnabled:
      typeof overrides.enabled === "boolean" ? overrides.enabled : defaults.defaultEnabled,
    minIntervalMs,
    maxIntervalMs,
    maxOffsetPx,
  } satisfies CursorActivityOptions;
}

export class CursorActivityController {
  private readonly options = loadOptions();
  private process: ChildProcess | null = null;

  start(taskId?: string, overrides: CursorActivityRuntimeOverrides = {}) {
    const runtimeOptions = resolveRuntimeOptions(this.options, overrides);

    if (!runtimeOptions.defaultEnabled) {
      return false;
    }

    if (process.platform !== "win32") {
      log("warn", "cursor_activity.unsupported_platform", {
        taskId: taskId ?? null,
        platform: process.platform,
      });
      return false;
    }

    if (this.process && this.process.exitCode === null) {
      return true;
    }

    try {
      const command = encodePowerShell(buildCursorActivityScript(runtimeOptions));
      const child = spawn(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-EncodedCommand",
          command,
        ],
        {
          stdio: "ignore",
          windowsHide: true,
        }
      );

      child.on("exit", () => {
        if (this.process?.pid === child.pid) {
          this.process = null;
        }
      });
      child.unref();
      this.process = child;

      log("info", "cursor_activity.started", {
        taskId: taskId ?? null,
        pid: child.pid ?? null,
        enabled: runtimeOptions.defaultEnabled,
        minIntervalMs: runtimeOptions.minIntervalMs,
        maxIntervalMs: runtimeOptions.maxIntervalMs,
        maxOffsetPx: runtimeOptions.maxOffsetPx,
      });

      return true;
    } catch (error) {
      log("warn", "cursor_activity.start_failed", {
        taskId: taskId ?? null,
        error: serializeError(error),
      });

      this.process = null;
      return false;
    }
  }

  stop(taskId?: string) {
    const child = this.process;

    if (!child?.pid) {
      this.process = null;
      return;
    }

    this.process = null;

    try {
      const terminated = terminateProcess(child.pid);

      if (!terminated) {
        child.kill();
      }

      log("info", "cursor_activity.stopped", {
        taskId: taskId ?? null,
        pid: child.pid,
      });
    } catch (error) {
      log("warn", "cursor_activity.stop_failed", {
        taskId: taskId ?? null,
        pid: child.pid,
        error: serializeError(error),
      });
    }
  }
}