/**
 * POST /api/voice/transcribe tests (node --test).
 *
 * Boots the REAL server with GROQ_STT_URL pointed at a local mock Groq
 * endpoint, so the full path is exercised: multipart upload → dependency-free
 * multipart parse → provider call with the server-side key → { text } reply.
 *
 *   1. Missing audio (JSON body, no multipart)      → 400 audio_required
 *   2. Multipart without a file part                → 400 audio_required
 *   3. Empty audio file                             → 400 audio_empty
 *   4. Successful mocked Groq transcription         → 200 { text }
 *      (Bearer key sent upstream, model field set, key NEVER in the response)
 *   5. Provider failure (HTTP 500)                  → safe 502, no key leak
 *   6. Provider 4xx (invalid audio)                 → 400 invalid_audio
 *   7. Empty transcription                          → 200 { text: "" }
 *   8. GROQ_API_KEY unset                           → 503 stt_not_configured
 *   9. Existing JSON routes (copilot turn) still parse bodies normally.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
const PORT = 3990;
const MOCK_PORT = 3989;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = "test-groq-key-abc123";

function audioForm(bytes: number, name = "audio", filename = "clip.webm"): FormData {
  const form = new FormData();
  form.append(name, new Blob([new Uint8Array(bytes).fill(7)], { type: "audio/webm" }), filename);
  return form;
}

async function bootServer(t: any, env: Record<string, string>): Promise<ChildProcess> {
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => proc.kill());
  await once(proc.stdout!, "data");
  return proc;
}

test("voice transcription endpoint", async (t) => {
  // Mock Groq: records the request, replies per test scenario.
  let mode: "ok" | "fail" | "empty" | "reject" = "ok";
  const seen: { auth: string; contentType: string; body: Buffer }[] = [];
  const mock = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    seen.push({
      auth: String(req.headers.authorization ?? ""),
      contentType: String(req.headers["content-type"] ?? ""),
      body: Buffer.concat(chunks),
    });
    if (mode === "fail") {
      res.writeHead(500, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "boom" }));
    }
    if (mode === "reject") {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "bad audio" }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ text: mode === "empty" ? "   " : "I want a cinematic Instagram advertisement." }));
  });
  mock.listen(MOCK_PORT);
  t.after(() => mock.close());

  await bootServer(t, {
    GROQ_API_KEY: SECRET,
    GROQ_STT_URL: `http://127.0.0.1:${MOCK_PORT}/openai/v1/audio/transcriptions`,
  });

  // health exposes the stt provider (no key)
  const health = await fetch(`${BASE}/api/health`);
  const healthBody = await health.text();
  assert.equal(JSON.parse(healthBody).stt, "groq");
  assert.ok(!healthBody.includes(SECRET), "health must not leak the key");

  // 1. missing audio — plain JSON is not an upload
  const r1 = await fetch(`${BASE}/api/voice/transcribe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hello: "world" }),
  });
  assert.equal(r1.status, 400);
  assert.equal((await r1.json()).error, "audio_required");

  // 2. multipart without any file part
  const noFile = new FormData();
  noFile.append("note", "no audio here");
  const r2 = await fetch(`${BASE}/api/voice/transcribe`, { method: "POST", body: noFile });
  assert.equal(r2.status, 400);
  assert.equal((await r2.json()).error, "audio_required");

  // 3. empty audio file
  const r3 = await fetch(`${BASE}/api/voice/transcribe`, { method: "POST", body: audioForm(0) });
  assert.equal(r3.status, 400);
  assert.equal((await r3.json()).error, "audio_empty");
  assert.equal(seen.length, 0, "invalid uploads must never reach the provider");

  // 4. success — mocked Groq transcription
  const r4 = await fetch(`${BASE}/api/voice/transcribe`, { method: "POST", body: audioForm(4096) });
  assert.equal(r4.status, 200);
  const ok = await r4.json();
  assert.equal(ok.text, "I want a cinematic Instagram advertisement.");
  assert.deepEqual(Object.keys(ok), ["text"], "response carries ONLY the transcript");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].auth, `Bearer ${SECRET}`, "server-side key used upstream");
  assert.match(seen[0].contentType, /multipart\/form-data/);
  const upstreamBody = seen[0].body.toString("latin1");
  assert.ok(upstreamBody.includes("whisper-large-v3-turbo"), "supported Groq Whisper model sent");
  assert.ok(upstreamBody.includes('name="file"'), "audio forwarded as a file part");
  assert.ok(!JSON.stringify(ok).includes(SECRET), "key never returned to the browser");

  // 5. provider failure → safe upstream-error status, no key leak
  mode = "fail";
  const r5 = await fetch(`${BASE}/api/voice/transcribe`, { method: "POST", body: audioForm(4096) });
  assert.equal(r5.status, 502);
  const failBody = await r5.text();
  assert.equal(JSON.parse(failBody).error, "transcription_failed");
  assert.ok(!failBody.includes(SECRET) && !failBody.includes("boom"), "no key, no raw provider body");

  // 6. provider rejects the audio → 400 invalid_audio
  mode = "reject";
  const r6 = await fetch(`${BASE}/api/voice/transcribe`, { method: "POST", body: audioForm(4096) });
  assert.equal(r6.status, 400);
  assert.equal((await r6.json()).error, "invalid_audio");

  // 7. empty transcription handled cleanly (frontend maps it to "silence")
  mode = "empty";
  const r7 = await fetch(`${BASE}/api/voice/transcribe`, { method: "POST", body: audioForm(4096) });
  assert.equal(r7.status, 200);
  assert.equal((await r7.json()).text, "");

  // 9. JSON routes still parse bodies normally (router multipart bypass is scoped)
  const start = await fetch(`${BASE}/api/demo/session`, { method: "POST" });
  assert.equal(start.status, 201);
  const sessionId = (await start.json()).session.sessionId as string;
  const turn = await fetch(`${BASE}/api/copilot/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, userMessage: "We are launching a skincare serum." }),
  });
  assert.equal(turn.status, 200);
  assert.ok(((await turn.json()).responseText as string).length > 0);
});

test("GROQ_API_KEY unset → 503 stt_not_configured (key required, never assumed)", async (t) => {
  await bootServer(t, { GROQ_API_KEY: "" });
  const health = await fetch(`${BASE}/api/health`);
  assert.equal((await health.json()).stt, "none");
  const res = await fetch(`${BASE}/api/voice/transcribe`, { method: "POST", body: audioForm(4096) });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "stt_not_configured");
});
