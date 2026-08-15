import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Router, sendJson } from "./lib/router.ts";
import { registerDemoRoutes } from "./routes/demo.ts";
import { registerBriefRoutes } from "./routes/brief.ts";
import { registerProductionRoutes } from "./routes/production.ts";
import { registerCopilotRoutes } from "./routes/copilot.ts";
import { registerTtsRoutes, ttsProviderName } from "./routes/tts.ts";
import { registerTranscribeRoutes, sttProviderName } from "./routes/transcribe.ts";
import { registerVideoRoutes } from "./routes/video.ts";
import { conversationService } from "./services/conversationService.ts";
import { briefService } from "./services/briefService.ts";
import { productionService } from "./services/productionService.ts";
import { copilotProviderName, createCopilotProvider } from "./services/copilotService.ts";
import { createVideoService, videoProviderName } from "./services/videoService.ts";

/**
 * CreativeFlow API + static host.
 *
 * Serves the frontend from /frontend/public and the API under /api/*.
 * Runs on plain Node (>= 22.18 / 24) with native TypeScript type
 * stripping — no build step, no runtime dependencies.
 *
 * Voice is browser-native (Web Speech API — free STT + TTS in the client);
 * the ElevenLabs conversational-agent integration is retired and its route
 * is intentionally NOT registered, so no credit-consuming voice session can
 * ever be created.
 *
 * Provider credentials come from the environment and are never exposed
 * to the browser:
 *   COPILOT_WORKFLOW_URL, COPILOT_AUTH_TOKEN — Activepieces /sync → Groq brain (live mode)
 *   GROQ_API_KEY                             — server-side Whisper STT (/api/voice/transcribe)
 *   GEMINI_API_KEY, COMPOSIO_API_KEY         — production pipeline (still mocked)
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = resolve(HERE, "../../frontend/public");
const PORT = Number(process.env.PORT ?? 3000);

const router = new Router(STATIC_ROOT);
const copilotProvider = createCopilotProvider(conversationService);
const videoService = createVideoService();

/**
 * "browser"     — default: free Web Speech API voice in the client
 * "simulation"  — force the typed text simulation (VOICE_PROVIDER=simulation)
 */
function voiceProviderName(): "browser" | "simulation" {
  return (process.env.VOICE_PROVIDER ?? "").toLowerCase() === "simulation"
    ? "simulation"
    : "browser";
}

router.get("/api/health", ({ res }) => {
  sendJson(res, 200, {
    status: "ok",
    service: "creativeflow-api",
    mode: "simulation", // becomes "production" once real generation providers are wired in
    voice: voiceProviderName(),
    tts: ttsProviderName(),
    stt: sttProviderName(),
    copilot: copilotProviderName(),
    video: videoProviderName(),
    time: new Date().toISOString(),
  });
});

registerDemoRoutes(router, conversationService);
registerBriefRoutes(router, briefService, conversationService);
registerProductionRoutes(router, productionService, briefService);
registerCopilotRoutes(router, copilotProvider, conversationService);
registerTtsRoutes(router);
registerTranscribeRoutes(router);
registerVideoRoutes(router, videoService);

const server = createServer((req, res) => {
  void router.dispatch(req, res);
});

server.listen(PORT, () => {
  console.log(`CreativeFlow listening on http://localhost:${PORT}`);
  console.log(`Static root: ${STATIC_ROOT}`);
  console.log(
    `Providers — voice: ${voiceProviderName()} · tts: ${ttsProviderName()} · copilot: ${copilotProviderName()} · video: ${videoProviderName()}`,
  );
});
