#!/usr/bin/env node
/**
 * Zero-dependency (beyond Node) stdio MCP server for local VideoGen.
 * No videogen.io / @videogen/* network calls.
 */
import { createInterface } from "node:readline";
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
import { detect } from "./lib/detect.mjs";
import { synthesize, DEFAULT_VOICE, DEFAULT_RATE } from "./lib/tts.mjs";

const SERVER_INFO = {
  name: "cursor-local-videogen",
  version: "2.1.0",
};

const TOOLS = [
  {
    name: "get_me",
    description:
      "Return local VideoGen engine status: readiness (ready/degraded/blocked), detected ffmpeg/TTS/font, and an install command if something is missing. No cloud account.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "doctor",
    description:
      "Full dependency health report with per-check fixes and a platform-specific install command. Re-scans tools (use after installing something).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_getting_started_guidance",
    description: "How to produce videos with this local Cursor/Grok VideoGen fork.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "script_to_video",
    description:
      "Narrated script→video with timed captions and ambient music, assembled locally (parallel ffmpeg + local TTS, ~1s for a 15s clip at quality=fast). Pass imagePath(s) from Cursor GenerateImage for best visuals; otherwise a procedural still is used. Degrades gracefully (e.g. no TTS → captions+music only) and reports `warnings`; set strict=true to fail instead.",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "Narration script / voiceover text" },
        style: {
          type: "string",
          description: "Visual style paragraph (used when no image is provided)",
        },
        imagePath: {
          type: "string",
          description: "Absolute path to a still image (from Cursor GenerateImage)",
        },
        imagePaths: {
          type: "array",
          items: { type: "string" },
          description: "Optional still images; first is used as the hero frame",
        },
        captions: { type: "boolean", default: true },
        music: { type: "boolean", default: true },
        voice: { type: "string", description: "TTS voice id (espeak-ng style, e.g. en-us+f3)", default: DEFAULT_VOICE },
        rate: { type: "number", description: "TTS words per minute", default: DEFAULT_RATE },
        quality: {
          type: "string",
          enum: Object.keys(QUALITY_PRESETS),
          default: "balanced",
          description:
            "fast = 720p/24fps/pan, fastest for drafts; balanced = 1080p/30fps Ken Burns; high = 1080p slower encode",
        },
        resolution: {
          type: "string",
          enum: Object.keys(RESOLUTIONS),
          description: "Override the preset resolution",
        },
        motion: { type: "string", enum: MOTION_MODES, description: "Override the preset camera motion" },
        fps: { type: "number", description: "Override the preset frame rate (12-60)" },
        strict: {
          type: "boolean",
          default: false,
          description: "Fail instead of degrading when narration or captions cannot be produced",
        },
        outDir: { type: "string", description: "Output directory for the project" },
      },
      required: ["script"],
      additionalProperties: false,
    },
  },
  {
    name: "text_to_speech",
    description:
      "Synthesize narration audio locally to a WAV file (espeak-ng, with espeak/say/flite/pico2wave fallbacks). Cached by content.",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string" },
        voice: { type: "string", default: DEFAULT_VOICE },
        rate: { type: "number", default: DEFAULT_RATE },
        outPath: { type: "string" },
      },
      required: ["script", "outPath"],
      additionalProperties: false,
    },
  },
];

function guidance() {
  return `# Local VideoGen (Cursor / Grok fork)

This fork does **not** call videogen.io, mcp.videogen.io, or @videogen/* APIs.

## Pipeline
1. **Check** — Call \`get_me\` once. If status is \`blocked\`, run the returned install command (or \`doctor\` for details). \`degraded\` still renders, with warnings.
2. **Visuals** — Use Cursor \`GenerateImage\` with the user's style paragraph. Save the image path.
3. **Assemble** — Call \`script_to_video\` with \`script\`, \`style\`, and \`imagePath\`.
   - Iterating on wording? Use \`quality: "fast"\` (720p, ~1s). Final export: \`balanced\` (default) or \`high\`.
   - Narration is synthesized per sentence and cached, so re-renders after small edits are near-instant.
4. **Output** — Read \`downloadPath\` from the result (local MP4). \`captionsPath\` is an SRT sidecar. Copy to \`/opt/cursor/artifacts\` when presenting. Check \`warnings\`.

## Defaults for narrated explainers
- captions: true (timed per sentence, burned in with drawtext)
- music: true (procedural ambient bed)
- motion: Ken Burns zoom (balanced/high) or slow pan (fast)

## Dependencies (local only)
- ffmpeg / ffprobe (libx264 + aac preferred; mpeg4/libopenh264 and mp3/opus are accepted)
- A TTS engine: espeak-ng (preferred), espeak, macOS say, flite, pico2wave, or Windows SAPI
- A TTF font for captions (DejaVu/Liberation/Noto/Arial auto-detected; override with VIDEOGEN_FONT)
- Cursor GenerateImage (agent-side) for AI stills

Default style lock:
${DEFAULT_STYLE}
`;
}

