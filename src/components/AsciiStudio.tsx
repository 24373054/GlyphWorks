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
import type { CliTask, ProbeResult } from "@/shared/ipc";

type MediaKind = "image" | "video";
type ChannelMode = "density" | "luminance" | "dual";

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

const IMAGE_EXTS = [
  "png", "jpg", "jpeg", "webp", "gif", "avif", "bmp", "svg", "tif", "tiff", "heic", "heif",
];

const clampColumns = (value: number, live: boolean) =>
  Math.max(40, Math.min(live ? 150 : 480, value));

function themeColors(theme: OutputTheme) {
  return theme === "dark"
    ? { bg: "#0b0e0a", fg: "#c6e88a" }
    : { bg: "#f1ecdd", fg: "#1b2119" };
}

function themeAnchors(theme: OutputTheme) {
  return theme === "dark"
    ? { darkest: "#0b0e0a", brightest: "#c6e88a" }
    : { darkest: "#1b2119", brightest: "#f1ecdd" };
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
  const bgColors =
    mode === "dual"
      ? DUAL_LEVELS[theme].bg.map((level) => mixRgb(darkest, brightest, level))
      : null;
  const fgColors =
    mode === "dual"
      ? DUAL_LEVELS[theme].fg.map((level) => mixRgb(darkest, brightest, level))
      : LUM_LEVELS.map((level) => mixRgb(darkest, brightest, level));
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
          x + (cellWidth - charWidth) / 2,
          y + cellHeight / 2,
        );
      }
    }
  }
}

