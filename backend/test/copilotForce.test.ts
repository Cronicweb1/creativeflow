/**
 * Force-generation conversation tests (node --test).
 *
 * A. "Just generate the video. Don't ask any more questions." => force, ready, no question
 * B. "I don't have a brand. Just generate it." => brand resolved (unbranded), force, ready
 * C. "Use whatever you think is best and make the video." => force, ready
 * D. Normal clarification answer => forceGenerate=false, conversation continues
 * E. Previously declined brand => AI never asks for brand name again
 * F. "No more questions" after partial info => generation branch runs with defaults
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import {
  detectForceGenerate,
  detectDecline,
  inferAskedField,
  buildForcedBrief,
  FORCE_GENERATE_REPLY,
} from "../src/services/forceGenerate.ts";
import {
  GuardedCopilotProvider,
  type CopilotProvider,
  type CopilotTurnResult,
} from "../src/services/copilotService.ts";
import { MockConversationService } from "../src/services/conversationService.ts";

const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
const PORT = 3979;
const BASE = `http://127.0.0.1:${PORT}`;

test("detectForceGenerate: all required trigger phrases", () => {
  const triggers = [
    "just generate the video",
    "generate it",
    "just create it",
    "create the video",
    "make the video",
    "don't ask any more questions",
    "no more questions",
    "stop asking questions",
    "use whatever you think is best",
    "go ahead",
    "proceed",
    "just do it",
    "make it with what you have",
    "that's enough, generate it",
    "Just generate the video. Don't ask any more questions.",
    "I don't have that, just make it",
  ];
  for (const msg of triggers) {
    assert.equal(detectForceGenerate(msg), true, `should trigger: "${msg}"`);
  }
});

test("detectForceGenerate: ordinary answers/discussion do NOT trigger", () => {
  const nonTriggers = [
    "Instagram",
    "We're launching a new premium skincare serum.",
    "I want to make the video about my coffee shop",
    "Young adults, mostly 20 to 35.",
    "It should generate excitement around the launch",
    "The campaign is about creating awareness",
    "Let's do 8 seconds.",
    "Something premium and natural.",
  ];
  for (const msg of nonTriggers) {
    assert.equal(detectForceGenerate(msg), false, `should NOT trigger: "${msg}"`);
  }
});

test("detectDecline and inferAskedField basics", () => {
  assert.equal(detectDecline("I don't have one."), true);
  assert.equal(detectDecline("No tagline"), true);
  assert.equal(detectDecline("Any color is fine"), true);
  assert.equal(detectDecline("I don't care"), true);
  assert.equal(detectDecline("We're a premium skincare brand called Lumo"), false);
  assert.equal(inferAskedField("What is your brand name?"), "client");
  assert.equal(inferAskedField("Which platform is this for?"), "platform");
  assert.equal(inferAskedField("Great choice!"), null);
});

test("buildForcedBrief fills defaults and never invents a brand", () => {
  const brief = buildForcedBrief("s1", [
    { field: "product", label: "Product", value: "a coffee mug", status: "confirmed", confidence: 1, source: "t" },
  ] as any) as any;
  assert.equal(brief.brief.product, "a coffee mug");
  assert.equal(brief.brief.brandName, null);
  assert.equal(brief.brief.client, null);
  assert.equal(brief.brief.platform, "Instagram");
  assert.equal(brief.brief.contentType, "video advertisement");
  assert.equal(brief.brief.visualStyle, "cinematic");
  assert.equal(brief.brief.campaign, "brand awareness");
  assert.equal(brief.brief.audience, "general target audience");
  assert.equal(brief.brief.duration, "8");
  assert.equal(brief.brief.aspectRatio, "9:16");
  assert.ok(brief.brief.mood);
  assert.ok(brief.brief.colorPalette);
  assert.ok(brief.brief.message.includes("coffee mug"));
});

/** Stub provider that always asks for the brand name. */
function brandAskingProvider(): CopilotProvider & { calls: number } {
  return {
    name: "mock" as const,
    calls: 0,
    async turn(): Promise<CopilotTurnResult> {
      (this as any).calls += 1;
      return {
        responseText: "What is your brand name?",
        requirements: {},
        missing: ["client"],
        complete: false,
        readyForProduction: false,
        productionBrief: null,
        provider: "mock",
      };
    },
  };
}

test("A: 'Just generate the video. Don't ask any more questions.' => force, ready, no question", async () => {
  const conv = new MockConversationService();
  const session = conv.startSession();
  const guarded = new GuardedCopilotProvider(brandAskingProvider(), conv);
  const r = await guarded.turn({
    sessionId: session.sessionId,
    userMessage: "Just generate the video. Don't ask any more questions.",
    conversationState: {},
  });
  assert.equal(r.forceGenerate, true);
  assert.equal(r.readyForProduction, true);
  assert.equal(r.complete, true);
  assert.deepEqual(r.missing, []);
  assert.equal(r.responseText, FORCE_GENERATE_REPLY);
  assert.ok(!r.responseText.includes("?"));
  assert.ok(r.productionBrief);
});

