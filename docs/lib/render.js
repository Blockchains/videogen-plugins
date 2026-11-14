import { paintWatercolor, hashSeed } from "./watercolor.js";
import {
  estimateDurationSec,
  renderSoundtrackBuffer,
  stopSpeakPreview,
} from "./narration.js";
import { WebMMuxer } from "./webm.js";
import { detectCapabilities } from "./capabilities.js";

function wrapLines(ctx, text, maxWidth) {
  const words = String(text).trim().split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width > maxWidth && cur) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Split the script into caption cues (sentence → clause → words) and assign
 * each a time window proportional to its length, so long scripts no longer
 * overflow the frame with a single block of text.
 */
export function buildCues(script, durationSec, { maxChars = 80, leadIn = 0.25, tail = 0.35 } = {}) {
  const clean = String(script || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) || [clean];
  const texts = [];
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (s.length <= maxChars) {
      texts.push(s);
      continue;
    }
    let cur = "";
    for (const clauseRaw of s.match(/[^,;:—–]+[,;:—–]*/g) || [s]) {
      const clause = clauseRaw.trim();
      if (!clause) continue;
      if (clause.length > maxChars) {
        if (cur) texts.push(cur);
        cur = "";
        let w = "";
        for (const word of clause.split(" ")) {
          const next = w ? `${w} ${word}` : word;
          if (next.length > maxChars && w) {
            texts.push(w);
            w = word;
          } else w = next;
        }
        if (w) texts.push(w);
        continue;
      }
      const next = cur ? `${cur} ${clause}` : clause;
      if (next.length > maxChars) {
        if (cur) texts.push(cur);
        cur = clause;
      } else cur = next;
    }
    if (cur) texts.push(cur);
  }
  const usable = Math.max(durationSec - leadIn - tail, 0.5);
  const weights = texts.map((t) => t.length + 6);
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  let t = leadIn;
  return texts.map((text, i) => {
    const start = t;
    t += (weights[i] / sum) * usable;
    return { text, start, end: i === texts.length - 1 ? durationSec : t };
  });
}

