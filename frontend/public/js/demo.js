/**
 * Demo experience controller.
 *
 * A small state machine over the backend contract:
 *   precall → call → confirm → production → result
 *
 * All conversation and production state lives on the server; this module
 * renders it and forwards user input. The voice layer is injected, so the
 * simulated input can later be swapped for real browser voice capture
 * without touching this flow.
 */

import { api } from "./api.js";
import { SimulatedVoiceInput } from "./voice.js";
import { RenderedPreview } from "./preview.js";

const STATE_GLYPH = {
  not_collected: { glyph: "○", cls: "", label: "Not collected" },
  being_determined: { glyph: "◌", cls: "determining", label: "Being determined" },
  confirmed: { glyph: "✓", cls: "confirmed", label: "Confirmed" },
};

const AGENT_DELAY_MS = 900; // "thinking" pause before the agent replies

export class DemoExperience {
  constructor(root, stage) {
    this.root = root;
    this.stage = stage;
    this.voice = new SimulatedVoiceInput();
    this.session = null;
    this.brief = null;
    this.job = null;
    this.suggestions = [];
    this.timerId = 0;
    this.pollId = 0;
    this.callSeconds = 0;
    this.preview = null;
    this.micGranted = false;
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
    clearInterval(this.timerId);
    clearInterval(this.pollId);
    this.preview?.destroy();
    this.preview = null;
    this.voice.stop();
    this.session = null;
    this.brief = null;
    this.job = null;
    this.callSeconds = 0;
  }

  /* ---------- view helpers ---------- */

  setView(html) {
    this.stage.innerHTML = `<div class="view">${html}</div>`;
    return this.stage.firstElementChild;
  }

  /* ---------- 1. pre-call ---------- */

