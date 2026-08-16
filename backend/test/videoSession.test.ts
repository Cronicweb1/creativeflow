/**
 * Composio session-based video generation tests (node --test, in-process).
 *
 * Verifies the @composio/core sessions flow:
 *   1. Session creation config — mcp:true, gemini toolkit only, exactly
 *      GEMINI_GENERATE_VIDEOS + GEMINI_WAIT_FOR_VIDEO, direct_tools preset.
 *   2. session.mcp.url + session.mcp.headers are what the MCP client uses
 *      (never a hand-built connect.composio.dev/mcp URL or consumer header).
 *   3. Full generate → wait → completed videoUrl via a fake session + fake
 *      MCP server.
 *   4. One Composio session per CreativeFlow session (reused, not re-created
 *      per job or per status poll).
 *   5. Failure propagation without leaking credentials.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import {
  GEMINI_SESSION_CONFIG,
  SdkComposioSessionFactory,
  composioUserId,
  type ComposioSessionHandle,
} from "../src/services/composioSession.ts";
import { ComposioVeoVideoService } from "../src/services/videoService.ts";
import { SessionPreset } from "@composio/core";

const VIDEO_URL = "https://mock-s3.example.com/veo/session-output.mp4";
const SECRET = "ak_test_project_key_do_not_leak";

/* ------------------------------------------------------------ */
/* Fake MCP server implementing initialize + tools/call          */
/* ------------------------------------------------------------ */

interface FakeMcpState {
  server: Server;
  url: string;
  sawAuthHeaders: Array<Record<string, string | string[] | undefined>>;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  failGenerate: boolean;
}

function startFakeMcp(port: number): Promise<FakeMcpState> {
  const state: FakeMcpState = {
    server: null as unknown as Server,
    url: `http://127.0.0.1:${port}/mcp/fake-session`,
    sawAuthHeaders: [],
    toolCalls: [],
    failGenerate: false,
  };
  state.server = createServer((req, res) => {
    state.sawAuthHeaders.push({ auth: req.headers["x-session-auth"] });
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      res.setHeader("content-type", "application/json");
      res.setHeader("mcp-session-id", "mcp-sess-1");
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
        state.toolCalls.push({ name, args });
        if (name === "GEMINI_GENERATE_VIDEOS") {
          if (state.failGenerate) {
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: body.id,
                result: {
                  isError: false,
                  structuredContent: { successful: false, error: "RESOURCE_EXHAUSTED: quota", data: {} },
                },
              }),
            );
            return;
          }
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                isError: false,
                structuredContent: {
                  successful: true,
                  data: { operation_name: "models/veo/operations/sess-op-9" },
                },
              },
            }),
          );
          return;
        }
        if (name === "GEMINI_WAIT_FOR_VIDEO") {
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                isError: false,
                structuredContent: {
                  successful: true,
                  data: { success: true, video_file: { name: "out.mp4", s3url: VIDEO_URL } },
                },
              },
            }),
          );
          return;
        }
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  return new Promise((resolveP) => state.server.listen(port, () => resolveP(state)));
}

/* ------------------------------------------------------------ */
/* Fake sessions API (stands in for composio.sessions)           */
/* ------------------------------------------------------------ */

function fakeSessions(mcpUrl: string) {
  const record = {
    createCalls: [] as Array<{ userId: string; config: Record<string, unknown> }>,
    useCalls: [] as string[],
  };
  let n = 0;
  const make = (id: string) => ({
    sessionId: id,
    mcp: { url: mcpUrl, headers: { "x-session-auth": "session-token-abc" } },
  });
  const sessions = {
    async create(userId: string, config: Record<string, unknown>) {
      record.createCalls.push({ userId, config });
      n += 1;
      return make(`composio-sess-${n}`);
    },
    async use(id: string) {
      record.useCalls.push(id);
      return make(id);
    },
  };
  return { sessions, record };
}

async function waitJob(svc: ComposioVeoVideoService, jobId: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const j = svc.get(jobId);
    if (j && j.status !== "generating") return j;
    await new Promise((r) => setTimeout(r, 25));
  }
  return svc.get(jobId);
}

/* ------------------------------------------------------------ */

