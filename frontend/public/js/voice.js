/**
 * Voice layer — browser-controlled voice pipeline. No conversational-agent
 * sessions, no credits burned by the voice loop itself.
 *
 *   microphone → Web Speech API SpeechRecognition (STT, free)
 *             → POST /api/copilot/turn  (backend → Activepieces /sync → Groq)
 *             → responseText
 *             → POST /api/tts (natural server-side TTS, key stays on server)
 *                 ↳ fallback: window.speechSynthesis (best available voice)
 *             → back to listening
 *
 * STT lifecycle (single-shot, no unbounded restarts):
 *   idle → listening → (interim…) → FINAL transcript → stop → submit ONCE
 * Silence/no-speech restarts are bounded (MAX_SILENT_RESTARTS), after which
 * the layer goes idle and reports "silence" so the UI can invite a retry.
 *
 * Surface used by demo.js:
 *   BrowserVoiceInput.isSupported()
 *   requestPermission()
 *   startListening() / stopListening()
 *   onTranscript(text)            — exactly one FINAL transcript per turn
 *   onInterim(text)               — live interim transcript ("" to clear)
 *   onListeningStateChange(bool)
 *   onSpeakingStateChange(bool)
 *   onError(reason)               — "unsupported"|"denied"|"audio"|"network"|"silence"|message
 *   speak(text) → Promise<bool>   — natural TTS w/ browser fallback
 *   stopSpeaking() / isSpeaking()
 *   setMuted(bool) / submitUtterance(text) / stop()
 */

const DEBUG =
  /[?&]debug\b/.test(window.location.search) ||
  (() => {
    try {
      return window.localStorage.getItem("cf_debug") === "1";
    } catch {
      return false;
    }
  })();

function dlog(...args) {
  if (DEBUG) console.info("[CreativeFlow STT]", ...args);
}

function recognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

/** Full BCP-47 locale — Chrome recognizes far better with "en-US" than "en". */
function speechLang() {
  const lang = navigator.language || "en-US";
  return lang.includes("-") ? lang : { en: "en-US", hi: "hi-IN" }[lang] || `${lang}-US`;
}

