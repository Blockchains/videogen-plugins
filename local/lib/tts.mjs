/**
 * Local text-to-speech with an engine chain and a content-addressed cache.
 * Every engine writes a PCM WAV file; callers never depend on which engine ran.
 */
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { run } from "./exec.mjs";
import { CACHE_DIR, detect } from "./detect.mjs";
import { parseWav } from "./wav.mjs";

export const DEFAULT_VOICE = "en-us+f3";
export const DEFAULT_RATE = 155;

const TTS_TIMEOUT_MS = 60_000;

function cacheKey({ engine, text, voice, rate }) {
  return createHash("sha1").update(`${engine}|${voice}|${rate}|${text}`).digest("hex");
}

function looksLikeEspeakVoice(voice) {
  return /^[a-z]{2}(-[a-z0-9-]+)?(\+[a-z0-9]+)?$/i.test(voice || "");
}

async function synthWithEngine(engine, binPath, text, outWav, { voice, rate, workDir }) {
  switch (engine) {
    case "espeak-ng":
    case "espeak":
      await run(
        binPath,
        ["-v", voice, "-s", String(rate), "-w", outWav, "--stdin"],
        { input: text, timeoutMs: TTS_TIMEOUT_MS },
      );
      return;
    case "say": {
      const args = ["-o", outWav, "--data-format=LEI16@22050", "-r", String(Math.round(rate * 1.1))];
      if (voice && !looksLikeEspeakVoice(voice)) args.push("-v", voice);
      args.push("-f", "-");
      await run(binPath, args, { input: text, timeoutMs: TTS_TIMEOUT_MS });
      return;
    }
    case "flite": {
      const txt = path.join(workDir, `tts_${process.pid}_${Date.now()}.txt`);
      await writeFile(txt, text, "utf8");
      try {
        const args = ["-f", txt, "-o", outWav];
        if (voice && !looksLikeEspeakVoice(voice)) args.unshift("-voice", voice);
        await run(binPath, args, { timeoutMs: TTS_TIMEOUT_MS });
      } finally {
        await rm(txt, { force: true });
      }
      return;
    }
    case "pico2wave":
      await run(binPath, ["-l", "en-US", "-w", outWav, text], { timeoutMs: TTS_TIMEOUT_MS });
      return;
    case "sapi": {
      const txt = path.join(workDir, `tts_${process.pid}_${Date.now()}.txt`);
      await writeFile(txt, text, "utf8");
      const ps = (s) => s.replace(/'/g, "''");
      try {
        await run(
          binPath,
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${ps(outWav)}'); $s.Speak([IO.File]::ReadAllText('${ps(txt)}')); $s.Dispose()`,
          ],
          { timeoutMs: TTS_TIMEOUT_MS },
        );
      } finally {
        await rm(txt, { force: true });
      }
      return;
    }
    default:
      throw new Error(`Unknown TTS engine: ${engine}`);
  }
}

async function validWav(file) {
  try {
    const st = await stat(file);
    if (st.size < 64) return false;
    const info = parseWav(await readFile(file));
    return info.durationSec > 0.05;
  } catch {
    return false;
  }
}

/**
 * Synthesize `text` to a WAV file, returning `{ path, engine, cached, durationSec }`.
 * Results are cached under CACHE_DIR/tts by (engine, voice, rate, text).
 * Falls through the engine chain if the preferred engine fails.
 */
export async function synthesize(text, outWav, { voice = DEFAULT_VOICE, rate = DEFAULT_RATE, workDir } = {}) {
  const d = await detect();
  const available = d.tts.candidates.filter((c) => c.path);
  if (!available.length) {
    const err = new Error("No local TTS engine available (espeak-ng, espeak, say, flite, pico2wave)");
    err.code = "ENOTTS";
    throw err;
  }
  const dir = workDir || path.dirname(outWav) || os.tmpdir();
  await mkdir(path.dirname(outWav), { recursive: true });

  let lastErr = null;
  for (const cand of available) {
    const key = cacheKey({ engine: cand.id, text, voice, rate });
    const cacheDir = path.join(CACHE_DIR, "tts");
    const cached = path.join(cacheDir, `${key}.wav`);
    if (await validWav(cached)) {
      await copyFile(cached, outWav);
      const info = parseWav(await readFile(outWav));
      return { path: outWav, engine: cand.id, cached: true, durationSec: info.durationSec };
    }
    try {
      await synthWithEngine(cand.id, cand.path, text, outWav, { voice, rate, workDir: dir });
      if (!(await validWav(outWav))) throw new Error(`${cand.id} produced an empty WAV`);
      const info = parseWav(await readFile(outWav));
      try {
        await mkdir(cacheDir, { recursive: true });
        const tmp = `${cached}.${process.pid}.tmp`;
        await copyFile(outWav, tmp);
        await rename(tmp, cached);
      } catch {
        /* cache is best-effort */
      }
      return { path: outWav, engine: cand.id, cached: false, durationSec: info.durationSec };
    } catch (err) {
      lastErr = err;
    }
  }
  const err = new Error(`All TTS engines failed: ${lastErr?.message || lastErr}`);
  err.code = "ETTSFAIL";
  err.cause = lastErr;
  throw err;
}
