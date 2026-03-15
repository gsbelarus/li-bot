import { spawnSync } from "node:child_process";

import type { ScriptInstructions, ScriptStep } from "./script-contract.js";

const windowsShell = process.env.ComSpec || "cmd.exe";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export interface StepExecutionRecord {
  order: number;
  kind: ScriptStep["kind"];
  instruction: string;
  durationMs: number;
  output: unknown;
}

export class OpenClawRuntime {
  private readonly browserProfile = process.env.OPENCLAW_BROWSER_PROFILE || "chrome";
  private readonly gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || "";
  private readonly gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || "";
  private readonly openClawBin = process.env.OPENCLAW_BIN || "openclaw";

  executeScript(script: ScriptInstructions, targetId?: string) {
    return this.runScript(script, targetId);
  }

  private oc(args: string[], { json = false }: { json?: boolean } = {}) {
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

    const command = process.platform === "win32" ? windowsShell : this.openClawBin;
    const commandArgs =
      process.platform === "win32"
        ? ["/d", "/s", "/c", this.openClawBin, ...fullArgs]
        : fullArgs;

    const result = spawnSync(command, commandArgs, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || `OpenClaw exited with code ${result.status}.`).trim());
    }

    const stdout = (result.stdout || "").trim();

    if (!json) {
      return stdout;
    }

    return stdout ? JSON.parse(stdout) : null;
  }

  private getFocusedTab() {
    const tabs = this.oc(["tabs"], { json: true });
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

  private evaluate(targetId: string, expression: string) {
    return parseJsonish(this.oc(["evaluate", "--fn", expression, "--target-id", targetId], { json: true }));
  }

  private getPageState(targetId: string) {
    return this.evaluate(
      targetId,
      `() => ({ url: window.location.href, title: document.title, readyState: document.readyState, scrollY: window.scrollY })`
    ) as {
      url: string;
      title: string;
      readyState: string;
      scrollY: number;
    };
  }

  private async waitForPage(targetId: string, step: ScriptStep) {
    const timeoutMs = step.timeoutMs;
    const readyState = scalarString(step.params.readyState, "complete");
    const urlIncludes = scalarString(step.params.urlIncludes);
    const urlEquals = scalarString(step.params.urlEquals);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() <= deadline) {
      const pageState = this.getPageState(targetId);
      const readyMatches = !readyState || pageState.readyState === readyState;
      const includesMatches = !urlIncludes || pageState.url.includes(urlIncludes);
      const equalsMatches = !urlEquals || pageState.url === urlEquals;

      if (readyMatches && includesMatches && equalsMatches) {
        return pageState;
      }

      await sleep(Math.min(500, Math.max(100, step.delayAfterMs || 250)));
    }

    throw new Error(`Timed out waiting for page state for step ${step.order}.`);
  }

  private runDomAction(targetId: string, step: ScriptStep) {
    const payload = JSON.stringify({
      action: step.kind,
      target: step.target,
      params: step.params,
      instruction: step.instruction,
    });

    return this.evaluate(
      targetId,
      `() => {
        const payload = ${payload};
        const target = payload.target;
        const params = payload.params || {};
        const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim().toLowerCase();
        const roleSelectors = {
          link: "a,[role='link']",
          button: "button,[role='button']",
          textbox: "input,textarea,[role='textbox']",
          heading: "h1,h2,h3,h4,h5,h6,[role='heading']",
          img: "img,[role='img']",
          article: "article,[role='article']",
          checkbox: "input[type='checkbox'],[role='checkbox']"
        };
        const seen = new Set();
        const candidates = [];
        const textFor = (element) => {
          if (!element) {
            return "";
          }
          return [
            element.innerText,
            element.textContent,
            element.getAttribute && element.getAttribute("aria-label"),
            element.getAttribute && element.getAttribute("title"),
            element.getAttribute && element.getAttribute("placeholder"),
            "value" in element ? element.value : ""
          ].map((entry) => String(entry ?? "")).join(" ").replace(/\\s+/g, " ").trim();
        };
        const addCandidate = (element) => {
          if (!(element instanceof Element)) {
            return;
          }
          if (seen.has(element)) {
            return;
          }
          seen.add(element);
          candidates.push(element);
        };
        const isVisible = (element) => {
          if (!(element instanceof Element)) {
            return false;
          }
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
        };
        if (target) {
          for (const selector of Array.isArray(target.selectors) ? target.selectors : []) {
            if (!selector) {
              continue;
            }
            try {
              document.querySelectorAll(selector).forEach(addCandidate);
            } catch {
            }
          }
          const roleSelector = target.role ? (roleSelectors[target.role] || "*") : "*";
          document.querySelectorAll(roleSelector).forEach((element) => {
            const text = normalize(textFor(element));
            const targetText = normalize(target.text);
            const description = normalize(target.description);
            if (
              (targetText && text.includes(targetText)) ||
              (description && text.includes(description)) ||
              (!targetText && !description && !target.role)
            ) {
              addCandidate(element);
            }
          });
          if (candidates.length === 0 && target.text) {
            document.querySelectorAll("*").forEach((element) => {
              if (normalize(textFor(element)).includes(normalize(target.text))) {
                addCandidate(element);
              }
            });
          }
        }
        const element = candidates.find(isVisible) || candidates[0] || null;
        const summary = element
          ? {
              tagName: element.tagName.toLowerCase(),
              text: textFor(element).slice(0, 160),
              visible: isVisible(element)
            }
          : null;
        const dispatchMouseMove = (node) => {
          node.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
          node.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true, view: window }));
        };
        switch (payload.action) {
          case "click": {
            if (!element) {
              return { ok: false, error: "Target not found for click." };
            }
            element.scrollIntoView({ block: "center", inline: "center" });
            dispatchMouseMove(element);
            element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
            element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
            element.click();
            return { ok: true, action: payload.action, matched: summary, matchCount: candidates.length };
          }
          case "hover":
          case "move_mouse": {
            const node = element || document.body;
            dispatchMouseMove(node);
            return { ok: true, action: payload.action, matched: summary, matchCount: candidates.length };
          }
          case "scroll": {
            if (element) {
              element.scrollIntoView({ block: "center", inline: "nearest" });
              return { ok: true, action: payload.action, matched: summary, scrollY: window.scrollY };
            }
            const amount = Number(params.amount ?? params.pixels ?? 600);
            const direction = String(params.direction ?? "down").toLowerCase();
            window.scrollBy({ top: direction === "up" ? -Math.abs(amount) : Math.abs(amount), behavior: String(params.behavior ?? "auto") === "smooth" ? "smooth" : "auto" });
            return { ok: true, action: payload.action, scrollY: window.scrollY };
          }
          case "type": {
            if (!element) {
              return { ok: false, error: "Target not found for type." };
            }
            const text = String(params.text ?? params.value ?? target?.text ?? "");
            const append = Boolean(params.append);
            const clear = params.clear === false ? false : true;
            element.scrollIntoView({ block: "center", inline: "center" });
            if (typeof element.focus === "function") {
              element.focus();
            }
            if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
              const nextValue = append ? String(element.value) + text : text;
              if (clear && !append) {
                element.value = "";
              }
              element.value = nextValue;
              element.dispatchEvent(new Event("input", { bubbles: true }));
              element.dispatchEvent(new Event("change", { bubbles: true }));
            } else if (element.isContentEditable) {
              const currentText = append ? (element.textContent || "") : "";
              if (clear && !append) {
                element.textContent = "";
              }
              element.textContent = String(currentText) + text;
              element.dispatchEvent(new Event("input", { bubbles: true }));
            } else {
              return { ok: false, error: "Resolved target is not typable." };
            }
            return { ok: true, action: payload.action, matched: summary, typedLength: text.length };
          }
          case "press_key": {
            const node = element || document.activeElement || document.body;
            const key = String(params.key ?? target?.text ?? "Enter");
            const code = String(params.code ?? key);
            node.dispatchEvent(new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true }));
            node.dispatchEvent(new KeyboardEvent("keyup", { key, code, bubbles: true, cancelable: true }));
            return { ok: true, action: payload.action, matched: summary, key };
          }
          case "extract_text": {
            if (!element) {
              return { ok: false, error: "Target not found for extract_text." };
            }
            const format = String(params.format ?? "text");
            const data =
              format === "html"
                ? element.innerHTML
                : format === "value" && "value" in element
                  ? element.value
                  : textFor(element);
            return { ok: true, action: payload.action, matched: summary, data };
          }
          case "assert_visible": {
            if (!element || !isVisible(element)) {
              return { ok: false, error: "Target is not visible." };
            }
            return { ok: true, action: payload.action, matched: summary };
          }
          case "custom": {
            const expression = typeof params.expression === "string" ? params.expression : "return null;";
            const fn = new Function("element", "params", "document", "window", expression);
            return { ok: true, action: payload.action, matched: summary, data: fn(element, params, document, window) };
          }
          default:
            return { ok: false, error: "Unsupported action: " + String(payload.action) };
        }
      }`
    );
  }

  private async runStep(targetId: string, step: ScriptStep) {
    const startedAt = Date.now();
    let output: unknown;

    if (step.kind === "wait_for_page") {
      output = await this.waitForPage(targetId, step);
    } else {
      output = this.runDomAction(targetId, step);
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
      output,
    } satisfies StepExecutionRecord;
  }

  private async runScript(script: ScriptInstructions, targetId?: string) {
    const activeTargetId = targetId || this.getFocusedTab().id;
    const startedAt = new Date().toISOString();
    const stepResults: StepExecutionRecord[] = [];

    for (const step of [...script.steps].sort((left, right) => left.order - right.order)) {
      const stepResult = await this.runStep(activeTargetId, step);
      stepResults.push(stepResult);

      const delayMs = Math.max(0, step.delayAfterMs || script.defaultDelayMs || 0);

      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }

    return {
      summary: script.summary,
      targetId: activeTargetId,
      startedAt,
      finishedAt: new Date().toISOString(),
      currentPage: this.getPageState(activeTargetId),
      steps: stepResults,
    };
  }
}