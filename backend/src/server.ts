import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Router, sendJson } from "./lib/router.ts";
import { registerDemoRoutes } from "./routes/demo.ts";
import { registerBriefRoutes } from "./routes/brief.ts";
import { registerProductionRoutes } from "./routes/production.ts";
import { conversationService } from "./services/conversationService.ts";
import { briefService } from "./services/briefService.ts";
import { productionService } from "./services/productionService.ts";

/**
 * CreativeFlow API + static host.
 *
 * Serves the frontend from /frontend/public and the API under /api/*.
 * Runs on plain Node (>= 22.18 / 24) with native TypeScript type
 * stripping — no build step, no runtime dependencies.
 *
 * Provider credentials (unused while services are mocked) come from the
 * environment and are never exposed to the browser:
 *   GEMINI_API_KEY, COMPOSIO_API_KEY, VOICE_AGENT_API_KEY
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = resolve(HERE, "../../frontend/public");
const PORT = Number(process.env.PORT ?? 3000);

const router = new Router(STATIC_ROOT);

router.get("/api/health", ({ res }) => {
  sendJson(res, 200, {
    status: "ok",
    service: "creativeflow-api",
    mode: "simulation", // becomes "production" once real providers are wired in
    time: new Date().toISOString(),
  });
});

registerDemoRoutes(router, conversationService);
registerBriefRoutes(router, briefService, conversationService);
registerProductionRoutes(router, productionService, briefService);

const server = createServer((req, res) => {
  void router.dispatch(req, res);
});

server.listen(PORT, () => {
  console.log(`CreativeFlow listening on http://localhost:${PORT}`);
  console.log(`Static root: ${STATIC_ROOT}`);
});
