import { randomUUID } from "node:crypto";
import type {
  CreativeBrief,
  GeneratedAsset,
  ProductionJob,
  ProductionStage,
} from "../types/creative.ts";
import { MOCK_SUMMARY, STAGE_PLAN } from "../mock/production.ts";

/**
 * Production pipeline contract.
 *
 * `MockProductionService` advances stages on a deterministic clock so the
 * UI can poll GET /api/production/:id. A future `GeminiVeoProductionService`
 * implements the same interface, driving real generation jobs and setting
 * a playable URL on the final asset. The frontend renders whatever the
 * job says — it has no knowledge of which implementation is running.
 */
export interface ProductionService {
  start(brief: CreativeBrief): ProductionJob;
  get(jobId: string): ProductionJob | null;
}

interface JobRecord {
  job: ProductionJob;
  brief: CreativeBrief;
  startedAtMs: number;
  /** Absolute elapsed-ms offset at which each stage completes. */
  stageEndsAt: number[];
}

export class MockProductionService implements ProductionService {
  private jobs = new Map<string, JobRecord>();

  start(brief: CreativeBrief): ProductionJob {
    const now = Date.now();
    let acc = 0;
    const stageEndsAt = STAGE_PLAN.map((s) => (acc += s.durationMs));

    const stages: ProductionStage[] = STAGE_PLAN.map((plan, index) => ({
      key: plan.key,
      index: index + 1,
      label: plan.label,
      status: plan.durationMs === 0 ? "complete" : "waiting",
      provider: plan.provider,
      startedAt: plan.durationMs === 0 ? new Date(now).toISOString() : null,
      completedAt: plan.durationMs === 0 ? new Date(now).toISOString() : null,
      detail: plan.detail,
    }));

    const job: ProductionJob = {
      id: randomUUID(),
      briefId: brief.id,
      status: "running",
      createdAt: new Date(now).toISOString(),
      completedAt: null,
      stages,
      assets: [],
      summary: null,
    };

    this.jobs.set(job.id, { job, brief, startedAtMs: now, stageEndsAt });
    return this.get(job.id)!;
  }

  get(jobId: string): ProductionJob | null {
    const record = this.jobs.get(jobId);
    if (!record) return null;
    this.advance(record);
    return record.job;
  }

  /** Recompute stage states from wall-clock elapsed time. Idempotent. */
  private advance(record: JobRecord): void {
    const { job, brief, startedAtMs, stageEndsAt } = record;
    if (job.status === "complete") return;

    const elapsed = Date.now() - startedAtMs;
    let allDone = true;

    job.stages.forEach((stage, i) => {
      const startsAt = i === 0 ? 0 : stageEndsAt[i - 1];
      const endsAt = stageEndsAt[i];
      if (elapsed >= endsAt) {
        if (stage.status !== "complete") {
          stage.status = "complete";
          stage.startedAt ??= new Date(startedAtMs + startsAt).toISOString();
          stage.completedAt = new Date(startedAtMs + endsAt).toISOString();
        }
      } else if (elapsed >= startsAt) {
        stage.status = "processing";
        stage.startedAt ??= new Date(startedAtMs + startsAt).toISOString();
        allDone = false;
      } else {
        allDone = false;
      }
    });

    if (allDone) {
      job.status = "complete";
      job.completedAt = new Date().toISOString();
      job.assets = [this.buildFinalAsset(job, brief)];
      job.summary = {
        requirementsCaptured: brief.requirements.filter((r) => r.value).length,
        creativeDecisions: MOCK_SUMMARY.creativeDecisions,
        stages: job.stages.length,
        humanReview: MOCK_SUMMARY.humanReview,
        finalFormat: this.finalFormat(brief),
      };
    }
  }

  private finalFormat(brief: CreativeBrief): string {
    const ratio = brief.requirements.find((r) => r.field === "aspectRatio")?.value ?? "9:16 vertical";
    return ratio.split(" ")[0];
  }

  private buildFinalAsset(job: ProductionJob, brief: CreativeBrief): GeneratedAsset {
    const duration = brief.requirements.find((r) => r.field === "duration")?.value ?? "8 seconds";
    return {
      id: randomUUID(),
      jobId: job.id,
      kind: "video",
      // Mock: no playable URL yet. GeminiVeoProductionService sets a real one;
      // the frontend falls back to a rendered preview while url is null.
      url: null,
      format: "mp4",
      aspectRatio: this.finalFormat(brief),
      durationSeconds: parseInt(duration, 10) || 8,
      title: brief.title,
      createdAt: new Date().toISOString(),
    };
  }
}

export const productionService: ProductionService = new MockProductionService();
