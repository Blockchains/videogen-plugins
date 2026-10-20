---
name: videogen
description: Local VideoGen for Cursor/Grok — script to narrated video with captions and music using Cursor GenerateImage plus a local ffmpeg/espeak pipeline. No videogen.io cloud.
---

# VideoGen (local Cursor / Grok fork)

This skill drives **local** video production. Do **not** call `videogen.io`,
`mcp.videogen.io`, `@videogen/sdk`, or `@videogen/mcp`.

## Architecture

| Step | Owner |
| --- | --- |
| Scene stills | Cursor `GenerateImage` (agent) |
| Narration | local `espeak-ng` via MCP/CLI |
| Ambient music | local ffmpeg synth |
| Captions + Ken Burns + mux | local ffmpeg via `script_to_video` |

MCP entrypoint: `node local/mcp-server.mjs` (configured in `mcp.json`).

## Workflow: narrated script → MP4

1. Call MCP `get_me` (or `npm run me`) to verify ffmpeg + espeak-ng.
2. Generate one or more stills with Cursor **GenerateImage** using the user's
   full visual-style paragraph (not a short label like `watercolor`). Prefer
   16:9 unless the user asked otherwise.
3. Call MCP **`script_to_video`** with:
   - `script` — spoken narration
   - `style` — the visual style paragraph
   - `imagePath` — absolute path to the generated still
   - `captions: true`, `music: true` unless the user opts out
4. Return the result's `downloadPath` (local MP4). For Cloud Agents, also copy
   or write under `/opt/cursor/artifacts/`.

CLI equivalent:

```sh
node local/cli.mjs script-to-video \
  --script "..." \
  --image /absolute/path/to/still.jpg \
  --out /opt/cursor/artifacts/my-video
```

## Style guidance

Pass a full style paragraph. Example lock used for hydration content:

> Loose watercolor illustration, visible brushstrokes, soft color bleeds, paper
> texture, muted palette. A clear uncluttered subject centered in the frame,
> occupying only the middle half of the image, with generous empty margins on
> all four sides, no background clutter.

Image models pack frames with text and clutter unless the style forbids it.
Keep one subject, empty margins, no on-image text.

## Tools

| Tool | Purpose |
| --- | --- |
| `get_me` | Local engine + dependency check |
| `get_getting_started_guidance` | This workflow as markdown |
| `script_to_video` | End-to-end narrated export |
| `text_to_speech` | WAV-only narration |

If the MCP host has not loaded this server yet, run the CLI directly — same pipeline.

## Failure modes

- Missing `espeak-ng`: install with `sudo apt-get install -y espeak-ng`
- Missing `ffmpeg`: install ffmpeg
- No `imagePath`: pipeline falls back to a procedural still (lower quality);
  always prefer Cursor GenerateImage first
