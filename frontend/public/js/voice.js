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
  if (DEBUG) console.info("[voice]", ...args);
}

function recognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

/**
 * STT language — FIXED to "en-US".
 * ROOT-CAUSE FIX: this used to derive from navigator.language, so on any
 * browser whose OS/UI locale isn't US English (e.g. hi-IN) Chrome ran
 * recognition in that locale and spoken ENGLISH produced no transcript
 * while the UI still showed "Listening…". The demo speaks English.
 * Power users can override via localStorage.cf_stt_lang = "xx-XX".
 */
function speechLang() {
  try {
    const override = window.localStorage?.getItem?.("cf_stt_lang");
    if (override) return override;
  } catch {
    /* storage unavailable (private mode) */
  }
  return "en-US";
}

/** Coarse browser detection — SpeechRecognition support is browser-specific. */
export function browserName() {
  const ua = (navigator.userAgent || "").toLowerCase();
  if (ua.includes("firefox")) return "firefox";
  if (ua.includes("edg/")) return "edge";
  if (ua.includes("chrome") || ua.includes("crios")) return "chrome";
  if (ua.includes("safari")) return "safari";
  return "other";
}

/** Dev diagnostic surface: window.__creativeFlowVoiceDebug — NO secrets. */
function dbg(patch) {
  try {
    const d = (window.__creativeFlowVoiceDebug = window.__creativeFlowVoiceDebug || {
      supported: null,
      listening: false,
      speaking: false,
      processing: false,
      lastError: null,
      lastInterimTranscript: "",
      lastFinalTranscript: "",
    });
    Object.assign(d, patch);
  } catch {
    /* diagnostics must never break the app */
  }
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
    // NEVER claim voice support merely because navigator.mediaDevices exists:
    // SpeechRecognition is browser-specific (Chrome/Edge/Safari — NOT Firefox)
    // and microphone access requires a secure (HTTPS) context.
    const supported =
      window.isSecureContext !== false &&
      Boolean(recognitionCtor()) &&
      typeof window.speechSynthesis !== "undefined";
    dbg({ supported });
    if (!supported) {
      dlog("voice input unsupported (browser:", browserName(), "secureContext:", String(window.isSecureContext) + ")");
    }
    return supported;
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
    dlog("requesting microphone…");
    // Permissions API (where supported) tells us the state up-front — handle
    // granted/prompt/denied without assuming the API exists in every browser.
    try {
      const st = await navigator.permissions?.query?.({ name: "microphone" });
      if (st?.state) {
        dlog("microphone permission state:", st.state);
        if (st.state === "denied") return { granted: false, reason: "denied" };
      }
    } catch {
      /* permissions API absent (Safari/older) — fall through to getUserMedia */
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
    // RACE FIX: guard on the recognition INSTANCE, not just this.listening.
    // this.listening only turns true at onstart — a second call in the
    // start→onstart window used to spawn a second recognizer whose orphaned
    // onend desynced the state machine (mic looked live, transcripts lost).
    if (this.muted || this.listening || this.recognition) return;
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
      dlog("recognition started, lang =", rec.lang, "browser =", browserName());
      dbg({ listening: true, lastError: null });
      // UI shows "Listening…" ONLY from this event — never from a click.
      this.onListeningStateChange?.(true);
    };

    // Diagnostic lifecycle events — make "mic looks on but hears nothing"
    // debuggable: audiostart proves capture, speechstart proves detection.
    rec.onaudiostart = () => dlog("audio capture started (microphone is live)");
    rec.onspeechstart = () => dlog("speech detected");
    rec.onspeechend = () => dlog("speech ended");
    rec.onaudioend = () => dlog("audio capture ended");

    rec.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) finalText += res[0].transcript;
        else interim += res[0].transcript;
      }
      // Interim transcripts are DISPLAY ONLY — they are never submitted.
      if (interim) {
        dlog("interim transcript:", interim.trim());
        dbg({ lastInterimTranscript: interim.trim() });
        this.onInterim?.(interim.trim());
      }
    };

    rec.onerror = (event) => {
      dlog("recognition error:", event.error, event.message ?? "");
      dbg({ lastError: event.error });
      // Explicit mapping — never silently swallow recognition errors.
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        this._silentRestarts = MAX_SILENT_RESTARTS; // don't retry
        this.onError?.("denied"); // "Microphone permission was denied."
      } else if (event.error === "audio-capture") {
        this._silentRestarts = MAX_SILENT_RESTARTS;
        this.onError?.("audio"); // "No microphone input was detected."
      } else if (event.error === "network") {
        this._silentRestarts = MAX_SILENT_RESTARTS;
        this.onError?.("network"); // "Speech recognition service is unavailable."
      } else if (event.error === "language-not-supported") {
        this._silentRestarts = MAX_SILENT_RESTARTS;
        this.onError?.("language"); // recognition language unavailable on device
      }
      // "no-speech" → bounded-restart path in onend ("I didn't hear anything").
      // "aborted" → routine (stop/teardown) — handled by onend.
    };

    rec.onend = () => {
      clearTimeout(startWatchdog);
      this.listening = false;
      if (this.recognition === rec) this.recognition = null;
      dbg({ listening: false });
      this.onListeningStateChange?.(false);
      this.onInterim?.("");

      const text = finalText.trim();
      if (text && !this._submittedThisSession) {
        // Exactly ONE final transcript is submitted per recognition session.
        this._submittedThisSession = true;
        this._silentRestarts = 0;
        dlog("final transcript:", text);
        dbg({ lastFinalTranscript: text, lastInterimTranscript: "" });
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
    } catch (err) {
      // Never swallow this silently: an InvalidStateError here means a
      // session was already active (prevented above); anything else means
      // recognition could not start at all — surface it.
      clearTimeout(startWatchdog);
      dlog("recognition.start() threw:", err?.name, err?.message);
      if (this.recognition === rec) this.recognition = null;
      if (err?.name !== "InvalidStateError") {
        dbg({ lastError: err?.name || "start-failed" });
        this.onError?.(err?.name === "NotAllowedError" ? "denied" : "start-failed");
      }
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
    dbg({ speaking });
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

/* ================= MediaRecorder → server-side STT engine ================= */

/**
 * Chrome's Web Speech API SpeechRecognition depends on an external Google
 * speech service that failed in production ("recognition error: network")
 * even with a live microphone. The PRIMARY voice-input path is therefore:
 *
 *   microphone → MediaRecorder → POST /api/voice/transcribe (multipart)
 *   → server-side Groq Whisper → { text } → onTranscript → copilot turn
 *
 * The Groq API key never reaches this file — transcription happens entirely
 * on the CreativeFlow backend. TTS stays browser speechSynthesis.
 */

const RECORDER_MIMES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/ogg",
];

/** Feature-detect the best supported recorder MIME ("" = browser default). */
export function pickRecorderMime() {
  const MR = window.MediaRecorder;
  if (!MR || typeof MR.isTypeSupported !== "function") return "";
  for (const mime of RECORDER_MIMES) {
    try {
      if (MR.isTypeSupported(mime)) return mime;
    } catch {
      /* keep looking */
    }
  }
  return "";
}

const MAX_RECORD_MS = 60_000; // hard cap — never record longer than a minute
const MIN_BLOB_BYTES = 800; // below this the clip cannot contain speech
const SILENCE_STOP_MS = 3_200; // auto-finish after this much trailing silence
const NO_SPEECH_GIVEUP_MS = 12_000; // nothing said at all → give up quietly
const SILENCE_RMS = 0.015; // RMS threshold separating speech from room noise

export class RecordedVoiceInput extends BrowserVoiceInput {
  /** MediaRecorder + mic + TTS in a secure context — no SpeechRecognition needed. */
  static isSupported() {
    const supported =
      window.isSecureContext !== false &&
      typeof window.MediaRecorder !== "undefined" &&
      Boolean(navigator.mediaDevices?.getUserMedia) &&
      typeof window.speechSynthesis !== "undefined";
    dbg({ supported });
    return supported;
  }

  constructor() {
    super();
    this.onTranscribing = null; // (bool) — "Transcribing…" UI state
    this._recorder = null;
    this._recStream = null;
    this._chunks = [];
    this._cancelled = false;
    this._starting = false;
    this._transcribing = false; // duplicate-upload guard
    this._maxTimer = 0;
    this._silenceCtx = null;
    this._silenceRaf = 0;
  }

  /* ------------------------ recording ------------------------ */

  async startListening() {
    if (this.muted || this.listening || this._starting || this._transcribing) return;
    if (!RecordedVoiceInput.isSupported()) {
      this.onError?.("unsupported");
      return;
    }
    this._starting = true;
    dlog("requesting microphone");
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      this._starting = false;
      const name = err?.name || "";
      dlog("microphone rejected:", name);
      this.onError?.(name === "NotFoundError" || name === "DevicesNotFoundError" ? "audio" : "denied");
      return;
    }
    dlog("microphone granted");

    const mime = pickRecorderMime();
    let recorder;
    try {
      recorder = mime
        ? new window.MediaRecorder(stream, { mimeType: mime })
        : new window.MediaRecorder(stream);
    } catch (err) {
      this._starting = false;
      stream.getTracks?.().forEach((t) => t.stop());
      dlog("MediaRecorder failed:", err?.name || err);
      this.onError?.("record-failed");
      return;
    }

    this._recStream = stream;
    this._recorder = recorder;
    this._chunks = [];
    this._cancelled = false;

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this._chunks.push(e.data);
    };
    recorder.onstart = () => {
      this._starting = false;
      this.listening = true;
      dlog("recording started (", recorder.mimeType || mime || "browser default", ")");
      this.onListeningStateChange?.(true);
      this._maxTimer = setTimeout(() => {
        dlog("max recording duration reached — finishing");
        this.finishListening();
      }, MAX_RECORD_MS);
      this._watchSilence(stream);
    };
    recorder.onerror = (e) => {
      dlog("recorder error:", e?.error?.name || e);
      this._cancelled = true;
      this._teardownRecording();
      this.onError?.("record-failed");
    };
    recorder.onstop = () => {
      const blob = new Blob(this._chunks, { type: recorder.mimeType || mime || "audio/webm" });
      const cancelled = this._cancelled;
      this._teardownRecording();
      if (cancelled) {
        dlog("recording cancelled — clip discarded");
        return;
      }
      dlog("recording stopped · audio blob created:", blob.size, "bytes");
      if (blob.size < MIN_BLOB_BYTES) {
        this.onError?.("silence");
        return;
      }
      void this._transcribe(blob);
    };

    try {
      recorder.start(250);
    } catch (err) {
      this._starting = false;
      this._teardownRecording();
      dlog("recorder.start failed:", err?.name || err);
      this.onError?.("record-failed");
    }
  }

  /** User tapped the mic again (or silence detected): stop and transcribe. */
  finishListening() {
    if (!this._recorder || this._recorder.state !== "recording") return;
    this._cancelled = false;
    try {
      this._recorder.stop();
    } catch {
      /* already stopped */
    }
  }

  /** Cancel: stop recording and DISCARD the clip (mute, close, typed input). */
  stopListening() {
    if (!this._recorder) return;
    this._cancelled = true;
    try {
      if (this._recorder.state === "recording") this._recorder.stop();
      else this._teardownRecording();
    } catch {
      this._teardownRecording();
    }
  }

  _teardownRecording() {
    clearTimeout(this._maxTimer);
    this._maxTimer = 0;
    this._stopSilenceWatch();
    this._recStream?.getTracks?.().forEach((t) => t.stop());
    this._recStream = null;
    this._recorder = null;
    if (this.listening) {
      this.listening = false;
      this.onListeningStateChange?.(false);
    }
  }

  /* ------------------------ silence auto-stop ------------------------ */

  /**
   * Auto-finish the clip after trailing silence so the visitor doesn't have
   * to tap twice. Uses a lightweight analyser; if AudioContext is missing
   * (old browsers, tests) tap-to-finish still works.
   */
  _watchSilence(stream) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      this._silenceCtx = ctx;
      const startedAt = Date.now();
      let lastSpeech = 0;
      const check = () => {
        if (!this._silenceCtx) return;
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        const now = Date.now();
        if (rms >= SILENCE_RMS) lastSpeech = now;
        if (lastSpeech && now - lastSpeech > SILENCE_STOP_MS) {
          dlog("trailing silence — finishing recording");
          this.finishListening();
          return;
        }
        if (!lastSpeech && now - startedAt > NO_SPEECH_GIVEUP_MS) {
          dlog("no speech detected — cancelling recording");
          this.stopListening();
          this.onError?.("silence");
          return;
        }
        this._silenceRaf = setTimeout(check, 200);
      };
      check();
    } catch {
      /* silence watch is best-effort — tap-to-finish always works */
    }
  }

  _stopSilenceWatch() {
    clearTimeout(this._silenceRaf);
    this._silenceRaf = 0;
    try {
      this._silenceCtx?.close();
    } catch {
      /* already closed */
    }
    this._silenceCtx = null;
  }

  /* ------------------------ transcription upload ------------------------ */

  async _transcribe(blob) {
    if (this._transcribing) return; // one clip → one upload
    this._transcribing = true;
    this.onTranscribing?.(true);
    dlog("uploading audio for transcription (", blob.size, "bytes )");
    const form = new FormData();
    const ext = /mp4/.test(blob.type) ? "mp4" : /ogg/.test(blob.type) ? "ogg" : "webm";
    form.append("audio", blob, `clip.${ext}`);
    let res;
    try {
      // NO manual Content-Type — the browser sets the multipart boundary.
      res = await fetch("/api/voice/transcribe", { method: "POST", body: form });
    } catch {
      this._transcribing = false;
      this.onTranscribing?.(false);
      dlog("transcription upload failed (network)");
      this.onError?.("transcribe-unavailable");
      return;
    }
    let text = "";
    if (res.ok) {
      try {
        const data = await res.json();
        text = typeof data?.text === "string" ? data.text.trim() : "";
      } catch {
        /* treated as empty below */
      }
    }
    this._transcribing = false;
    this.onTranscribing?.(false);
    if (!res.ok) {
      dlog("transcription failed: HTTP", res.status);
      this.onError?.(res.status >= 500 ? "transcribe-unavailable" : "transcribe-failed");
      return;
    }
    if (!text) {
      dlog("empty transcript — nothing submitted");
      this.onError?.("silence");
      return;
    }
    dlog("transcription received:", text);
    dbg({ lastFinalTranscript: text });
    this.onTranscript?.(text); // exactly once per clip
  }

  /* ------------------------ TTS (browser only) ------------------------ */

  /** speechSynthesis only — this engine NEVER calls /api/tts. */
  async speak(text) {
    const clean = toSpeakableText(text);
    if (!clean) return false;
    this.stopSpeaking();
    return this._speakViaBrowser(clean);
  }

  /* ------------------------ teardown ------------------------ */

  stop() {
    this.stopListening();
    this.stopSpeaking();
    this._teardownRecording();
  }
}
