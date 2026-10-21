import { mkdir, writeFile, readFile, copyFile, access } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { run, which } from "./exec.mjs";

const DEFAULT_STYLE =
  "Loose watercolor illustration, visible brushstrokes, soft color bleeds, paper texture, muted palette. A clear uncluttered subject centered in the frame, occupying only the middle half of the image, with generous empty margins on all four sides, no background clutter.";

function wrapCaptionLines(text, maxLen = 42) {
  const words = text.trim().split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxLen && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function formatSrtTime(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  const whole = Math.floor(rem);
  const ms = Math.round((rem - whole) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(whole).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

async function probeDuration(file) {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const n = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Bad duration for ${file}`);
  return n;
}

async function synthesizeSpeech(script, outWav, { voice = "en-us+f3", rate = 155 } = {}) {
  if (!(await which("espeak-ng"))) {
    throw new Error(
      "espeak-ng is required for local narration. Install with: sudo apt-get install -y espeak-ng",
    );
  }
  await run("espeak-ng", [
    "-v",
    voice,
    "-s",
    String(rate),
    "-w",
    outWav,
    script,
  ]);
  return outWav;
}

async function synthesizeMusic(durationSec, outWav) {
  // Soft ambient bed: low pads + gentle noise, no external samples.
  const d = Math.max(durationSec + 0.4, 2);
  await run("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=174.61:sample_rate=44100:duration=${d}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=220:sample_rate=44100:duration=${d}`,
    "-f",
    "lavfi",
    "-i",
    `anoisesrc=color=pink:amplitude=0.015:sample_rate=44100:duration=${d}`,
    "-filter_complex",
    "[0:a]volume=0.05,afade=t=in:st=0:d=1.2,afade=t=out:st=" +
      (d - 1.2).toFixed(2) +
      ":d=1.2[a0];" +
      "[1:a]volume=0.04,afade=t=in:st=0:d=1.5,afade=t=out:st=" +
      (d - 1.5).toFixed(2) +
      ":d=1.5[a1];" +
      "[2:a]volume=0.35,lowpass=f=600,afade=t=in:st=0:d=0.8,afade=t=out:st=" +
      (d - 0.8).toFixed(2) +
      ":d=0.8[a2];" +
      "[a0][a1][a2]amix=inputs=3:normalize=0,volume=0.7[aout]",
    "-map",
    "[aout]",
    outWav,
  ]);
  return outWav;
}

async function mixAudio(voiceWav, musicWav, outWav) {
  await run("ffmpeg", [
    "-y",
    "-i",
    voiceWav,
    "-i",
    musicWav,
    "-filter_complex",
    "[0:a]volume=1.0[v];[1:a]volume=0.28[m];[v][m]amix=inputs=2:duration=first:normalize=0[a]",
    "-map",
    "[a]",
    outWav,
  ]);
  return outWav;
}

async function writeSrt(captionText, durationSec, outPath) {
  const lines = wrapCaptionLines(captionText);
  const srt = `1
00:00:00,000 --> ${formatSrtTime(durationSec)}
${lines.join("\n")}
`;
  await writeFile(outPath, srt, "utf8");
  return outPath;
}

async function ensureImage(imagePath, workDir, style) {
  if (imagePath) {
    await access(imagePath);
    const dest = path.join(workDir, `scene${path.extname(imagePath) || ".png"}`);
    await copyFile(imagePath, dest);
    return dest;
  }
  // Procedural soft paper + centered glass-like blob (no external AI).
  const dest = path.join(workDir, "scene.png");
  const promptNote = (style || DEFAULT_STYLE).slice(0, 80);
  await run("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=0xE8E2D6:s=1920x1080:d=1",
    "-f",
    "lavfi",
    "-i",
    "anoisesrc=color=pink:amplitude=0.2:sample_rate=44100:duration=1",
    "-filter_complex",
    "[1:a]showspectrum=s=1920x1080:mode=combined:color=intensity:scale=log,format=rgba,colorchannelmixer=aa=0.12[noise];" +
      "[0:v]format=rgba[base];" +
      "[base][noise]overlay=0:0," +
      "drawbox=x=780:y=280:w=360:h=520:color=0x7AA6C2@0.35:t=fill," +
      "drawbox=x=820:y=320:w=280:h=420:color=0xB7D3E3@0.4:t=fill," +
      "drawbox=x=860:y=380:w=200:h=280:color=0xEAF4F8@0.35:t=fill," +
      "gblur=sigma=2," +
      `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='${promptNote.replace(/:/g, "\\:").replace(/'/g, "")}':fontsize=1:fontcolor=white@0.0:x=10:y=10`,
    "-frames:v",
    "1",
    dest,
  ]);
  return dest;
}

