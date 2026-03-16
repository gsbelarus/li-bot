import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

import { normalizeStructuredInstructions } from "@/lib/scripts";
import type { ScriptInstructions, ScriptStep } from "@/lib/scripts-shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const { OPENAI_API_KEY, OPENAI_PROJECT_KEY } = process.env;
const alternativeConnectorPattern = /\b(?:or|alternatively|sometimes)\b/i;
const alternativeSplitPattern = /\s*(?:,|\bor\b|\balternatively\b)\s*/i;

function safeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeText(value: unknown) {
  return safeString(value).replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeAlternativeTexts(value: unknown) {
  return Array.isArray(value)
    ? value.map((entry) => safeString(entry)).filter(Boolean)
    : [];
}

function dedupeTexts(values: string[]) {
  const seen = new Set<string>();

  return values.filter((value) => {
    const normalized = normalizeText(value);

    if (!normalized || seen.has(normalized)) {
      return false;
    }

    seen.add(normalized);
    return true;
  });
}

function extractQuotedAlternativeTexts(text: string) {
  const matches = Array.from(text.matchAll(/"([^"]+)"/g), (match) => safeString(match[1])).filter(Boolean);

  if (matches.length < 2 || !alternativeConnectorPattern.test(text)) {
    return [];
  }

  return dedupeTexts(matches);
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findCaseInsensitiveIndex(source: string, search: string) {
  if (!source || !search) {
    return -1;
  }

  return source.toLowerCase().indexOf(search.toLowerCase());
}

function cleanAlternativeSegment(value: string) {
  const normalized = safeString(value)
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/^(?:the\s+)?(?:section|heading|label|text|button|link|tab|item|option|card|profile)(?:\s+(?:called|named|labeled|labelled))?\s+/i, "")
    .replace(/^(?:called|named|labeled|labelled)\s+/i, "")
    .replace(/^(?:(?:or|and\s+)?\s*)?(?:alternatively|sometimes)\s+/i, "")
    .trim();

  if (normalized.endsWith("...") || normalized.endsWith("…")) {
    return normalized;
  }

  return normalized.replace(/[.,;:!?]+$/g, "").trim();
}

function extractUnquotedAlternativeTexts(text: string, primaryText: string) {
  const primary = safeString(primaryText);

  if (!primary || !alternativeConnectorPattern.test(text)) {
    return [];
  }

  const clauses = text
    .split(/[\r\n]+|(?<=[.!?;])\s+/)
    .map((clause) => clause.trim())
    .filter(Boolean);

  const matchingClauses = clauses.filter((clause) => findCaseInsensitiveIndex(clause, primary) >= 0);

  for (const clause of matchingClauses) {
    const primaryIndex = findCaseInsensitiveIndex(clause, primary);

    if (primaryIndex < 0) {
      continue;
    }

    const primaryEnd = primaryIndex + primary.length;
    const tail = clause.slice(primaryEnd);

    if (!/(?:\bor\b|\balternatively\b|\bsometimes\b|,)/i.test(tail)) {
      continue;
    }

    const trailingSegments = tail
      .split(alternativeSplitPattern)
      .map((segment) => cleanAlternativeSegment(segment))
      .filter(Boolean);

    if (trailingSegments.length > 0) {
      return dedupeTexts(trailingSegments);
    }
  }

  const fallbackMatch = text.match(
    new RegExp(`${escapeRegex(primary)}\\s+(?:or|alternatively|sometimes|,)\\s+([^.!?;]+)`, "i")
  );

  if (!fallbackMatch) {
    return [];
  }

  return dedupeTexts(
    fallbackMatch[1]
      .split(alternativeSplitPattern)
      .map((segment) => cleanAlternativeSegment(segment))
      .filter(Boolean)
  );
}

function extractAlternativeTexts(text: string, primaryText: string) {
  const quotedAlternatives = extractQuotedAlternativeTexts(text);

  if (quotedAlternatives.length > 1) {
    return quotedAlternatives;
  }

  const primary = safeString(primaryText);

  if (!primary) {
    return [];
  }

  return dedupeTexts([primary, ...extractUnquotedAlternativeTexts(text, primary)]);
}

function mergeAlternativeTexts(primaryText: unknown, alternativeTexts: unknown, instructionText: string) {
  const primary = safeString(primaryText);
  const extractedTexts = extractAlternativeTexts(instructionText, primary);
  const mergedTexts = dedupeTexts([
    primary || extractedTexts[0] || "",
    ...normalizeAlternativeTexts(alternativeTexts),
    ...extractedTexts,
  ]);

  return {
    text: mergedTexts[0] || primary,
    alternativeTexts: mergedTexts.slice(1),
  };
}

function inferOrdinalIndex(text: string) {
  const normalized = normalizeText(text);

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

function extractSecondRange(text: string) {
  const normalized = normalizeText(text);
  const rangeMatch = normalized.match(/(\d+)\s*(?:to|-|–)\s*(\d+)\s*seconds?/);

  if (rangeMatch) {
    const minSeconds = Number.parseInt(rangeMatch[1], 10);
    const maxSeconds = Number.parseInt(rangeMatch[2], 10);

    if (Number.isFinite(minSeconds) && Number.isFinite(maxSeconds)) {
      return {
        minDelayMs: minSeconds * 1000,
        maxDelayMs: maxSeconds * 1000,
      };
    }
  }

  const singleMatch = normalized.match(/(\d+)\s*seconds?/);

  if (singleMatch) {
    const seconds = Number.parseInt(singleMatch[1], 10);

    if (Number.isFinite(seconds)) {
      return {
        minDelayMs: seconds * 1000,
        maxDelayMs: seconds * 1000,
      };
    }
  }

  return null;
}

function inferKnownUrl(text: string) {
  const normalized = normalizeText(text);

  if (normalized.includes("my network") || normalized.includes("mynetwork")) {
    return "https://www.linkedin.com/mynetwork/";
  }

  if (normalized.includes("feed") || normalized.includes("home page") || normalized.includes("home feed")) {
    return "https://www.linkedin.com/feed/";
  }

  if (normalized.includes("notifications")) {
    return "https://www.linkedin.com/notifications/";
  }

  if (normalized.includes("messaging") || normalized.includes("messages")) {
    return "https://www.linkedin.com/messaging/";
  }

  if (normalized.includes("jobs")) {
    return "https://www.linkedin.com/jobs/";
  }

  return "";
}

function inferDestinationFromText(text: string) {
  const url = inferKnownUrl(text);

  if (!url) {
    return null;
  }

  return {
    url,
    urlIncludes: inferUrlIncludes(url),
  };
}

function isNavigationIntent(text: string) {
  const normalized = normalizeText(text);

  return (
    /\b(go to|open|navigate to|visit|move to|switch to|head to)\b/.test(normalized) &&
    Boolean(inferDestinationFromText(text))
  );
}

function isPageLoadIntent(text: string) {
  const normalized = normalizeText(text);

  return /\b(wait|until|finish loading|page loads|page to load|page to finish loading|page to settle|page settles)\b/.test(normalized);
}

function isHumanWaitIntent(text: string) {
  const normalized = normalizeText(text);
  return /\b(stay|wait|pause|remain|dwell)\b/.test(normalized);
}

function shouldMoveMouseDuringWait(text: string) {
  const normalized = normalizeText(text);
  return /move mouse|mouse movement|mouse around|natural mouse|like a person|human/.test(normalized);
}

function isProfileCardIntent(text: string) {
  const normalized = normalizeText(text);
  return /profile card|profile or card|creator profile|person or creator profile|open the first profile/.test(normalized);
}

function isGenericPeopleCardsSectionIntent(text: string) {
  const normalized = normalizeText(text);

  return /section/.test(normalized) && /(person|people|contact|profile|creator)/.test(normalized) && /(card|cards)/.test(normalized);
}

function getLinkedInPeopleSectionFallbacks(text: string) {
  if (!/linkedin|my network|mynetwork/.test(normalizeText(text))) {
    return [];
  }

  return [
    "Popular on LinkedIn",
    "People you may know",
    "People you may know from ...",
    "People you may know in ...",
  ];
}

function isMissingEndScriptIntent(text: string) {
  const normalized = normalizeText(text);

  return (
    /\bif\b/.test(normalized) &&
    /\b(no|not|missing|without)\b|is not present|isn't present|does not exist|doesn't exist|can't find|cannot find/.test(normalized) &&
    /\b(end|stop|finish|exit)\b.*\bscript\b/.test(normalized)
  );
}

function isLinkedInProfileActivityIntent(text: string) {
  const normalized = normalizeText(text);
  const inferredIndex = inferOrdinalIndex(text);

  if (inferredIndex > 0 && /\bposts?\b/.test(normalized) && !/\ball\b|\bactivity\b|\blist\b|\bfull\b/.test(normalized)) {
    return false;
  }

  return (
    (/\bactivity\b/.test(normalized) || (/\bposts?\b/.test(normalized) && /\ball\b|\blist\b|\bfull\b/.test(normalized))) &&
    /(view|see|show|open|full|all|list|look for|find)/.test(normalized)
  );
}

function getLinkedInProfileActivityControlTexts(text: string) {
  if (!/linkedin|profile/.test(normalizeText(text))) {
    return [];
  }

  return ["Show all activity", "See all activity", "See all posts"];
}

function hasResolvableTarget(step: ScriptStep | null | undefined) {
  return Boolean(
    step &&
    step.target &&
    (
      safeString(step.target.text) ||
      safeString(step.target.role) ||
      safeString(step.target.description) ||
      step.target.selectors.length > 0 ||
      typeof step.params.index === "number" ||
      safeString(step.params.containerText)
    )
  );
}

function cloneTarget(target: ScriptStep["target"]) {
  if (!target) {
    return null;
  }

  return {
    ...target,
    selectors: [...target.selectors],
    alternativeTexts: [...normalizeAlternativeTexts(target.alternativeTexts)],
  };
}

function copyLookupContextFromStep(step: ScriptStep, sourceStep: ScriptStep) {
  if (!hasResolvableTarget(step) && sourceStep.target) {
    step.target = cloneTarget(sourceStep.target);
  }

  if (typeof step.params.index !== "number" && typeof sourceStep.params.index === "number") {
    step.params.index = sourceStep.params.index;
  }

  if (!safeString(step.params.containerText) && safeString(sourceStep.params.containerText)) {
    step.params.containerText = safeString(sourceStep.params.containerText);
  }

  if (
    normalizeAlternativeTexts(step.params.containerAlternativeTexts).length === 0 &&
    normalizeAlternativeTexts(sourceStep.params.containerAlternativeTexts).length > 0
  ) {
    step.params.containerAlternativeTexts = normalizeAlternativeTexts(sourceStep.params.containerAlternativeTexts);
  }
}

function findBranchSourceStep(steps: ScriptStep[], branchIndex: number) {
  for (let offset = 1; offset <= 3; offset += 1) {
    const candidate = steps[branchIndex + offset];

    if (candidate && candidate.kind !== "branch_if_missing" && hasResolvableTarget(candidate)) {
      return candidate;
    }
  }

  for (let offset = 1; offset <= 2; offset += 1) {
    const candidate = steps[branchIndex - offset];

    if (candidate && candidate.kind !== "branch_if_missing" && hasResolvableTarget(candidate)) {
      return candidate;
    }
  }

  return null;
}

function applyLinkedInProfileActivityTarget(step: ScriptStep, contextText: string) {
  const activityTexts = getLinkedInProfileActivityControlTexts(contextText);

  if (activityTexts.length === 0) {
    return;
  }

  step.target = {
    description: safeString(step.target?.description) || "control to open the full profile activity list",
    selectors: [],
    text: activityTexts[0],
    role: "link",
    alternativeTexts: dedupeTexts([
      ...normalizeAlternativeTexts(step.target?.alternativeTexts),
      ...activityTexts.slice(1),
    ]),
  };
}

function reorderGuardBranches(steps: ScriptStep[]) {
  const reordered = [...steps];

  for (let index = 0; index < reordered.length; index += 1) {
    const step = reordered[index];

    if (step.kind !== "branch_if_missing" || safeString(step.params.onMissing) !== "end_script") {
      continue;
    }

    const sourceStep = findBranchSourceStep(reordered, index);

    if (!sourceStep) {
      continue;
    }

    const sourceIndex = reordered.indexOf(sourceStep);

    if (sourceIndex < 0 || sourceIndex >= index) {
      continue;
    }

    reordered.splice(index, 1);
    reordered.splice(sourceIndex, 0, step);
    index = Math.max(sourceIndex, 0);
  }

  return reordered;
}

function createEmptyTarget(): ScriptStep["target"] {
  return {
    description: "",
    selectors: [],
    text: "",
    role: "",
  };
}

function inferUrlIncludes(url: string) {
  const normalized = safeString(url);

  if (!normalized) {
    return "";
  }

  try {
    const parsed = new URL(normalized);
    return `${parsed.pathname}${parsed.search}` || parsed.pathname || normalized;
  } catch {
    return normalized;
  }
}

function cloneStep(step: ScriptStep): ScriptStep {
  return {
    ...step,
    target: step.target
      ? {
        ...step.target,
        selectors: [...step.target.selectors],
        alternativeTexts: [...normalizeAlternativeTexts(step.target.alternativeTexts)],
      }
      : null,
    params: Object.fromEntries(
      Object.entries(step.params).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value])
    ),
  };
}

