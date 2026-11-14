import test from "node:test";
import assert from "node:assert/strict";
import { parseWav, concatWavs, silentWav, wavDurationSec } from "../lib/wav.mjs";

function pcmWav(seconds, { sampleRate = 22050, channels = 1, fill = 0x11 } = {}) {
  const buf = silentWav(seconds, { sampleRate, channels });
  buf.fill(fill, 44);
  return buf;
}

test("silentWav writes a valid 16-bit PCM header", () => {
  const info = parseWav(silentWav(1.5));
  assert.equal(info.audioFormat, 1);
  assert.equal(info.channels, 1);
  assert.equal(info.sampleRate, 22050);
  assert.equal(info.bitsPerSample, 16);
  assert.equal(info.blockAlign, 2);
  assert.equal(info.byteRate, 44100);
  assert.equal(info.dataOffset, 44);
  assert.ok(Math.abs(info.durationSec - 1.5) < 1e-3);
});

test("parseWav trusts file length when data size is a streaming placeholder", () => {
  const buf = silentWav(1);
  buf.writeUInt32LE(0xffffffff, 40);
  assert.ok(Math.abs(wavDurationSec(buf) - 1) < 1e-3);
  buf.writeUInt32LE(0, 40);
  assert.ok(Math.abs(wavDurationSec(buf) - 1) < 1e-3);
});

test("parseWav rejects non-WAV input", () => {
  assert.throws(() => parseWav(Buffer.from("not a wav file at all, definitely not RIFF/WAVE....")));
});

test("concatWavs stitches clips with lead-in and gaps and reports exact segments", () => {
  const a = pcmWav(1, { fill: 0x11 });
  const b = pcmWav(0.5, { fill: 0x22 });
  const { buffer, segments, durationSec, format } = concatWavs([a, b], { gapSec: 0.25, leadInSec: 0.5 });
  const info = parseWav(buffer);
  assert.equal(info.channels, 1);
  assert.equal(format.sampleRate, 22050);
  assert.ok(Math.abs(durationSec - (0.5 + 1 + 0.25 + 0.5)) < 1e-3);
  assert.ok(Math.abs(info.durationSec - durationSec) < 1e-9);
  assert.ok(Math.abs(segments[0].start - 0.5) < 1e-3);
  assert.ok(Math.abs(segments[0].end - 1.5) < 1e-3);
  assert.ok(Math.abs(segments[1].start - 1.75) < 1e-3);
  assert.ok(Math.abs(segments[1].end - 2.25) < 1e-3);
  // lead-in is silence, first clip bytes are 0x11, gap is silence, second clip is 0x22
  assert.equal(buffer[44], 0);
  assert.equal(buffer[44 + Math.round(0.5 * 44100)], 0x11);
  assert.equal(buffer[44 + Math.round(1.5 * 44100) + 2], 0);
  assert.equal(buffer[44 + Math.round(1.75 * 44100) + 2], 0x22);
});

test("concatWavs refuses mismatched formats", () => {
  const a = pcmWav(0.2, { sampleRate: 22050 });
  const b = pcmWav(0.2, { sampleRate: 44100 });
  assert.throws(() => concatWavs([a, b]), /formats differ/);
});
