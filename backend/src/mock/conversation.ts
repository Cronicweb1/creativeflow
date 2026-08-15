import type { RequirementField, RequirementStatus } from "../types/creative.ts";

/**
 * Script for the simulated client call.
 *
 * Each step is one agent question plus the extraction rules applied to the
 * client's answer. The mock engine walks the steps in order; a real
 * conversation engine (voice agent + LLM extraction) replaces this file
 * entirely — nothing outside the mock layer references it.
 */

export interface ExtractionRule {
  field: RequirementField;
  /** If any keyword matches the client answer, use `value`; otherwise fall back to the raw answer when `fallbackToAnswer` is true. */
  keywords: string[];
  value: string;
  status: RequirementStatus;
  confidence: number;
  fallbackToAnswer?: boolean;
}

export interface ScriptStep {
  /** What the agent says before listening. */
  prompt: string;
  /** Extraction applied to the client's reply to this prompt. */
  extract: ExtractionRule[];
  /** Fields the agent is now trying to determine (rendered as ◌ in the brief panel). */
  probing: RequirementField[];
  /** Canned client answers offered by the simulated call UI. */
  suggestedResponses: string[];
}

export const INITIAL_REQUIREMENTS: Array<{ field: RequirementField; label: string }> = [
  { field: "client", label: "Client" },
  { field: "product", label: "Product" },
  { field: "campaign", label: "Campaign" },
  { field: "platform", label: "Platform" },
  { field: "contentType", label: "Content" },
  { field: "visualStyle", label: "Style" },
  { field: "audience", label: "Audience" },
  { field: "duration", label: "Duration" },
  { field: "aspectRatio", label: "Format" },
];

export const CONVERSATION_SCRIPT: ScriptStep[] = [
  {
    prompt:
      "Hi, I'm your CreativeFlow creative consultant. What are you looking to create?",
    probing: ["client", "product", "campaign"],
    extract: [
      {
        field: "product",
        keywords: ["serum", "skincare"],
        value: "Premium skincare serum",
        status: "confirmed",
        confidence: 0.97,
        fallbackToAnswer: true,
      },
      {
        field: "client",
        keywords: ["skincare"],
        value: "Premium skincare brand",
        status: "confirmed",
        confidence: 0.91,
        fallbackToAnswer: true,
      },
      {
        field: "campaign",
        keywords: ["launch", "launching", "new"],
        value: "Product launch",
        status: "being_determined",
        confidence: 0.78,
      },
    ],
    suggestedResponses: [
      "We're launching a new premium skincare serum.",
      "We need content for a handmade furniture collection.",
      "We're promoting a specialty coffee subscription.",
    ],
  },
  {
    prompt: "Great. Where will you primarily use the content?",
    probing: ["platform", "aspectRatio"],
    extract: [
      {
        field: "platform",
        keywords: ["instagram", "insta", "ig"],
        value: "Instagram",
        status: "confirmed",
        confidence: 0.98,
        fallbackToAnswer: true,
      },
      {
        field: "aspectRatio",
        keywords: ["instagram", "insta", "ig", "tiktok", "reels", "stories"],
        value: "9:16 vertical",
        status: "being_determined",
        confidence: 0.72,
      },
      {
        field: "campaign",
        keywords: [],
        value: "Product launch",
        status: "confirmed",
        confidence: 0.9,
      },
    ],
    suggestedResponses: ["Instagram.", "TikTok and Instagram Reels.", "Our website and YouTube."],
  },
  {
    prompt: "What kind of visual direction are you looking for?",
    probing: ["visualStyle"],
    extract: [
      {
        field: "visualStyle",
        keywords: ["premium", "natural", "luxury", "minimal"],
        value: "Premium · Natural · Minimal",
        status: "confirmed",
        confidence: 0.96,
        fallbackToAnswer: true,
      },
    ],
    suggestedResponses: [
      "Something premium and natural. Nothing too artificial.",
      "Bold, colorful and energetic.",
      "Clean and clinical, science-led.",
    ],
  },
  {
    prompt: "Who are you trying to reach?",
    probing: ["audience"],
    extract: [
      {
        field: "audience",
        keywords: ["20", "35", "young"],
        value: "Young adults, 20–35",
        status: "confirmed",
        confidence: 0.94,
        fallbackToAnswer: true,
      },
    ],
    suggestedResponses: [
      "Young adults, mostly 20 to 35.",
      "Professionals in their thirties and forties.",
      "A broad audience, skewing female.",
    ],
  },
  {
    prompt: "Understood. Are you thinking short video, still images, or both?",
    probing: ["contentType"],
    extract: [
      {
        field: "contentType",
        keywords: ["video", "reel", "clip"],
        value: "Short video",
        status: "confirmed",
        confidence: 0.95,
        fallbackToAnswer: true,
      },
    ],
    suggestedResponses: ["A short video.", "Both — a video plus a few stills.", "Still images for now."],
  },
  {
    prompt: "Last one — how long should it run? For Instagram, 6 to 10 seconds usually performs best.",
    probing: ["duration", "aspectRatio"],
    extract: [
      {
        field: "duration",
        keywords: ["8", "eight"],
        value: "8 seconds",
        status: "confirmed",
        confidence: 0.99,
        fallbackToAnswer: true,
      },
      {
        field: "aspectRatio",
        keywords: [],
        value: "9:16 vertical",
        status: "confirmed",
        confidence: 0.95,
      },
    ],
    suggestedResponses: ["Let's do 8 seconds.", "Around 10 seconds.", "Whatever you recommend."],
  },
];

export const WRAP_UP_MESSAGE =
  "Perfect — I've captured everything I need. Before production begins, let's confirm the brief on your screen.";
