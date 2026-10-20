# VideoGen (local Cursor / Grok fork)

Self-contained VideoGen for [Cursor](https://cursor.com) agents and a
**browser studio on GitHub Pages** — no videogen.io, no cloud APIs, no keys.

| Surface | Implementation |
| --- | --- |
| **Web app** (`docs/`) | Generative watercolor + captions + music + WebM export in-browser |
| Agent MCP (`local/`) | Cursor `GenerateImage` + `espeak-ng` + ffmpeg → MP4 |

Live site (after Pages deploy):
`https://blockchains.github.io/videogen-plugins/`

Fork: `github.com/Blockchains/videogen-plugins`

## Web studio (GitHub Pages)

Fully static. Open `docs/index.html` or the deployed Pages URL.

```sh
# local preview
python3 -m http.server -d docs 4173
# → http://127.0.0.1:4173/
```

Write a script, tweak the style, generate, regenerate the look, download WebM.
Captions / music toggles are the built-in editor controls. Nothing is uploaded.

Deploy is automatic via `.github/workflows/pages.yml` (GitHub Actions → Pages).

## Agent CLI requirements

- Node.js 20+
- `ffmpeg` + `ffprobe`
- `espeak-ng` (`./scripts/install-local-deps.sh`)

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
