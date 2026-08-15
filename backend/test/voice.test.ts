/**
 * Browser-voice architecture tests (node --test).
 *
 * Verifies the credit-safe voice pipeline:
 *   1. No ElevenLabs conversational-agent surface remains reachable
 *      (token endpoint unregistered → 404).
 *   2. Health reports the browser voice provider.
 *   3. STT transcript → /api/copilot/turn works with the REAL session id
 *      produced by the existing session flow (no fake hardcoded ids).
 *   4. The turn response carries responseText for TTS plus the structured
 *      brief fields the UI renders.
 *   5. Static source guards: voice.js / demo.js never initialize an
 *      ElevenLabs agent, fetch a conversation token, or import the SDK.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SERVER = resolve(ROOT, "backend/src/server.ts");
const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
}

test("browser voice pipeline — no ElevenLabs agent, real session, copilot turn", async (t) => {
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), COPILOT_PROVIDER: "mock", VOICE_PROVIDER: "" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => proc.kill());
  await once(proc.stdout!, "data"); // wait for "listening" log

  // 1. Health advertises the browser voice provider (not elevenlabs).
  const health = await call("GET", "/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.data.voice, "browser");

  // 2. The ElevenLabs conversational-agent token endpoint is GONE (404),
  //    so the frontend cannot open a credit-consuming agent session.
  const token = await call("GET", "/api/elevenlabs/token");
  assert.equal(token.status, 404);

  // 3. Session id propagation: the REAL session from the existing flow
  //    feeds /api/copilot/turn — never a fake hardcoded id.
  const start = await call("POST", "/api/demo/session");
  assert.equal(start.status, 201);
  const sessionId = start.data.session.sessionId as string;
  assert.ok(sessionId && sessionId.length > 8);

  const fake = await call("POST", "/api/copilot/turn", {
    sessionId: "test-session-001",
    userMessage: "hello",
  });
  assert.equal(fake.status, 404); // fake ids are rejected, real ones required

  // 4. STT transcript → copilot turn → structured response for TTS + UI.
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
  // The spoken text must be plain language, never serialized state.
  assert.ok(!turn.data.responseText.trim().startsWith("{"));

  // Another voice turn on the same session works (loop continues).
  const turn2 = await call("POST", "/api/copilot/turn", {
    sessionId,
    userMessage: "The audience is women aged 25 to 40.",
  });
  assert.equal(turn2.status, 200);
  assert.ok(typeof turn2.data.responseText === "string" && turn2.data.responseText.length > 0);
});

test("frontend sources contain no ElevenLabs conversational-agent usage", async () => {
  const voiceSrc = await readFile(resolve(ROOT, "frontend/public/js/voice.js"), "utf8");
  const demoSrc = await readFile(resolve(ROOT, "frontend/public/js/demo.js"), "utf8");
  const apiSrc = await readFile(resolve(ROOT, "frontend/public/js/api.js"), "utf8");

  for (const [name, src] of [["voice.js", voiceSrc], ["demo.js", demoSrc], ["api.js", apiSrc]] as const) {
    assert.ok(!/elevenlabs/i.test(src.replace(/no elevenlabs/gi, "")), `${name} references ElevenLabs`);
    assert.ok(!src.includes("startSession({"), `${name} starts an agent SDK session`);
    assert.ok(!src.includes("conversationToken"), `${name} uses a conversation token`);
    assert.ok(!src.includes("@elevenlabs/client"), `${name} imports the ElevenLabs SDK`);
    assert.ok(!src.includes("/api/elevenlabs"), `${name} calls the ElevenLabs token endpoint`);
  }

  // The browser voice layer really is Web Speech API based.
  assert.ok(voiceSrc.includes("webkitSpeechRecognition"), "voice.js must use SpeechRecognition");
  assert.ok(voiceSrc.includes("speechSynthesis"), "voice.js must use speechSynthesis");
  assert.ok(voiceSrc.includes("SpeechSynthesisUtterance"), "voice.js must build TTS utterances");
  // The demo routes transcripts through the backend brain.
  assert.ok(demoSrc.includes("copilotTurn"), "demo.js must call the copilot turn API");
});
