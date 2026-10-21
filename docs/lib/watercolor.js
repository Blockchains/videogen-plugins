/** Deterministic PRNG */
export function mulberry32(seed) {
  let t = seed >>> 0;
  return function next() {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function parsePalette(style) {
  const s = (style || "").toLowerCase();
  if (s.includes("sunset") || s.includes("warm")) {
    return ["#f0e6d8", "#d9a07a", "#b5684a", "#6e4a3a", "#8aa0a8"];
  }
  if (s.includes("forest") || s.includes("green")) {
    return ["#e8efe6", "#9cb59a", "#5f8a68", "#2f4f3e", "#c2b8a3"];
  }
  if (s.includes("night") || s.includes("ink")) {
    return ["#e7eaf0", "#8b9bb0", "#40506a", "#1c2433", "#b7c4c0"];
  }
  // default muted lagoon / watercolor paper
  return ["#f1eee6", "#9eb8b3", "#5f8f8a", "#2f4f55", "#c4b7a6"];
}

function blob(ctx, x, y, r, color, alpha, rand) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  const steps = 10;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const jitter = 0.72 + rand() * 0.5;
    const px = x + Math.cos(a) * r * jitter;
    const py = y + Math.sin(a) * r * jitter * 0.9;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * Paint a loose watercolor still into an offscreen canvas.
 * Subject stays in the middle half with generous margins.
 */
export function paintWatercolor({
  width = 1280,
  height = 720,
  script = "",
  style = "",
  seed = 1,
} = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const rand = mulberry32(seed ^ hashSeed(script + "|" + style));
  const palette = parsePalette(style);

  // paper
  ctx.fillStyle = palette[0];
  ctx.fillRect(0, 0, width, height);

  // soft washes
  for (let i = 0; i < 18; i++) {
    blob(
      ctx,
      rand() * width,
      rand() * height,
      80 + rand() * 220,
      palette[1 + Math.floor(rand() * (palette.length - 1))],
      0.04 + rand() * 0.07,
      rand,
    );
  }

  // paper grain
  const grain = ctx.getImageData(0, 0, width, height);
  for (let i = 0; i < grain.data.length; i += 4) {
    const n = (rand() - 0.5) * 18;
    grain.data[i] = Math.max(0, Math.min(255, grain.data[i] + n));
    grain.data[i + 1] = Math.max(0, Math.min(255, grain.data[i + 1] + n));
    grain.data[i + 2] = Math.max(0, Math.min(255, grain.data[i + 2] + n));
  }
  ctx.putImageData(grain, 0, 0);

  // centered subject — glass of water if hydration-ish, else abstract orb
  const cx = width * 0.5;
  const cy = height * 0.48;
  const subjectH = height * 0.42;
  const subjectW = subjectH * 0.42;
  const lower = (script + " " + style).toLowerCase();
  const isGlass =
    lower.includes("hydrat") ||
    lower.includes("water") ||
    lower.includes("glass") ||
    lower.includes("drink");

  ctx.save();
  ctx.translate(cx, cy);

  if (isGlass) {
    // soft contact shadow
    blob(ctx, 0, subjectH * 0.42, subjectW * 0.7, palette[4], 0.22, rand);

    const top = -subjectH * 0.45;
    const bot = subjectH * 0.42;
    const left = -subjectW * 0.5;
    const right = subjectW * 0.5;

    // glass body wash
    const g = ctx.createLinearGradient(left, top, right, bot);
    g.addColorStop(0, "rgba(180,210,220,0.35)");
    g.addColorStop(0.45, "rgba(120,170,185,0.28)");
    g.addColorStop(1, "rgba(90,130,145,0.2)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(left + 8, top);
    ctx.lineTo(right - 8, top);
    ctx.lineTo(right - 2, bot);
    ctx.lineTo(left + 2, bot);
    ctx.closePath();
    ctx.fill();

    // water fill
    const waterTop = top + subjectH * 0.28;
    const wg = ctx.createLinearGradient(0, waterTop, 0, bot);
    wg.addColorStop(0, "rgba(150,200,210,0.35)");
    wg.addColorStop(1, "rgba(70,120,140,0.4)");
    ctx.fillStyle = wg;
    ctx.beginPath();
    ctx.moveTo(left + 10, waterTop);
    ctx.lineTo(right - 10, waterTop);
    ctx.lineTo(right - 4, bot - 4);
    ctx.lineTo(left + 4, bot - 4);
    ctx.closePath();
    ctx.fill();

    // rim + edges
    ctx.strokeStyle = "rgba(70,100,115,0.45)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(left + 8, top);
    ctx.lineTo(left + 2, bot);
    ctx.moveTo(right - 8, top);
    ctx.lineTo(right - 2, bot);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(0, top, subjectW * 0.46, 10, 0, 0, Math.PI * 2);
    ctx.stroke();

    // specular bleed
    blob(ctx, -subjectW * 0.15, -subjectH * 0.05, subjectW * 0.18, "#ffffff", 0.18, rand);
  } else {
    blob(ctx, 0, 20, subjectH * 0.28, palette[2], 0.35, rand);
    blob(ctx, -20, -10, subjectH * 0.18, palette[3], 0.25, rand);
    blob(ctx, 24, 8, subjectH * 0.14, palette[1], 0.3, rand);
  }

  ctx.restore();

  // edge vignette / empty margins feel
  const vig = ctx.createRadialGradient(
    width / 2,
    height / 2,
    height * 0.2,
    width / 2,
    height / 2,
    height * 0.75,
  );
  vig.addColorStop(0, "rgba(241,238,230,0)");
  vig.addColorStop(1, "rgba(241,238,230,0.55)");
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, width, height);

  return canvas;
}
