/**
 * Demo experience controller.
 *
 * A small state machine over the backend contract:
 *   precall → call → confirm → production → result
 *
 * Layered architecture:
 *   Browser Web Speech API = voice layer (free STT + TTS, no credits)
 *   Activepieces → Groq    = conversational intelligence — decides every
 *                            reply and owns the structured requirement state
 *   Render backend         = secure bridge + session/state layer
 *
 * The browser owns the conversation loop. Every turn flows:
 *
 *   mic → SpeechRecognition (STT) → POST /api/copilot/turn →
 *   Activepieces /sync → Groq → structured response →
 *   speechSynthesis (TTS) → back to listening
 *
 * Voice states surfaced to the visitor: Idle · Listening… · Thinking… ·
 * Speaking… — with typed input always available as a fallback.
 *
 * No ElevenLabs conversational-agent session is ever created. When the
 * browser lacks the Web Speech API (or VOICE_PROVIDER=simulation), the
 * demo runs as a typed text simulation over the exact same backend turn.
 */

import { api } from "./api.js";
import { BrowserVoiceInput, RecordedVoiceInput } from "./voice.js";
import { RenderedPreview } from "./preview.js";
import { getCompletedVideo, resolveResultMedia, resetVideoUi } from "./videoStatus.js";

const DEBUG =
  /[?&]debug\b/.test(window.location.search) ||
  (() => {
    try {
      return window.localStorage.getItem("cf_debug") === "1";
    } catch {
      return false;
    }
  })();

const VOICE_READY_HINT = "Browser voice · free, no credits used";

const STATE_GLYPH = {
  not_collected: { glyph: "○", cls: "", label: "Not collected" },
  being_determined: { glyph: "◌", cls: "determining", label: "Being determined" },
  confirmed: { glyph: "✓", cls: "confirmed", label: "Confirmed" },
};

export class DemoExperience {
  constructor(root, stage) {
    this.root = root;
    this.stage = stage;
    this.modeTag = document.getElementById("demo-mode-tag");
    this.voice = DemoExperience._pickVoiceEngine();
    this.health = null;
    this.session = null;
    this.brief = null;
    this.job = null;
    this.suggestions = [];
    this.timerId = 0;
    this.pollId = 0;
    this.callSeconds = 0;
    this.preview = null;
    this.micGranted = false;
    this.voiceState = "idle"; // idle | listening | transcribing | thinking | speaking
    this.wrappingUp = false;
    this._turnChain = Promise.resolve();
  }

  /**
   * PRIMARY: RecordedVoiceInput — MediaRecorder → server-side transcription.
   * Chrome's SpeechRecognition network service failed in production, so the
   * Web Speech engine is opt-in only (localStorage cf_stt_engine="webspeech").
   */
  static _pickVoiceEngine() {
    try {
      if (window.localStorage?.getItem?.("cf_stt_engine") === "webspeech") {
        return new BrowserVoiceInput();
      }
    } catch {
      /* storage unavailable */
    }
    return new RecordedVoiceInput();
  }

  get voiceMode() {
    // Voice is free and browser-native — use it whenever the browser supports
    // it, unless the server explicitly forces the typed simulation.
    return (
      this.health?.voice !== "simulation" &&
      (this.voice instanceof RecordedVoiceInput
        ? RecordedVoiceInput.isSupported()
        : BrowserVoiceInput.isSupported())
    );
  }

  open() {
    this.root.hidden = false;
    document.body.style.overflow = "hidden";
    this.renderPrecall();
  }

  close() {
    this.teardown();
    this.root.hidden = true;
    document.body.style.overflow = "";
  }

  teardown() {
    if (this._videoDoneHandler) {
      document.removeEventListener("cf:video-completed", this._videoDoneHandler);
      this._videoDoneHandler = null;
    }
    clearInterval(this.timerId);
    clearInterval(this.pollId);
    this.preview?.destroy();
    this.preview = null;
    this.voice.onTranscript = null;
    this.voice.onInterim = null;
    this.voice.onListeningStateChange = null;
    this.voice.onTranscribing = null;
    this.voice.onError = null;
    this.voice.stop(); // stops recognition + TTS + mic tracks (all local, free)
    this.voiceState = "idle";
    this.wrappingUp = false;
    this.session = null;
    this.brief = null;
    this.job = null;
    this.callSeconds = 0;
    this._turnChain = Promise.resolve();
  }

  setModeTag(text) {
    if (this.modeTag) this.modeTag.textContent = text;
  }

