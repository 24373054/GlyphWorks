/**
 * Pure ASCII conversion pipeline (no DOM).
 * Techniques: perceptual luminance, aspect-correct sampling, density ramps,
 * Floyd-Steinberg / Bayer dithering, and half-block (U+2580/2584/2588) output.
 */

export type RampId = "classic" | "block" | "simple";
export type DitherId = "none" | "floyd" | "bayer";
export type OutputTheme = "dark" | "light";

export type AsciiOptions = {
  columns: number;
  ramp: RampId;
  contrast: number;
  invert: boolean;
  halfBlock: boolean;
  dither: DitherId;
  theme: OutputTheme;
};

export type DualLevels = { bg: number[]; fg: number[] };

/**
 * Chafa-style dual-channel gray levels.
 * 1 = white/paper, 0 = black/ink. Dark theme uses dark backgrounds with bright
 * foreground ink; light theme uses bright backgrounds with dark ink.
 */
export const DUAL_LEVELS: Record<OutputTheme, DualLevels> = {
  dark: {
    bg: [0.04, 0.1, 0.18, 0.28, 0.4],
    fg: [0.45, 0.6, 0.75, 0.9, 1.0],
  },
  light: {
    bg: [1.0, 0.9, 0.8, 0.7, 0.58],
    fg: [0.5, 0.36, 0.22, 0.1, 0.0],
  },
};

/** Foreground-only gray levels for the luminance channel mode. */
export const LUM_LEVELS = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1];

/** Precomputed foreground-level lookup: luminance level -> LUM_LEVELS index. */
export const LUM_LUT = Uint8Array.from({ length: 256 }, (_, q) => {
  const value = q / 255;
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let j = 0; j < LUM_LEVELS.length; j += 1) {
    const distance = Math.abs(LUM_LEVELS[j] - value);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = j;
    }
  }
  return best;
});

/** Density-ordered ramps, darkest first, space (lightest) last. */
export const RAMPS: Record<RampId, string> = {
  classic: "$@B%8&WM#*oahkbdpqwmZO0QLCJUYXzcvunxrjft/\\|()1{}[]?-_+~<>i!lI;:,\"^`'. ",
  block: "@%#*+=-:. ",
  simple: "#*+=-. ",
};

export const FONT_STACK =
  '"Cascadia Code", "SFMono-Regular", Consolas, "Liberation Mono", monospace';

export type ImageDataLike = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export function luminance(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Aspect-correct character row count for a given column count. */
export function estimateRows(
  columns: number,
  mediaWidth: number,
  mediaHeight: number,
  halfBlock: boolean,
  aspectFactor = 0.52,
): number {
  const aspect = mediaHeight / Math.max(mediaWidth, 1);
  const rows = Math.max(4, Math.round(columns * aspect * aspectFactor));
  return halfBlock ? Math.max(2, Math.ceil(rows / 2)) : rows;
}

/** Box-average a bitmap into a columns x rows luminance grid (1 = white). */
export function boxGrid(
  source: ImageDataLike,
  columns: number,
  rows: number,
): Float32Array {
  const { data, width: sw, height: sh } = source;
  const grid = new Float32Array(columns * rows);
  for (let r = 0; r < rows; r += 1) {
    const y0 = Math.floor((r * sh) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((r + 1) * sh) / rows));
    for (let c = 0; c < columns; c += 1) {
      const x0 = Math.floor((c * sw) / columns);
      const x1 = Math.max(x0 + 1, Math.floor(((c + 1) * sw) / columns));
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const i = (y * sw + x) * 4;
          sum += luminance(data[i], data[i + 1], data[i + 2]);
          count += 1;
        }
      }
      grid[r * columns + c] = sum / Math.max(count, 1);
    }
  }
  return grid;
}

/** Apply contrast and polarity to a luminance grid, clamping to [0, 1]. */
export function toneMap(
  grid: Float32Array,
  contrast: number,
  invert: boolean,
): Float32Array {
  const out = new Float32Array(grid.length);
  for (let i = 0; i < grid.length; i += 1) {
    let value = grid[i];
    if (invert) value = 1 - value;
    value = clamp01(0.5 + (value - 0.5) * contrast);
    out[i] = value;
  }
  return out;
}

export type DualPlan = {
  /** Per-cell background gray level index. */
  bg: Uint8Array;
  /** Per-cell foreground gray level index. */
  fg: Uint8Array;
  /** Per-cell ramp index. */
  glyph: Uint8Array;
};