/**
 * Render the ASCII art into the given canvas at its intrinsic bitmap size
 * (fixed 12px font, measured character metrics).
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
) {
  const fontSize = 12;
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
    );
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
) {
  const grid = new Float32Array(columns * sampleRows);
  for (let i = 0; i < grid.length; i += 1) {
    const offset = i * 3;
    grid[i] = luminance(raw[offset], raw[offset + 1], raw[offset + 2]);
  }
  const toned = toneMap(grid, options.contrast, options.invert);
  const halfBlock = channel === "density" && options.halfBlock;
  const textRows = halfBlock ? sampleRows / 2 : sampleRows;
  if (channel !== "density") {
    const plan =
      channel === "dual"
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
    );
    return;
  }
  const text = halfBlock
    ? encodeHalfBlock(toned, columns, sampleRows, options.ramp, options.dither, options.theme)
    : encodeGrid(toned, columns, sampleRows, options.ramp, options.dither, options.theme);
  renderTextToCanvas(canvas, text, columns, textRows, options.theme, size, true);
}

function makeExportCanvas(
  columns: number,
  textRows: number,
  theme: OutputTheme,
): HTMLCanvasElement {
  const probe = document.createElement("canvas").getContext("2d");
  if (!probe) throw new Error("无法创建绘图上下文");
  probe.font = `12px ${FONT_STACK}`;
  const charWidth = Math.max(probe.measureText("M").width, 1);
  const lineHeight = 12 * 1.22;
  const toEven = (value: number) => (value % 2 === 0 ? value : value + 1);
  const width = toEven(Math.ceil(charWidth * columns) + 8);
  const height = toEven(Math.ceil(lineHeight * textRows) + 8);
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

  const setOption = useCallback(
    <K extends keyof AsciiOptions>(key: K, value: AsciiOptions[K]) => {
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
      setDirty(false);
    },
    [options, channel],
  );

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
        appliedChannel === "dual"
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
      );
    }
    setOutput(converted);
    setGeneratedMs(Math.max(1, Math.round(performance.now() - started)));
  }, [captureBitmap]);

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
        channel === "dual"
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
    drawAsciiToCanvas(canvas, converted, plan, channel, options.theme, options.ramp);
  }, [captureBitmap, channel, options]);

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
    setRenderVersion((value) => value + 1);
  }, [options, channel]);

  const changeChannel = useCallback(
    (next: ChannelMode) => {
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

  const downloadPng = useCallback(async () => {
    if (!media) return;
    const stem = media.name.replace(/\.[^.]+$/, "");
    const canvas = live ? liveCanvasRef.current : bitmapCanvasRef.current;
    if (!canvas) return;
    const buffer = await canvasToBuffer(canvas, "image/png");
    if (!buffer) return;
    await window.app.saveBuffer(`${stem}-ascii.png`, buffer, "image/png");
  }, [live, media]);

  const runVideoExport = useCallback(
    async (input: {
      outputPath: string;
      sourcePath: string;
      options: AsciiOptions;
      channel: ChannelMode;
      probe: ProbeResult | null;
    }): Promise<{ ok: boolean; error?: string }> => {
      const { outputPath, sourcePath, options: exportOptions, channel: exportChannel, probe: exportProbe } = input;
      const duration = exportProbe?.duration ?? null;
      if (!duration || duration <= 0) {
        return { ok: false, error: "无法读取视频时长，请重新选择文件。" };
      }
      const fps = Math.min(240, Math.max(1, exportProbe?.fps ?? 30));
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
      const canvas = makeExportCanvas(columns, textRows, exportOptions.theme);
      const inks = measureRampInk(RAMPS[exportOptions.ramp]);
      const dualLUT = buildDualLUT(RAMPS[exportOptions.ramp], inks, exportOptions.theme);
      const totalFrames = Math.max(1, Math.round(duration * fps));

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

  const exportVideo = useCallback(async () => {
    if (!media || media.kind !== "video" || !media.path) {
      setError("当前文件没有可用的本地路径，无法导出视频。请重新通过对话框打开文件。");
      return;
    }
    const stem = media.name.replace(/\.[^.]+$/, "");
    const outputPath = await window.app.chooseSavePath(`${stem}-ascii.mp4`);
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
    });
    if (!result.ok && result.error !== "cancelled") {
      setError(`导出失败：${result.error}`);
    }
  }, [media, options, channel, probe, runVideoExport]);

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
                task.options.channel === "dual"
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
            drawAsciiToCanvas(
              outputCanvas,
              converted,
              plan,
              task.options.channel,
              task.options.theme,
              task.options.ramp,
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
          <span className="brand-mark">▚▞</span>
          <span className="brand-name">字符工坊 · GLYPH WORKS — WINDOWS</span>
          <span className="header-note">本地转换 · 内置 FFmpeg · 文件不上传</span>
        </div>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">IMAGE &amp; VIDEO TO CHARACTER PRINT</p>
          <h1>把图片与视频，打印成字符画<span className="cursor-block" aria-hidden="true">▊</span></h1>
          <p className="lede">
            拖入图片或视频，字符画即刻在右侧打印。调整列数、字符集、对比度与抖动，
            一键复制文本，或保存 TXT、PNG 与 MP4。
          </p>
          <ul className="hero-facts">
            <li><b>图片</b> PNG · JPG · WebP · GIF · AVIF · SVG · TIFF · HEIC</li>
            <li><b>视频</b> MP4 · WebM · MKV · MOV · AVI · WMV · OGG</li>
            <li><b>处理</b> 全部在本机完成，不上传、不联网、不存储</li>
          </ul>
          <div className="hero-actions">
            <button type="button" className="action-button" onClick={() => void openFromDialog()}>
              打开文件（系统对话框）
            </button>
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
                <span className="drop-hint">已就绪 · 点击可换一个文件</span>
              </>
            ) : (
              <>
                <span className="drop-main">拖入图片或视频</span>
                <span className="drop-hint">或点击选择文件 · 松开即打印</span>
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
          <h2 className="panel-title">01 · 输入与参数</h2>

          {media ? (
            <div className="media-preview" style={{ aspectRatio: mediaRatio }}>
              {media.kind === "image" || media.native ? (
                <img
                  ref={imageRef}
                  src={media.kind === "video" ? (media.frameUrl ?? "") : media.url}
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
                  muted
                  playsInline
                  preload="none"
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
              <p>还没有输入文件。</p>
              <p>拖一张图或一段视频到左侧大框，或点击「打开文件」。</p>
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
                <option value="dark">深色终端 · 磷光字符</option>
                <option value="light">浅色纸张 · 墨字</option>
              </select>
            </label>
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
          </div>

          {!(isVideo && live) && (
            <div className="apply-row">
              <button
                type="button"
                className={`apply-button ${dirty ? "is-dirty" : ""}`}
                disabled={!media}
                onClick={applyParams}
              >
                应用参数
              </button>
              <span className={`apply-hint ${dirty ? "is-visible" : ""}`}>
                {dirty ? "参数已修改，点击应用生效" : "参数调整后需点击应用"}
              </span>
            </div>
          )}
        </div>

        <div className="studio-panel output-panel">
          <div className="output-head">
            <h2 className="panel-title">02 · 字符输出</h2>
            <span className="output-stats">
              {output
                ? `${outputColumns} × ${outputRows} · ${outputColumns * outputRows} 字符 · ${generatedMs} ms`
                : "等待输入"}
            </span>
          </div>
          <div className="output-stage" ref={liveStageRef} style={{ aspectRatio: mediaRatio }}>
            {live && isVideo && !media.native ? (
              <canvas ref={liveCanvasRef} className="bitmap-canvas" />
            ) : output ? (
              <canvas ref={bitmapCanvasRef} className="bitmap-canvas" />
            ) : (
              <div className="output-placeholder" aria-live="polite">
                <p>· 等待输入 ·</p>
                <p>拖入一张图片或一段视频，字符画会在这里打印。</p>
                <p className="output-placeholder-sub">调整参数后点击「应用参数」生效</p>
              </div>
            )}
          </div>
          <div className="output-actions">
            <button type="button" className="action-button" disabled={!output || live} onClick={() => void copyText()}>
              {copied ? "已复制" : "复制字符"}
            </button>
            <button type="button" className="action-button" disabled={!output && !live} onClick={() => void downloadTxt()}>
              保存 .txt
            </button>
            <button type="button" className="action-button" disabled={!output && !live} onClick={() => void downloadPng()}>
              保存 .png
            </button>
            {isVideo && (
              <button
                type="button"
                className="action-button"
                disabled={(!output && !live) || Boolean(exporting?.active)}
                onClick={() => void exportVideo()}
              >
                {exporting?.active
                  ? exporting.phase === "decode"
                    ? `解码帧…`
                    : exporting.phase === "render"
                      ? `预渲染 ${Math.round((exporting.progress ?? 0) * 100)}%`
                      : `编码中 ${Math.round((exporting.progress ?? 0) * 100)}%`
                  : "导出 .mp4（原帧率）"}
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
          <p className="output-note">
            亮度类通道会为每个字符独立计算灰度（前景亮度 / 背景+前景双通道）；复制与 .txt 仍为密度版文本，.png 与视频导出按当前通道渲染。视频导出使用随程序内置的 FFmpeg：先在本地解码全部画面帧（「预渲染」），再按原帧率编码为 H.264 MP4（「编码中」，含原声，零丢帧），不依赖浏览器解码能力。
          </p>
        </div>
      </section>

      <footer className="studio-footer">
        <p>
          字符工坊 GlyphWorks Windows 版是 KEENTROPY 的桌面演示：所有转换都在本机完成，不上传、不联网、不存储。
          三种渲染通道：密度单通道保留原版；亮度前景只给字符上灰度；双通道同时计算背景与前景灰度（chafa 式）。
          浏览器无法解码的格式（MKV / MOV / AVI / WMV / HEVC / TIFF / HEIC）由内置 FFmpeg 处理。半块增强使用 Unicode 区块字符，请在等宽字体下查看。
        </p>
      </footer>
    </>
  );
}
