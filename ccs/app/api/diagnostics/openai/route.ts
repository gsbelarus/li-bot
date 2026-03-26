import { NextResponse } from "next/server";
import OpenAI from "openai";

import { OpenAiDiagnosticsResponse } from "@/lib/diagnostics-shared";
import {
  createOpenAiClient,
  getConfiguredOpenAiModel,
  getOpenAiApiKey,
  getOpenAiProjectKey,
} from "@/lib/openai-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normalizeOpenAiError(error: unknown) {
  if (error instanceof OpenAI.APIError) {
    return {
      message: error.message,
      status: error.status ?? null,
      code: typeof error.code === "string" ? error.code : null,
      type: typeof error.type === "string" ? error.type : null,
      param: typeof error.param === "string" ? error.param : null,
      requestId: typeof error.requestID === "string" ? error.requestID : null,
    };
  }

  if (error instanceof Error) {
    return {
      message: error.message,
      status: null,
      code: null,
      type: null,
      param: null,
      requestId: null,
    };
  }

  return {
    message: "OpenAI diagnostics failed.",
    status: null,
    code: null,
    type: null,
    param: null,
    requestId: null,
  };
}

function inferAccountFunding(error: ReturnType<typeof normalizeOpenAiError>) {
  const normalizedMessage = error.message.toLowerCase();
  const normalizedCode = error.code?.toLowerCase() ?? "";

  if (
    normalizedCode.includes("insufficient_quota") ||
    normalizedMessage.includes("insufficient_quota") ||
    normalizedMessage.includes("quota") ||
    normalizedMessage.includes("billing") ||
    normalizedMessage.includes("payment")
  ) {
    return false;
  }

  if (error.status && error.status >= 200 && error.status < 500 && error.status !== 429) {
    return true;
  }

  return null;
}

export async function GET() {
  const model = getConfiguredOpenAiModel();
  const project = getOpenAiProjectKey();
  const apiKey = getOpenAiApiKey();

  if (!apiKey) {
    const payload: OpenAiDiagnosticsResponse = {
      ok: false,
      model,
      project,
      checks: {
        apiKeyConfigured: false,
        modelSpecified: Boolean(model),
        openAiReachable: false,
        apiKeyAccepted: false,
        accountFunded: null,
      },
      error: {
        message: "Missing OPENAI_API_KEY environment variable.",
        status: null,
        code: null,
        type: null,
        param: null,
        requestId: null,
      },
    };

    return NextResponse.json(payload, { status: 500 });
  }

  try {
    const client = createOpenAiClient();
    const completion = await client.chat.completions.create({
      model,
      temperature: 0,
      max_completion_tokens: 16,
      messages: [
        {
          role: "user",
          content: "Reply with the single word OK.",
        },
      ],
    });

    const messagePreview = completion.choices[0]?.message?.content?.trim() || "";
    const payload: OpenAiDiagnosticsResponse = {
      ok: true,
      model,
      project,
      checks: {
        apiKeyConfigured: true,
        modelSpecified: Boolean(model),
        openAiReachable: true,
        apiKeyAccepted: true,
        accountFunded: true,
      },
      response: {
        completionId: completion.id ?? null,
        messagePreview,
      },
    };

    return NextResponse.json(payload);
  } catch (error) {
    const normalizedError = normalizeOpenAiError(error);
    const isApiError = error instanceof OpenAI.APIError;
    const payload: OpenAiDiagnosticsResponse = {
      ok: false,
      model,
      project,
      checks: {
        apiKeyConfigured: true,
        modelSpecified: Boolean(model),
        openAiReachable: isApiError || normalizedError.status !== null,
        apiKeyAccepted:
          normalizedError.status === 401
            ? false
            : isApiError && normalizedError.status !== 401
              ? true
              : null,
        accountFunded: inferAccountFunding(normalizedError),
      },
      error: normalizedError,
    };

    return NextResponse.json(payload, {
      status: normalizedError.status && normalizedError.status >= 400 ? normalizedError.status : 502,
    });
  }
}