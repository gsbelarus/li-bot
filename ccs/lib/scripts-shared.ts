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

export const scriptEngineModes = ["deterministic", "ai_driven"] as const;

export type ScriptEngineMode = (typeof scriptEngineModes)[number];

export type ScriptTimestampWarning = "createdAt" | "updatedAt";

export interface ScriptRecord {
  id: string;
  name: string;
  description: string;
  plainText: string;
  structuredInstructions: ScriptInstructions;
  engineMode: ScriptEngineMode;
  isDisabled: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
  timestampWarnings: ScriptTimestampWarning[];
}

export interface ScriptListResponse {
  items: ScriptRecord[];
  totalCount: number;
  page: number;
  pageSize: number;
}

export interface ScriptMutationResponse {
  item: ScriptRecord;
  message: string;
}

export interface ScriptConvertResponse {
  structuredInstructions: ScriptInstructions;
}

export function createEmptyScriptInstructions(summary = ""): ScriptInstructions {
  return {
    version: 1,
    summary,
    defaultDelayMs: 1000,
    steps: [],
  };
}
