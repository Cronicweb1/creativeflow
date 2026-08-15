/**
 * Core creative-production data model.
 *
 * These types are the contract between the conversation layer, the brief
 * layer and the production layer. Future integrations (voice agent,
 * Gemini/Veo, Composio/MCP tools) must produce and consume these shapes —
 * the frontend is built exclusively against them.
 */

export type RequirementStatus = "not_collected" | "being_determined" | "confirmed";

export type RequirementField =
  | "client"
  | "product"
  | "campaign"
  | "platform"
  | "contentType"
  | "visualStyle"
  | "audience"
  | "duration"
  | "aspectRatio";

export interface CreativeRequirement {
  field: RequirementField;
  /** Human-readable label used by clients of the API. */
  label: string;
  value: string | null;
  status: RequirementStatus;
  /** 0–1. Mock services emit deterministic values; real extractors emit model confidence. */
  confidence: number;
  /** Where the value came from, e.g. "client conversation", "default", "operator". */
  source: string;
}

export interface CreativeDirection {
  mood: string;
  composition: string;
  lighting: string;
  camera: string;
  environment: string;
  colorPalette: string[];
  motion: string;
  avoid: string[];
}

export interface CreativeBrief {
  id: string;
  sessionId: string;
  createdAt: string;
  confirmedAt: string | null;
  title: string;
  requirements: CreativeRequirement[];
  direction: CreativeDirection;
}

export type StageStatus = "waiting" | "processing" | "complete" | "failed";

export type StageKey =
  | "conversation"
  | "extraction"
  | "brief"
  | "concept"
  | "image"
  | "video"
  | "review"
  | "delivery";

export interface ProductionStage {
  key: StageKey;
  index: number;
  label: string;
  status: StageStatus;
  /** Provider that will execute this stage in production, e.g. "gemini", "veo", "internal". */
  provider: string;
  startedAt: string | null;
  completedAt: string | null;
  /** Optional operator-facing detail line, e.g. "Rendering frame set 2 of 3". */
  detail: string | null;
}

export type AssetKind = "image" | "video";

export interface GeneratedAsset {
  id: string;
  jobId: string;
  kind: AssetKind;
  /** Null while mocked. A real production service sets a playable URL here. */
  url: string | null;
  format: string;
  aspectRatio: string;
  durationSeconds: number | null;
  title: string;
  createdAt: string;
}

export type JobStatus = "queued" | "running" | "complete" | "failed";

export interface ProductionSummary {
  requirementsCaptured: number;
  creativeDecisions: number;
  stages: number;
  humanReview: "required" | "not_required";
  finalFormat: string;
}

export interface ProductionJob {
  id: string;
  briefId: string;
  status: JobStatus;
  createdAt: string;
  completedAt: string | null;
  stages: ProductionStage[];
  assets: GeneratedAsset[];
  summary: ProductionSummary | null;
}
