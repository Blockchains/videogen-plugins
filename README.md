# VideoGen - AI Video Generator

Generate professional, editable AI videos and media directly in Cursor,
Gemini CLI, and Codex-compatible hosts with your VideoGen account.

Go from text to video, image to video, or script to video with
[VideoGen’s AI video generator](https://videogen.io/videogen-mcp). Then edit
and remix your projects in VideoGen’s AI video editor.

Turn a narration script, uploaded voiceover, PDF/slideshow, or scene-by-scene
storyboard into a multi-scene video with AI visuals and captions. Create
images, video clips, voiceovers, music, sound effects, motion graphics, and
talking-head avatars. Add captions and transitions, animate stills, and
export MP4 downloads.

## Install

### Cursor

Once approved, install VideoGen from the Cursor Marketplace. The Cursor
manifest is `.cursor-plugin/plugin.json`; `mcp.json` connects the hosted MCP.

### Gemini CLI

```sh
gemini extensions install https://github.com/video-gen/videogen-plugins
```

### Agent skills

```sh
npx skills add video-gen/videogen-plugins --skill videogen
```

The standalone skill requires a VideoGen MCP connection configured in your
agent host. This command installs guidance, not the MCP connection itself.
Use `https://mcp.videogen.io/mcp` in the host's MCP settings and sign in.

### Codex-compatible hosts

The `.codex-plugin/plugin.json` manifest bundles `skills/` and `.mcp.json`.
For the independent Codex Plugin Marketplace, use its plugin installer after
listing approval. This repository is not an OpenAI endorsement.

## Authentication and usage

### Cursor Cloud Agents (this fork)

OAuth popups often time out in Cloud Agents. This fork’s `mcp.json` runs the
local `@videogen/mcp` stdio server and expects secret `VIDEOGEN_API_KEY`
(create at https://app.videogen.io/api). For a one-shot narrated export without
MCP tools:

```sh
npm install
npm run script-to-video
```

Desktop OAuth URL config is preserved in `mcp.oauth.json`.

### Interactive hosts

Complete the host-managed OAuth flow with your VideoGen account, or use an API
key. No API key, password, or token is bundled in the repo. Try:

- "Use VideoGen to create a 15-second vertical product ad, add captions, and export an MP4."
- "Use VideoGen to turn this script into a narrated landscape explainer."
- "Use VideoGen to animate this product image and return a download link."

Generation and exports may consume account credits. Connected-account access
controls project and media permissions. Respect the user's requested scope,
budget, and existing project choices.

## Network and components

One hosted HTTP MCP connection and one workflow skill. No scripts, lifecycle
hooks, local executables, dependency installation, or local secret reads.

- `https://mcp.videogen.io/mcp`: tools, guidance, and OAuth discovery/endpoints.
  The `vg_client` query parameter identifies the host in VideoGen integration
  attribution; it contains no user identifier or credential.
- `https://app.videogen.io`: account sign-in and project deep links.
- Operation-specific upload/download URLs returned by tools: transfer requested
  media only.

The manifests and endpoint discovery are checked statically. Installation,
OAuth, and generation in each host still require host-specific verification;
no successful host test is claimed by this package.

## Ownership and license

Maintained by [VideoGen](https://github.com/video-gen). Contact:
support@videogen.io. Plugin files are MIT licensed. The hosted service is
subject to [VideoGen's terms](https://videogen.io/terms-of-service) and
[privacy policy](https://videogen.io/privacy-policy).
