import { randomUUID } from "node:crypto";
import type {
  AgentTurn,
  Conversation,
  ConversationMessage,
} from "../types/conversation.ts";
import type { CreativeRequirement } from "../types/creative.ts";
import {
  CONVERSATION_SCRIPT,
  INITIAL_REQUIREMENTS,
  WRAP_UP_MESSAGE,
} from "../mock/conversation.ts";

/**
 * Conversation engine contract.
 *
 * The mock implementation below walks a scripted call. A future
 * `VoiceAgentService` implements the same interface backed by a real
 * voice/LLM stack (Retell, Vapi, LiveKit, …) — routes and frontend
 * never change.
 */
export interface ConversationService {
  startSession(): Conversation;
  getSession(sessionId: string): Conversation | null;
  /** Feed one client utterance (typed or transcribed) and get the agent's turn. */
  handleClientMessage(sessionId: string, text: string): AgentTurn;
  /** Reopen a session for edits ("Make changes"). */
  reopen(sessionId: string): Conversation;
}

interface SessionState {
  conversation: Conversation;
  stepIndex: number;
}

function makeMessage(speaker: "agent" | "client", text: string): ConversationMessage {
  return { id: randomUUID(), speaker, text, at: new Date().toISOString() };
}

function freshRequirements(): CreativeRequirement[] {
  return INITIAL_REQUIREMENTS.map(({ field, label }) => ({
    field,
    label,
    value: null,
    status: "not_collected",
    confidence: 0,
    source: "client conversation",
  }));
}

export class MockConversationService implements ConversationService {
  private sessions = new Map<string, SessionState>();

  startSession(): Conversation {
    const step = CONVERSATION_SCRIPT[0];
    const conversation: Conversation = {
      sessionId: randomUUID(),
      startedAt: new Date().toISOString(),
      phase: "gathering",
      messages: [makeMessage("agent", step.prompt)],
      requirements: freshRequirements(),
    };
    this.markProbing(conversation.requirements, step.probing);
    this.sessions.set(conversation.sessionId, { conversation, stepIndex: 0 });
    return conversation;
  }

  getSession(sessionId: string): Conversation | null {
    return this.sessions.get(sessionId)?.conversation ?? null;
  }

  handleClientMessage(sessionId: string, text: string): AgentTurn {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error("session_not_found");
    const { conversation } = state;
    if (conversation.phase !== "gathering") throw new Error("conversation_closed");

    conversation.messages.push(makeMessage("client", text));

    const step = CONVERSATION_SCRIPT[state.stepIndex];
    this.applyExtraction(conversation.requirements, step, text);

    state.stepIndex += 1;
    const next = CONVERSATION_SCRIPT[state.stepIndex];

    let reply: ConversationMessage;
    let suggested: string[] = [];
    if (next) {
      this.markProbing(conversation.requirements, next.probing);
      reply = makeMessage("agent", next.prompt);
      suggested = next.suggestedResponses;
    } else {
      conversation.phase = "review";
      reply = makeMessage("agent", WRAP_UP_MESSAGE);
    }
    conversation.messages.push(reply);

    return {
      reply,
      requirements: conversation.requirements,
      phase: conversation.phase,
      suggestedResponses: suggested,
    };
  }

  reopen(sessionId: string): Conversation {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error("session_not_found");
    const { conversation } = state;
    conversation.phase = "gathering";
    // Step back so the agent re-asks the final question and the client can revise.
    state.stepIndex = Math.max(0, CONVERSATION_SCRIPT.length - 1);
    const step = CONVERSATION_SCRIPT[state.stepIndex];
    const reply = makeMessage(
      "agent",
      "Of course — what would you like to change? " + step.prompt,
    );
    conversation.messages.push(reply);
    return conversation;
  }

  /** First suggested responses for a fresh session (simulated-call UI only). */
  initialSuggestions(): string[] {
    return CONVERSATION_SCRIPT[0].suggestedResponses;
  }

  private markProbing(requirements: CreativeRequirement[], fields: string[]): void {
    for (const req of requirements) {
      if (fields.includes(req.field) && req.status === "not_collected") {
        req.status = "being_determined";
      }
    }
  }

  private applyExtraction(
    requirements: CreativeRequirement[],
    step: (typeof CONVERSATION_SCRIPT)[number],
    answer: string,
  ): void {
    const lower = answer.toLowerCase();
    for (const rule of step.extract) {
      const req = requirements.find((r) => r.field === rule.field);
      if (!req) continue;
      const matched = rule.keywords.some((k) => lower.includes(k));
      if (matched || rule.keywords.length === 0) {
        req.value = rule.value;
        req.status = rule.status;
        req.confidence = rule.confidence;
      } else if (rule.fallbackToAnswer) {
        req.value = answer.replace(/\.$/, "");
        req.status = rule.status;
        req.confidence = Math.max(0.6, rule.confidence - 0.25);
      }
    }
  }
}

export const conversationService: ConversationService & MockConversationService =
  new MockConversationService();
