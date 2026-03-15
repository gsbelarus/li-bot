import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

import { normalizeStructuredInstructions } from "@/lib/scripts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const { OPENAI_API_KEY, OPENAI_PROJECT_KEY } = process.env;

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
                  "click",
                  "hover",
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
          content:
            "You convert browser operation scripts into structured JSON instructions for a bot. Produce explicit ordered steps, delays, selectors when inferable, and conservative defaults when details are missing.",
        },
        {
          role: "user",
          content: plainText,
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
    const structuredInstructions = normalizeStructuredInstructions(parsedArguments);

    return NextResponse.json({ structuredInstructions });
  } catch {
    return NextResponse.json(
      { error: "Failed to convert script markdown to structured instructions." },
      { status: 500 }
    );
  }
}
