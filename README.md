# VideoGen (local Cursor / Grok fork)

Self-contained VideoGen for [Cursor](https://cursor.com) agents (including Grok).
Produces narrated MP4s with captions and ambient music **without** videogen.io,
`mcp.videogen.io`, or `@videogen/*` cloud packages.

| Piece | Implementation |
| --- | --- |
| Stills | Cursor `GenerateImage` |
| Speech | `espeak-ng` |
| Music | ffmpeg procedural ambient bed |
| Captions / Ken Burns / mux | ffmpeg |
| Agent API | local stdio MCP (`local/mcp-server.mjs`) |

Fork: `github.com/Blockchains/videogen-plugins`

## Requirements

- Node.js 20+
- `ffmpeg` + `ffprobe`
- `espeak-ng` (`sudo apt-get install -y espeak-ng`)

No API keys. No OAuth.

## Install (Cursor)

This repo’s `.cursor-plugin/plugin.json` + `mcp.json` launch:

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
node local/cli.mjs me

node local/cli.mjs script-to-video \
  --script "Staying hydrated keeps your body and mind running at their best." \
  --image /path/to/still.jpg \
  --out /opt/cursor/artifacts/hydration-watercolor-video
```

## Demo

```sh
npm run demo:hydration
```

## Layout

```
local/
  mcp-server.mjs   # stdio MCP (get_me, script_to_video, …)
  cli.mjs
  lib/pipeline.mjs # offline assembler
skills/videogen/   # agent workflow
mcp.json           # Cursor MCP → local server
```

## License

Plugin files are MIT licensed (see `LICENSE`).
