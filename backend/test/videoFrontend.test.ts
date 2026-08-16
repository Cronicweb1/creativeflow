/**
 * Frontend video-integration tests (node --test).
 *
 * Imports the DOM-free tracker module frontend/public/js/videoStatus.js
 * directly (dependency-injected fetch/timers) and covers:
 *   1. generating state after job discovery
 *   2. polling cadence (every intervalMs)
 *   3. completed video with a real videoUrl + downloadUrl
 *   4. failed generation -> friendly failure state
 *   5. timeout after timeoutMs
 *   6. duplicate prevention (one session = one tracking run)
 *   7. never fabricates a URL ("completed" without videoUrl -> failed)
 *   8. discovery fallback POSTs /api/video/generate with the brief
 *
 * Plus backend integration: per-session dedup and GET /api/video/session/:id.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// @ts-ignore - plain browser ES module, DOM-free at import time
import { createVideoTracker, saveActiveJob, loadActiveJob, clearActiveJob } from "../../frontend/public/js/videoStatus.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SERVER = resolve(ROOT, "backend/src/server.ts");
const URL_OK = "https://cdn.example.com/veo/final.mp4";

type Call = { method: string; path: string; body?: unknown };

function harness(script: Array<(call: Call) => unknown>, opts: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const updates: any[] = [];
  const delays: number[] = [];
  let clock = 0;
  const tracker = createVideoTracker({
    fetchJson: async (method: string, path: string, body?: unknown) => {
      const call = { method, path, body };
      calls.push(call);
      const handler = script.length > 1 ? script.shift()! : script[0];
      const out = handler(call);
      if (out instanceof Error) throw out;
      return out;
    },
    onUpdate: (s: any) => updates.push(s),
    now: () => clock,
    delay: async (ms: number) => {
      delays.push(ms);
      clock += ms;
    },
    ...opts,
  });
  return { tracker, calls, updates, delays };
}

const err404 = () => Object.assign(new Error("job_not_found"), { status: 404 });

test("tracker: discovers session job and reports generating state", async () => {
  const { tracker, updates } = harness([
    () => ({ status: "generating", jobId: "vid-1", videoUrl: null }),
    () => ({ status: "generating", jobId: "vid-1", videoUrl: null }),
    () => ({ status: "completed", jobId: "vid-1", videoUrl: URL_OK, downloadUrl: URL_OK }),
  ]);
  const final = await tracker.track({ sessionId: "s1" });
  assert.equal(final.phase, "completed");
  const phases = updates.map((u) => u.phase);
  assert.ok(phases.includes("starting"));
  assert.ok(phases.includes("generating"));
  assert.equal(updates.find((u) => u.jobId)?.jobId, "vid-1");
});

test("tracker: polls every intervalMs", async () => {
  const { tracker, delays } = harness(
    [
      () => ({ status: "generating", jobId: "vid-2", videoUrl: null }),
      () => ({ status: "generating", jobId: "vid-2", videoUrl: null }),
      () => ({ status: "generating", jobId: "vid-2", videoUrl: null }),
      () => ({ status: "completed", jobId: "vid-2", videoUrl: URL_OK }),
    ],
    { intervalMs: 5000 },
  );
  await tracker.track({ sessionId: "s2" });
  assert.deepEqual(delays, [5000, 5000]); // two generating polls before completion
});

test("tracker: completed exposes real videoUrl and downloadUrl", async () => {
  const dl = "https://cdn.example.com/veo/final-download.mp4";
  const { tracker } = harness([
    () => ({ status: "generating", jobId: "vid-3", videoUrl: null }),
    () => ({ status: "completed", jobId: "vid-3", videoUrl: URL_OK, downloadUrl: dl }),
  ]);
  const final = await tracker.track({ sessionId: "s3" });
  assert.equal(final.phase, "completed");
  assert.equal(final.videoUrl, URL_OK);
  assert.equal(final.downloadUrl, dl);
});

test("tracker: never fabricates a URL — completed without videoUrl fails", async () => {
  const { tracker } = harness([
    () => ({ status: "generating", jobId: "vid-4", videoUrl: null }),
    () => ({ status: "completed", jobId: "vid-4", videoUrl: "not-a-url" }),
  ]);
  const final = await tracker.track({ sessionId: "s4" });
  assert.equal(final.phase, "failed");
  assert.equal(final.videoUrl, undefined);
});

test("tracker: failed generation -> friendly failure, no stack traces", async () => {
  const { tracker } = harness([
    () => ({ status: "generating", jobId: "vid-5", videoUrl: null }),
    () => ({ status: "failed", jobId: "vid-5", error: "composio_gemini_http_500: boom" }),
  ]);
  const final = await tracker.track({ sessionId: "s5" });
  assert.equal(final.phase, "failed");
  assert.ok(!/composio|http_500|stack/i.test(final.error));
});

test("tracker: stops polling after timeoutMs", async () => {
  const { tracker, calls } = harness(
    [() => ({ status: "generating", jobId: "vid-6", videoUrl: null })],
    { intervalMs: 5000, timeoutMs: 600000 },
  );
  const final = await tracker.track({ sessionId: "s6" });
  assert.equal(final.phase, "timeout");
  // 1 discovery + polls until the injected clock passes 10 minutes
  assert.ok(calls.length <= 600000 / 5000 + 2);
});

test("tracker: duplicate prevention — second track() reuses the first run", async () => {
  const { tracker, calls } = harness([
    () => ({ status: "generating", jobId: "vid-7", videoUrl: null }),
    () => ({ status: "completed", jobId: "vid-7", videoUrl: URL_OK }),
  ]);
  const p1 = tracker.track({ sessionId: "s7" });
  const p2 = tracker.track({ sessionId: "s7" });
  assert.equal(p1, p2);
  assert.equal(tracker.isTracking("s7"), true);
  await p1;
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
});

test("tracker: discovery 404s fall back to POST /api/video/generate with the brief", async () => {
  const brief = { product: "Serum", platform: "Instagram" };
  const { tracker, calls } = harness(
    [
      () => err404(), // session lookup x2 (discoverAttempts=2)
      () => err404(),
      (c: Call) => {
        assert.equal(c.method, "POST");
        assert.equal(c.path, "/api/video/generate");
        assert.deepEqual((c.body as any).productionBrief, brief);
        return { status: "generating", jobId: "vid-8", message: "Video generation started." };
      },
      () => ({ status: "completed", jobId: "vid-8", videoUrl: URL_OK }),
    ],
    { discoverAttempts: 2, discoverDelayMs: 1 },
  );
  const final = await tracker.track({ sessionId: "s8", productionBrief: brief });
  assert.equal(final.phase, "completed");
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
});

test("tracker: stop() halts polling", async () => {
  const { tracker } = harness([() => ({ status: "generating", jobId: "vid-9", videoUrl: null })]);
  const p = tracker.track({ sessionId: "s9" });
  tracker.stop();
  const final = await p;
  assert.ok(["stopped", "timeout"].includes(final.phase));
});

/* ---------------- backend: session lookup + per-session dedup ---------------- */