/** Strip Markdown/code fences so TTS never reads formatting aloud. */
export function toSpeakableText(text) {
  return String(text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

const MAX_SILENT_RESTARTS = 2; // bounded — never restart indefinitely

export class BrowserVoiceInput {
  /** True when this browser can do free, native speech recognition. */
  static isSupported() {
    return Boolean(recognitionCtor()) && typeof window.speechSynthesis !== "undefined";
  }

  constructor() {
    this.recognition = null;
    this.listening = false;
    this.muted = false;
    this.onTranscript = null;
    this.onInterim = null;
    this.onListeningStateChange = null;
    this.onSpeakingStateChange = null;
    this.onError = null;
    this._silentRestarts = 0;
    this._submittedThisSession = false; // duplicate-submission guard
    this._speaking = false;
    this._utterance = null;
    this._audio = null; // server TTS playback element
    this._serverTts = null; // null = unknown, true/false once probed
    this._voicesReady = false;
    // Some browsers populate speechSynthesis voices asynchronously.
    try {
      window.speechSynthesis?.addEventListener?.("voiceschanged", () => {
        this._voicesReady = true;
      });
    } catch {
      /* optional */
    }
  }

  /** Request mic permission explicitly when the user starts the call. */
  async requestPermission() {
    if (!navigator.mediaDevices?.getUserMedia) {
      return { granted: false, reason: "unsupported" };
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // SpeechRecognition manages its own capture — release the probe stream.
      stream.getTracks().forEach((t) => t.stop());
      dlog("microphone permission granted");
      return { granted: true };
    } catch (err) {
      dlog("microphone permission failed:", err?.name);
      return { granted: false, reason: err?.name || "denied" };
    }
  }

  /* ------------------------ speech-to-text ------------------------ */

  startListening() {
    const Ctor = recognitionCtor();
    if (!Ctor) {
      this.onError?.("unsupported");
      return;
    }
    if (this.muted || this.listening) return;
    if (this.isSpeaking()) {
      // Never listen while the AI is speaking — but do NOT silently drop the
      // turn: retry briefly until playback state clears (bounded).
      this._listenRetries = (this._listenRetries ?? 0) + 1;
      if (this._listenRetries <= 20) {
        setTimeout(() => {
          if (!this.muted && !this.listening) this.startListening();
        }, 250);
      } else {
        this._listenRetries = 0;
        this.onError?.("silence");
      }
      return;
    }
    this._listenRetries = 0;

    const rec = new Ctor();
    this.recognition = rec;
    rec.lang = speechLang();
    rec.continuous = false; // one utterance per turn
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    this._submittedThisSession = false;

    let finalText = "";

    // Watchdog: if Chrome never fires onstart (rare silent failure), abort so
    // onend runs and the bounded-restart/error path takes over — the UI must
    // never claim "Listening…" while nothing is actually listening.
    const startWatchdog = setTimeout(() => {
      if (!this.listening && this.recognition === rec) {
        dlog("recognition never started — aborting");
        try {
          rec.abort();
        } catch {
          /* already gone */
        }
      }
    }, 3000);

    rec.onstart = () => {
      clearTimeout(startWatchdog);
      this.listening = true;
      dlog("recognition started, lang =", rec.lang);
      this.onListeningStateChange?.(true);
    };

    rec.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) finalText += res[0].transcript;
        else interim += res[0].transcript;
      }
      // Interim transcripts are DISPLAY ONLY — they are never submitted.
      if (interim) this.onInterim?.(interim.trim());
    };

    rec.onerror = (event) => {
      dlog("recognition error:", event.error);
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        this._silentRestarts = MAX_SILENT_RESTARTS; // don't retry
        this.onError?.("denied");
      } else if (event.error === "audio-capture") {
        this._silentRestarts = MAX_SILENT_RESTARTS;
        this.onError?.("audio");
      } else if (event.error === "network") {
        this._silentRestarts = MAX_SILENT_RESTARTS;
        this.onError?.("network");
      }
      // "no-speech" / "aborted" are routine — handled by onend.
    };

    rec.onend = () => {
      clearTimeout(startWatchdog);
      this.listening = false;
      this.recognition = null;
      this.onListeningStateChange?.(false);
      this.onInterim?.("");

      const text = finalText.trim();
      if (text && !this._submittedThisSession) {
        // Exactly ONE final transcript is submitted per recognition session.
        this._submittedThisSession = true;
        this._silentRestarts = 0;
        dlog("final transcript:", text);
        this.onTranscript?.(text);
        return;
      }

      // Ended with no final transcript → NEVER submit an empty request.
      if (!this.muted && this._silentRestarts < MAX_SILENT_RESTARTS) {
        this._silentRestarts += 1;
        dlog(`silence — bounded restart ${this._silentRestarts}/${MAX_SILENT_RESTARTS}`);
        setTimeout(() => {
          if (!this.muted && !this.listening && !this.isSpeaking()) this.startListening();
        }, 300);
      } else if (!this.muted) {
        this._silentRestarts = 0;
        dlog("silence limit reached — going idle");
        this.onError?.("silence"); // UI invites the user to tap the mic / retry
      }
    };

    try {
      rec.start();
    } catch {
      /* start() throws if a session is already active — harmless */
    }
  }

  stopListening() {
    this._silentRestarts = MAX_SILENT_RESTARTS; // block pending restarts
    const rec = this.recognition;
    try {
      rec?.stop();
    } catch {
      /* not started */
    }
    this._silentRestarts = 0;
  }

  /* ------------------------ text-to-speech ------------------------ */

  /**
   * Speak ONLY plain response text (never JSON/requirements/debug).
   * Primary: POST /api/tts — natural server-side voice; the provider API key
   * never leaves the backend. Fallback: window.speechSynthesis with the best
   * available voice. Resolves true when playback finished, false otherwise.
   */
  async speak(text) {
    const clean = toSpeakableText(text);
    if (!clean) return false;
    this.stopSpeaking(); // cancel stale utterances/audio before starting

    if (this._serverTts !== false) {
      const played = await this._speakViaServer(clean);
      if (played !== null) return played; // played (true/false), provider available
    }
    return this._speakViaBrowser(clean);
  }

  /** Returns true/false when server TTS handled it, null when unavailable. */
  async _speakViaServer(text) {
    let res;
    try {
      res = await fetch("/api/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
    } catch {
      return null; // network problem — use browser fallback for this turn
    }
    if (res.status === 503) {
      this._serverTts = false; // not configured — stop probing this session
      dlog("server TTS not configured — using browser speechSynthesis");
      return null;
    }
    if (!res.ok) return null;

    let url;
    try {
      const blob = await res.blob();
      if (!blob.size) return null;
      url = URL.createObjectURL(blob);
    } catch {
      return null;
    }

    this._serverTts = true;
    return await new Promise((resolve) => {
      const audio = new Audio(url);
      this._audio = audio;
      const done = (ok) => {
        if (this._audio === audio) {
          this._audio = null;
          this._setSpeaking(false);
        }
        URL.revokeObjectURL(url);
        resolve(ok);
      };
      audio.onended = () => done(true);
      audio.onerror = () => done(false);
      this._setSpeaking(true);
      audio.play().catch(() => done(false));
    });
  }

  /** Pick the most natural English voice this browser exposes. */
  _pickVoice() {
    const voices = window.speechSynthesis?.getVoices?.() ?? [];
    if (!voices.length) return null;
    const lang = speechLang();
    const score = (v) => {
      let s = 0;
      const name = (v.name || "").toLowerCase();
      if (v.lang === lang) s += 4;
      else if (v.lang?.startsWith(lang.split("-")[0])) s += 2;
      // Neural/enhanced voices, by capability keywords — never a hard-coded name.
      if (/natural|neural|enhanced|premium|online/.test(name)) s += 4;
      if (name.includes("google")) s += 3;
      if (v.localService === false) s += 1; // cloud voices usually sound better
      if (v.default) s += 1;
      return s;
    };
    return voices.slice().sort((a, b) => score(b) - score(a))[0] ?? null;
  }

  _speakViaBrowser(text) {
    return new Promise((resolve) => {
      const synth = window.speechSynthesis;
      if (!synth) {
        resolve(false);
        return;
      }
      try {
        synth.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = speechLang();
        const voice = this._pickVoice();
        if (voice) u.voice = voice;
        u.rate = 1.0; // 0.95–1.05 sounds most conversational
        u.pitch = 1.0;
        let settled = false;
        let watchdog = null;
        const done = (ok) => {
          if (settled) return;
          settled = true;
          clearTimeout(watchdog);
          if (this._utterance === u) {
            this._utterance = null;
            this._setSpeaking(false);
          }
          resolve(ok);
        };
        u.onend = () => done(true);
        u.onerror = () => done(false);
        // Chrome bug: onend/onerror sometimes never fire (esp. right after
        // cancel()) — a watchdog guarantees speak() ALWAYS resolves so the
        // conversation loop can never hang on "Speaking…".
        const maxMs = Math.min(45000, 4000 + text.length * 90);
        watchdog = setTimeout(() => {
          dlog("speechSynthesis watchdog fired — forcing turn to continue");
          try {
            synth.cancel();
          } catch {
            /* unavailable */
          }
          done(false);
        }, maxMs);
        this._utterance = u;
        this._setSpeaking(true);
        // Chrome bug: speak() immediately after cancel() can silently drop
        // the utterance — queue on a short delay and resume() a paused engine.
        setTimeout(() => {
          if (settled) return;
          try {
            synth.speak(u);
            synth.resume();
          } catch {
            done(false);
          }
        }, 60);
      } catch {
        this._setSpeaking(false);
        resolve(false);
      }
    });
  }

  _setSpeaking(speaking) {
    if (this._speaking === speaking) return;
    this._speaking = speaking;
    this.onSpeakingStateChange?.(speaking);
  }

  stopSpeaking() {
    const audio = this._audio;
    this._audio = null;
    if (audio) {
      try {
        audio.pause();
        audio.src = "";
      } catch {
        /* already stopped */
      }
    }
    this._utterance = null;
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* unavailable */
    }
    this._setSpeaking(false);
  }

  isSpeaking() {
    // ONLY our internally tracked state. Chrome's speechSynthesis.speaking
    // flag can remain stuck true after an utterance ends, which would
    // permanently block startListening() (mic appears dead).
    return this._speaking;
  }

  /* ------------------------ shared controls ------------------------ */

  /** Mute = stop recognizing immediately. Unmuting does not auto-listen. */
  setMuted(muted) {
    this.muted = muted;
    if (muted) this.stopListening();
  }

  /** Typed fallback — routed exactly like a spoken final transcript. */
  submitUtterance(text) {
    if (this.onTranscript) this.onTranscript(text);
  }

  /** Full teardown: recognition + all audio output. */
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
