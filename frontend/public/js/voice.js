/**
 * Voice layer — real browser voice conversation via ElevenLabs Agents.
 *
 * ElevenLabs is the AUDIO layer only: microphone transport, speech
 * recognition, speech output and the realtime WebRTC session. The
 * conversational intelligence is Copilot Studio — the ElevenLabs agent is
 * configured with a Custom LLM pointing at this backend
 * (/api/copilot/llm/v1), which bridges every turn to Copilot. ElevenLabs
 * never independently decides what to say.
 *
 * The temporary conversation token is fetched from the CreativeFlow
 * backend (/api/elevenlabs/token) so the ElevenLabs API key never
 * reaches the client.
 *
 * Surface used by demo.js:
 *
 *   requestPermission()       — mic permission pre-flight
 *   connect({ sessionId })    — open the WebRTC session, tagged with the
 *                               CreativeFlow session so the backend bridge
 *                               can map spoken turns to session state
 *   onTranscript(text)        — final visitor utterance (from ElevenLabs ASR)
 *   onAgentTranscript(text)   — agent reply text (spoken audio is played by the SDK)
 *   onStatus(status)          — "connecting" | "connected" | "disconnected"
 *   onMode(mode)              — "speaking" | "listening"
 *   onError(message)          — human-readable failure reason
 *   setMuted(bool) / stop()   — real mute / real teardown
 *
 * SimulatedVoiceInput is kept below purely as a typed fallback/debug path.
 */

const SDK_URL = "https://cdn.jsdelivr.net/npm/@elevenlabs/client@latest/+esm";

export class BrowserVoiceInput {
  constructor() {
    this.stream = null; // pre-flight permission stream (released before WebRTC starts)
    this.conversation = null;
    this.muted = false;
    this.onTranscript = null;
    this.onAgentTranscript = null;
    this.onStatus = null;
    this.onMode = null;
    this.onError = null;
    this._lastMsg = { user: "", ai: "" }; // dedupe repeated SDK message events
  }

  /** Request mic permission up-front so the UX fails fast. Resolves { granted, reason }. */
  async requestPermission() {
    if (!navigator.mediaDevices?.getUserMedia) {
      return { granted: false, reason: "unsupported" };
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      return { granted: true };
    } catch (err) {
      return { granted: false, reason: err?.name || "denied" };
    }
  }

  /**
   * Connect to the ElevenLabs agent: fetch a temporary conversation token
   * from the backend, then open the WebRTC session. Resolves once connected;
   * throws with a human-readable message on failure.
   *
   * options.sessionId — the CreativeFlow session id. Passed to ElevenLabs as
   * a dynamic variable and custom-LLM extra body so the backend bridge can
   * route each turn to the right Copilot conversation state.
   */
  async connect(options = {}) {
    const { sessionId } = options;
    this.onStatus?.("connecting");

    // 1. Temporary conversation token from our backend (API key stays server-side).
    let token;
    try {
      const res = await fetch("/api/elevenlabs/token");
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.token) {
        throw new Error(tokenErrorMessage(data.error, res.status));
      }
      token = data.token;
    } catch (err) {
      this._fail(err instanceof Error ? err.message : "Could not reach the voice token endpoint.");
      throw err;
    }

    // 2. Load the official ElevenLabs browser SDK (ES module, no build step).
    let Conversation;
    try {
      ({ Conversation } = await import(SDK_URL));
    } catch {
      const msg = "Could not load the ElevenLabs voice SDK.";
      this._fail(msg);
      throw new Error(msg);
    }

    // 3. The SDK manages its own microphone track; release the pre-flight stream.
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;

    // 4. Start the WebRTC conversation (exactly one per CreativeFlow session).
    try {
      this.conversation = await Conversation.startSession({
        conversationToken: token,
        connectionType: "webrtc",
        ...(sessionId
          ? {
              dynamicVariables: { session_id: sessionId },
              customLlmExtraBody: { sessionId },
            }
          : {}),
        onConnect: () => this.onStatus?.("connected"),
        onDisconnect: () => this.onStatus?.("disconnected"),
        onError: (message) => this._fail(typeof message === "string" ? message : "Voice connection error"),
        onModeChange: ({ mode }) => this.onMode?.(mode), // "speaking" | "listening"
        onMessage: ({ message, source }) => {
          const text = typeof message === "string" ? message : message?.message;
          if (!text || !text.trim()) return;
          const side = source === "user" ? "user" : "ai";
          if (this._lastMsg[side] === text) return; // ignore duplicate events
          this._lastMsg[side] = text;
          if (side === "user") this.onTranscript?.(text);
          else this.onAgentTranscript?.(text);
        },
      });
      if (this.muted) this.conversation.setMicMuted(true);
    } catch (err) {
      const msg = "Could not connect to the voice agent. Please try again.";
      this._fail(msg);
      throw new Error(msg);
    }
  }

  _fail(message) {
    this.onError?.(message);
  }

  /** Optional typed fallback — kept for debugging; routed like a transcript. */
  submitUtterance(text) {
    if (this.onTranscript) this.onTranscript(text);
    // Let the agent know what the visitor "said" so the voice conversation stays coherent.
    try {
      this.conversation?.sendUserMessage?.(text);
    } catch {
      /* older SDK versions — typed fallback then only feeds the brief */
    }
  }

  /** Actually mutes the microphone stream feeding ElevenLabs. */
  setMuted(muted) {
    this.muted = muted;
    try {
      this.conversation?.setMicMuted(muted);
    } catch {
      /* not connected yet — applied on connect */
    }
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
  }

  /** Terminate the ElevenLabs conversation and release all microphone resources. */
  async stop() {
    const conv = this.conversation;
    this.conversation = null;
    this._lastMsg = { user: "", ai: "" };
    try {
      await conv?.endSession();
    } catch {
      /* already closed */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

function tokenErrorMessage(code, status) {
  switch (code) {
    case "elevenlabs_not_configured":
      return "Voice agent is not configured yet (missing ElevenLabs credentials on the server).";
    case "elevenlabs_error":
      return "The voice service rejected the token request. Please try again.";
    default:
      return `Voice token request failed (${code || `http_${status}`}).`;
  }
}

/**
 * Typed simulation — no audio, no ElevenLabs session, no credits consumed.
 * Used when VOICE_PROVIDER=simulation (or ElevenLabs is unconfigured): the
 * visitor types, the Copilot bridge (/api/copilot/turn) answers with text.
 */
export class SimulatedVoiceInput {
  constructor() {
    this.stream = null;
    this.onTranscript = null;
    this.muted = false;
  }

  async requestPermission() {
    if (!navigator.mediaDevices?.getUserMedia) {
      return { granted: false, reason: "unsupported" };
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      return { granted: true };
    } catch (err) {
      return { granted: false, reason: err?.name || "denied" };
    }
  }

  submitUtterance(text) {
    if (this.onTranscript) this.onTranscript(text);
  }

  setMuted(muted) {
    this.muted = muted;
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
