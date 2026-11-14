/**
 * Minimal WebM (Matroska) muxer for WebCodecs output.
 *
 * Writes a complete, seekable file: EBML header, Info (with Duration), Tracks,
 * Clusters of SimpleBlocks (new cluster on each video keyframe past 1s), and
 * Cues. Supports one VP8/VP9 video track and one optional Opus audio track.
 * No dependencies; everything is built in memory.
 */

const ID = {
  EBML: [0x1a, 0x45, 0xdf, 0xa3],
  EBMLVersion: [0x42, 0x86],
  EBMLReadVersion: [0x42, 0xf7],
  EBMLMaxIDLength: [0x42, 0xf2],
  EBMLMaxSizeLength: [0x42, 0xf3],
  DocType: [0x42, 0x82],
  DocTypeVersion: [0x42, 0x87],
  DocTypeReadVersion: [0x42, 0x85],
  Segment: [0x18, 0x53, 0x80, 0x67],
  Info: [0x15, 0x49, 0xa9, 0x66],
  TimecodeScale: [0x2a, 0xd7, 0xb1],
  MuxingApp: [0x4d, 0x80],
  WritingApp: [0x57, 0x41],
  Duration: [0x44, 0x89],
  Tracks: [0x16, 0x54, 0xae, 0x6b],
  TrackEntry: [0xae],
  TrackNumber: [0xd7],
  TrackUID: [0x73, 0xc5],
  TrackType: [0x83],
  FlagLacing: [0x9c],
  CodecID: [0x86],
  CodecPrivate: [0x63, 0xa2],
  CodecDelay: [0x56, 0xaa],
  SeekPreRoll: [0x56, 0xbb],
  Video: [0xe0],
  PixelWidth: [0xb0],
  PixelHeight: [0xba],
  Audio: [0xe1],
  SamplingFrequency: [0xb5],
  Channels: [0x9f],
  Cluster: [0x1f, 0x43, 0xb6, 0x75],
  Timecode: [0xe7],
  SimpleBlock: [0xa3],
  Cues: [0x1c, 0x53, 0xbb, 0x6b],
  CuePoint: [0xbb],
  CueTime: [0xb3],
  CueTrackPositions: [0xb7],
  CueTrack: [0xf7],
  CueClusterPosition: [0xf1],
};

const VIDEO_TRACK = 1;
const AUDIO_TRACK = 2;
const CLUSTER_MS = 1000;
const MAX_CLUSTER_MS = 30000;

function vint(n) {
  let len = 1;
  while (len < 8 && n >= 2 ** (7 * len) - 1) len++;
  const out = new Uint8Array(len);
  let v = n;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] |= 1 << (8 - len);
  return out;
}

function uintBytes(n) {
  if (n < 0) throw new Error("uint must be >= 0");
  let len = 1;
  while (len < 8 && n >= 2 ** (8 * len)) len++;
  const out = new Uint8Array(len);
  let v = n;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
}

function floatBytes(f) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, f, false);
  return out;
}

function stringBytes(s) {
  return new TextEncoder().encode(s);
}

function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function el(id, payload) {
  const body = Array.isArray(payload) ? concat(payload) : payload;
  return concat([Uint8Array.from(id), vint(body.length), body]);
}

const uint = (id, n) => el(id, uintBytes(n));
const float = (id, f) => el(id, floatBytes(f));
const str = (id, s) => el(id, stringBytes(s));

/** 19-byte OpusHead used as CodecPrivate when the encoder does not supply one. */
export function opusHead({ channels = 2, sampleRate = 48000, preSkip = 312 } = {}) {
  const out = new Uint8Array(19);
  out.set(stringBytes("OpusHead"), 0);
  const dv = new DataView(out.buffer);
  out[8] = 1;
  out[9] = channels;
  dv.setUint16(10, preSkip, true);
  dv.setUint32(12, sampleRate, true);
  dv.setInt16(16, 0, true);
  out[18] = 0;
  return out;
}

export class WebMMuxer {
  /**
   * @param {{ video: { codec: "vp8"|"vp9", width: number, height: number },
   *           audio?: { sampleRate: number, channels: number, codecPrivate?: Uint8Array } | null }} opts
   */
  constructor({ video, audio = null }) {
    if (!video) throw new Error("video track is required");
    this.video = video;
    this.audio = audio;
    this.blocks = [];
    this.finalized = false;
  }

  addVideoChunk(chunk, meta) {
    this._add(VIDEO_TRACK, chunk, chunk.type === "key");
    const desc = meta?.decoderConfig?.description;
    if (desc && !this.video.codecPrivate) this.video.codecPrivate = toU8(desc);
  }

  addAudioChunk(chunk, meta) {
    if (!this.audio) throw new Error("no audio track configured");
    this._add(AUDIO_TRACK, chunk, true);
    const desc = meta?.decoderConfig?.description;
    if (desc && !this.audio.codecPrivate) this.audio.codecPrivate = toU8(desc);
  }

  _add(track, chunk, key) {
    if (this.finalized) throw new Error("muxer already finalized");
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.blocks.push({ track, key, tsMs: chunk.timestamp / 1000, data });
  }

