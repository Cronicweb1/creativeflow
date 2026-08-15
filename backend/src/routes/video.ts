import type { Router } from "../lib/router.ts";
import { sendError, sendJson } from "../lib/router.ts";
import type { VideoService } from "../services/videoService.ts";

/**
 * Video-generation routes — called by the Activepieces "Generate Video"
 * branch once the creative brief is complete.
 *
 * POST /api/video/generate            → start an async Gemini/Veo job (202)
 * GET  /api/video/status/:jobId       → poll job state
 * GET  /api/video/session/:sessionId  → latest job for a session (frontend
 *                                       discovery: Activepieces starts jobs
 *                                       directly, so the browser looks the
 *                                       job up by its sessionId)
 *
 * The Composio/Gemini credentials live only in server env vars; this
 * endpoint never returns them and the browser never sees them.
 */
export function registerVideoRoutes(router: Router, video: VideoService): void {
  // Latest jobId started per session — powers frontend discovery and makes
  // POST /generate idempotent while a session's job is still generating
  // (Activepieces and the frontend may both call it; only one job runs).
  const latestBySession = new Map<string, string>();

  router.post("/api/video/generate", ({ res, body }) => {
    const { sessionId, productionBrief } = (body ?? {}) as {
      sessionId?: unknown;
      productionBrief?: unknown;
    };
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      return sendError(res, 400, "sessionId_required");
    }
    if (
      !productionBrief ||
      typeof productionBrief !== "object" ||
      Array.isArray(productionBrief) ||
      Object.keys(productionBrief as Record<string, unknown>).length === 0
    ) {
      return sendError(res, 400, "productionBrief_required");
    }

    const sid = sessionId.trim();
    const existingId = latestBySession.get(sid);
    const existing = existingId ? video.get(existingId) : null;
    if (existing && existing.status === "generating") {
      // Duplicate request while a job is still running → same job, no
      // double generation.
      return sendJson(res, 202, {
        status: "generating",
        jobId: existing.jobId,
        message: "Video generation started.",
      });
    }

    const job = video.start(sid, productionBrief as Record<string, unknown>);
    latestBySession.set(sid, job.jobId);
    // 202 Accepted — generation continues in the background.
    sendJson(res, 202, {
      status: "generating",
      jobId: job.jobId,
      message: "Video generation started.",
    });
  });

  router.get("/api/video/session/:sessionId", ({ res, params }) => {
    const jobId = latestBySession.get(params.sessionId);
    const job = jobId ? video.get(jobId) : null;
    if (!job) return sendError(res, 404, "job_not_found");
    sendJobState(res, job);
  });

  router.get("/api/video/status/:jobId", ({ res, params }) => {
    const job = video.get(params.jobId);
    if (!job) return sendError(res, 404, "job_not_found");
    sendJobState(res, job);
  });
}

function sendJobState(
  res: Parameters<typeof sendJson>[0],
  job: NonNullable<ReturnType<VideoService["get"]>>,
): void {
  if (job.status === "completed") {
    return sendJson(res, 200, {
      status: "completed",
      jobId: job.jobId,
      videoUrl: job.videoUrl,
      downloadUrl: job.downloadUrl ?? job.videoUrl,
    });
  }
  if (job.status === "failed") {
    return sendJson(res, 200, {
      status: "failed",
      jobId: job.jobId,
      error: job.error ?? "video_generation_failed",
    });
  }
  sendJson(res, 200, { status: "generating", jobId: job.jobId, videoUrl: null });
}
