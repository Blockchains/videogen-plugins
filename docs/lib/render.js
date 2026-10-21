import { paintWatercolor, hashSeed } from "./watercolor.js";
import {
  estimateDurationSec,
  renderSoundtrackBuffer,
  stopSpeakPreview,
} from "./narration.js";

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
  return lines.slice(0, 3);
}

function drawFrame(ctx, still, progress, { script, captions, width, height }) {
  // Strong Ken Burns: zoom + diagonal drift (clearly moving)
  const zoom = 1.05 + progress * 0.22;
  const dw = width * zoom;
  const dh = height * zoom;
  const dx = (width - dw) / 2 + progress * width * 0.04;
  const dy = (height - dh) / 2 - progress * height * 0.05;
  ctx.fillStyle = "#d7e0db";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(still, dx, dy, dw, dh);

  if (captions && script) {
    const pad = Math.round(width * 0.06);
    ctx.font = `600 ${Math.round(width * 0.028)}px Figtree, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    const lines = wrapLines(ctx, script, width - pad * 2);
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
}

function pickMime() {
  const types = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  for (const t of types) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Render + encode a moving narrated clip entirely in-browser.
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
    previewCanvas,
    onStatus,
  } = opts;

  stopSpeakPreview();
  const durationSec = estimateDurationSec(script);

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
    drawFrame(previewCanvas.getContext("2d"), still, 0, {
      script,
      captions,
      width,
      height,
    });
  }

  onStatus?.("Synthesizing narration + music…");
  const audioBuffer = await renderSoundtrackBuffer({
    script,
    durationSec,
    music,
    narration,
  });

  const mimeType = pickMime();
  if (!mimeType) {
    throw new Error("This browser cannot record video (MediaRecorder/WebM unsupported).");
  }

  onStatus?.("Recording motion + audio…");

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

  const mixed = new MediaStream([
    videoTrack,
    ...dest.stream.getAudioTracks(),
  ]);

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

  const fps = 30;
  const totalFrames = Math.max(Math.round(durationSec * fps), fps * 3);
  const frameMs = 1000 / fps;

  // Prime first frame before recorder starts
  drawFrame(rctx, still, 0, { script, captions, width, height });
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
    drawFrame(rctx, still, progress, { script, captions, width, height });
    if (typeof videoTrack.requestFrame === "function") {
      videoTrack.requestFrame();
    }

    if (previewCanvas && f % 2 === 0) {
      previewCanvas.getContext("2d").drawImage(recordCanvas, 0, 0);
    }
  }

  // Let trailing audio finish into the recorder
  const remaining = durationSec * 1000 - (performance.now() - t0);
  if (remaining > 0) await wait(remaining + 120);

  if (recorder.state === "recording") recorder.stop();
  await stopped;

  try {
    src.stop();
  } catch {
    /* already ended */
  }
  videoTrack.stop();
  dest.stream.getTracks().forEach((t) => t.stop());
  await audioCtx.close();
  recordCanvas.remove();

  const blob = new Blob(chunks, { type: mimeType });
  if (blob.size < 10_000) {
    throw new Error("Recording produced an empty/too-small file — try again.");
  }
  const url = URL.createObjectURL(blob);
  onStatus?.("Ready.");
  return { blob, url, durationSec, still, mimeType, seed, bytes: blob.size };
}
