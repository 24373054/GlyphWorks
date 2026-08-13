import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildDualLUT,
  convertBitmap,
  DUAL_LEVELS,
  encodeGrid,
  encodeHalfBlock,
  estimateRows,
  FONT_STACK,
  LUM_LEVELS,
  LUM_LUT,
  luminance,
  planDualLUT,
  planLuminanceChannel,
  RAMPS,
  toneMap,
  type AsciiOptions,
  type DitherId,
  type DualPlan,
  type OutputTheme,
  type RampId,
} from "@/lib/ascii";
import TestPattern from "./TestPattern";
import { demoWoodcut } from "@/lib/demo";
import { DEFAULT_SIGNATURE, drawSignature } from "@/lib/signature";
import type { CliTask, DuotoneOptions, ProbeResult, SignatureOptions } from "@/shared/ipc";

type MediaKind = "image" | "video";
type ChannelMode = "density" | "luminance" | "dual" | "duotone";

type MediaState = {
  kind: MediaKind;
  url: string;
  name: string;
  path: string | null;
  native: boolean;
  frameUrl: string | null;
};

type ExportState = {
  active: boolean;
  progress: number;
  phase: "decode" | "render" | "encode";
};

const DEFAULT_OPTIONS: AsciiOptions = {
  columns: 110,
  ramp: "classic",
  contrast: 1,
  invert: false,
  halfBlock: false,
  dither: "floyd",
  theme: "dark",
};

interface Preset {
  name: string;
  channel: ChannelMode;
  options: Partial<AsciiOptions>;
}

/** 策展预设:像选刻刀一样选一套参数。 */
const PRESETS: Preset[] = [
  {
    name: "报版印刷",
    channel: "density",
    options: { columns: 96, ramp: "classic", contrast: 1.05, dither: "floyd", theme: "light", halfBlock: false, invert: false },
  },
  {
    name: "暗房磷光",
    channel: "density",
    options: { columns: 110, ramp: "classic", contrast: 1.15, dither: "floyd", theme: "dark", halfBlock: false, invert: false },
  },
  {
    name: "蓝图晒印",
    channel: "dual",
    options: { columns: 120, ramp: "block", contrast: 1.05, dither: "none", theme: "light", halfBlock: false, invert: false },
  },
  {
    name: "木刻拓片",
    channel: "density",
    options: { columns: 80, ramp: "block", contrast: 1.6, dither: "bayer", theme: "dark", halfBlock: false, invert: false },
  },
  {
    name: "电报窄带",
    channel: "density",
    options: { columns: 56, ramp: "simple", contrast: 1.3, dither: "none", theme: "dark", halfBlock: false, invert: false },
  },
  {
    name: "绢本细密",
    channel: "dual",
    options: { columns: 200, ramp: "classic", contrast: 0.9, dither: "floyd", theme: "dark", halfBlock: false, invert: false },
  },
];

const DEFAULT_DUOTONE: DuotoneOptions = { inkA: "#c23f26", inkB: "#3a3229", offset: 0 };

/** 套色策展:前景墨(字)+ 背景墨(底)+ 纸基。 */
const DUOTONE_PRESETS: Array<{
  name: string;
  base: OutputTheme;
  inkA: string;
  inkB: string;
}> = [
  { name: "朱砂拓墨", base: "dark", inkA: "#c23f26", inkB: "#3a3229" },
  { name: "磷光墨青", base: "dark", inkA: "#c6e88a", inkB: "#27424a" },
  { name: "靛蓝纸白", base: "light", inkA: "#2f4a5f", inkB: "#c9b98f" },
  { name: "朱印墨字", base: "light", inkA: "#241f18", inkB: "#c23f26" },
];

/** 样张档案:每次「盖印打样」留下一张版次卡。 */
interface ArchiveEntry {
  id: string;
  edition: number;
  mediaName: string;
  thumb: string;
  options: AsciiOptions;
  channel: ChannelMode;
  signature: SignatureOptions;
  duotone: DuotoneOptions | null;
  createdAt: number;
}

const ARCHIVE_KEY = "glyphworks.archive.v1";
const RECENT_KEY = "glyphworks.recent.v1";
const ARCHIVE_LIMIT = 24;
const RECENT_LIMIT = 8;
/** 成作画布像素上限(约 64MP),防止高列数 × 高精度分配失败。 */
const MAX_PROOF_PIXELS = 64_000_000;

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch {
    // 本地数据损坏时回退默认值
  }
  return fallback;
}

function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 存储满时静默降级,不影响转换
  }
}

/** 按像素上限把成作精度收敛到 1 / 2 / 4 档。 */
function clampProofScale(columns: number, rows: number, requested: number): number {
  const probe = document.createElement("canvas").getContext("2d");
  if (!probe) return 1;
  probe.font = `12px ${FONT_STACK}`;
  const charWidth = Math.max(probe.measureText("M").width, 1);
  const lineHeight = 12 * 1.22;
  const width1 = Math.ceil(charWidth * columns) + 10;
  const height1 = Math.ceil(lineHeight * rows) + 10;
  const areaScale = Math.sqrt(MAX_PROOF_PIXELS / (width1 * height1));
  const snapped = areaScale >= 4 ? 4 : areaScale >= 2 ? 2 : 1;
  return Math.max(1, Math.min(requested, snapped));
}

const IMAGE_EXTS = [
  "png", "jpg", "jpeg", "webp", "gif", "avif", "bmp", "svg", "tif", "tiff", "heic", "heif",
];

const clampColumns = (value: number, live: boolean) =>
  Math.max(40, Math.min(live ? 150 : 480, value));

function themeColors(theme: OutputTheme) {
  return theme === "dark"
    ? { bg: "#0d0b08", fg: "#c6e88a" }
    : { bg: "#e9e0cd", fg: "#241f18" };
}

function themeAnchors(theme: OutputTheme) {
  return theme === "dark"
    ? { darkest: "#0d0b08", brightest: "#c6e88a" }
    : { darkest: "#241f18", brightest: "#e9e0cd" };
}

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function mixRgb(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): string {
  const clamp = (v: number) => Math.round(Math.min(255, Math.max(0, v)));
  return `rgb(${clamp(a[0] + (b[0] - a[0]) * t)},${clamp(a[1] + (b[1] - a[1]) * t)},${clamp(a[2] + (b[2] - a[2]) * t)})`;
}

/**
 * 双色套印调色板:把双通道规划的 bg/fg 灰度级分别重映射为
 * 「纸基 → 背景墨」与「纸基 → 前景墨」两条色阶。灰度级方向随纸基反转:
 * 暗底 = 越亮越有墨,纸底 = 越暗越有墨。
 */
function duotonePalettes(
  base: OutputTheme,
  inkA: string,
  inkB: string,
): { bgColors: string[]; fgColors: string[] } {
  const levels = DUAL_LEVELS[base];
  const toInk = (values: number[], ink: string): string[] => {
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const direction = base === "dark" ? 1 : -1;
    const baseHex = hexToRgb(themeColors(base).bg);
    const inkRgb = hexToRgb(ink);
    return values.map((v) => {
      const t = direction === 1 ? (v - min) / span : (max - v) / span;
      return mixRgb(baseHex, inkRgb, 0.1 + t * 0.9);
    });
  };
  return {
    bgColors: toInk(levels.bg, inkB),
    fgColors: toInk(levels.fg, inkA),
  };
}

/** Measure the actual ink coverage of each ramp glyph in the output font. */
function measureRampInk(ramp: string): Float32Array {
  const canvas = document.createElement("canvas");
  const size = 24;
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const inks = new Float32Array(ramp.length);
  if (!context) return inks;
  context.font = `14px ${FONT_STACK}`;
  context.textBaseline = "top";
  for (let i = 0; i < ramp.length; i += 1) {
    context.clearRect(0, 0, size, size);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, size, size);
    context.fillStyle = "#000000";
    context.fillText(ramp[i], 2, 3);
    const data = context.getImageData(0, 0, size, size).data;
    let sum = 0;
    for (let p = 0; p < data.length; p += 4) sum += 255 - data[p];
    inks[i] = sum / (255 * size * size);
  }
  return inks;
}

function canvasFontMetrics(): { charWEm: number } {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return { charWEm: 0.52 };
  context.font = `100px ${FONT_STACK}`;
  return {
    charWEm: Math.max(context.measureText("M").width / 100, 0.3),
  };
}

function renderTextToCanvas(
  canvas: HTMLCanvasElement,
  text: string,
  columns: number,
  rows: number,
  theme: OutputTheme,
  size?: { width: number; height: number },
  fixedSize = false,
) {
  const context = canvas.getContext("2d");
  if (!context) return;
  const dpr = fixedSize ? 1 : Math.min(window.devicePixelRatio || 1, 1.25);
  const cssWidth = size?.width ?? Math.max(canvas.clientWidth, 120);
  const cssHeight = size?.height ?? Math.max(canvas.clientHeight, 80);
  const fontSize = Math.max(
    6,
    Math.min((cssWidth / columns) * 1.6, (cssHeight / rows) / 1.22),
  );
  const font = `${fontSize.toFixed(1)}px ${FONT_STACK}`;
  context.font = font;
  const charWidth = Math.max(context.measureText("M").width, 1);
  const lineHeight = fontSize * 1.22;
  if (!fixedSize) {
    canvas.width = Math.round(charWidth * columns * dpr);
    canvas.height = Math.round(lineHeight * rows * dpr);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  const colors = themeColors(theme);
  context.fillStyle = colors.bg;
  context.fillRect(0, 0, cssWidth, cssHeight);
  context.font = font;
  context.fillStyle = colors.fg;
  context.textBaseline = "top";
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    context.fillText(lines[i], 4, i * lineHeight + 4);
  }
}

