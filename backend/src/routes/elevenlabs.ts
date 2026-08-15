import type { Router } from "../lib/router.ts";
import { sendJson } from "../lib/router.ts";

/**
 * RETIRED — ElevenLabs Agents integration.
 *
 * This route is intentionally NOT registered in server.ts any more.
 * The ElevenLabs Conversational AI agent was removed from the CreativeFlow
 * conversation loop because it consumed credits too quickly; voice now runs
 * free in the browser (Web Speech API STT + speechSynthesis TTS) and the
 * conversational brain is the Activepieces /sync → Groq workflow behind
 * POST /api/copilot/turn.
 *
 * The file is kept isolated (dead code, never executed) in case ElevenLabs
 * is ever needed again for an unrelated, non-conversational feature. To
 * re-enable, import and call registerElevenLabsRoutes() in server.ts.
 *
 * GET /api/elevenlabs/token → { token }
 *
 * Configuration (only if ever re-enabled):
 *   ELEVENLABS_API_KEY   — secret ElevenLabs API key (server-only)
 *   ELEVENLABS_AGENT_ID  — the ElevenLabs Agents agent id
 */

const ELEVENLABS_TOKEN_URL = "https://api.elevenlabs.io/v1/convai/conversation/token";

export function registerElevenLabsRoutes(router: Router): void {
  router.get("/api/elevenlabs/token", async ({ res }) => {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const agentId = process.env.ELEVENLABS_AGENT_ID;

    if (!apiKey || !agentId) {
      const missing = [
        ...(apiKey ? [] : ["ELEVENLABS_API_KEY"]),
        ...(agentId ? [] : ["ELEVENLABS_AGENT_ID"]),
      ];
      return sendJson(res, 503, { error: "elevenlabs_not_configured", missing });
    }

    let upstream: Response;
    try {
      upstream = await fetch(
        `${ELEVENLABS_TOKEN_URL}?agent_id=${encodeURIComponent(agentId)}`,
        { headers: { "xi-api-key": apiKey } },
      );
    } catch {
      return sendJson(res, 502, { error: "elevenlabs_unreachable" });
    }

    if (!upstream.ok) {
      // Log status only — never the key, never full upstream bodies with secrets.
      console.error(`elevenlabs token request failed: http ${upstream.status}`);
      return sendJson(res, 502, { error: "elevenlabs_error", status: upstream.status });
    }

    const data = (await upstream.json().catch(() => ({}))) as { token?: string };
    if (!data.token) {
      return sendJson(res, 502, { error: "elevenlabs_error" });
    }

    // Only the short-lived conversation token reaches the browser.
    sendJson(res, 200, { token: data.token });
  });
}
