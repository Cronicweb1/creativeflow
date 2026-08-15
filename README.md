# CreativeFlow

AI creative client-to-production showcase. A visitor talks to an AI
Creative Director, a structured creative brief is built live, and — after
explicit confirmation — production is kicked off (currently simulated).

Zero runtime dependencies: plain Node (>= 22.18) runs the TypeScript
backend natively (type stripping), which serves both the API and the
vanilla-JS frontend. No build step.

## Layered architecture — one brain, free voice

```
CLIENT (browser)
  ├── microphone → Web Speech API SpeechRecognition   (STT — free, local)
  ├── POST /api/copilot/turn                          (transcript → backend)
  │        └── Render Node backend (bridge + session/state)
  │                 └── Activepieces /sync workflow → Groq   (the ONLY brain)
  ├── structured response {responseText, requirements, missing, complete, …}
  │        └── Live Creative Brief UI (authoritative state from the brain)
  └── window.speechSynthesis speaks responseText      (TTS — free, local)
           └── back to listening
```

- **Browser Web Speech API** — the entire voice layer. Free, native,
  no credits, no external voice provider. Browsers without
  SpeechRecognition automatically fall back to the typed text simulation.
- **Activepieces → Groq** — the single conversational intelligence,
  reached synchronously through `COPILOT_WORKFLOW_URL`.
- **Render Node backend** — secure bridge; owns sessions, state, and the
  creative brief. Credentials never reach the browser.
- **n8n / Composio → Gemini / Veo** — downstream production (still
  simulated; interface prepared).

> The former **ElevenLabs Conversational AI agent is retired** — it
> consumed credits too quickly. Its token route is no longer registered
> (`/api/elevenlabs/token` → 404) and no agent session is ever created.
> `backend/src/routes/elevenlabs.ts` is kept only as unregistered,
> isolated dead code.

## Run it

```bash
node backend/src/server.ts
# → http://localhost:3000
```

Tests: `npm test` (node --test, boots the real server).

## Provider mode matrix

| VOICE_PROVIDER | COPILOT_PROVIDER | Result |
| --- | --- | --- |
| `browser` (default) | `mock` | Free spoken demo, deterministic local brain |
| `browser` (default) | `live` | Free spoken demo, Activepieces/Groq brain |
| `simulation` | `mock` | Typed demo, fully offline |
| `simulation` | `live` | Typed demo, Activepieces/Groq brain |

Voice never consumes credits in any combination.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port (Render sets it) |
| `VOICE_PROVIDER` | `browser` (default) or `simulation` |
| `COPILOT_PROVIDER` | `mock` (default) or `live` |
| `COPILOT_WORKFLOW_URL` | Activepieces `/sync` webhook URL (live brain) |
| `COPILOT_AUTH_TOKEN` | Optional `Authorization: Bearer` for the workflow |
| `COPILOT_LLM_API_KEY` | Optional secret for the OpenAI-compatible endpoint |
| `GEMINI_API_KEY`, `COMPOSIO_API_KEY` | Future production pipeline (still mocked) |
| ~~`ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`~~ | Retired — unused, safe to delete |

## Workflow contract (live brain)

`POST $COPILOT_WORKFLOW_URL` receives:

```json
{
  "sessionId": "…",
  "userMessage": "We're launching a premium skincare serum.",
  "conversationState": { "client": null, "product": null, "campaign": null,
    "platform": null, "contentType": null, "visualStyle": null,
    "audience": null, "duration": null, "aspectRatio": null }
}
```

and must synchronously return:

```json
{
  "responseText": "Which platform is the campaign for?",
  "requirements": { "product": "Premium skincare serum" },
  "missing": ["platform", "audience", "duration"],
  "complete": false,
  "readyForProduction": false,
  "productionBrief": null
}
```

`readyForProduction` may only become `true` after the client explicitly
confirms the summarized brief — never automatically.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/health` | status + active providers (`voice`, `copilot`) |
| `POST /api/demo/session` | create the demo session (real session ids) |
| `POST /api/copilot/turn` | one conversational turn `{sessionId, userMessage}` |
| `GET /api/copilot/state/:sessionId` | authoritative brief/requirement state |
| `POST /api/copilot/llm/v1/chat/completions` | OpenAI-compatible SSE bridge (optional) |
| `POST /api/brief/build` · `/confirm` · `/reopen` | brief lifecycle |
| `POST /api/production/start` · `GET /api/production/:id` | simulated production |

## Layout

```
backend/src/{routes,services,types,mock,lib}   dependency-free TS backend
backend/test/                                  node --test e2e + voice tests
frontend/public/{js,styles}                    vanilla JS modules, no build
render.yaml                                    single Render web service
```

## What is intentionally not connected yet

Real video generation (Composio → Gemini/Veo). The production pipeline is
simulated end-to-end; `buildProductionPayload()` already emits the
structured JSON brief the downstream workflow will consume.
