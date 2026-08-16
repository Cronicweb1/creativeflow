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
import {
  SdkComposioSessionFactory,
  composioUserId,
  type ComposioMcpEndpoint,
  type ComposioSessionFactory,
  type ComposioSessionHandle,
} from "./composioSession.ts";

export type VideoJobStatus = "generating" | "completed" | "failed";

export interface VideoJob {
  jobId: string;
  sessionId: string;
  status: VideoJobStatus;
  videoUrl: string | null;
  downloadUrl: string | null;
  error: string | null;
  /** Full sanitized upstream error (internal; never sent to clients). */
  errorDetail?: string | null;
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
  // The user's actual product is the HERO SUBJECT — never let Veo drift into
  // a generic portrait/lifestyle video that omits it.
  if (product && !/^the (featured|user'?s) product$/i.test(product.trim())) {
    parts.push(
      `The ${product} is the hero subject of every shot: clearly show the ${product}, its packaging and presentation, in an attractive product-focused composition. Do not turn the advertisement into a generic portrait or lifestyle video without the ${product}.`,
    );
  }
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

  protected fail(job: VideoJob, error: string, detail?: string): void {
    job.errorDetail = sanitizeError(detail ?? error, 2000);
    job.status = "failed";
    job.error = sanitizeError(error);
    job.completedAt = new Date().toISOString();
  }

  protected abstract run(job: VideoJob, brief: Record<string, unknown>): Promise<void>;
}

/** Coerce any thrown/returned error shape (string, Error, object) to text. */
export function errorText(err: unknown, maxLen = 500): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const m = (err as Record<string, unknown>).message;
    if (typeof m === "string" && m) return m;
    try {
      return JSON.stringify(err).slice(0, maxLen);
    } catch {
      return "video_generation_failed";
    }
  }
  return "video_generation_failed";
}

/** Never let credentials or auth headers leak into stored error strings. */
function sanitizeError(message: unknown, maxLen = 500): string {
  return errorText(message, maxLen)
    .replace(/(x-api-key|api[_-]?key|bearer)\s*[:=]\s*\S+/gi, "$1: [redacted]")
    .slice(0, maxLen);
}

/* ------------------------------------------------------------------ */
/* Quota / retry helpers (Fix E)                                       */
/* ------------------------------------------------------------------ */

/** Veo model pinned to what Composio-managed shared credentials support. */
export const VEO_MODEL = "veo-3.1-lite-generate-preview";

/** True when an upstream error is HTTP 429 / RESOURCE_EXHAUSTED (quota). */
export function isQuotaExhausted(text: string): boolean {
  return /(\b429\b|RESOURCE_EXHAUSTED|exceeded\s+your\s+current\s+quota|quota\s+exceeded)/i.test(text);
}

/**
 * Extract Google's suggested retryDelay ("34s" / "12.5s") from an upstream
 * error blob. Returns milliseconds, capped for safety, or null if absent.
 */
