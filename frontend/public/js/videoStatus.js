/**
 * Video generation tracking — Creative brief → Activepieces → /api/video.
 *
 * Flow (Activepieces owns the trigger):
 *   Groq turn → readyForProduction:true → Activepieces "Generate Video"
 *   branch POSTs /api/video/generate on this backend → the frontend
 *   DISCOVERS that job via GET /api/video/session/:sessionId and polls
 *   GET /api/video/status/:jobId every 5 seconds (10-minute timeout).
 *
 * If no Activepieces-created job appears within the discovery window, the
 * tracker starts one itself with the turn's productionBrief (the backend
 * de-duplicates per session, so this can never double-generate).
 *
 * The module has two layers:
 *   1. createVideoTracker(...)  — DOM-free, dependency-injected core
 *      (unit-tested in Node: backend/test/videoFrontend.test.ts).
 *   2. onCopilotTurn(...) / resetVideoUi() — thin browser UI that renders a
 *      persistent panel into #demo-root and cleans up when the demo closes.
 *
 * The videoUrl is NEVER fabricated — it is only ever taken verbatim from a
 * `completed` status response.
 */

const HTTP_URL = /^https?:\/\//i;

/* ------------------------------------------------------------------ */
/* Core tracker (DOM-free, testable)                                   */
/* ------------------------------------------------------------------ */