/**
 * Dual-channel planner: for every cell, pick (bg level, fg level, glyph) so
 * that bg + (fg - bg) * inkCoverage best matches the source luminance.
 * `inks` must be the measured ink coverage of `ramp`'s glyphs (same order).
 */
export function planDualChannel(
  toned: Float32Array,
  columns: number,
  rows: number,
  ramp: string,
  inks: Float32Array,
  theme: OutputTheme,
): DualPlan {
  const { bg: bgLevels, fg: fgLevels } = DUAL_LEVELS[theme];
  const order = Array.from({ length: ramp.length }, (_, i) => i)
    .sort((a, b) => inks[a] - inks[b]);
  const sortedInks = order.map((index) => inks[index]);
  const space = ramp.length - 1;
  const bg = new Uint8Array(columns * rows);
  const fg = new Uint8Array(columns * rows);
  const glyph = new Uint8Array(columns * rows);

  for (let i = 0; i < toned.length; i += 1) {
    const luminance = toned[i];
    let bestError = Number.POSITIVE_INFINITY;
    let bestBg = 0;
    let bestFg = 0;
    let bestGlyph = space;
    for (let bi = 0; bi < bgLevels.length; bi += 1) {
      const b = bgLevels[bi];
      for (let fi = 0; fi < fgLevels.length; fi += 1) {
        const g = fgLevels[fi];
        const span = g - b;
        if (Math.abs(span) < 1e-9) {
          const error = Math.abs(luminance - b);
          if (error < bestError) {
            bestError = error;
            bestBg = bi;
            bestFg = fi;
            bestGlyph = space;
          }
          continue;
        }
        const target = (luminance - b) / span;
        let lo = 0;
        let hi = sortedInks.length - 1;
        let idx = 0;
        if (target <= sortedInks[0]) {
          idx = 0;
        } else if (target >= sortedInks[sortedInks.length - 1]) {
          idx = sortedInks.length - 1;
        } else {
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (sortedInks[mid] < target) lo = mid + 1;
            else hi = mid - 1;
          }
          idx = lo;
          if (
            lo > 0 &&
            Math.abs(sortedInks[lo - 1] - target) < Math.abs(sortedInks[lo] - target)
          ) {
            idx = lo - 1;
          }
        }
        const predicted = b + span * sortedInks[idx];
        const error = Math.abs(luminance - predicted);
        if (error < bestError) {
          bestError = error;
          bestBg = bi;
          bestFg = fi;
          bestGlyph = order[idx];
        }
      }
    }
    bg[i] = bestBg;
    fg[i] = bestFg;
    glyph[i] = bestGlyph;
  }
  return { bg, fg, glyph };
}

/**
 * Foreground-luminance planner: keeps the background fixed (theme base) and
 * only varies each glyph's gray level by the source luminance. Glyph choice
 * still follows the density ramp, so both channels carry brightness.
 */
export function planLuminanceChannel(
  toned: Float32Array,
  columns: number,
  rows: number,
  ramp: string,
  dither: DitherId,
  theme: OutputTheme,
  lumLut: Uint8Array = LUM_LUT,
): DualPlan {
  const indices = pickIndices(toned, columns, rows, ramp, dither);
  const last = ramp.length - 1;
  const length = toned.length;
  const bg = new Uint8Array(length);
  const fg = new Uint8Array(length);
  const glyph = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    const k = indices[i];
    glyph[i] = theme === "dark" ? last - k : k;
    fg[i] = lumLut[Math.min(255, Math.max(0, Math.round(toned[i] * 255)))];
  }
  return { bg, fg, glyph };
}

/**
 * Precompute the dual-channel decision table over 256 luminance levels.
 * Table layout: [q * 3] = bg index, [q * 3 + 1] = fg index, [q * 3 + 2] = glyph.
 */
export function buildDualLUT(
  ramp: string,
  inks: Float32Array,
  theme: OutputTheme,
): Uint8Array {
  const lut = new Uint8Array(256 * 3);
  const single = new Float32Array(1);
  for (let q = 0; q < 256; q += 1) {
    single[0] = q / 255;
    const plan = planDualChannel(single, 1, 1, ramp, inks, theme);
    lut[q * 3] = plan.bg[0];
    lut[q * 3 + 1] = plan.fg[0];
    lut[q * 3 + 2] = plan.glyph[0];
  }
  return lut;
}

