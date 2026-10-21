/**
 * Offline formant-style narration synthesizer (no network, no cloud TTS).
 * Robotic but clearly spoken, timed to the script words.
 */

const VOWELS = {
  a: [730, 1090, 2440],
  e: [530, 1840, 2480],
  i: [390, 1990, 2550],
  o: [570, 840, 2410],
  u: [440, 1020, 2240],
  y: [300, 1850, 2450],
};

function pickVowel(ch) {
  const c = (ch || "a").toLowerCase();
  if (VOWELS[c]) return VOWELS[c];
  if ("bcdfghjklmnpqrstvwxz".includes(c)) return null;
  return VOWELS.a;
}

function wordPhones(word) {
  const w = word.toLowerCase().replace(/[^a-z']/g, "");
  if (!w) return [];
  const phones = [];
  for (let i = 0; i < w.length; i++) {
    const v = pickVowel(w[i]);
    if (v) phones.push({ type: "vowel", formants: v });
    else phones.push({ type: "cons", ch: w[i] });
  }
  if (!phones.some((p) => p.type === "vowel")) {
    phones.push({ type: "vowel", formants: VOWELS.a });
  }
  return phones;
}

export function estimateDurationSec(script) {
  const words = String(script || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return Math.max(3.8, words.length * 0.4 + 0.9);
}

/**
 * Render narration (+ optional ambient music) into an AudioBuffer.
 */
export async function renderSoundtrackBuffer({
  script,
  durationSec,
  music = true,
  narration = true,
  sampleRate = 44100,
} = {}) {
  const length = Math.ceil(durationSec * sampleRate);
  const offline = new OfflineAudioContext(2, length, sampleRate);
  const master = offline.createGain();
  master.gain.value = 1;
  master.connect(offline.destination);

  if (music) {
    const musicGain = offline.createGain();
    musicGain.gain.value = 0.14;
    musicGain.connect(master);
    for (const f of [174.61, 220, 277.18]) {
      const osc = offline.createOscillator();
      const g = offline.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      g.gain.setValueAtTime(0.0001, 0);
      g.gain.exponentialRampToValueAtTime(0.5, 0.9);
      g.gain.setValueAtTime(0.5, Math.max(0.9, durationSec - 0.75));
      g.gain.exponentialRampToValueAtTime(0.0001, durationSec);
      osc.connect(g);
      g.connect(musicGain);
      osc.start(0);
      osc.stop(durationSec + 0.02);
    }
    const nbuf = offline.createBuffer(1, length, sampleRate);
    const nd = nbuf.getChannelData(0);
    for (let i = 0; i < length; i++) nd[i] = (Math.random() * 2 - 1) * 0.04;
    const noise = offline.createBufferSource();
    noise.buffer = nbuf;
    const nf = offline.createBiquadFilter();
    nf.type = "lowpass";
    nf.frequency.value = 650;
    const ng = offline.createGain();
    ng.gain.value = 0.32;
    noise.connect(nf);
    nf.connect(ng);
    ng.connect(musicGain);
    noise.start(0);
  }

  const voiceGain = offline.createGain();
  voiceGain.gain.value = 1;
  voiceGain.connect(master);

  const words = narration
    ? String(script || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
    : [];
  const startAt = 0.25;
  const usable = Math.max(durationSec - startAt - 0.4, 1);
  let t = startAt;

  words.forEach((word, wi) => {
    const phones = wordPhones(word);
    const wordBudget = usable / Math.max(words.length, 1);
    const phoneDur = Math.min(0.12, (wordBudget * 0.75) / Math.max(phones.length, 1));
    const pitch = (150 + (wi % 5) * 5) * (1 - (wi / Math.max(words.length - 1, 1)) * 0.1);

    phones.forEach((phone, pi) => {
      const on = t + pi * phoneDur;
      const off = on + phoneDur * 0.9;
      if (on >= durationSec) return;

      if (phone.type === "cons") {
        const nlen = Math.max(1, Math.floor(sampleRate * phoneDur * 0.5));
        const buf = offline.createBuffer(1, nlen, sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < nlen; i++) {
          const env = Math.sin((Math.PI * i) / nlen);
          data[i] = (Math.random() * 2 - 1) * 0.5 * env;
        }
        const src = offline.createBufferSource();
        src.buffer = buf;
        const bp = offline.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.value = 1600 + ((phone.ch?.charCodeAt(0) || 97) % 9) * 100;
        bp.Q.value = 1.4;
        const g = offline.createGain();
        g.gain.value = 0.4;
        src.connect(bp);
        bp.connect(g);
        g.connect(voiceGain);
        src.start(on);
      } else {
        const osc = offline.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.value = pitch;
        const gEnv = offline.createGain();
        gEnv.gain.setValueAtTime(0.0001, on);
        gEnv.gain.exponentialRampToValueAtTime(0.75, on + 0.018);
        gEnv.gain.exponentialRampToValueAtTime(0.0001, Math.min(off, durationSec - 0.01));

        const carriers = [
          { f: phone.formants[0], a: 0.55 },
          { f: phone.formants[1], a: 0.3 },
          { f: phone.formants[2], a: 0.14 },
        ];
        for (const { f, a } of carriers) {
          const bp = offline.createBiquadFilter();
          bp.type = "bandpass";
          bp.frequency.value = f;
          bp.Q.value = 7;
          const g = offline.createGain();
          g.gain.value = a;
          osc.connect(bp);
          bp.connect(g);
          g.connect(gEnv);
        }
        const fund = offline.createGain();
        fund.gain.value = 0.14;
        osc.connect(fund);
        fund.connect(gEnv);
        gEnv.connect(voiceGain);
        osc.start(on);
        osc.stop(Math.min(off + 0.01, durationSec));
      }
    });

    t += wordBudget;
  });

  return offline.startRendering();
}

/** Live browser TTS preview (speakers only; export uses the formant synth). */
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
