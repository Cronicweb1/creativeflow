/**
 * Veo quota retry hardening tests (Fix E) - node --test, in-process.
 *
 * Covers:
 *   A. Successful generation -> no retry, model pinned.
 *   B. 429 with upstream retryDelay -> delay honored, fresh generate call,
 *      WAIT only ever sees the successful operation_name.
 *   C. 429, 429, success -> fallback delays 30s/60s, 3 attempts.
 *   D. 3x 429 -> failed after exactly 3 attempts, zero WAIT calls,
 *      friendly error, full sanitized quota detail retained internally.
 *   E. 400 INVALID_ARGUMENT -> no retry.
 *   F. 401 / 403 -> no retry.
 *   G. A failed attempt's operation_name is never reused (asserted in B/C).
 *   H. quotaMetric/quotaId/quotaDimensions/retryDelay/model retained, no secrets.
 * Plus unit tests for isQuotaExhausted / parseRetryDelayMs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { SdkComposioSessionFactory } from "../src/services/composioSession.ts";
import {
  ComposioVeoVideoService,
  VEO_MODEL,
  isQuotaExhausted,
  parseRetryDelayMs,
} from "../src/services/videoService.ts";

const VIDEO_URL = "https://mock-s3.example.com/veo/retry-output.mp4";
const SECRET = "ak_retry_test_key_do_not_leak";

const QUOTA_ERROR_WITH_DELAY =
  '429 Veo generate_videos failed: {"error":{"code":429,"status":"RESOURCE_EXHAUSTED",' +
  '"message":"You exceeded your current quota","details":[{"quotaMetric":' +
  '"generativelanguage.googleapis.com/generate_video_requests","quotaId":' +
  '"GenerateVideoRequestsPerDayPerProject","quotaDimensions":{"model":"veo-3.1-lite"},' +
  '"retryDelay":"45s"}]}}';
const QUOTA_ERROR_NO_DELAY = "429 RESOURCE_EXHAUSTED: You exceeded your current quota";

type GenScript = { error?: string }; // no error -> success

interface RetryMcpState {
  server: Server;
  url: string;
  genCalls: Array<Record<string, unknown>>;
  waitCalls: Array<Record<string, unknown>>;
  script: GenScript[];
}

function startRetryMcp(port: number, script: GenScript[]): Promise<RetryMcpState> {
  const state: RetryMcpState = {
    server: null as unknown as Server,
    url: `http://127.0.0.1:${port}/mcp/retry-session`,
    genCalls: [],
    waitCalls: [],
    script,
  };
  state.server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      res.setHeader("content-type", "application/json");
      res.setHeader("mcp-session-id", "mcp-retry-1");
      const reply = (structuredContent: unknown) =>
        res.end(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { isError: false, structuredContent } }),
        );
      if (body.method === "initialize") {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { capabilities: {} } }));
        return;
      }
      if (body.method === "notifications/initialized") {
        res.statusCode = 202;
        res.end();
        return;
      }
      if (body.method === "tools/call") {
        const name = body.params?.name as string;
        const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
        if (name === "GEMINI_GENERATE_VIDEOS") {
          state.genCalls.push(args);
          const step = state.script[state.genCalls.length - 1] ?? {};
          if (step.error) {
            reply({ successful: false, error: step.error, data: {} });
          } else {
            reply({
              successful: true,
              data: { operation_name: `models/veo/operations/op-${state.genCalls.length}` },
            });
          }
          return;
        }
        if (name === "GEMINI_WAIT_FOR_VIDEO") {
          state.waitCalls.push(args);
          reply({ successful: true, data: { success: true, video_file: { name: "out.mp4", s3url: VIDEO_URL } } });
          return;
        }
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  return new Promise((resolveP) => state.server.listen(port, () => resolveP(state)));
}

function fakeSessions(mcpUrl: string) {
  return {
    async create(_userId: string, _config: Record<string, unknown>) {
      return { sessionId: "composio-retry-sess", mcp: { url: mcpUrl, headers: { "x-session-auth": "retry-token" } } };
    },
    async use(id: string) {
      return { sessionId: id, mcp: { url: mcpUrl, headers: { "x-session-auth": "retry-token" } } };
    },
  };
}

function makeService(mcpUrl: string, sleeps: number[]) {
  return new ComposioVeoVideoService({
    apiKey: SECRET,
    restUrl: null,
    sessionFactory: new SdkComposioSessionFactory({ sessions: fakeSessions(mcpUrl) }),
    sleep: async (ms) => {
      sleeps.push(ms); // recorded, never actually waited
    },
  });
}

async function waitJob(svc: ComposioVeoVideoService, jobId: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const j = svc.get(jobId);
    if (j && j.status !== "generating") return j;
    await new Promise((r) => setTimeout(r, 20));
  }
  return svc.get(jobId);
}

const BRIEF = { product: "espresso machine", visualStyle: "warm light", duration: "6s", aspectRatio: "9:16" };

/* ------------------------------------------------------------ */

