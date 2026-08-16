/**
 * RecordedVoiceInput unit tests (node --test) — run the REAL recorder class
 * against a fake window/MediaRecorder/fetch to verify the primary STT path:
 *
 *   mic → MediaRecorder → multipart POST /api/voice/transcribe → transcript
 *   → onTranscript (exactly once) → existing copilot turn
 *
 *   1. Support detection (MediaRecorder + getUserMedia + secure context).
 *   2. Recorder MIME feature detection with fallback.
 *   3. Record → finish → multipart upload (FormData, browser-set boundary).
 *   4. Transcript delivered to onTranscript EXACTLY once.
 *   5. Empty transcript → "silence", nothing submitted.
 *   6. Transcription provider failure → mapped error, nothing submitted.
 *   7. Cancel (stopListening) → NO upload, nothing submitted.
 *   8. Tiny/silent blob → "silence", NO upload.
 *   9. Max-duration + duplicate-upload guards exist.
 *  10. TTS stays browser speechSynthesis (no /api/tts request).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

class FakeMediaRecorder {
  static supported = ["audio/webm;codecs=opus", "audio/webm"];
  static last: FakeMediaRecorder | null = null;
  static nextBlobBytes = 5000;
  state = "inactive";
  mimeType: string;
  stream: any;
  ondataavailable: any; onstart: any; onstop: any; onerror: any;
  static isTypeSupported(t: string) { return FakeMediaRecorder.supported.includes(t); }
  constructor(stream: any, opts?: any) {
    this.stream = stream;
    this.mimeType = opts?.mimeType ?? "audio/webm";
    FakeMediaRecorder.last = this;
  }
  start() { this.state = "recording"; queueMicrotask(() => this.onstart?.()); }
  stop() {
    this.state = "inactive";
    queueMicrotask(() => {
      const size = FakeMediaRecorder.nextBlobBytes;
      if (size > 0) {
        this.ondataavailable?.({ data: new Blob([new Uint8Array(size)], { type: this.mimeType }) });
      }
      this.onstop?.();
    });
  }
}

const fetchCalls: { url: string; opts: any }[] = [];
let fetchResponder: () => Response = () => new Response(JSON.stringify({ text: "hello" }), { status: 200 });

function freshWindow() {
  FakeMediaRecorder.last = null;
  FakeMediaRecorder.nextBlobBytes = 5000;
  fetchCalls.length = 0;
  fetchResponder = () => new Response(JSON.stringify({ text: "hello" }), { status: 200 });
  const w: any = {
    location: { search: "" },
    localStorage: { getItem: () => null },
    isSecureContext: true,
    MediaRecorder: FakeMediaRecorder,
    speechSynthesis: {
      addEventListener: () => {},
      cancel: () => {},
      resume: () => {},
      getVoices: () => [],
      speak: (u: any) => setTimeout(() => u.onend?.(), 5),
    },
  };
  (globalThis as any).window = w;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      language: "hi-IN",
      userAgent: "Mozilla/5.0 Chrome/126.0 Safari/537.36",
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => {} }] }) },
      permissions: { query: async () => ({ state: "granted" }) },
    },
  });
  (globalThis as any).SpeechSynthesisUtterance = class {
    text: string; lang = ""; rate = 0; pitch = 0; voice: any; onend: any; onerror: any;
    constructor(t: string) { this.text = t; }
  };
  (globalThis as any).fetch = async (url: string, opts: any) => {
    fetchCalls.push({ url, opts });
    return fetchResponder();
  };
  return w;
}

const w = freshWindow();
const { RecordedVoiceInput, pickRecorderMime } = await import("../../frontend/public/js/voice.js");

const tick = () => new Promise((r) => setTimeout(r, 20));

function makeRecorder() {
  const events: string[] = [];
  const v = new RecordedVoiceInput();
  const out = { v, events, transcripts: [] as string[], errors: [] as string[], listening: [] as boolean[], transcribing: [] as boolean[] };
  v.onTranscript = (t: string) => { out.transcripts.push(t); events.push(`transcript:${t}`); };
  v.onError = (r: string) => { out.errors.push(r); events.push(`error:${r}`); };
  v.onListeningStateChange = (l: boolean) => { out.listening.push(l); events.push(`listening:${l}`); };
  v.onTranscribing = (b: boolean) => { out.transcribing.push(b); events.push(`transcribing:${b}`); };
  return out;
}

test("support detection — MediaRecorder + getUserMedia + secure context", () => {
  assert.equal(RecordedVoiceInput.isSupported(), true);
  const saved = w.MediaRecorder;
  delete w.MediaRecorder;
  assert.equal(RecordedVoiceInput.isSupported(), false, "no MediaRecorder → unsupported");
  w.MediaRecorder = saved;
  w.isSecureContext = false;
  assert.equal(RecordedVoiceInput.isSupported(), false, "insecure context → unsupported");
  w.isSecureContext = true;
});

test("recorder MIME is feature-detected with fallback", () => {
  assert.equal(pickRecorderMime(), "audio/webm;codecs=opus");
  FakeMediaRecorder.supported = ["audio/mp4"];
  assert.equal(pickRecorderMime(), "audio/mp4", "falls back to a supported type");
  FakeMediaRecorder.supported = [];
  assert.equal(pickRecorderMime(), "", "no known type → browser default");
  FakeMediaRecorder.supported = ["audio/webm;codecs=opus", "audio/webm"];
});

test("record → finish → ONE multipart upload → ONE transcript", async () => {
  freshWindow();
  fetchResponder = () => new Response(JSON.stringify({ text: "  I want a cinematic Instagram advertisement.  " }), { status: 200 });
  const r = makeRecorder();
  await r.v.startListening();
  await tick();
  assert.deepEqual(r.listening, [true], "Listening only after recorder onstart");
  assert.equal(r.v.listening, true);
  r.v.finishListening(); // mic tapped again
  await tick();
  await tick();
  assert.deepEqual(r.listening, [true, false]);
  assert.equal(fetchCalls.length, 1, "exactly one transcription upload");
  assert.equal(fetchCalls[0].url, "/api/voice/transcribe");
  assert.equal(fetchCalls[0].opts.method, "POST");
  assert.ok(fetchCalls[0].opts.body instanceof FormData, "multipart body via FormData");
  assert.equal(fetchCalls[0].opts.headers, undefined, "no manual Content-Type — browser sets the boundary");
  const file = fetchCalls[0].opts.body.get("audio") as File;
  assert.ok(file && file.size >= 5000, "recorded audio attached");
  assert.deepEqual(r.transcripts, ["I want a cinematic Instagram advertisement."], "trimmed transcript submitted EXACTLY once");
  assert.deepEqual(r.transcribing, [true, false], "Transcribing state toggles around the upload");
  assert.equal(r.errors.length, 0);
});

test("empty transcript → 'silence', nothing submitted", async () => {
  freshWindow();
  fetchResponder = () => new Response(JSON.stringify({ text: "   " }), { status: 200 });
  const r = makeRecorder();
  await r.v.startListening();
  await tick();
  r.v.finishListening();
  await tick(); await tick();
  assert.equal(fetchCalls.length, 1);
  assert.deepEqual(r.transcripts, [], "whitespace transcript rejected");
  assert.deepEqual(r.errors, ["silence"]);
});

test("provider failure → mapped error, nothing submitted", async () => {
  freshWindow();
  fetchResponder = () => new Response(JSON.stringify({ error: "transcription_failed" }), { status: 502 });
  const r = makeRecorder();
  await r.v.startListening();
  await tick();
  r.v.finishListening();
  await tick(); await tick();
  assert.deepEqual(r.transcripts, []);
  assert.deepEqual(r.errors, ["transcribe-unavailable"]);

  fetchResponder = () => new Response(JSON.stringify({ error: "invalid_audio" }), { status: 400 });
  const r2 = makeRecorder();
  await r2.v.startListening();
  await tick();
  r2.v.finishListening();
  await tick(); await tick();
  assert.deepEqual(r2.errors, ["transcribe-failed"]);
});

test("cancel (stopListening) → NO upload, nothing submitted", async () => {
  freshWindow();
  const r = makeRecorder();
  await r.v.startListening();
  await tick();
  r.v.stopListening(); // typed input / mute / close — discard the clip
  await tick(); await tick();
  assert.equal(fetchCalls.length, 0, "cancelled recordings are never uploaded");
  assert.deepEqual(r.transcripts, []);
  assert.deepEqual(r.listening, [true, false]);
});

test("tiny/silent blob → 'silence', NO upload", async () => {
  freshWindow();
  FakeMediaRecorder.nextBlobBytes = 100; // below MIN_BLOB_BYTES
  const r = makeRecorder();
  await r.v.startListening();
  await tick();
  r.v.finishListening();
  await tick(); await tick();
  assert.equal(fetchCalls.length, 0, "sub-minimum blobs never uploaded");
  assert.deepEqual(r.errors, ["silence"]);
});

test("guards — no double-start, duplicate-upload guard, max-duration cap", async () => {
  freshWindow();
  const r = makeRecorder();
  await r.v.startListening();
  await tick();
  const first = FakeMediaRecorder.last;
  await r.v.startListening(); // second start while recording — must be a no-op
  await tick();
  assert.equal(FakeMediaRecorder.last, first, "no second recorder while listening");
  assert.deepEqual(r.listening, [true]);
  assert.ok(r.v._maxTimer, "max-duration cap armed");
  r.v.finishListening();
  await tick(); await tick();
  assert.equal(fetchCalls.length, 1);
  assert.equal(r.transcripts.length, 1, "one recording → one transcript");
});

test("TTS stays browser speechSynthesis — no /api/tts request", async () => {
  const w2 = freshWindow();
  const r = makeRecorder();
  let spoke = false;
  const spoken: boolean[] = [];
  r.v.onSpeakingStateChange = (s: boolean) => spoken.push(s);
  w2.speechSynthesis.speak = (u: any) => { spoke = true; setTimeout(() => u.onend?.(), 5); };
  const okTts = await r.v.speak("Great choice! **bold** stays unspoken formatting.");
  assert.equal(okTts, true);
  assert.equal(spoke, true, "browser speechSynthesis used");
  assert.equal(fetchCalls.length, 0, "speak() must not call /api/tts");
  assert.deepEqual(spoken, [true, false]);
});