function renderPlanToCanvas(
  canvas: HTMLCanvasElement,
  dual: DualPlan,
  columns: number,
  rows: number,
  ramp: string,
  theme: OutputTheme,
  mode: ChannelMode,
  size?: { width: number; height: number },
  fixedSize = false,
  duotone?: { bgColors: string[]; fgColors: string[]; offsetX: number; offsetY: number } | null,
) {
  const context = canvas.getContext("2d");
  if (!context) return;
  const dpr = fixedSize ? 1 : Math.min(window.devicePixelRatio || 1, 1.25);
  const cssWidth = size?.width ?? Math.max(canvas.clientWidth, 120);
  const cssHeight = size?.height ?? Math.max(canvas.clientHeight, 80);
  const fontSize = Math.max(
    4,
    Math.min((cssWidth / columns) * 1.6, (cssHeight / rows) / 1.22),
  );
  const font = `${fontSize.toFixed(1)}px ${FONT_STACK}`;
  context.font = font;
  const charWidth = Math.max(context.measureText("M").width, 1);
  const lineHeight = fontSize * 1.22;
  if (!fixedSize) {
    canvas.width = Math.round(charWidth * columns * dpr);
    canvas.height = Math.round(lineHeight * rows * dpr);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  const anchors = themeAnchors(theme);
  const darkest = hexToRgb(anchors.darkest);
  const brightest = hexToRgb(anchors.brightest);
  const baseBg = themeColors(theme).bg;
  const bgColors = duotone
    ? duotone.bgColors
    : mode === "dual"
      ? DUAL_LEVELS[theme].bg.map((level) => mixRgb(darkest, brightest, level))
      : null;
  const fgColors = duotone
    ? duotone.fgColors
    : mode === "dual"
      ? DUAL_LEVELS[theme].fg.map((level) => mixRgb(darkest, brightest, level))
      : LUM_LEVELS.map((level) => mixRgb(darkest, brightest, level));
  const offsetX = duotone?.offsetX ?? 0;
  const offsetY = duotone?.offsetY ?? 0;
  const cellWidth = cssWidth / columns;
  const cellHeight = cssHeight / rows;
  context.fillStyle = baseBg;
  context.fillRect(0, 0, cssWidth, cssHeight);
  context.textBaseline = "middle";
  let currentBg = -1;
  let currentFg = -1;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const i = row * columns + column;
      const x = column * cellWidth;
      const y = row * cellHeight;
      if (bgColors) {
        const bgIndex = dual.bg[i];
        if (bgIndex !== currentBg) {
          context.fillStyle = bgColors[bgIndex];
          currentBg = bgIndex;
        }
        context.fillRect(x, y, cellWidth + 0.5, cellHeight + 0.5);
      }
      const glyph = ramp[dual.glyph[i]];
      if (glyph !== " ") {
        const fgIndex = dual.fg[i];
        if (fgIndex !== currentFg) {
          context.fillStyle = fgColors[fgIndex];
          currentFg = fgIndex;
        }
        context.font = font;
        context.fillText(
          glyph,
          x + offsetX + (cellWidth - charWidth) / 2,
          y + offsetY + cellHeight / 2,
        );
      }
    }
  }
}

/**
 * Render the ASCII art into the given canvas at its intrinsic bitmap size
 * (12px font × scale, measured character metrics). With a signature present,
 * a cinnabar seal and colophon are stamped onto the finished print.
 */
function drawAsciiToCanvas(
  canvas: HTMLCanvasElement,
  converted: {
    text: string;
    columns: number;
    rows: number;
    sampleRows: number;
    toned: Float32Array;
  },
  plan: DualPlan | null,
  chan: ChannelMode,
  theme: OutputTheme,
  ramp: RampId,
  opts: { scale?: number; signature?: SignatureOptions; duotone?: DuotoneOptions | null } = {},
) {
  const fontSize = 12 * (opts.scale ?? 1);
  const context = canvas.getContext("2d");
  if (!context) return;
  context.font = `${fontSize}px ${FONT_STACK}`;
  const charWidth = Math.max(context.measureText("M").width, 1);
  const lineHeight = fontSize * 1.22;
  const width = Math.ceil(charWidth * converted.columns) + 10;
  const height = Math.ceil(lineHeight * converted.rows) + 10;
  canvas.width = width;
  canvas.height = height;
  if (chan !== "density" && plan) {
    const palette =
      chan === "duotone" && opts.duotone
        ? {
            ...duotonePalettes(theme, opts.duotone.inkA, opts.duotone.inkB),
            offsetX: opts.duotone.offset * (opts.scale ?? 1),
            offsetY: Math.round(opts.duotone.offset * 0.6 * (opts.scale ?? 1)),
          }
        : null;
    renderPlanToCanvas(
      canvas,
      plan,
      converted.columns,
      converted.rows,
      RAMPS[ramp],
      theme,
      chan,
      { width, height },
      true,
      palette,
    );
    if (opts.signature) drawSignature(context, width, height, opts.signature, theme);
    return;
  }
  const colors = themeColors(theme);
  context.fillStyle = colors.bg;
  context.fillRect(0, 0, width, height);
  context.font = `${fontSize}px ${FONT_STACK}`;
  context.fillStyle = colors.fg;
  context.textBaseline = "top";
  converted.text.split("\n").forEach((line, index) => {
    context.fillText(line, 5, index * lineHeight + 5);
  });
  if (opts.signature) drawSignature(context, width, height, opts.signature, theme);
}

/** Convert a grid-size RGB24 frame (from ffmpeg decode) into the export canvas. */
function renderGridFrame(
  canvas: HTMLCanvasElement,
  raw: Uint8Array,
  columns: number,
  sampleRows: number,
  options: AsciiOptions,
  channel: ChannelMode,
  dualLUT: Uint8Array,
  size: { width: number; height: number },
  signature?: SignatureOptions,
  duotone?: DuotoneOptions | null,
) {
  const grid = new Float32Array(columns * sampleRows);
  for (let i = 0; i < grid.length; i += 1) {
    const offset = i * 3;
    grid[i] = luminance(raw[offset], raw[offset + 1], raw[offset + 2]);
  }
  const toned = toneMap(grid, options.contrast, options.invert);
  const halfBlock = channel === "density" && options.halfBlock;
  const textRows = halfBlock ? sampleRows / 2 : sampleRows;
  const context = canvas.getContext("2d");
  if (!context) return;
  if (channel !== "density") {
    const plan =
      channel === "dual" || channel === "duotone"
        ? planDualLUT(toned, columns, sampleRows, dualLUT, options.dither)
        : planLuminanceChannel(
            toned,
            columns,
            sampleRows,
            RAMPS[options.ramp],
            options.dither,
            options.theme,
            LUM_LUT,
          );
    const palette =
      channel === "duotone" && duotone
        ? {
            ...duotonePalettes(options.theme, duotone.inkA, duotone.inkB),
            offsetX: duotone.offset,
            offsetY: Math.round(duotone.offset * 0.6),
          }
        : null;
    renderPlanToCanvas(
      canvas,
      plan,
      columns,
      textRows,
      RAMPS[options.ramp],
      options.theme,
      channel,
      size,
      true,
      palette,
    );
    if (signature) drawSignature(context, canvas.width, canvas.height, signature, options.theme);
    return;
  }
  const text = halfBlock
    ? encodeHalfBlock(toned, columns, sampleRows, options.ramp, options.dither, options.theme)
    : encodeGrid(toned, columns, sampleRows, options.ramp, options.dither, options.theme);
  renderTextToCanvas(canvas, text, columns, textRows, options.theme, size, true);
  if (signature) drawSignature(context, canvas.width, canvas.height, signature, options.theme);
}

function makeExportCanvas(
  columns: number,
  textRows: number,
  theme: OutputTheme,
  maxDimension = 1920,
): HTMLCanvasElement {
  const probe = document.createElement("canvas").getContext("2d");
  if (!probe) throw new Error("无法创建绘图上下文");
  probe.font = `12px ${FONT_STACK}`;
  const charWidth = Math.max(probe.measureText("M").width, 1);
  const lineHeight = 12 * 1.22;
  const toEven = (value: number) => (value % 2 === 0 ? value : value + 1);
  let width = toEven(Math.ceil(charWidth * columns) + 8);
  let height = toEven(Math.ceil(lineHeight * textRows) + 8);
  // 大画布会让 x264 / GIF 在内存紧张的机器上分配失败:把最长边限制到
  // maxDimension(MP4 1920,GIF 960),字符按目标画布等比缩小,输出不受影响。
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  if (scale < 1) {
    width = toEven(Math.max(2, Math.round(width * scale)));
    height = toEven(Math.max(2, Math.round(height * scale)));
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context) {
    context.fillStyle = themeColors(theme).bg;
    context.fillRect(0, 0, width, height);
  }
  return canvas;
}

function canvasToBuffer(
  canvas: HTMLCanvasElement,
  mime: string,
  quality?: number,
): Promise<ArrayBuffer | null> {
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          resolve(null);
          return;
        }
        void blob.arrayBuffer().then(resolve);
      },
      mime,
      quality,
    );
  });
}

function canvasToJpegBytes(canvas: HTMLCanvasElement, quality: number): Uint8Array<ArrayBuffer> | null {
  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function uint8ToArrayBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(data.byteLength);
  new Uint8Array(copy).set(data);
  return copy;
}

function loadImageFromBuffer(data: Uint8Array): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([uint8ToArrayBuffer(data)], { type: "image/png" }));
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("图片解码失败"));
    };
    image.src = url;
  });
}

function basename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? "媒体文件";
}

