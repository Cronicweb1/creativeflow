import type { StageKey } from "../types/creative.ts";

/**
 * Deterministic timing plan for the mock production pipeline.
 *
 * `durationMs` is how long each stage "runs" after the previous stage
 * finishes. The first four stages are already complete when a job starts
 * (they happened during the call), so they carry zero duration.
 */

export interface StagePlan {
  key: StageKey;
  label: string;
  provider: string;
  durationMs: number;
  detail: string;
}

export const STAGE_PLAN: StagePlan[] = [
  { key: "conversation", label: "Client conversation", provider: "internal", durationMs: 0, detail: "Captured during the call" },
  { key: "extraction", label: "Requirement extraction", provider: "internal", durationMs: 0, detail: "9 fields extracted" },
  { key: "brief", label: "Creative brief", provider: "internal", durationMs: 0, detail: "Brief confirmed by client" },
  { key: "concept", label: "Visual concept", provider: "gemini", durationMs: 2500, detail: "Composition, lighting and palette locked" },
  { key: "image", label: "Image generation", provider: "gemini", durationMs: 5000, detail: "Rendering key frames" },
  { key: "video", label: "Video generation", provider: "veo", durationMs: 7000, detail: "Generating 8s motion sequence" },
  { key: "review", label: "Quality review", provider: "internal", durationMs: 2500, detail: "Checking brief compliance" },
  { key: "delivery", label: "Final delivery", provider: "internal", durationMs: 1500, detail: "Packaging 9:16 master" },
];

export const MOCK_SUMMARY = {
  creativeDecisions: 18,
  humanReview: "not_required" as const,
};
