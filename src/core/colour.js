// Colour helpers: HSL to RGB, and the pixel-art ramp every material is drawn
// from.

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));

export function hsl(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  const f = k0 => {
    const k = (k0 + h * 12) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)].map(x => Math.round(clamp(x) * 255));
}

// Pixel-art ramp: shadows slide cool, highlights slide warm.
export function ramp(h, s, l, contrast, steps) {
  const out = [];
  for (let j = 0; j < steps; j++) {
    const t = j / (steps - 1);
    out.push(hsl(h + (0.5 - t) * 26, clamp(s * (0.75 + 0.5 * (1 - Math.abs(t - 0.55) * 1.6))), clamp(l + (t - 0.5) * 0.62 * contrast, 0.05, 0.94)));
  }
  return out;
}