/**
 * Fast dual-channel planning via a 256-level LUT. Dithering is approximated by
 * diffusing the error toward 256-quantized luminance before lookup.
 */
export function planDualLUT(
  toned: Float32Array,
  columns: number,
  rows: number,
  lut: Uint8Array,
  dither: DitherId,
): DualPlan {
  const length = toned.length;
  const bg = new Uint8Array(length);
  const fg = new Uint8Array(length);
  const glyph = new Uint8Array(length);
  const buffer = Float32Array.from(toned);

  for (let y = 0; y < rows; y += 1) {
    const leftToRight = y % 2 === 0;
    for (let step = 0; step < columns; step += 1) {
      const x = leftToRight ? step : columns - 1 - step;
      const i = y * columns + x;
      let q = Math.min(255, Math.max(0, Math.round(buffer[i] * 255)));
      if (dither === "bayer") {
        const matrix = [
          [1, 9, 3, 11],
          [13, 5, 15, 7],
          [4, 12, 2, 10],
          [16, 8, 14, 6],
        ];
        const offset = (matrix[y % 4][x % 4] - 8.5) / 17;
        q = Math.min(255, Math.max(0, Math.round((buffer[i] + offset / 255) * 255)));
      } else if (dither === "floyd") {
        const error = buffer[i] - q / 255;
        if (leftToRight) {
          if (x + 1 < columns) buffer[i + 1] += (error * 7) / 16;
          if (y + 1 < rows) {
            if (x > 0) buffer[i + columns - 1] += (error * 3) / 16;
            buffer[i + columns] += (error * 5) / 16;
            if (x + 1 < columns) buffer[i + columns + 1] += error / 16;
          }
        } else {
          if (x > 0) buffer[i - 1] += (error * 7) / 16;
          if (y + 1 < rows) {
            if (x + 1 < columns) buffer[i + columns + 1] += (error * 3) / 16;
            buffer[i + columns] += (error * 5) / 16;
            if (x > 0) buffer[i + columns - 1] += error / 16;
          }
        }
      }
      const base = q * 3;
      bg[i] = lut[base];
      fg[i] = lut[base + 1];
      glyph[i] = lut[base + 2];
    }
  }
  return { bg, fg, glyph };
}

function rampLevels(ramp: string): Float32Array {
  const levels = new Float32Array(ramp.length);
  for (let i = 0; i < ramp.length; i += 1) {
    levels[i] = i / (ramp.length - 1);
  }
  return levels;
}

function nearestIndex(levels: Float32Array, value: number): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < levels.length; i += 1) {
    const distance = Math.abs(levels[i] - value);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/** Choose a ramp index per cell with optional dithering. */
function pickIndices(
  toned: Float32Array,
  columns: number,
  rows: number,
  ramp: string,
  dither: DitherId,
): Int32Array {
  const levels = rampLevels(ramp);
  const out = new Int32Array(columns * rows);
  const length = ramp.length;

  if (dither === "floyd") {
    const buffer = Float32Array.from(toned);
    for (let y = 0; y < rows; y += 1) {
      const leftToRight = y % 2 === 0;
      for (let step = 0; step < columns; step += 1) {
        const x = leftToRight ? step : columns - 1 - step;
        const i = y * columns + x;
        const old = buffer[i];
        const k = nearestIndex(levels, old);
        out[i] = k;
        const error = old - levels[k];
        if (leftToRight) {
          if (x + 1 < columns) buffer[i + 1] += (error * 7) / 16;
          if (y + 1 < rows) {
            if (x > 0) buffer[i + columns - 1] += (error * 3) / 16;
            buffer[i + columns] += (error * 5) / 16;
            if (x + 1 < columns) buffer[i + columns + 1] += error / 16;
          }
        } else {
          if (x > 0) buffer[i - 1] += (error * 7) / 16;
          if (y + 1 < rows) {
            if (x + 1 < columns) buffer[i + columns + 1] += (error * 3) / 16;
            buffer[i + columns] += (error * 5) / 16;
            if (x > 0) buffer[i + columns - 1] += error / 16;
          }
        }
      }
    }
    return out;
  }

  if (dither === "bayer") {
    const matrix = [
      [1, 9, 3, 11],
      [13, 5, 15, 7],
      [4, 12, 2, 10],
      [16, 8, 14, 6],
    ];
    const step = 1 / Math.max(length - 1, 1);
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < columns; x += 1) {
        const i = y * columns + x;
        const offset = (matrix[y % 4][x % 4] - 8.5) / 17;
        const value = clamp01(toned[i] + offset * step);
        out[i] = Math.min(length - 1, Math.max(0, Math.round(value * (length - 1))));
      }
    }
    return out;
  }

  for (let i = 0; i < toned.length; i += 1) {
    out[i] = Math.min(
      length - 1,
      Math.max(0, Math.round(toned[i] * (length - 1))),
    );
  }
  return out;
}