function drawFrame(ctx, still, progress, timeSec, { cues, captions, width, height }) {
  // Strong Ken Burns: zoom + diagonal drift (clearly moving)
  const zoom = 1.05 + progress * 0.22;
  const dw = width * zoom;
  const dh = height * zoom;
  const dx = (width - dw) / 2 + progress * width * 0.04;
  const dy = (height - dh) / 2 - progress * height * 0.05;
  ctx.fillStyle = "#d7e0db";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(still, dx, dy, dw, dh);

  if (!captions || !cues?.length) return;
  const cue = cues.find((c) => timeSec >= c.start && timeSec < c.end) || (timeSec >= cues[cues.length - 1].start ? cues[cues.length - 1] : null);
  if (!cue) return;
  const pad = Math.round(width * 0.06);
  ctx.font = `600 ${Math.round(width * 0.028)}px Figtree, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  const lines = wrapLines(ctx, cue.text, width - pad * 2).slice(0, 3);
  const lineH = Math.round(width * 0.036);
  let y = height - pad;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    ctx.lineWidth = Math.max(3, width * 0.004);
    ctx.strokeStyle = "rgba(20,33,43,0.55)";
    ctx.fillStyle = "#ffffff";
    ctx.strokeText(line, width / 2, y);
    ctx.fillText(line, width / 2, y);
    y -= lineH;
  }
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForQueue(encoder, max) {
  if (encoder.encodeQueueSize <= max) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (encoder.encodeQueueSize <= max) {
        encoder.removeEventListener?.("dequeue", check);
        resolve();
      }
    };
    if (typeof encoder.addEventListener === "function") {
      encoder.addEventListener("dequeue", check);
    }
    const poll = () => {
      if (encoder.encodeQueueSize <= max) resolve();
      else setTimeout(poll, 4);
    };
    setTimeout(poll, 4);
  });
}

/**
 * Confirm the browser can actually open the produced file (metadata +
 * dimensions). Used to decide whether a fast-path result is trustworthy.
 */
async function verifyPlayable(blob, { timeoutMs = 6000, requireDuration = true } = {}) {
  const url = URL.createObjectURL(blob);
  const v = document.createElement("video");
  v.preload = "metadata";
  v.muted = true;
  try {
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("timed out reading video metadata")), timeoutMs);
      v.onloadedmetadata = () => {
        clearTimeout(to);
        resolve();
      };
      v.onerror = () => {
        clearTimeout(to);
        reject(new Error(`browser could not decode output (${v.error?.message || v.error?.code || "unknown"})`));
      };
      v.src = url;
    });
    if (!(v.videoWidth > 0 && v.videoHeight > 0)) throw new Error("output has no video dimensions");
    if (requireDuration && !(Number.isFinite(v.duration) && v.duration > 0)) {
      throw new Error("output has no duration");
    }
    return { durationSec: v.duration, width: v.videoWidth, height: v.videoHeight };
  } finally {
    v.removeAttribute("src");
    v.load?.();
    URL.revokeObjectURL(url);
  }
}

/**
 * Fast route: draw frames straight into VideoEncoder/AudioEncoder and mux a
 * seekable WebM. Runs as fast as the CPU allows instead of 1× real time.
 */
async function encodeWithWebCodecs({
  still, cues, captions, width, height, fps, durationSec, audioPromise, sampleRate, caps, previewCanvas, onStatus,
}) {
  const codec = caps.videoCodec;
  const muxer = new WebMMuxer({
    video: { codec: codec.startsWith("vp09") ? "vp9" : "vp8", width, height },
    audio: { sampleRate, channels: 2 },
  });

  let encodeError = null;
  const onError = (e) => {
    encodeError = encodeError || e;
  };
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: onError,
  });
  videoEncoder.configure({
    codec,
    width,
    height,
    bitrate: 3_000_000,
    framerate: fps,
    latencyMode: "realtime",
  });
  const audioEncoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: onError,
  });
  audioEncoder.configure({
    codec: "opus",
    sampleRate,
    numberOfChannels: 2,
    bitrate: 128_000,
  });

  try {
    // Video frames are encoded while the OfflineAudioContext renders the
    // soundtrack on its own thread; audio is encoded once both are ready.
    const totalFrames = Math.max(Math.round(durationSec * fps), fps * 3);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { alpha: false });
    const frameUs = Math.round(1e6 / fps);
    const keyEvery = fps * 2;
    const t0 = performance.now();
    for (let f = 0; f < totalFrames; f++) {
      if (encodeError) throw encodeError;
      const progress = totalFrames <= 1 ? 1 : f / (totalFrames - 1);
      drawFrame(ctx, still, progress, f / fps, { cues, captions, width, height });
      const frame = new VideoFrame(canvas, { timestamp: f * frameUs, duration: frameUs });
      videoEncoder.encode(frame, { keyFrame: f % keyEvery === 0 });
      frame.close();
      if (videoEncoder.encodeQueueSize > 6) await waitForQueue(videoEncoder, 2);
      if (f % 15 === 0) {
        if (previewCanvas) previewCanvas.getContext("2d").drawImage(canvas, 0, 0);
        const pct = Math.round((f / totalFrames) * 100);
        const fpsNow = f > 0 ? Math.round((f / (performance.now() - t0)) * 1000) : 0;
        onStatus?.(`Encoding video… ${pct}%${fpsNow ? ` · ${fpsNow} fps` : ""}`);
        await wait(0);
      }
    }
    const videoFlush = videoEncoder.flush();

    onStatus?.("Encoding audio…");
    const audioBuffer = await audioPromise;
    if (audioBuffer.sampleRate !== sampleRate) throw new Error("audio sample rate mismatch");
    const { numberOfChannels, length } = audioBuffer;
    const chunkFrames = sampleRate; // 1 s per AudioData
    const channelData = Array.from({ length: 2 }, (_, c) =>
      audioBuffer.getChannelData(Math.min(c, numberOfChannels - 1)),
    );
    for (let start = 0; start < length; start += chunkFrames) {
      const n = Math.min(chunkFrames, length - start);
      const planar = new Float32Array(n * 2);
      for (let c = 0; c < 2; c++) planar.set(channelData[c].subarray(start, start + n), c * n);
      const data = new AudioData({
        format: "f32-planar",
        sampleRate,
        numberOfFrames: n,
        numberOfChannels: 2,
        timestamp: Math.round((start / sampleRate) * 1e6),
        data: planar,
      });
      audioEncoder.encode(data);
      data.close();
    }
    await Promise.all([videoFlush, audioEncoder.flush()]);
    if (encodeError) throw encodeError;
  } finally {
    try {
      videoEncoder.close();
    } catch {
      /* already closed */
    }
    try {
      audioEncoder.close();
    } catch {
      /* already closed */
    }
  }

  onStatus?.("Muxing WebM…");
  const blob = muxer.finalize(Math.round(durationSec * 1000));
  if (blob.size < 10_000) throw new Error("encoder produced an empty file");
  return { blob, mimeType: blob.type };
}

/**
 * Fallback route: capture the canvas + Web Audio in real time with MediaRecorder.
 */
async function recordRealtime({
  still, cues, captions, width, height, fps, durationSec, audioBuffer, caps, previewCanvas, onStatus,
}) {
  const mimeType = caps.mediaRecorderMime;
  if (!mimeType) {
    throw new Error("This browser cannot record video (MediaRecorder/WebM unsupported).");
  }
  onStatus?.("Recording motion + audio in real time…");

  const recordCanvas = document.createElement("canvas");
  recordCanvas.width = width;
  recordCanvas.height = height;
  // Must be in the document for reliable capture in some engines
  recordCanvas.style.cssText =
    "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.appendChild(recordCanvas);
  const rctx = recordCanvas.getContext("2d", { alpha: false });

  // captureStream(0) + requestFrame = explicit frame push (fixes frozen single-frame videos)
  const canvasStream = recordCanvas.captureStream(0);
  const videoTrack = canvasStream.getVideoTracks()[0];

  const audioCtx = new (window.AudioContext || window.webkitAudioContext)({
    sampleRate: audioBuffer.sampleRate,
  });
  if (audioCtx.state === "suspended") await audioCtx.resume();

  const dest = audioCtx.createMediaStreamDestination();
  const src = audioCtx.createBufferSource();
  src.buffer = audioBuffer;
  const gain = audioCtx.createGain();
  gain.gain.value = 1;
  src.connect(gain);
  gain.connect(dest);
  // Also monitor softly while recording
  const monitor = audioCtx.createGain();
  monitor.gain.value = 0.85;
  gain.connect(monitor);
  monitor.connect(audioCtx.destination);

  const mixed = new MediaStream([videoTrack, ...dest.stream.getAudioTracks()]);

  const chunks = [];
  const recorder = new MediaRecorder(mixed, {
    mimeType,
    videoBitsPerSecond: 6_000_000,
    audioBitsPerSecond: 192_000,
  });
  recorder.ondataavailable = (e) => {
    if (e.data?.size) chunks.push(e.data);
  };
  const stopped = new Promise((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = () => reject(new Error("Recording failed"));
  });

  const totalFrames = Math.max(Math.round(durationSec * fps), fps * 3);
  const frameMs = 1000 / fps;

  try {
    // Prime first frame before recorder starts
    drawFrame(rctx, still, 0, 0, { cues, captions, width, height });
    if (typeof videoTrack.requestFrame === "function") videoTrack.requestFrame();

    recorder.start(100);
    await wait(40);
    src.start(0);

    const t0 = performance.now();
    for (let f = 0; f < totalFrames; f++) {
      const target = t0 + f * frameMs;
      const delay = target - performance.now();
      if (delay > 1) await wait(delay);

      const progress = totalFrames <= 1 ? 1 : f / (totalFrames - 1);
      drawFrame(rctx, still, progress, f / fps, { cues, captions, width, height });
      if (typeof videoTrack.requestFrame === "function") videoTrack.requestFrame();

      if (previewCanvas && f % 2 === 0) {
        previewCanvas.getContext("2d").drawImage(recordCanvas, 0, 0);
      }
      if (f % fps === 0) onStatus?.(`Recording… ${Math.round((f / totalFrames) * 100)}%`);
    }

    // Let trailing audio finish into the recorder
    const remaining = durationSec * 1000 - (performance.now() - t0);
    if (remaining > 0) await wait(remaining + 120);

    if (recorder.state === "recording") recorder.stop();
    await stopped;
  } finally {
    try {
      src.stop();
    } catch {
      /* already ended */
    }
    videoTrack.stop();
    dest.stream.getTracks().forEach((t) => t.stop());
    await audioCtx.close().catch(() => {});
    recordCanvas.remove();
  }

  const blob = new Blob(chunks, { type: mimeType });
  if (blob.size < 10_000) {
    throw new Error("Recording produced an empty/too-small file — try again.");
  }
  return { blob, mimeType };
}

/**
 * Render + encode a moving narrated clip entirely in-browser.
 * Uses WebCodecs when available (many × faster than real time) and falls back
 * to MediaRecorder; the fast result is verified decodable before it is trusted.
 */
export async function generateVideo(opts) {
  const {
    script,
    style,
    captions = true,
    music = true,
    narration = true,
    seed = Date.now(),
    width = 1280,
    height = 720,
    fps = 30,
    engine = "auto",
    previewCanvas,
    onStatus,
  } = opts;

  const tStart = performance.now();
  const warnings = [];
  stopSpeakPreview();
  const caps = await detectCapabilities({ width, height, fps });
  if (caps.engine === "none") throw new Error(caps.label);

  const durationSec = estimateDurationSec(script);
  const cues = buildCues(script, durationSec);

  onStatus?.("Painting watercolor still…");
  const still = paintWatercolor({
    width,
    height,
    script,
    style,
    seed: seed ^ hashSeed(style || ""),
  });

  if (previewCanvas) {
    previewCanvas.width = width;
    previewCanvas.height = height;
    drawFrame(previewCanvas.getContext("2d"), still, 0, 0, { cues, captions, width, height });
  }

  const useFast = caps.webcodecs && engine !== "realtime";
  const sampleRate = useFast ? 48000 : 44100;
  onStatus?.("Synthesizing narration + music…");
  // Offline audio renders on its own thread; the fast path overlaps it with video encoding.
  const audioPromise = renderSoundtrackBuffer({ script, durationSec, music, narration, sampleRate });
  audioPromise.catch(() => {});

  const shared = { still, cues, captions, width, height, fps, durationSec, caps, previewCanvas, onStatus };
  let out = null;
  let usedEngine = null;

  if (useFast) {
    try {
      const fast = await encodeWithWebCodecs({ ...shared, audioPromise, sampleRate });
      onStatus?.("Verifying output…");
      const check = await verifyPlayable(fast.blob);
      out = { ...fast, verified: check };
      usedEngine = "webcodecs";
    } catch (err) {
      console.warn("[videogen] fast encoder failed, falling back to realtime recorder", err);
      warnings.push(`Fast encoder unavailable (${err?.message || err}); recorded in real time instead.`);
      if (!(caps.mediaRecorderMime && caps.captureStream)) throw err;
    }
  }

  if (!out) {
    const rendered = await audioPromise;
    const audio =
      rendered.sampleRate === 44100
        ? rendered
        : await renderSoundtrackBuffer({ script, durationSec, music, narration, sampleRate: 44100 });
    const slow = await recordRealtime({ ...shared, audioBuffer: audio });
    let verified = null;
    try {
      verified = await verifyPlayable(slow.blob, { requireDuration: false });
    } catch (err) {
      throw new Error(`Recording could not be decoded: ${err.message}`);
    }
    out = { ...slow, verified };
    usedEngine = "realtime";
  }

  const url = URL.createObjectURL(out.blob);
  const renderMs = Math.round(performance.now() - tStart);
  onStatus?.("Ready.");
  return {
    blob: out.blob,
    url,
    durationSec,
    still,
    cues,
    mimeType: out.mimeType,
    seed,
    bytes: out.blob.size,
    engine: usedEngine,
    renderMs,
    speedup: Number((durationSec / (renderMs / 1000)).toFixed(1)),
    warnings,
    verified: out.verified,
  };
}