export default function AsciiStudio() {
  const [media, setMedia] = useState<MediaState | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null);
  const [options, setOptions] = useState<AsciiOptions>(DEFAULT_OPTIONS);
  const [output, setOutput] = useState<{
    text: string;
    columns: number;
    rows: number;
    sampleRows: number;
    toned: Float32Array;
  } | null>(null);
  const [generatedMs, setGeneratedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [videoTime, setVideoTime] = useState(0);
  const [frameVersion, setFrameVersion] = useState(0);
  const [copied, setCopied] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [posterUrl, setPosterUrl] = useState<string | null>(null);
  const [nativeBusy, setNativeBusy] = useState(false);
  const [exporting, setExporting] = useState<ExportState | null>(null);
  const [channel, setChannel] = useState<ChannelMode>("density");
  const [dirty, setDirty] = useState(false);
  const [renderVersion, setRenderVersion] = useState(0);
  const [cliTask, setCliTask] = useState<CliTask | null>(null);
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [proofNumber, setProofNumber] = useState(0);
  const [appliedTheme, setAppliedTheme] = useState<OutputTheme>("dark");
  const [signature, setSignature] = useState<SignatureOptions>(DEFAULT_SIGNATURE);
  const [duotone, setDuotone] = useState<DuotoneOptions>(DEFAULT_DUOTONE);
  const [exportScale, setExportScale] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [compareOn, setCompareOn] = useState(false);
  const [compareUrl, setCompareUrl] = useState<string | null>(null);
  const [archive, setArchive] = useState<ArchiveEntry[]>(() =>
    loadJson<ArchiveEntry[]>(ARCHIVE_KEY, []),
  );
  const [recent, setRecent] = useState<string[]>(() => loadJson<string[]>(RECENT_KEY, []));

  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const liveCanvasRef = useRef<HTMLCanvasElement>(null);
  const liveStageRef = useRef<HTMLDivElement>(null);
  const bitmapCanvasRef = useRef<HTMLCanvasElement>(null);
  const appliedRef = useRef<{
    options: AsciiOptions;
    channel: ChannelMode;
  }>({ options: DEFAULT_OPTIONS, channel: "density" });
  const tmpCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const liveInViewRef = useRef(true);
  const motionOkRef = useRef(true);
  const posterDoneRef = useRef(false);
  const exportCancelRef = useRef(false);
  const exportSessionRef = useRef<string | null>(null);
  const nativeFrameImageRef = useRef<HTMLImageElement | null>(null);
  const nativeFrameUrlRef = useRef<string | null>(null);
  const nativeFrameSeqRef = useRef(0);
  const nativeFrameTimerRef = useRef<number | null>(null);
  const cliStartedRef = useRef(false);
  const proofPrintRef = useRef<HTMLDivElement>(null);
  const revealRef = useRef(false);
  const proofNumberRef = useRef(0);
  const stampRef = useRef<{
    edition: number;
    signature: SignatureOptions;
    duotone: DuotoneOptions;
  } | null>(null);
  const mediaNameRef = useRef("");
  const dragPathRef = useRef<string | null>(null);
  const panRef = useRef({ active: false, startX: 0, startY: 0, origX: 0, origY: 0 });

  const setOption = useCallback(
    <K extends keyof AsciiOptions>(key: K, value: AsciiOptions[K]) => {
      setActivePreset(null);
      setOptions((previous) => ({ ...previous, [key]: value }));
      if (live) {
        appliedRef.current = { options: { ...options, [key]: value }, channel };
        setDirty(false);
      } else {
        setDirty(true);
      }
    },
    [live, options, channel],
  );

  const applyPreset = useCallback((preset: Preset) => {
    setOptions((previous) => ({ ...previous, ...preset.options }));
    setChannel(preset.channel);
    setActivePreset(preset.name);
    setDirty(true);
  }, []);

  const resetMediaState = useCallback(
    (next: {
      kind: MediaKind;
      url: string;
      name: string;
      path: string | null;
      native: boolean;
      probe: ProbeResult;
    }) => {
      setMedia({
        kind: next.kind,
        url: next.url,
        name: next.name,
        path: next.path,
        native: next.native,
        frameUrl: null,
      });
      setProbe(next.probe);
      setDims(
        next.probe.width > 0 && next.probe.height > 0
          ? { width: next.probe.width, height: next.probe.height }
          : null,
      );
      setOutput(null);
      setError(null);
      setLive(false);
      setPlaying(false);
      setVideoTime(0);
      setFrameVersion(0);
      setPosterUrl(null);
      setNativeBusy(false);
      posterDoneRef.current = false;
      nativeFrameImageRef.current = null;
      nativeFrameSeqRef.current += 1;
      if (nativeFrameTimerRef.current) {
        window.clearTimeout(nativeFrameTimerRef.current);
        nativeFrameTimerRef.current = null;
      }
      if (nativeFrameUrlRef.current) {
        URL.revokeObjectURL(nativeFrameUrlRef.current);
        nativeFrameUrlRef.current = null;
      }
      appliedRef.current = { options, channel };
      setActivePreset(null);
      setDirty(false);
      revealRef.current = true;
      proofNumberRef.current = 0;
      setProofNumber(0);
      setCompareOn(false);
      setCompareUrl(null);
      setZoom(1);
      setPan({ x: 0, y: 0 });
      dragPathRef.current = null;
      mediaNameRef.current = next.name;
    },
    [options, channel],
  );

  const loadDemo = useCallback(() => {
    const dataUrl = demoWoodcut();
    resetMediaState({
      kind: "image",
      url: dataUrl,
      name: "示例 · 木版山水",
      path: null,
      native: false,
      probe: {
        ok: true,
        kind: "image",
        width: 0,
        height: 0,
        duration: null,
        fps: null,
        hasAudio: false,
        formatName: "demo",
        codecName: "",
      },
    });
  }, [resetMediaState]);

  const loadPath = useCallback(
    async (filePath: string, knownProbe?: ProbeResult) => {
      const resolvedProbe = knownProbe ?? (await window.app.probe(filePath));
      const name = basename(filePath);
      const ext = name.split(".").pop()?.toLowerCase() ?? "";
      let kind: MediaKind;
      if (resolvedProbe.ok && resolvedProbe.kind !== "unknown") {
        kind = resolvedProbe.kind;
      } else if (IMAGE_EXTS.includes(ext)) {
        kind = "image";
      } else {
        kind = "video";
      }
      resetMediaState({
        kind,
        url: window.app.mediaUrl(filePath),
        name,
        path: filePath,
        native: false,
        probe: resolvedProbe,
      });
      setRecent((previous) => {
        const next = [filePath, ...previous.filter((p) => p !== filePath)].slice(0, RECENT_LIMIT);
        saveJson(RECENT_KEY, next);
        return next;
      });
      void window.app.markRecent(filePath);
    },
    [resetMediaState],
  );

  const openFromDialog = useCallback(async () => {
    const opened = await window.app.openFile();
    if (!opened) return;
    await loadPath(opened.path, opened.probe);
  }, [loadPath]);

  const openFromFile = useCallback(
    async (file: File) => {
      try {
        const filePath = window.app.getPathForFile(file);
        if (filePath) {
          await loadPath(filePath);
          return;
        }
      } catch {
        // 拿不到真实路径时回退到浏览器内存预览（无法导出视频）
      }
      const url = URL.createObjectURL(file);
      const kind: MediaKind = file.type.startsWith("video/") ? "video" : "image";
      resetMediaState({
        kind,
        url,
        name: file.name,
        path: null,
        native: false,
        probe: {
          ok: true,
          kind,
          width: 0,
          height: 0,
          duration: null,
          fps: null,
          hasAudio: false,
          formatName: file.type,
          codecName: "",
        },
      });
    },
    [loadPath, resetMediaState],
  );

  const activateNativeImage = useCallback(async () => {
    if (!media || media.kind !== "image" || !media.path) {
      setError("这张图片无法解码，请换用 PNG / JPG / WebP 等常见格式。");
      return;
    }
    if (media.native) {
      setError("这张图片无法解码，请换用 PNG / JPG / WebP 等常见格式。");
      return;
    }
    setNativeBusy(true);
    try {
      const { data } = await window.app.decodeImage(media.path, 1024);
      const url = URL.createObjectURL(new Blob([uint8ToArrayBuffer(data)], { type: "image/png" }));
      if (nativeFrameUrlRef.current) URL.revokeObjectURL(nativeFrameUrlRef.current);
      nativeFrameUrlRef.current = url;
      setMedia((previous) => (previous ? { ...previous, url, native: true } : previous));
    } catch (error) {
      setError(`这张图片无法解码：${String(error).slice(0, 300)}`);
    } finally {
      setNativeBusy(false);
    }
  }, [media]);

  const requestNativeFrame = useCallback(
    async (time: number) => {
      if (!media || media.kind !== "video" || !media.path) return;
      const sequence = nativeFrameSeqRef.current + 1;
      nativeFrameSeqRef.current = sequence;
      setNativeBusy(true);
      try {
        const { data } = await window.app.extractFrame(media.path, time, 1024);
        if (sequence !== nativeFrameSeqRef.current) return;
        const url = URL.createObjectURL(new Blob([uint8ToArrayBuffer(data)], { type: "image/png" }));
        const image = new Image();
        await new Promise<void>((resolve, reject) => {
          image.onload = () => resolve();
          image.onerror = () => reject(new Error("画面解码失败"));
          image.src = url;
        });
        if (sequence !== nativeFrameSeqRef.current) {
          URL.revokeObjectURL(url);
          return;
        }
        if (nativeFrameUrlRef.current) URL.revokeObjectURL(nativeFrameUrlRef.current);
        nativeFrameUrlRef.current = url;
        nativeFrameImageRef.current = image;
        setMedia((previous) => (previous ? { ...previous, frameUrl: url, native: true } : previous));
        setFrameVersion((value) => value + 1);
      } catch (error) {
        if (sequence === nativeFrameSeqRef.current) {
          setError(`取帧失败：${String(error).slice(0, 300)}`);
        }
      } finally {
        if (sequence === nativeFrameSeqRef.current) setNativeBusy(false);
      }
    },
    [media],
  );

  const activateNativeVideo = useCallback(async () => {
    if (!media || media.kind !== "video" || media.native) return;
    setMedia((previous) => (previous ? { ...previous, native: true } : previous));
    setLive(false);
    await requestNativeFrame(videoTime);
  }, [media, videoTime, requestNativeFrame]);

  const makePoster = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || posterDoneRef.current) return;
    posterDoneRef.current = true;
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = Math.max(1, Math.round((320 * video.videoHeight) / Math.max(video.videoWidth, 1)));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    setPosterUrl(canvas.toDataURL("image/jpeg", 0.72));
  }, []);

  useEffect(() => {
    const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const connection = (navigator as Navigator & {
      connection?: {
        saveData?: boolean;
        effectiveType?: string;
        addEventListener?: (type: string, listener: () => void) => void;
        removeEventListener?: (type: string, listener: () => void) => void;
      };
    }).connection;
    const updateMotion = () => {
      const reduced = reducedQuery.matches;
      const saveData = Boolean(
        connection?.saveData || ["slow-2g", "2g"].includes(connection?.effectiveType ?? ""),
      );
      motionOkRef.current = !reduced && !saveData;
      if (!motionOkRef.current) setLive(false);
    };
    updateMotion();
    const observer = new IntersectionObserver(
      ([entry]) => {
        liveInViewRef.current = entry.isIntersecting;
      },
      { threshold: 0.1 },
    );
    const stage = liveStageRef.current;
    if (stage) observer.observe(stage);
    document.addEventListener("visibilitychange", updateMotion);
    reducedQuery.addEventListener("change", updateMotion);
    connection?.addEventListener?.("change", updateMotion);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", updateMotion);
      reducedQuery.removeEventListener("change", updateMotion);
      connection?.removeEventListener?.("change", updateMotion);
    };
  }, []);

  const captureBitmap = useCallback((theme: OutputTheme): ImageData | null => {
    const canvas = tmpCanvasRef.current ?? document.createElement("canvas");
    tmpCanvasRef.current = canvas;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    let sourceWidth = 0;
    let sourceHeight = 0;
    let drawSource: CanvasImageSource | null = null;
    if (media?.kind === "image") {
      const image = imageRef.current;
      if (!image || !image.naturalWidth) return null;
      sourceWidth = image.naturalWidth;
      sourceHeight = image.naturalHeight;
      drawSource = image;
    } else if (media?.kind === "video") {
      if (media.native) {
        const image = nativeFrameImageRef.current;
        if (!image || !image.naturalWidth) return null;
        sourceWidth = image.naturalWidth;
        sourceHeight = image.naturalHeight;
        drawSource = image;
      } else {
        const video = videoRef.current;
        if (!video || !video.videoWidth) return null;
        sourceWidth = video.videoWidth;
        sourceHeight = video.videoHeight;
        drawSource = video;
      }
    } else {
      return null;
    }
    const maxDimension = 1024;
    const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(2, Math.round(sourceWidth * scale));
    const height = Math.max(2, Math.round(sourceHeight * scale));
    canvas.width = width;
    canvas.height = height;
    const colors = themeColors(theme);
    context.fillStyle = colors.bg;
    context.fillRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(drawSource, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
  }, [media]);

  useEffect(() => {
    return window.app.onExportProgress((progress) => {
      if (exportSessionRef.current && !exportCancelRef.current) {
        setExporting({
          active: true,
          progress: progress.progress,
          phase: progress.phase === "render" ? "render" : progress.phase,
        });
      }
    });
  }, []);

  const applyRender = useCallback(() => {
    try {
      const { options: appliedOptions, channel: appliedChannel } = appliedRef.current;
      const source = captureBitmap(appliedOptions.theme);
      if (!source) return;
      const started = performance.now();
      const effectiveOptions =
        appliedChannel === "density"
          ? appliedOptions
          : { ...appliedOptions, halfBlock: false };
      const metrics = canvasFontMetrics();
      const aspectFactor = metrics.charWEm / 1.22;
      const converted = convertBitmap(source, effectiveOptions, aspectFactor);
      let plan: DualPlan | null = null;
      if (appliedChannel !== "density") {
        const inks = measureRampInk(RAMPS[appliedOptions.ramp]);
        const dualLUT = buildDualLUT(RAMPS[appliedOptions.ramp], inks, appliedOptions.theme);
        plan =
          appliedChannel === "dual" || appliedChannel === "duotone"
            ? planDualLUT(
                converted.toned,
                converted.columns,
                converted.sampleRows,
                dualLUT,
                effectiveOptions.dither,
              )
            : planLuminanceChannel(
                converted.toned,
                converted.columns,
                converted.sampleRows,
                RAMPS[appliedOptions.ramp],
                effectiveOptions.dither,
                appliedOptions.theme,
                LUM_LUT,
              );
      }
      const bitmapCanvas = bitmapCanvasRef.current;
      if (bitmapCanvas) {
        drawAsciiToCanvas(
          bitmapCanvas,
          converted,
          plan,
          appliedChannel,
          appliedOptions.theme,
          appliedOptions.ramp,
          { signature, duotone: appliedChannel === "duotone" ? duotone : null },
        );
      }
      setOutput(converted);
      setGeneratedMs(Math.max(1, Math.round(performance.now() - started)));
      setAppliedTheme(appliedOptions.theme);
      setZoom(1);
      setPan({ x: 0, y: 0 });
      dragPathRef.current = null;
      if (revealRef.current) {
        revealRef.current = false;
        const printEl = proofPrintRef.current;
        if (printEl && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          printEl.classList.remove("is-printing");
          void printEl.offsetWidth;
          printEl.classList.add("is-printing");
        }
      }
      if (stampRef.current && bitmapCanvas) {
        const stamp = stampRef.current;
        stampRef.current = null;
        const thumb = document.createElement("canvas");
        const thumbScale = Math.min(1, 240 / Math.max(bitmapCanvas.width, 1));
        thumb.width = Math.max(1, Math.round(bitmapCanvas.width * thumbScale));
        thumb.height = Math.max(1, Math.round(bitmapCanvas.height * thumbScale));
        const thumbContext = thumb.getContext("2d");
        if (thumbContext) {
          thumbContext.drawImage(bitmapCanvas, 0, 0, thumb.width, thumb.height);
          const entry: ArchiveEntry = {
            id: `${Date.now()}-${stamp.edition}`,
            edition: stamp.edition,
            mediaName: mediaNameRef.current,
            thumb: thumb.toDataURL("image/jpeg", 0.72),
            options: { ...appliedOptions },
            channel: appliedChannel,
            signature: stamp.signature,
            duotone: appliedChannel === "duotone" ? { ...stamp.duotone } : null,
            createdAt: Date.now(),
          };
          setArchive((previous) => {
            const next = [entry, ...previous].slice(0, ARCHIVE_LIMIT);
            saveJson(ARCHIVE_KEY, next);
            return next;
          });
        }
      }
    } catch (renderError) {
      setError(`渲染失败：${String(renderError).slice(0, 400)}`);
    }
  }, [captureBitmap, signature, duotone]);

  useEffect(() => {
    if (!media) return;
    if (media.kind === "image" && !dims) return;
    if (media.kind === "video" && live) return;
    const timer = window.setTimeout(applyRender, 90);
    return () => window.clearTimeout(timer);
  }, [media, dims, live, frameVersion, renderVersion, applyRender]);

  const renderLiveFrame = useCallback(() => {
    const canvas = liveCanvasRef.current;
    if (!canvas) return;
    const source = captureBitmap(options.theme);
    if (!source) return;
    const effectiveOptions =
      channel === "density"
        ? { ...options, columns: clampColumns(options.columns, true) }
        : { ...options, halfBlock: false, columns: clampColumns(options.columns, true) };
    const metrics = canvasFontMetrics();
    const aspectFactor = metrics.charWEm / 1.22;
    const converted = convertBitmap(source, effectiveOptions, aspectFactor);
    let plan: DualPlan | null = null;
    if (channel !== "density") {
      const inks = measureRampInk(RAMPS[options.ramp]);
      const dualLUT = buildDualLUT(RAMPS[options.ramp], inks, options.theme);
      plan =
        channel === "dual" || channel === "duotone"
          ? planDualLUT(
              converted.toned,
              converted.columns,
              converted.sampleRows,
              dualLUT,
              effectiveOptions.dither,
            )
          : planLuminanceChannel(
              converted.toned,
              converted.columns,
              converted.sampleRows,
              RAMPS[options.ramp],
              effectiveOptions.dither,
              options.theme,
              LUM_LUT,
            );
    }
    drawAsciiToCanvas(canvas, converted, plan, channel, options.theme, options.ramp, {
      signature,
      duotone: channel === "duotone" ? duotone : null,
    });
  }, [captureBitmap, channel, options, signature, duotone]);

  useEffect(() => {
    if (!(media?.kind === "video" && !media.native && live)) return;
    const video = videoRef.current;
    if (!video) return;
    video.muted = true;
    video.playsInline = true;
    video.loop = true;
    const playPromise = video.play();
    playPromise?.catch(() => setPlaying(false));
    let raf = 0;
    let lastFrame = 0;
    const loop = (time: number) => {
      if (!liveInViewRef.current || document.hidden || !motionOkRef.current) {
        raf = 0;
        return;
      }
      if (time - lastFrame >= 1000 / 15) {
        renderLiveFrame();
        lastFrame = time;
      }
      raf = window.requestAnimationFrame(loop);
    };
    raf = window.requestAnimationFrame(loop);
    return () => {
      window.cancelAnimationFrame(raf);
      video.pause();
      setPlaying(false);
    };
  }, [media, live, renderLiveFrame]);

  const applyParams = useCallback(() => {
    appliedRef.current = { options, channel };
    setDirty(false);
    revealRef.current = true;
    proofNumberRef.current += 1;
    setProofNumber(proofNumberRef.current);
    stampRef.current = { edition: proofNumberRef.current, signature, duotone };
    setRenderVersion((value) => value + 1);
  }, [options, channel, signature, duotone]);

  const changeChannel = useCallback(
    (next: ChannelMode) => {
      setActivePreset(null);
      setChannel(next);
      appliedRef.current = { options, channel: next };
      setDirty(false);
      setRenderVersion((value) => value + 1);
    },
    [options],
  );

  const setLiveMode = useCallback(
    (next: boolean) => {
      setLive(next);
      if (next) {
        appliedRef.current = { options, channel };
        setDirty(false);
      }
    },
    [options, channel],
  );

  const copyText = useCallback(async () => {
    if (!output) return;
    try {
      await window.app.copyText(output.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("复制失败，可以改用「保存 .txt」。");
    }
  }, [output]);

  const downloadTxt = useCallback(async () => {
    if (!output) return;
    const stem = (media?.name ?? "ascii").replace(/\.[^.]+$/, "");
    await window.app.saveText(`${stem}-ascii.txt`, output.text);
  }, [media, output]);

  const changeSignature = useCallback((key: keyof SignatureOptions, value: string | boolean) => {
    setSignature((previous) => ({ ...previous, [key]: value }));
    setRenderVersion((value) => value + 1);
  }, []);

  /** 套色只改呈现(配色/错位),不重算规划:即时生效,无需盖印。 */
  const changeDuotone = useCallback((key: keyof DuotoneOptions, value: string | number) => {
    setDuotone((previous) => ({ ...previous, [key]: value }));
    setRenderVersion((value) => value + 1);
  }, []);

  const applyDuotonePreset = useCallback(
    (preset: { name: string; base: OutputTheme; inkA: string; inkB: string }) => {
      setDuotone((previous) => ({ ...previous, inkA: preset.inkA, inkB: preset.inkB }));
      if (options.theme !== preset.base) {
        setOptions((previous) => ({ ...previous, theme: preset.base }));
        setDirty(true);
      }
      setRenderVersion((value) => value + 1);
    },
    [options.theme],
  );

  /** 按当前已应用参数重绘一版成作(供 PNG 保存与拖出),精度按像素上限收敛。 */
  const renderProofCanvas = useCallback(
    async (scale: number): Promise<HTMLCanvasElement | null> => {
      const { options: appliedOptions, channel: appliedChannel } = appliedRef.current;
      const source = captureBitmap(appliedOptions.theme);
      if (!source) return null;
      const effectiveOptions =
        appliedChannel === "density"
          ? appliedOptions
          : { ...appliedOptions, halfBlock: false };
      const metrics = canvasFontMetrics();
      const aspectFactor = metrics.charWEm / 1.22;
      const converted = convertBitmap(source, effectiveOptions, aspectFactor);
      const effectiveScale = clampProofScale(converted.columns, converted.rows, scale);
      let plan: DualPlan | null = null;
      if (appliedChannel !== "density") {
        const inks = measureRampInk(RAMPS[appliedOptions.ramp]);
        const dualLUT = buildDualLUT(RAMPS[appliedOptions.ramp], inks, appliedOptions.theme);
        plan =
          appliedChannel === "dual" || appliedChannel === "duotone"
            ? planDualLUT(
                converted.toned,
                converted.columns,
                converted.sampleRows,
                dualLUT,
                effectiveOptions.dither,
              )
            : planLuminanceChannel(
                converted.toned,
                converted.columns,
                converted.sampleRows,
                RAMPS[appliedOptions.ramp],
                effectiveOptions.dither,
                appliedOptions.theme,
                LUM_LUT,
              );
      }
      const canvas = document.createElement("canvas");
      drawAsciiToCanvas(
        canvas,
        converted,
        plan,
        appliedChannel,
        appliedOptions.theme,
        appliedOptions.ramp,
        {
          scale: effectiveScale,
          signature,
          duotone: appliedChannel === "duotone" ? duotone : null,
        },
      );
      return canvas;
    },
    [captureBitmap, signature, duotone],
  );

  const downloadPng = useCallback(async () => {
    if (!media) return;
    const stem = media.name.replace(/\.[^.]+$/, "");
    const canvas = await renderProofCanvas(exportScale);
    if (!canvas) return;
    const buffer = await canvasToBuffer(canvas, "image/png");
    if (!buffer) return;
    await window.app.saveBuffer(`${stem}-ascii.png`, buffer, "image/png");
  }, [media, renderProofCanvas, exportScale]);

  const prepareDragPng = useCallback(async (): Promise<string | null> => {
    if (!media) return null;
    const canvas = await renderProofCanvas(exportScale);
    if (!canvas) return null;
    const buffer = await canvasToBuffer(canvas, "image/png");
    if (!buffer) return null;
    const stem = media.name.replace(/\.[^.]+$/, "");
    return window.app.saveTemp(buffer, `${stem}-ascii.png`);
  }, [media, renderProofCanvas, exportScale]);

  const toggleCompare = useCallback(() => {
    if (!compareOn) {
      const source = captureBitmap(appliedRef.current.options.theme);
      if (source) {
        const canvas = document.createElement("canvas");
        canvas.width = source.width;
        canvas.height = source.height;
        const context = canvas.getContext("2d");
        if (context) {
          context.putImageData(source, 0, 0);
          setCompareUrl(canvas.toDataURL("image/jpeg", 0.85));
        } else {
          setCompareUrl(null);
        }
      } else {
        setCompareUrl(null);
      }
    }
    setCompareOn((previous) => !previous);
  }, [compareOn, captureBitmap]);

  const updateArchive = useCallback((updater: (previous: ArchiveEntry[]) => ArchiveEntry[]) => {
    setArchive((previous) => {
      const next = updater(previous);
      saveJson(ARCHIVE_KEY, next);
      return next;
    });
  }, []);

  const restoreEntry = useCallback((entry: ArchiveEntry) => {
    setOptions(entry.options);
    setChannel(entry.channel);
    setSignature(entry.signature);
    setDuotone(entry.duotone ?? DEFAULT_DUOTONE);
    setActivePreset(null);
    appliedRef.current = { options: entry.options, channel: entry.channel };
    setDirty(false);
    revealRef.current = true;
    setRenderVersion((value) => value + 1);
  }, []);

  const runVideoExport = useCallback(
    async (input: {
      outputPath: string;
      sourcePath: string;
      options: AsciiOptions;
      channel: ChannelMode;
      probe: ProbeResult | null;
      signature: SignatureOptions;
      duotone: DuotoneOptions | null;
    }): Promise<{ ok: boolean; error?: string }> => {
      const {
        outputPath,
        sourcePath,
        options: exportOptions,
        channel: exportChannel,
        probe: exportProbe,
        signature: exportSignature,
        duotone: exportDuotone,
      } = input;
      const isGif = outputPath.toLowerCase().endsWith(".gif");
      const duration = exportProbe?.duration ?? null;
      if (!duration || duration <= 0) {
        return { ok: false, error: "无法读取视频时长，请重新选择文件。" };
      }
      const fps = Math.min(isGif ? 15 : 240, Math.max(1, exportProbe?.fps ?? 30));
      const width = exportProbe?.width ?? 0;
      const height = exportProbe?.height ?? 0;
      if (width <= 0 || height <= 0) {
        return { ok: false, error: "无法读取视频尺寸。" };
      }
      const columns = clampColumns(exportOptions.columns, false);
      const metrics = canvasFontMetrics();
      const aspectFactor = metrics.charWEm / 1.22;
      const halfBlock = exportChannel === "density" && exportOptions.halfBlock;
      const sampleRows = halfBlock
        ? estimateRows(columns, width, height, true, aspectFactor) * 2
        : estimateRows(columns, width, height, false, aspectFactor);
      const textRows = halfBlock ? sampleRows / 2 : sampleRows;
      const canvas = makeExportCanvas(columns, textRows, exportOptions.theme, isGif ? 960 : 1920);
      const inks = measureRampInk(RAMPS[exportOptions.ramp]);
      const dualLUT = buildDualLUT(RAMPS[exportOptions.ramp], inks, exportOptions.theme);
      const totalFrames = Math.max(1, Math.round(duration * fps));
      if (isGif && totalFrames > 600) {
        return {
          ok: false,
          error: `GIF 动图上限 600 帧（当前约 ${totalFrames} 帧），请截短视频或改用 MP4 导出。`,
        };
      }

      exportCancelRef.current = false;
      setExporting({ active: true, progress: 0, phase: "decode" });
      let sessionId: string | null = null;
      try {
        sessionId = await window.app.startExport({
          sourcePath,
          columns,
          sampleRows,
          fps,
          hasAudio: Boolean(exportProbe?.hasAudio),
          totalFrames,
          outputPath,
        });
        exportSessionRef.current = sessionId;
        setExporting({ active: true, progress: 0, phase: "render" });
        let index = 0;
        const estimated = totalFrames;
        while (!exportCancelRef.current) {
          const raw = await window.app.readDecodedFrame(sessionId, index);
          if (!raw) break;
          if (exportCancelRef.current) break;
          renderGridFrame(
            canvas,
            raw,
            columns,
            sampleRows,
            exportOptions,
            exportChannel,
            dualLUT,
            { width: canvas.width, height: canvas.height },
            exportSignature,
            exportChannel === "duotone" ? exportDuotone : null,
          );
          const jpeg = canvasToJpegBytes(canvas, 0.95);
          if (jpeg) await window.app.writeFrame(sessionId, index, jpeg.buffer);
          index += 1;
          if (index % 2 === 0) {
            setExporting({
              active: true,
              progress: Math.min(1, index / Math.max(estimated, index)),
              phase: "render",
            });
          }
        }
        if (exportCancelRef.current) {
          await window.app.cancelExport(sessionId);
          exportSessionRef.current = null;
          setExporting(null);
          return { ok: false, error: "cancelled" };
        }
        if (index === 0) {
          await window.app.cancelExport(sessionId);
          exportSessionRef.current = null;
          setExporting(null);
          return { ok: false, error: "没有捕获到任何画面帧，导出失败。" };
        }
        setExporting({ active: true, progress: 0, phase: "encode" });
        const result = await window.app.finishExport(sessionId);
        exportSessionRef.current = null;
        setExporting(null);
        return result;
      } catch (error) {
        if (sessionId) await window.app.cancelExport(sessionId).catch(() => undefined);
        exportSessionRef.current = null;
        setExporting(null);
        return { ok: false, error: String(error).slice(0, 800) };
      }
    },
    [],
  );

  const exportVideo = useCallback(
    async (format: "mp4" | "gif") => {
      if (!media || media.kind !== "video" || !media.path) {
        setError("当前文件没有可用的本地路径，无法导出。请重新通过对话框打开文件。");
        return;
      }
      const stem = media.name.replace(/\.[^.]+$/, "");
      const outputPath = await window.app.chooseSavePath(`${stem}-ascii.${format}`, format);
      if (!outputPath) return;
      appliedRef.current = { options, channel };
      setDirty(false);
      setLive(false);
      const result = await runVideoExport({
        outputPath,
        sourcePath: media.path,
        options,
        channel,
        probe,
        signature,
        duotone: channel === "duotone" ? duotone : null,
      });
      if (!result.ok && result.error !== "cancelled") {
        setError(`导出失败：${result.error}`);
      }
    },
    [media, options, channel, probe, signature, duotone, runVideoExport],
  );

  const runCli = useCallback(
    async (task: CliTask) => {
      try {
        const inputProbe = await window.app.probe(task.input);
        if (!inputProbe.ok || inputProbe.kind === "unknown") {
          throw new Error("无法识别输入文件");
        }
        const ext = task.output.split(".").pop()?.toLowerCase() ?? "txt";
        if (inputProbe.kind === "image") {
          const { data } = await window.app.decodeImage(task.input, 1024);
          const image = await loadImageFromBuffer(data);
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext("2d");
          if (!context) throw new Error("无法创建绘图上下文");
          context.drawImage(image, 0, 0);
          const source = context.getImageData(0, 0, canvas.width, canvas.height);
          const metrics = canvasFontMetrics();
          const aspectFactor = metrics.charWEm / 1.22;
          const effectiveOptions =
            task.options.channel === "density"
              ? task.options
              : { ...task.options, halfBlock: false };
          const converted = convertBitmap(source, effectiveOptions, aspectFactor);
          if (ext === "png") {
            const inks = measureRampInk(RAMPS[task.options.ramp]);
            const dualLUT = buildDualLUT(
              RAMPS[task.options.ramp],
              inks,
              task.options.theme,
            );
            let plan: DualPlan | null = null;
            if (task.options.channel !== "density") {
              plan =
                task.options.channel === "dual" || task.options.channel === "duotone"
                  ? planDualLUT(
                      converted.toned,
                      converted.columns,
                      converted.sampleRows,
                      dualLUT,
                      effectiveOptions.dither,
                    )
                  : planLuminanceChannel(
                      converted.toned,
                      converted.columns,
                      converted.sampleRows,
                      RAMPS[task.options.ramp],
                      effectiveOptions.dither,
                      task.options.theme,
                      LUM_LUT,
                    );
            }
            const outputCanvas = document.createElement("canvas");
            const taskSignature = task.signature ?? DEFAULT_SIGNATURE;
            drawAsciiToCanvas(
              outputCanvas,
              converted,
              plan,
              task.options.channel,
              task.options.theme,
              task.options.ramp,
              {
                scale: clampProofScale(converted.columns, converted.rows, task.scale ?? 1),
                signature: taskSignature,
                duotone: task.options.channel === "duotone" ? (task.duotone ?? DEFAULT_DUOTONE) : null,
              },
            );
            const buffer = await canvasToBuffer(outputCanvas, "image/png");
            if (!buffer) throw new Error("PNG 渲染失败");
            await window.app.saveDirect(task.output, buffer);
          } else {
            await window.app.saveDirect(task.output, converted.text);
          }
          window.app.cliDone(0, task.output);
          return;
        }
        const result = await runVideoExport({
          outputPath: task.output,
          sourcePath: task.input,
          options: task.options,
          channel: task.options.channel,
          probe: inputProbe,
          signature: task.signature ?? DEFAULT_SIGNATURE,
          duotone: task.options.channel === "duotone" ? (task.duotone ?? DEFAULT_DUOTONE) : null,
        });
        if (result.ok) {
          window.app.cliDone(0, task.output);
        } else {
          window.app.cliDone(1, result.error ?? "视频导出失败");
        }
      } catch (error) {
        window.app.cliDone(1, String(error).slice(0, 1000));
      }
    },
    [runVideoExport],
  );

  useEffect(() => {
    let cancelled = false;
    void window.app.cliTask().then((task) => {
      if (!cancelled && task) setCliTask(task);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!cliTask || cliStartedRef.current) return;
    cliStartedRef.current = true;
    void runCli(cliTask);
  }, [cliTask, runCli]);

  useEffect(() => {
    return window.app.onOpenPath((filePath) => {
      void loadPath(filePath);
    });
  }, [loadPath]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && compareOn) {
        setCompareOn(false);
        return;
      }
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === "o") {
        event.preventDefault();
        void openFromDialog();
      } else if (key === "enter") {
        if (media && !(media.kind === "video" && live)) {
          event.preventDefault();
          applyParams();
        }
      } else if (key === "c") {
        if (output && !live) {
          event.preventDefault();
          void copyText();
        }
      } else if (key === "s") {
        if (event.shiftKey) {
          if (media) {
            event.preventDefault();
            void downloadPng();
          }
        } else if (output || live) {
          event.preventDefault();
          void downloadTxt();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [media, output, live, compareOn, openFromDialog, applyParams, copyText, downloadTxt, downloadPng]);

  // 放大检视:样张上滚轮缩放(需非被动监听才能 preventDefault 阻止页面滚动)
  useEffect(() => {
    const el = proofPrintRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      const hasProof =
        Boolean(output) || (live && media?.kind === "video" && !media.native);
      if (!hasProof || compareOn) return;
      event.preventDefault();
      setZoom((previous) => {
        const next = Math.min(8, Math.max(1, previous * (event.deltaY < 0 ? 1.12 : 0.89)));
        if (next === 1) setPan({ x: 0, y: 0 });
        return next;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [output, live, media, compareOn]);

  const isVideo = media?.kind === "video";
  const videoDuration = isVideo
    ? media.native
      ? (probe?.duration ?? 0)
      : Number.isFinite(videoRef.current?.duration)
        ? (videoRef.current?.duration ?? 0)
        : 0
    : 0;
  const outputRows = output?.rows ?? 0;
  const outputColumns = output?.columns ?? 0;
  const mediaRatio =
    dims && dims.width > 0 && dims.height > 0
      ? `${dims.width} / ${dims.height}`
      : "16 / 9";

  return (
    <>
      <header className="studio-header">
        <div className="studio-header-inner">
          <span className="brand-seal" aria-hidden="true">字符工坊</span>
          <span className="brand-name">Glyph Works <em>·</em> Windows 版画台</span>
          <span className="header-note">本地制版 · 图档不出本机</span>
        </div>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">IMAGE &amp; VIDEO TO CHARACTER PRINT</p>
          <h1>把图片与视频，压印成字符画<span className="cursor-block" aria-hidden="true">▊</span></h1>
          <p className="lede">
            拖入图片或视频，字符画即刻上版打印。调整列数、字符集、对比度与抖动，
            盖印打样，或保存 TXT、PNG 与 MP4。
          </p>
          <ul className="hero-facts">
            <li><b>图片</b> PNG · JPG · WebP · GIF · AVIF · SVG · TIFF · HEIC</li>
            <li><b>视频</b> MP4 · WebM · MKV · MOV · AVI · WMV · OGG</li>
            <li><b>处理</b> 全部在本机完成，不上传、不联网、不存储</li>
          </ul>
          <div className="hero-actions">
            <button type="button" className="action-button" onClick={() => void openFromDialog()}>
              打开图档（系统对话框）
            </button>
            {!media && (
              <button type="button" className="action-button" onClick={loadDemo}>
                试印示例 · 木版山水
              </button>
            )}
            <span className="hero-actions-hint">也可把文件拖到本窗口或程序图标上</span>
          </div>
        </div>

        <div
          className={`dropzone ${dragActive ? "is-drag" : ""} ${media ? "has-file" : ""}`}
          role="button"
          tabIndex={0}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              fileInputRef.current?.click();
            }
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragActive(false);
            const file = event.dataTransfer.files?.[0];
            if (file) void openFromFile(file);
          }}
        >
          <TestPattern />
          <div className="dropzone-copy">
            {media ? (
              <>
                <span className="drop-file-name">{media.name}</span>
                <span className="drop-hint">已上版 · 点击可换一张图档</span>
              </>
            ) : (
              <>
                <span className="drop-main">把图档拖到这里</span>
                <span className="drop-hint">或点击选稿 · 松开即上版</span>
              </>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*"
            className="visually-hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void openFromFile(file);
              event.target.value = "";
            }}
          />
        </div>
      </section>

      {error && (
        <div className="error-bar" role="alert">
          <span className="error-dot" aria-hidden="true" />{error}
        </div>
      )}

      <section className="studio">
        <div className="studio-panel controls-panel">
          <section className="panel-section">
            <h2 className="section-title"><span className="step-no">①</span>选稿 · 图档</h2>

            {media ? (
              <div className="media-preview" style={{ aspectRatio: mediaRatio }}>
                {media.kind === "image" || media.native ? (
                  <img
                    ref={imageRef}
                    src={media.kind === "video" ? (media.frameUrl ?? "") : media.url}
                    crossOrigin="anonymous"
                    alt=""
                    className="media-preview-image"
                    onLoad={(event) => {
                      const target = event.currentTarget;
                      setDims({ width: target.naturalWidth, height: target.naturalHeight });
                    }}
                    onError={() => {
                      if (media.kind === "image" && !media.native) {
                        void activateNativeImage();
                      } else {
                        setError("这张图片无法解码，请换用 PNG / JPG / WebP 等常见格式。");
                      }
                    }}
                  />
                ) : (
                  <video
                    ref={videoRef}
                    src={media.url}
                    crossOrigin="anonymous"
                    muted
                    playsInline
                    preload="metadata"
                    poster={posterUrl ?? undefined}
                    className="media-preview-video"
                    onLoadedMetadata={(event) => {
                      const target = event.currentTarget;
                      setDims({ width: target.videoWidth, height: target.videoHeight });
                      target.currentTime = 0;
                    }}
                    onSeeked={() => {
                      setFrameVersion((value) => value + 1);
                      makePoster();
                    }}
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                    onError={() => void activateNativeVideo()}
                  />
                )}
                <div className="media-meta">
                  <span>{media.name}</span>
                  {dims && <span>{dims.width} × {dims.height}</span>}
                  {nativeBusy && <span>解码中…</span>}
                </div>
              </div>
            ) : (
              <div className="panel-empty">
                <p>工作台还空着。</p>
                <p>拖一张图或一段视频到选稿区，或点「打开图档」。</p>
                <button type="button" className="action-button" onClick={loadDemo}>
                  试印示例 · 木版山水
                </button>
              </div>
            )}

            {isVideo && media && (
              <div className="video-controls">
              {!media.native && (
                <div className="segmented">
                  <button
                    type="button"
                    className={!live ? "is-active" : ""}
                    onClick={() => setLiveMode(false)}
                  >
                    单帧取字
                  </button>
                  <button
                    type="button"
                    className={live ? "is-active" : ""}
                    onClick={() => setLiveMode(true)}
                  >
                    实时打印
                  </button>
                </div>
              )}
              <label className="field">
                <span>取帧位置</span>
                <input
                  type="range"
                  min={0}
                  max={videoDuration}
                  step={0.05}
                  value={Math.min(videoTime, videoDuration)}
                  disabled={live || nativeBusy}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    setVideoTime(next);
                    if (media.native) {
                      if (nativeFrameTimerRef.current) {
                        window.clearTimeout(nativeFrameTimerRef.current);
                      }
                      nativeFrameTimerRef.current = window.setTimeout(() => {
                        void requestNativeFrame(next);
                      }, 160);
                    } else {
                      const video = videoRef.current;
                      if (video) video.currentTime = next;
                    }
                  }}
                />
                <span className="field-value">{videoTime.toFixed(2)} s</span>
              </label>
              {live && (
                <button type="button" className="action-button" onClick={() => setLiveMode(false)}>
                  {playing ? "暂停实时打印" : "停止实时打印"}
                </button>
              )}
              {media.native && (
                <p className="output-note">
                  浏览器无法直接解码此格式：预览帧与视频导出由内置 FFmpeg 完成，实时打印不可用。
                </p>
              )}
              </div>
            )}

            {recent.length > 0 && (
              <div className="recent">
                <div className="recent-head">
                  <span className="recent-title">最近 · 图档</span>
                  <button
                    type="button"
                    className="recent-clear"
                    onClick={() => {
                      setRecent([]);
                      saveJson(RECENT_KEY, []);
                      void window.app.clearRecent();
                    }}
                  >
                    清空
                  </button>
                </div>
                <ul className="recent-list">
                  {recent.map((filePath) => (
                    <li key={filePath}>
                      <button type="button" title={filePath} onClick={() => void loadPath(filePath)}>
                        {basename(filePath)}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <section className="panel-section">
            <h2 className="section-title"><span className="step-no">②</span>雕版 · 参数</h2>

            <div className="presets" aria-label="预设参数">
              {PRESETS.map((preset) => (
                <button
                  key={preset.name}
                  type="button"
                  className={`preset-chip ${activePreset === preset.name ? "is-active" : ""}`}
                  onClick={() => applyPreset(preset)}
                >
                  {preset.name}
                </button>
              ))}
            </div>
            <p className="presets-note">选一套刀法，再微调；盖印前不会生效。</p>

            <div className="settings">
            <label className="field">
              <span>细腻度（列数）<em>{options.columns}</em></span>
              <input
                type="range"
                min={40}
                max={420}
                step={5}
                value={options.columns}
                onChange={(event) => setOption("columns", Number(event.target.value))}
              />
            </label>
            <label className="field">
              <span>渲染通道</span>
              <select
                value={channel}
                onChange={(event) => changeChannel(event.target.value as ChannelMode)}
              >
                <option value="density">密度单通道（原版）</option>
                <option value="luminance">亮度前景 · 字符灰度（背景不变）</option>
                <option value="dual">双通道 · 背景+前景灰度（chafa 式）</option>
                <option value="duotone">双色套印 · 前景墨+背景墨</option>
              </select>
            </label>
            <label className="field">
              <span>字符集</span>
              <select
                value={options.ramp}
                onChange={(event) => setOption("ramp", event.target.value as RampId)}
              >
                <option value="classic">经典 70 级阶梯</option>
                <option value="block">紧凑 10 级</option>
                <option value="simple">极简 6 级</option>
              </select>
            </label>
            <label className="field">
              <span>对比度 <em>{options.contrast.toFixed(2)}</em></span>
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.05}
                value={options.contrast}
                onChange={(event) => setOption("contrast", Number(event.target.value))}
              />
            </label>
            <label className="field">
              <span>抖动</span>
              <select
                value={options.dither}
                onChange={(event) => setOption("dither", event.target.value as DitherId)}
              >
                <option value="floyd">Floyd–Steinberg 误差扩散</option>
                <option value="bayer">Bayer 有序抖动</option>
                <option value="none">无抖动</option>
              </select>
            </label>
            <label className="field">
              <span>输出风格</span>
              <select
                value={options.theme}
                onChange={(event) => setOption("theme", event.target.value as OutputTheme)}
              >
                <option value="dark">深色磷光 · 暗房打样</option>
                <option value="light">浅色墨纸 · 纸样打样</option>
              </select>
            </label>
            {channel === "duotone" && (
              <div className="duotone-block">
                <p className="presets-note">套色 · 双墨版（纸基由上方「输出风格」决定）</p>
                <div className="duotone-presets">
                  {DUOTONE_PRESETS.map((preset) => (
                    <button
                      key={preset.name}
                      type="button"
                      className={`preset-chip ${
                        duotone.inkA === preset.inkA && duotone.inkB === preset.inkB ? "is-active" : ""
                      }`}
                      onClick={() => applyDuotonePreset(preset)}
                    >
                      {preset.name}
                    </button>
                  ))}
                </div>
                <label className="field">
                  <span>前景墨（字）</span>
                  <span className="color-field">
                    <input
                      type="color"
                      value={duotone.inkA}
                      onChange={(event) => changeDuotone("inkA", event.target.value)}
                      aria-label="前景墨颜色"
                    />
                    <code>{duotone.inkA}</code>
                  </span>
                </label>
                <label className="field">
                  <span>背景墨（底）</span>
                  <span className="color-field">
                    <input
                      type="color"
                      value={duotone.inkB}
                      onChange={(event) => changeDuotone("inkB", event.target.value)}
                      aria-label="背景墨颜色"
                    />
                    <code>{duotone.inkB}</code>
                  </span>
                </label>
                <label className="field">
                  <span>套印错位 <em>{duotone.offset} px</em></span>
                  <input
                    type="range"
                    min={0}
                    max={6}
                    step={1}
                    value={duotone.offset}
                    onChange={(event) => changeDuotone("offset", Number(event.target.value))}
                  />
                </label>
              </div>
            )}
            <div className="field-row">
              <label className="check">
                <input
                  type="checkbox"
                  checked={options.halfBlock}
                  disabled={channel !== "density"}
                  onChange={(event) => setOption("halfBlock", event.target.checked)}
                />
                <span>半块增强（▀▄█ 纵向翻倍，仅密度模式）</span>
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={options.invert}
                  onChange={(event) => setOption("invert", event.target.checked)}
                />
                <span>反色</span>
              </label>
            </div>
            <div className="signature-block">
              <label className="check">
                <input
                  type="checkbox"
                  checked={signature.enabled}
                  onChange={(event) => changeSignature("enabled", event.target.checked)}
                />
                <span>落款钤印（盖于样张 / PNG / MP4）</span>
              </label>
              {signature.enabled && (
                <>
                  <label className="field">
                    <span>印章字（1–4）</span>
                    <input
                      type="text"
                      className="text-input"
                      maxLength={4}
                      value={signature.sealText}
                      onChange={(event) => changeSignature("sealText", event.target.value)}
                      placeholder="工"
                    />
                  </label>
                  <label className="field">
                    <span>题款</span>
                    <input
                      type="text"
                      className="text-input"
                      maxLength={40}
                      value={signature.colophon}
                      onChange={(event) => changeSignature("colophon", event.target.value)}
                      placeholder="GLYPHWORKS"
                    />
                  </label>
                </>
              )}
            </div>
            <label className="field">
              <span>成作精度（PNG）<em>{exportScale}×</em></span>
              <select
                value={exportScale}
                onChange={(event) => setExportScale(Number(event.target.value))}
              >
                <option value={1}>1× · 约 800 px 宽</option>
                <option value={2}>2× · 约 1600 px 宽</option>
                <option value={4}>4× · 约 3200 px 宽</option>
              </select>
            </label>
          </div>
          </section>

          {!(isVideo && live) && (
            <div className="apply-row">
              <button
                type="button"
                className={`seal-button ${dirty ? "is-dirty" : ""}`}
                disabled={!media}
                onClick={applyParams}
              >
                盖印打样
              </button>
              <span className={`apply-hint ${dirty ? "is-visible" : ""}`}>
                {dirty ? "参数已改，待盖印" : "调整后盖印生效"}
              </span>
            </div>
          )}
        </div>

        <div className="studio-panel output-panel">
          <div className="output-head">
            <h2 className="section-title"><span className="step-no">③</span>打样 · 样张</h2>
          </div>
          <div className="proof-sheet" ref={liveStageRef} style={{ aspectRatio: mediaRatio }}>
            {media ? (
              <>
                <div className="proof-mat" data-theme={live && isVideo ? options.theme : appliedTheme}>
                  <span className="reg-mark reg-top" aria-hidden="true">+</span>
                  <span className="reg-mark reg-bottom" aria-hidden="true">+</span>
                  <div
                    className="proof-print"
                    ref={proofPrintRef}
                    onPointerDown={(event) => {
                      if (zoom <= 1) return;
                      panRef.current = {
                        active: true,
                        startX: event.clientX,
                        startY: event.clientY,
                        origX: pan.x,
                        origY: pan.y,
                      };
                      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
                    }}
                    onPointerMove={(event) => {
                      const p = panRef.current;
                      if (!p.active) return;
                      setPan({
                        x: p.origX + (event.clientX - p.startX),
                        y: p.origY + (event.clientY - p.startY),
                      });
                    }}
                    onPointerUp={() => {
                      panRef.current.active = false;
                    }}
                    onPointerCancel={() => {
                      panRef.current.active = false;
                    }}
                    onDoubleClick={() => {
                      setZoom(1);
                      setPan({ x: 0, y: 0 });
                    }}
                  >
                    {live && isVideo && !media.native ? (
                      <canvas
                        ref={liveCanvasRef}
                        className="bitmap-canvas"
                        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
                      />
                    ) : (
                      <canvas
                        ref={bitmapCanvasRef}
                        className="bitmap-canvas"
                        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
                      />
                    )}
                  </div>
                  {zoom > 1 && (
                    <span className="zoom-chip">×{zoom.toFixed(1)} · 双击复位</span>
                  )}
                </div>
                {compareOn && (
                  <div
                    className="compare-overlay"
                    role="button"
                    tabIndex={0}
                    aria-label="返回样张"
                    onClick={() => setCompareOn(false)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setCompareOn(false);
                      }
                    }}
                  >
                    {compareUrl ? (
                      <img src={compareUrl} alt="" />
                    ) : (
                      <span className="compare-empty">暂无原图画面</span>
                    )}
                    <span className="compare-tag">原图 · 点击返回样张</span>
                  </div>
                )}
                <div className="proof-colophon">
                  <span className="proof-edition">打样 · 第 {proofNumber} 版</span>
                  <span className="output-stats">
                    {output
                      ? `${outputColumns} × ${outputRows} · ${outputColumns * outputRows} 字符 · ${generatedMs} ms`
                      : "等待上版"}
                  </span>
                </div>
                {!output && !(live && isVideo && !media.native) && (
                  <div className="proof-overlay" aria-hidden="true">
                    <p>正在上版…</p>
                  </div>
                )}
              </>
            ) : (
              <div className="output-placeholder" aria-live="polite">
                <p>工作台还空着。</p>
                <p>拖入一张图或一段视频，第一版打样即刻印出。</p>
                <span className="output-stats" hidden>等待上版</span>
                <button type="button" className="action-button" onClick={loadDemo}>
                  试印示例 · 木版山水
                </button>
              </div>
            )}
          </div>
          <div className="output-actions">
            <button type="button" className="action-button" disabled={!output || live} onClick={() => void copyText()}>
              {copied ? "已复制" : "复制字符"}
            </button>
            <button type="button" className="action-button" disabled={!output && !live} onClick={() => void downloadTxt()}>
              存 TXT
            </button>
            <button
              type="button"
              className="action-button drag-png"
              draggable
              disabled={!output && !live}
              title="点击另存为；按住拖到桌面或文件夹，直接保存当前精度 PNG"
              onPointerDown={() => {
                if (!dragPathRef.current) {
                  void prepareDragPng().then((path) => {
                    if (path) dragPathRef.current = path;
                  });
                }
              }}
              onDragStart={(event) => {
                if (dragPathRef.current) {
                  event.preventDefault();
                  void window.app.startDrag(dragPathRef.current);
                }
              }}
              onClick={() => void downloadPng()}
            >
              存 PNG
            </button>
            <button
              type="button"
              className={`action-button ${compareOn ? "is-active" : ""}`}
              disabled={!media}
              aria-pressed={compareOn}
              onClick={toggleCompare}
            >
              {compareOn ? "返回样张" : "对比原图"}
            </button>
            {isVideo && (
              <button
                type="button"
                className="action-button"
                disabled={(!output && !live) || Boolean(exporting?.active)}
                onClick={() => void exportVideo("mp4")}
              >
                {exporting?.active ? "正在导出…" : "导出 MP4（原帧率）"}
              </button>
            )}
            {isVideo && (
              <button
                type="button"
                className="action-button"
                disabled={(!output && !live) || Boolean(exporting?.active)}
                title="上限 960px / 15fps / 600 帧"
                onClick={() => void exportVideo("gif")}
              >
                导出 GIF 动图
              </button>
            )}
            {exporting?.active && (
              <button
                type="button"
                className="action-button"
                onClick={() => {
                  exportCancelRef.current = true;
                  const id = exportSessionRef.current;
                  if (id) void window.app.cancelExport(id);
                }}
              >
                取消导出
              </button>
            )}
          </div>
          {exporting?.active && (
            <div
              className="export-bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round((exporting.progress ?? 0) * 100)}
            >
              <div className="export-bar-head">
                <strong>
                  {exporting.phase === "decode"
                    ? "制版 · 解码画面"
                    : exporting.phase === "render"
                      ? "印刷 · 字符帧"
                      : "装订 · 编码成片"}
                </strong>
                <span>{Math.round((exporting.progress ?? 0) * 100)}%</span>
              </div>
              <span className="export-bar-track">
                <span
                  className="export-bar-fill"
                  style={{ width: `${Math.round((exporting.progress ?? 0) * 100)}%` }}
                />
              </span>
            </div>
          )}
          <p className="output-note">
            亮度类通道为每个字符独立计算灰度；双色套印把背景与前景分别映射到两种墨色（可选错位偏移）。复制与 TXT 为密度版文本，PNG 与 MP4 按当前通道渲染并盖上落款。
            样张上滚轮可放大检视、按住拖动平移、双击复位。存 PNG 可拖到桌面直接保存，精度由「成作精度」决定。
            导出由内置 FFmpeg 先本地解码全部画面帧（制版），再按原帧率编码为 H.264 MP4（成片，含原声，零丢帧）；GIF 动图上限 960px / 15fps / 600 帧。
          </p>
        </div>

        <div className="studio-panel archive-panel">
          <div className="archive-head">
            <h2 className="section-title">样张档案</h2>
            {archive.length > 0 && (
              <button type="button" className="archive-clear" onClick={() => updateArchive(() => [])}>
                清空档案
              </button>
            )}
          </div>
          {archive.length === 0 ? (
            <p className="archive-empty">
              还没有样张。每次「盖印打样」都会在这里留一张版次卡，点击即可复原当时的全部参数。
            </p>
          ) : (
            <div className="archive-row">
              {archive.map((entry) => (
                <div
                  key={entry.id}
                  className="archive-card"
                  role="button"
                  tabIndex={0}
                  title={`第 ${entry.edition} 版 · ${entry.mediaName} · 点击复原参数`}
                  onClick={() => restoreEntry(entry)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      restoreEntry(entry);
                    }
                  }}
                >
                  <img src={entry.thumb} alt={`第 ${entry.edition} 版`} />
                  <span className="archive-meta">
                    第 {entry.edition} 版 · {entry.options.columns} 列 · {entry.channel === "density" ? "密度" : entry.channel === "dual" ? "双通道" : entry.channel === "duotone" ? "套色" : "亮度"}
                  </span>
                  <button
                    type="button"
                    className="archive-del"
                    aria-label={`删除第 ${entry.edition} 版`}
                    onClick={(event) => {
                      event.stopPropagation();
                      updateArchive((previous) => previous.filter((item) => item.id !== entry.id));
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <footer className="studio-footer">
        <p>
          字符工坊 GlyphWorks 是 KEENTROPY 的桌面版画台：所有转换都在本机完成，不上传、不联网、不存储。
          四种渲染通道——密度单通道保留原版；亮度前景只给字符上灰度；双通道同时计算背景与前景灰度（chafa 式）；双色套印把背景与前景分别映射到两种墨色（可加错位）。
          浏览器无法解码的格式（MKV / MOV / AVI / WMV / HEVC / TIFF / HEIC）由内置 FFmpeg 处理。半块增强使用 Unicode 区块字符，请在等宽字体下查看。
        </p>
        <p className="shortcut-row">
          快捷键：
          <span className="kbd">Ctrl+O</span> 选稿 ·
          <span className="kbd">Ctrl+Enter</span> 盖印打样 ·
          <span className="kbd">Ctrl+C</span> 复制字符 ·
          <span className="kbd">Ctrl+S</span> 存 TXT ·
          <span className="kbd">Ctrl+Shift+S</span> 存 PNG
        </p>
      </footer>
    </>
  );
}