export function parseRetryDelayMs(text: string, capMs = 120_000): number | null {
  const m = /retryDelay["'\s:]+["']?(\d+(?:\.\d+)?)s/i.exec(text);
  if (!m) return null;
  const ms = Math.round(parseFloat(m[1]) * 1000);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(ms, capMs);
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
/* Transport: a Composio *session* created through the @composio/core  */
/* SDK (composio.sessions.create). Every session exposes its own       */
/* hosted MCP endpoint — session.mcp.url + session.mcp.headers — and   */
/* tool calls are MCP tools/call requests against that endpoint. The   */
/* generic https://connect.composio.dev/mcp endpoint and the manual    */
/* x-consumer-api-key header are no longer used.                       */
/*                                                                     */
/* A test/dev REST override remains: when COMPOSIO_API_URL is set the  */
/* provider calls <url>/api/v3/tools/execute/<TOOL> directly (this is  */
/* how the spawned-server tests mock Composio without the SDK).        */
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

/**
 * MCP client bound to ONE Composio session endpoint (session.mcp.url).
 * Handles the initialize handshake and tools/call requests, tracking the
 * mcp-session-id header the server assigns.
 */
export class McpToolClient {
  private endpoint: ComposioMcpEndpoint;
  private mcpSessionId: string | null = null;
  private init: Promise<void> | null = null;

  constructor(endpoint: ComposioMcpEndpoint) {
    this.endpoint = endpoint;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      ...this.endpoint.headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.mcpSessionId) h["mcp-session-id"] = this.mcpSessionId;
    return h;
  }

  private async rpc(body: Record<string, unknown>, timeoutMs: number): Promise<McpRpcResponse | null> {
    const res = await fetch(this.endpoint.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.mcpSessionId = sid;
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`composio_mcp_http_${res.status}: ${sanitizeError(text, 800).slice(0, 800)}`);
    }
    if (!text.trim()) return null; // notifications answer with an empty body
    const ct = res.headers.get("content-type") ?? "";
    const json = (ct.includes("text/event-stream") ? parseSseJson(text) : JSON.parse(text)) as
      | McpRpcResponse
      | null;
    if (json && typeof json === "object" && json.error) {
      throw new Error(`composio_mcp_rpc: ${sanitizeError(json.error, 800).slice(0, 800)}`);
    }
    return json;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.mcpSessionId) return;
    if (!this.init) {
      this.init = (async () => {
        await this.rpc(
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
        await this.rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, 15_000).catch(() => {
          /* some servers skip the ack — not fatal */
        });
      })().catch((err: unknown) => {
        this.init = null; // allow a retry on the next job
        throw err;
      });
    }
    await this.init;
  }

  async executeTool(
    toolSlug: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<ComposioExecuteResponse> {
    await this.ensureInitialized();
    const rpc = await this.rpc(
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
        `composio_mcp_${toolSlug.toLowerCase()}_failed: ${sanitizeError(payload ?? "tool_error", 800).slice(0, 800)}`,
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
}

export class ComposioVeoVideoService extends BaseVideoService {
  private apiKey: string;
  private restUrl: string | null;
  private generateTimeoutMs: number;
  private waitTimeoutMs: number;
  private sessionFactory: ComposioSessionFactory;
  /** Injectable sleep so retry timing is testable without real waits. */
  private sleep: (ms: number) => Promise<void>;
  /** Fallback retry delays (ms) when upstream gives no retryDelay. */
  private retryDelaysMs: number[];
  /** Max retries after the initial GEMINI_GENERATE_VIDEOS attempt. */
  private maxGenerateRetries: number;
  /** One Composio session (and MCP client) per CreativeFlow session. */
  private sessionClients = new Map<string, Promise<McpToolClient>>();
  /** Persisted Composio session ids so a session can be re-attached. */
  private composioSessionIds = new Map<string, string>();

  constructor(opts?: {
    apiKey?: string;
    restUrl?: string | null;
    sessionFactory?: ComposioSessionFactory;
    generateTimeoutMs?: number;
    waitTimeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    retryDelaysMs?: number[];
    maxGenerateRetries?: number;
  }) {
    super();
    this.apiKey = opts?.apiKey ?? process.env.COMPOSIO_API_KEY ?? "";
    // Test/dev override only: direct REST execute against a mock server.
    const envRest = (process.env.COMPOSIO_API_URL ?? "").trim();
    this.restUrl =
      opts?.restUrl !== undefined ? opts.restUrl : envRest ? envRest.replace(/\/+$/, "") : null;
    this.generateTimeoutMs = opts?.generateTimeoutMs ?? 60_000;
    // GEMINI_WAIT_FOR_VIDEO polls internally; Veo jobs can take up to ~12 min.
    this.waitTimeoutMs = opts?.waitTimeoutMs ?? 14 * 60_000;
    this.sessionFactory = opts?.sessionFactory ?? new SdkComposioSessionFactory({ apiKey: this.apiKey || undefined });
    this.sleep = opts?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.retryDelaysMs = opts?.retryDelaysMs ?? [30_000, 60_000];
    this.maxGenerateRetries = opts?.maxGenerateRetries ?? 2;
  }

  /** Create (or reuse) the Composio session for a CreativeFlow session. */
  private clientFor(creativeflowSessionId: string): Promise<McpToolClient> {
    const userId = composioUserId(creativeflowSessionId);
    let client = this.sessionClients.get(userId);
    if (!client) {
      client = (async () => {
        const existingId = this.composioSessionIds.get(userId);
        let handle: ComposioSessionHandle;
        if (existingId) {
          // Re-attach to the persisted Composio session where possible.
          try {
            handle = await this.sessionFactory.useSession(existingId);
          } catch {
            handle = await this.sessionFactory.createSession(userId);
          }
        } else {
          handle = await this.sessionFactory.createSession(userId);
        }
        this.composioSessionIds.set(userId, handle.composioSessionId);
        return new McpToolClient(handle.mcp);
      })().catch((err: unknown) => {
        this.sessionClients.delete(userId); // allow retry on next job
        throw err;
      });
      this.sessionClients.set(userId, client);
    }
    return client;
  }

  private async execute(
    sessionId: string,
    toolSlug: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<ComposioExecuteResponse> {
    if (this.restUrl) {
      // Test/dev REST override (mock Composio server).
      const res = await fetch(`${this.restUrl}/api/v3/tools/execute/${toolSlug}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
        },
        body: JSON.stringify({ user_id: composioUserId(sessionId), arguments: args }),
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
    const client = await this.clientFor(sessionId);
    return client.executeTool(toolSlug, args, timeoutMs);
  }

  protected async run(job: VideoJob, brief: Record<string, unknown>): Promise<void> {
    // 1. Kick off the Veo generation job. Quota errors (429 /
    //    RESOURCE_EXHAUSTED) get a bounded retry: up to maxGenerateRetries
    //    additional FRESH generate calls (a failed attempt's operation_name
    //    is never reused). All other failures fail immediately.
    const genArgs = {
      model: VEO_MODEL,
      prompt: buildVideoPrompt(brief),
      duration_seconds: briefDurationSeconds(brief),
      aspect_ratio: briefAspectRatio(brief),
      resolution: "720p",
    };
    let operationName: string | null = null;
    for (let attempt = 0; ; attempt++) {
      let failure: string | null = null;
      try {
        const gen = await this.execute(
          job.sessionId,
          "GEMINI_GENERATE_VIDEOS",
          genArgs,
          this.generateTimeoutMs,
        );
        if (gen.successful === false) {
          failure = gen.error ? errorText(gen.error, 2000) : "veo_generate_failed";
        } else {
          const op = gen.data?.operation_name;
          if (typeof op !== "string" || !op) {
            this.fail(job, "veo_generate_missing_operation_name");
            return;
          }
          operationName = op;
          break;
        }
      } catch (err: unknown) {
        failure = errorText(err, 2000);
      }
      if (!isQuotaExhausted(failure)) {
        // 400/401/403/404/safety/etc. - never retried.
        this.fail(job, failure);
        return;
      }
      if (attempt >= this.maxGenerateRetries) {
        // Final quota failure: friendly message out, full detail retained.
        this.fail(job, "Veo generation quota temporarily exhausted after retries.", failure);
        return;
      }
      const delayMs =
        parseRetryDelayMs(failure) ??
        this.retryDelaysMs[Math.min(attempt, this.retryDelaysMs.length - 1)];
      await this.sleep(delayMs);
    }

    // 2. Wait for completion (Composio polls Gemini internally and returns
    //    a downloadable file when done).
    const wait = await this.execute(
      job.sessionId,
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
