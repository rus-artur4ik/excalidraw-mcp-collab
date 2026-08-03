const NAMED: Record<string, string> = {
  white: "#ffffff",
  black: "#000000",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  yellow: "#ffff00",
};

type Rgb = { r: number; g: number; b: number };

export const parseColor = (color: string | undefined): Rgb | null => {
  if (!color) {
    return null;
  }
  const value = NAMED[color.toLowerCase()] ?? color.trim();
  const hex = value.startsWith("#") ? value.slice(1) : null;
  if (!hex || !/^[0-9a-fA-F]+$/.test(hex)) {
    return null;
  }
  if (hex.length === 3) {
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16),
    };
  }
  if (hex.length === 6 || hex.length === 8) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }
  return null;
};

const channelLuminance = (channel: number): number => {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const relativeLuminance = ({ r, g, b }: Rgb): number =>
  0.2126 * channelLuminance(r) +
  0.7152 * channelLuminance(g) +
  0.0722 * channelLuminance(b);

export const contrastRatio = (foreground: Rgb, background: Rgb): number => {
  const l1 = relativeLuminance(foreground);
  const l2 = relativeLuminance(background);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
};

const colorDistance = (a: Rgb, b: Rgb): number =>
  (a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2;

type Hsl = { h: number; s: number; l: number };

const rgbToHsl = ({ r, g, b }: Rgb): Hsl => {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const l = (max + min) / 2;
  if (delta === 0) {
    return { h: 0, s: 0, l };
  }
  const s = delta / (1 - Math.abs(2 * l - 1));
  const h =
    max === rn
      ? ((gn - bn) / delta) % 6
      : max === gn
        ? (bn - rn) / delta + 2
        : (rn - gn) / delta + 4;
  return { h: (h * 60 + 360) % 360, s, l };
};

const hslToRgb = ({ h, s, l }: Hsl): Rgb => {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r1, g1, b1] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
};

export const toHex = ({ r, g, b }: Rgb): string =>
  `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;

const LIGHTNESS_STEP = 0.01;

// Only lightness moves, so a green label stays green and the color coding survives.
const nearestReadableShade = (
  current: Rgb,
  background: Rgb,
  threshold: number,
): string | null => {
  const { h, s, l } = rgbToHsl(current);
  for (let delta = LIGHTNESS_STEP; delta <= 1; delta += LIGHTNESS_STEP) {
    const passing = [l - delta, l + delta]
      .filter((lightness) => lightness >= 0 && lightness <= 1)
      .map((lightness) => hslToRgb({ h, s, l: lightness }))
      .map((rgb) => ({ rgb, ratio: contrastRatio(rgb, background) }))
      .filter(({ ratio }) => ratio >= threshold);
    if (passing.length) {
      const best = passing.reduce((a, b) => (b.ratio > a.ratio ? b : a));
      return toHex(best.rgb);
    }
  }
  return null;
};

const nearestReadableCandidate = (
  current: Rgb,
  background: Rgb,
  threshold: number,
  candidates: readonly string[],
): string | null => {
  let best: { hex: string; distance: number } | null = null;
  for (const hex of candidates) {
    const rgb = parseColor(hex);
    if (!rgb || contrastRatio(rgb, background) < threshold) {
      continue;
    }
    const distance = colorDistance(rgb, current);
    if (!best || distance < best.distance) {
      best = { hex, distance };
    }
  }
  return best?.hex ?? null;
};

export const suggestReadableColor = (
  current: Rgb,
  background: Rgb,
  threshold: number,
  candidates: readonly string[],
): string | null =>
  nearestReadableShade(current, background, threshold) ??
  nearestReadableCandidate(current, background, threshold, candidates);