/**
 * Encode a tone grid as text.
 * theme "dark" renders bright image areas with dense ink (phosphor terminal),
 * theme "light" renders dark image areas with dense ink (paper).
 */
export function encodeGrid(
  toned: Float32Array,
  columns: number,
  rows: number,
  ramp: RampId,
  dither: DitherId,
  theme: OutputTheme,
): string {
  const rampString = RAMPS[ramp];
  const indices = pickIndices(toned, columns, rows, rampString, dither);
  const last = rampString.length - 1;
  const lines: string[] = [];
  for (let y = 0; y < rows; y += 1) {
    let line = "";
    for (let x = 0; x < columns; x += 1) {
      const k = indices[y * columns + x];
      line += theme === "dark" ? rampString[last - k] : rampString[k];
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/**
 * Half-block variant: the tone grid is sampled at 2x row resolution; every
 * two pixel rows collapse into one character row of U+2588/2580/2584/space.
 */
export function encodeHalfBlock(
  toned: Float32Array,
  columns: number,
  sampleRows: number,
  ramp: RampId,
  dither: DitherId,
  theme: OutputTheme,
): string {
  const buffer = Float32Array.from(toned);
  const ink = new Uint8Array(columns * sampleRows);

  for (let y = 0; y < sampleRows; y += 1) {
    const leftToRight = y % 2 === 0;
    for (let step = 0; step < columns; step += 1) {
      const x = leftToRight ? step : columns - 1 - step;
      const i = y * columns + x;
      const old = buffer[i];
      const on = theme === "dark" ? old >= 0.5 : old < 0.5;
      ink[i] = on ? 1 : 0;
      const level = on ? 1 : 0;
      const error = old - level;
      if (leftToRight) {
        if (x + 1 < columns) buffer[i + 1] += (error * 7) / 16;
        if (y + 1 < sampleRows) {
          if (x > 0) buffer[i + columns - 1] += (error * 3) / 16;
          buffer[i + columns] += (error * 5) / 16;
          if (x + 1 < columns) buffer[i + columns + 1] += error / 16;
        }
      } else {
        if (x > 0) buffer[i - 1] += (error * 7) / 16;
        if (y + 1 < sampleRows) {
          if (x + 1 < columns) buffer[i + columns + 1] += (error * 3) / 16;
          buffer[i + columns] += (error * 5) / 16;
          if (x > 0) buffer[i + columns - 1] += error / 16;
        }
      }
    }
  }

  const lines: string[] = [];
  for (let y = 0; y < sampleRows; y += 2) {
    let line = "";
    for (let x = 0; x < columns; x += 1) {
      const top = ink[y * columns + x] === 1;
      const bottom = ink[(y + 1) * columns + x] === 1;
      if (top && bottom) line += "\u2588";
      else if (top) line += "\u2580";
      else if (bottom) line += "\u2584";
      else line += " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/** Run the full pipeline for one frame bitmap. */
export function convertBitmap(
  source: ImageDataLike,
  options: AsciiOptions,
  aspectFactor = 0.52,
): {
  text: string;
  columns: number;
  rows: number;
  sampleRows: number;
  toned: Float32Array;
} {
  const columns = Math.max(24, Math.min(480, options.columns));
  const rows = estimateRows(
    columns,
    source.width,
    source.height,
    options.halfBlock,
    aspectFactor,
  );
  const sampleRows = options.halfBlock ? rows * 2 : rows;
  const grid = boxGrid(source, columns, sampleRows);
  const toned = toneMap(grid, options.contrast, options.invert);
  const text = options.halfBlock
    ? encodeHalfBlock(toned, columns, sampleRows, options.ramp, options.dither, options.theme)
    : encodeGrid(toned, columns, sampleRows, options.ramp, options.dither, options.theme);
  return { text, columns, rows, sampleRows, toned };
}
