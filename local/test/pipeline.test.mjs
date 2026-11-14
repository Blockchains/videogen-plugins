import test from "node:test";
import assert from "node:assert/strict";
import { __internals, QUALITY_PRESETS, RESOLUTIONS } from "../lib/pipeline.mjs";
import { installCommand, pickVideoEncoder, pickAudioEncoder } from "../lib/detect.mjs";

const { buildVideoGraph, buildAudioGraph, captionFilters, musicInputs, resolveResolution } = __internals;

test("resolveResolution accepts presets and even-rounds custom sizes", () => {
  assert.deepEqual(resolveResolution("720p"), RESOLUTIONS["720p"]);
  assert.deepEqual(resolveResolution({ width: 1001, height: 563 }), { width: 1002, height: 564 });
  assert.throws(() => resolveResolution("4k"), /Unknown resolution/);
});

test("every quality preset is complete", () => {
  for (const [name, p] of Object.entries(QUALITY_PRESETS)) {
    assert.ok(RESOLUTIONS[p.resolution], `${name} resolution`);
    assert.ok(["zoom", "pan", "none"].includes(p.motion), `${name} motion`);
    assert.ok(p.fps >= 12 && p.fps <= 60, `${name} fps`);
    assert.ok(Array.isArray(p.x264) && p.x264.includes("-preset"), `${name} x264 args`);
  }
});

test("video graph converts pixel format before duplicating frames", () => {
  const base = { width: 1280, height: 720, fps: 30, frames: 301, durationSec: 10, captionMode: "none", captionParts: [], srtPath: "" };
  for (const motion of ["zoom", "pan", "none"]) {
    const g = buildVideoGraph({ ...base, motion });
    const fmt = g.indexOf("format=yuv420p");
    const dup = Math.max(g.indexOf("zoompan="), g.indexOf("fps="));
    assert.ok(fmt !== -1 && dup !== -1 && fmt < dup, `${motion}: ${g}`);
    assert.ok(g.endsWith("[v]"));
  }
  assert.match(buildVideoGraph({ ...base, motion: "zoom" }), /zoompan=z='1\+0\.08\*on\/301'/);
  assert.match(buildVideoGraph({ ...base, motion: "pan" }), /crop=1280:720:x='\(iw-ow\)\*min\(t\/10\.000\\,1\)'/);
  assert.doesNotMatch(buildVideoGraph({ ...base, motion: "none" }), /zoompan|crop=1280:720:x/);
});

test("video graph appends drawtext cues or a subtitles filter", () => {
  const cues = [
    { lines: ["Hello there"], start: 0.2, end: 1.9 },
    { lines: ["Line one", "line two"], start: 1.9, end: 4 },
  ];
  const parts = captionFilters({
    cues,
    fontPath: "/usr/share/fonts/DejaVuSans.ttf",
    width: 1920,
    height: 1080,
    workFiles: { "0_0": "/w/c00.txt", "1_0": "/w/c10.txt", "1_1": "/w/c11.txt" },
  });
  assert.equal(parts.length, 3);
  assert.match(parts[0], /textfile=\/w\/c00\.txt:expansion=none/);
  assert.match(parts[0], /enable='between\(t,0\.200,1\.900\)'/);
  // second cue: first line sits above the second
  const y = (s) => Number(/:y=(\d+)/.exec(s)[1]);
  assert.ok(y(parts[1]) < y(parts[2]));
  const g = buildVideoGraph({
    width: 1920, height: 1080, fps: 30, frames: 10, durationSec: 1, motion: "none",
    captionMode: "drawtext", captionParts: parts, srtPath: "",
  });
  assert.equal((g.match(/drawtext=/g) || []).length, 3);
  const sub = buildVideoGraph({
    width: 1920, height: 1080, fps: 30, frames: 10, durationSec: 1, motion: "none",
    captionMode: "subtitles", captionParts: [], srtPath: "/w/captions.srt",
  });
  assert.match(sub, /subtitles=\/w\/captions\.srt:force_style=/);
});

test("audio graph mixes voice with music or passes voice through", () => {
  const withMusic = buildAudioGraph({ durationSec: 12, music: true });
  assert.match(withMusic, /^\[0:a\]aformat=.*apad\[vo\];/);
  assert.match(withMusic, /\[1:a\].*\[m0\];\[2:a\].*\[m1\];\[3:a\].*\[m2\]/);
  assert.match(withMusic, /\[vo\]\[mu\]amix=inputs=2:duration=first.*\[a\]$/);
  assert.equal(musicInputs(12).filter((a) => a === "lavfi").length, 3);
  const voiceOnly = buildAudioGraph({ durationSec: 12, music: false });
  assert.match(voiceOnly, /\[vo\]anull\[a\]$/);
});

test("encoder selection prefers libx264/aac and falls back sanely", () => {
  assert.equal(pickVideoEncoder({ libx264: true, mpeg4: true }).name, "libx264");
  assert.equal(pickVideoEncoder({ libx264: false, libopenh264: true }).name, "libopenh264");
  assert.equal(pickVideoEncoder({ mpeg4: true }).name, "mpeg4");
  assert.equal(pickVideoEncoder({}), null);
  assert.equal(pickAudioEncoder({ aac: true }).name, "aac");
  assert.equal(pickAudioEncoder({ libopus: true }).name, "libopus");
  assert.equal(pickAudioEncoder({}), null);
});

test("installCommand produces per-package-manager commands", () => {
  assert.equal(
    installCommand("apt-get", ["ffmpeg", "tts", "font"]),
    "sudo apt-get update && sudo apt-get install -y ffmpeg espeak-ng fonts-dejavu-core",
  );
  assert.equal(installCommand("brew", ["tts"]), "brew install espeak-ng");
  assert.equal(installCommand("winget", ["ffmpeg"]), "winget install --id Gyan.FFmpeg -e");
  assert.equal(installCommand("brew", ["font"]), null);
  assert.equal(installCommand("nope", ["ffmpeg"]), null);
});
