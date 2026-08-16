import type { ServerResponse } from "node:http";
import type { Router } from "../lib/router.ts";
import { sendError, sendJson } from "../lib/router.ts";
import type { ConversationService, MockConversationService } from "../services/conversationService.ts";
import {
  type CopilotProvider,
  type CopilotTurnResult,
  COPILOT_FALLBACK_TEXT,
  buildProductionPayload,
  copilotProviderName,
} from "../services/copilotService.ts";

/**
 * Copilot bridge routes.
 *
 *   POST /api/copilot/turn                      — text-mode conversational turn
 *   GET  /api/copilot/state/:sessionId          — authoritative brief state
 *   POST /api/copilot/llm(/v1)/chat/completions — OpenAI-compatible endpoint the
 *        ElevenLabs agent's Custom LLM points at, so ElevenLabs delegates every
 *        spoken reply to Copilot. One brain — no double answers.
 */

interface TurnBody {
  sessionId?: string;
  userMessage?: string;
  conversationState?: Record<string, string | null | string[]>;
}

function conversationState(
  conversation: ConversationService,
  sessionId: string,
): Record<string, string | null> {
  const session = conversation.getSession(sessionId);
  const state: Record<string, string | null> = {};
  for (const r of session?.requirements ?? []) state[r.field] = r.value;
  return state;
}

function stateResponse(
  conversation: ConversationService,
  sessionId: string,
  turn?: CopilotTurnResult,
) {
  const session = conversation.getSession(sessionId);
  if (!session) return null;
  return {
    sessionId,
    phase: session.phase,
    complete: session.phase !== "gathering",
    requirementList: session.requirements,
    requirements: Object.fromEntries(
      session.requirements.filter((r) => r.value).map((r) => [r.field, r.value]),
    ),
    missing: session.requirements.filter((r) => !r.value).map((r) => r.field),
    provider: copilotProviderName(),
    ...(turn ? { degraded: turn.degraded === true } : {}),
  };
}

export function registerCopilotRoutes(
  router: Router,
  copilot: CopilotProvider,
  conversation: ConversationService & Partial<MockConversationService>,
): void {
  router.post("/api/copilot/turn", async ({ res, body }) => {
    const { sessionId, userMessage } = (body ?? {}) as TurnBody;
    if (!sessionId || typeof userMessage !== "string" || !userMessage.trim()) {
      return sendError(res, 400, "sessionId_and_userMessage_required");
    }
    if (!conversation.getSession(sessionId)) return sendError(res, 404, "session_not_found");

    const result = await copilot.turn({
      sessionId,
      userMessage: userMessage.trim(),
      conversationState: conversationState(conversation, sessionId),
    });

    const productionBrief =
      result.readyForProduction || result.forceGenerate === true
        ? (result.productionBrief ?? buildProductionPayload(sessionId, conversation))
        : result.productionBrief;

    sendJson(res, 200, {
      response: result.responseText,
      responseText: result.responseText,
      requirements: result.requirements,
      missing: result.missing,
      complete: result.complete,
      readyForProduction: result.readyForProduction,
      forceGenerate: result.forceGenerate === true,
      productionBrief,
      provider: result.provider,
      degraded: result.degraded === true,
      requirementList: conversation.getSession(sessionId)?.requirements ?? [],
      phase: conversation.getSession(sessionId)?.phase ?? "gathering",
    });
  });

  router.get("/api/copilot/state/:sessionId", ({ res, params }) => {
    const state = stateResponse(conversation, params.sessionId);
    if (!state) return sendError(res, 404, "session_not_found");
    sendJson(res, 200, state);
  });

  const chatCompletions = async ({
    res,
    body,
    req,
  }: {
    res: ServerResponse;
    body: unknown;
    req: import("node:http").IncomingMessage;
  }) => {
    // Optional shared-secret check (COPILOT_LLM_API_KEY set in ElevenLabs too).
    const expected = process.env.COPILOT_LLM_API_KEY;
    if (expected) {
      const got = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      if (got !== expected) return sendError(res, 401, "unauthorized");
    }

    const payload = (body ?? {}) as {
      messages?: Array<{ role?: string; content?: unknown }>;
      stream?: boolean;
      elevenlabs_extra_body?: { sessionId?: string };
    };
    const messages = Array.isArray(payload.messages) ? payload.messages : [];

    // Session id: custom-LLM extra body (primary) or a
    // creativeflow_session=<id> marker in any message (fallback).
    let sessionId = payload.elevenlabs_extra_body?.sessionId;
    if (!sessionId) {
      for (const m of messages) {
        const match = /creativeflow_session=([0-9a-f-]{16,})/i.exec(String(m.content ?? ""));
        if (match) {
          sessionId = match[1];
          break;
        }
      }
    }

    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const userMessage = String(lastUser?.content ?? "").trim();

    let text = COPILOT_FALLBACK_TEXT;
    if (sessionId && conversation.getSession(sessionId) && userMessage) {
      try {
        const result = await copilot.turn({
          sessionId,
          userMessage,
          conversationState: conversationState(conversation, sessionId),
        });
        text = result.responseText;
      } catch {
        text = COPILOT_FALLBACK_TEXT;
      }
    } else if (!userMessage) {
      text = "I'm listening — what are we creating today?";
    }

    const id = `chatcmpl-cf-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const model = "creativeflow-copilot";

    if (payload.stream === false) {
      return sendJson(res, 200, {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
        ],
      });
    }

    // SSE streaming (ElevenLabs default).
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    const chunk = (delta: Record<string, unknown>, finish: string | null) =>
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    res.write(chunk({ role: "assistant" }, null));
    res.write(chunk({ content: text }, null));
    res.write(chunk({}, "stop"));
    res.write("data: [DONE]\n\n");
    res.end();
  };

  router.post("/api/copilot/llm/v1/chat/completions", chatCompletions);
  router.post("/api/copilot/llm/chat/completions", chatCompletions);
}
