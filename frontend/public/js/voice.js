/**
 * Voice layer — browser-native voice pipeline. No ElevenLabs, no credits.
 *
 * The browser owns the entire conversation loop:
 *
 *   microphone → Web Speech API SpeechRecognition (STT)
 *             → POST /api/copilot/turn  (backend → Activepieces /sync → Groq)
 *             → responseText
 *             → window.speechSynthesis (TTS)
 *             → back to listening
 *
 * No conversational-agent session is ever opened with any paid provider.
 * The only network calls made by the voice flow are to the CreativeFlow
 * backend itself (same-origin /api/*).
 *
 * Surface used by demo.js:
 *
 *   BrowserVoiceInput.isSupported()   — feature-detect SpeechRecognition
 *   requestPermission()               — mic permission pre-flight
 *   startListening() / stopListening()
 *   onTranscript(text)                — FINAL visitor utterance
 *   onInterim(text)                   — live interim transcript (may be "")
 *   onListeningStateChange(bool)      — recognition started/stopped
 *   onError(reason)                   — "unsupported" | "denied" | "audio" | "network" | message
 *   speak(text) → Promise<bool>       — browser TTS; resolves when playback ends
 *   stopSpeaking() / isSpeaking()     — interrupt / query TTS
 *   setMuted(bool)                    — mute = stop recognition
 *   submitUtterance(text)             — typed fallback, routed like a transcript
 *   stop()                            — full teardown (recognition + TTS + mic)
 *
 * STT and TTS are small abstractions here so either can be swapped for a
 * different engine later without touching demo.js.
 */

function recognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export class BrowserVoiceInput {
  /** True when this browser can do free, native speech recognition. */
  static isSupported() {
    return Boolean(recognitionCtor()) && typeof window.speechSynthesis !== "undefined";
  }

  constructor() {
    this.stream = null; // permission pre-flight stream (released immediately)
    this.recognition = null;
    this.listening = false;
    this.muted = false;
    this.onTranscript = null;
    this.onInterim = null;
    this.onListeningStateChange = null;
    this.onError = null;
    this._shouldListen = false; // desired state — drives silent auto-restart
    this._speaking = false;
    this._utterance = null;
    this._restartTimer = 0;
  }

  /** Request mic permission up-front so the UX fails fast. Resolves { granted, reason }. */
  async requestPermission() {
    if (!navigator.mediaDevices?.getUserMedia) {
      return { granted: false, reason: "unsupported" };
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // SpeechRecognition manages its own capture — release the probe stream.
      stream.getTracks().forEach((t) => t.stop());
      return { granted: true };
    } catch (err) {
      return { granted: false, reason: err?.name || "denied" };
    }
  }

  /* ---------- speech-to-text ---------- */

  startListening() {
    const Ctor = recognitionCtor();
    if (!Ctor) {
      this.onError?.("unsupported");
      return;
    }
    if (this.muted || this.listening) return;
    this._shouldListen = true;

    const rec = new Ctor();
    this.recognition = rec;
    rec.lang = document.documentElement.lang || navigator.language || "en-US";
    rec.continuous = false; // one utterance per turn
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    let finalText = "";

    rec.onstart = () => {
      this.listening = true;
      this.onListeningStateChange?.(true);
    };

    rec.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) finalText += res[0].transcript;
        else interim += res[0].transcript;
      }
      if (interim) this.onInterim?.(interim.trim());
    };

    rec.onerror = (event) => {
      // "no-speech"/"aborted" are routine — the onend auto-restart handles them.
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        this._shouldListen = false;
        this.onError?.("denied");
      } else if (event.error === "audio-capture") {
        this._shouldListen = false;
        this.onError?.("audio");
      } else if (event.error === "network") {
        this.onError?.("network");
      }
    };

    rec.onend = () => {
      this.listening = false;
      this.recognition = null;
      this.onListeningStateChange?.(false);
      this.onInterim?.("");
      const text = finalText.trim();
      if (text) {
        this._shouldListen = false; // demo restarts listening after the reply is spoken
        this.onTranscript?.(text);
      } else if (this._shouldListen && !this.muted) {
        // Silence / recognizer timeout — quietly keep listening.
        clearTimeout(this._restartTimer);
        this._restartTimer = setTimeout(() => {
          if (this._shouldListen && !this.muted && !this.listening) this.startListening();
        }, 250);
      }
    };

    try {
      rec.start();
    } catch {
      // start() throws if a session is already active — treat as harmless.
    }
  }

  stopListening() {
    this._shouldListen = false;
    clearTimeout(this._restartTimer);
    try {
      this.recognition?.stop();
    } catch {
      /* not started */
    }
  }

  /* ---------- text-to-speech ---------- */

  /**
   * Speak ONLY the given text (never JSON or internal state) with the
   * browser's built-in speechSynthesis. Resolves true when playback
   * finished, false when TTS is unavailable/failed or was interrupted —
   * the caller still shows the text either way.
   */
  speak(text) {
    return new Promise((resolve) => {
      const synth = window.speechSynthesis;
      if (!synth || !text || !String(text).trim()) {
        resolve(false);
        return;
      }
      try {
        synth.cancel(); // never overlap two responses
        const u = new SpeechSynthesisUtterance(String(text));
        u.lang = document.documentElement.lang || navigator.language || "en-US";
        u.rate = 1;
        u.pitch = 1;
        const done = (ok) => {
          if (this._utterance === u) {
            this._speaking = false;
            this._utterance = null;
          }
          resolve(ok);
        };
        u.onend = () => done(true);
        u.onerror = () => done(false);
        this._utterance = u;
        this._speaking = true;
        synth.speak(u);
      } catch {
        this._speaking = false;
        resolve(false);
      }
    });
  }

  stopSpeaking() {
    this._speaking = false;
    this._utterance = null;
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* unavailable */
    }
  }

  isSpeaking() {
    return this._speaking || Boolean(window.speechSynthesis?.speaking);
  }

  /* ---------- shared controls ---------- */

  /** Mute = stop recognizing. Unmuting does not auto-listen; demo decides. */
  setMuted(muted) {
    this.muted = muted;
    if (muted) this.stopListening();
  }

  /** Typed fallback — routed exactly like a spoken final transcript. */
  submitUtterance(text) {
    if (this.onTranscript) this.onTranscript(text);
  }

  /** Full teardown: recognition, TTS and any lingering mic tracks. */
  stop() {
    this.stopListening();
    this.stopSpeaking();
    try {
      this.recognition?.abort();
    } catch {
      /* already stopped */
    }
    this.recognition = null;
    this.listening = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

/**
 * Typed simulation — no audio at all. Used when VOICE_PROVIDER=simulation
 * or the browser lacks the Web Speech API: the visitor types, the Copilot
 * bridge (/api/copilot/turn) answers with text.
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