  /**
   * @param {number} [durationMs] total duration; defaults to the last block end.
   * @returns {Blob}
   */
  finalize(durationMs) {
    this.finalized = true;
    const blocks = this.blocks.slice().sort((a, b) => a.tsMs - b.tsMs || a.track - b.track);
    const lastTs = blocks.length ? blocks[blocks.length - 1].tsMs : 0;
    const duration = Math.max(durationMs || 0, lastTs + 1);

    const header = el(ID.EBML, [
      uint(ID.EBMLVersion, 1),
      uint(ID.EBMLReadVersion, 1),
      uint(ID.EBMLMaxIDLength, 4),
      uint(ID.EBMLMaxSizeLength, 8),
      str(ID.DocType, "webm"),
      uint(ID.DocTypeVersion, 4),
      uint(ID.DocTypeReadVersion, 2),
    ]);

    const info = el(ID.Info, [
      uint(ID.TimecodeScale, 1_000_000),
      str(ID.MuxingApp, "videogen-local"),
      str(ID.WritingApp, "videogen-local"),
      float(ID.Duration, duration),
    ]);

    const trackEntries = [
      el(ID.TrackEntry, [
        uint(ID.TrackNumber, VIDEO_TRACK),
        uint(ID.TrackUID, VIDEO_TRACK),
        uint(ID.TrackType, 1),
        uint(ID.FlagLacing, 0),
        str(ID.CodecID, this.video.codec === "vp8" ? "V_VP8" : "V_VP9"),
        ...(this.video.codecPrivate ? [el(ID.CodecPrivate, this.video.codecPrivate)] : []),
        el(ID.Video, [uint(ID.PixelWidth, this.video.width), uint(ID.PixelHeight, this.video.height)]),
      ]),
    ];
    if (this.audio) {
      const priv =
        this.audio.codecPrivate ||
        opusHead({ channels: this.audio.channels, sampleRate: this.audio.sampleRate });
      trackEntries.push(
        el(ID.TrackEntry, [
          uint(ID.TrackNumber, AUDIO_TRACK),
          uint(ID.TrackUID, AUDIO_TRACK),
          uint(ID.TrackType, 2),
          uint(ID.FlagLacing, 0),
          str(ID.CodecID, "A_OPUS"),
          el(ID.CodecPrivate, priv),
          uint(ID.CodecDelay, 6_500_000),
          uint(ID.SeekPreRoll, 80_000_000),
          el(ID.Audio, [
            float(ID.SamplingFrequency, this.audio.sampleRate),
            uint(ID.Channels, this.audio.channels),
          ]),
        ]),
      );
    }
    const tracks = el(ID.Tracks, trackEntries);

    // Group blocks into clusters. A cluster starts at the first block and at
    // each video keyframe once the cluster is >= CLUSTER_MS long; it is forced
    // before the int16 relative timecode would overflow.
    const clusters = [];
    let cur = null;
    for (const b of blocks) {
      const ts = Math.round(b.tsMs);
      const startNew =
        !cur ||
        (b.track === VIDEO_TRACK && b.key && ts - cur.timecode >= CLUSTER_MS) ||
        ts - cur.timecode > MAX_CLUSTER_MS;
      if (startNew) {
        cur = { timecode: ts, blocks: [] };
        clusters.push(cur);
      }
      cur.blocks.push({ ...b, rel: ts - cur.timecode });
    }

    const clusterBytes = [];
    const cuePoints = [];
    let offset = info.length + tracks.length;
    for (const c of clusters) {
      const parts = [uint(ID.Timecode, c.timecode)];
      for (const b of c.blocks) {
        const head = new Uint8Array(4);
        head[0] = 0x80 | b.track;
        head[1] = (b.rel >> 8) & 0xff;
        head[2] = b.rel & 0xff;
        head[3] = b.key ? 0x80 : 0x00;
        parts.push(el(ID.SimpleBlock, concat([head, b.data])));
      }
      const bytes = el(ID.Cluster, parts);
      cuePoints.push(
        el(ID.CuePoint, [
          uint(ID.CueTime, c.timecode),
          el(ID.CueTrackPositions, [uint(ID.CueTrack, VIDEO_TRACK), uint(ID.CueClusterPosition, offset)]),
        ]),
      );
      clusterBytes.push(bytes);
      offset += bytes.length;
    }
    const cues = el(ID.Cues, cuePoints);

    const segment = el(ID.Segment, [info, tracks, ...clusterBytes, cues]);
    const mime = `video/webm;codecs=${this.video.codec === "vp8" ? "vp8" : "vp9"}${this.audio ? ",opus" : ""}`;
    return new Blob([header, segment], { type: mime });
  }
}

function toU8(desc) {
  if (desc instanceof Uint8Array) return desc;
  if (desc instanceof ArrayBuffer) return new Uint8Array(desc);
  if (ArrayBuffer.isView(desc)) return new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength);
  return null;
}

export const __internals = { vint, uintBytes, el, concat };
