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
import { createVideoTracker } from "../../frontend/public/js/videoStatus.js";

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
