/**
 * API client. All backend access goes through here.
 *
 * The API origin defaults to same-origin (single Render service). When the
 * frontend is deployed separately, the backend origin is injected at deploy
 * time via /js/config.js defining window.CREATIVEFLOW_API_URL.
 */

import { onCopilotTurn, resetVideoUi, resumeVideoUi } from "./videoStatus.js";

const BASE = (window.CREATIVEFLOW_API_URL || "").replace(/\/$/, "");

async function request(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `http_${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  health: () => request("GET", "/api/health"),
  startSession: async () => {
    const out = await request("POST", "/api/demo/session");
    resetVideoUi(); // fresh conversation → clear any previous video panel
    return out;
  },
  sendMessage: (sessionId, text) => request("POST", "/api/demo/message", { sessionId, text }),
  // Copilot bridge — the conversational brain lives behind the backend.
  copilotTurn: async (sessionId, userMessage) => {
    const turn = await request("POST", "/api/copilot/turn", { sessionId, userMessage });
    // Video pipeline hook: when the brief is production-ready, Activepieces
    // kicks off /api/video/generate — discover and track that job so the
    // real generated video appears in the UI. Purely additive; the
    // conversation flow is untouched.
    try {
      onCopilotTurn(sessionId, turn, request);
    } catch {
      /* video tracking must never break the conversation */
    }
    return turn;
  },
  copilotState: (sessionId) => request("GET", `/api/copilot/state/${sessionId}`),
  buildBrief: (sessionId) => request("POST", "/api/brief/build", { sessionId }),
  confirmBrief: (briefId) => request("POST", "/api/brief/confirm", { briefId }),
  reopenSession: (sessionId) => request("POST", "/api/brief/reopen", { sessionId }),
  startProduction: (briefId) => request("POST", "/api/production/start", { briefId }),
  getProduction: (jobId) => request("GET", `/api/production/${jobId}`),
  // Video generation (Composio → Gemini Veo). Jobs are normally started by
  // the Activepieces "Generate Video" branch; the frontend discovers and
  // polls them. generateVideo is a safe fallback (backend dedups by session).
  videoForSession: (sessionId) => request("GET", `/api/video/session/${encodeURIComponent(sessionId)}`),
  videoStatus: (jobId) => request("GET", `/api/video/status/${encodeURIComponent(jobId)}`),
  generateVideo: (sessionId, productionBrief) =>
    request("POST", "/api/video/generate", { sessionId, productionBrief }),
};

// Page refresh: resume polling an active video job (if one was persisted for
// this browser session). Never starts a new generation.
try {
  resumeVideoUi(request);
} catch {
  /* resume is best-effort */
}
