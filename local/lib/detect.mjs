/**
 * Fast, cached capability detection for the local VideoGen engine.
 *
 * - Binaries are resolved with a pure-Node PATH scan (no shell spawn).
 * - ffmpeg filter/encoder capabilities are probed once and cached on disk,
 *   keyed by the binary's path + mtime + size.
 * - Several TTS engines are supported so narration keeps working when
 *   espeak-ng is missing (espeak, macOS `say`, flite, pico2wave, Windows SAPI).
 * - A usable TTF font is discovered for drawtext captions.
 */
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { run, whichPath } from "./exec.mjs";

export const CACHE_DIR =
  process.env.VIDEOGEN_CACHE_DIR || path.join(os.tmpdir(), "videogen-cache");

const PLATFORM = process.platform;

export const TTS_ENGINES = [
  { id: "espeak-ng", bin: "espeak-ng", envVar: "VIDEOGEN_ESPEAK" },
  { id: "espeak", bin: "espeak" },
  { id: "say", bin: "say", platforms: ["darwin"] },
  { id: "flite", bin: "flite" },
  { id: "pico2wave", bin: "pico2wave" },
  { id: "sapi", bin: "powershell", platforms: ["win32"] },
];

const FONT_CANDIDATES = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/TTF/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
  "/usr/share/fonts/liberation-sans/LiberationSans-Bold.ttf",
  "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
  "/usr/share/fonts/noto/NotoSans-Bold.ttf",
  "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
  "/usr/share/fonts/truetype/droid/DroidSans-Bold.ttf",
  "/usr/share/fonts/truetype/droid/DroidSans.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "/System/Library/Fonts/SFNS.ttf",
  "/Library/Fonts/Arial Bold.ttf",
  "C:/Windows/Fonts/segoeuib.ttf",
  "C:/Windows/Fonts/arialbd.ttf",
  "C:/Windows/Fonts/arial.ttf",
  "C:/Windows/Fonts/calibrib.ttf",
];

const WANTED_FILTERS = [
  "drawtext",
  "subtitles",
  "zoompan",
  "scale",
  "crop",
  "fps",
  "amix",
  "afade",
  "lowpass",
  "aformat",
  "apad",
  "sine",
  "anoisesrc",
  "anullsrc",
  "color",
  "noise",
  "gblur",
  "drawbox",
  "format",
];
const WANTED_ENCODERS = [
  "libx264",
  "libopenh264",
  "h264_videotoolbox",
  "mpeg4",
  "libvpx-vp9",
  "libvpx",
  "aac",
  "libopus",
  "libmp3lame",
];

function hashKey(s) {
  return createHash("sha1").update(s).digest("hex").slice(0, 16);
}

async function fileExists(p) {
  try {
    const st = await stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function writeJson(file, data) {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(data));
  } catch {
    /* cache is best-effort */
  }
}

function parseNameList(text, wanted) {
  const have = new Set();
  const want = new Set(wanted);
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*[A-Z.]{3,7}\s+([A-Za-z0-9_\-]+)\s/);
    if (m && want.has(m[1])) have.add(m[1]);
  }
  const out = {};
  for (const w of wanted) out[w] = have.has(w);
  return out;
}

async function probeFfmpeg(ffmpegPath) {
  const st = await stat(ffmpegPath);
  const cacheFile = path.join(
    CACHE_DIR,
    `ffmpeg-caps-${hashKey(`${ffmpegPath}|${st.mtimeMs}|${st.size}`)}.json`,
  );
  const cached = await readJson(cacheFile);
  if (cached?.version && cached.filters && cached.encoders) return { ...cached, cached: true };

  const [ver, filters, encoders] = await Promise.all([
    run(ffmpegPath, ["-hide_banner", "-version"], { timeoutMs: 15_000 }),
    run(ffmpegPath, ["-hide_banner", "-filters"], { timeoutMs: 15_000 }),
    run(ffmpegPath, ["-hide_banner", "-encoders"], { timeoutMs: 15_000 }),
  ]);
  const version = (ver.stdout.split("\n")[0] || "").replace(/^ffmpeg version\s*/, "").trim();
  const caps = {
    version,
    filters: parseNameList(filters.stdout, WANTED_FILTERS),
    encoders: parseNameList(encoders.stdout, WANTED_ENCODERS),
  };
  await writeJson(cacheFile, caps);
  return { ...caps, cached: false };
}

export function pickVideoEncoder(encoders) {
  if (encoders.libx264) return { name: "libx264", args: ["-preset", "veryfast", "-tune", "stillimage", "-crf", "20"] };
  if (encoders.h264_videotoolbox) return { name: "h264_videotoolbox", args: ["-b:v", "4M"] };
  if (encoders.libopenh264) return { name: "libopenh264", args: ["-b:v", "4M"] };
  if (encoders.mpeg4) return { name: "mpeg4", args: ["-q:v", "3"] };
  return null;
}

