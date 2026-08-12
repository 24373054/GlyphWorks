import { spawn } from "node:child_process";
import { app } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import type { ProbeResult } from "../src/shared/ipc";

export interface RunResult {
  code: number | null;
  stderrTail: string;
  stdout: string;
}

export function ffmpegDir(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "ffmpeg");
  return path.join(__dirname, "..", "..", "resources", "ffmpeg");
}

export function ffmpegExe(): string {
  return path.join(ffmpegDir(), "ffmpeg.exe");
}

export function ffprobeExe(): string {
  return path.join(ffmpegDir(), "ffprobe.exe");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureTools(): Promise<void> {
  const [ffmpegOk, ffprobeOk] = await Promise.all([exists(ffmpegExe()), exists(ffprobeExe())]);
  if (!ffmpegOk || !ffprobeOk) {
    throw new Error(
      `缺少内置转码工具：ffmpeg=${ffmpegOk ? "ok" : "缺失"}，ffprobe=${ffprobeOk ? "ok" : "缺失"}（目录 ${ffmpegDir()}）`,
    );
  }
}

function run(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    onStderr?: (line: string) => void;
    timeoutMs?: number;
  } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tail: string[] = [];
    const stdoutBuffer: Buffer[] = [];
    const capture = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        options.onStderr?.(line);
        tail.push(line);
        if (tail.length > 80) tail.shift();
      }
    };
    child.stderr?.on("data", capture);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer.push(chunk);
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      resolve({
        code,
        stderrTail: tail.join("\n"),
        stdout: Buffer.concat(stdoutBuffer).toString("utf8"),
      });
    });
  });
}

function parseRate(value: string | undefined): number {
  if (!value) return 0;
  const parts = value.split("/");
  if (parts.length === 2) {
    const numerator = Number(parts[0]);
    const denominator = Number(parts[1]);
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) {
      return numerator / denominator;
    }
  }
  const direct = Number(value);
  return Number.isFinite(direct) ? direct : 0;
}

const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "webp", "gif", "avif", "bmp", "svg", "tif", "tiff", "heic", "heif", "ico",
]);
const VIDEO_EXTS = new Set([
  "mp4", "webm", "mkv", "mov", "avi", "wmv", "ogg", "ogv", "m4v", "flv", "mpg", "mpeg", "ts", "m2ts",
]);

export async function probeMedia(filePath: string): Promise<ProbeResult> {
  const result = await run(ffprobeExe(), [
    "-v", "error",
    "-show_streams",
    "-show_format",
    "-of", "json",
    filePath,
  ]);
  const extension = path.extname(filePath).slice(1).toLowerCase();
  if (result.code !== 0) {
    return {
      ok: false,
      error: result.stderrTail.slice(-600),
      kind: "unknown",
      width: 0,
      height: 0,
      duration: null,
      fps: null,
      hasAudio: false,
      formatName: extension,
      codecName: "",
    };
  }
  let parsed: {
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      duration?: string;
      nb_frames?: string;
      r_frame_rate?: string;
      avg_frame_rate?: string;
    }>;
    format?: { format_name?: string; duration?: string };
  };
  try {
    parsed = JSON.parse(result.stdout.trim() || "{}") as typeof parsed;
  } catch {
    parsed = {};
  }
  const videoStream = parsed.streams?.find((stream) => stream.codec_type === "video");
  const hasAudio = Boolean(parsed.streams?.some((stream) => stream.codec_type === "audio"));
  const duration = Number(parsed.format?.duration ?? videoStream?.duration ?? NaN);
  let kind: ProbeResult["kind"] = "unknown";
  if (videoStream) {
    if (IMAGE_EXTS.has(extension)) kind = "image";
    else if (VIDEO_EXTS.has(extension)) kind = "video";
    else if (hasAudio || (Number.isFinite(duration) && duration > 0.15)) kind = "video";
    else kind = "image";
  }
  const fpsRaw =
    parseRate(videoStream?.r_frame_rate) ||
    parseRate(videoStream?.avg_frame_rate) ||
    30;
  const fps = Math.min(240, Math.max(1, fpsRaw));
  return {
    ok: true,
    kind,
    width: videoStream?.width ?? 0,
    height: videoStream?.height ?? 0,
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    fps: kind === "video" ? fps : null,
    hasAudio,
    formatName: parsed.format?.format_name ?? extension,
    codecName: videoStream?.codec_name ?? "",
  };
}

async function pipeFrameToPng(
  args: string[],
): Promise<{ data: Buffer; code: number | null; stderrTail: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegExe(), args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const tail: string[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      const lines = chunk.toString("utf8").split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        tail.push(line);
        if (tail.length > 60) tail.shift();
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ data: Buffer.concat(chunks), code, stderrTail: tail.join("\n") });
    });
  });
}

export async function extractFrame(
  filePath: string,
  timeSeconds: number,
  maxWidth: number,
): Promise<{ data: Buffer }> {
  const scale = `scale=w=${Math.max(2, Math.round(maxWidth))}:h=-2:flags=lanczos`;
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-ss", String(Math.max(0, timeSeconds)),
    "-i", filePath,
    "-frames:v", "1",
    "-vf", scale,
    "-f", "image2pipe",
    "-vcodec", "png",
    "pipe:1",
  ];
  const result = await pipeFrameToPng(args);
  if (result.code !== 0 || result.data.length === 0) {
    throw new Error(`取帧失败：${result.stderrTail.slice(-400)}`);
  }
  return { data: result.data };
}

export async function decodeImage(
  filePath: string,
  maxWidth: number,
): Promise<{ data: Buffer }> {
  const scale = `scale=w=${Math.max(2, Math.round(maxWidth))}:h=-2:flags=lanczos`;
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-i", filePath,
    "-frames:v", "1",
    "-vf", scale,
    "-f", "image2pipe",
    "-vcodec", "png",
    "pipe:1",
  ];
  const result = await pipeFrameToPng(args);
  if (result.code !== 0 || result.data.length === 0) {
    throw new Error(`图片解码失败：${result.stderrTail.slice(-400)}`);
  }
  return { data: result.data };
}