test("retry helpers - quota detection and retryDelay parsing", () => {
  assert.ok(isQuotaExhausted(QUOTA_ERROR_WITH_DELAY));
  assert.ok(isQuotaExhausted("RESOURCE_EXHAUSTED"));
  assert.ok(isQuotaExhausted("You exceeded your current quota, please retry"));
  assert.ok(!isQuotaExhausted("400 INVALID_ARGUMENT: bad prompt"));
  assert.ok(!isQuotaExhausted("401 UNAUTHENTICATED"));
  assert.ok(!isQuotaExhausted("403 PERMISSION_DENIED"));
  assert.ok(!isQuotaExhausted("404 not found"));
  assert.ok(!isQuotaExhausted("safety_filtered: blocked"));

  assert.equal(parseRetryDelayMs(QUOTA_ERROR_WITH_DELAY), 45_000);
  assert.equal(parseRetryDelayMs('"retryDelay":"12.5s"'), 12_500);
  assert.equal(parseRetryDelayMs("retryDelay: 30s"), 30_000);
  assert.equal(parseRetryDelayMs('"retryDelay":"900s"'), 120_000, "safety cap");
  assert.equal(parseRetryDelayMs("no delay here"), null);
});

test("A: successful generation -> no retry, no sleep, model pinned", async (t) => {
  const mcp = await startRetryMcp(3986, [{}]);
  t.after(() => mcp.server.close());
  const sleeps: number[] = [];
  const svc = makeService(mcp.url, sleeps);

  const job = svc.start("cf-retry-A", BRIEF);
  const done = await waitJob(svc, job.jobId);

  assert.equal(done?.status, "completed");
  assert.equal(done?.videoUrl, VIDEO_URL);
  assert.equal(mcp.genCalls.length, 1);
  assert.equal(sleeps.length, 0);
  assert.equal(mcp.genCalls[0].model, VEO_MODEL, "model must be pinned");
  assert.equal(mcp.genCalls[0].model, "veo-3.1-lite-generate-preview");
  assert.equal(mcp.genCalls[0].aspect_ratio, "9:16");
  assert.equal(mcp.genCalls[0].duration_seconds, 6);
  assert.equal(mcp.waitCalls.length, 1);
  assert.equal(mcp.waitCalls[0].operation_name, "models/veo/operations/op-1");
});

test("B: 429 with retryDelay -> honors delay, fresh generate, wait uses only successful op", async (t) => {
  const mcp = await startRetryMcp(3985, [{ error: QUOTA_ERROR_WITH_DELAY }, {}]);
  t.after(() => mcp.server.close());
  const sleeps: number[] = [];
  const svc = makeService(mcp.url, sleeps);

  const job = svc.start("cf-retry-B", BRIEF);
  const done = await waitJob(svc, job.jobId);

  assert.equal(done?.status, "completed");
  assert.equal(mcp.genCalls.length, 2, "one retry");
  assert.deepEqual(sleeps, [45_000], "upstream retryDelay honored");
  assert.equal(mcp.waitCalls.length, 1, "wait called exactly once");
  assert.equal(mcp.waitCalls[0].operation_name, "models/veo/operations/op-2");
  // G: the failed first attempt produced no operation_name and none was reused.
  for (const w of mcp.waitCalls) assert.notEqual(w.operation_name, "models/veo/operations/op-1");
});

