import type { Router } from "../lib/router.ts";
import { sendError, sendJson } from "../lib/router.ts";
import type { BriefService } from "../services/briefService.ts";
import type { ConversationService, MockConversationService } from "../services/conversationService.ts";

/**
 * Brief routes.
 *
 * POST /api/brief/build     → build a brief from a completed conversation
 * POST /api/brief/confirm   → client approves the brief
 * POST /api/brief/reopen    → client wants changes; conversation reopens
 * GET  /api/brief/:id       → fetch a brief
 */
export function registerBriefRoutes(
  router: Router,
  briefs: BriefService,
  conversation: ConversationService & Partial<MockConversationService>,
): void {
  router.post("/api/brief/build", ({ res, body }) => {
    const { sessionId } = (body ?? {}) as { sessionId?: string };
    if (!sessionId) return sendError(res, 400, "sessionId_required");
    const session = conversation.getSession(sessionId);
    if (!session) return sendError(res, 404, "session_not_found");
    const brief = briefs.buildBrief(session);
    sendJson(res, 201, { brief });
  });

  router.post("/api/brief/confirm", ({ res, body }) => {
    const { briefId } = (body ?? {}) as { briefId?: string };
    if (!briefId) return sendError(res, 400, "briefId_required");
    const brief = briefs.confirmBrief(briefId);
    sendJson(res, 200, { brief });
  });

  router.post("/api/brief/reopen", ({ res, body }) => {
    const { sessionId } = (body ?? {}) as { sessionId?: string };
    if (!sessionId) return sendError(res, 400, "sessionId_required");
    const session = conversation.reopen(sessionId);
    sendJson(res, 200, { session });
  });

  router.get("/api/brief/:id", ({ res, params }) => {
    const brief = briefs.getBrief(params.id);
    if (!brief) return sendError(res, 404, "brief_not_found");
    sendJson(res, 200, { brief });
  });
}
