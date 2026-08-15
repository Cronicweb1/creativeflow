/**
 * Video-generation backend tests (node --test).
 *
 * Covers the Activepieces "Generate Video" contract:
 *   1. POST /api/video/generate — 400 on missing productionBrief / sessionId.
 *   2. Successful job creation — 202 { status:"generating", jobId, message }.
 *   3. GET /api/video/status/:jobId while generating — videoUrl null.
 *   4. Completed job — videoUrl + downloadUrl (via a local mock Composio
 *      server standing in for GEMINI_GENERATE_VIDEOS / GEMINI_WAIT_FOR_VIDEO).
 *   5. Failed generation — status "failed" with an error, and no API key
 *      leaking into any response.
 *   6. Unknown jobId — 404.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SERVER = resolve(ROOT, "backend/src/server.ts");

const FAKE_KEY = "ck_test_video_secret_do_not_leak";
const VIDEO_URL = "https://mock-s3.example.com/veo/output-720p.mp4";

function api(base: string) {
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, text: await res.clone().text(), data: (await res.json().catch(() => ({}))) as any };
  };
}

function bootServer(port: number, env: Record<string, string>) {
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return proc;
}

async function poll(call: ReturnType<typeof api>, jobId: string, until: string, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    last = await call("GET", `/api/video/status/${jobId}`);
    if (last.data.status === until || last.data.status === "failed") return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  return last;
}

test("video generation — validation, 202 contract, mock provider lifecycle", async (t) => {
  const PORT = 3995;
  const call = api(`http://127.0.0.1:${PORT}`);
  const proc = bootServer(PORT, {
    COPILOT_PROVIDER: "mock",
    VIDEO_GEN_PROVIDER: "mock",
    MOCK_VIDEO_DELAY_MS: "600",
    COMPOSIO_API_KEY: "",
  });
  t.after(() => proc.kill());
  await once(proc.stdout!, "data");

  const brief = {
    client: "Aurora Skincare",
    product: "premium skincare serum",
    platform: "Instagram",
    contentType: "cinematic advertisement",
    visualStyle: "cinematic, luxurious",
    audience: "women 25-40",
    duration: "8 seconds",
    aspectRatio: "9:16",
  };

  // 1. Missing productionBrief → 400.
  const noBrief = await call("POST", "/api/video/generate", { sessionId: "s-1" });
  assert.equal(noBrief.status, 400);
  assert.equal(noBrief.data.error, "productionBrief_required");

  const emptyBrief = await call("POST", "/api/video/generate", { sessionId: "s-1", productionBrief: {} });
  assert.equal(emptyBrief.status, 400);

  // Missing sessionId → 400.
  const noSession = await call("POST", "/api/video/generate", { productionBrief: brief });
  assert.equal(noSession.status, 400);
  assert.equal(noSession.data.error, "sessionId_required");

  // 2. Successful job creation → 202 immediately with the exact contract.
  const started = Date.now();
  const gen = await call("POST", "/api/video/generate", { sessionId: "sess-abc", productionBrief: brief });
  assert.equal(gen.status, 202);
  assert.equal(gen.data.status, "generating");
  assert.ok(typeof gen.data.jobId === "string" && gen.data.jobId.length > 8);
  assert.equal(gen.data.message, "Video generation started.");
  assert.ok(Date.now() - started < 500, "generate endpoint must not block on Veo");

  // 3. Status while generating.
  const during = await call("GET", `/api/video/status/${gen.data.jobId}`);
  assert.equal(during.status, 200);
  assert.equal(during.data.status, "generating");
  assert.equal(during.data.videoUrl, null);

  // 4. Completed → videoUrl + downloadUrl.
  const done = await poll(call, gen.data.jobId, "completed");
  assert.equal(done.data.status, "completed");
  assert.equal(done.data.jobId, gen.data.jobId);
  assert.ok(typeof done.data.videoUrl === "string" && done.data.videoUrl.startsWith("http"));
  assert.ok(typeof done.data.downloadUrl === "string" && done.data.downloadUrl.startsWith("http"));

  // 6. Unknown job → 404.
  const missing = await call("GET", "/api/video/status/nope");
  assert.equal(missing.status, 404);

  // Health advertises the video provider.
  const health = await call("GET", "/api/health");
  assert.equal(health.data.video, "mock");
});

test("video generation — composio provider: success, failure, no key leak", async (t) => {
  const PORT = 3994;
  const MOCK_PORT = 3993;
  const call = api(`http://127.0.0.1:${PORT}`);

  // Local mock Composio API: GENERATE returns an operation, WAIT returns a
  // downloadable file — unless failNext is set, then it fails.
  let sawApiKey = "";
  let failNext = false;
  const mock = createServer((req, res) => {
    sawApiKey = String(req.headers["x-api-key"] ?? "");
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/GEMINI_GENERATE_VIDEOS")) {
        assert.ok(String(body.arguments?.prompt ?? "").length > 10, "prompt built from brief");
        if (failNext) {
          res.end(JSON.stringify({ successful: false, error: "RESOURCE_EXHAUSTED: quota", data: {} }));
          return;
        }
        res.end(
          JSON.stringify({
            successful: true,
            data: { operation_name: "models/veo-3.1-lite-generate-preview/operations/test123" },
          }),
        );
      } else if (req.url?.endsWith("/GEMINI_WAIT_FOR_VIDEO")) {
        assert.equal(body.arguments?.operation_name, "models/veo-3.1-lite-generate-preview/operations/test123");
        res.end(
          JSON.stringify({
            successful: true,
            data: { success: true, video_file: { name: "out.mp4", mimetype: "video/mp4", s3url: VIDEO_URL } },
          }),
        );
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  mock.listen(MOCK_PORT);
  t.after(() => mock.close());

  const proc = bootServer(PORT, {
    COPILOT_PROVIDER: "mock",
    VIDEO_GEN_PROVIDER: "composio",
    COMPOSIO_API_KEY: FAKE_KEY,
    COMPOSIO_API_URL: `http://127.0.0.1:${MOCK_PORT}`,
  });
  t.after(() => proc.kill());
  await once(proc.stdout!, "data");

  const brief = { product: "espresso machine", visualStyle: "warm morning light", duration: "6s" };

  // Success path — real Composio flow shape end-to-end.
  const gen = await call("POST", "/api/video/generate", { sessionId: "sess-live", productionBrief: brief });
  assert.equal(gen.status, 202);
  const done = await poll(call, gen.data.jobId, "completed");
  assert.equal(done.data.status, "completed");
  assert.equal(done.data.videoUrl, VIDEO_URL);
  assert.equal(done.data.downloadUrl, VIDEO_URL);
  assert.equal(sawApiKey, FAKE_KEY, "server must authenticate to Composio with x-api-key");

  // Failure path — upstream error surfaces as failed job, without the key.
  failNext = true;
  const gen2 = await call("POST", "/api/video/generate", { sessionId: "sess-live", productionBrief: brief });
  assert.equal(gen2.status, 202);
  const failed = await poll(call, gen2.data.jobId, "failed");
  assert.equal(failed.data.status, "failed");
  assert.ok(typeof failed.data.error === "string" && failed.data.error.length > 0);
  assert.ok(!failed.text.includes(FAKE_KEY), "API key must never appear in responses");
  assert.ok(!done.text.includes(FAKE_KEY), "API key must never appear in responses");

  // Health advertises composio provider.
  const health = await call("GET", "/api/health");
  assert.equal(health.data.video, "composio");
  assert.ok(!health.text.includes(FAKE_KEY));
});
