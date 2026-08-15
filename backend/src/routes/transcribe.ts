import type { IncomingMessage } from "node:http";
import type { Router } from "../lib/router.ts";
import { sendJson } from "../lib/router.ts";

/**
 * POST /api/voice/transcribe — server-side speech-to-text.
 *
 * The browser records microphone audio with MediaRecorder and uploads it as
 * multipart/form-data; the server forwards it to Groq's OpenAI-compatible
 * Whisper transcription endpoint and returns ONLY the transcript:
 *
 *   multipart (field "audio", a WebM/Opus blob)  →  { "text": "..." }
 *
 * This replaced Chrome's Web Speech API SpeechRecognition as the primary STT
 * path: Chrome's external recognition service failed in production with
 * "recognition error: network" even though the microphone itself worked.
 *
 * GROQ_API_KEY lives exclusively in server environment variables and is
 * NEVER exposed to the browser (no keys in responses, no raw provider
 * bodies, no key logging). Raw audio is processed in memory only — nothing
 * is written to disk and nothing is logged beyond byte counts/status codes.
 *
 * Environment:
 *   GROQ_API_KEY    — required; endpoint returns 503 until configured.
 *   GROQ_STT_MODEL  — optional; defaults to whisper-large-v3-turbo (Groq's
 *                     currently supported fast Whisper transcription model).
 *   GROQ_STT_URL    — optional endpoint override (used by tests to mock).
 */

const MAX_AUDIO_BYTES = 12 * 1024 * 1024; // ~12 MB ≫ 60 s of Opus speech
const STT_TIMEOUT_MS = 45_000;
const DEFAULT_STT_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const DEFAULT_STT_MODEL = "whisper-large-v3-turbo";

export function sttProviderName(): "groq" | "none" {
  return process.env.GROQ_API_KEY ? "groq" : "none";
}

/** Read the raw request body, aborting when it exceeds the size cap. */
async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) {
      req.destroy();
      return null;
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

interface AudioPart {
  filename: string;
  type: string;
  data: Buffer;
}

/**
 * Minimal dependency-free multipart/form-data parser — extracts the first
 * file part (or a part named "audio"). Returns null when the payload is not
 * valid multipart or contains no file part.
 */
export function extractAudioPart(raw: Buffer, contentType: string): AudioPart | null {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) return null;
  const boundary = Buffer.from(`--${(m[1] ?? m[2]).trim()}`);
  let cursor = raw.indexOf(boundary);
  while (cursor !== -1) {
    const headStart = cursor + boundary.length;
    if (raw.subarray(headStart, headStart + 2).toString("latin1") === "--") break; // closing marker
    const headerEnd = raw.indexOf("\r\n\r\n", headStart);
    if (headerEnd === -1) break;
    const headers = raw.subarray(headStart, headerEnd).toString("utf8");
    const next = raw.indexOf(boundary, headerEnd + 4);
    if (next === -1) break;
    const data = raw.subarray(headerEnd + 4, next - 2); // strip trailing \r\n
    const fileM = /filename="([^"]*)"/i.exec(headers);
    const nameM = /name="([^"]*)"/i.exec(headers);
    if (fileM || nameM?.[1] === "audio") {
      const typeM = /content-type:\s*([^\r\n;]+)/i.exec(headers);
      return {
        filename: fileM?.[1] || "audio.webm",
        type: (typeM?.[1] ?? "application/octet-stream").trim(),
        data: Buffer.from(data),
      };
    }
    cursor = next;
  }
  return null;
}

export function registerTranscribeRoutes(router: Router): void {
  router.post("/api/voice/transcribe", async ({ req, res }) => {
    if (!process.env.GROQ_API_KEY) {
      return sendJson(res, 503, { error: "stt_not_configured" });
    }

    const contentType = String(req.headers["content-type"] ?? "");
    if (!contentType.toLowerCase().startsWith("multipart/")) {
      return sendJson(res, 400, { error: "audio_required" });
    }

    const raw = await readRawBody(req, MAX_AUDIO_BYTES);
    if (raw === null) return sendJson(res, 413, { error: "audio_too_large" });

    const part = extractAudioPart(raw, contentType);
    if (!part) return sendJson(res, 400, { error: "audio_required" });
    if (!part.data.length) return sendJson(res, 400, { error: "audio_empty" });

    // Log byte count + status only — NEVER raw audio, NEVER the API key.
    console.log(`stt transcribe: received ${part.data.length} bytes (${part.type})`);

    const form = new FormData();
    form.append("file", new Blob([part.data], { type: part.type }), part.filename);
    form.append("model", process.env.GROQ_STT_MODEL ?? DEFAULT_STT_MODEL);
    form.append("response_format", "json");
    form.append("language", "en");

    let upstream: Response;
    try {
      upstream = await fetch(process.env.GROQ_STT_URL ?? DEFAULT_STT_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}` },
        body: form,
        signal: AbortSignal.timeout(STT_TIMEOUT_MS),
      });
    } catch {
      console.error("stt transcribe: provider unreachable");
      return sendJson(res, 502, { error: "transcription_unavailable" });
    }

    if (upstream.status >= 400 && upstream.status < 500) {
      // Provider rejected the audio/request — status only, never bodies that may echo keys.
      console.error(`stt transcribe: provider rejected audio (http ${upstream.status})`);
      return sendJson(res, 400, { error: "invalid_audio" });
    }
    if (!upstream.ok) {
      console.error(`stt transcribe: provider failure (http ${upstream.status})`);
      return sendJson(res, 502, { error: "transcription_failed" });
    }

    let text = "";
    try {
      const data = (await upstream.json()) as { text?: unknown };
      text = typeof data?.text === "string" ? data.text.trim() : "";
    } catch {
      return sendJson(res, 502, { error: "transcription_failed" });
    }

    // Return ONLY the transcript — no provider metadata, no credentials.
    return sendJson(res, 200, { text });
  });
}
