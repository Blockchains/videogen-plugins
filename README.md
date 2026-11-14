# VideoGen (local Cursor / Grok fork)

Self-contained VideoGen for [Cursor](https://cursor.com) agents and a
**browser studio on GitHub Pages** — no videogen.io, no cloud APIs, no keys.

| Surface | Implementation |
| --- | --- |
| **Web app** (`docs/`) | Generative watercolor + timed captions + music, encoded with WebCodecs → seekable WebM (MediaRecorder fallback) |
| Agent MCP (`local/`) | Cursor `GenerateImage` + local TTS + parallel ffmpeg → MP4 |

Live site (after Pages deploy):
`https://blockchains.github.io/videogen-plugins/`

Fork: `github.com/Blockchains/videogen-plugins`

## Performance

Both free routes were rebuilt around speed, detection and success rate.

| Route | Before | After | Notes |
| --- | --- | --- | --- |
| Agent CLI, 14 s clip, `quality: fast` (720p) | 5.7 s | **0.65 s** | ~9× |
| Agent CLI, 14 s clip, `balanced` (1080p Ken Burns) | 5.7 s | **1.7 s** | same output spec as before |
| Browser studio, 12 s clip (software VP9, 4 cores) | 12.7 s (real time) | **2.1 s** | no longer bounded by clip length |
| Dependency detection | ~5 shell spawns per call | **~1 ms** warm / 44 ms cold | disk-cached ffmpeg capabilities |

Measured on a 4-vCPU Linux VM without GPU; machines with hardware encoders will be faster.

How:

- **One parallel render instead of five sequential passes.** The old pipeline ran
  ffmpeg five times and encoded the video twice. Video and audio are now encoded
  in two concurrent ffmpeg processes and stream-copied into the MP4.
- **Cheap frame pipeline.** Pixel-format conversion happens once before frames are
  duplicated, captions use `drawtext` (3× cheaper than libass), the fast preset
  uses a crop-based pan instead of `zoompan`, and the AAC encoder runs its fast coder.
- **Per-sentence TTS, cached by content.** Each cue is synthesized in parallel and
  stitched in-process, so captions are timed exactly and re-renders after edits only
  re-synthesize what changed.
- **Browser: WebCodecs + an in-page WebM muxer.** Frames go straight into
  `VideoEncoder`/`AudioEncoder` while `OfflineAudioContext` renders the soundtrack on
  another thread; the file gets a real duration and cue index (seekable), unlike
  MediaRecorder output.

## Detection and success

- `get_me` / `doctor` report `ready`, `degraded` or `blocked`, list every check with a
  fix, and return a platform-specific install command (apt, dnf, pacman, apk, zypper,
  brew, winget, choco).
- Binaries are resolved with a pure-Node PATH scan (plus well-known install dirs);
  ffmpeg filters/encoders are probed once and cached on disk.
- TTS engine chain: `espeak-ng` → `espeak` → macOS `say` → `flite` → `pico2wave` →
  Windows SAPI. Encoder chain: libx264 → h264_videotoolbox → libopenh264 → mpeg4;
  aac → mp3 → opus. Captions: drawtext with an auto-discovered TTF → libass → skipped.
- Every render degrades instead of failing (missing TTS → captions + music; bad
  image → procedural still; failed fast render → safe re-render) and reports
  `warnings`; pass `strict: true` to fail instead. Output is validated with ffprobe.
- All child processes have timeouts. `VIDEOGEN_DEBUG=1` prints every command.
- The browser studio detects WebCodecs/MediaRecorder/OfflineAudioContext up front,
  shows the chosen route, verifies the produced file is decodable, and falls back to
  the real-time recorder with a visible warning.

## Web studio (GitHub Pages)

Fully static. Open `docs/index.html` or the deployed Pages URL.

```sh
# local preview
npm run serve:docs
# → http://127.0.0.1:4173/
```

Write a script, tweak the style, generate, regenerate the look, download WebM.
Captions / music / narration toggles and the encoder selector are the built-in
editor controls. Nothing is uploaded.

Deploy is automatic via `.github/workflows/pages.yml` (GitHub Actions → Pages).
The same workflow runs `npm test` and a CLI smoke render on every PR.

## Agent CLI requirements

- Node.js 20+
- `ffmpeg` + `ffprobe`
- A TTS engine — `espeak-ng` recommended (`./scripts/install-local-deps.sh`)

No API keys. No OAuth. Run `npm run doctor` to see what is missing and how to install it.

## Install (Cursor)

This repo's `.cursor-plugin/plugin.json` + `mcp.json` launch:

```json
{
  "mcpServers": {
    "videogen": {
      "command": "node",
      "args": ["local/mcp-server.mjs"]
    }
  }
}
```

Ask the agent:

> Use VideoGen to turn this script into a narrated video with captions and background music: "…"

The skill tells the agent to generate a still with Cursor, then call
`script_to_video`.

## CLI

```sh
node local/cli.mjs doctor                 # health report + install command
node local/cli.mjs bench                  # time every quality preset on this machine

node local/cli.mjs script-to-video \
  --script "Staying hydrated keeps your body and mind running at their best." \
  --image /path/to/still.jpg \
  --quality fast \                        # fast | balanced (default) | high
  --out /opt/cursor/artifacts/hydration-watercolor-video
```

Other flags: `--resolution 1080p|720p|480p|WxH`, `--motion zoom|pan|none`, `--fps N`,
`--voice`, `--rate`, `--no-captions`, `--no-music`, `--strict`, `--quiet`.

Environment overrides: `VIDEOGEN_FFMPEG`, `VIDEOGEN_FFPROBE`, `VIDEOGEN_ESPEAK`,
`VIDEOGEN_FONT`, `VIDEOGEN_CACHE_DIR`, `VIDEOGEN_OUT_DIR`, `VIDEOGEN_DEBUG`.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `get_me` | Status (`ready`/`degraded`/`blocked`), detected tools, install command |
| `doctor` | Full re-scan with per-check fixes |
| `get_getting_started_guidance` | Workflow as markdown |
| `script_to_video` | End-to-end narrated export (supports `quality`, `resolution`, `motion`, `fps`, `strict`; emits MCP progress notifications) |
| `text_to_speech` | WAV-only narration (cached) |

## Demo

```sh
npm run demo:hydration
```

## Layout

```
local/
  mcp-server.mjs     # stdio MCP (get_me, doctor, script_to_video, …)
  cli.mjs            # me | doctor | bench | script-to-video
  lib/pipeline.mjs   # parallel offline assembler
  lib/detect.mjs     # cached capability detection + doctor()
  lib/tts.mjs        # TTS engine chain + content cache
  lib/captions.mjs   # cue segmentation / SRT / ffmpeg escaping
  lib/wav.mjs        # WAV header parse + in-process concat
  test/              # node:test suites
docs/
  lib/render.js      # WebCodecs fast path + MediaRecorder fallback
  lib/webm.js        # minimal WebM muxer
  lib/capabilities.js
skills/videogen/     # agent workflow
mcp.json             # Cursor MCP → local server
```

## License

Plugin files are MIT licensed (see `LICENSE`).