async function callTool(name, args = {}, { progress } = {}) {
  switch (name) {
    case "get_me":
      return getMe();
    case "doctor":
      return doctor({ refresh: true });
    case "get_getting_started_guidance":
      return { markdown: guidance() };
    case "script_to_video": {
      const outDir =
        args.outDir ||
        path.join(process.env.VIDEOGEN_OUT_DIR || "/opt/cursor/artifacts", `videogen_${Date.now()}`);
      return scriptToVideo({
        script: args.script,
        style: args.style || DEFAULT_STYLE,
        imagePath: args.imagePath || null,
        imagePaths: args.imagePaths || null,
        captions: args.captions !== false,
        music: args.music !== false,
        voice: args.voice || DEFAULT_VOICE,
        rate: args.rate || DEFAULT_RATE,
        quality: args.quality || "balanced",
        resolution: args.resolution || null,
        motion: args.motion || null,
        fps: args.fps || null,
        strict: args.strict === true,
        outDir,
        onProgress: progress,
      });
    }
    case "text_to_speech": {
      const r = await synthesize(args.script, args.outPath, {
        voice: args.voice || DEFAULT_VOICE,
        rate: args.rate || DEFAULT_RATE,
      });
      return { outPath: r.path, engine: r.engine, cached: r.cached, durationSec: r.durationSec };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function ok(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function summarize(name, result) {
  if (name === "script_to_video") {
    const warn = result.warnings?.length ? ` Warnings: ${result.warnings.join(" | ")}` : "";
    return `Video ready: ${result.downloadPath} (${result.durationSec.toFixed(1)}s, ${result.width}x${result.height}, rendered in ${result.timings.totalMs}ms).${warn}`;
  }
  if (name === "get_me") {
    return `Local VideoGen is ${result.status}${result.install?.command ? `. Install: ${result.install.command}` : ""}.`;
  }
  if (name === "doctor") {
    return `Status ${result.status}: ${result.checks.filter((c) => !c.ok).map((c) => c.detail).join("; ") || "all checks passed"}`;
  }
  return null;
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    ok(id, {
      protocolVersion: params?.protocolVersion || "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
    return;
  }
  if (method === "notifications/initialized" || method === "initialized") {
    return;
  }
  if (method === "ping") {
    ok(id, {});
    return;
  }
  if (method === "tools/list") {
    ok(id, { tools: TOOLS });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    const token = params?._meta?.progressToken;
    const progress =
      token === undefined
        ? null
        : ({ pct, message }) =>
            send({
              jsonrpc: "2.0",
              method: "notifications/progress",
              params: { progressToken: token, progress: pct, total: 100, message },
            });
    try {
      const result = await callTool(name, args, { progress });
      const summary = summarize(name, result);
      ok(id, {
        content: [
          ...(summary ? [{ type: "text", text: summary }] : []),
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
        structuredContent: result,
      });
    } catch (err) {
      const hint = err?.doctor?.install?.command ? `\nInstall: ${err.doctor.install.command}` : "";
      ok(id, {
        isError: true,
        content: [{ type: "text", text: `${String(err?.message || err)}${hint}` }],
      });
    }
    return;
  }
  if (id !== undefined) fail(id, -32601, `Method not found: ${method}`);
}

// Warm the capability cache while the host finishes its handshake.
detect().catch(() => {});

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  const messages = Array.isArray(msg) ? msg : [msg];
  for (const m of messages) {
    pending++;
    handle(m)
      .catch((err) => {
        if (m?.id !== undefined) fail(m.id, -32000, String(err?.message || err));
      })
      .finally(() => {
        pending--;
        maybeExit();
      });
  }
});

// Exit once the host closes stdin and all in-flight tool calls have replied.
let pending = 0;
let stdinClosed = false;
function maybeExit() {
  if (stdinClosed && pending === 0) process.exit(0);
}
process.stdin.on("end", () => {
  stdinClosed = true;
  maybeExit();
});