export function pickAudioEncoder(encoders) {
  if (encoders.aac) return { name: "aac", args: ["-b:a", "160k"] };
  if (encoders.libmp3lame) return { name: "libmp3lame", args: ["-b:a", "160k"] };
  if (encoders.libopus) return { name: "libopus", args: ["-b:a", "96k"] };
  return null;
}

async function findTts() {
  const candidates = [];
  for (const eng of TTS_ENGINES) {
    if (eng.platforms && !eng.platforms.includes(PLATFORM)) continue;
    const override = eng.envVar ? process.env[eng.envVar] : null;
    const p = await whichPath(override || eng.bin);
    candidates.push({ id: eng.id, path: p });
  }
  const chosen = candidates.find((c) => c.path);
  return {
    engine: chosen?.id || null,
    path: chosen?.path || null,
    candidates,
  };
}

async function findFont() {
  const override = process.env.VIDEOGEN_FONT;
  if (override && (await fileExists(override))) return { path: override, source: "env" };

  for (const candidate of FONT_CANDIDATES) {
    if (await fileExists(candidate)) return { path: candidate, source: "known-path" };
  }
  const fcMatch = await whichPath("fc-match");
  if (fcMatch) {
    try {
      const { stdout } = await run(fcMatch, ["-f", "%{file}", "sans-serif:bold"], {
        timeoutMs: 10_000,
      });
      const p = stdout.trim();
      if (p && /\.(ttf|otf|ttc)$/i.test(p) && (await fileExists(p))) {
        return { path: p, source: "fc-match" };
      }
    } catch {
      /* fall through */
    }
  }
  return null;
}

async function findPackageManager() {
  if (PLATFORM === "darwin") return (await whichPath("brew")) ? "brew" : null;
  if (PLATFORM === "win32") {
    if (await whichPath("winget")) return "winget";
    if (await whichPath("choco")) return "choco";
    if (await whichPath("scoop")) return "scoop";
    return null;
  }
  for (const pm of ["apt-get", "dnf", "pacman", "apk", "zypper", "brew"]) {
    if (await whichPath(pm)) return pm;
  }
  return null;
}

export function installCommand(pm, pkgs) {
  const want = new Set(pkgs);
  const names = {
    "apt-get": { ffmpeg: "ffmpeg", tts: "espeak-ng", font: "fonts-dejavu-core" },
    dnf: { ffmpeg: "ffmpeg", tts: "espeak-ng", font: "dejavu-sans-fonts" },
    pacman: { ffmpeg: "ffmpeg", tts: "espeak-ng", font: "ttf-dejavu" },
    apk: { ffmpeg: "ffmpeg", tts: "espeak-ng", font: "ttf-dejavu" },
    zypper: { ffmpeg: "ffmpeg", tts: "espeak-ng", font: "dejavu-fonts" },
    brew: { ffmpeg: "ffmpeg", tts: "espeak-ng", font: null },
    winget: { ffmpeg: "Gyan.FFmpeg", tts: "eSpeak-NG.eSpeak-NG", font: null },
    choco: { ffmpeg: "ffmpeg", tts: "espeak-ng", font: null },
    scoop: { ffmpeg: "ffmpeg", tts: null, font: null },
  };
  const map = names[pm];
  if (!map) return null;
  const list = ["ffmpeg", "tts", "font"].filter((k) => want.has(k) && map[k]).map((k) => map[k]);
  if (!list.length) return null;
  switch (pm) {
    case "apt-get":
      return `sudo apt-get update && sudo apt-get install -y ${list.join(" ")}`;
    case "dnf":
      return `sudo dnf install -y ${list.join(" ")}`;
    case "pacman":
      return `sudo pacman -S --noconfirm ${list.join(" ")}`;
    case "apk":
      return `sudo apk add ${list.join(" ")}`;
    case "zypper":
      return `sudo zypper install -y ${list.join(" ")}`;
    case "brew":
      return `brew install ${list.join(" ")}`;
    case "winget":
      return list.map((p) => `winget install --id ${p} -e`).join(" && ");
    case "choco":
      return `choco install -y ${list.join(" ")}`;
    case "scoop":
      return `scoop install ${list.join(" ")}`;
    default:
      return null;
  }
}

let detectPromise = null;

/**
 * Detect everything the pipeline needs. Memoized per process; pass
 * `{ refresh: true }` to re-scan (e.g. after installing a dependency).
 */
