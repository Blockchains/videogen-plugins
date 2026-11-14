---
name: videogen
description: Local VideoGen for Cursor/Grok — script to narrated video with timed captions and music using Cursor GenerateImage plus a local ffmpeg/TTS pipeline. No videogen.io cloud.
---

# VideoGen (local Cursor / Grok fork)

This skill drives **local** video production. Do **not** call `videogen.io`,
`mcp.videogen.io`, `@videogen/sdk`, or `@videogen/mcp`.

## Architecture

| Step | Owner |
| --- | --- |
| Scene stills | Cursor `GenerateImage` (agent) |
| Narration | local TTS via MCP/CLI (`espeak-ng`, fallbacks: `espeak`, `say`, `flite`, `pico2wave`, SAPI) |
| Ambient music | local ffmpeg synth |
| Timed captions + motion + mux | local ffmpeg (video and audio encoded in parallel) via `script_to_video` |

MCP entrypoint: `node local/mcp-server.mjs` (configured in `mcp.json`).

## Workflow: narrated script → MP4

1. Call MCP `get_me` (or `npm run doctor`) once.
   - `ready`: continue.
   - `degraded`: rendering works but something is missing (e.g. no TTS → no voice).
     Tell the user, or run the returned `install.command` if you can.
   - `blocked`: ffmpeg is missing. Run `install.command`, then call `doctor`.
2. Generate one or more stills with Cursor **GenerateImage** using the user's
   full visual-style paragraph (not a short label like `watercolor`). Prefer
   16:9 unless the user asked otherwise.
3. Call MCP **`script_to_video`** with:
   - `script` — spoken narration
   - `style` — the visual style paragraph
   - `imagePath` — absolute path to the generated still
   - `captions: true`, `music: true` unless the user opts out
   - `quality: "fast"` while iterating on wording (720p, ~1 s); `balanced`
     (default, 1080p Ken Burns) or `high` for the final export
4. Read the result:
   - `downloadPath` — local MP4; `captionsPath` — SRT sidecar
   - `warnings` — anything that degraded (report these to the user)
   - `timings` — detect/prepare/render milliseconds
   For Cloud Agents, also copy or write under `/opt/cursor/artifacts/`.

Narration is synthesized per sentence and cached by content, so re-rendering
after a small script edit only re-synthesizes the changed sentence.

CLI equivalent:

```sh
node local/cli.mjs script-to-video \
  --script "..." \
  --image /absolute/path/to/still.jpg \
  --quality fast \
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
| `get_me` | Status + dependency summary + install command |
| `doctor` | Full re-scan with per-check fixes |
| `get_getting_started_guidance` | This workflow as markdown |
| `script_to_video` | End-to-end narrated export (`quality`, `resolution`, `motion`, `fps`, `strict`) |
| `text_to_speech` | WAV-only narration |

If the MCP host has not loaded this server yet, run the CLI directly — same pipeline.

## Failure modes

- `blocked` / "ffmpeg is required": run the install command from `get_me`/`doctor`
  (e.g. `sudo apt-get install -y ffmpeg espeak-ng fonts-dejavu-core`), then retry.
- No TTS engine: the video still renders with captions + music and a warning.
  Install `espeak-ng` for narration. Use `strict: true` if a silent video is unacceptable.
- No `imagePath` or an unreadable image: pipeline falls back to a procedural still
  (lower quality) and warns; always prefer Cursor GenerateImage first.
- Fast render fails for an unusual ffmpeg build: the pipeline re-renders with safe
  settings (static frame, libass or no captions) and records it in `warnings`.
- Set `VIDEOGEN_DEBUG=1` to print every command the pipeline runs.
