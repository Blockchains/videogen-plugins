/**
 * Pure helpers for caption segmentation and timing. No I/O.
 */

export const CAPTION_MAX_LINE = 42;
export const CAPTION_MAX_LINES = 2;

export function wrapCaptionLines(text, maxLen = CAPTION_MAX_LINE) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxLen && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function splitWords(text, maxChars) {
  const out = [];
  let cur = "";
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxChars && cur) {
      out.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Split a script into caption cues that fit in `maxLines` lines of `maxLine`
 * characters. Cuts prefer sentence boundaries, then clause boundaries, then
 * word boundaries, so each cue is also a natural TTS utterance.
 */
export function segmentScript(
  script,
  { maxLine = CAPTION_MAX_LINE, maxLines = CAPTION_MAX_LINES } = {},
) {
  const maxChars = maxLine * maxLines - 4;
  const clean = String(script || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return [];

  const sentences = clean.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) || [clean];
  const cues = [];
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (sentence.length <= maxChars) {
      cues.push(sentence);
      continue;
    }
    const clauses = sentence.match(/[^,;:—–]+[,;:—–]*/g) || [sentence];
    let cur = "";
    const flush = () => {
      if (cur.trim()) cues.push(cur.trim());
      cur = "";
    };
    for (const clauseRaw of clauses) {
      const clause = clauseRaw.trim();
      if (!clause) continue;
      if (clause.length > maxChars) {
        flush();
        cues.push(...splitWords(clause, maxChars));
        continue;
      }
      const next = cur ? `${cur} ${clause}` : clause;
      if (next.length > maxChars) {
        flush();
        cur = clause;
      } else cur = next;
    }
    flush();
  }
  return cues.map((text) => ({ text, lines: wrapCaptionLines(text, maxLine).slice(0, 3) }));
}

/**
 * Distribute `totalSec` across cues proportionally to their character
 * weight (used when per-cue speech durations are unknown).
 */
export function proportionalTimings(cues, totalSec, { leadIn = 0.2, tail = 0.3 } = {}) {
  const usable = Math.max(totalSec - leadIn - tail, 0.5);
  const weights = cues.map((c) => Math.max(c.text.length, 1) + 6);
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  let t = leadIn;
  return cues.map((c, i) => {
    const dur = (weights[i] / sum) * usable;
    const start = t;
    t += dur;
    return { ...c, start, end: t };
  });
}

export function formatSrtTime(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  const whole = Math.floor(rem);
  const ms = Math.min(999, Math.round((rem - whole) * 1000));
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(whole).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

export function buildSrt(timedCues) {
  return (
    timedCues
      .map(
        (c, i) =>
          `${i + 1}\n${formatSrtTime(c.start)} --> ${formatSrtTime(c.end)}\n${c.lines.join("\n")}`,
      )
      .join("\n\n") + "\n"
  );
}

/**
 * Two-level ffmpeg escaping (option value, then filtergraph) for a literal
 * value such as a file path used inside -filter_complex.
 */
export function escapeFilterValue(value) {
  const level1 = String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:");
  return level1
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

export function estimateSpeechSec(text, wordsPerMinute = 155) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean).length;
  return Math.max(0.6, (words / wordsPerMinute) * 60 + 0.25);
}
