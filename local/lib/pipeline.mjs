import { mkdir, writeFile, readFile, copyFile, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { run } from "./exec.mjs";
import { detect, doctor } from "./detect.mjs";
import { synthesize, DEFAULT_VOICE, DEFAULT_RATE } from "./tts.mjs";
import { concatWavs, parseWav, silentWav } from "./wav.mjs";
import {
  segmentScript,
  proportionalTimings,
  buildSrt,
  escapeFilterValue,
  estimateSpeechSec,
} from "./captions.mjs";

export const DEFAULT_STYLE =
  "Loose watercolor illustration, visible brushstrokes, soft color bleeds, paper texture, muted palette. A clear uncluttered subject centered in the frame, occupying only the middle half of the image, with generous empty margins on all four sides, no background clutter.";

export const RESOLUTIONS = {
  "1080p": { width: 1920, height: 1080 },
  "720p": { width: 1280, height: 720 },
  "480p": { width: 854, height: 480 },
};

/**
 * Quality presets trade encode time for fidelity:
 *  - fast:     720p, cheap crop-based pan, x264 ultrafast, fast AAC coder (drafts, iteration)
 *  - balanced: 1080p, zoompan Ken Burns, x264 veryfast, fast AAC coder (default)
 *  - high:     1080p, zoompan, x264 medium, two-loop AAC coder
 */
export const QUALITY_PRESETS = {
  fast: {
    resolution: "720p",
    motion: "pan",
    fps: 24,
    x264: ["-preset", "ultrafast", "-tune", "stillimage", "-crf", "23"],
    aacCoder: "fast",
  },
  balanced: {
    resolution: "1080p",
    motion: "zoom",
    fps: 30,
    x264: ["-preset", "veryfast", "-tune", "stillimage", "-crf", "20"],
    aacCoder: "fast",
  },
  high: {
    resolution: "1080p",
    motion: "zoom",
    fps: 30,
    x264: ["-preset", "medium", "-tune", "stillimage", "-crf", "18"],
    aacCoder: null,
  },
};

export const MOTION_MODES = ["zoom", "pan", "none"];

const FFMPEG_TIMEOUT_MS = 180_000;
const TAIL_SEC = 0.5;
const LEAD_IN_SEC = 0.25;
const CUE_GAP_SEC = 0.12;

function resolveResolution(resolution) {
  if (!resolution) return RESOLUTIONS["1080p"];
  if (typeof resolution === "string") {
    const r = RESOLUTIONS[resolution.toLowerCase()];
    if (!r) throw new Error(`Unknown resolution "${resolution}" (use 1080p, 720p, 480p)`);
    return r;
  }
  const width = Math.max(64, Math.round(Number(resolution.width) / 2) * 2);
  const height = Math.max(64, Math.round(Number(resolution.height) / 2) * 2);
  if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error("Bad resolution");
  return { width, height };
}

function palette(style) {
  const s = (style || "").toLowerCase();
  if (/sunset|warm|orange|gold/.test(s)) return ["0xF0E6D8", "0xD9A07A", "0xB5684A", "0x8AA0A8"];
  if (/forest|green|leaf|plant/.test(s)) return ["0xE8EFE6", "0x9CB59A", "0x5F8A68", "0xC2B8A3"];
  if (/night|ink|dark|moon/.test(s)) return ["0x1C2433", "0x40506A", "0x8B9BB0", "0xB7C4C0"];
  return ["0xE8E2D6", "0x7AA6C2", "0xB7D3E3", "0xEAF4F8"];
}

async function probeImage(ffprobePath, imagePath) {
  if (!ffprobePath) return true;
  try {
    const { stdout } = await run(
      ffprobePath,
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", imagePath],
      { timeoutMs: 15_000 },
    );
    const [w, h] = stdout.trim().split(",").map(Number);
    return w > 0 && h > 0;
  } catch {
    return false;
  }
}

async function prepareImage({ imagePath, workDir, style, det, warnings, width, height, strict }) {
  if (imagePath) {
    let problem = null;
    try {
      await stat(imagePath);
      if (await probeImage(det.ffprobe?.path, imagePath)) {
        const dest = path.join(workDir, `scene${path.extname(imagePath) || ".png"}`);
        await copyFile(imagePath, dest);
        return { path: dest, source: "provided" };
      }
      problem = `imagePath "${imagePath}" is not a decodable image`;
    } catch {
      problem = `imagePath "${imagePath}" not found`;
    }
    if (strict) {
      const err = new Error(problem);
      err.code = "EBADIMAGE";
      throw err;
    }
    warnings.push(`${problem}; using procedural still`);
  }
  const dest = path.join(workDir, "scene.png");
  const [paper, c1, c2, c3] = palette(style);
  const bw = Math.round(width * 0.19);
  const bh = Math.round(height * 0.48);
  const bx = Math.round((width - bw) / 2);
  const by = Math.round(height * 0.26);
  const inset = (f) => ({
    x: Math.round(bx + bw * f),
    y: Math.round(by + bh * f),
    w: Math.round(bw * (1 - 2 * f)),
    h: Math.round(bh * (1 - 2 * f)),
  });
  const i1 = inset(0.1);
  const i2 = inset(0.22);
  const filter =
    `noise=alls=7:allf=t+u,` +
    `drawbox=x=${bx}:y=${by}:w=${bw}:h=${bh}:color=${c1}@0.35:t=fill,` +
    `drawbox=x=${i1.x}:y=${i1.y}:w=${i1.w}:h=${i1.h}:color=${c2}@0.4:t=fill,` +
    `drawbox=x=${i2.x}:y=${i2.y}:w=${i2.w}:h=${i2.h}:color=${c3}@0.35:t=fill,` +
    `gblur=sigma=${Math.max(2, Math.round(width / 640))}`;
  await run(
    det.ffmpeg.path,
    [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", `color=c=${paper}:s=${width}x${height}:d=1`,
      "-vf", filter,
      "-frames:v", "1",
      dest,
    ],
    { timeoutMs: 60_000 },
  );
  return { path: dest, source: "procedural" };
}

/**
 * Synthesize narration per cue so caption timings are exact, then stitch the
 * clips in-process. Falls back to a single utterance with proportional timings
 * if per-cue stitching is impossible.
 */
async function buildNarration({ cues, script, workDir, voice, rate, det, warnings, strict }) {
  const voiceWav = path.join(workDir, "voice.wav");
  if (!det.tts.engine) {
    if (strict) {
      const err = new Error(
        "No local TTS engine found (espeak-ng recommended). Run the `doctor` tool for an install command.",
      );
      err.code = "ENOTTS";
      throw err;
    }
    warnings.push("No TTS engine available — rendering without a voice track (captions + music only)");
    const total = cues.reduce((s, c) => s + estimateSpeechSec(c.text, rate), 0) + LEAD_IN_SEC;
    await writeFile(voiceWav, silentWav(total));
    return {
      path: voiceWav,
      engine: null,
      durationSec: total,
      cues: proportionalTimings(cues, total, { leadIn: LEAD_IN_SEC, tail: 0 }),
      cachedCues: 0,
    };
  }

  const cueDir = path.join(workDir, "cues");
  await mkdir(cueDir, { recursive: true });
  let results;
  try {
    results = await Promise.all(
      cues.map((c, i) =>
        synthesize(c.text, path.join(cueDir, `cue_${String(i).padStart(3, "0")}.wav`), {
          voice,
          rate,
          workDir: cueDir,
        }),
      ),
    );
  } catch (err) {
    if (strict) throw err;
    warnings.push(`Narration failed (${err.message}); rendering without a voice track`);
    const total = cues.reduce((s, c) => s + estimateSpeechSec(c.text, rate), 0) + LEAD_IN_SEC;
    await writeFile(voiceWav, silentWav(total));
    return {
      path: voiceWav,
      engine: null,
      durationSec: total,
      cues: proportionalTimings(cues, total, { leadIn: LEAD_IN_SEC, tail: 0 }),
      cachedCues: 0,
    };
  }

  const buffers = await Promise.all(results.map((r) => readFile(r.path)));
  try {
    const stitched = concatWavs(buffers, { gapSec: CUE_GAP_SEC, leadInSec: LEAD_IN_SEC });
    await writeFile(voiceWav, stitched.buffer);
    const timed = cues.map((c, i) => ({
      ...c,
      start: Math.max(0, stitched.segments[i].start - 0.05),
      end: i < cues.length - 1 ? stitched.segments[i + 1].start : stitched.segments[i].end + 0.15,
    }));
    return {
      path: voiceWav,
      engine: results[0].engine,
      durationSec: stitched.durationSec,
      cues: timed,
      cachedCues: results.filter((r) => r.cached).length,
    };
  } catch (err) {
    warnings.push(`Per-cue stitching unavailable (${err.message}); using proportional caption timing`);
    const whole = await synthesize(script, voiceWav, { voice, rate, workDir: cueDir });
    const info = parseWav(await readFile(voiceWav));
    return {
      path: voiceWav,
      engine: whole.engine,
      durationSec: info.durationSec,
      cues: proportionalTimings(cues, info.durationSec, { leadIn: 0.15, tail: 0.3 }),
      cachedCues: whole.cached ? 1 : 0,
    };
  }
}

function musicGraph(inputBase, durationSec, label) {
  const d = durationSec;
  const fade = (len) => `afade=t=in:st=0:d=${len},afade=t=out:st=${Math.max(0, d - len).toFixed(2)}:d=${len}`;
  return (
    `[${inputBase}:a]volume=0.05,${fade(1.2)}[m0];` +
    `[${inputBase + 1}:a]volume=0.04,${fade(1.5)}[m1];` +
    `[${inputBase + 2}:a]volume=0.35,lowpass=f=600,${fade(0.8)}[m2];` +
    `[m0][m1][m2]amix=inputs=3:normalize=0,volume=0.2,aformat=sample_rates=44100:channel_layouts=stereo[${label}]`
  );
}

function musicInputs(durationSec) {
  const d = (durationSec + 0.2).toFixed(3);
  return [
    "-f", "lavfi", "-i", `sine=frequency=174.61:sample_rate=44100:duration=${d}`,
    "-f", "lavfi", "-i", `sine=frequency=220:sample_rate=44100:duration=${d}`,
    "-f", "lavfi", "-i", `anoisesrc=color=pink:amplitude=0.015:sample_rate=44100:duration=${d}`,
  ];
}

function captionFilters({ cues, fontPath, width, height, workFiles }) {
  const fontSize = Math.max(16, Math.round(height * 0.041));
  const lineH = Math.round(fontSize * 1.32);
  const bottom = Math.round(height * 0.055);
  const border = Math.max(2, Math.round(fontSize / 14));
  const parts = [];
  cues.forEach((cue, ci) => {
    const lines = cue.lines;
    lines.forEach((line, li) => {
      const file = workFiles[`${ci}_${li}`];
      const y = height - bottom - (lines.length - li) * lineH;
      parts.push(
        `drawtext=fontfile=${escapeFilterValue(fontPath)}:textfile=${escapeFilterValue(file)}:expansion=none` +
          `:fontsize=${fontSize}:fontcolor=white:borderw=${border}:bordercolor=black@0.55` +
          `:x=(w-text_w)/2:y=${y}:enable='between(t,${cue.start.toFixed(3)},${cue.end.toFixed(3)})'`,
      );
    });
  });
  return parts;
}

function buildVideoGraph({ width, height, fps, frames, durationSec, captionMode, captionParts, srtPath, motion }) {
  const v = [];
  // Pixel-format conversion happens once, before frames are multiplied, so the
  // duplicated frames downstream are cheap references instead of per-frame
  // RGB->YUV conversions.
  if (motion === "pan") {
    const pw = Math.ceil((width * 1.08) / 2) * 2;
    const ph = Math.ceil((height * 1.08) / 2) * 2;
    const d = durationSec.toFixed(3);
    v.push(
      `[0:v]scale=${pw}:${ph}:force_original_aspect_ratio=increase:flags=bicubic,crop=${pw}:${ph},setsar=1,format=yuv420p,fps=${fps}`,
      `crop=${width}:${height}:x='(iw-ow)*min(t/${d}\\,1)':y='(ih-oh)*min(t/${d}\\,1)'`,
    );
  } else {
    v.push(
      `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase:flags=bicubic,crop=${width}:${height},setsar=1,format=yuv420p`,
    );
    if (motion === "zoom") {
      v.push(
        `zoompan=z='1+0.08*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps}`,
      );
    } else {
      v.push(`fps=${fps}`);
    }
  }
  if (captionMode === "drawtext") v.push(...captionParts);
  if (captionMode === "subtitles") {
    const style =
      "FontName=DejaVu Sans,FontSize=22,PrimaryColour=&H00FFFFFF&,OutlineColour=&H80000000&,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=36";
    v.push(`subtitles=${escapeFilterValue(srtPath)}:force_style='${style}'`);
  }
  return v.join(",") + "[v]";
}

/** Voice is input 0; music lavfi sources (if any) are inputs 1..3. */
function buildAudioGraph({ durationSec, music }) {
  const parts = [`[0:a]aformat=sample_rates=44100:channel_layouts=stereo,apad[vo]`];
  if (music) {
    parts.push(musicGraph(1, durationSec, "mu"));
    parts.push(`[vo][mu]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]`);
  } else {
    parts.push(`[vo]anull[a]`);
  }
  return parts.join(";");
}

function audioContainerExt(encoderName) {
  if (encoderName === "libmp3lame") return ".mp3";
  if (encoderName === "libopus") return ".mka";
  return ".m4a";
}

async function validateOutput(det, file, expectedSec) {
  const st = await stat(file);
  if (st.size < 10_000) throw new Error(`Output too small (${st.size} bytes)`);
  if (!det.ffprobe?.path) return { durationSec: expectedSec, validated: false };
  const { stdout } = await run(
    det.ffprobe.path,
    ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", file],
    { timeoutMs: 20_000 },
  );
  const info = JSON.parse(stdout);
  const types = new Set((info.streams || []).map((s) => s.codec_type));
  const dur = Number.parseFloat(info.format?.duration);
  if (!types.has("video")) throw new Error("Output has no video stream");
  if (!types.has("audio")) throw new Error("Output has no audio stream");
  if (!Number.isFinite(dur) || Math.abs(dur - expectedSec) > 1.0) {
    throw new Error(`Output duration ${dur}s differs from expected ${expectedSec.toFixed(2)}s`);
  }
  return { durationSec: dur, validated: true, bytes: st.size };
}

/**
 * Build a narrated, captioned video entirely offline in a single ffmpeg pass.
 *
 * Options beyond the original API:
 *   quality:    "fast" | "balanced" | "high"                   (default balanced)
 *   resolution: "1080p" | "720p" | "480p" | { width, height }   (default from preset)
 *   motion:     "zoom" | "pan" | "none"                          (default from preset)
 *   fps:        number                                          (default from preset)
 *   rate:       TTS words-per-minute                            (default 155)
 *   strict:     throw instead of degrading when TTS/captions are unavailable
 *   onProgress: ({ stage, pct, message }) => void
 */
export async function scriptToVideo({
  script,
  style = DEFAULT_STYLE,
  imagePath = null,
  imagePaths = null,
  outDir,
  captions = true,
  music = true,
  voice = DEFAULT_VOICE,
  rate = DEFAULT_RATE,
  projectId = null,
  quality = "balanced",
  resolution = null,
  motion = null,
  fps = null,
  strict = false,
  onProgress = null,
} = {}) {
  const t0 = performance.now();
  const timings = {};
  const warnings = [];
  const progress = (stage, pct, message) => {
    try {
      onProgress?.({ stage, pct, message });
    } catch {
      /* observer errors must not break the render */
    }
  };

  if (!script?.trim()) throw new Error("script is required");
  const preset = QUALITY_PRESETS[quality];
  if (!preset) throw new Error(`Unknown quality "${quality}" (use fast, balanced, high)`);
  const { width, height } = resolveResolution(resolution || preset.resolution);
  let motionMode = motion || preset.motion;
  if (!MOTION_MODES.includes(motionMode)) {
    throw new Error(`Unknown motion "${motionMode}" (use zoom, pan, none)`);
  }
  fps = Math.min(60, Math.max(12, Number(fps) || preset.fps));

  progress("detect", 2, "Detecting local tools");
  const det = await detect();
  timings.detectMs = det.detectMs;
  if (!det.ffmpeg?.path || det.ffmpeg.error) {
    const report = await doctor();
    const hint = report.install?.command ? ` Install: ${report.install.command}` : "";
    const err = new Error(`ffmpeg is required but was not found.${hint}`);
    err.code = "ENOFFMPEG";
    err.doctor = report;
    throw err;
  }
  if (!det.ffmpeg.videoEncoder || !det.ffmpeg.audioEncoder) {
    const err = new Error(
      `This ffmpeg build lacks a usable ${det.ffmpeg.videoEncoder ? "audio" : "video"} encoder (need libx264/mpeg4 + aac).`,
    );
    err.code = "ENOENCODER";
    throw err;
  }

  const id = projectId || `local_${randomUUID().slice(0, 8)}`;
  const root = outDir || path.join(process.cwd(), "output", id);
  const workDir = path.join(root, "work");
  await mkdir(workDir, { recursive: true });

  const chosenImage = imagePath || (Array.isArray(imagePaths) && imagePaths[0]) || null;
  const cleanScript = script.trim();
  const cues = segmentScript(cleanScript);

  progress("prepare", 8, "Synthesizing narration and preparing the still");
  const tPrep = performance.now();
  const [scene, narration] = await Promise.all([
    prepareImage({ imagePath: chosenImage, workDir, style, det, warnings, width, height, strict }),
    buildNarration({ cues, script: cleanScript, workDir, voice, rate, det, warnings, strict }),
  ]);
  timings.prepareMs = Math.round(performance.now() - tPrep);

  const durationSec = Number((narration.durationSec + TAIL_SEC).toFixed(3));
  const frames = Math.ceil(durationSec * fps) + 1;

  let captionMode = "none";
  const workFiles = {};
  const srtPath = path.join(workDir, "captions.srt");
  if (captions) {
    await writeFile(srtPath, buildSrt(narration.cues), "utf8");
    if (det.ffmpeg.filters.drawtext && det.font) {
      captionMode = "drawtext";
      await Promise.all(
        narration.cues.flatMap((cue, ci) =>
          cue.lines.map(async (line, li) => {
            const file = path.join(workDir, `cue_${ci}_${li}.txt`);
            workFiles[`${ci}_${li}`] = file;
            await writeFile(file, line, "utf8");
          }),
        ),
      );
    } else if (det.ffmpeg.filters.subtitles) {
      captionMode = "subtitles";
      warnings.push("drawtext/font unavailable — using slower libass subtitles renderer");
    } else {
      warnings.push("No caption renderer in this ffmpeg build — captions skipped");
      if (strict) throw new Error("Captions requested but no caption renderer is available");
    }
  }

  const outMp4 = path.join(root, "export.mp4");
  const encoder = det.ffmpeg.videoEncoder;
  const audioEnc = det.ffmpeg.audioEncoder;
  const audioArgs = [...audioEnc.args];
  if (audioEnc.name === "aac" && preset.aacCoder) audioArgs.push("-aac_coder", preset.aacCoder);

  const videoOnly = path.join(workDir, "video.mp4");
  const audioOnly = path.join(workDir, `audio${audioContainerExt(audioEnc.name)}`);
  const base = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];

  // Video and audio are encoded in two concurrent ffmpeg processes (ffmpeg < 7
  // serializes them inside one process), then stream-copied into the MP4.
  const renderVideo = async ({ motion: m, mode, videoArgs }) => {
    const captionParts =
      mode === "drawtext"
        ? captionFilters({ cues: narration.cues, fontPath: det.font.path, width, height, workFiles })
        : [];
    const graph = buildVideoGraph({
      width, height, fps, frames, durationSec, captionMode: mode, captionParts, srtPath, motion: m,
    });
    await run(
      det.ffmpeg.path,
      [
        ...base,
        "-loop", "1", "-framerate", "1", "-i", scene.path,
        "-filter_complex", graph,
        "-map", "[v]",
        "-t", durationSec.toFixed(3),
        "-r", String(fps),
        "-c:v", encoder.name, ...videoArgs,
        "-pix_fmt", "yuv420p",
        "-an",
        videoOnly,
      ],
      { timeoutMs: FFMPEG_TIMEOUT_MS },
    );
  };

  const renderAudio = async ({ withMusic }) => {
    await run(
      det.ffmpeg.path,
      [
        ...base,
        "-i", narration.path,
        ...(withMusic ? musicInputs(durationSec) : []),
        "-filter_complex", buildAudioGraph({ durationSec, music: withMusic }),
        "-map", "[a]",
        "-t", durationSec.toFixed(3),
        "-c:a", audioEnc.name, ...audioArgs,
        "-vn",
        audioOnly,
      ],
      { timeoutMs: FFMPEG_TIMEOUT_MS },
    );
  };

  const mux = async () => {
    await run(
      det.ffmpeg.path,
      [
        ...base,
        "-i", videoOnly,
        "-i", audioOnly,
        "-map", "0:v:0", "-map", "1:a:0",
        "-c", "copy",
        ...(audioEnc.name === "libopus" ? ["-strict", "-2"] : []),
        "-movflags", "+faststart",
        "-shortest",
        outMp4,
      ],
      { timeoutMs: 60_000 },
    );
    return validateOutput(det, outMp4, durationSec);
  };

  const describe = (err) => String(err?.message || err).split("\n")[0].slice(0, 200);

  progress("render", 35, "Rendering video and audio in parallel");
  const tRender = performance.now();
  if (motionMode === "zoom" && !det.ffmpeg.filters.zoompan) {
    warnings.push("zoompan filter unavailable — using crop-based pan motion");
    motionMode = "pan";
  }

  let renderPath = "fast";
  const primaryVideoArgs = encoder.name === "libx264" ? preset.x264 : encoder.args;
  const safeVideoArgs = encoder.name === "libx264" ? ["-preset", "ultrafast", "-crf", "23"] : encoder.args;

  const videoTask = renderVideo({ motion: motionMode, mode: captionMode, videoArgs: primaryVideoArgs }).catch(
    async (err) => {
      renderPath = "safe";
      const fallbackMode =
        captionMode === "drawtext" && det.ffmpeg.filters.subtitles ? "subtitles" : "none";
      warnings.push(`Fast video render failed (${describe(err)}); retrying with safe settings`);
      progress("render", 55, "Retrying video with safe render settings");
      await renderVideo({ motion: "none", mode: fallbackMode, videoArgs: safeVideoArgs });
      motionMode = "none";
      captionMode = fallbackMode;
    },
  );
  const audioTask = renderAudio({ withMusic: music }).catch(async (err) => {
    renderPath = "safe";
    if (music) {
      warnings.push(`Music bed failed (${describe(err)}); rendering voice only`);
      await renderAudio({ withMusic: false });
      return;
    }
    throw err;
  });

  let validation;
  try {
    await Promise.all([videoTask, audioTask]);
    progress("mux", 85, "Muxing");
    validation = await mux();
  } catch (err) {
    const final = new Error(`Render failed: ${err.message}`);
    final.code = "ERENDER";
    final.warnings = warnings;
    throw final;
  }
  timings.renderMs = Math.round(performance.now() - tRender);
  timings.totalMs = Math.round(performance.now() - t0);

  progress("done", 100, "Done");
  const meta = {
    projectId: id,
    status: warnings.length ? "succeeded_with_warnings" : "succeeded",
    script: cleanScript,
    style,
    imagePath: scene.path,
    imageSource: scene.source,
    durationSec: validation.durationSec ?? durationSec,
    width,
    height,
    fps,
    motion: motionMode,
    captions,
    captionMode,
    cues: narration.cues.map((c) => ({ text: c.text, start: Number(c.start.toFixed(3)), end: Number(c.end.toFixed(3)) })),
    captionsPath: captions ? srtPath : null,
    music,
    narration: {
      engine: narration.engine,
      voice,
      rate,
      cachedCues: narration.cachedCues,
      totalCues: cues.length,
    },
    encoder: { video: encoder.name, audio: audioEnc.name, quality, renderPath },
    downloadPath: outMp4,
    projectUrl: `file://${outMp4}`,
    bytes: validation.bytes ?? null,
    validated: validation.validated,
    warnings,
    timings,
    engine: "cursor-local-videogen",
    createdAt: new Date().toISOString(),
  };
  await writeFile(path.join(root, "project.json"), JSON.stringify(meta, null, 2));
  return meta;
}

