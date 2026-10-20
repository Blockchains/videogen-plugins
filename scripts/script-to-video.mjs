#!/usr/bin/env node
/**
 * Cloud-agent-friendly VideoGen script→video runner.
 * Auth: VIDEOGEN_API_KEY (https://app.videogen.io/api). Do not paste keys into chat.
 *
 * Usage:
 *   node scripts/script-to-video.mjs
 *   SCRIPT="..." STYLE="..." node scripts/script-to-video.mjs
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { VideoGen } from "@videogen/sdk";

const script =
  process.env.SCRIPT ??
  "Staying hydrated keeps your body and mind running at their best.";

const style =
  process.env.STYLE ??
  "Loose watercolor illustration, visible brushstrokes, soft color bleeds, paper texture, muted palette. A clear uncluttered subject centered in the frame, occupying only the middle half of the image, with generous empty margins on all four sides, no background clutter.";

const musicPrompt =
  process.env.MUSIC_PROMPT ??
  "Soft calm ambient instrumental background music, gentle piano and warm pads, muted and unobtrusive under narration";

const quality = process.env.QUALITY ?? "HIGH";
const outDir = process.env.OUT_DIR ?? "/opt/cursor/artifacts";

if (!process.env.VIDEOGEN_API_KEY) {
  console.error(
    "Missing VIDEOGEN_API_KEY. Create a key at https://app.videogen.io/api and add it as a Cloud Agent secret named VIDEOGEN_API_KEY.",
  );
  process.exit(1);
}

const vg = new VideoGen({ apiKey: process.env.VIDEOGEN_API_KEY });

const me = await vg.account.getMe();
console.error(`Authenticated as ${me.email ?? me.displayName ?? "team"}`);

console.error("Starting script_to_video (captions + generated music)...");
const run = await vg.workflows.scriptToVideoAndWait({
  script,
  visualStyle: {
    type: "AI_IMAGE",
    aiStyle: style,
  },
  quality,
  autoExport: true,
  remixActions: [
    { type: "ENABLE_CAPTIONS" },
    { type: "GENERATE_MUSIC", prompt: musicPrompt },
    {
      type: "CONVERT_IMAGES_TO_VIDEOS",
      motionPrompt: "slow gentle camera drift, soft watercolor motion",
      muteOutputVideos: true,
      quality,
    },
  ],
});

const summary = {
  workflowRunId: run.workflowRunId,
  status: run.status,
  projectId: run.projectId,
  projectUrl: run.projectUrl,
  downloadUrl: run.downloadUrl ?? null,
  progressPercentage: run.progressPercentage,
  error: run.error ?? null,
};

console.log(JSON.stringify(summary, null, 2));

if (run.status !== "succeeded" || !run.downloadUrl) {
  console.error("Workflow did not succeed with a downloadUrl.");
  process.exit(2);
}

await mkdir(outDir, { recursive: true });
const outPath = path.join(outDir, "hydration-watercolor-video.mp4");
const res = await fetch(run.downloadUrl);
if (!res.ok) {
  console.error(`Failed to download MP4: HTTP ${res.status}`);
  process.exit(3);
}
const buf = Buffer.from(await res.arrayBuffer());
await writeFile(outPath, buf);
console.error(`Saved ${outPath} (${buf.length} bytes)`);
console.error(`Project: ${run.projectUrl}`);
