import type { Router } from "../lib/router.ts";
import { sendError, sendJson } from "../lib/router.ts";
import type { BriefService } from "../services/briefService.ts";
import type { ProductionService } from "../services/productionService.ts";

/**
 * Production routes.
 *
 * POST /api/production/start   → start a production job for a confirmed brief
 * GET  /api/production/:id     → poll job state (stages, assets, summary)
 */
export function registerProductionRoutes(
  router: Router,
  production: ProductionService,
  briefs: BriefService,
): void {
  router.post("/api/production/start", ({ res, body }) => {
    const { briefId } = (body ?? {}) as { briefId?: string };
    if (!briefId) return sendError(res, 400, "briefId_required");
    const brief = briefs.getBrief(briefId);
    if (!brief) return sendError(res, 404, "brief_not_found");
    if (!brief.confirmedAt) return sendError(res, 409, "brief_not_confirmed");
    const job = production.start(brief);
    sendJson(res, 201, { job });
  });

  router.get("/api/production/:id", ({ res, params }) => {
    const job = production.get(params.id);
    if (!job) return sendError(res, 404, "job_not_found");
    sendJson(res, 200, { job });
  });
}
