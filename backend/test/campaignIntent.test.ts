/**
 * Regression tests — "ad campaign for X" phrasing.
 *
 * Bug: "Create an ad campaign for remote control car and don't ask any more
 * questions" extracted NO product (pattern required "ad for X"), the brief
 * fell back to "the featured product", and Veo generated an unrelated ad.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  detectForceGenerate,
  extractProductService,
  extractContentType,
  buildForcedBrief,
} from "../src/services/forceGenerate.ts";
import { buildVideoPrompt } from "../src/services/videoService.ts";

test("campaign RC1: 'ad campaign for remote control car' extracts the product", () => {
  assert.equal(
    extractProductService("Create an ad campaign for remote control car and don't ask any more questions."),
    "remote control car",
  );
  assert.equal(
    extractProductService("I want an ad campaign for a remote control car."),
    "remote control car",
  );
  assert.equal(
    extractProductService("make an ad campaign for my remote control car"),
    "remote control car",
  );
  assert.equal(
    extractProductService("create a remote control car ad campaign"),
    "remote control car",
  );
});

test("campaign RC2: bare 'campaign for X' phrasings extract the product", () => {
  assert.equal(extractProductService("I need a video campaign for my bakery. Just generate it."), "bakery");
  assert.equal(extractProductService("Run a marketing campaign for my bakery"), "bakery");
  assert.equal(extractProductService("campaign for coffee subscription"), "coffee subscription");
});

test("campaign RC3: forced brief keeps the real product, never the placeholder", () => {
  const forced = buildForcedBrief(
    "s1",
    [],
    "Create an ad campaign for a remote control car and don't ask any more questions.",
  ) as any;
  assert.equal(forced.brief.product, "remote control car");
  assert.match(forced.brief.contentType, /advertisement/);
  assert.equal(forced.brief.brandName, null);
  assert.ok(!JSON.stringify(forced).includes("the featured product"));
});

test("campaign RC4: Veo prompt contains 'remote control car' as hero subject", () => {
  const forced = buildForcedBrief(
    "s1",
    [],
    "Create an ad campaign for a remote control car and don't ask any more questions.",
  );
  const prompt = buildVideoPrompt(forced);
  assert.match(prompt, /remote control car/);
  assert.match(prompt, /hero subject/);
  assert.ok(!prompt.includes("the featured product"));
});

test("campaign RC5: contentType inferred from campaign wording", () => {
  assert.equal(extractContentType("Create an ad campaign for remote control car"), "video advertisement");
  assert.equal(extractContentType("campaign for my bakery"), "video advertisement");
});

test("campaign RC6: campaign mention alone never triggers force generation", () => {
  assert.equal(detectForceGenerate("I want an ad campaign for a remote control car"), false);
  assert.equal(detectForceGenerate("The campaign is about creating awareness"), false);
});

test("campaign RC7: existing extraction phrasings still work (regression)", () => {
  assert.equal(
    extractProductService("Create a makeup kit ad and don't ask any more questions."),
    "makeup kit",
  );
  assert.equal(
    extractProductService("Make an Instagram ad for my premium skincare serum. Don't ask anything else."),
    "premium skincare serum",
  );
  assert.equal(
    extractProductService("Create a coffee subscription commercial. Just generate it."),
    "coffee subscription",
  );
  assert.equal(extractProductService("Make an Instagram ad"), null);
});
