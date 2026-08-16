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
  /\b(don'?t|do not) ask (me )?(anything|any ?more)( else| more| questions)?\b/,
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


/* ---------- creative-intent extraction ---------- */

/** Generic placeholder product values that must never beat a real product. */
const GENERIC_PRODUCTS = new Set([
  "the featured product",
  "the user's product",
  "the product",
  "your product",
]);

export function isGenericProduct(value: string | null | undefined): boolean {
  if (!value) return true;
  return GENERIC_PRODUCTS.has(value.trim().toLowerCase());
}

const PLATFORM_CANON: Array<[RegExp, string]> = [
  [/\binstagram\b|\breels?\b/, "Instagram"],
  [/\btik ?tok\b/, "TikTok"],
  [/\byou ?tube\b|\bshorts\b/, "YouTube"],
  [/\bfacebook\b/, "Facebook"],
  [/\blinked ?in\b/, "LinkedIn"],
];

const PLATFORM_WORDS = [
  "instagram", "tiktok", "youtube", "facebook", "linkedin", "twitter",
  "snapchat", "pinterest", "reels", "shorts",
];

const PRODUCT_STOPWORDS = new Set([
  "video", "videos", "it", "this", "that", "one", "me", "us", "them",
  "the", "a", "an", "new", "another", "some", "more", "quick", "short",
  ...PLATFORM_WORDS,
]);

function cleanProduct(raw: string): string | null {
  let p = raw.trim();
  // Strip leading articles/possessives ("my premium skincare serum" => keep "premium ...").
  for (;;) {
    const next = p.replace(
      /^(?:please|make|create|generate|produce|build|want|need|me|my|our|the|a|an|this|that|some|new)\s+/,
      "",
    );
    if (next === p) break;
    p = next;
  }
  // Platform names are not products ("Instagram ad" => no product).
  p = p
    .split(/\s+/)
    .filter((w) => !PLATFORM_WORDS.includes(w))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!p) return null;
  if (p.split(" ").every((w) => PRODUCT_STOPWORDS.has(w))) return null;
  if (p.length < 3 || p.length > 80) return null;
  return p;
}

const NOUN = "[a-z0-9' -]+?";
const END = "(?=\\s*(?:$|[.!?,;:]|\\band\\b|\\bdon'?t\\b|\\bdo not\\b|\\bplease\\b|\\bnow\\b|\\bthat\\b|\\bwhich\\b))";

const PRODUCT_PATTERNS: RegExp[] = [
  // "... ad/commercial/video for my premium skincare serum"
  new RegExp(`\\b(?:ad|advert|advertisement|commercial|promo|video)\\s+for\\s+(${NOUN})${END}`),
  // "... about my handmade candle shop"
  new RegExp(`\\b(?:about|promoting|showcasing|featuring|advertising|selling)\\s+(${NOUN})${END}`),
  // "create a makeup kit ad" / "make a coffee subscription commercial"
  new RegExp(
    `\\b(?:create|make|generate|produce|build|want|need|do)\\s+(?:me\\s+)?(?:an?\\s+|the\\s+)?(${NOUN})\\s+(?:ad|advert|advertisement|commercial|promo)\\b`,
  ),
  // "skincare serum advertisement" (bare noun phrase + ad word)
  new RegExp(`(?:^|[.!?;,]\\s*)(${NOUN})\\s+(?:ad|advert|advertisement|commercial)\\b`),
];

/** Deterministic product/service extraction from a user message. */
export function extractProductService(text: string): string | null {
  const t = (text ?? "").toLowerCase().replace(/[\u2019\u2018\u0060]/g, "'");
  for (const re of PRODUCT_PATTERNS) {
    const m = re.exec(t);
    if (m?.[1]) {
      const cleaned = cleanProduct(m[1]);
      if (cleaned) return cleaned;
    }
  }
  return null;
}

/** Deterministic content-type extraction from a user message. */
export function extractContentType(text: string): string | null {
  const t = (text ?? "").toLowerCase();
  if (/\bproduct video\b/.test(t)) return "product video";
  if (/\b(ad|advert|advertisement|commercial|promo)\b/.test(t)) return "video advertisement";
  return null;
}

/** Deterministic platform extraction from a user message. */
export function extractPlatform(text: string): string | null {
  const t = (text ?? "").toLowerCase();
  for (const [re, canon] of PLATFORM_CANON) if (re.test(t)) return canon;
  return null;
}