  /* ---------- view helpers ---------- */

  setView(html) {
    this.stage.innerHTML = `<div class="view">${html}</div>`;
    return this.stage.firstElementChild;
  }

  /* ---------- 1. pre-call ---------- */

  async renderPrecall() {
    this.teardown();
    this.setModeTag("Connecting…");
    this.setView(`<div class="precall"><p class="eyebrow">Preparing…</p></div>`);

    // Ask the server which providers are active (never assume one combination).
    try {
      this.health = await api.health();
    } catch {
      this.health = null;
    }

    if (this.voiceMode) this.renderPrecallVoice();
    else this.renderPrecallText();
  }

  renderPrecallVoice() {
    this.setModeTag("Live voice demo");
    const view = this.setView(`
      <div class="precall">
        <p class="eyebrow">Live client call</p>
        <h2>Ready to start?</h2>
        <p>You'll act as the client. Speak naturally — the AI Creative Agent talks with you and gathers the requirements for your campaign.</p>
        <p class="mic-note">Microphone access is required. Voice runs in your browser — free, no credits used.</p>
        <button class="btn btn-accent btn-lg" data-a="allow">Allow microphone &amp; start call</button>
        <p class="precall-error" hidden></p>
      </div>
    `);
    const btn = view.querySelector("[data-a=allow]");
    const errEl = view.querySelector(".precall-error");

    const fail = (message) => {
      btn.disabled = false;
      btn.textContent = "Allow microphone & start call";
      errEl.hidden = false;
      errEl.textContent = message;
    };

    btn.addEventListener("click", async () => {
      btn.disabled = true;
      errEl.hidden = true;

      // 1. Browser microphone permission — requested explicitly on start.
      btn.textContent = "Requesting microphone…";
      const perm = await this.voice.requestPermission();
      this.micGranted = perm.granted;
      if (perm.granted) btn.textContent = "Microphone ready";
      if (!perm.granted) {
        fail(
          perm.reason === "unsupported"
            ? "This browser does not support microphone access. Please use a current browser over HTTPS."
            : "Microphone access was denied. The live call needs your microphone — please allow access and try again.",
        );
        return;
      }

      // 2. CreativeFlow backend session (bridge/state layer).
      btn.textContent = "Connecting…";
      try {
        const { session, suggestedResponses } = await api.startSession();
        this.session = session;
        this.suggestions = suggestedResponses;
      } catch {
        fail("Could not reach the CreativeFlow API. Please try again.");
        return;
      }

      // 3. Render the call UI, then start the browser voice loop.
      this.renderCall();
      this.beginVoiceConversation();
    });
  }