function bootServer(port: number, env: Record<string, string>) {
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return proc;
}

async function waitFor(base: string) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(base + "/api/health");
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not boot");
}

test("backend: /api/video/session lookup + duplicate generate is idempotent", async () => {
  const port = 3992;
  const base = `http://127.0.0.1:${port}`;
  const proc = bootServer(port, { VIDEO_GEN_PROVIDER: "mock", MOCK_VIDEO_DELAY_MS: "60000" });
  try {
    await waitFor(base);
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(base + path, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
    };

    // No job yet -> 404
    const none = await call("GET", "/api/video/session/sess-dedup");
    assert.equal(none.status, 404);

    const first = await call("POST", "/api/video/generate", {
      sessionId: "sess-dedup",
      productionBrief: { product: "Serum" },
    });
    assert.equal(first.status, 202);

    // Duplicate request while generating -> SAME job (no double generation)
    const dup = await call("POST", "/api/video/generate", {
      sessionId: "sess-dedup",
      productionBrief: { product: "Serum" },
    });
    assert.equal(dup.status, 202);
    assert.equal(dup.data.jobId, first.data.jobId);

    // Session lookup finds the job
    const found = await call("GET", "/api/video/session/sess-dedup");
    assert.equal(found.status, 200);
    assert.equal(found.data.jobId, first.data.jobId);
    assert.equal(found.data.status, "generating");
    assert.equal(found.data.videoUrl, null);
  } finally {
    proc.kill("SIGKILL");
    await once(proc, "exit").catch(() => {});
  }
});