export interface CreativeIntent {
  productService: string;
  contentType: string;
  platform: string;
  visualStyle: string;
  campaignObjective: string;
  targetAudience: string;
  duration: string;
  aspectRatio: string;
  mood: string;
  colorPalette: string;
  message: string;
  brandName: string | null;
  tagline: string | null;
}

function existingValue(
  existing: Record<string, unknown> | null | undefined,
  keys: string[],
): string | null {
  if (!existing) return null;
  for (const k of keys) {
    const v = existing[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Deterministic creative-intent resolver. Priority per field:
 *   1. explicit value in the user's latest message (most specific wins),
 *   2. real value already accumulated in the brief/requirements,
 *   3. safe default (defaults NEVER replace user-provided information).
 * A generic placeholder product ("the featured product") never beats a
 * real product from either source. Never invents a brand name.
 */
export function extractCreativeIntent(
  text: string,
  existingBrief?: Record<string, unknown> | null,
): CreativeIntent {
  const ex = (keys: string[]) => existingValue(existingBrief, keys);

  const extractedProduct = extractProductService(text);
  const existingProduct = ex(["productService", "product"]);
  const productService =
    extractedProduct ??
    (!isGenericProduct(existingProduct) ? (existingProduct as string) : null) ??
    FIELD_DEFAULTS.product;

  const brandRaw = ex(["brandName", "client"]);
  const brandName = brandRaw && brandRaw !== "Unbranded" ? brandRaw : null;

  const campaign = ex(["campaignObjective", "campaign"]);
  const tagline = ex(["tagline"]);
  const message =
    ex(["message"]) ??
    tagline ??
    campaign ??
    (!isGenericProduct(productService)
      ? `Discover ${productService}.`
      : "A premium showcase of the featured product.");

  return {
    productService,
    contentType:
      extractContentType(text) ?? ex(["contentType"]) ?? FIELD_DEFAULTS.contentType,
    platform: extractPlatform(text) ?? ex(["platform"]) ?? FIELD_DEFAULTS.platform,
    visualStyle: ex(["visualStyle"]) ?? FIELD_DEFAULTS.visualStyle,
    campaignObjective: campaign ?? FIELD_DEFAULTS.campaign,
    targetAudience: ex(["targetAudience", "audience"]) ?? FIELD_DEFAULTS.audience,
    duration: ex(["duration"]) ?? FIELD_DEFAULTS.duration,
    aspectRatio: ex(["aspectRatio"]) ?? FIELD_DEFAULTS.aspectRatio,
    mood: ex(["mood"]) ?? "premium, polished and engaging",
    colorPalette: ex(["colorPalette"]) ?? "modern neutral palette with warm accent tones",
    message,
    brandName,
    tagline: tagline ?? null,
  };
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
  latestMessage = "",
  contextMessages: string[] = [],
): Record<string, unknown> {
  const known = (f: RequirementField): string | null =>
    requirements.find((r) => r.field === f)?.value ?? null;

  const existing: Record<string, unknown> = {
    product: known("product"),
    client: known("client"),
    campaign: known("campaign"),
    platform: known("platform"),
    contentType: known("contentType"),
    visualStyle: known("visualStyle"),
    audience: known("audience"),
    duration: known("duration"),
    aspectRatio: known("aspectRatio"),
  };

  let intent = extractCreativeIntent(latestMessage, existing);

  // Still no real product from the latest message or accumulated brief?
  // Scan earlier user messages (newest first) — user-provided information
  // is NEVER discarded just because force mode triggered later.
  if (isGenericProduct(intent.productService)) {
    for (const msg of contextMessages) {
      const p = extractProductService(msg);
      if (p) {
        intent = extractCreativeIntent(msg, { ...existing, product: p });
        // Latest message still wins for contentType/platform if it had them.
        const ct = extractContentType(latestMessage);
        const pf = extractPlatform(latestMessage);
        if (ct) intent = { ...intent, contentType: ct };
        if (pf) intent = { ...intent, platform: pf };
        break;
      }
    }
  }

  return {
    sessionId,
    forceGenerate: true,
    brief: {
      client: intent.brandName,
      brandName: intent.brandName,
      product: intent.productService,
      campaign: intent.campaignObjective,
      platform: intent.platform,
      contentType: intent.contentType,
      visualStyle: intent.visualStyle,
      audience: intent.targetAudience,
      duration: intent.duration,
      aspectRatio: intent.aspectRatio,
      mood: intent.mood,
      colorPalette: intent.colorPalette,
      message: intent.message,
      tagline: intent.tagline,
    },
  };
}