export function detect({ refresh = false } = {}) {
  if (!refresh && detectPromise) return detectPromise;
  detectPromise = (async () => {
    const t0 = performance.now();
    const [ffmpegPath, ffprobePath, tts, font, pm] = await Promise.all([
      whichPath(process.env.VIDEOGEN_FFMPEG || "ffmpeg"),
      whichPath(process.env.VIDEOGEN_FFPROBE || "ffprobe"),
      findTts(),
      findFont(),
      findPackageManager(),
    ]);

    let ffmpeg = null;
    if (ffmpegPath) {
      try {
        const caps = await probeFfmpeg(ffmpegPath);
        ffmpeg = {
          path: ffmpegPath,
          ...caps,
          videoEncoder: pickVideoEncoder(caps.encoders),
          audioEncoder: pickAudioEncoder(caps.encoders),
        };
      } catch (err) {
        ffmpeg = { path: ffmpegPath, error: String(err?.message || err) };
      }
    }

    return {
      platform: PLATFORM,
      arch: process.arch,
      node: process.version,
      cpus: os.cpus()?.length || 1,
      packageManager: pm,
      ffmpeg,
      ffprobe: ffprobePath ? { path: ffprobePath } : null,
      tts,
      font,
      cacheDir: CACHE_DIR,
      detectMs: Math.round(performance.now() - t0),
    };
  })();
  detectPromise.catch(() => {
    detectPromise = null;
  });
  return detectPromise;
}

/**
 * Human-actionable health report built from detect().
 */
export async function doctor(opts) {
  const d = await detect(opts);
  const checks = [];
  const missing = new Set();

  const add = (id, ok, level, detail, fix = null) =>
    checks.push({ id, ok, level: ok ? "ok" : level, detail, ...(fix && !ok ? { fix } : {}) });

  if (!d.ffmpeg?.path) {
    missing.add("ffmpeg");
    add("ffmpeg", false, "error", "ffmpeg not found on PATH (set VIDEOGEN_FFMPEG to override)");
  } else if (d.ffmpeg.error) {
    add("ffmpeg", false, "error", `ffmpeg found at ${d.ffmpeg.path} but failed to run: ${d.ffmpeg.error}`);
  } else {
    add("ffmpeg", true, "ok", `${d.ffmpeg.path} (${d.ffmpeg.version})`);
    add(
      "video-encoder",
      !!d.ffmpeg.videoEncoder,
      "error",
      d.ffmpeg.videoEncoder
        ? `${d.ffmpeg.videoEncoder.name}${d.ffmpeg.videoEncoder.name === "libx264" ? "" : " (libx264 unavailable; quality/size will differ)"}`
        : "No H.264/MPEG-4 encoder in this ffmpeg build",
      "Install an ffmpeg build with libx264",
    );
    add(
      "audio-encoder",
      !!d.ffmpeg.audioEncoder,
      "error",
      d.ffmpeg.audioEncoder ? d.ffmpeg.audioEncoder.name : "No AAC/MP3/Opus encoder in this ffmpeg build",
    );
    add(
      "motion",
      !!d.ffmpeg.filters.zoompan,
      "warn",
      d.ffmpeg.filters.zoompan ? "zoompan available (Ken Burns)" : "zoompan missing — video will be static",
    );
    const captionsOk = (d.ffmpeg.filters.drawtext && !!d.font) || d.ffmpeg.filters.subtitles;
    add(
      "captions",
      captionsOk,
      "warn",
      captionsOk
        ? d.ffmpeg.filters.drawtext && d.font
          ? "drawtext (fast path)"
          : "subtitles/libass (slower fallback)"
        : "No caption renderer: needs drawtext + a TTF font, or libass",
      "Install a font package (e.g. fonts-dejavu-core) or an ffmpeg build with libfreetype/libass",
    );
  }

  if (!d.ffprobe?.path) {
    missing.add("ffmpeg");
    add("ffprobe", false, "warn", "ffprobe not found — output validation will be skipped");
  } else {
    add("ffprobe", true, "ok", d.ffprobe.path);
  }

  if (!d.tts.engine) {
    missing.add("tts");
    add(
      "narration",
      false,
      "warn",
      "No local TTS engine (espeak-ng, espeak, say, flite, pico2wave) — videos will render without a voice track",
    );
  } else {
    add(
      "narration",
      true,
      "ok",
      `${d.tts.engine} (${d.tts.path})${d.tts.engine === "espeak-ng" ? "" : " — espeak-ng recommended"}`,
    );
  }

  if (!d.font) {
    missing.add("font");
    add("font", false, "warn", "No TTF font found for drawtext (set VIDEOGEN_FONT)");
  } else {
    add("font", true, "ok", `${d.font.path} via ${d.font.source}`);
  }

  const errors = checks.filter((c) => !c.ok && c.level === "error");
  const warns = checks.filter((c) => !c.ok && c.level === "warn");
  const install = missing.size && d.packageManager ? installCommand(d.packageManager, [...missing]) : null;

  return {
    ok: errors.length === 0,
    status: errors.length ? "blocked" : warns.length ? "degraded" : "ready",
    checks,
    install: install
      ? { packageManager: d.packageManager, command: install }
      : missing.size
        ? { packageManager: null, command: "Install ffmpeg and espeak-ng with your system package manager" }
        : null,
    detection: d,
  };
}

export function resetDetection() {
  detectPromise = null;
}
