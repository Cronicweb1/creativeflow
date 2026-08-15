import type { Router } from "../lib/router.ts";
import { sendError, sendJson } from "../lib/router.ts";
import type { ConversationService, MockConversationService } from "../services/conversationService.ts";

/**
 * Demo session routes.
 *
 * POST /api/demo/session          → start a call session
 * POST /api/demo/message          → send one client utterance
 * GET  /api/demo/session/:id      → fetch full session state
 *
 * The message endpoint accepts any text — typed, canned, or (later) a
 * microphone transcript from the browser voice layer.
 */
export function registerDemoRoutes(
  router: Router,
  conversation: ConversationService & Partial<MockConversationService>,
): void {
  router.post("/api/demo/session", ({ res }) => {
    const session = conversation.startSession();
    sendJson(res, 201, {
      session,
      suggestedResponses: conversation.initialSuggestions?.() ?? [],
    });
  });

  router.get("/api/demo/session/:id", ({ res, params }) => {
    const session = conversation.getSession(params.id);
    if (!session) return sendError(res, 404, "session_not_found");
    sendJson(res, 200, { session });
  });

  router.post("/api/demo/message", ({ res, body }) => {
    const { sessionId, text } = (body ?? {}) as { sessionId?: string; text?: string };
    if (!sessionId || typeof text !== "string" || !text.trim()) {
      return sendError(res, 400, "sessionId_and_text_required");
    }
    const turn = conversation.handleClientMessage(sessionId, text.trim());
    sendJson(res, 200, turn);
  });
}
