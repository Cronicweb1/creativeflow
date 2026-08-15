import { randomUUID } from "node:crypto";
import type { Conversation } from "../types/conversation.ts";
import type { CreativeBrief, CreativeDirection } from "../types/creative.ts";

/**
 * Turns a completed conversation into a production-ready creative brief.
 *
 * The mock derives creative direction from the captured style keywords.
 * A future LLM-backed implementation replaces `deriveDirection` with a
 * model call; the brief shape stays identical.
 */
export interface BriefService {
  buildBrief(conversation: Conversation): CreativeBrief;
  getBrief(briefId: string): CreativeBrief | null;
  confirmBrief(briefId: string): CreativeBrief;
}

function deriveDirection(conversation: Conversation): CreativeDirection {
  const style = (
    conversation.requirements.find((r) => r.field === "visualStyle")?.value ?? ""
  ).toLowerCase();
  const premiumNatural = style.includes("premium") || style.includes("natural") || style.includes("luxury");

  if (premiumNatural) {
    return {
      mood: "Premium, calm, natural",
      composition: "Product centered with generous negative space.",
      lighting: "Soft diffused morning light.",
      camera: "Slow macro push-in.",
      environment: "Minimal warm-neutral bathroom setting.",
      colorPalette: ["#F5F1EA", "#D9CDBD", "#A98F72", "#3E362E"],
      motion: "Subtle product rotation and natural environmental movement.",
      avoid: [
        "Overly artificial skin",
        "Excessive visual effects",
        "Cluttered backgrounds",
        "Aggressive camera movement",
      ],
    };
  }

  return {
    mood: "Confident, modern, direct",
    composition: "Product hero framing with strong diagonal balance.",
    lighting: "Controlled studio key with soft fill.",
    camera: "Measured lateral dolly with a single reveal.",
    environment: "Seamless studio backdrop in a complementary tone.",
    colorPalette: ["#F2F2F0", "#C9CDD2", "#5B6470", "#1C1E22"],
    motion: "One deliberate product move; restrained secondary motion.",
    avoid: [
      "Visual clutter",
      "Trend-driven effects",
      "Inconsistent color grading",
      "Rapid cutting",
    ],
  };
}

export class MockBriefService implements BriefService {
  private briefs = new Map<string, CreativeBrief>();

  buildBrief(conversation: Conversation): CreativeBrief {
    const client = conversation.requirements.find((r) => r.field === "client")?.value ?? "Client";
    const campaign = conversation.requirements.find((r) => r.field === "campaign")?.value ?? "Campaign";
    const brief: CreativeBrief = {
      id: randomUUID(),
      sessionId: conversation.sessionId,
      createdAt: new Date().toISOString(),
      confirmedAt: null,
      title: `${client} — ${campaign}`,
      requirements: conversation.requirements.map((r) => ({ ...r })),
      direction: deriveDirection(conversation),
    };
    this.briefs.set(brief.id, brief);
    return brief;
  }

  getBrief(briefId: string): CreativeBrief | null {
    return this.briefs.get(briefId) ?? null;
  }

  confirmBrief(briefId: string): CreativeBrief {
    const brief = this.briefs.get(briefId);
    if (!brief) throw new Error("brief_not_found");
    brief.confirmedAt = new Date().toISOString();
    brief.requirements = brief.requirements.map((r) => ({
      ...r,
      status: r.value ? "confirmed" : r.status,
    }));
    return brief;
  }
}

export const briefService: BriefService = new MockBriefService();
