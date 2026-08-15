/**
 * Voice architecture tests (node --test).
 *
 * Covers:
 *   1. No ElevenLabs conversational-agent surface reachable (token → 404).
 *   2. Health reports voice/tts providers.
 *   3. Final transcript → /api/copilot/turn with the REAL session id;
 *      fake hardcoded ids are rejected; structured response for TTS + UI.
 *   4. POST /api/tts: 503 when unconfigured (browser fallback), 400 on
 *      empty text, audio bytes when a provider is configured (verified
 *      against a local mock OpenAI-compatible provider), and no API key
 *      ever appears in the response.
 *   5. Markdown/code fences are stripped before speaking.
 *   6. Static source guards: STT lifecycle invariants and zero ElevenLabs
 *      agent usage in the frontend.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SERVER = resolve(ROOT, "backend/src/server.ts");

function api(base: string) {
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, res, data: (await res.clone().json().catch(() => ({}))) as any };
  };
}

function bootServer(port: number, env: Record<string, string>) {
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return proc;
}

test("browser voice pipeline — no agent, real session, copilot turn, tts fallback", async (t) => {
  const PORT = 3998;
  const call = api(`http://127.0.0.1:${PORT}`);
  const proc = bootServer(PORT, {
    COPILOT_PROVIDER: "mock",
    VOICE_PROVIDER: "",
    TTS_PROVIDER: "browser", // force-unconfigured → frontend speechSynthesis fallback
  });
  t.after(() => proc.kill());
  await once(proc.stdout!, "data");

  // 1. Health advertises browser voice and browser (fallback) TTS.
  const health = await call("GET", "/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.data.voice, "browser");
  assert.equal(health.data.tts, "browser");

  // 2. The retired conversational-agent token endpoint stays GONE.
  const token = await call("GET", "/api/elevenlabs/token");
  assert.equal(token.status, 404);

  // 3. Session id propagation — REAL session id only.
  const start = await call("POST", "/api/demo/session");
  assert.equal(start.status, 201);
  const sessionId = start.data.session.sessionId as string;
  assert.ok(sessionId && sessionId.length > 8);

  const fake = await call("POST", "/api/copilot/turn", {
    sessionId: "test-session-001",
    userMessage: "hello",
  });
  assert.equal(fake.status, 404); // fake ids are rejected

  // 4. Final transcript → copilot turn → structured response.
  const turn = await call("POST", "/api/copilot/turn", {
    sessionId,
    userMessage: "I want a cinematic Instagram advertisement for a premium skincare serum.",
  });
  assert.equal(turn.status, 200);
  assert.ok(typeof turn.data.responseText === "string" && turn.data.responseText.length > 0);
  assert.ok(turn.data.requirements && typeof turn.data.requirements === "object");
  assert.ok(Array.isArray(turn.data.missing));
  assert.equal(typeof turn.data.complete, "boolean");
  assert.equal(turn.data.readyForProduction, false);
  assert.ok(!turn.data.responseText.trim().startsWith("{")); // spoken text is never JSON

  const turn2 = await call("POST", "/api/copilot/turn", {
    sessionId,
    userMessage: "The audience is women aged 25 to 40.",
  });
  assert.equal(turn2.status, 200);

  // 5. TTS unconfigured → 503 so the frontend falls back to speechSynthesis.
  const tts = await call("POST", "/api/tts", { text: "Hello there" });
  assert.equal(tts.status, 503);
  assert.equal(tts.data.error, "tts_not_configured");
});

test("POST /api/tts — natural TTS via configured provider, key stays server-side", async (t) => {
  const SECRET = "test-secret-key-tts";
  const FAKE_AUDIO = Buffer.from("ID3-fake-mp3-bytes-for-test");

  // Local mock OpenAI-compatible /audio/speech provider.
  let seenAuth = "";
  let seenBody: any = null;
  const mock = createServer(async (req, res) => {
    seenAuth = String(req.headers.authorization ?? "");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    seenBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "content-type": "audio/mpeg" });
    res.end(FAKE_AUDIO);
  });
  await new Promise<void>((r) => mock.listen(3997, r));
  t.after(() => mock.close());

  const PORT = 3996;
  const call = api(`http://127.0.0.1:${PORT}`);
  const proc = bootServer(PORT, {
    COPILOT_PROVIDER: "mock",
    TTS_PROVIDER: "openai",
    TTS_API_URL: "http://127.0.0.1:3997/v1",
    TTS_API_KEY: SECRET,
    TTS_MODEL: "mock-tts",
    TTS_VOICE: "mock-voice",
  });
  t.after(() => proc.kill());
  await once(proc.stdout!, "data");

  const health = await call("GET", "/api/health");
  assert.equal(health.data.tts, "openai");

  // Empty / missing text → 400, nothing is synthesized.
  assert.equal((await call("POST", "/api/tts", { text: "   " })).status, 400);
  assert.equal((await call("POST", "/api/tts", {})).status, 400);

  // Markdown is stripped server-side; only prose reaches the provider.
  const { status, res } = await call("POST", "/api/tts", {
    text: "**Great choice!** Here is `code` — ```json\n{\"x\":1}\n``` Who is the audience?",
  });
  assert.equal(status, 200);
  assert.match(res.headers.get("content-type") ?? "", /audio\/mpeg/);
  const audio = Buffer.from(await res.arrayBuffer());
  assert.deepEqual(audio, FAKE_AUDIO);
  assert.equal(seenAuth, `Bearer ${SECRET}`); // key used server-side…
  assert.ok(!seenBody.input.includes("```") && !seenBody.input.includes("**"));
  assert.ok(seenBody.input.includes("Great choice!") && seenBody.input.includes("audience"));

  // …and the key never appears in any response the browser can see.
  const headerDump = JSON.stringify([...res.headers.entries()]);
  assert.ok(!headerDump.includes(SECRET));
  assert.ok(!audio.toString("utf8").includes(SECRET));
  const healthDump = JSON.stringify(health.data);
  assert.ok(!healthDump.includes(SECRET));
});

test("frontend sources — STT lifecycle invariants, no ElevenLabs agent usage", async () => {
  const voiceSrc = await readFile(resolve(ROOT, "frontend/public/js/voice.js"), "utf8");
  const demoSrc = await readFile(resolve(ROOT, "frontend/public/js/demo.js"), "utf8");
  const apiSrc = await readFile(resolve(ROOT, "frontend/public/js/api.js"), "utf8");

  for (const [name, src] of [["voice.js", voiceSrc], ["demo.js", demoSrc], ["api.js", apiSrc]] as const) {
    assert.ok(!/elevenlabs/i.test(src.replace(/no elevenlabs/gi, "")), `${name} references ElevenLabs`);
    assert.ok(!src.includes("startSession({"), `${name} starts an agent SDK session`);
    assert.ok(!src.includes("conversationToken"), `${name} uses a conversation token`);
    assert.ok(!src.includes("@elevenlabs/client"), `${name} imports the ElevenLabs SDK`);
    assert.ok(!src.includes("/api/elevenlabs"), `${name} calls the ElevenLabs token endpoint`);
    assert.ok(!/test-session-001/.test(src), `${name} must never use a fake session id`);
    assert.ok(!/sk_[a-z0-9]/i.test(src), `${name} must not contain API keys`);
  }

  // STT is the Web Speech API with a robust, bounded lifecycle.
  assert.ok(voiceSrc.includes("webkitSpeechRecognition"), "voice.js must use SpeechRecognition");
  assert.ok(voiceSrc.includes("interimResults = true"), "interim transcripts must be enabled");
  assert.ok(voiceSrc.includes("_submittedThisSession"), "duplicate-submission guard required");
  assert.ok(voiceSrc.includes("MAX_SILENT_RESTARTS"), "recognition restarts must be bounded");
  assert.ok(voiceSrc.includes("maxAlternatives = 1"), "maxAlternatives must be 1");
  // TTS abstraction: server-side natural TTS first, speechSynthesis fallback.
  assert.ok(voiceSrc.includes("/api/tts"), "voice.js must use the backend TTS endpoint");
  assert.ok(voiceSrc.includes("speechSynthesis"), "voice.js must keep the browser TTS fallback");
  assert.ok(voiceSrc.includes("SpeechSynthesisUtterance"), "voice.js must build fallback utterances");
  assert.ok(voiceSrc.includes("onSpeakingStateChange"), "speaking-state events required");
  // The demo routes transcripts through the backend brain.
  assert.ok(demoSrc.includes("copilotTurn"), "demo.js must call the copilot turn API");
});

test("toSpeakableText strips markdown, fences and JSON noise", async () => {
  (globalThis as any).window = {
    location: { search: "" },
    localStorage: { getItem: () => null },
  };
  const { toSpeakableText } = await import("../../frontend/public/js/voice.js");
  assert.equal(
    toSpeakableText("**Great!** Here's `x` — ```json\n{\"a\":1}\n``` [link](http://e.com) next?"),
    "Great! Here's x — link next?",
  );
  assert.equal(toSpeakableText("   "), "");
  assert.equal(toSpeakableText(null), "");
  delete (globalThis as any).window;
});