async function renderKenBurns(imagePath, durationSec, srtPath, outMp4) {
  const frames = Math.max(Math.ceil(durationSec * 30), 30);
  const d = durationSec.toFixed(3);
  // Escape path for ffmpeg filtergraph / subtitles filter.
  const srtEsc = srtPath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
  const style =
    "FontName=DejaVu Sans,FontSize=22,PrimaryColour=&H00FFFFFF&,OutlineColour=&H80000000&,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=36";
  const filter =
    `scale=2200:1238:force_original_aspect_ratio=increase,` +
    `crop=1920:1080,` +
    `zoompan=z='min(zoom+0.00035,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1920x1080:fps=30,` +
    `subtitles='${srtEsc}':force_style='${style}'`;

  await run("ffmpeg", [
    "-y",
    "-loop",
    "1",
    "-i",
    imagePath,
    "-vf",
    filter,
    "-t",
    d,
    "-r",
    "30",
    "-pix_fmt",
    "yuv420p",
    "-an",
    outMp4,
  ]);
  return outMp4;
}

/**
 * Build a narrated captioned video entirely offline.
 */
export async function scriptToVideo({
  script,
  style = DEFAULT_STYLE,
  imagePath = null,
  imagePaths = null,
  outDir,
  captions = true,
  music = true,
  voice = "en-us+f3",
  projectId = null,
} = {}) {
  if (!script?.trim()) throw new Error("script is required");
  if (!(await which("ffmpeg")) || !(await which("ffprobe"))) {
    throw new Error("ffmpeg and ffprobe are required");
  }

  const id = projectId || `local_${randomUUID().slice(0, 8)}`;
  const root = outDir || path.join(process.cwd(), "output", id);
  const workDir = path.join(root, "work");
  await mkdir(workDir, { recursive: true });

  const chosenImage =
    imagePath ||
    (Array.isArray(imagePaths) && imagePaths[0]) ||
    null;

  const sceneImage = await ensureImage(chosenImage, workDir, style);
  const voiceWav = path.join(workDir, "voice.wav");
  await synthesizeSpeech(script.trim(), voiceWav, { voice });
  const voiceDur = await probeDuration(voiceWav);
  const duration = voiceDur + 0.35;

  const musicWav = path.join(workDir, "music.wav");
  if (music) await synthesizeMusic(duration, musicWav);
  else {
    await run("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `anullsrc=r=44100:cl=stereo:d=${duration}`,
      musicWav,
    ]);
  }

  const mixWav = path.join(workDir, "mix.wav");
  await mixAudio(voiceWav, musicWav, mixWav);

  const srtPath = path.join(workDir, "captions.srt");
  if (captions) await writeSrt(script.trim(), duration, srtPath);
  else await writeSrt(" ", duration, srtPath);

  const videoSilent = path.join(workDir, "video_silent.mp4");
  await renderKenBurns(sceneImage, duration, srtPath, videoSilent);

  const outMp4 = path.join(root, "export.mp4");
  await run("ffmpeg", [
    "-y",
    "-i",
    videoSilent,
    "-i",
    mixWav,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-shortest",
    "-movflags",
    "+faststart",
    outMp4,
  ]);

  const meta = {
    projectId: id,
    status: "succeeded",
    script: script.trim(),
    style,
    imagePath: sceneImage,
    durationSec: duration,
    captions,
    music,
    downloadPath: outMp4,
    projectUrl: `file://${outMp4}`,
    engine: "cursor-local-videogen",
    createdAt: new Date().toISOString(),
  };
  await writeFile(path.join(root, "project.json"), JSON.stringify(meta, null, 2));
  return meta;
}

export async function getMe() {
  return {
    engine: "cursor-local-videogen",
    displayName: "Local VideoGen (Cursor/Grok fork)",
    email: null,
    teamId: "local",
    dependencies: {
      ffmpeg: await which("ffmpeg"),
      ffprobe: await which("ffprobe"),
      espeakNg: await which("espeak-ng"),
    },
    notes:
      "No VideoGen cloud. Visuals: Cursor GenerateImage. Speech/music/captions/mux: local ffmpeg + espeak-ng.",
  };
}

export { DEFAULT_STYLE };

// allow reading project.json
export async function readProject(projectDir) {
  return JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
}
