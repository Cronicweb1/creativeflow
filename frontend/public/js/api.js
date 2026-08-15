/**
 * API client. All backend access goes through here.
 *
 * The API origin defaults to same-origin (single Render service). When the
 * frontend is deployed separately, the backend origin is injected at deploy
 * time via /js/config.js defining window.CREATIVEFLOW_API_URL.
 */

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
  startSession: () => request("POST", "/api/demo/session"),
  sendMessage: (sessionId, text) => request("POST", "/api/demo/message", { sessionId, text }),
  buildBrief: (sessionId) => request("POST", "/api/brief/build", { sessionId }),
  confirmBrief: (briefId) => request("POST", "/api/brief/confirm", { briefId }),
  reopenSession: (sessionId) => request("POST", "/api/brief/reopen", { sessionId }),
  startProduction: (briefId) => request("POST", "/api/production/start", { briefId }),
  getProduction: (jobId) => request("GET", `/api/production/${jobId}`),
};
