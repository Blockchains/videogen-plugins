#!/usr/bin/env node
import path from "node:path";
import {
  scriptToVideo,
  getMe,
  doctor,
  DEFAULT_STYLE,
  QUALITY_PRESETS,
  RESOLUTIONS,
  MOTION_MODES,
} from "./lib/pipeline.mjs";

function usage() {
  console.error(`Usage:
  node local/cli.mjs me                      # engine status + dependency summary
  node local/cli.mjs doctor [--json]         # full health report with install commands
  node local/cli.mjs script-to-video --script "..." [options]
  node local/cli.mjs bench [--script "..."] [--image PATH]   # time every quality preset

script-to-video options:
  --image PATH          still image from Cursor GenerateImage (falls back to a procedural still)
  --style "..."         visual style paragraph (used for the procedural still)
  --out DIR             output directory (default /opt/cursor/artifacts/videogen_<ts>)
  --quality ${Object.keys(QUALITY_PRESETS).join("|")}   (default balanced)
  --resolution ${Object.keys(RESOLUTIONS).join("|")}|WxH   (default from preset)
  --motion ${MOTION_MODES.join("|")}        (default from preset)
  --fps N               (default from preset)
  --voice ID            TTS voice (default en-us+f3)
  --rate WPM            TTS speaking rate (default 155)
  --no-captions         skip burned-in captions
  --no-music            skip ambient music bed
  --strict              fail instead of degrading when TTS/captions are unavailable
  --quiet               print only the output path

Environment:
  SCRIPT, STYLE, IMAGE_PATH, OUT_DIR, VOICE, QUALITY
  VIDEOGEN_FFMPEG, VIDEOGEN_FFPROBE, VIDEOGEN_ESPEAK, VIDEOGEN_FONT, VIDEOGEN_CACHE_DIR, VIDEOGEN_DEBUG
`);
}

const args = process.argv.slice(2);
const cmd = args[0];

function flag(name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  return args[i + 1] ?? null;
}
function has(name) {
  return args.includes(name);
}

function parseResolution(v) {
  if (!v) return null;
  const m = /^(\d+)x(\d+)$/i.exec(v);
  if (m) return { width: Number(m[1]), height: Number(m[2]) };
  return v;
}

function printDoctor(report) {
  const icon = (c) => (c.ok ? "ok  " : c.level === "error" ? "FAIL" : "warn");
  console.log(`Local VideoGen doctor — status: ${report.status.toUpperCase()}`);
  for (const c of report.checks) {
    console.log(`  [${icon(c)}] ${c.id.padEnd(14)} ${c.detail}`);
    if (c.fix) console.log(`         fix: ${c.fix}`);
  }
  if (report.install?.command) {
    console.log(`\nInstall missing dependencies:\n  ${report.install.command}`);
  }
  const d = report.detection;
  console.log(
    `\nDetected in ${d.detectMs}ms on ${d.platform}/${d.arch} (${d.cpus} CPUs), cache: ${d.cacheDir}`,
  );
}

async function main() {
  if (!cmd || cmd === "-h" || cmd === "--help") {
    usage();
    process.exit(cmd ? 0 : 1);
  }

  if (cmd === "me") {
    console.log(JSON.stringify(await getMe(), null, 2));
    return;
  }

  if (cmd === "doctor") {
    const report = await doctor({ refresh: true });
    if (has("--json")) console.log(JSON.stringify(report, null, 2));
    else printDoctor(report);
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  if (cmd === "bench") {
    const script =
      flag("--script") ||
      process.env.SCRIPT ||
      "Staying hydrated keeps your body and mind running at their best. Drink a glass of water when you wake up, and keep a bottle nearby through the day.";
    const imagePath = flag("--image") || process.env.IMAGE_PATH || null;
    const outRoot = flag("--out") || path.join(process.env.TMPDIR || "/tmp", `videogen_bench_${Date.now()}`);
    const rows = [];
    for (const quality of Object.keys(QUALITY_PRESETS)) {
      const t = performance.now();
      const r = await scriptToVideo({ script, imagePath, quality, outDir: path.join(outRoot, quality) });
      rows.push({
        quality,
        size: `${r.width}x${r.height}@${r.fps}`,
        motion: r.motion,
        clipSec: r.durationSec.toFixed(1),
        wallMs: Math.round(performance.now() - t),
        renderMs: r.timings.renderMs,
        kb: Math.round((r.bytes || 0) / 1024),
        warnings: r.warnings.length,
      });
    }
    console.table(rows);
    console.log(`Outputs under ${outRoot}`);
    return;
  }

  if (cmd === "script-to-video") {
    const script = flag("--script") || process.env.SCRIPT;
    if (!script) {
      usage();
      process.exit(1);
    }
    const result = await scriptToVideo({
      script,
      style: flag("--style") || process.env.STYLE || DEFAULT_STYLE,
      imagePath: flag("--image") || process.env.IMAGE_PATH || null,
      outDir:
        flag("--out") ||
        process.env.OUT_DIR ||
        path.join(process.env.VIDEOGEN_OUT_DIR || "/opt/cursor/artifacts", `videogen_${Date.now()}`),
      voice: flag("--voice") || process.env.VOICE || undefined,
      rate: flag("--rate") ? Number(flag("--rate")) : undefined,
      quality: flag("--quality") || process.env.QUALITY || "balanced",
      resolution: parseResolution(flag("--resolution")),
      motion: flag("--motion") || null,
      fps: flag("--fps") ? Number(flag("--fps")) : null,
      captions: !has("--no-captions"),
      music: !has("--no-music"),
      strict: has("--strict"),
      onProgress: has("--quiet")
        ? null
        : ({ stage, pct, message }) => process.stderr.write(`[${String(pct).padStart(3)}%] ${stage}: ${message}\n`),
    });
    if (has("--quiet")) console.log(result.downloadPath);
    else console.log(JSON.stringify(result, null, 2));
    if (result.warnings.length) {
      for (const w of result.warnings) process.stderr.write(`warning: ${w}\n`);
    }
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  usage();
  process.exit(1);
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  if (err.doctor?.install?.command) console.error(`install: ${err.doctor.install.command}`);
  if (process.env.VIDEOGEN_DEBUG) console.error(err);
  process.exit(1);
});