  renderPrecall() {
    this.teardown();
    const view = this.setView(`
      <div class="precall">
        <p class="eyebrow">Simulated client call</p>
        <h2>Ready to start?</h2>
        <p>You'll act as the client while the AI Creative Agent gathers the requirements for your campaign.</p>
        <p class="mic-note">Microphone access is required.</p>
        <button class="btn btn-accent btn-lg" data-a="allow">Allow microphone &amp; start call</button>
        <p class="precall-error" hidden></p>
      </div>
    `);
    const btn = view.querySelector("[data-a=allow]");
    const errEl = view.querySelector(".precall-error");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Requesting microphone…";
      const perm = await this.voice.requestPermission();
      this.micGranted = perm.granted;
      if (!perm.granted) {
        // The simulation still works without a mic; be honest about it.
        errEl.hidden = false;
        errEl.textContent =
          "Microphone unavailable — continuing in simulation mode. Voice capture will be enabled in the production integration.";
        await pause(1400);
      }
      btn.textContent = "Connecting…";
      try {
        const { session, suggestedResponses } = await api.startSession();
        this.session = session;
        this.suggestions = suggestedResponses;
        this.renderCall();
      } catch {
        btn.disabled = false;
        btn.textContent = "Allow microphone & start call";
        errEl.hidden = false;
        errEl.textContent = "Could not reach the CreativeFlow API. Please try again.";
      }
    });
  }

  /* ---------- 2. call ---------- */

  renderCall() {
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
            <p class="call-status"><span class="status-dot"></span><span data-el="status">Call in progress</span></p>
            <p class="call-timer" data-el="timer">00:00</p>
          </div>
          <div class="transcript" data-el="transcript"></div>
          <div class="call-input" data-el="input">
            <div class="suggestions" data-el="suggestions"></div>
            <form class="input-row" data-el="form">
              <input type="text" placeholder="Speak as the client — type your answer…" autocomplete="off" />
              <button class="btn btn-primary" type="submit">Send</button>
            </form>
            <div class="call-controls">
              <button class="ctl" type="button" data-a="mute" aria-label="Mute microphone" title="Mute">
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
            <p class="mic-hint">${this.micGranted ? "Microphone connected — voice streaming arrives with the production integration." : "Simulation mode — answers are sent as text."}</p>
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
      layout: view.querySelector(".call-layout"),
    };

    // Call timer.
    clearInterval(this.timerId);
    this.timerId = setInterval(() => {
      this.callSeconds += 1;
      this.els.timer.textContent = fmtTime(this.callSeconds);
    }, 1000);

    // Existing transcript + requirements (fresh session or reopened one).
    for (const msg of this.session.messages) this.appendMessage(msg, false);
    this.renderRequirements(this.session.requirements);
    this.renderSuggestions(this.suggestions);

    // The voice layer delivers client utterances (typed now, transcribed later).
    this.voice.onTranscript = (text) => this.handleClientUtterance(text);

    this.els.form.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = this.els.form.querySelector("input");
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      this.voice.submitUtterance(text);
    });

    view.querySelector("[data-a=mute]").addEventListener("click", (e) => {
      const btn = e.currentTarget;
      const muted = !btn.classList.contains("ctl-muted");
      btn.classList.toggle("ctl-muted", muted);
      this.voice.setMuted(muted);
    });
    view.querySelector("[data-a=end]").addEventListener("click", () => this.close());
  }

  renderSuggestions(list) {
    this.els.suggestions.innerHTML = "";
    for (const text of list || []) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "suggestion";
      b.textContent = text;
      b.addEventListener("click", () => this.voice.submitUtterance(text));
      this.els.suggestions.appendChild(b);
    }
  }

  appendMessage(msg, animate = true) {
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

  async handleClientUtterance(text) {
    if (!this.session || this.busy) return;
    this.busy = true;
    this.renderSuggestions([]);
    this.appendMessage({ speaker: "client", text });

    const typing = this.appendMessage({ speaker: "agent", text: "…" });
    typing.classList.add("msg-typing");

    try {
      const [turn] = await Promise.all([
        api.sendMessage(this.session.sessionId, text),
        pause(AGENT_DELAY_MS),
      ]);
      typing.remove();
      this.appendMessage(turn.reply);
      this.renderRequirements(turn.requirements);
      this.session.phase = turn.phase;

      if (turn.phase === "review") {
        this.els.status.textContent = "Wrapping up";
        this.els.briefStatus.textContent = "Requirements complete";
        await pause(1600);
        await this.renderConfirm();
      } else {
        this.renderSuggestions(turn.suggestedResponses);
      }
    } catch (err) {
      typing.remove();
      this.appendMessage({
        speaker: "agent",
        text: "Sorry — the line dropped for a second. Could you say that again?",
      });
      this.renderSuggestions(this.suggestions);
    } finally {
      this.busy = false;
    }
  }

  renderRequirements(reqs) {
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
      this.renderCall();
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

    const view = this.setView(`
      <div class="result-view">
        <p class="eyebrow">Production complete</p>
        <h2>Creative ready.</h2>
        <div class="result-grid">
          <div class="player" data-el="player">
            ${asset.url
              ? `<video src="${asset.url}" playsinline loop></video>`
              : `<canvas></canvas><span class="sim-render-tag">Simulated render</span>`}
            <div class="player-ui">
              <button class="pbtn" data-a="play" aria-label="Play">
                <svg viewBox="0 0 16 16" data-el="play-ic"><path d="M4 2.5v11l9-5.5z"/></svg>
              </button>
              <div class="player-progress"><span data-el="bar"></span></div>
              <span class="player-time" data-el="time">0:00</span>
              <button class="pbtn" data-a="fs" aria-label="Fullscreen">
                <svg viewBox="0 0 16 16"><path d="M2 6V2h4v1.5H3.5V6H2zm8-4h4v4h-1.5V3.5H10V2zM2 10h1.5v2.5H6V14H2v-4zm12 0H14v4h-4v-1.5h2.5V10z"/></svg>
              </button>
            </div>
          </div>
          <div class="result-meta">
            <p class="meta-title">${escapeHtml(this.brief.title)}</p>
            <p class="meta-spec">${spec}</p>
            <div class="result-actions">
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
    const bar = view.querySelector("[data-el=bar]");
    const time = view.querySelector("[data-el=time]");
    const playIc = view.querySelector("[data-el=play-ic]");
    const video = playerEl.querySelector("video");
    const canvas = playerEl.querySelector("canvas");

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
    const goFullscreen = () => playerEl.requestFullscreen?.();
    view.querySelector("[data-a=fs]").addEventListener("click", goFullscreen);
    view.querySelector("[data-a=fs2]").addEventListener("click", goFullscreen);
    view.querySelector("[data-a=view-brief]").addEventListener("click", () => {
      const doc = view.querySelector("[data-el=brief-doc]");
      doc.classList.add("open");
      doc.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    view.querySelector("[data-a=restart]").addEventListener("click", () => this.renderPrecall());
    view.querySelectorAll(".brief-doc-head").forEach((h) =>
      h.addEventListener("click", () => h.parentElement.classList.toggle("open")),
    );

    // Autoplay the preview after a beat — it is the payoff moment.
    setTimeout(toggle, 600);
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
