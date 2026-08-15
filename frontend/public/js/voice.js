/**
 * Voice layer — real browser voice conversation via ElevenLabs Agents.
 *
 * BrowserVoiceInput streams the visitor's microphone to an ElevenLabs
 * agent over WebRTC and plays the agent's spoken replies in the browser.
 * The temporary conversation token is fetched from the CreativeFlow
 * backend (/api/elevenlabs/token) so the ElevenLabs API key never
 * reaches the client.
 *
 * The class keeps the same surface demo.js has always used
 * (requestPermission / onTranscript / setMuted / stop) and adds
 * agent-side events so the call UI can reflect the real session state:
 *
 *   onTranscript(text)        — final visitor utterance (from ElevenLabs ASR)
 *   onAgentTranscript(text)   — agent reply text (spoken audio is played by the SDK)
 *   onStatus(status)          — "connecting" | "connected" | "disconnected"
 *   onMode(mode)              — "speaking" | "listening"
 *   onError(message)          — human-readable failure reason
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
   */
  async connect() {
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

    // 4. Start the WebRTC conversation.
    try {
      this.conversation = await Conversation.startSession({
        conversationToken: token,
        connectionType: "webrtc",
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
 * Typed simulation — retained ONLY as a debug fallback (no audio, no agent).
 * Not used by the demo flow unless explicitly constructed.
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