test("composio sessions — SDK factory sends the exact session config", async () => {
  const { sessions, record } = fakeSessions("http://127.0.0.1:1/unused");
  const factory = new SdkComposioSessionFactory({ sessions });
  const handle = await factory.createSession(composioUserId("cf-1"));

  assert.equal(record.createCalls.length, 1);
  const { userId, config } = record.createCalls[0];
  assert.equal(userId, "creativeflow:cf-1");
  assert.equal(config.mcp, true, "mcp: true must be requested");
  assert.deepEqual(config.toolkits, ["gemini"], "gemini toolkit only");
  assert.deepEqual((config.tools as any).gemini.enable, [
    "GEMINI_GENERATE_VIDEOS",
    "GEMINI_WAIT_FOR_VIDEO",
  ]);
  assert.equal(config.sessionPreset, SessionPreset.DIRECT_TOOLS);
  assert.equal(config.sessionPreset, GEMINI_SESSION_CONFIG.sessionPreset);

  // The handle exposes exactly what the SDK returned.
  assert.equal(handle.composioSessionId, "composio-sess-1");
  assert.equal(handle.mcp.headers["x-session-auth"], "session-token-abc");

  // Reuse path goes through sessions.use with mcp surfaced.
  const reused = await factory.useSession("composio-sess-1");
  assert.deepEqual(record.useCalls, ["composio-sess-1"]);
  assert.equal(reused.composioSessionId, "composio-sess-1");
});

test("composio sessions — generate→wait→completed via session.mcp.url/headers", async (t) => {
  const mcp = await startFakeMcp(3988);
  t.after(() => mcp.server.close());
  const { sessions, record } = fakeSessions(mcp.url);
  const svc = new ComposioVeoVideoService({
    apiKey: SECRET,
    restUrl: null,
    sessionFactory: new SdkComposioSessionFactory({ sessions }),
  });

  const brief = { product: "espresso machine", visualStyle: "warm light", duration: "6s", aspectRatio: "9:16" };
  const job = svc.start("cf-sess-A", brief);
  assert.equal(job.status, "generating");

  const done = await waitJob(svc, job.jobId);
  assert.equal(done?.status, "completed");
  assert.equal(done?.videoUrl, VIDEO_URL);
  assert.equal(done?.downloadUrl, VIDEO_URL);

  // Both Gemini tools were called against session.mcp.url (a local fake —
  // proving no hand-built connect.composio.dev/mcp endpoint is involved).
  const names = mcp.toolCalls.map((c) => c.name);
  assert.deepEqual(names, ["GEMINI_GENERATE_VIDEOS", "GEMINI_WAIT_FOR_VIDEO"]);
  assert.equal(mcp.toolCalls[0].args.aspect_ratio, "9:16");
  assert.equal(mcp.toolCalls[0].args.duration_seconds, 6);
  assert.ok(String(mcp.toolCalls[0].args.prompt).includes("espresso machine"));

  // Every request carried the session.mcp.headers auth header.
  assert.ok(mcp.sawAuthHeaders.length >= 3, "initialize + 2 tool calls");
  for (const h of mcp.sawAuthHeaders) assert.equal(h.auth, "session-token-abc");

  // Second job in the SAME CreativeFlow session must reuse the session.
  const job2 = svc.start("cf-sess-A", brief);
  const done2 = await waitJob(svc, job2.jobId);
  assert.equal(done2?.status, "completed");
  assert.equal(record.createCalls.length, 1, "one Composio session per CreativeFlow session");

  // A DIFFERENT CreativeFlow session gets its own Composio session.
  const job3 = svc.start("cf-sess-B", brief);
  await waitJob(svc, job3.jobId);
  assert.equal(record.createCalls.length, 2);

  // Status polls never touch Composio (no extra session or tool calls).
  const before = mcp.toolCalls.length;
  for (let i = 0; i < 5; i++) svc.get(job.jobId);
  assert.equal(mcp.toolCalls.length, before);
  assert.equal(record.createCalls.length, 2);
});

test("composio sessions — failure surfaces as failed job without key leak", async (t) => {
  const mcp = await startFakeMcp(3987);
  mcp.failGenerate = true;
  t.after(() => mcp.server.close());
  const { sessions } = fakeSessions(mcp.url);
  const svc = new ComposioVeoVideoService({
    apiKey: SECRET,
    restUrl: null,
    sessionFactory: new SdkComposioSessionFactory({ sessions }),
    sleep: async () => {}, // quota errors retry; keep the test instant
  });

  const job = svc.start("cf-sess-F", { product: "widget" });
  const done = await waitJob(svc, job.jobId);
  assert.equal(done?.status, "failed");
  assert.ok(done?.error && done.error.length > 0);
  assert.ok(!JSON.stringify(done).includes(SECRET), "COMPOSIO_API_KEY must never leak");
  assert.ok(!JSON.stringify(done).includes("session-token-abc"), "session headers must never leak");
});