  renderPrecallText() {
    this.setModeTag("Simulated call");
    const view = this.setView(`
      <div class="precall">
        <p class="eyebrow">Simulated client call</p>
        <h2>Ready to start?</h2>
        <p>You'll act as the client. Type your answers — the AI Creative Agent responds and gathers the requirements for your campaign.</p>
        <p class="mic-note">Text simulation mode — no microphone or voice credits are used.</p>
        <button class="btn btn-accent btn-lg" data-a="start">Start simulated call</button>
        <p class="precall-error" hidden></p>
      </div>
    `);
    const btn = view.querySelector("[data-a=start]");
    const errEl = view.querySelector(".precall-error");

    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Connecting…";
      try {
        const { session, suggestedResponses } = await api.startSession();
        this.session = session;
        this.suggestions = suggestedResponses;
      } catch {
        btn.disabled = false;
        btn.textContent = "Start simulated call";
        errEl.hidden = false;
        errEl.textContent = "Could not reach the CreativeFlow API. Please try again.";
        return;
      }
      this.renderCall();
    });
  }

  /* ---------- 2. call ---------- */

  renderCall() {
    const voiceMode = this.voiceMode;
    const view = this.setView(`
      <div class="call-layout call-active">
        <section class="call-main" aria-label="Call">
          <div class="call-agent">
            <div class="agent-avatar">
              <svg viewBox="0 0 24 24" fill="none" stroke-width="1.5" stroke-linecap="round">
                <path d="M12 3.5a3.2 3.2 0 0 1 3.2 3.2v4.6a3.2 3.2 0 1 1-6.4 0V6.7A3.2 3.2 0 0 1 12 3.5Z"/>
                <path d="M5.8 11.3a6.2 6.2 0 0 0 12.4 0M12 17.5v3"/>
              </svg>
            </div>
            <p class="agent-name">AI Creative Agent</p>
            <p class="agent-role">Creative Director</p>
            <p class="call-status"><span class="status-dot"></span><span data-el="status">${voiceMode ? "Ready" : "Call in progress"}</span></p>
            <p class="call-timer" data-el="timer">00:00</p>
          </div>
          <div class="transcript" data-el="transcript"></div>
          <div class="call-input" data-el="input">
            <div class="suggestions" data-el="suggestions"></div>
            <form class="input-row" data-el="form">
              <input type="text" placeholder="${voiceMode ? "Prefer typing? Optional fallback — just speak normally…" : "Type your answer…"}" autocomplete="off" />
              <button class="btn btn-primary" type="submit">Send</button>
            </form>
            <div class="call-controls">
              <button class="ctl" type="button" data-a="mute" aria-label="Mute microphone" title="Mute" ${voiceMode ? "" : "hidden"}>
                <svg viewBox="0 0 24 24" stroke-width="1.6" stroke-linecap="round">
                  <path d="M12 3.5a3.2 3.2 0 0 1 3.2 3.2v4.6a3.2 3.2 0 1 1-6.4 0V6.7A3.2 3.2 0 0 1 12 3.5Z"/>
                  <path d="M5.8 11.3a6.2 6.2 0 0 0 12.4 0M12 17.5v3"/>
                </svg>
              </button>
              <button class="ctl ctl-end" type="button" data-a="end" aria-label="End call" title="End call">
                <svg viewBox="0 0 24 24" stroke-width="1.7" stroke-linecap="round">
                  <path d="M4 15c4.8-4.6 11.2-4.6 16 0M7 12.2 5.6 16M17 12.2l1.4 3.8" />
                </svg>
              </button>
            </div>
            <p class="mic-hint" data-el="mic-hint">${voiceMode ? "Browser voice · free, no credits used" : "Text simulation · no voice credits used"}</p>
          </div>
        </section>
        <aside class="brief-panel" aria-label="Live creative brief">
          <p class="panel-title">Live creative brief</p>
          <div class="req-list" data-el="reqs"></div>
          <p class="brief-status"><span class="status-dot"></span><span data-el="brief-status">Gathering requirements</span></p>
        </aside>
      </div>
    `);

    this.els = {
      transcript: view.querySelector("[data-el=transcript]"),
      suggestions: view.querySelector("[data-el=suggestions]"),
      form: view.querySelector("[data-el=form]"),
      reqs: view.querySelector("[data-el=reqs]"),
      briefStatus: view.querySelector("[data-el=brief-status]"),
      timer: view.querySelector("[data-el=timer]"),
      status: view.querySelector("[data-el=status]"),
      micHint: view.querySelector("[data-el=mic-hint]"),
      layout: view.querySelector(".call-layout"),
    };

    // Call timer.
    clearInterval(this.timerId);
    this.timerId = setInterval(() => {
      this.callSeconds += 1;
      this.els.timer.textContent = fmtTime(this.callSeconds);
    }, 1000);

    // Requirements panel (fresh session or reopened one).
    this.renderRequirements(this.session.requirements);
    this.renderSuggestions(this.suggestions);

    // Both modes render the full history — the browser owns TTS, so agent
    // text is never spoken by a second system.
    for (const msg of this.session.messages) this.appendMessage(msg, false);

    if (voiceMode) this.bindVoiceEvents();

    // Input: typed answers (always available; primary in text mode).
    this.els.form.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = this.els.form.querySelector("input");
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      this.handleTurn(text);
    });

    const muteBtn = view.querySelector("[data-a=mute]");
    muteBtn?.addEventListener("click", (e) => {
      const btn = e.currentTarget;
      // Recorder engine: tapping the mic while listening finishes the clip
      // and sends it for transcription (tap → speak → tap again).
      if (this.voiceState === "listening" && typeof this.voice.finishListening === "function") {
        this.voice.finishListening();
        return;
      }
      // Idle + unmuted = tap-to-talk: resume listening after a silence timeout.
      if (!this.voice.muted && this.voiceState === "idle" && !this.wrappingUp) {
        this.setMicHint(VOICE_READY_HINT);
        this.voice.startListening();
        return;
      }
      const muted = !btn.classList.contains("ctl-muted");
      btn.classList.toggle("ctl-muted", muted);
      this.voice.setMuted(muted); // muted = recognition stopped immediately
      if (muted) {
        this.setVoiceState("idle");
        this.setMicHint("Microphone muted");
      } else {
        this.setMicHint(VOICE_READY_HINT);
        if (this.voiceState !== "thinking" && this.voiceState !== "speaking") {
          this.voice.startListening();
        }
      }
    });
    view.querySelector("[data-a=end]").addEventListener("click", () => this.close());
  }

  /* ---------- browser voice loop ---------- */

  bindVoiceEvents() {
    // FINAL visitor utterance from the browser recognizer → one backend turn.
    // Interim transcripts are NEVER submitted — only displayed.
    this.voice.onTranscript = (text) => {
      this.showInterim("");
      this.handleTurn(text);
    };
    // Live interim transcript — visible bubble so capture can be verified.
    this.voice.onInterim = (text) => {
      if (this.voiceState !== "listening") return;
      this.showInterim(text);
      this.setMicHint(text ? "Hearing you…" : VOICE_READY_HINT);
    };
    this.voice.onListeningStateChange = (listening) => {
      if (this.wrappingUp) return;
      if (listening) {
        this.setVoiceState("listening");
        if (typeof this.voice.finishListening === "function") {
          this.setMicHint("Listening… tap the mic again when you finish speaking");
        }
      } else if (this.voiceState === "listening") this.setVoiceState("idle");
      if (!listening) this.showInterim("");
    };
    // "Transcribing…" — the recorded clip is being turned into text server-side.
    this.voice.onTranscribing = (busy) => {
      if (this.wrappingUp) return;
      if (busy) this.setVoiceState("transcribing");
      else if (this.voiceState === "transcribing") this.setVoiceState("idle");
    };
    this.voice.onSpeakingStateChange = (speaking) => {
      if (this.wrappingUp) return;
      if (speaking) this.setVoiceState("speaking");
    };
    this.voice.onError = (reason) => {
      const message =
        reason === "unsupported"
          ? "Voice input isn't supported in this browser — type your answers below."
          : reason === "denied"
            ? "Microphone access was blocked — allow it in the browser, or type your answers below."
            : reason === "audio"
              ? "No microphone was found — check your input device, or type your answers below."
              : reason === "network"
                ? "Speech recognition needs a network connection — tap the mic to retry, or type below."
                : reason === "language"
                  ? "Speech recognition doesn't support English on this device — type your answers below."
                  : reason === "silence"
                    ? "Didn't catch anything — tap the mic to try again, or type your answer below."
                    : reason === "record-failed"
                      ? "Could not record microphone audio — tap the mic to retry, or type below."
                      : reason === "transcribe-unavailable"
                        ? "Voice transcription service is unavailable — try again shortly, or type below."
                        : reason === "transcribe-failed"
                          ? "Speech transcription failed — tap the mic to try again, or type below."
                          : "Speech recognition hit a snag — tap the mic to retry, or type your answers below.";
      this.setVoiceState("idle");
      this.showInterim("");
      this.setMicHint(message);
    };
  }

  /** Live "You: …" bubble in the transcript while the browser is hearing you. */
  showInterim(text) {
    if (!this.els?.transcript) return;
    let el = this.els.transcript.querySelector(".msg-interim");
    if (!text) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement("div");
      el.className = "msg msg-client msg-interim";
      el.style.opacity = "0.55";
      el.innerHTML = `<p class="msg-speaker">You</p><p class="msg-text"></p>`;
      el.style.animation = "none";
      this.els.transcript.appendChild(el);
    }
    el.querySelector(".msg-text").textContent = `“${text}…”`;
    this.els.transcript.scrollTop = this.els.transcript.scrollHeight;
  }

  /** Speak the agent's opening line, then hand the mic to the visitor. */
  beginVoiceConversation() {
    this._turnChain = this._turnChain.then(async () => {
      if (!this.session) return;
      const lastAgent = [...this.session.messages].reverse().find((m) => m.speaker === "agent");
      if (lastAgent) {
        this.setVoiceState("speaking");
        await this.voice.speak(lastAgent.text); // resolves even if TTS unavailable
      }
      if (!this.session || this.wrappingUp) return;
      // Do NOT pre-claim "listening" — the status flips to "Listening…" only
      // when recognition.onstart actually fires (via onListeningStateChange).
      this.setVoiceState("idle");
      this.voice.startListening();
    });
    return this._turnChain;
  }

  setVoiceState(state) {
    this.voiceState = state;
    try {
      if (window.__creativeFlowVoiceDebug) window.__creativeFlowVoiceDebug.processing = state === "thinking";
    } catch {
      /* diagnostics only */
    }
    if (!this.voiceMode) return;
    const label = { idle: "Tap mic to speak", listening: "Listening…", transcribing: "Transcribing…", thinking: "Thinking…", speaking: "Speaking…" }[state];
    if (label) this.setStatus(label);
  }

  /* ---------- Copilot bridge — ONE turn path for voice and text ---------- */

  handleTurn(text) {
    this._turnChain = this._turnChain.then(async () => {
      if (!this.session || this.wrappingUp) return;
      const voiceMode = this.voiceMode;
      if (voiceMode) {
        this.voice.stopSpeaking(); // typing/speaking interrupts current TTS
        this.voice.stopListening();
      }
      this.appendMessage({ speaker: "client", text });
      this.renderSuggestions([]);
      if (voiceMode) this.setVoiceState("thinking");
      else this.setStatus("Thinking…");

      let turn;
      try {
        if (DEBUG) {
          // Payload log for development — no secrets are ever in this payload.
          console.info("[voice] sending transcript to /api/copilot/turn", {
            sessionId: this.session.sessionId,
            userMessage: text,
          });
        }
        turn = await api.copilotTurn(this.session.sessionId, text);
        if (DEBUG) console.info("[voice] Copilot response received");
      } catch {
        this.setStatus("Creative intelligence temporarily unavailable");
        this.setMicHint("Creative intelligence temporarily unavailable — please try again.");
        if (voiceMode && !this.voice.muted) {
          await pause(1200);
          this.setVoiceState("idle"); // "Listening…" only after onstart fires
          this.voice.startListening(); // allow retry by voice
        }
        return;
      }

      this.setMicHint(
        turn.degraded
          ? "Creative intelligence temporarily unavailable — please try again."
          : voiceMode
            ? "Browser voice · free, no credits used"
            : "Text simulation · no voice credits used",
      );
      this.appendMessage({ speaker: "agent", text: turn.responseText });
      if (turn.requirementList) this.renderRequirements(turn.requirementList);

      if (voiceMode) {
        // Speak ONLY responseText. If TTS fails the text is already shown.
        this.setVoiceState("speaking");
        await this.voice.speak(turn.responseText);
      } else {
        this.setStatus("Call in progress");
      }

      if (turn.complete) {
        await this.wrapUp();
        return;
      }

      if (voiceMode && !this.voice.muted && !this.wrappingUp) {
        this.setVoiceState("idle"); // "Listening…" appears only after onstart
        this.voice.startListening(); // playback done — visitor may speak again
      } else if (voiceMode) {
        this.setVoiceState("idle");
      }
    });
    return this._turnChain;
  }

  async wrapUp() {
    if (this.wrappingUp) return;
    this.wrappingUp = true;
    this.setStatus("Wrapping up");
    if (this.els?.briefStatus) this.els.briefStatus.textContent = "Requirements complete";
    this.voice.stop(); // end recognition + TTS cleanly before review
    await pause(1600);
    await this.renderConfirm();
    this.wrappingUp = false;
  }

  setStatus(text) {
    if (this.els?.status) this.els.status.textContent = text;
  }

  setMicHint(text) {
    if (this.els?.micHint) this.els.micHint.textContent = text;
  }

  renderSuggestions(list) {
    if (!this.els?.suggestions) return;
    this.els.suggestions.innerHTML = "";
    for (const text of list || []) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "suggestion";
      b.textContent = text;
      b.addEventListener("click", () => this.handleTurn(text));
      this.els.suggestions.appendChild(b);
    }
  }

  appendMessage(msg, animate = true) {
    if (!this.els?.transcript) return null;
    const el = document.createElement("div");
    el.className = `msg msg-${msg.speaker === "agent" ? "agent" : "client"}`;
    el.innerHTML = `
      <p class="msg-speaker">${msg.speaker === "agent" ? "AI" : "You"}</p>
      <p class="msg-text"></p>`;
    el.querySelector(".msg-text").textContent = msg.text;
    if (!animate) el.style.animation = "none";
    this.els.transcript.appendChild(el);
    this.els.transcript.scrollTop = this.els.transcript.scrollHeight;
    return el;
  }

  renderRequirements(reqs) {
    if (!this.els?.reqs || !Array.isArray(reqs)) return;
    const prev = this.prevReqs || {};
    this.els.reqs.innerHTML = "";
    for (const r of reqs) {
      const s = STATE_GLYPH[r.status];
      const row = document.createElement("div");
      row.className = "req";
      if (prev[r.field] !== undefined && prev[r.field] !== r.value) row.classList.add("updated");
      const valueCls = r.value ? (r.status === "being_determined" ? "determining" : "") : "empty";
      row.innerHTML = `
        <p class="req-label">${r.label}</p>
        <p class="req-value ${valueCls}"></p>
        <span class="req-state ${s.cls}" title="${s.label}">${s.glyph}</span>`;
      row.querySelector(".req-value").textContent = r.value ?? "—";
      this.els.reqs.appendChild(row);
    }
    this.prevReqs = Object.fromEntries(reqs.map((r) => [r.field, r.value]));
  }

  /* ---------- 3. confirmation ---------- */

  async renderConfirm() {
    clearInterval(this.timerId);
    this.voice.stop();
    this.setModeTag("Simulated production");
    const { brief } = await api.buildBrief(this.session.sessionId);
    this.brief = brief;

    const rows = brief.requirements
      .filter((r) => r.value)
      .map(
        (r) => `
        <div class="confirm-row">
          <p class="req-label">${r.label}</p>
          <p class="value">${escapeHtml(r.value)}</p>
          <p class="confidence">${Math.round(r.confidence * 100)}%</p>
        </div>`,
      )
      .join("");

    const view = this.setView(`
      <div class="confirm-view">
        <p class="eyebrow">Requirements complete</p>
        <h2>I've captured everything I need.</h2>
        <p class="lede">Before production begins, let's confirm the brief.</p>
        <div class="confirm-grid">${rows}</div>
        <div class="confirm-actions">
          <button class="btn btn-accent btn-lg" data-a="confirm">Confirm brief</button>
          <button class="btn btn-ghost btn-lg" data-a="changes">Make changes</button>
        </div>
      </div>
    `);

    view.querySelector("[data-a=confirm]").addEventListener("click", () => this.confirmBrief());
    view.querySelector("[data-a=changes]").addEventListener("click", async () => {
      const { session } = await api.reopenSession(this.session.sessionId);
      this.session = session;
      this.suggestions = [];
      this.wrappingUp = false;
      this.setModeTag(this.voiceMode ? "Live voice demo" : "Simulated call");
      this.renderCall();
      if (this.voiceMode) this.beginVoiceConversation(); // resume the browser voice loop
    });
  }

  async confirmBrief() {
    const { brief } = await api.confirmBrief(this.brief.id);
    this.brief = brief;

    this.setView(`
      <div class="confirm-done">
        <p class="big-check">✓</p>
        <h2>Brief confirmed</h2>
        <p>Starting creative production…</p>
      </div>
    `);
    const [{ job }] = await Promise.all([api.startProduction(brief.id), pause(1500)]);
    this.job = job;
    this.renderProduction();
  }

  /* ---------- 4. production ---------- */

  renderProduction() {
    const view = this.setView(`
      <div class="production-view">
        <p class="eyebrow">Creative production</p>
        <h2>${escapeHtml(this.brief.title)}</h2>
        <div class="stage-list" data-el="stages"></div>
        <div class="brief-doc" data-el="brief-doc">
          <button class="brief-doc-head" type="button">
            Production brief
            <span class="chev">▼</span>
          </button>
          <div class="brief-doc-body">${this.briefDocHtml()}</div>
        </div>
      </div>
    `);
    this.els = { stages: view.querySelector("[data-el=stages]") };
    const doc = view.querySelector("[data-el=brief-doc]");
    doc.querySelector(".brief-doc-head").addEventListener("click", () => doc.classList.toggle("open"));

    this.renderStages(this.job.stages);

    clearInterval(this.pollId);
    this.pollId = setInterval(async () => {
      try {
        const { job } = await api.getProduction(this.job.id);
        this.job = job;
        this.renderStages(job.stages);
        if (job.status === "complete") {
          clearInterval(this.pollId);
          await pause(900);
          this.renderResult();
        }
      } catch {
        /* transient poll error — keep trying */
      }
    }, 700);
  }

  renderStages(stages) {
    this.els.stages.innerHTML = "";
    for (const st of stages) {
      const row = document.createElement("div");
      row.className = `stage stage-${st.status}`;
      const state =
        st.status === "complete"
          ? `✓ Complete`
          : st.status === "processing"
            ? `<span class="spinner"></span> Processing`
            : `○ Waiting`;
      row.innerHTML = `
        <span class="stage-idx">${String(st.index).padStart(2, "0")}</span>
        <span>
          <span class="stage-label">${st.label}</span>
          ${st.status === "processing" && st.detail ? `<span class="stage-detail">${escapeHtml(st.detail)}</span>` : ""}
        </span>
        <span class="stage-state">${state}</span>`;
      this.els.stages.appendChild(row);
    }
  }

  briefDocHtml() {
    const d = this.brief.direction;
    const req = (f) => this.brief.requirements.find((r) => r.field === f)?.value ?? "—";
    const swatches = d.colorPalette
      .map((c) => `<span class="swatch" style="background:${c}" title="${c}"></span>`)
      .join("");
    return `
      <div class="doc-section">
        <p class="doc-title">Client requirements</p>
        <p class="doc-body">${escapeHtml(req("client"))} · ${escapeHtml(req("product"))} · ${escapeHtml(req("campaign"))}<br/>
        ${escapeHtml(req("platform"))} · ${escapeHtml(req("audience"))} · ${escapeHtml(req("duration"))} · ${escapeHtml(req("aspectRatio"))}</p>
      </div>
      <div class="doc-section"><p class="doc-title">Creative direction — mood</p><p class="doc-body">${escapeHtml(d.mood)}</p></div>
      <div class="doc-section"><p class="doc-title">Visual composition</p><p class="doc-body">${escapeHtml(d.composition)}</p></div>
      <div class="doc-section"><p class="doc-title">Lighting</p><p class="doc-body">${escapeHtml(d.lighting)}</p></div>
      <div class="doc-section"><p class="doc-title">Camera</p><p class="doc-body">${escapeHtml(d.camera)}</p></div>
      <div class="doc-section"><p class="doc-title">Environment</p><p class="doc-body">${escapeHtml(d.environment)}</p></div>
      <div class="doc-section"><p class="doc-title">Color palette</p><div class="palette">${swatches}</div></div>
      <div class="doc-section"><p class="doc-title">Motion</p><p class="doc-body">${escapeHtml(d.motion)}</p></div>
      <div class="doc-section">
        <p class="doc-title">Things to avoid</p>
        <ul class="doc-list">${d.avoid.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul>
      </div>`;
  }

  /* ---------- 5. result ---------- */

  renderResult() {
    const asset = this.job.assets[0];
    const s = this.job.summary;
    const spec = `${asset.durationSeconds} sec · ${this.brief.requirements.find((r) => r.field === "platform")?.value ?? "—"} · ${asset.aspectRatio}`;


    // Part 1: the REAL completed Veo video (same URL as the floating player).
    // Falls back to the existing simulated canvas preview until completion.
    this.preview?.destroy();
    this.preview = null;
    const media = resolveResultMedia(
      this.session ? getCompletedVideo(this.session.sessionId) : null,
      asset,
    );
    const real = media.kind === "real";
    const view = this.setView(`
      <div class="result-view">
        <p class="eyebrow">Production complete</p>
        <h2>Creative ready.</h2>
        <div class="result-grid">
          <div class="player${real ? " player-real" : ""}" data-el="player">
            ${real
              ? `<video class="real-video" src="${media.videoUrl}" controls playsinline preload="metadata"></video><span class="sim-render-tag ai-tag">AI GENERATED</span>`
              : media.kind === "mock"
                ? `<video src="${media.videoUrl}" playsinline loop></video>`
                : `<canvas></canvas><span class="sim-render-tag">${media.label}</span>`}
            ${real ? "" : `<div class="player-ui">
              <button class="pbtn" data-a="play" aria-label="Play">
                <svg viewBox="0 0 16 16" data-el="play-ic"><path d="M4 2.5v11l9-5.5z"/></svg>
              </button>
              <div class="player-progress"><span data-el="bar"></span></div>
              <span class="player-time" data-el="time">0:00</span>
              <button class="pbtn" data-a="fs" aria-label="Fullscreen">
                <svg viewBox="0 0 16 16"><path d="M2 6V2h4v1.5H3.5V6H2zm8-4h4v4h-1.5V3.5H10V2zM2 10h1.5v2.5H6V14H2v-4zm12 0H14v4h-4v-1.5h2.5V10z"/></svg>
              </button>
            </div>`}
          </div>
          <div class="result-meta">
            <p class="meta-title">${escapeHtml(this.brief.title)}</p>
            <p class="meta-spec">${spec}</p>
            <div class="result-actions">
              ${real ? `<a class="btn btn-accent" data-a="download" href="${media.downloadUrl}" download="creativeflow-video.mp4" target="_blank" rel="noopener">Download Video</a>` : ""}
              <button class="btn btn-primary" data-a="fs2">Watch fullscreen</button>
              <button class="btn btn-ghost" data-a="view-brief">View creative brief</button>
              <button class="btn btn-ghost" data-a="restart">Start another project</button>
            </div>
            <div class="summary">
              <p class="summary-title">Production summary</p>
              <div class="summary-row"><span class="k">Client requirements</span><span class="v">${s.requirementsCaptured} captured</span></div>
              <div class="summary-row"><span class="k">Creative decisions</span><span class="v">${s.creativeDecisions} generated</span></div>
              <div class="summary-row"><span class="k">Production stages</span><span class="v">${s.stages}</span></div>
              <div class="summary-row"><span class="k">Human review</span><span class="v">${s.humanReview === "not_required" ? "Not required" : "Required"}</span></div>
              <div class="summary-row"><span class="k">Final format</span><span class="v">${s.finalFormat}</span></div>
            </div>
            <div class="brief-doc" data-el="brief-doc" style="margin-top:28px">
              <button class="brief-doc-head" type="button">Creative brief<span class="chev">▼</span></button>
              <div class="brief-doc-body">${this.briefDocHtml()}</div>
            </div>
          </div>
        </div>
      </div>
    `);

    const playerEl = view.querySelector("[data-el=player]");
    const video = playerEl.querySelector("video");
    const canvas = playerEl.querySelector("canvas");

    if (!real) {
      // Existing simulated player UI (canvas preview or mock asset video).
      const bar = view.querySelector("[data-el=bar]");
      const time = view.querySelector("[data-el=time]");
      const playIc = view.querySelector("[data-el=play-ic]");

      let isPlaying = false;
      const setIcon = () => {
        playIc.innerHTML = isPlaying
          ? '<path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z"/>'
          : '<path d="M4 2.5v11l9-5.5z"/>';
      };

      if (video) {
        video.addEventListener("timeupdate", () => {
          bar.style.width = `${(video.currentTime / video.duration) * 100}%`;
          time.textContent = fmtClock(video.currentTime);
        });
      } else {
        this.preview = new RenderedPreview(canvas, {
          durationSeconds: asset.durationSeconds ?? 8,
          palette: this.brief.direction.colorPalette,
        });
        this.preview.onProgress = (p, t) => {
          bar.style.width = `${p * 100}%`;
          time.textContent = fmtClock(t);
        };
      }

      const toggle = () => {
        isPlaying = !isPlaying;
        if (video) (isPlaying ? video.play() : video.pause());
        else isPlaying ? this.preview.play() : this.preview.pause();
        setIcon();
      };

      view.querySelector("[data-a=play]").addEventListener("click", toggle);
      playerEl.addEventListener("click", (e) => {
        if (e.target.closest(".pbtn")) return;
        toggle();
      });

      // Autoplay the simulated preview after a beat - it is the payoff moment.
      setTimeout(toggle, 600);

      // Hot-swap: when the real Veo video completes while this view is open,
      // re-render so the main preview shows the exact generated videoUrl.
      const sid = this.session?.sessionId;
      if (sid) {
        if (this._videoDoneHandler)
          document.removeEventListener("cf:video-completed", this._videoDoneHandler);
        const handler = (e) => {
          if (e.detail?.sessionId !== sid) return;
          document.removeEventListener("cf:video-completed", handler);
          this._videoDoneHandler = null;
          if (this.stage.querySelector(".result-view")) this.renderResult();
        };
        this._videoDoneHandler = handler;
        document.addEventListener("cf:video-completed", handler);
      }
    }

    const goFullscreen = () =>
      real && video?.requestFullscreen
        ? video.requestFullscreen()
        : playerEl.requestFullscreen?.();
    view.querySelector("[data-a=fs]")?.addEventListener("click", goFullscreen);
    view.querySelector("[data-a=fs2]").addEventListener("click", goFullscreen);
    view.querySelector("[data-a=view-brief]").addEventListener("click", () => {
      const doc = view.querySelector("[data-el=brief-doc]");
      doc.classList.add("open");
      doc.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    view.querySelector("[data-a=restart]").addEventListener("click", () => {
      // Start another project: clear previous video/production state fully.
      resetVideoUi();
      this.renderPrecall();
    });
    view.querySelectorAll(".brief-doc-head").forEach((h) =>
      h.addEventListener("click", () => h.parentElement.classList.toggle("open")),
    );
  }
}

/* ---------- utilities ---------- */

function pause(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function fmtTime(total) {
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}
function fmtClock(t) {
  return `0:${String(Math.floor(t)).padStart(2, "0")}`;
}
function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
