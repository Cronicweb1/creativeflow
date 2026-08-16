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
          error: "Video generation is taking longer than expected. You can check again shortly.",
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
      const entry = {
        state: { phase: "idle", sessionId },
        stopped: false,
        promise: null,
        args: { sessionId, productionBrief, jobId },
      };
      sessions.set(sessionId, entry);
      entry.promise = run(entry, entry.args);
      return entry.promise;
    },

    /**
     * Explicit user-initiated retry after failed/timeout. Never automatic.
     * Clears the finished entry and re-tracks with the remembered brief.
     */
    retry(sessionId) {
      const existing = sessions.get(sessionId);
      if (!existing) return Promise.resolve(null);
      if (!existing.stopped && !["failed", "timeout"].includes(existing.state.phase)) {
        return existing.promise; // still running — nothing to retry
      }
      const args = { ...existing.args, jobId: null }; // force a fresh job
      existing.stopped = true;
      sessions.delete(sessionId);
      return this.track(args);
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
/* Job persistence — lets a page refresh resume polling an active job. */
/* Uses sessionStorage (existing browser session scope); no new DB.    */
/* ------------------------------------------------------------------ */

const JOB_STORE_KEY = "cf_video_job";

export function saveActiveJob(storage, { sessionId, jobId }, now = Date.now()) {
  if (!storage || !sessionId || !jobId) return;
  try {
    storage.setItem(JOB_STORE_KEY, JSON.stringify({ sessionId, jobId, savedAt: now }));
  } catch {
    /* storage may be unavailable (private mode) — resume is best-effort */
  }
}

export function loadActiveJob(storage, maxAgeMs = 10 * 60 * 1000, now = Date.now()) {
  if (!storage) return null;
  try {
    const raw = storage.getItem(JOB_STORE_KEY);
    if (!raw) return null;
    const job = JSON.parse(raw);
    if (!job || typeof job.sessionId !== "string" || typeof job.jobId !== "string") return null;
    if (typeof job.savedAt !== "number" || now - job.savedAt > maxAgeMs) return null; // stale
    return job;
  } catch {
    return null;
  }
}

export function clearActiveJob(storage) {
  try {
    storage?.removeItem(JOB_STORE_KEY);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Production timeline sync (pure, DOM-free, unit-tested)              */
/*                                                                     */
/* The simulated production job (/api/production/:id) advances its     */
/* stages on timers, while the REAL Veo job is polled separately by    */
/* the tracker above. Without syncing, the timeline can claim          */
/* "Video generation — Complete" while the real render is still        */
/* running. These helpers clamp the simulated stages while a real      */
/* video job is pending so both progress views stay in sync.           */
/* ------------------------------------------------------------------ */

const PENDING_PHASES = new Set(["idle", "starting", "generating"]);
const VIDEO_STAGE_RE = /video\s*generation/i;
const VIDEO_STAGE_DETAIL = "Rendering with Gemini Veo";

/** True while a tracked real video job exists and has not resolved yet. */
export function computeVideoPending(state) {
  return !!state && PENDING_PHASES.has(state.phase);
}

/**
 * Clamp a GET /api/production/:id response while the real video job is
 * still pending:
 *   - a simulated-complete "Video generation" stage is held at processing
 *   - every stage after it is held at waiting
 *   - job.status "complete" is held at "processing" so the result page
 *     only renders once the real videoUrl exists
 * Once the real job resolves (completed/failed/timeout), responses pass
 * through untouched — including the failure path, which keeps its
 * existing simulated result + retry UI.
 */
export function syncProductionWithVideo(response, pending) {
  if (!pending) return response;
  const job = response?.job;
  if (!job || !Array.isArray(job.stages)) return response;
  const idx = job.stages.findIndex((s) => VIDEO_STAGE_RE.test(String(s?.label ?? "")));
  if (idx === -1) return response;
  const stages = job.stages.map((s, i) => {
    if (i < idx) return s;
    if (i === idx) {
      // Never let the simulation claim completion ahead of the real render.
      return s.status === "waiting" ? s : { ...s, status: "processing", detail: VIDEO_STAGE_DETAIL };
    }
    return s.status === "waiting" ? s : { ...s, status: "waiting" };
  });
  const status = job.status === "complete" ? "processing" : job.status;
  return { ...response, job: { ...job, stages, status } };
}

/* ------------------------------------------------------------------ */
/* Browser UI (only runs in the page — nothing here touches the DOM    */
/* at import time, so the module stays importable in Node tests)       */
/* ------------------------------------------------------------------ */

let uiTracker = null;
let panelEl = null;
let rootObserver = null;
let latestVideoState = null; // most recent tracker state (browser session)

/** Browser-level: is the real video generation still pending right now? */
export function isVideoPending() {
  return computeVideoPending(latestVideoState);
}

function demoRoot() {
  const root = document.getElementById("demo-root");
  return root && !root.hidden ? root : document.body;
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


/* ---------- completed-video registry (DOM-free, shared with demo.js) ---------- */

const HTTP_RE = /^https?:\/\//i;
const completedVideos = new Map();

/**
 * Record a completed generation so other views (the main production preview
 * in demo.js) can reuse the SAME videoUrl. Never fabricates URLs.
 */
export function recordCompletedVideo(sessionId, state = {}) {
  const { videoUrl, downloadUrl } = state;
  if (!sessionId || typeof videoUrl !== "string" || !HTTP_RE.test(videoUrl)) return null;
  const entry = {
    sessionId,
    videoUrl,
    downloadUrl:
      typeof downloadUrl === "string" && HTTP_RE.test(downloadUrl) ? downloadUrl : videoUrl,
  };
  completedVideos.set(sessionId, entry);
  return entry;
}

/** The completed video for a session, or null. */
export function getCompletedVideo(sessionId) {
  return (sessionId && completedVideos.get(sessionId)) || null;
}

/** Clear all completed-video state (new project / demo closed). */
export function clearCompletedVideos() {
  completedVideos.clear();
}

/**
 * Decide what the MAIN production preview should show. Pure and DOM-free so
 * it is unit-testable in Node:
 *   - real Veo video when the session has a completed generation
 *   - mock asset video when one exists (legacy/simulated path)
 *   - canvas placeholder otherwise (also for failed/incomplete jobs)
 */
export function resolveResultMedia(completed, asset) {
  if (completed && typeof completed.videoUrl === "string" && HTTP_RE.test(completed.videoUrl)) {
    return {
      kind: "real",
      videoUrl: completed.videoUrl,
      downloadUrl: completed.downloadUrl || completed.videoUrl,
      label: "AI GENERATED",
    };
  }
  if (asset && typeof asset.url === "string" && HTTP_RE.test(asset.url)) {
    return { kind: "mock", videoUrl: asset.url, downloadUrl: null, label: "Concept preview" };
  }
  return { kind: "placeholder", videoUrl: null, downloadUrl: null, label: "Concept preview" };
}

/** Browser-only: notify open views (demo.js result page) of a completion. */
function announceCompleted(state) {
  try {
    document.dispatchEvent(
      new CustomEvent("cf:video-completed", {
        detail: {
          sessionId: state.sessionId,
          videoUrl: state.videoUrl,
          downloadUrl: state.downloadUrl || state.videoUrl,
        },
      }),
    );
  } catch {
    /* non-browser environment */
  }
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
  latestVideoState = state; // keep the production timeline in sync
  if (state.phase === "stopped") {
    removePanel();
    return;
  }
  const el = ensurePanel();
  if (state.phase === "completed") {
    clearActiveJob(getStorage());
    // Share the completed URL with the main production preview (demo.js).
    recordCompletedVideo(state.sessionId, state);
    announceCompleted(state);
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
    clearActiveJob(getStorage());
    el.innerHTML = "";
    const head = document.createElement("div");
    head.className = "video-panel-head error";
    head.textContent = state.phase === "timeout" ? "Still working\u2026" : "Video generation failed";
    const note = document.createElement("p");
    note.className = "video-panel-note";
    note.textContent = state.error || "Video generation failed. Please try again.";
    el.append(head, note);
    if (state.phase === "failed" && uiTracker) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn video-retry";
      btn.textContent = "Try again";
      btn.addEventListener("click", () => {
        // Explicit user action — the only path that restarts generation.
        void uiTracker?.retry(state.sessionId);
      });
      el.appendChild(btn);
    }
    return;
  }
  // idle / starting / generating
  if (state.phase === "generating" && state.jobId) {
    saveActiveJob(getStorage(), { sessionId: state.sessionId, jobId: state.jobId });
  }
  el.innerHTML =
    `<div class="video-panel-head"><span class="spinner"></span>Generating your video\u2026</div>` +
    `<p class="video-panel-note">Usually takes 30\u2013180 seconds.</p>`;
}

function getStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Hook called by api.js after every /api/copilot/turn response. Starts (or
 * re-attaches to) video tracking when the brief is production-ready. The
 * conversation flow is never touched — this is purely additive.
 */
export function onCopilotTurn(sessionId, turn, fetchJson) {
  // Router: generate when readyForProduction OR the user force-requested it.
  if (!turn || (turn.readyForProduction !== true && turn.forceGenerate !== true)) return;
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

/**
 * Resume polling after a page refresh: if sessionStorage still holds an
 * active (< 10 min old) job, re-attach to it by jobId. Never starts a new
 * generation — it only polls the existing job's status endpoint.
 */
export function resumeVideoUi(fetchJson) {
  const job = loadActiveJob(getStorage());
  if (!job) return;
  ensureStyles();
  if (!uiTracker) {
    uiTracker = createVideoTracker({ fetchJson, onUpdate: renderState });
  }
  if (uiTracker.isTracking(job.sessionId)) return;
  void uiTracker.track({ sessionId: job.sessionId, productionBrief: null, jobId: job.jobId });
}

/** Reset on a fresh demo session so a new conversation starts clean. */
export function resetVideoUi() {
  clearActiveJob(getStorage());
  clearCompletedVideos();
  latestVideoState = null;
  uiTracker?.stop();
  uiTracker = null;
  removePanel();
}
