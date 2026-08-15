/**
 * Browser STT unit tests (node --test) — run the REAL BrowserVoiceInput class
 * against a fake window/SpeechRecognition to verify the voice-input pipeline:
 *
 *   1. Support detection (browser-dependent, secure-context aware).
 *   2. Recognition config: lang forced to en-US (root-cause fix), continuous
 *      false, interimResults true, maxAlternatives 1.
 *   3. Interim vs final transcripts — only the FINAL transcript is submitted.
 *   4. Empty transcript → nothing submitted.
 *   5. Duplicate-submission prevention (one utterance → one onTranscript).
 *   6. Start-race guard: no second recognizer before onstart fires.
 *   7. Error mapping: not-allowed/service-not-allowed/audio-capture/network/
 *      language-not-supported → denied/audio/network/language.
 *   8. Unsupported browser → "unsupported" error, typed input still works.
 *   9. TTS (speechSynthesis fallback) works independently of STT.
 *  10. Diagnostic surface window.__creativeFlowVoiceDebug carries no secrets.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  lang = ""; continuous = true; interimResults = false; maxAlternatives = 0;
  onstart: any; onresult: any; onend: any; onerror: any;
  onaudiostart: any; onspeechstart: any; onspeechend: any; onaudioend: any;
  started = false;
  constructor() { FakeRecognition.instances.push(this); }
  start() { this.started = true; } // onstart fired manually by each test
  stop() { this.onend?.(); }
  abort() { this.onend?.(); }
  emitResult(items: Array<{ text: string; final: boolean }>) {
    this.onresult?.({
      resultIndex: 0,
      results: items.map((i) => Object.assign([{ transcript: i.text }], { isFinal: i.final })),
    });
  }
}

function freshWindow() {
  FakeRecognition.instances = [];
  const w: any = {
    location: { search: "" },
    localStorage: { getItem: () => null },
    isSecureContext: true,
    SpeechRecognition: FakeRecognition,
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
      language: "hi-IN", // deliberately NOT en-US — recognition must still use en-US
      userAgent: "Mozilla/5.0 Chrome/126.0 Safari/537.36",
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
      permissions: { query: async () => ({ state: "granted" }) },
    },
  });
  (globalThis as any).SpeechSynthesisUtterance = class {
    text: string; lang = ""; rate = 0; pitch = 0; voice: any; onend: any; onerror: any;
    constructor(t: string) { this.text = t; }
  };
  return w;
}

const w = freshWindow();
const { BrowserVoiceInput, browserName } = await import("../../frontend/public/js/voice.js");

test("support detection — browser-dependent and secure-context aware", () => {
  freshWindow();
  assert.equal(BrowserVoiceInput.isSupported(), true);
  (globalThis as any).window.SpeechRecognition = undefined; // Firefox-like
  assert.equal(BrowserVoiceInput.isSupported(), false);
  freshWindow();
  (globalThis as any).window.isSecureContext = false; // plain HTTP
  assert.equal(BrowserVoiceInput.isSupported(), false);
  freshWindow();
  assert.equal(browserName(), "chrome");
});

test("recognition config — lang FORCED to en-US even on a hi-IN browser", () => {
  freshWindow();
  const v = new BrowserVoiceInput();
  v.startListening();
  const rec = FakeRecognition.instances[0];
  assert.ok(rec, "a recognizer must be created");
  assert.equal(rec.lang, "en-US"); // THE root-cause fix
  assert.equal(rec.continuous, false);
  assert.equal(rec.interimResults, true);
  assert.equal(rec.maxAlternatives, 1);
  rec.onstart(); v.stopListening();
});

test("interim shown, only FINAL transcript submitted — exactly once", () => {
  freshWindow();
  const v = new BrowserVoiceInput();
  const finals: string[] = []; const interims: string[] = [];
  v.onTranscript = (t: string) => finals.push(t);
  v.onInterim = (t: string) => { if (t) interims.push(t); };
  v.startListening();
  const rec = FakeRecognition.instances[0];
  rec.onstart();
  rec.emitResult([{ text: "I want a cinematic", final: false }]);
  rec.emitResult([{ text: "I want a cinematic Instagram advertisement.", final: true }]);
  assert.deepEqual(finals, [], "final must not submit before recognition ends");
  v.muted = true; // block the bounded silence-restart timer in this test
  rec.onend();
  rec.onend(); // duplicate end event → guard must prevent a second submission
  assert.deepEqual(finals, ["I want a cinematic Instagram advertisement."]);
  assert.ok(interims.includes("I want a cinematic"));
});

test("empty transcript → nothing submitted", () => {
  freshWindow();
  const v = new BrowserVoiceInput();
  let calls = 0;
  v.onTranscript = () => { calls += 1; };
  v.startListening();
  const rec = FakeRecognition.instances[0];
  rec.onstart();
  rec.emitResult([{ text: "   ", final: true }]); // whitespace-only
  v.muted = true;
  rec.onend();
  assert.equal(calls, 0);
});

test("start-race guard — no orphaned second recognizer before onstart", () => {
  freshWindow();
  const v = new BrowserVoiceInput();
  v.startListening();
  v.startListening(); // window between start() and onstart — used to fork
  v.startListening();
  assert.equal(FakeRecognition.instances.length, 1);
  const rec = FakeRecognition.instances[0];
  rec.onstart();
  v.startListening(); // while listening — still no second instance
  assert.equal(FakeRecognition.instances.length, 1);
  v.stopListening();
});

test("recognition error mapping", () => {
  const cases: Array<[string, string]> = [
    ["not-allowed", "denied"],
    ["service-not-allowed", "denied"],
    ["audio-capture", "audio"],
    ["network", "network"],
    ["language-not-supported", "language"],
  ];
  for (const [raw, mapped] of cases) {
    freshWindow();
    const v = new BrowserVoiceInput();
    const errors: string[] = [];
    v.onError = (r: string) => errors.push(r);
    v.startListening();
    const rec = FakeRecognition.instances[0];
    rec.onstart();
    rec.onerror({ error: raw });
    v.muted = true;
    rec.onend();
    assert.deepEqual(errors, [mapped], `${raw} must map to ${mapped}`);
  }
});

test("unsupported browser → 'unsupported' error, typed input still works", () => {
  freshWindow();
  (globalThis as any).window.SpeechRecognition = undefined;
  const v = new BrowserVoiceInput();
  const errors: string[] = []; const finals: string[] = [];
  v.onError = (r: string) => errors.push(r);
  v.onTranscript = (t: string) => finals.push(t);
  v.startListening();
  assert.deepEqual(errors, ["unsupported"]);
  v.submitUtterance("typed fallback message"); // typed path must keep working
  assert.deepEqual(finals, ["typed fallback message"]);
});

test("TTS fallback works independently of STT", async () => {
  freshWindow();
  const origFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = async () => ({ status: 503, ok: false }); // server TTS unconfigured
  try {
    const v = new BrowserVoiceInput();
    const speakingStates: boolean[] = [];
    v.onSpeakingStateChange = (s: boolean) => speakingStates.push(s);
    await v.speak("Hello there."); // resolves via speechSynthesis fallback
    assert.deepEqual(speakingStates, [true, false]);
    assert.equal(v.isSpeaking(), false);
  } finally {
    (globalThis as any).fetch = origFetch;
  }
});

test("diagnostic surface exists and carries no secrets", () => {
  freshWindow();
  const v = new BrowserVoiceInput();
  BrowserVoiceInput.isSupported();
  v.startListening();
  const rec = FakeRecognition.instances[0];
  rec.onstart();
  rec.emitResult([{ text: "hello can you hear me", final: true }]);
  v.muted = true;
  rec.onend();
  const dbg = (globalThis as any).window.__creativeFlowVoiceDebug;
  assert.ok(dbg, "window.__creativeFlowVoiceDebug must exist");
  assert.equal(dbg.supported, true);
  assert.equal(dbg.lastFinalTranscript, "hello can you hear me");
  const dump = JSON.stringify(dbg);
  assert.ok(!/sk_[a-z0-9]/i.test(dump) && !/ck_[a-z0-9]/i.test(dump), "no keys in debug surface");
});
