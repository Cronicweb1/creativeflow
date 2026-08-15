/**
 * Voice layer abstraction.
 *
 * The demo uses SimulatedVoiceInput: it requests real microphone permission
 * (so the UX matches production) but takes client utterances from the UI.
 *
 * A future BrowserVoiceInput implements the same interface with real
 * capture + streaming to a voice agent (Retell / Vapi / LiveKit), calling
 * `onTranscript(text)` whenever the client finishes speaking. demo.js only
 * talks to this interface.
 */

export class SimulatedVoiceInput {
  constructor() {
    this.stream = null;
    this.onTranscript = null; // set by the call controller
    this.muted = false;
  }

  /** Request mic permission. Resolves { granted, reason }. */
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

  /** The simulated call feeds canned/typed answers through the same path a transcriber would use. */
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
