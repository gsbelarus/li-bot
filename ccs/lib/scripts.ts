import { Types } from "mongoose";

import ScriptDefinitionModel, {
  ScriptDefinitionDocument,
} from "@/models/ScriptDefinition";
import {
  ScriptActionKind,
  ScriptInstructions,
  ScriptRecord,
  ScriptStep,
  ScriptTimestampWarning,
  ScriptTarget,
  createEmptyScriptInstructions,
  scriptActionKinds,
} from "@/lib/scripts-shared";

const actorFallback = "operator@control-center";
const fallbackIsoTimestamp = new Date(0).toISOString();

const safeString = (value: unknown, fallback = "") =>
  typeof value === "string" ? value.trim() : fallback;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasToObject(
  value: ScriptDefinitionDocument | Record<string, unknown>
): value is ScriptDefinitionDocument & { toObject(): Record<string, unknown> } {
  return typeof (value as { toObject?: unknown }).toObject === "function";
}

function toIsoResult<TWarning extends string>(
  warning: TWarning,
  value: Date | string | null | undefined,
  fallback = fallbackIsoTimestamp
): { value: string; warning?: TWarning } {
  if (value === null || value === undefined) {
    return { value: fallback, warning };
  }

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return { value: fallback, warning };
  }

  return { value: date.toISOString() };
}

function normalizeTarget(value: unknown): ScriptTarget | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const selectors = Array.isArray(value.selectors)
    ? value.selectors.map((selector) => safeString(selector)).filter(Boolean)
    : [];

  return {
    description: safeString(value.description),
    selectors,
    text: safeString(value.text),
    role: safeString(value.role),
  };
}

function normalizeStep(value: unknown, index: number): ScriptStep {
  const source = isPlainObject(value) ? value : {};
  const kind = safeString(source.kind, "custom") as ScriptActionKind;
  const params = isPlainObject(source.params)
    ? Object.entries(source.params).reduce<ScriptStep["params"]>((accumulator, [key, entry]) => {
      if (
        typeof entry === "string" ||
        typeof entry === "number" ||
        typeof entry === "boolean" ||
        entry === null
      ) {
        accumulator[key] = entry;
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
        : 1000,
    timeoutMs:
      Number.isFinite(source.timeoutMs) && Number(source.timeoutMs) > 0
        ? Number(source.timeoutMs)
        : 10000,
    target: normalizeTarget(source.target),
    params,
  };
}

export function normalizeStructuredInstructions(
  value: unknown,
  fallbackSummary = ""
): ScriptInstructions {
  const source = isPlainObject(value) ? value : {};
  const steps = Array.isArray(source.steps)
    ? source.steps.map((step, index) => normalizeStep(step, index))
    : [];

  return {
    version: 1,
    summary: safeString(source.summary, fallbackSummary),
    defaultDelayMs:
      Number.isFinite(source.defaultDelayMs) && Number(source.defaultDelayMs) >= 0
        ? Number(source.defaultDelayMs)
        : 1000,
    steps,
  };
}

export function serializeScript(
  document: ScriptDefinitionDocument | Record<string, unknown>
): ScriptRecord {
  const source = hasToObject(document) ? document.toObject() : document;
  const createdAt = toIsoResult("createdAt", source.createdAt as Date | string | null | undefined);
  const updatedAt = toIsoResult("updatedAt", source.updatedAt as Date | string | null | undefined);
  const timestampWarnings = [createdAt.warning, updatedAt.warning].filter(
    (warning): warning is ScriptTimestampWarning => Boolean(warning)
  );

  return {
    id: String(source._id),
    name: safeString(source.name),
    description: safeString(source.description),
    plainText: safeString(source.plainText),
    structuredInstructions: normalizeStructuredInstructions(
      source.structuredInstructions,
      safeString(source.description)
    ),
    isDisabled: Boolean(source.isDisabled),
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
    createdBy: safeString(source.createdBy),
    updatedBy: safeString(source.updatedBy),
    timestampWarnings,
  };
}

export interface ScriptPayload {
  name: string;
  description: string;
  plainText: string;
  structuredInstructions: ScriptInstructions;
  isDisabled: boolean;
}

export class ScriptPayloadValidationError extends Error {
  constructor(public errors: Record<string, string>) {
    super("Invalid script payload");
  }
}

export function validateScriptPayload(input: unknown): ScriptPayload {
  if (!isPlainObject(input)) {
    throw new ScriptPayloadValidationError({
      form: "Request body must be a JSON object.",
    });
  }

  const name = safeString(input.name);
  const description = safeString(input.description);
  const plainText = typeof input.plainText === "string" ? input.plainText.trim() : "";
  const isDisabled =
    typeof input.isDisabled === "boolean" ? input.isDisabled : Boolean(input.isDisabled);
  const structuredInstructions = normalizeStructuredInstructions(
    input.structuredInstructions,
    description || name
  );
  const errors: Record<string, string> = {};

  if (!name) {
    errors.name = "Script name is required.";
  }

  if (!plainText) {
    errors.plainText = "Script markdown is required.";
  }

  if (Object.keys(errors).length > 0) {
    throw new ScriptPayloadValidationError(errors);
  }

  return {
    name,
    description,
    plainText,
    structuredInstructions,
    isDisabled,
  };
}

export function getActorFromRequest(request: Request) {
  return (
    request.headers.get("x-operator-id") ??
    request.headers.get("x-user-id") ??
    actorFallback
  );
}

export function getScriptListQuery(searchParams: URLSearchParams) {
  const page = Math.max(1, Number(searchParams.get("page") ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(searchParams.get("pageSize") ?? 10)));
  const search = safeString(searchParams.get("search"));
  const disabled = safeString(searchParams.get("disabled"));
  const sortField = safeString(searchParams.get("sortField"), "updatedAt");
  const sortDirection = safeString(searchParams.get("sortDirection"), "desc");

  const filter: Record<string, unknown> = { isDeleted: false };

  if (disabled === "true") {
    filter.isDisabled = true;
  }

  if (disabled === "false") {
    filter.isDisabled = false;
  }

  if (search) {
    const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ name: regex }, { description: regex }, { plainText: regex }];
  }

  const sortFieldMap: Record<string, string> = {
    name: "name",
    updatedAt: "updatedAt",
    createdAt: "createdAt",
    isDisabled: "isDisabled",
  };

  const sort: Record<string, 1 | -1> = {
    [sortFieldMap[sortField] ?? "updatedAt"]: sortDirection === "asc" ? 1 : -1,
  };

  return { filter, page, pageSize, sort };
}

export async function findScriptById(id: string, includeDeleted = false) {
  if (!Types.ObjectId.isValid(id)) {
    return null;
  }

  return ScriptDefinitionModel.findOne({
    _id: id,
    ...(includeDeleted ? {} : { isDeleted: false }),
  });
}

export function createDefaultScriptPayload(): ScriptPayload {
  return {
    name: "",
    description: "",
    plainText: "",
    structuredInstructions: createEmptyScriptInstructions(),
    isDisabled: false,
  };
}
