/**
 * End-to-end API journey test (node --test).
 * Boots the real server on an ephemeral port and walks the full flow:
 * session → conversation → brief → confirm → production → final asset.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: (await res.json()) as any };
}

test("full client-to-production journey", async (t) => {
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => proc.kill());
  await once(proc.stdout!, "data"); // wait for "listening" log

  // health
  const health = await call("GET", "/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.data.status, "ok");

  // static frontend served
  const page = await fetch(BASE + "/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /CreativeFlow/);

  // session
  const start = await call("POST", "/api/demo/session");
  assert.equal(start.status, 201);
  const sessionId = start.data.session.sessionId as string;
  assert.ok(start.data.suggestedResponses.length > 0);
  assert.equal(start.data.session.phase, "gathering");

  // walk the conversation to completion
  const answers = [
    "We're launching a new premium skincare serum.",
    "Instagram.",
    "Something premium and natural. Nothing too artificial.",
    "Young adults, mostly 20 to 35.",
    "A short video.",
    "Let's do 8 seconds.",
  ];
  let phase = "gathering";
  for (const text of answers) {
    const turn = await call("POST", "/api/demo/message", { sessionId, text });
    assert.equal(turn.status, 200);
    phase = turn.data.phase;
  }
  assert.equal(phase, "review");

  // requirement shape
  const session = await call("GET", `/api/demo/session/${sessionId}`);
  const style = session.data.session.requirements.find((r: any) => r.field === "visualStyle");
  assert.equal(style.status, "confirmed");
  assert.ok(style.confidence > 0.9);
  assert.equal(style.source, "client conversation");

  // brief
  const built = await call("POST", "/api/brief/build", { sessionId });
  assert.equal(built.status, 201);
  const briefId = built.data.brief.id as string;
  assert.ok(built.data.brief.direction.avoid.length >= 3);

  // production refuses unconfirmed brief
  const early = await call("POST", "/api/production/start", { briefId });
  assert.equal(early.status, 409);

  const confirmed = await call("POST", "/api/brief/confirm", { briefId });
  assert.equal(confirmed.status, 200);
  assert.ok(confirmed.data.brief.confirmedAt);

  // production
  const started = await call("POST", "/api/production/start", { briefId });
  assert.equal(started.status, 201);
  const jobId = started.data.job.id as string;
  assert.equal(started.data.job.stages.length, 8);
  assert.equal(started.data.job.stages[0].status, "complete");

  // poll to completion (mock clock ≈ 18.5s)
  let job = started.data.job;
  for (let i = 0; i < 60 && job.status !== "complete"; i++) {
    await new Promise((r) => setTimeout(r, 500));
    job = (await call("GET", `/api/production/${jobId}`)).data.job;
  }
  assert.equal(job.status, "complete");
  assert.ok(job.stages.every((s: any) => s.status === "complete"));
  assert.equal(job.assets.length, 1);
  assert.equal(job.assets[0].kind, "video");
  assert.equal(job.summary.stages, 8);
  assert.equal(job.summary.finalFormat, "9:16");

  // reopen flow
  const reopened = await call("POST", "/api/brief/reopen", { sessionId });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.data.session.phase, "gathering");
});
