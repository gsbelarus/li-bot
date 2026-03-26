import OpenAI from "openai";

export const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";

export function getConfiguredOpenAiModel() {
  const configuredModel = process.env.OPENAI_MODEL?.trim();

  return configuredModel || DEFAULT_OPENAI_MODEL;
}

export function getOpenAiProjectKey() {
  const configuredProject = process.env.OPENAI_PROJECT_KEY?.trim();

  return configuredProject || null;
}

export function getOpenAiApiKey() {
  const configuredApiKey = process.env.OPENAI_API_KEY?.trim();

  return configuredApiKey || null;
}

export function createOpenAiClient() {
  const apiKey = getOpenAiApiKey();

  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY environment variable.");
  }

  return new OpenAI({
    apiKey,
    project: getOpenAiProjectKey() ?? undefined,
  });
}