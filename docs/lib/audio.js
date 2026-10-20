/** Estimate narration length from word count */
export function estimateDurationSec(script) {
  const words = String(script || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return Math.max(3.2, words.length * 0.42 + 0.6);
}

/**
 * Build ambient bed + soft “spoken” syllable pulses into a MediaStreamTrack.
 */
export function createSoundtrack(audioCtx, { durationSec, script, music = true } = {}) {
  const dest = audioCtx.createMediaStreamDestination();
  const master = audioCtx.createGain();
  master.gain.value = 0.9;
  master.connect(dest);
  master.connect(audioCtx.destination); // live monitor while recording/preview

  const now = audioCtx.currentTime + 0.05;
  const end = now + durationSec;

  if (music) {
    const freqs = [174.61, 220, 261.63];
    for (const f of freqs) {
      const osc = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.03, now + 1.1);
      g.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(g);
      g.connect(master);
      osc.start(now);
      osc.stop(end + 0.05);
    }

    // gentle noise bed via buffer
    const noiseLen = Math.ceil(audioCtx.sampleRate * durationSec);
    const buffer = audioCtx.createBuffer(1, noiseLen, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < noiseLen; i++) data[i] = (Math.random() * 2 - 1) * 0.015;
    const noise = audioCtx.createBufferSource();
    noise.buffer = buffer;
    const ng = audioCtx.createGain();
    const filter = audioCtx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 700;
    ng.gain.value = 0.55;
    noise.connect(filter);
    filter.connect(ng);
    ng.connect(master);
    noise.start(now);
    noise.stop(end + 0.05);
  }

  // syllable pulses for narration rhythm (captions carry the words)
  const words = String(script || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length) {
    const span = Math.max(durationSec - 0.5, 1);
    words.forEach((word, i) => {
      const t = now + 0.25 + (i / words.length) * span;
      const osc = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      osc.type = "triangle";
      const base = 160 + (word.length % 7) * 18;
      osc.frequency.setValueAtTime(base, t);
      osc.frequency.exponentialRampToValueAtTime(base * 0.85, t + 0.12);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.08, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      osc.connect(g);
      g.connect(master);
      osc.start(t);
      osc.stop(t + 0.16);
    });
  }

  return { dest, stopAt: end };
}

/** Optional live browser TTS preview (not captured into export). */
export function speakPreview(script) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(script);
  u.rate = 0.95;
  u.pitch = 1;
  window.speechSynthesis.speak(u);
}

export function stopSpeakPreview() {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}
