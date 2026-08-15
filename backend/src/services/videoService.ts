/**
 * Video generation service — Creative brief → Composio → Gemini Veo.
 *
 * Providers:
 *  - ComposioVeoVideoService (VIDEO_GEN_PROVIDER=composio, or auto when
 *    COMPOSIO_API_KEY is set): executes the Composio-hosted Gemini tools
 *    GEMINI_GENERATE_VIDEOS + GEMINI_WAIT_FOR_VIDEO server-side. The
 *    Composio API key never leaves the server.
 *  - MockVideoService (default when unconfigured): simulates generation so
 *    the showcase works end-to-end without credentials.
 *
 * Contract (used by routes/video.ts):
 *   start(sessionId, brief) -> VideoJob   (returns immediately; work is async)
 *   get(jobId)              -> VideoJob | null
 */

import crypto from "node:crypto";

export type VideoJobStatus = "generating" | "completed" | "failed";

export interface VideoJob {
  jobId: string;
  sessionId: string;
  status: VideoJobStatus;
  videoUrl: string | null;
  downloadUrl: string | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface VideoService {
  start(sessionId: string, productionBrief: Record<string, unknown>): VideoJob;
  get(jobId: string): VideoJob | null;
}

/* ------------------------------------------------------------------ */
/* Prompt building                                                     */
/* ------------------------------------------------------------------ */

const BRIEF_FIELDS = [
  "client",
  "product",
  "campaign",
  "platform",
  "contentType",
  "visualStyle",
  "audience",
  "duration",
  "aspectRatio",
] as const;

function briefValue(brief: Record<string, unknown>, field: string): string | null {
  // Accept flat briefs, { brief: {...} } wrappers, and requirement arrays.
  const flat = brief[field];
  if (typeof flat === "string" && flat.trim()) return flat.trim();
  const nested = brief.brief;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const v = (nested as Record<string, unknown>)[field];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  const reqs = brief.requirements;
  if (Array.isArray(reqs)) {
    for (const r of reqs) {
      if (r && typeof r === "object" && (r as Record<string, unknown>).field === field) {
        const v = (r as Record<string, unknown>).value;
        if (typeof v === "string" && v.trim()) return v.trim();
      }
    }
  } else if (reqs && typeof reqs === "object") {
    const v = (reqs as Record<string, unknown>)[field];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** Compose a cinematic Veo prompt from whatever brief fields are present. */
export function buildVideoPrompt(brief: Record<string, unknown>): string {
  const get = (f: string) => briefValue(brief, f);
  const parts: string[] = [];
  const contentType = get("contentType") ?? "advertisement";
  const product = get("product");
  const client = get("client");
  const platform = get("platform");
  const style = get("visualStyle");
  const audience = get("audience");
  const campaign = get("campaign");

  parts.push(
    `A high-production ${contentType}${product ? ` for ${product}` : ""}${client ? ` by ${client}` : ""}.`,
  );
  if (style) parts.push(`Visual style: ${style}.`);
  if (platform) parts.push(`Optimized for ${platform}.`);
  if (audience) parts.push(`Target audience: ${audience}.`);
  if (campaign) parts.push(`Campaign: ${campaign}.`);
  parts.push(
    "Professional cinematography, smooth camera movement, polished lighting, no on-screen text or captions.",
  );
  const prompt = parts.join(" ");
  // Fallback if the brief carried nothing usable.
  return prompt.trim() || "A cinematic product advertisement with professional lighting.";
}

export function briefDurationSeconds(brief: Record<string, unknown>): 4 | 6 | 8 {
  const raw = briefValue(brief, "duration") ?? "";
  const m = raw.match(/(\d+)/);
  if (!m) return 8;
  const n = Number(m[1]);
  if (n <= 4) return 4;
  if (n <= 6) return 6;
  return 8;
}

export function briefAspectRatio(brief: Record<string, unknown>): "16:9" | "9:16" {
  const raw = (briefValue(brief, "aspectRatio") ?? "").toLowerCase();
  if (raw.includes("9:16") || raw.includes("vertical") || raw.includes("portrait")) return "9:16";
  return "16:9";
}

/* ------------------------------------------------------------------ */
/* Base job store                                                      */
/* ------------------------------------------------------------------ */

abstract class BaseVideoService implements VideoService {
  protected jobs = new Map<string, VideoJob>();

  start(sessionId: string, productionBrief: Record<string, unknown>): VideoJob {
    const job: VideoJob = {
      jobId: `vid-${crypto.randomUUID()}`,
      sessionId,
      status: "generating",
      videoUrl: null,
      downloadUrl: null,
      error: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    this.jobs.set(job.jobId, job);
    // Fire and forget — never block the HTTP request.
    void this.run(job, productionBrief).catch((err: unknown) => {
      this.fail(job, err instanceof Error ? err.message : "video_generation_failed");
    });
    return job;
  }

  get(jobId: string): VideoJob | null {
    return this.jobs.get(jobId) ?? null;
  }

  protected complete(job: VideoJob, videoUrl: string, downloadUrl?: string): void {
    job.status = "completed";
    job.videoUrl = videoUrl;
    job.downloadUrl = downloadUrl ?? videoUrl;
    job.completedAt = new Date().toISOString();
  }

  protected fail(job: VideoJob, error: string): void {
    job.status = "failed";
    job.error = sanitizeError(error);
    job.completedAt = new Date().toISOString();
  }

  protected abstract run(job: VideoJob, brief: Record<string, unknown>): Promise<void>;
}

/** Never let credentials or auth headers leak into stored error strings. */
function sanitizeError(message: string): string {
  return message
    .replace(/(x-api-key|api[_-]?key|bearer)\s*[:=]\s*\S+/gi, "$1: [redacted]")
    .slice(0, 500);
}

/* ------------------------------------------------------------------ */
/* Mock provider                                                       */
/* ------------------------------------------------------------------ */

export class MockVideoService extends BaseVideoService {
  private delayMs: number;
  private sampleUrl: string;

  constructor(delayMs?: number, sampleUrl?: string) {
    super();
    this.delayMs = delayMs ?? Number(process.env.MOCK_VIDEO_DELAY_MS ?? 4000);
    this.sampleUrl =
      sampleUrl ??
      process.env.MOCK_VIDEO_SAMPLE_URL ??
      "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4";
  }

  protected async run(job: VideoJob): Promise<void> {
    await new Promise((r) => setTimeout(r, this.delayMs));
    if (job.status !== "generating") return;
    this.complete(job, this.sampleUrl);
  }
}

/* ------------------------------------------------------------------ */
/* Composio → Gemini Veo provider                                      */
/* ------------------------------------------------------------------ */

interface ComposioExecuteResponse {
  successful?: boolean;
  error?: string | null;
  data?: Record<string, unknown>;
}

export class ComposioVeoVideoService extends BaseVideoService {
  private apiKey: string;
  private baseUrl: string;
  private userId: string;
  private generateTimeoutMs: number;
  private waitTimeoutMs: number;

  constructor(opts?: {
    apiKey?: string;
    baseUrl?: string;
    userId?: string;
    generateTimeoutMs?: number;
    waitTimeoutMs?: number;
  }) {
    super();
    this.apiKey = opts?.apiKey ?? process.env.COMPOSIO_API_KEY ?? "";
    this.baseUrl = (opts?.baseUrl ?? process.env.COMPOSIO_API_URL ?? "https://backend.composio.dev")
      .replace(/\/+$/, "");
    this.userId = opts?.userId ?? process.env.COMPOSIO_USER_ID ?? "default";
    this.generateTimeoutMs = opts?.generateTimeoutMs ?? 60_000;
    // GEMINI_WAIT_FOR_VIDEO polls internally; Veo jobs can take up to ~12 min.
    this.waitTimeoutMs = opts?.waitTimeoutMs ?? 14 * 60_000;
  }

  private async execute(
    toolSlug: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<ComposioExecuteResponse> {
    const res = await fetch(`${this.baseUrl}/api/v3/tools/execute/${toolSlug}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
      },
      body: JSON.stringify({ user_id: this.userId, arguments: args }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json: ComposioExecuteResponse | null = null;
    try {
      json = JSON.parse(text) as ComposioExecuteResponse;
    } catch {
      /* non-JSON error body */
    }
    if (!res.ok) {
      throw new Error(
        `composio_${toolSlug.toLowerCase()}_http_${res.status}: ${sanitizeError((json?.error as string) ?? text ?? "").slice(0, 200)}`,
      );
    }
    if (!json) throw new Error(`composio_${toolSlug.toLowerCase()}_invalid_response`);
    return json;
  }

  protected async run(job: VideoJob, brief: Record<string, unknown>): Promise<void> {
    // 1. Kick off the Veo generation job.
    const gen = await this.execute(
      "GEMINI_GENERATE_VIDEOS",
      {
        prompt: buildVideoPrompt(brief),
        duration_seconds: briefDurationSeconds(brief),
        aspect_ratio: briefAspectRatio(brief),
        resolution: "720p",
      },
      this.generateTimeoutMs,
    );
    if (gen.successful === false) {
      this.fail(job, gen.error ?? "veo_generate_failed");
      return;
    }
    const operationName = gen.data?.operation_name;
    if (typeof operationName !== "string" || !operationName) {
      this.fail(job, "veo_generate_missing_operation_name");
      return;
    }

    // 2. Wait for completion (Composio polls Gemini internally and returns
    //    a downloadable file when done).
    const wait = await this.execute(
      "GEMINI_WAIT_FOR_VIDEO",
      { operation_name: operationName },
      this.waitTimeoutMs,
    );
    if (wait.successful === false) {
      this.fail(job, wait.error ?? "veo_wait_failed");
      return;
    }
    const data = wait.data ?? {};
    const videoFile = data.video_file as Record<string, unknown> | undefined;
    const url = typeof videoFile?.s3url === "string" ? videoFile.s3url : null;
    if (!url) {
      const rai = data.rai_filtering as Record<string, unknown> | undefined;
      const reason =
        typeof rai?.message === "string" && rai.message
          ? `safety_filtered: ${rai.message}`
          : "veo_completed_without_video";
      this.fail(job, reason);
      return;
    }
    this.complete(job, url, url);
  }
}

/* ------------------------------------------------------------------ */
/* Provider selection                                                  */
/* ------------------------------------------------------------------ */

export function videoProviderName(): "composio" | "mock" {
  const explicit = (process.env.VIDEO_GEN_PROVIDER ?? "").toLowerCase();
  if (explicit === "composio") return "composio";
  if (explicit === "mock") return "mock";
  return process.env.COMPOSIO_API_KEY ? "composio" : "mock";
}

export function createVideoService(): VideoService {
  return videoProviderName() === "composio"
    ? new ComposioVeoVideoService()
    : new MockVideoService();
}