function isRedundantSectionHeadingStep(currentStep: ScriptStep, nextStep: ScriptStep | undefined) {
  if (!nextStep) {
    return false;
  }

  const currentTargetText = safeString(currentStep.target?.text);
  const nextContainerText = safeString(nextStep.params.containerText);
  const nextContainerAlternatives = normalizeAlternativeTexts(nextStep.params.containerAlternativeTexts);
  const nextTargetDescription = normalizeText(nextStep.target?.description);

  return (
    currentStep.kind === "click" &&
    currentStep.target?.role === "heading" &&
    Boolean(currentTargetText) &&
    (currentTargetText === nextContainerText || nextContainerAlternatives.includes(currentTargetText)) &&
    nextStep.kind === "click" &&
    (nextStep.target?.role === "link" || nextTargetDescription.includes("profile card"))
  );
}

function stripListPrefix(value: string) {
  return value.replace(/^\s*(?:\d+[.):-]?|[-*•])\s+/, "").trim();
}

function splitParagraphIntoCandidateInstructions(paragraph: string) {
  const normalizedParagraph = paragraph
    .replace(/\s+/g, " ")
    .replace(/\b(?:and then|then|after that|afterwards|next|finally|once that happens|once loaded)\b/gi, " | ")
    .trim();

  return normalizedParagraph
    .split(/\s*\|\s*|(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function deriveInstructionCandidates(plainText: string) {
  const lines = plainText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const hasExplicitListLines = lines.some((line) => /^\s*(?:\d+[.):-]?|[-*•])\s+/.test(line));

  if (hasExplicitListLines) {
    return lines.map(stripListPrefix).filter(Boolean);
  }

  const paragraphs = plainText
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const candidates = paragraphs.flatMap((paragraph) => splitParagraphIntoCandidateInstructions(paragraph));

  return candidates.length > 0 ? candidates : [plainText.trim()].filter(Boolean);
}

function buildConversionUserContent(plainText: string) {
  const candidates = deriveInstructionCandidates(plainText);
  const candidateSection = candidates.map((candidate, index) => `${index + 1}. ${candidate}`).join("\n");

  return [
    "Original operator text:",
    plainText,
    "",
    "Derived candidate instruction boundaries:",
    candidateSection || "1. " + plainText,
    "",
    "Treat the original operator text as the source of truth.",
    "Use the derived candidate instruction boundaries to preserve step separation, especially when the operator wrote plain prose instead of a numbered list.",
  ].join("\n");
}

function repairStructuredInstructions(instructions: ScriptInstructions) {
  const repairedSteps: ScriptStep[] = [];

  instructions.steps.forEach((originalStep, index, allSteps) => {
    const step = cloneStep(originalStep);
    const instructionText = [step.instruction, step.target?.description, step.target?.text].filter(Boolean).join(" ");
    const inferredIndex = inferOrdinalIndex(instructionText);
    const previousStep = index > 0 ? repairedSteps[index - 1] ?? allSteps[index - 1] : null;
    const previousContextWindow = repairedSteps
      .slice(Math.max(0, repairedSteps.length - 4))
      .map((entry) => [entry.instruction, entry.target?.description, entry.target?.text].filter(Boolean).join(" "))
      .join(" ");
    const previousTargetText = safeString(previousStep?.target?.text);
    const previousTargetAlternativeTexts = normalizeAlternativeTexts(previousStep?.target?.alternativeTexts);
    const previousStepContext = normalizeText(
      [previousStep?.instruction, previousStep?.target?.description, previousTargetText].filter(Boolean).join(" ")
    );
    const destination = inferDestinationFromText(instructionText);

    if (step.target) {
      const mergedTargetTexts = mergeAlternativeTexts(
        step.target.text,
        step.target.alternativeTexts,
        step.instruction
      );

      step.target = {
        ...step.target,
        text: mergedTargetTexts.text,
        alternativeTexts: mergedTargetTexts.alternativeTexts,
      };
    }

    if (isMissingEndScriptIntent(instructionText)) {
      step.kind = "branch_if_missing";
      step.delayAfterMs = 0;
      step.params.onMissing = safeString(step.params.onMissing) || "end_script";
    }

    if (safeString(step.params.containerText)) {
      const mergedContainerTexts = mergeAlternativeTexts(
        step.params.containerText,
        step.params.containerAlternativeTexts,
        step.instruction
      );

      step.params.containerText = mergedContainerTexts.text;

      if (mergedContainerTexts.alternativeTexts.length > 0) {
        step.params.containerAlternativeTexts = mergedContainerTexts.alternativeTexts;
      }
    }

    if (step.kind !== "navigate" && destination && isNavigationIntent(instructionText)) {
      step.kind = "navigate";
      step.target = createEmptyTarget();
      step.params = {
        ...step.params,
        url: destination.url,
      };
    }

    if (step.kind === "wait" && isHumanWaitIntent(instructionText)) {
      const durationRange = extractSecondRange(instructionText);

      if (durationRange) {
        if (typeof step.params.minDelayMs !== "number") {
          step.params.minDelayMs = durationRange.minDelayMs;
        }

        if (typeof step.params.maxDelayMs !== "number") {
          step.params.maxDelayMs = durationRange.maxDelayMs;
        }

        if (
          !Number.isFinite(Number(step.timeoutMs)) ||
          step.timeoutMs < durationRange.maxDelayMs
        ) {
          step.timeoutMs = durationRange.maxDelayMs;
        }
      }

      if (shouldMoveMouseDuringWait(instructionText) && typeof step.params.moveMouse !== "boolean") {
        step.params.moveMouse = true;
      }
    }

    if (
      (step.kind === "click" ||
        step.kind === "hover" ||
        step.kind === "scroll" ||
        step.kind === "assert_visible" ||
        step.kind === "type") &&
      inferredIndex > 0 &&
      typeof step.params.index !== "number"
    ) {
      step.params.index = inferredIndex;
    }

    if (step.kind === "navigate" && !safeString(step.params.url)) {
      const inferredUrl = inferKnownUrl(instructionText);

      if (inferredUrl) {
        step.params.url = inferredUrl;
      }
    }

    if (step.kind === "wait_for_page") {
      if (!safeString(step.params.readyState)) {
        step.params.readyState = "complete";
      }

      if (
        !safeString(step.params.urlIncludes) &&
        !safeString(step.params.urlEquals) &&
        !safeString(step.params.text) &&
        normalizeText(instructionText).includes("linkedin")
      ) {
        step.params.urlIncludes = "linkedin.com";
      }

      if (!safeString(step.params.urlIncludes) && !safeString(step.params.urlEquals) && destination && isPageLoadIntent(instructionText)) {
        step.params.urlIncludes = destination.urlIncludes;
      }

      if (
        !safeString(step.params.urlIncludes) &&
        !safeString(step.params.urlEquals) &&
        !safeString(step.params.text) &&
        previousStep?.kind === "navigate"
      ) {
        const previousUrl = safeString(previousStep.params.url);
        const inferredUrlIncludes = inferUrlIncludes(previousUrl);

        if (inferredUrlIncludes) {
          step.params.urlIncludes = inferredUrlIncludes;
        }
      }

      if (!safeString(step.params.urlIncludes) && !safeString(step.params.urlEquals) && previousStep?.kind !== "navigate" && destination) {
        step.params.urlIncludes = destination.urlIncludes;
      }
    }

    if (step.kind !== "wait_for_page" && previousStep?.kind === "navigate" && isPageLoadIntent(instructionText)) {
      step.kind = "wait_for_page";
      step.target = createEmptyTarget();
      step.params = {
        ...step.params,
        readyState: safeString(step.params.readyState) || "complete",
        urlIncludes:
          safeString(step.params.urlIncludes) ||
          safeString(step.params.urlEquals) ||
          inferUrlIncludes(safeString(previousStep.params.url)),
      };
    }

    if (
      step.kind === "assert_visible" &&
      step.target?.role === "document" &&
      step.target.text &&
      !safeString(step.params.text)
    ) {
      step.params.text = step.target.text;
    }

    if (
      !safeString(step.params.containerText) &&
      previousTargetText &&
      /section|area|panel|group|within|inside/.test(normalizeText(step.instruction)) &&
      /section|area|panel|group/.test(previousStepContext)
    ) {
      step.params.containerText = previousTargetText;

      if (previousTargetAlternativeTexts.length > 0) {
        step.params.containerAlternativeTexts = previousTargetAlternativeTexts;
      }
    }

    if (
      safeString(step.params.containerText) &&
      previousTargetText &&
      safeString(step.params.containerText) === previousTargetText &&
      normalizeAlternativeTexts(step.params.containerAlternativeTexts).length === 0 &&
      previousTargetAlternativeTexts.length > 0
    ) {
      step.params.containerAlternativeTexts = previousTargetAlternativeTexts;
    }

    if (
      step.kind === "assert_visible" &&
      isGenericPeopleCardsSectionIntent(step.instruction)
    ) {
      const contextualSectionTexts = dedupeTexts([
        ...getLinkedInPeopleSectionFallbacks(previousContextWindow),
        ...getLinkedInPeopleSectionFallbacks(previousStepContext),
        ...getLinkedInPeopleSectionFallbacks(instructionText),
      ]);

      if (step.target && contextualSectionTexts.length > 0) {
        step.target = {
          ...step.target,
          description: safeString(step.target.description) || "section with person contact cards",
          role: safeString(step.target.role) || "heading",
          text: contextualSectionTexts[0],
          alternativeTexts: contextualSectionTexts.slice(1),
        };
      }
    }

    if (
      step.kind === "click" &&
      isProfileCardIntent(instructionText) &&
      safeString(step.params.containerText) &&
      step.target &&
      (
        step.target.text === safeString(step.params.containerText) ||
        normalizeAlternativeTexts(step.params.containerAlternativeTexts).includes(step.target.text) ||
        /^\d+$/.test(step.target.text) ||
        !safeString(step.target.role)
      )
    ) {
      step.target = {
        description: "profile card",
        selectors: [],
        text: "",
        role: "link",
        alternativeTexts: [],
      };
    }

    if (
      (step.kind === "assert_visible" || step.kind === "click" || step.kind === "branch_if_missing") &&
      isLinkedInProfileActivityIntent(instructionText)
    ) {
      const activityContext = [previousContextWindow, previousStepContext, instructionText].filter(Boolean).join(" ");
      applyLinkedInProfileActivityTarget(step, activityContext);
    }

    if (
      step.target?.role === "link" &&
      safeString(step.params.containerText) &&
      (
        step.target.text === safeString(step.params.containerText) ||
        normalizeAlternativeTexts(step.params.containerAlternativeTexts).includes(step.target.text)
      )
    ) {
      step.target = {
        ...step.target,
        text: "",
      };
    }

    if (step.target?.text) {
      step.target = {
        ...step.target,
        selectors: [],
      };
    }

    repairedSteps.push(step);
  });

  const branchedSteps = repairedSteps.map((step, index, steps) => {
    if (step.kind !== "branch_if_missing") {
      return step;
    }

    const branchStep = cloneStep(step);
    const sourceStep = findBranchSourceStep(steps, index);

    if (!hasResolvableTarget(branchStep) && sourceStep) {
      copyLookupContextFromStep(branchStep, sourceStep);
    }

    if (sourceStep && isLinkedInProfileActivityIntent(sourceStep.instruction)) {
      applyLinkedInProfileActivityTarget(
        branchStep,
        [sourceStep.instruction, sourceStep.target?.description, sourceStep.target?.text].filter(Boolean).join(" ")
      );
    }

    return branchStep;
  });

  const cleanedSteps = reorderGuardBranches(branchedSteps)
    .filter((step, index, steps) => !isRedundantSectionHeadingStep(step, steps[index + 1]))
    .map((step, index) => ({
      ...step,
      order: index + 1,
    }));

  return {
    ...instructions,
    steps: cleanedSteps,
  } satisfies ScriptInstructions;
}

const conversionTool = {
  type: "function" as const,
  function: {
    name: "build_structured_script",
    description:
      "Convert a human-written browser operation script into structured execution instructions.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "defaultDelayMs", "steps"],
      properties: {
        summary: { type: "string" },
        defaultDelayMs: { type: "number" },
        steps: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["order", "kind", "instruction", "delayAfterMs", "timeoutMs"],
            properties: {
              order: { type: "number" },
              kind: {
                type: "string",
                enum: [
                  "navigate",
                  "click",
                  "branch_if_missing",
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
                ],
              },
              instruction: { type: "string" },
              delayAfterMs: { type: "number" },
              timeoutMs: { type: "number" },
              target: {
                type: "object",
                additionalProperties: false,
                properties: {
                  description: { type: "string" },
                  selectors: {
                    type: "array",
                    items: { type: "string" },
                  },
                  text: { type: "string" },
                  role: { type: "string" },
                  alternativeTexts: {
                    type: "array",
                    items: { type: "string" },
                  },
                },
              },
              params: {
                type: "object",
                additionalProperties: {
                  anyOf: [
                    { type: "string" },
                    { type: "number" },
                    { type: "boolean" },
                    { type: "null" },
                    {
                      type: "array",
                      items: { type: "string" },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    },
  },
};

export async function POST(request: NextRequest) {
  if (!OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "Missing OPENAI_API_KEY environment variable." },
      { status: 500 }
    );
  }

  const body = await request.json().catch(() => null);
  const plainText = typeof body?.plainText === "string" ? body.plainText.trim() : "";

  if (!plainText) {
    return NextResponse.json({ error: "plainText is required." }, { status: 400 });
  }

  const client = new OpenAI({
    apiKey: OPENAI_API_KEY,
    project: OPENAI_PROJECT_KEY,
  });

  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: [
            "You convert human browser instructions into structured JSON for an OpenClaw-based bot.",
            "OpenClaw should execute human-like browser actions from visible labels, roles, page URLs, and page state whenever possible.",
            "Use only these action kinds: navigate, click, branch_if_missing, hover, wait, wait_for_page, move_mouse, scroll, type, press_key, extract_text, assert_visible, custom.",
            "Prefer native-browser-friendly instructions that can be executed from an OpenClaw snapshot and element ref.",
            "Prefer intent-level actions over DOM-mechanical actions.",
            "If the human instruction says to go to a known destination page such as LinkedIn My Network, Feed, Jobs, Notifications, or Messaging, use navigate rather than click, and always set params.url.",
            "Use click only when the intent is to activate a visible control that already exists on the current page.",
            "Use wait_for_page for page readiness checks and URL assertions. Put urlIncludes, urlEquals, readyState, and text into params when needed. If the instruction mentions a destination page, do not leave wait_for_page params empty.",
            "When a navigation step is followed by 'wait for the page to load' or similar wording, represent that as a wait_for_page step with readyState and URL conditions.",
            "When the operator says that if a visible control, post, or other target is missing the script should end, emit a separate branch_if_missing step with the same target you would otherwise click or assert, and set params.onMissing='end_script'.",
            "Use wait for dwell time on a page. For random dwell time, set params.minDelayMs and params.maxDelayMs. If the human prompt says to move the mouse around during the wait, set params.moveMouse=true.",
            "If the operator provides a numbered or line-by-line procedure, preserve one output step per operator instruction and do not merge neighboring steps.",
            "Preserve explicit conditional stop instructions such as 'If there is no third post, end the script' as their own branch step instead of merging them into the next action.",
            "When a step must act inside a section or inside the Nth repeated container, prefer containerText plus index. Use containerSelector only as a last resort.",
            "If the operator uses OR wording for visible text, whether quoted or unquoted, preserve every option. Put the first option in target.text or params.containerText and put every remaining option into target.alternativeTexts or params.containerAlternativeTexts.",
            "Support more than two alternatives, such as 'A or B or C' or 'A, B, or C', without collapsing the later options.",
            "If the operator writes a visible-label prefix with trailing ellipsis such as 'People you may know from ...', preserve that text literally as an alternative so the runtime can treat it as a prefix match.",
            "Set target.role and target.text to the visible or accessible label a human would recognize. Use target.description only for brief clarification. Avoid generic descriptions without a visible label.",
            "Avoid CSS selectors unless the user explicitly provides one or there is no visible text or role-based way to identify the target.",
            "Only use supported target roles that the runtime understands: document, link, button, textbox, heading, img, article, checkbox, or an empty string.",
            "For page-presence checks like 'make sure LinkedIn is opened', prefer wait_for_page with params.urlIncludes over assert_visible when possible.",
            "Do not create click or assert_visible steps with only a generic role and no visible text unless you also provide index and enough container context to disambiguate the target.",
            "For known destination pages, do not rely on selectors or page links when the operator intent is clearly navigation.",
            "If an instruction says to open the first profile card inside a named section, do not target the section heading itself. Target a clickable profile/link inside that section using containerText and index.",
            "For LinkedIn profile activity, prefer the visible control 'Show all activity' and preserve alternatives such as 'See all activity' or 'See all posts' when the operator wants to open the full posts/activity list.",
            "For wait and wait_for_page steps, usually set delayAfterMs to 0.",
            "Use custom only when the requested behavior cannot be represented with the supported action kinds.",
            "Return explicit ordered steps that preserve the human intent.",
          ].join(" "),
        },
        {
          role: "user",
          content: buildConversionUserContent(plainText),
        },
      ],
      tools: [conversionTool],
      tool_choice: {
        type: "function",
        function: { name: "build_structured_script" },
      },
    });

    const toolCall = completion.choices[0]?.message?.tool_calls?.[0];

    if (!toolCall || toolCall.type !== "function") {
      return NextResponse.json(
        { error: "OpenAI did not return structured instructions." },
        { status: 502 }
      );
    }

    const parsedArguments = JSON.parse(toolCall.function.arguments);
    const structuredInstructions = repairStructuredInstructions(
      normalizeStructuredInstructions(parsedArguments)
    );

    return NextResponse.json({ structuredInstructions });
  } catch {
    return NextResponse.json(
      { error: "Failed to convert script markdown to structured instructions." },
      { status: 500 }
    );
  }
}