/* ------------------------------------------------------------------ */
/* Final integration additions: retry, refresh persistence, MCP parse  */
/* ------------------------------------------------------------------ */

test("tracker: explicit retry after failure starts exactly one new job", async () => {
  let generates = 0;
  let fail = true;
  const fetchJson = async (method: string, path: string) => {
    if (path.startsWith("/api/video/session/")) throw new Error("404");
    if (path === "/api/video/generate") {
      generates += 1;
      return { status: "generating", jobId: `job-${generates}` };
    }
    if (path.startsWith("/api/video/status/")) {
      return fail
        ? { status: "failed", jobId: "job-1", error: "boom" }
        : { status: "completed", jobId: "job-2", videoUrl: "https://cdn/x.mp4", downloadUrl: "https://cdn/x.mp4" };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  const tracker = createVideoTracker({
    fetchJson,
    discoverAttempts: 1,
    discoverDelayMs: 0,
    intervalMs: 0,
    delay: async () => {},
  });
  const first = await tracker.track({ sessionId: "s-retry", productionBrief: { product: "x" } });
  assert.equal(first.phase, "failed");
  assert.equal(generates, 1); // no automatic re-generation

  fail = false;
  const second = await tracker.retry("s-retry");
  assert.equal(second.phase, "completed");
  assert.equal(second.videoUrl, "https://cdn/x.mp4");
  assert.equal(generates, 2); // exactly one more job, only on explicit retry
});

test("tracker: retry while still generating returns the in-flight run (no new job)", async () => {
  let generates = 0;
  let resolveStatus: (v: unknown) => void = () => {};
  const gate = new Promise((r) => (resolveStatus = r));
  const fetchJson = async (_m: string, path: string) => {
    if (path.startsWith("/api/video/session/")) throw new Error("404");
    if (path === "/api/video/generate") {
      generates += 1;
      return { status: "generating", jobId: "job-a" };
    }
    await gate;
    return { status: "completed", jobId: "job-a", videoUrl: "https://cdn/a.mp4" };
  };
  const tracker = createVideoTracker({
    fetchJson,
    discoverAttempts: 1,
    discoverDelayMs: 0,
    intervalMs: 0,
    delay: async () => {},
  });
  const p1 = tracker.track({ sessionId: "s-busy", productionBrief: { a: 1 } });
  await new Promise((r) => setTimeout(r, 10));
  const p2 = tracker.retry("s-busy");
  resolveStatus(null);
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.phase, "completed");
  assert.equal(r2.phase, "completed");
  assert.equal(generates, 1); // retry did NOT duplicate the running job
});

test("persistence: save/load round-trip and stale-job rejection", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  saveActiveJob(storage, { sessionId: "s1", jobId: "vid-1" }, 1000);
  const fresh = loadActiveJob(storage, 600000, 5000);
  assert.deepEqual({ sessionId: fresh.sessionId, jobId: fresh.jobId }, { sessionId: "s1", jobId: "vid-1" });
  // 10-minute-old jobs are stale — a refresh must not resume them.
  assert.equal(loadActiveJob(storage, 600000, 1000 + 600001), null);
  clearActiveJob(storage);
  assert.equal(loadActiveJob(storage, 600000, 5000), null);
  // corrupt payloads never throw
  storage.setItem("cf_video_job", "{not json");
  assert.equal(loadActiveJob(storage, 600000, 5000), null);
});