test("C: 429, 429, success -> fallback 30s/60s delays, third attempt wins", async (t) => {
  const mcp = await startRetryMcp(3984, [
    { error: QUOTA_ERROR_NO_DELAY },
    { error: QUOTA_ERROR_NO_DELAY },
    {},
  ]);
  t.after(() => mcp.server.close());
  const sleeps: number[] = [];
  const svc = makeService(mcp.url, sleeps);

  const job = svc.start("cf-retry-C", BRIEF);
  const done = await waitJob(svc, job.jobId);

  assert.equal(done?.status, "completed");
  assert.equal(mcp.genCalls.length, 3);
  assert.deepEqual(sleeps, [30_000, 60_000]);
  assert.equal(mcp.waitCalls.length, 1);
  assert.equal(mcp.waitCalls[0].operation_name, "models/veo/operations/op-3");
});

test("D+H: three 429s -> failed, exactly 3 attempts, no wait, quota detail retained sanitized", async (t) => {
  const mcp = await startRetryMcp(3983, [
    { error: QUOTA_ERROR_WITH_DELAY },
    { error: QUOTA_ERROR_WITH_DELAY },
    { error: QUOTA_ERROR_WITH_DELAY },
  ]);
  t.after(() => mcp.server.close());
  const sleeps: number[] = [];
  const svc = makeService(mcp.url, sleeps);

  const job = svc.start("cf-retry-D", BRIEF);
  const done = await waitJob(svc, job.jobId);

  assert.equal(done?.status, "failed");
  assert.equal(mcp.genCalls.length, 3, "exactly 3 generation attempts");
  assert.equal(mcp.waitCalls.length, 0, "wait never called");
  assert.equal(sleeps.length, 2);
  assert.equal(done?.error, "Veo generation quota temporarily exhausted after retries.");
  // Full upstream quota info preserved internally...
  const detail = done?.errorDetail ?? "";
  assert.ok(detail.includes("RESOURCE_EXHAUSTED"));
  assert.ok(detail.includes("quotaMetric"));
  assert.ok(detail.includes("GenerateVideoRequestsPerDayPerProject"));
  assert.ok(detail.includes("quotaDimensions"));
  assert.ok(detail.includes("retryDelay"));
  assert.ok(detail.includes("veo-3.1-lite"));
  // ...but never any credentials.
  const blob = JSON.stringify(done);
  assert.ok(!blob.includes(SECRET));
  assert.ok(!blob.includes("retry-token"));
});

test("E: 400 INVALID_ARGUMENT -> fails immediately, no retry", async (t) => {
  const mcp = await startRetryMcp(3982, [{ error: "400 INVALID_ARGUMENT: prompt was rejected" }]);
  t.after(() => mcp.server.close());
  const sleeps: number[] = [];
  const svc = makeService(mcp.url, sleeps);

  const job = svc.start("cf-retry-E", BRIEF);
  const done = await waitJob(svc, job.jobId);

  assert.equal(done?.status, "failed");
  assert.equal(mcp.genCalls.length, 1);
  assert.equal(sleeps.length, 0);
  assert.equal(mcp.waitCalls.length, 0);
  assert.ok(done?.error?.includes("INVALID_ARGUMENT"));
});

test("F: 401/403 -> fails immediately, no retry", async (t) => {
  const mcp401 = await startRetryMcp(3981, [{ error: "401 UNAUTHENTICATED: invalid credentials" }]);
  t.after(() => mcp401.server.close());
  const sleeps401: number[] = [];
  const svc401 = makeService(mcp401.url, sleeps401);
  const j401 = svc401.start("cf-retry-F1", BRIEF);
  const d401 = await waitJob(svc401, j401.jobId);
  assert.equal(d401?.status, "failed");
  assert.equal(mcp401.genCalls.length, 1);
  assert.equal(sleeps401.length, 0);

  const mcp403 = await startRetryMcp(3980, [{ error: "403 PERMISSION_DENIED" }]);
  t.after(() => mcp403.server.close());
  const sleeps403: number[] = [];
  const svc403 = makeService(mcp403.url, sleeps403);
  const j403 = svc403.start("cf-retry-F2", BRIEF);
  const d403 = await waitJob(svc403, j403.jobId);
  assert.equal(d403?.status, "failed");
  assert.equal(mcp403.genCalls.length, 1);
  assert.equal(sleeps403.length, 0);
  assert.equal(mcp403.waitCalls.length, 0);
});
