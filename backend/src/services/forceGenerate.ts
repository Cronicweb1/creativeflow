import type { CreativeRequirement, RequirementField } from "../types/creative.ts";

/**
 * Force-generation + decline detection for the conversation flow.
 *
 * When the user explicitly asks to generate the video without further
 * questions ("just generate it", "no more questions", ...), discovery must
 * stop IMMEDIATELY: no more clarification questions, sensible defaults for
 * anything unspecified, and a complete productionBrief.
 *
 * Pure functions only — easy to unit test, no session state here.
 */

/** Exact instruction forwarded to the live (Groq) workflow system prompt. */
export const FORCE_GENERATE_SYSTEM_INSTRUCTION =
  "If the user explicitly asks you to generate/create the video and tells you not to ask " +
  "additional questions, STOP DISCOVERY IMMEDIATELY. Do not ask another question. Use the " +
  "information already collected and sensible defaults for unspecified fields. Mark the " +
  "request ready for production and return a complete productionBrief.";

/** Fixed reply once force-generation is engaged. */
export const FORCE_GENERATE_REPLY =
  "Got it — I'll generate the video using what you've provided.";

/** Lowercase, strip punctuation, collapse whitespace. */
export function normalizeMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const FORCE_ANYWHERE: RegExp[] = [
  /\b(don'?t|do not|no) (ask )?(any )?more questions\b/,
  /\bstop asking( me)?( any| more)?( questions)?\b/,
  /\bjust (generate|create|make|do|build|produce)\b/,
  /\b(use )?whatever you think is best\b/,
  /\bwith what (you|we) (already )?have\b/,
  /\bgo ahead and (generate|create|make|do)\b/,
  /\bthat'?s enough\b.*\b(generate|create|make)\b/,
];

// Bare imperative commands — only when the (short) message IS the command,
// so ordinary discussion ("I want to make the video about my shop") and
// answers to questions never trigger force mode.
const FORCE_BARE: RegExp[] = [
  /^(ok(ay)? )?(please )?(go ahead|proceed)( now| please)?$/,
  /^(ok(ay)? )?(please )?(generate|create|make) (it|the video|this video|the ad|one)( now| please)?$/,
  /^(ok(ay)? )?(please )?(generate|create|make)( it)?( now| please)?$/,
];

/**
 * True when the CURRENT user message clearly means: "stop asking questions
 * and generate using whatever information is already available."
 */
export function detectForceGenerate(message: string): boolean {
  const n = normalizeMessage(message);
  if (!n) return false;
  // Evaluate bare commands per sentence so "I don't have a brand. Just
  // generate it." and "Ok. Go ahead." both work.
  const sentences = message
    .toLowerCase()
    .split(/[.!?;,]+/)
    .map((s) => normalizeMessage(s))
    .filter(Boolean);
  if (FORCE_ANYWHERE.some((re) => re.test(n))) return true;
  return sentences.some((s) => FORCE_BARE.some((re) => re.test(s)));
}

const DECLINE_ANYWHERE: RegExp[] = [
  /\b(don'?t|do not) have (one|a|any|that|it)\b/,
  /\b(don'?t|do not) have a [a-z]+\b/,
  /\b(don'?t|do not) care\b/,
  /\b(doesn'?t|does not) matter\b/,
  /\bno preference\b/,
  /\bwhatever works\b/,
  /\bany(thing| of (them|those))? is fine\b/,
  /\bany (colou?r|style|platform|palette|one) (is |works )?(fine|ok(ay)?|good)?\b/,
  /\bskip (that|it|this)\b/,
];

const DECLINE_BARE: RegExp[] = [
  /^no( [a-z]+){0,2}$/, // "no", "no tagline", "no brand name"
  /^(none|nothing|whatever|skip)$/,
  /^(i )?(don'?t|do not) know$/,
];

/**
 * True when the message declines to provide the field that was just asked
 * ("I don't have one", "no tagline", "any color is fine", "I don't care").
 */
export function detectDecline(message: string): boolean {
  const n = normalizeMessage(message);
  if (!n) return false;
  if (DECLINE_ANYWHERE.some((re) => re.test(n))) return true;
  const sentences = message
    .toLowerCase()
    .split(/[.!?;,]+/)
    .map((s) => normalizeMessage(s))
    .filter(Boolean);
  return sentences.some((s) => DECLINE_BARE.some((re) => re.test(s)));
}

const FIELD_HINTS: Array<[RequirementField, RegExp]> = [
  ["client", /\b(brand|company|client|business)\b/],
  ["aspectRatio", /\b(aspect ratio|orientation|vertical|horizontal|portrait|landscape)\b/],
  ["duration", /\b(duration|how long|length|seconds)\b/],
  ["platform", /\bplatform\b/],
  ["contentType", /\b(content type|type of (video|content)|kind of (video|content)|format)\b/],
  ["campaign", /\b(campaign|objective|goal|tagline|message)\b/],
  ["visualStyle", /\b(style|look|visual|aesthetic|colou?r|palette|mood|tone)\b/],
  ["audience", /\b(audience|target|demographic|who (is|are) (it|this|we))\b/],
  ["product", /\b(product|service|selling|advertis\w*|promot\w*|creating|working on)\b/],
];

/** Which requirement field an agent question is asking about (best effort). */
export function inferAskedField(agentText: string): RequirementField | null {
  if (!agentText || !agentText.includes("?")) return null;
  const n = agentText.toLowerCase();
  for (const [field, re] of FIELD_HINTS) if (re.test(n)) return field;
  return null;
}

/** Sensible defaults — never a real/invented brand. */
export const FIELD_DEFAULTS: Record<RequirementField, string> = {
  client: "Unbranded",
  product: "the featured product",
  campaign: "brand awareness",
  platform: "Instagram",
  contentType: "video advertisement",
  visualStyle: "cinematic",
  audience: "general target audience",
  duration: "8",
  aspectRatio: "9:16",
};

/**
 * Build a complete productionBrief from everything collected so far,
 * filling unspecified fields with sensible defaults. Preserves the existing
 * productionBrief schema ({ sessionId, brief: {...} }) consumed by the
 * video pipeline, plus defaulted creative extras.
 */
export function buildForcedBrief(
  sessionId: string,
  requirements: CreativeRequirement[],
): Record<string, unknown> {
  const known = (f: RequirementField): string | null =>
    requirements.find((r) => r.field === f)?.value ?? null;
  const or = (f: RequirementField): string => known(f) ?? FIELD_DEFAULTS[f];

  const product = or("product");
  const rawClient = known("client");
  // Never invent a real brand: unknown/declined brand => unbranded ad.
  const brandName = rawClient && rawClient !== "Unbranded" ? rawClient : null;

  return {
    sessionId,
    forceGenerate: true,
    brief: {
      client: brandName,
      brandName,
      product,
      campaign: or("campaign"),
      platform: or("platform"),
      contentType: or("contentType"),
      visualStyle: or("visualStyle"),
      audience: or("audience"),
      duration: or("duration"),
      aspectRatio: or("aspectRatio"),
      mood: "premium, polished and engaging",
      colorPalette: "modern neutral palette with warm accent tones",
      message:
        known("campaign") ??
        (known("product") ? `Discover ${product}.` : "A premium showcase of the featured product."),
    },
  };
}
