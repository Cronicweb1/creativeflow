import type { CreativeRequirement } from "./creative.ts";

/** Who produced a message in the call. */
export type Speaker = "agent" | "client";

export interface ConversationMessage {
  id: string;
  speaker: Speaker;
  text: string;
  at: string;
}

export type ConversationPhase =
  | "gathering" // agent is still collecting requirements
  | "review"    // all requirements captured, awaiting confirmation
  | "confirmed"; // brief confirmed, conversation closed

export interface Conversation {
  sessionId: string;
  startedAt: string;
  phase: ConversationPhase;
  messages: ConversationMessage[];
  requirements: CreativeRequirement[];
}

/** Server response after the client says something. */
export interface AgentTurn {
  /** The agent's spoken reply. */
  reply: ConversationMessage;
  /** Full requirement set after extraction ran on the client's message. */
  requirements: CreativeRequirement[];
  phase: ConversationPhase;
  /**
   * Suggested client answers for the simulated call. A real voice
   * integration ignores this field and streams microphone transcripts
   * to POST /api/demo/message instead.
   */
  suggestedResponses: string[];
}
