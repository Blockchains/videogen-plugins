/**
 * Minimal PCM WAV reader/writer — avoids spawning ffprobe just to learn a
 * narration clip's duration, and lets us stitch per-cue speech clips with
 * exact timings in-process.
 */

export function parseWav(buf) {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE file");
  }
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        byteRate: buf.readUInt32LE(body + 8),
        blockAlign: buf.readUInt16LE(body + 12),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      const remaining = buf.length - body;
      // Streaming writers leave size as 0 / 0xFFFFFFFF; trust the file length.
      if (size === 0 || size === 0xffffffff || size > remaining) size = remaining;
      data = { offset: body, size };
      break;
    }
    off = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error("WAV missing fmt/data chunk");
  if (!fmt.byteRate) fmt.byteRate = (fmt.sampleRate * fmt.channels * fmt.bitsPerSample) / 8;
  const durationSec = data.size / fmt.byteRate;
  return { ...fmt, dataOffset: data.offset, dataSize: data.size, durationSec };
}

export function wavDurationSec(buf) {
  return parseWav(buf).durationSec;
}

function header(fmt, dataSize) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + dataSize, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(fmt.channels, 22);
  h.writeUInt32LE(fmt.sampleRate, 24);
  h.writeUInt32LE(fmt.byteRate, 28);
  h.writeUInt16LE(fmt.blockAlign, 32);
  h.writeUInt16LE(fmt.bitsPerSample, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(dataSize, 40);
  return h;
}

function sameFormat(a, b) {
  return (
    a.audioFormat === b.audioFormat &&
    a.channels === b.channels &&
    a.sampleRate === b.sampleRate &&
    a.bitsPerSample === b.bitsPerSample
  );
}

/**
 * Concatenate PCM WAV buffers with `gapSec` of silence between them.
 * Returns the combined buffer plus per-clip start/end times (seconds).
 * Throws if formats differ or audio is not integer PCM.
 */
export function concatWavs(buffers, { gapSec = 0.12, leadInSec = 0.2 } = {}) {
  if (!buffers.length) throw new Error("No WAV buffers to concat");
  const infos = buffers.map(parseWav);
  const fmt = infos[0];
  if (fmt.audioFormat !== 1) throw new Error(`Unsupported WAV format ${fmt.audioFormat}`);
  for (const i of infos) {
    if (!sameFormat(fmt, i)) throw new Error("WAV formats differ; cannot concat in-process");
  }
  const align = fmt.blockAlign || 1;
  const bytesFor = (sec) => Math.round((sec * fmt.byteRate) / align) * align;

  const parts = [];
  const segments = [];
  let bytes = 0;
  const lead = bytesFor(leadInSec);
  if (lead > 0) {
    parts.push(Buffer.alloc(lead));
    bytes += lead;
  }
  infos.forEach((info, idx) => {
    const start = bytes / fmt.byteRate;
    const pcm = buffers[idx].subarray(info.dataOffset, info.dataOffset + info.dataSize);
    parts.push(pcm);
    bytes += pcm.length;
    segments.push({ start, end: bytes / fmt.byteRate });
    if (idx < infos.length - 1) {
      const gap = bytesFor(gapSec);
      parts.push(Buffer.alloc(gap));
      bytes += gap;
    }
  });
  const out = Buffer.concat([header(fmt, bytes), ...parts]);
  return { buffer: out, segments, durationSec: bytes / fmt.byteRate, format: fmt };
}

/** Silent PCM WAV of the given duration (16-bit mono, 22050 Hz by default). */
export function silentWav(durationSec, { sampleRate = 22050, channels = 1 } = {}) {
  const fmt = {
    channels,
    sampleRate,
    bitsPerSample: 16,
    blockAlign: channels * 2,
    byteRate: sampleRate * channels * 2,
  };
  const size = Math.max(fmt.blockAlign, Math.round(durationSec * fmt.byteRate / fmt.blockAlign) * fmt.blockAlign);
  return Buffer.concat([header(fmt, size), Buffer.alloc(size)]);
}