test("B: 'I don't have a brand. Just generate it.' => brand unbranded, force, ready", async () => {
  const conv = new MockConversationService();
  const session = conv.startSession();
  const inner = brandAskingProvider();
  const guarded = new GuardedCopilotProvider(inner, conv);
  // Agent asks for the brand first.
  const q = await guarded.turn({
    sessionId: session.sessionId,
    userMessage: "hello",
    conversationState: {},
  });
  assert.equal(q.responseText, "What is your brand name?");
  const r = await guarded.turn({
    sessionId: session.sessionId,
    userMessage: "I don't have a brand. Just generate it.",
    conversationState: {},
  });
  assert.equal(r.forceGenerate, true);
  assert.equal(r.readyForProduction, true);
  const brief = r.productionBrief as any;
  // Declined brand => unbranded ad, never an invented real brand.
  assert.equal(brief.brief.brandName, null);
  assert.equal(brief.brief.client, null);
  assert.ok(!r.responseText.includes("?"));
});

test("C: 'Use whatever you think is best and make the video.' => force, ready", async () => {
  const conv = new MockConversationService();
  const session = conv.startSession();
  const guarded = new GuardedCopilotProvider(brandAskingProvider(), conv);
  const r = await guarded.turn({
    sessionId: session.sessionId,
    userMessage: "Use whatever you think is best and make the video.",
    conversationState: {},
  });
  assert.equal(r.forceGenerate, true);
  assert.equal(r.readyForProduction, true);
  assert.ok(r.productionBrief);
});

test("D: normal clarification answer => forceGenerate=false, conversation continues", async () => {
  const conv = new MockConversationService();
  const session = conv.startSession();
  const inner = brandAskingProvider();
  const guarded = new GuardedCopilotProvider(inner, conv);
  const r = await guarded.turn({
    sessionId: session.sessionId,
    userMessage: "We're launching a new premium skincare serum.",
    conversationState: {},
  });
  assert.equal(r.forceGenerate, false);
  assert.equal(r.readyForProduction, false);
  assert.equal(inner.calls, 1); // inner provider still consulted
  assert.equal(r.responseText, "What is your brand name?");
});

test("E: declined brand is never asked again", async () => {
  const conv = new MockConversationService();
  const session = conv.startSession();
  const guarded = new GuardedCopilotProvider(brandAskingProvider(), conv);
  // Turn 1: agent asks brand.
  await guarded.turn({ sessionId: session.sessionId, userMessage: "hello", conversationState: {} });
  // Turn 2: user declines. Inner stub STILL tries to ask brand again.
  const r2 = await guarded.turn({
    sessionId: session.sessionId,
    userMessage: "I don't have one.",
    conversationState: {},
  });
  assert.ok(!/brand name\?/i.test(r2.responseText), `re-asked brand: "${r2.responseText}"`);
  assert.ok(!r2.missing.includes("client"));
  // Turn 3: still never re-asks brand.
  const r3 = await guarded.turn({
    sessionId: session.sessionId,
    userMessage: "It's a handmade ceramic mug.",
    conversationState: {},
  });
  assert.ok(!/brand name\?/i.test(r3.responseText));
  assert.ok(!r3.missing.includes("client"));
});

test("F: 'No more questions' after partial info => video branch runs with defaults (HTTP)", async (t) => {
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), COPILOT_PROVIDER: "mock", COMPOSIO_API_KEY: "" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => proc.kill());
  await once(proc.stdout!, "data");

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(BASE + path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: (await res.json()) as any };
  };

  const start = await call("POST", "/api/demo/session");
  const sessionId = start.data.session.sessionId as string;

  // Partial info only.
  await call("POST", "/api/copilot/turn", {
    sessionId,
    userMessage: "It's a video for my handmade candle shop.",
  });
  const turn = await call("POST", "/api/copilot/turn", {
    sessionId,
    userMessage: "No more questions",
  });
  assert.equal(turn.status, 200);
  assert.equal(turn.data.forceGenerate, true);
  assert.equal(turn.data.readyForProduction, true);
  assert.ok(turn.data.productionBrief);
  const brief = turn.data.productionBrief.brief;
  assert.equal(brief.contentType ?? "video advertisement", "video advertisement");
  assert.equal(brief.aspectRatio, "9:16");

  // Router equivalent: generation branch executes with the defaulted brief.
  const gen = await call("POST", "/api/video/generate", {
    sessionId,
    productionBrief: turn.data.productionBrief,
  });
  assert.equal(gen.status, 202);
  assert.equal(gen.data.status, "generating");
  assert.ok(gen.data.jobId);
});
