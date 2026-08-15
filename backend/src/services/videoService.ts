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
      this.fail(job, errorText(err));
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

/** Coerce any thrown/returned error shape (string, Error, object) to text. */
export function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const m = (err as Record<string, unknown>).message;
    if (typeof m === "string" && m) return m;
    try {
      return JSON.stringify(err).slice(0, 500);
    } catch {
      return "video_generation_failed";
    }
  }
  return "video_generation_failed";
}

/** Never let credentials or auth headers leak into stored error strings. */
function sanitizeError(message: unknown): string {
  return errorText(message)
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
/*                                                                     */
/* Two transports, selected automatically:                             */
/*  - MCP (Streamable HTTP): COMPOSIO_MCP_URL set, or the key looks    */
/*    like a consumer key (ck_...). Endpoint defaults to               */
/*    https://connect.composio.dev/mcp, auth header x-consumer-api-key.*/
/*  - REST v3 execute API (backend.composio.dev, x-api-key) otherwise. */
/* ------------------------------------------------------------------ */

/** Parse a text/event-stream body and return the last JSON `data:` payload. */
export function parseSseJson(text: string): unknown {
  let last: unknown = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (!raw) continue;
    try {
      last = JSON.parse(raw);
    } catch {
      /* keep scanning — non-JSON keep-alive frames are normal */
    }
  }
  return last;
}

interface McpRpcResponse {
  result?: {
    isError?: boolean;
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  error?: unknown;
}

interface ComposioExecuteResponse {
  successful?: boolean;
  error?: unknown;
  data?: Record<string, unknown>;
}

export class ComposioVeoVideoService extends BaseVideoService {
  private apiKey: string;
  private baseUrl: string;
  private userId: string;
  private generateTimeoutMs: number;
  private waitTimeoutMs: number;
  private mcpUrl: string | null;
  private mcpSessionId: string | null = null;
  private mcpInit: Promise<void> | null = null;

  constructor(opts?: {
    apiKey?: string;
    baseUrl?: string;
    userId?: string;
    generateTimeoutMs?: number;
    waitTimeoutMs?: number;
    mcpUrl?: string | null;
  }) {
    super();
    this.apiKey = opts?.apiKey ?? process.env.COMPOSIO_API_KEY ?? "";
    this.baseUrl = (opts?.baseUrl ?? process.env.COMPOSIO_API_URL ?? "https://backend.composio.dev")
      .replace(/\/+$/, "");
    this.userId = opts?.userId ?? process.env.COMPOSIO_USER_ID ?? "default";
    this.generateTimeoutMs = opts?.generateTimeoutMs ?? 60_000;
    // GEMINI_WAIT_FOR_VIDEO polls internally; Veo jobs can take up to ~12 min.
    this.waitTimeoutMs = opts?.waitTimeoutMs ?? 14 * 60_000;
    // MCP transport: explicit URL wins; consumer keys (ck_...) default to
    // Composio's hosted MCP endpoint with the x-consumer-api-key header.
    const explicitRestUrl = Boolean(opts?.baseUrl ?? process.env.COMPOSIO_API_URL);
    this.mcpUrl =
      opts?.mcpUrl !== undefined
        ? opts.mcpUrl
        : process.env.COMPOSIO_MCP_URL ??
          // Consumer keys (ck_...) only work against the hosted MCP endpoint —
          // but an explicitly configured REST URL always takes precedence.
          (this.apiKey.startsWith("ck_") && !explicitRestUrl
            ? "https://connect.composio.dev/mcp"
            : null);
  }

  /* ----------------------------- MCP ------------------------------ */

  private mcpHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-consumer-api-key": this.apiKey,
    };
    if (this.mcpSessionId) h["mcp-session-id"] = this.mcpSessionId;
    return h;
  }

  private async mcpRpc(body: Record<string, unknown>, timeoutMs: number): Promise<McpRpcResponse | null> {
    const res = await fetch(this.mcpUrl as string, {
      method: "POST",
      headers: this.mcpHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.mcpSessionId = sid;
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`composio_mcp_http_${res.status}: ${sanitizeError(text).slice(0, 200)}`);
    }
    if (!text.trim()) return null; // notifications answer with an empty body
    const ct = res.headers.get("content-type") ?? "";
    const json = (ct.includes("text/event-stream") ? parseSseJson(text) : JSON.parse(text)) as
      | McpRpcResponse
      | null;
    if (json && typeof json === "object" && json.error) {
      throw new Error(`composio_mcp_rpc: ${sanitizeError(json.error).slice(0, 250)}`);
    }
    return json;
  }

  private async mcpEnsureSession(): Promise<void> {
    if (this.mcpSessionId) return;
    if (!this.mcpInit) {
      this.mcpInit = (async () => {
        await this.mcpRpc(
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              clientInfo: { name: "creativeflow", version: "1.0.0" },
            },
          },
          30_000,
        );
        await this.mcpRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, 15_000).catch(
          () => {
            /* some servers skip the ack — not fatal */
          },
        );
      })().catch((err: unknown) => {
        this.mcpInit = null; // allow a retry on the next job
        throw err;
      });
    }
    await this.mcpInit;
  }

  private async executeMcp(
    toolSlug: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<ComposioExecuteResponse> {
    await this.mcpEnsureSession();
    const rpc = await this.mcpRpc(
      {
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: { name: toolSlug, arguments: args },
      },
      timeoutMs,
    );
    const result = rpc?.result ?? {};
    let payload: unknown = result.structuredContent ?? null;
    if (!payload && Array.isArray(result.content)) {
      const t = result.content.find((c) => c?.type === "text" && typeof c.text === "string");
      if (t?.text) {
        try {
          payload = JSON.parse(t.text);
        } catch {
          payload = { successful: !result.isError, error: result.isError ? t.text : null };
        }
      }
    }
    if (result.isError) {
      throw new Error(
        `composio_mcp_${toolSlug.toLowerCase()}_failed: ${sanitizeError(payload ?? "tool_error").slice(0, 250)}`,
      );
    }
    if (!payload || typeof payload !== "object") {
      throw new Error(`composio_mcp_${toolSlug.toLowerCase()}_invalid_result`);
    }
    const obj = payload as Record<string, unknown>;
    // Composio tools wrap output as {successful, error, data}; accept raw data too.
    if ("successful" in obj || "data" in obj) return obj as ComposioExecuteResponse;
    return { successful: true, data: obj };
  }

  private async execute(
    toolSlug: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<ComposioExecuteResponse> {
    if (this.mcpUrl) return this.executeMcp(toolSlug, args, timeoutMs);
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
        `composio_${toolSlug.toLowerCase()}_http_${res.status}: ${sanitizeError(json?.error ?? text ?? "").slice(0, 200)}`,
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
      this.fail(job, gen.error ? errorText(gen.error) : "veo_generate_failed");
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
      this.fail(job, wait.error ? errorText(wait.error) : "veo_wait_failed");
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
