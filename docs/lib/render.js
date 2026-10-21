import { paintWatercolor, hashSeed } from "./watercolor.js";
import { estimateDurationSec, createSoundtrack, stopSpeakPreview } from "./audio.js";

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
  const zoom = 1 + progress * 0.08;
  const sw = still.width;
  const sh = still.height;
  const dw = width * zoom;
  const dh = height * zoom;
  const dx = (width - dw) / 2;
  const dy = (height - dh) / 2 - progress * 12;
  ctx.clearRect(0, 0, width, height);
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

/**
 * Render + encode a short narrated clip entirely in-browser.
 * Returns { blob, url, durationSec, stillCanvas }
 */
export async function generateVideo(opts) {
  const {
    script,
    style,
    captions = true,
    music = true,
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

  // show first frame
  if (previewCanvas) {
    previewCanvas.width = width;
    previewCanvas.height = height;
    const pctx = previewCanvas.getContext("2d");
    drawFrame(pctx, still, 0, { script, captions, width, height });
  }

  onStatus?.("Composing audio + motion…");
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") await audioCtx.resume();

  const recordCanvas = document.createElement("canvas");
  recordCanvas.width = width;
  recordCanvas.height = height;
  const rctx = recordCanvas.getContext("2d");

  const fps = 30;
  const canvasStream = recordCanvas.captureStream(fps);
  const { dest } = createSoundtrack(audioCtx, { durationSec, script, music });

  const mixed = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...dest.stream.getAudioTracks(),
  ]);

  const mimeType = pickMime();
  if (!mimeType) {
    await audioCtx.close();
    throw new Error("This browser cannot record video (MediaRecorder/WebM unsupported).");
  }

  const chunks = [];
  const recorder = new MediaRecorder(mixed, {
    mimeType,
    videoBitsPerSecond: 4_500_000,
  });
  recorder.ondataavailable = (e) => {
    if (e.data?.size) chunks.push(e.data);
  };

  const stopped = new Promise((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = () => reject(new Error("Recording failed"));
  });

  recorder.start(100);
  onStatus?.("Recording clip…");

  const t0 = performance.now();
  const totalMs = durationSec * 1000;

  await new Promise((resolve) => {
    const tick = () => {
      const elapsed = performance.now() - t0;
      const progress = Math.min(1, elapsed / totalMs);
      drawFrame(rctx, still, progress, { script, captions, width, height });
      if (previewCanvas) {
        const pctx = previewCanvas.getContext("2d");
        pctx.drawImage(recordCanvas, 0, 0);
      }
      if (progress < 1) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });

  // small pad so last audio envelopes finish
  await new Promise((r) => setTimeout(r, 180));
  recorder.stop();
  await stopped;

  canvasStream.getTracks().forEach((t) => t.stop());
  dest.stream.getTracks().forEach((t) => t.stop());
  await audioCtx.close();

  const blob = new Blob(chunks, { type: mimeType });
  const url = URL.createObjectURL(blob);
  onStatus?.("Ready.");
  return { blob, url, durationSec, still, mimeType, seed };
}
