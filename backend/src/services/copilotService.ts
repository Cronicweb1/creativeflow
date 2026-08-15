import type { ConversationService, MockConversationService } from "./conversationService.ts";
import type { CreativeRequirement, RequirementField } from "../types/creative.ts";

/**
 * Copilot Studio bridge — the conversational intelligence ("brain") layer.
 *
 * Architecture:
 *   ElevenLabs = voice/audio transport (ASR + TTS)
 *   Copilot Studio = decides what to say next + extracts requirements
 *   This backend = secure bridge + session/state layer
 *
 * The browser NEVER talks to Copilot Studio directly. Every conversational
 * turn flows: browser/ElevenLabs → this backend → Copilot → back.
 *
 * Providers (COPILOT_PROVIDER env):
 *   "mock" (default) — deterministic local intake logic; no external calls,
 *                      no credits consumed. Delegates slot-filling to the
 *                      existing conversation engine so the downstream
 *                      brief/production pipeline works unchanged.
 *   "live"           — POSTs each turn to the Copilot Studio workflow at
 *                      COPILOT_WORKFLOW_URL (synchronous request/response),
 *                      authenticated with COPILOT_AUTH_TOKEN when set.
 */

export interface CopilotTurnInput {
  sessionId: string;
  userMessage: string;
  conversationState: Record<string, string | null | string[]>;
}

export interface CopilotTurnResult {
  responseText: string;
  requirements: Record<string, string>;
  missing: string[];
  complete: boolean;
  readyForProduction: boolean;
  productionBrief: Record<string, unknown> | null;
  provider: "mock" | "live";
  degraded?: boolean;
}

export interface CopilotProvider {
  readonly name: "mock" | "live";
  turn(input: CopilotTurnInput): Promise<CopilotTurnResult>;
}

/** Controlled fallback — never let a second AI invent a response. */
export const COPILOT_FALLBACK_TEXT =
  "Sorry, I had a brief connection issue. Could you say that again?";

function requirementsToMap(reqs: CreativeRequirement[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const r of reqs) if (r.value) map[r.field] = r.value;
  return map;
}

function missingFields(reqs: CreativeRequirement[]): string[] {
  return reqs.filter((r) => !r.value).map((r) => r.field);
}

/** Safe structured logging — no API keys, no utterance content. */
function logTurn(entry: {
  sessionId: string;
  provider: string;
  status: "ok" | "error" | "fallback";
  latencyMs: number;
  errorCategory?: string;
}): void {
  console.log(
    JSON.stringify({ at: new Date().toISOString(), scope: "copilot_turn", ...entry }),
  );
}

class MockCopilotProvider implements CopilotProvider {
  readonly name = "mock" as const;

  private conversation: ConversationService & Partial<MockConversationService>;

  constructor(conversation: ConversationService & Partial<MockConversationService>) {
    this.conversation = conversation;
  }

  async turn(input: CopilotTurnInput): Promise<CopilotTurnResult> {
    const started = Date.now();
    const session = this.conversation.getSession(input.sessionId);
    if (!session) throw new Error("session_not_found");

    let responseText: string;
    if (session.phase !== "gathering") {
      responseText =
        "I have everything I need — please review and confirm the brief on screen.";
    } else {
      const turn = this.conversation.handleClientMessage(input.sessionId, input.userMessage);
      responseText = turn.reply.text;
    }

    const current = this.conversation.getSession(input.sessionId)!;
    const complete = current.phase !== "gathering";
    logTurn({
      sessionId: input.sessionId,
      provider: this.name,
      status: "ok",
      latencyMs: Date.now() - started,
    });
    return {
      responseText,
      requirements: requirementsToMap(current.requirements),
      missing: missingFields(current.requirements),
      complete,
      // Confirmation is a SEPARATE explicit step — never auto-approve
      // just because all fields are filled.
      readyForProduction: false,
      productionBrief: null,
      provider: this.name,
    };
  }
}

const KNOWN_FIELDS: RequirementField[] = [
  "client",
  "product",
  "campaign",
  "platform",
  "contentType",
  "visualStyle",
  "audience",
  "duration",
  "aspectRatio",
];

const COPILOT_TIMEOUT_MS = 15_000;

class LiveCopilotProvider implements CopilotProvider {
  readonly name = "live" as const;

  private url: string;
  private authToken: string | undefined;
  private conversation: ConversationService & Partial<MockConversationService>;

  constructor(
    url: string,
    authToken: string | undefined,
    conversation: ConversationService & Partial<MockConversationService>,
  ) {
    this.url = url;
    this.authToken = authToken;
    this.conversation = conversation;
  }

