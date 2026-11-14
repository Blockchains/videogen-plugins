import test from "node:test";
import assert from "node:assert/strict";
import {
  segmentScript,
  wrapCaptionLines,
  proportionalTimings,
  buildSrt,
  escapeFilterValue,
  formatSrtTime,
  CAPTION_MAX_LINE,
  CAPTION_MAX_LINES,
} from "../lib/captions.mjs";

test("segmentScript keeps short sentences whole and splits long ones at clauses", () => {
  const cues = segmentScript(
    "Staying hydrated keeps your body and mind running at their best. Drink a glass of water when you wake up, and keep a bottle nearby through the day.",
  );
  assert.deepEqual(
    cues.map((c) => c.text),
    [
      "Staying hydrated keeps your body and mind running at their best.",
      "Drink a glass of water when you wake up,",
      "and keep a bottle nearby through the day.",
    ],
  );
  for (const c of cues) {
    assert.ok(c.lines.length <= 3);
    for (const l of c.lines) assert.ok(l.length <= CAPTION_MAX_LINE, `line too long: ${l}`);
  }
});

test("segmentScript handles a single very long clause by word wrapping", () => {
  const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
  const cues = segmentScript(words);
  assert.ok(cues.length >= 3);
  const max = CAPTION_MAX_LINE * CAPTION_MAX_LINES;
  for (const c of cues) assert.ok(c.text.length <= max);
  assert.equal(cues.map((c) => c.text).join(" "), words);
});

test("segmentScript returns [] for empty input and collapses whitespace", () => {
  assert.deepEqual(segmentScript("   "), []);
  assert.equal(segmentScript("a   b\n\nc.")[0].text, "a b c.");
});

test("wrapCaptionLines never exceeds the max length when a single word fits", () => {
  const lines = wrapCaptionLines("one two three four five six seven eight nine ten eleven", 12);
  for (const l of lines) assert.ok(l.length <= 12);
  assert.equal(lines.join(" "), "one two three four five six seven eight nine ten eleven");
});

test("proportionalTimings covers the usable window in order", () => {
  const cues = segmentScript("Short. A considerably longer sentence with many more characters in it.");
  const timed = proportionalTimings(cues, 10, { leadIn: 0.2, tail: 0.3 });
  assert.equal(timed[0].start, 0.2);
  assert.ok(Math.abs(timed[timed.length - 1].end - 9.7) < 1e-9);
  assert.ok(timed[1].end - timed[1].start > timed[0].end - timed[0].start);
  for (let i = 1; i < timed.length; i++) assert.ok(timed[i].start >= timed[i - 1].end - 1e-9);
});

test("buildSrt emits numbered cues with SRT timestamps", () => {
  const srt = buildSrt([
    { lines: ["Hello", "world"], start: 0.2, end: 1.5 },
    { lines: ["Bye"], start: 1.5, end: 3661.25 },
  ]);
  assert.equal(
    srt,
    "1\n00:00:00,200 --> 00:00:01,500\nHello\nworld\n\n2\n00:00:01,500 --> 01:01:01,250\nBye\n",
  );
});

test("formatSrtTime clamps negatives and milliseconds", () => {
  assert.equal(formatSrtTime(-1), "00:00:00,000");
  assert.equal(formatSrtTime(0.9999), "00:00:00,999");
});

test("escapeFilterValue applies both ffmpeg escaping levels", () => {
  assert.equal(escapeFilterValue("/tmp/a.txt"), "/tmp/a.txt");
  assert.equal(escapeFilterValue("C:/f.ttf"), "C\\\\:/f.ttf");
  assert.equal(escapeFilterValue("it's"), "it\\\\\\'s");
  assert.equal(escapeFilterValue("a,b;c[d]"), "a\\,b\\;c\\[d\\]");
});
