# CreativeFlow

**AI Creative Client-to-Production Showcase**

An interactive portfolio showcase of an AI creative agency workflow:

```
Client conversation → requirement understanding → creative brief → AI production → final video
```

The current version runs entirely as a **browser simulation** with a real backend, real API contracts, real state management, and mocked engines. Voice telephony, Gemini/Veo generation, and Composio/MCP tooling plug in later as service-level replacements — nothing in the frontend or routes changes.

## Run it

Requires **Node ≥ 22.18** (native TypeScript type stripping — no build step, no dependencies).

```bash
node backend/src/server.ts
# → http://localhost:3000
```

Dev mode with reload: `npm run dev` · Type-check (needs dev deps): `npm run typecheck` · API tests: `npm test`

## Deploy (Render)

The repo ships a `render.yaml` blueprint: one web service, no build step, health check on `/api/health`. Connect the repo in Render → *New → Blueprint* and deploy. Provider API keys (`GEMINI_API_KEY`, `COMPOSIO_API_KEY`, `VOICE_AGENT_API_KEY`) are declared as dashboard-managed secrets and never reach the browser.

If you ever split the frontend into a separate static site, create `frontend/public/js/config.js`:

```js
window.CREATIVEFLOW_API_URL = "https://your-backend.onrender.com";
```

`js/api.js` picks it up automatically; same-origin is the default.

## Architecture

```
Browser / Phone
      ↓
AI Creative Agent          ConversationService   (mock: scripted call engine)
      ↓
Requirement Extraction     typed CreativeRequirement{field,value,status,confidence,source}
      ↓
Creative Brief             BriefService          (mock: rule-derived direction)
      ↓
Tool / MCP Layer           (interface reserved — Composio/MCP later)
      ↓
Image + Video Generation   ProductionService     (mock: deterministic stage clock)
      ↓
Quality Review → Final Asset
```

### Replaceable services

| Today (mock) | Later (production) | Contract |
| --- | --- | --- |
| `MockConversationService` | `VoiceAgentService` (Retell/Vapi/LiveKit) | `ConversationService` in `services/conversationService.ts` |
| `MockBriefService` | LLM-backed brief builder | `BriefService` in `services/briefService.ts` |
| `MockProductionService` | `GeminiVeoProductionService` | `ProductionService` in `services/productionService.ts` |
| `SimulatedVoiceInput` (browser) | `BrowserVoiceInput` (real capture + streaming) | `frontend/public/js/voice.js` |

The final video player already handles both worlds: if `GeneratedAsset.url` is set it renders a `<video>`; while mocked (`url: null`) it falls back to a canvas-rendered simulated preview matching the confirmed creative direction.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/demo/session` | Start a call session |
| `GET` | `/api/demo/session/:id` | Fetch session state |
| `POST` | `/api/demo/message` | Send one client utterance (typed or transcribed) |
| `POST` | `/api/brief/build` | Build a brief from a completed conversation |
| `POST` | `/api/brief/confirm` | Client approves the brief |
| `POST` | `/api/brief/reopen` | Client wants changes; conversation reopens |
| `GET` | `/api/brief/:id` | Fetch a brief |
| `POST` | `/api/production/start` | Start production for a confirmed brief |
| `GET` | `/api/production/:id` | Poll job state (stages, assets, summary) |
| `GET` | `/api/health` | Service health + mode |

## Layout

```
backend/
  src/
    routes/        demo.ts · brief.ts · production.ts
    services/      conversationService.ts · briefService.ts · productionService.ts
    types/         creative.ts · conversation.ts
    mock/          conversation.ts · production.ts   ← only the mock layer touches these
    lib/           router.ts (dependency-free HTTP router + static host)
    server.ts
  test/            api.test.ts (node --test, full journey)
frontend/
  public/
    index.html
    styles/main.css
    js/            app.js · demo.js · api.js · voice.js · preview.js
render.yaml
.env.example
```

## What is intentionally not connected yet

Retell · Vapi · Twilio · LiveKit · Gemini · Veo · Composio · n8n · Copilot Studio · MCP servers.

Each has a reserved seam (service interface, env var, or frontend adapter). The objective of this version is the complete showcase experience and mock workflow; integrations land one by one after the UX is approved.
