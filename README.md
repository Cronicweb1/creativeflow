# CreativeFlow

**AI Creative Client-to-Production Showcase**

An interactive portfolio showcase of an AI creative agency workflow:

```
Client conversation → requirement understanding → creative brief → AI production → final video
```

The client conversation is a **real browser voice call**: the visitor speaks through their
microphone to an **ElevenLabs Agents** voice agent (WebRTC) and hears it answer. The structured
workflow — requirement extraction, live creative brief, brief confirmation and the production
pipeline — runs on the CreativeFlow backend. Gemini/Veo generation and Composio/MCP tooling still
plug in later as service-level replacements.

## Run it

Requires **Node ≥ 22.18** (native TypeScript type stripping — no build step, no dependencies).

```bash
node backend/src/server.ts
# → http://localhost:3000
```

Dev mode with reload: `npm run dev` · Type-check (needs dev deps): `npm run typecheck` · API tests: `npm test`

For the live voice call, export `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID` before starting
(see `.env.example`). Without them the app runs, but starting a call reports that the voice agent
is not configured.

## ElevenLabs voice agent

The call phase uses ElevenLabs Agents over WebRTC:

1. The browser asks for microphone permission.
2. The frontend requests a **short-lived conversation token** from `GET /api/elevenlabs/token`.
   The backend mints it with the server-side `ELEVENLABS_API_KEY` — **the API key never reaches
   the browser.**
3. The official `@elevenlabs/client` SDK (loaded as an ES module) opens the WebRTC session:
   microphone audio streams to the agent, the agent's voice plays back, and transcript events
   flow both ways.
4. Every final visitor transcript is forwarded to the existing `POST /api/demo/message` endpoint,
   so requirement extraction and the live creative brief stay synchronized with the spoken
   conversation. The ElevenLabs agent is the *only* voice — CreativeFlow never generates a second
   spoken response.

### Environment variables (required for voice)

Add both in **Render Dashboard → creativeflow → Environment → Add Environment Variable**:

| Variable | Purpose |
| --- | --- |
| `ELEVENLABS_API_KEY` | Secret ElevenLabs API key. Server-only — never committed, never sent to the browser. |
| `ELEVENLABS_AGENT_ID` | The agent id of your ElevenLabs Agents agent. Kept server-side. |

Do **not** put real values in `.env.example`, `render.yaml`, or anywhere else in Git.

### Recommended agent configuration (in the ElevenLabs dashboard)

Configure the agent as a **Creative Director / creative intake agent** for CreativeFlow. It should
sound like a real agency account manager: professional, natural, one question at a time, with
follow-ups when an answer is vague. Suggested first message:

> "Hi, I'm the CreativeFlow creative director. I'll quickly understand what you're looking to
> create and then turn our conversation into a production-ready brief. What are we creating today?"

Suggested system-prompt goals — collect, conversationally, one at a time:
client/company · product/service · campaign · platform · target audience · duration ·
aspect ratio · creative direction · mood · visual style · lighting · environment ·
camera direction · color palette · motion · things to avoid.

## Deploy (Render)

The repo ships a `render.yaml` blueprint: one web service, no build step, health check on
`/api/health`. Connect the repo in Render → *New → Blueprint* and deploy. All provider keys
(`ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, `GEMINI_API_KEY`, `COMPOSIO_API_KEY`) are
dashboard-managed secrets and never reach the browser.

If you ever split the frontend into a separate static site, create `frontend/public/js/config.js`:

```js
window.CREATIVEFLOW_API_URL = "https://your-backend.onrender.com";
```

`js/api.js` picks it up automatically; same-origin is the default.

## Architecture

```
Browser microphone
      ↓
ElevenLabs Agent (WebRTC)   BrowserVoiceInput     (frontend/public/js/voice.js)
      ↓  transcripts
AI Creative Agent           ConversationService   (structured workflow engine)
      ↓
Requirement Extraction      typed CreativeRequirement{field,value,status,confidence,source}
      ↓
Creative Brief              BriefService          (mock: rule-derived direction)
      ↓
Tool / MCP Layer            (interface reserved — Composio/MCP later)
      ↓
Image + Video Generation    ProductionService     (mock: deterministic stage clock)
      ↓
Quality Review → Final Asset
```

The ElevenLabs agent owns the *natural voice conversation*; CreativeFlow owns the *application
workflow and state*. There is exactly one AI voice — the backend conversation engine is used for
requirement extraction, not for generating competing spoken replies.

### Replaceable services

| Today | Later (production) | Contract |
| --- | --- | --- |
| `MockConversationService` (extraction) | LLM-backed extraction | `ConversationService` in `services/conversationService.ts` |
| `MockBriefService` | LLM-backed brief builder | `BriefService` in `services/briefService.ts` |
| `MockProductionService` | `GeminiVeoProductionService` | `ProductionService` in `services/productionService.ts` |
| `BrowserVoiceInput` (ElevenLabs WebRTC — **live**) | — | `frontend/public/js/voice.js` |

The final video player already handles both worlds: if `GeneratedAsset.url` is set it renders a
`<video>`; while mocked (`url: null`) it falls back to a canvas-rendered simulated preview matching
the confirmed creative direction.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/demo/session` | Start a call session |
| `GET` | `/api/demo/session/:id` | Fetch session state |
| `POST` | `/api/demo/message` | Send one client utterance (voice transcript or typed) |
| `GET` | `/api/elevenlabs/token` | Mint a short-lived ElevenLabs conversation token (key stays server-side) |
| `POST` | `/api/brief/build` | Build a brief from a completed conversation |
| `POST` | `/api/brief/confirm` | Client approves the brief |
| `POST` | `/api/brief/reopen` | Client wants changes; conversation reopens |
| `GET` | `/api/brief/:id` | Fetch a brief |
| `POST` | `/api/production/start` | Start production for a confirmed brief |
| `GET` | `/api/production/:id` | Poll job state (stages, assets, summary) |
| `GET` | `/api/health` | Service health + mode + voice configuration |

## Layout

```
backend/
  src/
    routes/        demo.ts · brief.ts · production.ts · elevenlabs.ts
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

Gemini · Veo · Composio · n8n · Copilot Studio · MCP servers.

Each has a reserved seam (service interface, env var, or frontend adapter). The live voice
conversation (ElevenLabs Agents) is connected; the remaining integrations land one by one.
