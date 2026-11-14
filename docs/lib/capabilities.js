/**
 * Browser capability detection for the studio. Picks the fastest available
 * encoding route and reports what the UI should show. Memoized.
 */

const VIDEO_CODECS = ["vp09.00.10.08", "vp8"];

function pickRecorderMime() {
  const types = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  if (!("MediaRecorder" in window)) return "";
  for (const t of types) {
    try {
      if (MediaRecorder.isTypeSupported(t)) return t;
    } catch {
      /* ignore */
    }
  }
  return "";
}

let memo = null;

export function resetCapabilities() {
  memo = null;
}

/**
 * @returns {Promise<{
 *   engine: "webcodecs" | "realtime" | "none",
 *   webcodecs: boolean, videoCodec: string|null, audioCodec: string|null,
 *   mediaRecorderMime: string, captureStream: boolean, offlineAudio: boolean,
 *   speechSynthesis: boolean, hardwareConcurrency: number, label: string
 * }>}
 */
export function detectCapabilities({ width = 1280, height = 720, fps = 30 } = {}) {
  if (memo) return memo;
  memo = (async () => {
    const caps = {
      engine: "none",
      webcodecs: false,
      videoCodec: null,
      audioCodec: null,
      mediaRecorderMime: pickRecorderMime(),
      captureStream: typeof HTMLCanvasElement !== "undefined" && !!HTMLCanvasElement.prototype.captureStream,
      offlineAudio: !!(window.OfflineAudioContext || window.webkitOfflineAudioContext),
      speechSynthesis: "speechSynthesis" in window,
      hardwareConcurrency: navigator.hardwareConcurrency || 1,
      label: "",
    };

    if ("VideoEncoder" in window && "AudioEncoder" in window && "VideoFrame" in window && "AudioData" in window) {
      for (const codec of VIDEO_CODECS) {
        try {
          const r = await VideoEncoder.isConfigSupported({
            codec,
            width,
            height,
            bitrate: 4_000_000,
            framerate: fps,
          });
          if (r?.supported) {
            caps.videoCodec = codec;
            break;
          }
        } catch {
          /* try next */
        }
      }
      try {
        const a = await AudioEncoder.isConfigSupported({
          codec: "opus",
          sampleRate: 48000,
          numberOfChannels: 2,
          bitrate: 128_000,
        });
        if (a?.supported) caps.audioCodec = "opus";
      } catch {
        /* unsupported */
      }
      caps.webcodecs = !!(caps.videoCodec && caps.audioCodec);
    }

    if (!caps.offlineAudio) {
      caps.engine = "none";
      caps.label = "This browser lacks OfflineAudioContext";
    } else if (caps.webcodecs) {
      caps.engine = "webcodecs";
      caps.label = `Fast encoder · WebCodecs ${caps.videoCodec.startsWith("vp09") ? "VP9" : "VP8"} + Opus`;
    } else if (caps.mediaRecorderMime && caps.captureStream) {
      caps.engine = "realtime";
      caps.label = "Realtime recorder · MediaRecorder (slower, 1× clip length)";
    } else {
      caps.engine = "none";
      caps.label = "This browser cannot encode video (no WebCodecs or MediaRecorder)";
    }
    return caps;
  })();
  memo.catch(() => {
    memo = null;
  });
  return memo;
}
