#!/usr/bin/env node
import path from "node:path";
import { scriptToVideo, getMe, DEFAULT_STYLE } from "./lib/pipeline.mjs";

function usage() {
  console.error(`Usage:
  node local/cli.mjs me
  node local/cli.mjs script-to-video --script "..." [--image PATH] [--style "..."] [--out DIR]

Environment:
  SCRIPT, STYLE, IMAGE_PATH, OUT_DIR, VOICE
`);
}

const args = process.argv.slice(2);
const cmd = args[0];

function flag(name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  return args[i + 1] ?? null;
}

if (!cmd || cmd === "-h" || cmd === "--help") {
  usage();
  process.exit(cmd ? 0 : 1);
}

if (cmd === "me") {
  console.log(JSON.stringify(await getMe(), null, 2));
  process.exit(0);
}

if (cmd === "script-to-video") {
  const script = flag("--script") || process.env.SCRIPT;
  const style = flag("--style") || process.env.STYLE || DEFAULT_STYLE;
  const imagePath = flag("--image") || process.env.IMAGE_PATH || null;
  const outDir =
    flag("--out") ||
    process.env.OUT_DIR ||
    path.join("/opt/cursor/artifacts", `videogen_${Date.now()}`);
  const voice = flag("--voice") || process.env.VOICE || "en-us+f3";
  if (!script) {
    usage();
    process.exit(1);
  }
  const result = await scriptToVideo({
    script,
    style,
    imagePath,
    outDir,
    voice,
    captions: true,
    music: true,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

console.error(`Unknown command: ${cmd}`);
usage();
process.exit(1);
