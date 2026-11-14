import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebMMuxer, opusHead, __internals } from "../../docs/lib/webm.js";
import { whichPath, run } from "../lib/exec.mjs";

const { vint, uintBytes } = __internals;

function fakeChunk({ type = "key", timestampUs = 0, bytes = 16, fill = 0xab }) {
  const data = new Uint8Array(bytes).fill(fill);
  return {
    type,
    timestamp: timestampUs,
    byteLength: bytes,
    copyTo: (dst) => dst.set(data),
  };
}

test("EBML vint and uint encodings", () => {
  assert.deepEqual([...vint(0)], [0x80]);
  assert.deepEqual([...vint(126)], [0xfe]);
  assert.deepEqual([...vint(127)], [0x40, 0x7f]);
  assert.deepEqual([...vint(0x3ffe)], [0x7f, 0xfe]);
  assert.deepEqual([...vint(0x3fff)], [0x20, 0x3f, 0xff]);
  assert.deepEqual([...uintBytes(0)], [0]);
  assert.deepEqual([...uintBytes(255)], [255]);
  assert.deepEqual([...uintBytes(256)], [1, 0]);
  assert.deepEqual([...uintBytes(1_000_000)], [0x0f, 0x42, 0x40]);
});

test("opusHead is a 19-byte header with pre-skip and sample rate", () => {
  const h = opusHead({ channels: 2, sampleRate: 48000 });
  assert.equal(h.length, 19);
  assert.equal(new TextDecoder().decode(h.subarray(0, 8)), "OpusHead");
  const dv = new DataView(h.buffer);
  assert.equal(h[8], 1);
  assert.equal(h[9], 2);
  assert.equal(dv.getUint16(10, true), 312);
  assert.equal(dv.getUint32(12, true), 48000);
});

test("muxer produces an EBML/webm document with clusters at keyframes", async () => {
  const m = new WebMMuxer({ video: { codec: "vp9", width: 320, height: 180 }, audio: { sampleRate: 48000, channels: 2 } });
  const fps = 30;
  for (let f = 0; f < 90; f++) {
    m.addVideoChunk(fakeChunk({ type: f % 30 === 0 ? "key" : "delta", timestampUs: Math.round((f * 1e6) / fps) }), null);
  }
  for (let i = 0; i < 150; i++) m.addAudioChunk(fakeChunk({ timestampUs: i * 20_000, bytes: 8, fill: 0x55 }), null);
  const blob = m.finalize(3000);
  assert.equal(blob.type, "video/webm;codecs=vp9,opus");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);
  const text = Buffer.from(bytes).toString("latin1");
  assert.ok(text.includes("webm"));
  assert.ok(text.includes("V_VP9"));
  assert.ok(text.includes("A_OPUS"));
  assert.ok(text.includes("OpusHead"));
  // 3 keyframes at 0s, 1s, 2s -> 3 clusters
  const clusterId = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);
  let count = 0;
  let idx = Buffer.from(bytes).indexOf(clusterId);
  while (idx !== -1) {
    count++;
    idx = Buffer.from(bytes).indexOf(clusterId, idx + 1);
  }
  assert.equal(count, 3);
  assert.throws(() => m.addVideoChunk(fakeChunk({}), null), /finalized/);
});

test("ffprobe recognizes the container, tracks and duration", async (t) => {
  const ffprobe = await whichPath("ffprobe");
  if (!ffprobe) {
    t.skip("ffprobe not installed");
    return;
  }
  const m = new WebMMuxer({ video: { codec: "vp8", width: 640, height: 360 }, audio: { sampleRate: 48000, channels: 2 } });
  for (let f = 0; f < 60; f++) {
    m.addVideoChunk(fakeChunk({ type: f % 30 === 0 ? "key" : "delta", timestampUs: Math.round((f * 1e6) / 30), bytes: 64 }), null);
  }
  for (let i = 0; i < 100; i++) m.addAudioChunk(fakeChunk({ timestampUs: i * 20_000, bytes: 8 }), null);
  const blob = m.finalize(2000);
  const dir = await mkdtemp(path.join(os.tmpdir(), "videogen-webm-"));
  const file = path.join(dir, "t.webm");
  await writeFile(file, Buffer.from(await blob.arrayBuffer()));
  try {
    const { stdout } = await run(ffprobe, [
      "-v", "error",
      "-show_entries", "stream=codec_name,width,height,sample_rate,channels:format=format_name,duration",
      "-of", "json", file,
    ]);
    const info = JSON.parse(stdout);
    assert.match(info.format.format_name, /webm/);
    assert.ok(Math.abs(Number(info.format.duration) - 2.0) < 0.05, info.format.duration);
    const codecs = info.streams.map((s) => s.codec_name).sort();
    assert.deepEqual(codecs, ["opus", "vp8"]);
    const v = info.streams.find((s) => s.codec_name === "vp8");
    assert.equal(v.width, 640);
    assert.equal(v.height, 360);
    const a = info.streams.find((s) => s.codec_name === "opus");
    assert.equal(Number(a.sample_rate), 48000);
    assert.equal(a.channels, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