export async function getMe() {
  const report = await doctor();
  const d = report.detection;
  return {
    engine: "cursor-local-videogen",
    displayName: "Local VideoGen (Cursor/Grok fork)",
    email: null,
    teamId: "local",
    status: report.status,
    ok: report.ok,
    dependencies: {
      ffmpeg: !!d.ffmpeg?.path && !d.ffmpeg.error,
      ffprobe: !!d.ffprobe?.path,
      espeakNg: d.tts.engine === "espeak-ng",
      tts: d.tts.engine,
      font: !!d.font,
      videoEncoder: d.ffmpeg?.videoEncoder?.name || null,
      audioEncoder: d.ffmpeg?.audioEncoder?.name || null,
    },
    install: report.install,
    issues: report.checks.filter((c) => !c.ok),
    detectMs: d.detectMs,
    notes:
      "No VideoGen cloud. Visuals: Cursor GenerateImage. Speech/music/captions/mux: local ffmpeg + TTS in one pass.",
  };
}

export { doctor };

/** Exposed for tests and benchmarks; not part of the public API. */
export const __internals = {
  buildVideoGraph,
  buildAudioGraph,
  captionFilters,
  musicInputs,
  resolveResolution,
  palette,
};

// allow reading project.json
export async function readProject(projectDir) {
  return JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
}
