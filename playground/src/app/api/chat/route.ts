/**
 * POST /api/chat
 * Streams Claude responses as NDJSON.
 * Handles tool calls (create/run/update/list/delete workflows).
 *
 * NDJSON event types:
 *   { type: "text", text: "..." }
 *   { type: "tool_use", name: "...", id: "..." }
 *   { type: "tool_result", toolUseId: "...", result: {...} }
 *   { type: "error", error: "..." }
 *   { type: "done" }
 */

import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { TOOLS, executeTool, getSystemPrompt } from "@/lib/claude-tools";
import { checkRateLimit, checkPromptLength, MAX_PROMPT_CHARS } from "@/lib/limits";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Allow long-running requests (tool execution can take time)
export const maxDuration = 300;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export async function POST(req: NextRequest) {
  let body: {
    messages: Anthropic.MessageParam[];
    sessionId: string;
  };

  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ type: "error", error: "Invalid JSON" }) + "\n",
      { status: 400, headers: { "Content-Type": "application/x-ndjson" } }
    );
  }

  const { messages, sessionId } = body;

  if (!sessionId) {
    return new Response(
      JSON.stringify({ type: "error", error: "Missing sessionId" }) + "\n",
      { status: 400, headers: { "Content-Type": "application/x-ndjson" } }
    );
  }

  // Check prompt length (last user message)
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  const lastText = typeof lastUserMsg?.content === "string"
    ? lastUserMsg.content
    : Array.isArray(lastUserMsg?.content)
      ? lastUserMsg.content.filter((b): b is Anthropic.TextBlockParam => b.type === "text").map((b) => b.text).join("")
      : "";

  const lengthCheck = checkPromptLength(lastText);
  if (!lengthCheck.ok) {
    return new Response(
      JSON.stringify({
        type: "error",
        error: `Your message is too long (${lengthCheck.length.toLocaleString()} characters). Please keep it under ${MAX_PROMPT_CHARS.toLocaleString()} characters.`,
        code: "PROMPT_TOO_LONG",
      }) + "\n",
      { status: 400, headers: { "Content-Type": "application/x-ndjson" } }
    );
  }

  // Session rate limit
  const rateLimit = checkRateLimit(sessionId);
  if (!rateLimit.allowed) {
    return new Response(
      JSON.stringify({
        type: "error",
        error: `You've reached the message limit for this session (${20} messages/hour). Please wait ${rateLimit.resetInMinutes} minute${rateLimit.resetInMinutes === 1 ? "" : "s"} before sending more.`,
        code: "RATE_LIMITED",
      }) + "\n",
      { status: 429, headers: { "Content-Type": "application/x-ndjson" } }
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          // client disconnected
        }
      };

      try {
        // Agentic loop: keep calling Claude until no more tool calls
        let currentMessages = [...messages];

        // eslint-disable-next-line no-constant-condition
        while (true) {
          const response = await anthropic.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 8192,
            system: getSystemPrompt(sessionId),
            messages: currentMessages,
            tools: TOOLS,
          });

          // Collect tool uses and text from this response
          const toolUses: Anthropic.ToolUseBlock[] = [];

          for (const block of response.content) {
            if (block.type === "text") {
              emit({ type: "text", text: block.text });
            } else if (block.type === "tool_use") {
              toolUses.push(block);
              emit({ type: "tool_use", name: block.name, id: block.id });
            }
          }

          // If no tool calls, we're done
          if (toolUses.length === 0 || response.stop_reason === "end_turn") {
            break;
          }

          // Execute all tool calls
          const toolResults: Anthropic.ToolResultBlockParam[] = [];

          for (const toolUse of toolUses) {
            const result = await executeTool(
              toolUse.name,
              toolUse.input as Record<string, unknown>,
              sessionId
            );

            emit({
              type: "tool_result",
              toolUseId: toolUse.id,
              toolName: toolUse.name,
              result,
            });

            toolResults.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: JSON.stringify(result),
            });
          }

          // Add assistant response + tool results to message history
          currentMessages = [
            ...currentMessages,
            { role: "assistant", content: response.content },
            { role: "user", content: toolResults },
          ];

          // If stop_reason is tool_use, continue the loop
          if (response.stop_reason !== "tool_use") break;
        }

        emit({ type: "done" });
      } catch (err) {
        emit({
          type: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