test("tracker: resume by jobId polls without creating a job", async () => {
  const calls: string[] = [];
  const fetchJson = async (_m: string, path: string) => {
    calls.push(path);
    if (path === "/api/video/status/vid-resume") {
      return { status: "completed", jobId: "vid-resume", videoUrl: "https://cdn/r.mp4", downloadUrl: "https://cdn/r.mp4" };
    }
    throw new Error(`unexpected ${path}`);
  };
  const tracker = createVideoTracker({ fetchJson, intervalMs: 0, delay: async () => {} });
  const final = await tracker.track({ sessionId: "s-resume", jobId: "vid-resume" });
  assert.equal(final.phase, "completed");
  assert.ok(!calls.includes("/api/video/generate")); // resume never re-generates
  assert.ok(!calls.some((c) => c.startsWith("/api/video/session/"))); // no discovery needed
});

test("mcp: parseSseJson extracts the last JSON data frame", async () => {
  const { parseSseJson } = await import("../src/services/videoService.ts");
  const sse = [
    "event: message",
    'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"successful\\":true}"}]}}',
    "",
    "data: keep-alive",
    "",
  ].join("\n");
  const parsed = parseSseJson(sse) as { result?: { content?: Array<{ text?: string }> } };
  assert.equal(parsed?.result?.content?.[0]?.text, '{"successful":true}');
  assert.equal(parseSseJson("no data lines here"), null);
});

test("mcp: ComposioVeoVideoService full flow over a fake MCP server (SSE), no key leak", async (t) => {
  const { createServer } = await import("node:http");
  const { ComposioVeoVideoService } = await import("../src/services/videoService.ts");
  const MCP_PORT = 3991;
  const KEY = "session-header-secret-do-not-leak";
  const seen: { headers: string[]; methods: string[] } = { headers: [], methods: [] };

  const server = createServer((req, res) => {
    seen.headers.push(String(req.headers["x-session-auth"] ?? ""));
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      seen.methods.push(body.method);
      res.setHeader("mcp-session-id", "mcp-sess-1");
      if (body.method === "initialize") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } }));
        return;
      }
      if (body.method === "notifications/initialized") {
        res.statusCode = 202;
        res.end();
        return;
      }
      // tools/call — answer as SSE, the Streamable-HTTP norm.
      const tool = body.params?.name;
      const inner =
        tool === "GEMINI_GENERATE_VIDEOS"
          ? { successful: true, data: { operation_name: "operations/mcp-op-1" } }
          : { successful: true, data: { video_file: { s3url: "https://cdn.example/mcp-video.mp4" } } };
      const rpc = {
        jsonrpc: "2.0",
        id: body.id,
        result: { isError: false, content: [{ type: "text", text: JSON.stringify(inner) }] },
      };
      res.setHeader("content-type", "text/event-stream");
      res.end(`event: message\ndata: ${JSON.stringify(rpc)}\n\n`);
    });
  });
  server.listen(MCP_PORT);
  t.after(() => server.close());

  // Session-based transport: the fake factory stands in for
  // composio.sessions.create and returns session.mcp.url/headers.
  const svc = new ComposioVeoVideoService({
    apiKey: "ak_test_project_key",
    restUrl: null,
    sessionFactory: {
      async createSession() {
        return {
          composioSessionId: "composio-sess-sse",
          mcp: { url: `http://127.0.0.1:${MCP_PORT}/mcp`, headers: { "x-session-auth": KEY } },
        };
      },
      async useSession() {
        throw new Error("not used");
      },
    },
  });
  const job = svc.start("sess-mcp", { product: "smart bottle", visualStyle: "cinematic" });
  assert.equal(job.status, "generating");
  for (let i = 0; i < 100 && svc.get(job.jobId)!.status === "generating"; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const done = svc.get(job.jobId)!;
  assert.equal(done.status, "completed");
  assert.equal(done.videoUrl, "https://cdn.example/mcp-video.mp4");
  assert.equal(done.downloadUrl, "https://cdn.example/mcp-video.mp4");
  assert.ok(seen.headers.every((h) => h === KEY), "MCP auth uses session.mcp.headers");
  assert.deepEqual(seen.methods, [
    "initialize",
    "notifications/initialized",
    "tools/call",
    "tools/call",
  ]);
  assert.ok(!JSON.stringify(done).includes(KEY), "key never appears in job state");
});