  async turn(input: CopilotTurnInput): Promise<CopilotTurnResult> {
    const started = Date.now();
    const session = this.conversation.getSession(input.sessionId);
    if (!session) throw new Error("session_not_found");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), COPILOT_TIMEOUT_MS);
    let raw: Record<string, unknown>;
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.authToken) headers.authorization = `Bearer ${this.authToken}`;
      const res = await fetch(this.url, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          sessionId: input.sessionId,
          userMessage: input.userMessage,
          conversationState: input.conversationState,
        }),
      });
      if (!res.ok) throw new Error(`copilot_http_${res.status}`);
      raw = (await res.json()) as Record<string, unknown>;
    } catch (err) {
      clearTimeout(timer);
      const category =
        err instanceof Error && err.name === "AbortError"
          ? "timeout"
          : err instanceof Error && err.message.startsWith("copilot_http_")
            ? err.message
            : "unreachable";
      logTurn({
        sessionId: input.sessionId,
        provider: this.name,
        status: "fallback",
        latencyMs: Date.now() - started,
        errorCategory: category,
      });
      return {
        responseText: COPILOT_FALLBACK_TEXT,
        requirements: requirementsToMap(session.requirements),
        missing: missingFields(session.requirements),
        complete: false,
        readyForProduction: false,
        productionBrief: null,
        provider: this.name,
        degraded: true,
      };
    }
    clearTimeout(timer);

    const result = this.normalize(raw);
    this.syncSession(input.sessionId, input.userMessage, result);
    logTurn({
      sessionId: input.sessionId,
      provider: this.name,
      status: "ok",
      latencyMs: Date.now() - started,
    });
    return result;
  }

  /** Tolerant normalization of the Copilot workflow response. */
  private normalize(raw: Record<string, unknown>): CopilotTurnResult {
    const requirements =
      raw.requirements && typeof raw.requirements === "object"
        ? Object.fromEntries(
            Object.entries(raw.requirements as Record<string, unknown>)
              .filter(([, v]) => typeof v === "string" && v)
              .map(([k, v]) => [k, v as string]),
          )
        : {};
    return {
      responseText:
        typeof raw.responseText === "string" && raw.responseText.trim()
          ? raw.responseText.trim()
          : COPILOT_FALLBACK_TEXT,
      requirements,
      missing: Array.isArray(raw.missing) ? raw.missing.map(String) : [],
      complete: raw.complete === true,
      readyForProduction: raw.readyForProduction === true,
      productionBrief:
        raw.productionBrief && typeof raw.productionBrief === "object"
          ? (raw.productionBrief as Record<string, unknown>)
          : null,
      provider: this.name,
    };
  }

  /**
   * Mirror Copilot's authoritative requirement state back into the
   * conversation session so the existing brief/production pipeline
   * (brief build, confirm, production) works unchanged.
   */
  private syncSession(sessionId: string, userMessage: string, result: CopilotTurnResult): void {
    const session = this.conversation.getSession(sessionId);
    if (!session) return;

    session.messages.push({
      id: crypto.randomUUID(),
      speaker: "client",
      text: userMessage,
      at: new Date().toISOString(),
    });
    session.messages.push({
      id: crypto.randomUUID(),
      speaker: "agent",
      text: result.responseText,
      at: new Date().toISOString(),
    });

    for (const [field, value] of Object.entries(result.requirements)) {
      if (!KNOWN_FIELDS.includes(field as RequirementField)) continue;
      const req = session.requirements.find((r) => r.field === field);
      if (!req) continue;
      req.value = value;
      req.status = "confirmed";
      req.confidence = 0.9;
      req.source = "copilot studio";
    }
    if (result.complete && session.phase === "gathering") session.phase = "review";
  }
}

/**
 * Structured production payload for the future n8n / Composio → Gemini/Veo
 * workflow. JSON, not a giant unstructured prompt.
 */
export function buildProductionPayload(
  sessionId: string,
  conversation: ConversationService,
): Record<string, unknown> | null {
  const session = conversation.getSession(sessionId);
  if (!session) return null;
  const get = (f: string) => session.requirements.find((r) => r.field === f)?.value ?? null;
  return {
    sessionId,
    brief: {
      client: get("client"),
      product: get("product"),
      campaign: get("campaign"),
      platform: get("platform"),
      contentType: get("contentType"),
      visualStyle: get("visualStyle"),
      audience: get("audience"),
      duration: get("duration"),
      aspectRatio: get("aspectRatio"),
    },
  };
}

export function createCopilotProvider(
  conversation: ConversationService & Partial<MockConversationService>,
): CopilotProvider {
  const mode = (process.env.COPILOT_PROVIDER ?? "mock").toLowerCase();
  const url = process.env.COPILOT_WORKFLOW_URL;
  if (mode === "live") {
    if (!url) {
      console.warn(
        "COPILOT_PROVIDER=live but COPILOT_WORKFLOW_URL is not set — falling back to mock provider.",
      );
      return new MockCopilotProvider(conversation);
    }
    return new LiveCopilotProvider(url, process.env.COPILOT_AUTH_TOKEN, conversation);
  }
  return new MockCopilotProvider(conversation);
}

export function copilotProviderName(): "mock" | "live" {
  return (process.env.COPILOT_PROVIDER ?? "mock").toLowerCase() === "live" &&
    process.env.COPILOT_WORKFLOW_URL
    ? "live"
    : "mock";
}
