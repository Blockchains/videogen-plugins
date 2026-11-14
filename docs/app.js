import { generateVideo } from "./lib/render.js";
import { speakPreview, stopSpeakPreview } from "./lib/narration.js";
import { detectCapabilities } from "./lib/capabilities.js";

const DEFAULT_SCRIPT =
  "Staying hydrated keeps your body and mind running at their best.";
const DEFAULT_STYLE =
  "Loose watercolor illustration, visible brushstrokes, soft color bleeds, paper texture, muted palette. A clear uncluttered subject centered in the frame, occupying only the middle half of the image, with generous empty margins on all four sides, no background clutter.";

const els = {
  script: document.getElementById("script"),
  style: document.getElementById("style"),
  captions: document.getElementById("captions"),
  music: document.getElementById("music"),
  narration: document.getElementById("narration"),
  engine: document.getElementById("engine"),
  enginePill: document.getElementById("engine-pill"),
  status: document.getElementById("status"),
  stats: document.getElementById("stats"),
  stage: document.getElementById("stage"),
  preview: document.getElementById("preview"),
  player: document.getElementById("player"),
  generate: document.getElementById("generate"),
  regen: document.getElementById("regen"),
  speak: document.getElementById("speak"),
  download: document.getElementById("download"),
};

let current = null;
let busy = false;
let caps = null;

function setBusy(v) {
  busy = v;
  els.generate.disabled = v;
  els.regen.disabled = v || !current;
  els.download.disabled = v || !current;
  els.speak.disabled = v;
  els.engine.disabled = v;
}

function setStatus(msg) {
  els.status.textContent = msg || "";
}

function setStats(result) {
  if (!result) {
    els.stats.textContent = "";
    return;
  }
  const engine = result.engine === "webcodecs" ? "WebCodecs" : "realtime";
  const kb = Math.round(result.bytes / 1024);
  els.stats.textContent = `${result.durationSec.toFixed(1)}s clip · rendered in ${(result.renderMs / 1000).toFixed(1)}s (${result.speedup}× realtime) · ${engine} · ${kb} KB`;
}

function showVideo(url) {
  els.player.src = url;
  els.player.load();
  els.stage.classList.add("has-video");
  els.player.play().catch(() => {});
}

function showCanvas() {
  els.stage.classList.remove("has-video");
  els.player.removeAttribute("src");
}

function applyCapabilities(c) {
  caps = c;
  els.enginePill.textContent = c.label;
  els.enginePill.classList.remove("is-fast", "is-slow", "is-none");
  els.enginePill.classList.add(
    c.engine === "webcodecs" ? "is-fast" : c.engine === "realtime" ? "is-slow" : "is-none",
  );
  if (c.engine === "none") {
    els.generate.disabled = true;
    setStatus(c.label);
  }
  if (!c.webcodecs) {
    els.engine.value = "realtime";
    els.engine.disabled = true;
    els.engine.title = "WebCodecs is not available in this browser";
  }
  if (!c.speechSynthesis) {
    els.speak.disabled = true;
    els.speak.title = "Speech preview is not available in this browser";
  }
}

async function runGenerate({ newSeed = true } = {}) {
  if (busy) return;
  const script = els.script.value.trim();
  const style = els.style.value.trim();
  if (!script) {
    setStatus("Add a short script to narrate.");
    els.script.focus();
    return;
  }

  setBusy(true);
  setStats(null);
  showCanvas();
  stopSpeakPreview();
  if (current?.url) URL.revokeObjectURL(current.url);

  try {
    const seed = newSeed ? Date.now() : current?.seed || Date.now();
    const result = await generateVideo({
      script,
      style: style || DEFAULT_STYLE,
      captions: els.captions.checked,
      music: els.music.checked,
      narration: els.narration?.checked !== false,
      engine: els.engine.value,
      seed,
      previewCanvas: els.preview,
      onStatus: setStatus,
    });
    current = result;
    showVideo(result.url);
    els.regen.disabled = false;
    els.download.disabled = false;
    setStats(result);
    const warn = result.warnings?.length ? ` · ${result.warnings[0]}` : "";
    setStatus(`Done · ${result.durationSec.toFixed(1)}s · ready to download${warn}`);
  } catch (err) {
    console.error(err);
    setStatus(err?.message || "Generation failed");
  } finally {
    setBusy(false);
  }
}

els.script.value = DEFAULT_SCRIPT;
els.style.value = DEFAULT_STYLE;

els.generate.addEventListener("click", () => runGenerate({ newSeed: true }));
els.regen.addEventListener("click", () => runGenerate({ newSeed: true }));
els.download.addEventListener("click", () => {
  if (!current?.url) return;
  const a = document.createElement("a");
  a.href = current.url;
  a.download = "videogen-clip.webm";
  a.click();
});
els.speak.addEventListener("click", () => {
  const script = els.script.value.trim();
  if (script) speakPreview(script);
});

// Live edit: toggling captions/music marks dirty; regenerate applies
for (const el of [els.captions, els.music, els.narration, els.engine]) {
  el?.addEventListener("change", () => {
    if (current) setStatus("Settings changed — regenerate to apply.");
  });
}

setStatus("Edit the script, then generate. Everything runs in your browser.");
detectCapabilities()
  .then(applyCapabilities)
  .catch((err) => {
    console.error(err);
    els.enginePill.textContent = "Encoder detection failed";
    els.enginePill.classList.add("is-none");
  });

// Exposed for automated checks (no UI dependency).
window.__videogen = { generateVideo, detectCapabilities, get current() { return current; } };
