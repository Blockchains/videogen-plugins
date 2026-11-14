# VideoGen web studio (GitHub Pages)

Static, self-contained AI video generator + editor.

- No CDN scripts
- No videogen.io / cloud APIs
- No accounts or keys
- Fonts and code are vendored in this folder

Open `index.html` locally or via GitHub Pages after deploy.

## Encoding routes

The page detects what the browser can do and picks the fastest route
(shown in the header pill):

| Route | When | Speed |
| --- | --- | --- |
| **WebCodecs** (`lib/render.js` → `lib/webm.js`) | `VideoEncoder` + `AudioEncoder` support VP9/VP8 + Opus (Chrome, Edge, Firefox 130+, Safari 16.4+ where enabled) | As fast as the CPU/GPU encodes — typically 5-20× realtime |
| **Realtime recorder** | Only `MediaRecorder` + `canvas.captureStream` are available | 1× clip length |

The WebCodecs result is verified decodable before it is shown; if anything
fails the studio falls back to the recorder and says so in the status line.
The WebM written by `lib/webm.js` carries a real duration and cue index, so it
seeks correctly in players, unlike raw `MediaRecorder` output.

Soundtrack synthesis runs in an `OfflineAudioContext` on its own thread and is
overlapped with video encoding.

## Files

```
index.html, styles.css, app.js   UI
lib/render.js                    frame drawing, cue timing, both encode routes
lib/webm.js                      minimal WebM/Matroska muxer (EBML, Clusters, Cues)
lib/capabilities.js              feature detection (memoized)
lib/narration.js                 formant narration + ambient bed (OfflineAudioContext)
lib/watercolor.js                procedural watercolor still + subject detection
lib/audio.js                     compatibility re-export of narration.js
```
