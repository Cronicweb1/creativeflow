/**
 * Production timeline <-> real video generation sync (node --test).
 *
 * The simulated production job advances on timers while the REAL Veo job is
 * polled separately. These tests cover the pure helpers that keep the
 * "Video generation" timeline stage in sync with the real job:
 *
 *   PS1. passthrough when no video job is pending
 *   PS2. simulated-complete video stage is clamped to processing
 *   PS3. stages after video generation are held at waiting
 *   PS4. job.status "complete" is held at processing (result page waits)
 *   PS5. stages before video generation are untouched
 *   PS6. a still-waiting video stage stays waiting (no premature spinner)
 *   PS7. responses without stages / without a video stage pass through
 *   PS8. computeVideoPending phase mapping (pending vs terminal)
 *   PS9. resolved video (completed/failed) unclamps the timeline
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// @ts-ignore - plain browser ES module, DOM-free at import time
import { computeVideoPending, syncProductionWithVideo } from "../../frontend/public/js/videoStatus.js";

type Stage = { index: number; label: string; status: string; detail?: string };

function makeJob(statuses: string[], jobStatus = "processing") {
  const labels = [
    "Client conversation",
    "Requirement extraction",
    "Creative brief",
    "Visual concept",
    "Image generation",
    "Video generation",
    "Quality review",
    "Final delivery",
  ];
  const stages: Stage[] = labels.map((label, i) => ({
    index: i + 1,
    label,
    status: statuses[i] ?? "waiting",
  }));
  return { job: { id: "job-1", status: jobStatus, stages } };
}

const ALL_COMPLETE = Array(8).fill("complete");

test("PS1: passthrough when no video job is pending", () => {
  const res = makeJob(ALL_COMPLETE, "complete");
  const out = syncProductionWithVideo(res, false);
  assert.equal(out, res); // same reference — untouched
});

test("PS2: simulated-complete video stage is clamped to processing while pending", () => {
  const out = syncProductionWithVideo(makeJob(ALL_COMPLETE, "complete"), true);
  const video = out.job.stages.find((s: Stage) => s.label === "Video generation");
  assert.equal(video.status, "processing");
  assert.ok(video.detail && /veo/i.test(video.detail));
});

test("PS3: stages after video generation are held at waiting while pending", () => {
  const out = syncProductionWithVideo(makeJob(ALL_COMPLETE, "complete"), true);
  const review = out.job.stages.find((s: Stage) => s.label === "Quality review");
  const delivery = out.job.stages.find((s: Stage) => s.label === "Final delivery");
  assert.equal(review.status, "waiting");
  assert.equal(delivery.status, "waiting");
});

test("PS4: job.status complete is held at processing so the result page waits", () => {
  const out = syncProductionWithVideo(makeJob(ALL_COMPLETE, "complete"), true);
  assert.equal(out.job.status, "processing");
});

test("PS5: stages before video generation are untouched", () => {
  const statuses = ["complete", "complete", "complete", "complete", "processing", "waiting", "waiting", "waiting"];
  const out = syncProductionWithVideo(makeJob(statuses), true);
  for (let i = 0; i < 5; i++) assert.equal(out.job.stages[i].status, statuses[i]);
});

test("PS6: a still-waiting video stage stays waiting (no premature spinner)", () => {
  const statuses = ["complete", "complete", "processing", "waiting", "waiting", "waiting", "waiting", "waiting"];
  const out = syncProductionWithVideo(makeJob(statuses), true);
  const video = out.job.stages.find((s: Stage) => s.label === "Video generation");
  assert.equal(video.status, "waiting");
});

test("PS7: responses without stages or without a video stage pass through", () => {
  assert.equal(syncProductionWithVideo(null, true), null);
  const noJob = { ok: true };
  assert.equal(syncProductionWithVideo(noJob, true), noJob);
  const noVideo = { job: { id: "x", status: "complete", stages: [{ index: 1, label: "Only stage", status: "complete" }] } };
  assert.equal(syncProductionWithVideo(noVideo, true), noVideo);
});

test("PS8: computeVideoPending — pending phases vs terminal phases", () => {
  assert.equal(computeVideoPending(null), false);
  assert.equal(computeVideoPending({ phase: "idle" }), true);
  assert.equal(computeVideoPending({ phase: "starting" }), true);
  assert.equal(computeVideoPending({ phase: "generating" }), true);
  assert.equal(computeVideoPending({ phase: "completed" }), false);
  assert.equal(computeVideoPending({ phase: "failed" }), false);
  assert.equal(computeVideoPending({ phase: "timeout" }), false);
  assert.equal(computeVideoPending({ phase: "stopped" }), false);
});

test("PS9: once the real job resolves, the timeline unclamps and completes", () => {
  const res = makeJob(ALL_COMPLETE, "complete");
  // While generating: clamped.
  const during = syncProductionWithVideo(res, computeVideoPending({ phase: "generating" }));
  assert.equal(during.job.status, "processing");
  // After completion (or failure): passthrough — timeline may complete.
  const after = syncProductionWithVideo(res, computeVideoPending({ phase: "completed" }));
  assert.equal(after.job.status, "complete");
  const failed = syncProductionWithVideo(res, computeVideoPending({ phase: "failed" }));
  assert.equal(failed.job.status, "complete");
});
