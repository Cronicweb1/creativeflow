import type { Router } from "../lib/router.ts";
import { sendJson } from "../lib/router.ts";

/**
 * POST /api/tts — natural text-to-speech, server-side.
 *
 * The browser sends ONLY plain response text and receives audio back:
 *
 *   { "text": "responseText" }  →  audio/mpeg
 *
 * Provider API keys live exclusively in server environment variables and
 * are NEVER exposed to the browser (no tokens, no signed URLs, no keys in
 * responses). When no provider is configured the endpoint returns 503 and
 * the frontend falls back to window.speechSynthesis.
 *
 * Providers (TTS_PROVIDER, auto-detected when unset):
 *
 *   "elevenlabs"  — the plain ElevenLabs text-to-speech HTTP endpoint.
 *                   This is NOT the retired Conversational AI agent: no
 *                   agent session, no conversation token, no WebRTC, no
 *                   agent LLM — one stateless speech-synthesis request per
 *                   reply. Uses ELEVENLABS_API_KEY (or TTS_API_KEY),
 *                   TTS_VOICE_ID (default: Rachel), TTS_MODEL
 *                   (default: eleven_flash_v2_5 — the cheapest tier).
 *
 *   "openai"      — any OpenAI-compatible /audio/speech endpoint
 *                   (OpenAI, Groq playai-tts, etc.). Uses TTS_API_KEY,
 *                   TTS_API_URL (base URL), TTS_MODEL, TTS_VOICE.
 *
 *   "browser"     — force-disable server TTS (endpoint returns 503).
 */

const MAX_TTS_CHARS = 600; // one conversational reply — never documents/JSON
const TTS_TIMEOUT_MS = 15_000;
const DEFAULT_ELEVENLABS_VOICE = "21m00Tcm4TlvDq8ikWAM"; // "Rachel" — natural conversational preset

export type TtsProvider = "elevenlabs" | "openai" | "browser";

export function ttsProviderName(): TtsProvider {
  const explicit = (process.env.TTS_PROVIDER ?? "").toLowerCase();
  if (explicit === "elevenlabs" || explicit === "openai" || explicit === "browser") {
    return explicit;
  }
  // Auto-detect from available server-side credentials.
  if (process.env.ELEVENLABS_API_KEY) return "elevenlabs";
  if (process.env.TTS_API_KEY && process.env.TTS_API_URL) return "openai";
  return "browser";
}

/** Strip Markdown/code fences server-side too — TTS speaks prose only. */
function toSpeakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TTS_CHARS);
}

async function synthesizeElevenLabs(text: string): Promise<Response> {
  const apiKey = process.env.ELEVENLABS_API_KEY ?? process.env.TTS_API_KEY ?? "";
  const voiceId = process.env.TTS_VOICE_ID ?? DEFAULT_ELEVENLABS_VOICE;
  const model = process.env.TTS_MODEL ?? "eleven_flash_v2_5";
  return fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.3 },
      }),
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    },
  );
}

async function synthesizeOpenAiCompatible(text: string): Promise<Response> {
  const base = (process.env.TTS_API_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  return fetch(`${base}/audio/speech`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.TTS_API_KEY ?? ""}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.TTS_MODEL ?? "gpt-4o-mini-tts",
      voice: process.env.TTS_VOICE ?? "alloy",
      input: text,
      response_format: "mp3",
    }),
    signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
  });
}

export function registerTtsRoutes(router: Router): void {
  router.post("/api/tts", async ({ res, body }) => {
    const provider = ttsProviderName();
    if (provider === "browser") {
      return sendJson(res, 503, { error: "tts_not_configured" });
    }

    const raw = (body as { text?: unknown })?.text;
    if (typeof raw !== "string" || !raw.trim()) {
      return sendJson(res, 400, { error: "text_required" });
    }
    const text = toSpeakable(raw);
    if (!text) return sendJson(res, 400, { error: "text_required" });

    let upstream: Response;
    try {
      upstream =
        provider === "elevenlabs"
          ? await synthesizeElevenLabs(text)
          : await synthesizeOpenAiCompatible(text);
    } catch {
      return sendJson(res, 502, { error: "tts_unreachable" });
    }

    if (!upstream.ok) {
      // Log status only — never keys, never upstream bodies that may echo them.
      console.error(`tts synthesis failed: provider=${provider} http ${upstream.status}`);
      return sendJson(res, 502, { error: "tts_failed" });
    }

    const audio = Buffer.from(await upstream.arrayBuffer());
    if (!audio.length) return sendJson(res, 502, { error: "tts_failed" });

    res.writeHead(200, {
      "content-type": upstream.headers.get("content-type") ?? "audio/mpeg",
      "content-length": audio.length,
      "cache-control": "no-store",
    });
    res.end(audio);
  });
}