export function createVideoTracker(opts = {}) {
  const {
    fetchJson,                       // async (method, path, body?) => JSON (throws on !ok)
    onUpdate = () => {},             // (state) => void
    intervalMs = 5000,               // poll cadence (spec: every 5 seconds)
    timeoutMs = 10 * 60 * 1000,      // stop polling after 10 minutes (spec)
    discoverAttempts = 4,            // tries to find the Activepieces-created job
    discoverDelayMs = 2500,
    now = () => Date.now(),
    delay = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = opts;

  if (typeof fetchJson !== "function") throw new Error("fetchJson is required");

  const sessions = new Map(); // sessionId -> { promise, state, stopped }

  function emit(entry, patch) {
    entry.state = { ...entry.state, ...patch };
    try {
      onUpdate({ ...entry.state });
    } catch {
      /* UI listener errors must never kill the tracker */
    }
    return entry.state;
  }

  /** Accept a URL only if the server really returned one. Never invent it. */
  function realUrl(value) {
    return typeof value === "string" && HTTP_URL.test(value) ? value : null;
  }

  async function discoverJobId(entry, sessionId, productionBrief) {
    // 1. Look for the job Activepieces already started for this session.
    for (let i = 0; i < discoverAttempts; i++) {
      if (entry.stopped) return null;
      try {
        const found = await fetchJson("GET", `/api/video/session/${encodeURIComponent(sessionId)}`);
        if (found && typeof found.jobId === "string" && found.jobId) return found.jobId;
      } catch {
        /* 404 = not started yet — keep waiting */
      }
      if (i < discoverAttempts - 1) await delay(discoverDelayMs);
    }
    // 2. Fallback: start it ourselves (backend dedupes by session, so even a
    //    race with Activepieces yields a single job).
    if (productionBrief && typeof productionBrief === "object") {
      const started = await fetchJson("POST", "/api/video/generate", { sessionId, productionBrief });
      if (started && typeof started.jobId === "string" && started.jobId) return started.jobId;
    }
    return null;
  }

  async function run(entry, { sessionId, productionBrief, jobId }) {
    const startedAt = now();
    emit(entry, { phase: "starting", sessionId });

    let id = typeof jobId === "string" && jobId ? jobId : null;
    try {
      if (!id) id = await discoverJobId(entry, sessionId, productionBrief);
    } catch {
      return emit(entry, { phase: "failed", error: "Video generation could not be started." });
    }
    if (entry.stopped) return emit(entry, { phase: "stopped" });
    if (!id) return emit(entry, { phase: "failed", error: "Video generation did not start." });

    emit(entry, { phase: "generating", jobId: id });

    // Poll every `intervalMs`, but never past `timeoutMs`.
    while (!entry.stopped) {
      if (now() - startedAt >= timeoutMs) {
        return emit(entry, {
          phase: "timeout",
          error: "Video generation is taking longer than expected. Please check back later.",
        });
      }
      let status;
      try {
        status = await fetchJson("GET", `/api/video/status/${encodeURIComponent(id)}`);
      } catch {
        status = null; // transient poll error — keep trying until timeout
      }
      if (entry.stopped) return emit(entry, { phase: "stopped" });

      if (status && status.status === "completed") {
        const videoUrl = realUrl(status.videoUrl);
        const downloadUrl = realUrl(status.downloadUrl) ?? videoUrl;
        if (!videoUrl) {
          // A "completed" job without a genuine URL is a failure — do NOT
          // display a made-up video.
          return emit(entry, { phase: "failed", error: "The generated video URL was missing." });
        }
        return emit(entry, { phase: "completed", videoUrl, downloadUrl });
      }
      if (status && status.status === "failed") {
        return emit(entry, {
          phase: "failed",
          error: "Video generation failed. You can confirm the brief again to retry.",
        });
      }
      emit(entry, { phase: "generating", elapsedMs: now() - startedAt });
      await delay(intervalMs);
    }
    return emit(entry, { phase: "stopped" });
  }

  return {
    /**
     * Track (at most once per session — duplicate calls return the original
     * in-flight tracking promise and start nothing new).
     */
    track({ sessionId, productionBrief = null, jobId = null }) {
      if (!sessionId || typeof sessionId !== "string") {
        return Promise.resolve({ phase: "failed", error: "Missing session." });
      }
      const existing = sessions.get(sessionId);
      if (existing) return existing.promise; // duplicate prevention
      const entry = { state: { phase: "idle", sessionId }, stopped: false, promise: null };
      sessions.set(sessionId, entry);
      entry.promise = run(entry, { sessionId, productionBrief, jobId });
      return entry.promise;
    },

    isTracking(sessionId) {
      return sessions.has(sessionId);
    },

    stateFor(sessionId) {
      return sessions.get(sessionId)?.state ?? null;
    },

    /** Stop all polling (demo closed / new session). */
    stop() {
      for (const entry of sessions.values()) entry.stopped = true;
      sessions.clear();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Browser UI (only runs in the page — nothing here touches the DOM    */
/* at import time, so the module stays importable in Node tests)       */
/* ------------------------------------------------------------------ */

let uiTracker = null;
let panelEl = null;
let rootObserver = null;

function demoRoot() {
  return document.getElementById("demo-root") ?? document.body;
}

function ensureStyles() {
  if (document.getElementById("video-panel-css")) return;
  const css = document.createElement("link");
  css.id = "video-panel-css";
  css.rel = "stylesheet";
  css.href = "styles/video.css";
  document.head.appendChild(css);
}

function removePanel() {
  panelEl?.remove();
  panelEl = null;
}

function ensurePanel() {
  const root = demoRoot();
  if (panelEl && root.contains(panelEl)) return panelEl;
  removePanel();
  panelEl = document.createElement("div");
  panelEl.className = "video-panel";
  root.appendChild(panelEl);
  return panelEl;
}

/** Stop tracking + remove the panel when the demo overlay is closed. */
function watchDemoRoot() {
  const root = document.getElementById("demo-root");
  if (!root || rootObserver) return;
  rootObserver = new MutationObserver(() => {
    if (root.hidden) resetVideoUi();
  });
  rootObserver.observe(root, { attributes: true, attributeFilter: ["hidden"] });
}

function renderState(state) {
  if (state.phase === "stopped") {
    removePanel();
    return;
  }
  const el = ensurePanel();
  if (state.phase === "completed") {
    // Only ever shown with a REAL videoUrl returned by the status endpoint.
    el.innerHTML = `<div class="video-panel-head done">Your video is ready</div>`;
    const video = document.createElement("video");
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.src = state.videoUrl;
    el.appendChild(video);
    const link = document.createElement("a");
    link.className = "btn video-download";
    link.href = state.downloadUrl || state.videoUrl;
    link.setAttribute("download", "creativeflow-video.mp4");
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Download Video";
    el.appendChild(link);
    return;
  }
  if (state.phase === "failed" || state.phase === "timeout") {
    el.innerHTML = "";
    const head = document.createElement("div");
    head.className = "video-panel-head error";
    head.textContent = "Video generation issue";
    const note = document.createElement("p");
    note.className = "video-panel-note";
    note.textContent = state.error || "Video generation failed. Please try again.";
    el.append(head, note);
    return;
  }
  // idle / starting / generating
  el.innerHTML =
    `<div class="video-panel-head"><span class="spinner"></span>Generating your video\u2026</div>` +
    `<p class="video-panel-note">Gemini Veo is producing your creative. This can take a few minutes.</p>`;
}

/**
 * Hook called by api.js after every /api/copilot/turn response. Starts (or
 * re-attaches to) video tracking when the brief is production-ready. The
 * conversation flow is never touched — this is purely additive.
 */
export function onCopilotTurn(sessionId, turn, fetchJson) {
  if (!turn || turn.readyForProduction !== true) return;
  if (!sessionId || typeof sessionId !== "string") return;
  ensureStyles();
  watchDemoRoot();
  if (!uiTracker) {
    uiTracker = createVideoTracker({ fetchJson, onUpdate: renderState });
  }
  if (uiTracker.isTracking(sessionId)) return; // duplicate prevention
  const jobId =
    typeof turn.videoJobId === "string" && turn.videoJobId
      ? turn.videoJobId
      : typeof turn.jobId === "string" && turn.jobId
        ? turn.jobId
        : null;
  void uiTracker.track({
    sessionId,
    productionBrief:
      turn.productionBrief && typeof turn.productionBrief === "object" ? turn.productionBrief : null,
    jobId,
  });
}

/** Reset on a fresh demo session so a new conversation starts clean. */
export function resetVideoUi() {
  uiTracker?.stop();
  uiTracker = null;
  removePanel();
}
