#!/usr/bin/env node
/**
 * Zero-dependency (beyond Node) stdio MCP server for local VideoGen.
 * No videogen.io / @videogen/* network calls.
 */
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptToVideo, getMe, DEFAULT_STYLE } from "./lib/pipeline.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_INFO = {
  name: "cursor-local-videogen",
  version: "1.0.0",
};

const TOOLS = [
  {
    name: "get_me",
    description:
      "Return local VideoGen engine status and dependency checks (ffmpeg, espeak-ng). No cloud account.",
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
      "Narrated script→video with captions and ambient music, assembled locally with ffmpeg + espeak-ng. Pass imagePath(s) from Cursor GenerateImage for best visuals; otherwise a procedural still is used.",
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
        voice: { type: "string", description: "espeak-ng voice id", default: "en-us+f3" },
        outDir: { type: "string", description: "Output directory for the project" },
      },
      required: ["script"],
      additionalProperties: false,
    },
  },
  {
    name: "text_to_speech",
    description: "Synthesize narration audio locally with espeak-ng (WAV).",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string" },
        voice: { type: "string", default: "en-us+f3" },
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
1. **Visuals** — Use Cursor \`GenerateImage\` with the user's style paragraph. Save the image path.
2. **Assemble** — Call \`script_to_video\` with \`script\`, \`style\`, and \`imagePath\`.
3. **Output** — Read \`downloadPath\` from the result (local MP4). Copy to \`/opt/cursor/artifacts\` when presenting.

## Defaults for narrated explainers
- captions: true
- music: true (procedural ambient bed via ffmpeg)
- Ken Burns slow zoom on the still

## Dependencies (local only)
- ffmpeg / ffprobe
- espeak-ng
- Cursor GenerateImage (agent-side) for AI stills

Default style lock:
${DEFAULT_STYLE}
`;
}

async function callTool(name, args = {}) {
  switch (name) {
    case "get_me":
      return getMe();
    case "get_getting_started_guidance":
      return { markdown: guidance() };
    case "script_to_video": {
      const outDir =
        args.outDir ||
        path.join(
          process.env.VIDEOGEN_OUT_DIR || "/opt/cursor/artifacts",
          `videogen_${Date.now()}`,
        );
      return scriptToVideo({
        script: args.script,
        style: args.style || DEFAULT_STYLE,
        imagePath: args.imagePath || null,
        imagePaths: args.imagePaths || null,
        captions: args.captions !== false,
        music: args.music !== false,
        voice: args.voice || "en-us+f3",
        outDir,
      });
    }
    case "text_to_speech": {
      const { run } = await import("./lib/exec.mjs");
      await run("espeak-ng", [
        "-v",
        args.voice || "en-us+f3",
        "-w",
        args.outPath,
        args.script,
      ]);
      return { outPath: args.outPath, engine: "espeak-ng" };
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
    try {
      const result = await callTool(name, args);
      ok(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      });
    } catch (err) {
      ok(id, {
        isError: true,
        content: [{ type: "text", text: String(err?.message || err) }],
      });
    }
    return;
  }
  if (id !== undefined) fail(id, -32601, `Method not found: ${method}`);
}

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
  handle(msg).catch((err) => {
    if (msg?.id !== undefined) fail(msg.id, -32000, String(err?.message || err));
  });
});

// Keep alive
process.stdin.on("end", () => process.exit(0));
