import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  net,
  protocol,
  shell,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { decodeImage, ensureTools, extractFrame, ffmpegExe, probeMedia } from "./media";
import type { CliTask, ExportStartRequest, ProbeResult, SignatureOptions } from "../src/shared/ipc";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

interface ExportSession {
  id: string;
  tempDir: string;
  sourcePath: string;
  outputPath: string;
  fps: number;
  hasAudio: boolean;
  totalFrames: number;
  decodeProc: ChildProcess | null;
  encodeProc: ChildProcess | null;
  decodeExitCode: number | null;
  decodeError: string;
  encodeError: string;
  canceled: boolean;
  decodeDone: Promise<void>;
}

const sessions = new Map<string, ExportSession>();
const dragTempFiles = new Set<string>();

let mainWindow: BrowserWindow | null = null;
let cliTaskValue: CliTask | null = null;
let cliFinished = false;
let lastOpenDir: string | null = null;
let lastSaveDir: string | null = null;
let firstLaunchPath: string | null = null;
let smokeMode = false;

const IMAGE_EXTS = [
  "png", "jpg", "jpeg", "webp", "gif", "avif", "bmp", "svg", "tif", "tiff", "heic", "heif",
];
const VIDEO_EXTS = [
  "mp4", "webm", "mkv", "mov", "avi", "wmv", "ogg", "ogv", "m4v",
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function pick<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

interface ParsedArgs {
  smoke: boolean;
  cli: boolean;
  guiCheck: boolean;
  cliError: string | null;
  input: string | null;
  output: string | null;
  options: CliTask["options"];
  signature: SignatureOptions;
  scale: number;
  duotone: CliTask["duotone"];
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(1);
  const map = new Map<string, string>();
  const positional: string[] = [];
  let cli = false;
  let smoke = false;
  let guiCheck = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--cli") {
      cli = true;
    } else if (arg === "--smoke") {
      smoke = true;
    } else if (arg === "--gui-check") {
      guiCheck = true;
    } else if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      if (equals > 0) {
        map.set(arg.slice(2, equals), arg.slice(equals + 1));
      } else if (arg === "--half-block" || arg === "--invert") {
        map.set(arg.slice(2), "true");
      } else {
        const next = args[i + 1];
        if (next && !next.startsWith("-")) {
          map.set(arg.slice(2), next);
          i += 1;
        } else {
          map.set(arg.slice(2), "true");
        }
      }
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }
  const positionalFile = positional.find((candidate) => {
    try {
      return fs.statSync(path.resolve(candidate)).isFile();
    } catch {
      return false;
    }
  });
  const input = map.get("input") ?? map.get("i") ?? positionalFile ?? null;
  const output = map.get("output") ?? map.get("o") ?? null;
  const rawColumns = Number(map.get("columns") ?? "110");
  const rawContrast = Number(map.get("contrast") ?? "1");
  const options: CliTask["options"] = {
    columns: Number.isFinite(rawColumns) ? clamp(Math.round(rawColumns), 40, 480) : 110,
    ramp: pick(map.get("ramp"), ["classic", "block", "simple"] as const, "classic"),
    contrast: Number.isFinite(rawContrast) ? clamp(rawContrast, 0.5, 2) : 1,
    invert: map.has("invert"),
    halfBlock: map.has("half-block"),
    dither: pick(map.get("dither"), ["none", "floyd", "bayer"] as const, "floyd"),
    theme: pick(map.get("theme"), ["dark", "light"] as const, "dark"),
    channel: pick(map.get("channel"), ["density", "luminance", "dual", "duotone"] as const, "density"),
  };
  let cliError: string | null = null;
  if (cli && !input) cliError = "CLI 模式缺少 --input <文件>";
  if (cli && input && !fs.existsSync(path.resolve(input))) {
    cliError = `输入文件不存在：${input}`;
  }
  const sealText = map.get("seal") ?? null;
  const colophon = map.get("colophon") ?? null;
  const signature: SignatureOptions = {
    enabled: Boolean(sealText ?? colophon),
    sealText: sealText ?? "工",
    colophon: colophon ?? "GLYPHWORKS",
  };
  const rawScale = Number(map.get("scale") ?? "1");
  const scale = [1, 2, 4].includes(rawScale) ? rawScale : 1;
  const hexColor = (value: string | null, fallback: string) =>
    value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
  const inkA = map.get("ink-a") ?? null;
  const inkB = map.get("ink-b") ?? null;
  const rawOffset = Number(map.get("offset") ?? "0");
  const duotone: CliTask["duotone"] =
    inkA || inkB
      ? {
          inkA: hexColor(inkA, "#c23f26"),
          inkB: hexColor(inkB, "#3a3229"),
          offset: Number.isFinite(rawOffset) ? clamp(Math.round(rawOffset), 0, 6) : 0,
        }
      : undefined;
  return {
    smoke,
    cli,
    guiCheck,
    cliError,
    input: input ? path.resolve(input) : null,
    output: output ? path.resolve(output) : null,
    options,
    signature,
    scale,
    duotone,
  };
}

function findFileArg(argv: string[]): string | null {
  const appPath = app.getAppPath();
  for (const raw of argv.slice(1)) {
    if (raw.startsWith("-")) continue;
    const resolved = path.resolve(raw);
    if (resolved === appPath) continue;
    if (resolved === process.cwd()) continue;
    try {
      if (fs.statSync(resolved).isFile()) return resolved;
    } catch {
      // not a file
    }
  }
  return null;
}

const MEDIA_FILTERS = [
  { name: "媒体文件（图片与视频）", extensions: [...IMAGE_EXTS, ...VIDEO_EXTS] },
  { name: "图片", extensions: IMAGE_EXTS },
  { name: "视频", extensions: VIDEO_EXTS },
  { name: "所有文件", extensions: ["*"] },
];

function showOpenDialog(options: OpenDialogOptions) {
  return mainWindow && !mainWindow.isDestroyed()
    ? dialog.showOpenDialog(mainWindow, options)
    : dialog.showOpenDialog(options);
}

function showSaveDialog(options: SaveDialogOptions) {
  return mainWindow && !mainWindow.isDestroyed()
    ? dialog.showSaveDialog(mainWindow, options)
    : dialog.showSaveDialog(options);
}

function mediaUrl(filePath: string): string {
  return `media://local/${encodeURIComponent(filePath)}`;
}

async function defaultOutputFor(probe: ProbeResult, input: string): Promise<string> {
  const ext = path.extname(input);
  const stem = ext ? input.slice(0, -ext.length) : input;
  const outputExt = probe.kind === "video" ? "mp4" : "txt";
  return `${stem}-ascii.${outputExt}`;
}

function createWindow(hidden: boolean): BrowserWindow {
  const iconPath = path.join(__dirname, "..", "..", "build", "icon.ico");
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1060,
    minHeight: 720,
    show: false,
    backgroundColor: "#100d0a",
    autoHideMenuBar: true,
    title: "字符工坊 GlyphWorks",
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });
  mainWindow = window;
  window.once("ready-to-show", () => {
    if (!hidden) window.show();
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    if (smokeMode) {
      console.error(`SMOKE FAIL render-process-gone: ${details.reason}`);
      app.exit(1);
    }
  });
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void window.loadURL(devUrl);
  } else {
    void window.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  return window;
}

function sendProgress(session: ExportSession, phase: "decode" | "render" | "encode", progress: number, message?: string) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("app:export-progress", {
    phase,
    progress: clamp(progress, 0, 1),
    message,
    sessionId: session.id,
  });
}

function spawnDecode(session: ExportSession, columns: number, sampleRows: number, fps: number): ChildProcess {
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-i", session.sourcePath,
    "-map", "0:v:0",
    // fps 滤镜让解码帧率与导出帧率一致:GIF 按 15fps 抽帧,MP4 顺带把 VFR 源规范成 CFR
    "-vf", `scale=${columns}:${sampleRows}:flags=lanczos,format=rgb24,fps=${fps}`,
    "-c:v", "rawvideo",
    "-f", "image2",
    "-start_number", "0",
    "frame_%06d.rgb",
  ];
  return spawn(
    ffmpegExe(),
    args,
    { cwd: session.tempDir, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
  );
}

async function cleanupTemp(session: ExportSession): Promise<void> {
  await fsp.rm(session.tempDir, { recursive: true, force: true }).catch(() => undefined);
}

async function removeOutput(session: ExportSession): Promise<void> {
  await fsp.rm(session.outputPath, { force: true }).catch(() => undefined);
}

function spawnEncoder(session: ExportSession, args: string[]): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegExe(), args, {
      cwd: session.tempDir,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    session.encodeProc = child;
    const tail: string[] = [];
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 80) tail.shift();
        const frameMatch = /frame=\s*(\d+)/.exec(line);
        if (frameMatch && session.totalFrames > 0) {
          const frame = Number(frameMatch[1]);
          sendProgress(session, "encode", frame / session.totalFrames);
        }
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      session.encodeProc = null;
      session.encodeError = tail.join("\n");
      resolve(code);
    });
  });
}

function runEncode(session: ExportSession, withAudio: boolean): Promise<number | null> {
  const base = [
    "-hide_banner",
    "-y",
    "-stats_period", "0.5",
    "-framerate", String(session.fps),
    "-start_number", "0",
    "-i", "frame_%04d.jpg",
  ];
  const args = withAudio
    ? [
        ...base,
        "-i", session.sourcePath,
        "-map", "0:v:0",
        "-map", "1:a?",
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "16",
        "-pix_fmt", "yuv420p",
        "-r", String(session.fps),
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        "-shortest",
        session.outputPath,
      ]
    : [
        ...base,
        "-map", "0:v:0",
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "16",
        "-pix_fmt", "yuv420p",
        "-r", String(session.fps),
        "-movflags", "+faststart",
        session.outputPath,
      ];
  return spawnEncoder(session, args);
}

/** GIF 编码:单次 palettegen/paletteuse 生成 256 色调色板,无限循环。 */
function runGifEncode(session: ExportSession): Promise<number | null> {
  const args = [
    "-hide_banner",
    "-y",
    "-stats_period", "0.5",
    "-framerate", String(session.fps),
    "-start_number", "0",
    "-i", "frame_%04d.jpg",
    "-vf",
    "split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=floyd_steinberg",
    "-loop", "0",
    session.outputPath,
  ];
  return spawnEncoder(session, args);
}

function registerIpc(): void {
  ipcMain.handle("app:open-file", async (): Promise<{
    path: string;
    name: string;
    url: string;
    probe: ProbeResult;
  } | null> => {
    const result = await showOpenDialog({
      title: "打开图片或视频",
      properties: ["openFile"],
      filters: MEDIA_FILTERS,
      defaultPath: lastOpenDir ?? undefined,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    lastOpenDir = path.dirname(filePath);
    const probe = await probeMedia(filePath);
    return {
      path: filePath,
      name: path.basename(filePath),
      url: mediaUrl(filePath),
      probe,
    };
  });

  ipcMain.handle("app:probe", async (_event, filePath: string) => {
    return probeMedia(filePath);
  });

  ipcMain.handle("app:extract-frame", async (_event, filePath: string, timeSeconds: number, maxWidth: number) => {
    const { data } = await extractFrame(filePath, timeSeconds, maxWidth);
    return { data };
  });

  ipcMain.handle("app:decode-image", async (_event, filePath: string, maxWidth: number) => {
    const { data } = await decodeImage(filePath, maxWidth);
    return { data };
  });

  ipcMain.handle("app:copy-text", (_event, text: string) => {
    clipboard.writeText(text);
  });

  ipcMain.handle("app:save-text", async (_event, defaultName: string, text: string) => {
    const result = await showSaveDialog({
      title: "保存字符文本",
      defaultPath: path.join(lastSaveDir ?? "", defaultName),
      filters: [{ name: "文本文件", extensions: ["txt"] }],
    });
    if (result.canceled || !result.filePath) return null;
    await fsp.writeFile(result.filePath, text, "utf8");
    lastSaveDir = path.dirname(result.filePath);
    return result.filePath;
  });

  ipcMain.handle("app:save-buffer", async (_event, defaultName: string, data: ArrayBuffer, mime: string) => {
    const isPng = mime.includes("png");
    const result = await showSaveDialog({
      title: "保存图片",
      defaultPath: path.join(lastSaveDir ?? "", defaultName),
      filters: isPng
        ? [{ name: "PNG 图片", extensions: ["png"] }]
        : [{ name: "文件", extensions: [defaultName.split(".").pop() ?? "bin"] }],
    });
    if (result.canceled || !result.filePath) return null;
    await fsp.writeFile(result.filePath, Buffer.from(data));
    lastSaveDir = path.dirname(result.filePath);
    return result.filePath;
  });

  ipcMain.handle("app:save-direct", async (_event, filePath: string, data: ArrayBuffer | string) => {
    if (typeof data === "string") {
      await fsp.writeFile(filePath, data, "utf8");
    } else {
      await fsp.writeFile(filePath, Buffer.from(data));
    }
  });

  ipcMain.handle("app:choose-save-path", async (_event, defaultName: string, ext?: string) => {
    const isGif = ext === "gif";
    const result = await showSaveDialog({
      title: isGif ? "保存字符动图" : "保存字符视频",
      defaultPath: path.join(lastSaveDir ?? "", defaultName),
      filters: isGif
        ? [{ name: "GIF 动图", extensions: ["gif"] }]
        : [{ name: "MP4 视频", extensions: ["mp4"] }],
    });
    if (result.canceled || !result.filePath) return null;
    lastSaveDir = path.dirname(result.filePath);
    return result.filePath;
  });

  ipcMain.handle("app:start-export", async (_event, request: ExportStartRequest): Promise<string> => {
    await ensureTools();
    await fsp.access(request.sourcePath);
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "glyphworks-"));
    const session: ExportSession = {
      id: randomUUID(),
      tempDir,
      sourcePath: request.sourcePath,
      outputPath: request.outputPath,
      fps: request.fps,
      hasAudio: request.hasAudio,
      totalFrames: request.totalFrames,
      decodeProc: null,
      encodeProc: null,
      decodeExitCode: null,
      decodeError: "",
      encodeError: "",
      canceled: false,
      decodeDone: Promise.resolve(),
    };
    session.decodeProc = spawnDecode(session, request.columns, request.sampleRows, request.fps);
    session.decodeDone = new Promise<void>((resolve) => {
      session.decodeProc?.once("close", (code) => {
        session.decodeExitCode = code;
        session.decodeError = session.decodeError || "";
        session.decodeProc = null;
        resolve();
      });
    });
    session.decodeProc?.stderr?.on("data", (chunk: Buffer) => {
      const lines = chunk.toString("utf8").split(/\r?\n/).filter(Boolean);
      session.decodeError = [session.decodeError, ...lines].filter(Boolean).slice(-60).join("\n");
    });
    sessions.set(session.id, session);
    return session.id;
  });

  ipcMain.handle("app:read-decoded-frame", async (_event, sessionId: string, index: number) => {
    const session = sessions.get(sessionId);
    if (!session) throw new Error("导出会话不存在");
    const filePath = path.join(session.tempDir, `frame_${String(index).padStart(6, "0")}.rgb`);
    try {
      const buffer = await fsp.readFile(filePath);
      return new Uint8Array(buffer);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await session.decodeDone;
        try {
          const buffer = await fsp.readFile(filePath);
          return new Uint8Array(buffer);
        } catch (retryError) {
          if ((retryError as NodeJS.ErrnoException).code !== "ENOENT") throw retryError;
        }
        if (session.decodeExitCode !== null && session.decodeExitCode !== 0) {
          throw new Error(`视频解码中断（退出码 ${session.decodeExitCode}）：${session.decodeError.slice(-500)}`);
        }
        return null;
      }
      throw error;
    }
  });

  ipcMain.handle("app:write-frame", async (_event, sessionId: string, index: number, jpeg: ArrayBuffer) => {
    const session = sessions.get(sessionId);
    if (!session) throw new Error("导出会话不存在");
    const filePath = path.join(session.tempDir, `frame_${String(index).padStart(4, "0")}.jpg`);
    await fsp.writeFile(filePath, Buffer.from(jpeg));
  });

  ipcMain.handle("app:finish-export", async (_event, sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) return { ok: false, error: "导出会话不存在" };
    if (session.canceled) {
      await Promise.all([cleanupTemp(session), removeOutput(session)]);
      sessions.delete(sessionId);
      return { ok: false, error: "cancelled" };
    }
    const isGif = session.outputPath.toLowerCase().endsWith(".gif");
    let code = isGif ? await runGifEncode(session) : await runEncode(session, session.hasAudio);
    if (session.canceled) {
      await Promise.all([cleanupTemp(session), removeOutput(session)]);
      sessions.delete(sessionId);
      return { ok: false, error: "cancelled" };
    }
    if (!isGif && code !== 0 && session.hasAudio) {
      code = await runEncode(session, false);
      if (session.canceled) {
        await Promise.all([cleanupTemp(session), removeOutput(session)]);
        sessions.delete(sessionId);
        return { ok: false, error: "cancelled" };
      }
    }
    if (code !== 0) {
      let frameFiles = 0;
      try {
        frameFiles = (await fsp.readdir(session.tempDir)).filter((name) => name.endsWith(".jpg")).length;
      } catch {
        frameFiles = -1;
      }
      await Promise.all([cleanupTemp(session), removeOutput(session)]);
      sessions.delete(sessionId);
      const log = session.encodeError;
      const detail =
        log.length > 1200
          ? `${log.slice(0, 500)}\n…（中间省略）…\n${log.slice(-500)}`
          : log;
      return { ok: false, error: `ffmpeg 编码失败（退出码 ${code}，临时帧文件数 ${frameFiles}）：${detail}` };
    }
    let stat: { size: number } | null = null;
    try {
      stat = await fsp.stat(session.outputPath);
    } catch {
      stat = null;
    }
    await cleanupTemp(session);
    sessions.delete(sessionId);
    if (!stat || stat.size === 0) {
      await removeOutput(session);
      return { ok: false, error: "编码输出为空文件，导出失败。" };
    }
    sendProgress(session, "encode", 1);
    return { ok: true };
  });

  ipcMain.handle("app:cancel-export", async (_event, sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.canceled = true;
    session.decodeProc?.kill();
    session.encodeProc?.kill();
    await Promise.all([cleanupTemp(session), removeOutput(session)]);
    sessions.delete(sessionId);
  });

  ipcMain.handle("app:cli-task", () => cliTaskValue);

  ipcMain.on("app:cli-done", (_event, code: number, message?: string) => {
    cliFinished = true;
    if (code === 0) {
      if (message) process.stdout.write(`${message}\n`);
      app.exit(0);
    } else {
      if (message) process.stderr.write(`${message}\n`);
      app.exit(code && code > 0 ? code : 1);
    }
  });

  ipcMain.on("app:show-item", (_event, filePath: string) => {
    shell.showItemInFolder(filePath);
  });

  ipcMain.handle("app:mark-recent", (_event, filePath: string) => {
    if (fs.existsSync(filePath)) app.addRecentDocument(filePath);
  });

  ipcMain.handle("app:clear-recent", () => {
    app.clearRecentDocuments();
  });

  ipcMain.handle("app:save-temp", async (_event, data: ArrayBuffer, name: string) => {
    const filePath = path.join(os.tmpdir(), `glyphworks-drag-${randomUUID()}-${path.basename(name)}`);
    await fsp.writeFile(filePath, Buffer.from(data));
    dragTempFiles.add(filePath);
    return filePath;
  });

  ipcMain.handle("app:start-drag", (_event, filePath: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.startDrag({ file: filePath, icon: filePath });
    }
  });
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.setAppUserModelId("com.keentropy.glyphworks");

  app.on("second-instance", (_event, argv) => {
    const openedPath = findFileArg(argv);
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      if (openedPath) mainWindow.webContents.send("app:open-path", openedPath);
    }
  });

  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event, url) => {
      if (
        !url.startsWith("file:") &&
        !url.startsWith("http://localhost") &&
        !url.startsWith("http://127.0.0.1")
      ) {
        event.preventDefault();
      }
    });
  });

  app.whenReady().then(async () => {
    protocol.handle("media", async (request) => {
      try {
        const url = new URL(request.url);
        const filePath = decodeURIComponent(url.pathname.replace(/^\//, ""));
        if (!path.isAbsolute(filePath)) return new Response("bad request", { status: 400 });
        const response = await net.fetch(pathToFileURL(filePath).toString());
        const headers = new Headers(response.headers);
        headers.set("Access-Control-Allow-Origin", "*");
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      } catch {
        return new Response("bad request", { status: 400 });
      }
    });

    const parsed = parseArgs(process.argv);
    smokeMode = parsed.smoke;
    if (parsed.cliError) {
      process.stderr.write(`${parsed.cliError}\n`);
      app.exit(2);
      return;
    }
    if (parsed.cli && parsed.input) {
      const probe = await probeMedia(parsed.input);
      if (!probe.ok || probe.kind === "unknown") {
        process.stderr.write(`无法识别输入文件：${parsed.input}\n`);
        app.exit(2);
        return;
      }
      cliTaskValue = {
        input: parsed.input,
        output: parsed.output ?? (await defaultOutputFor(probe, parsed.input)),
        options: parsed.options,
        signature: parsed.signature,
        scale: parsed.scale,
        duotone: parsed.duotone,
      };
    }

    registerIpc();

    if (smokeMode) {
      try {
        await ensureTools();
      } catch (error) {
        console.error(`SMOKE FAIL: ${String(error)}`);
        app.exit(1);
        return;
      }
      const window = createWindow(true);
      window.webContents.once("did-finish-load", async () => {
        try {
          await window.webContents.executeJavaScript("document.readyState");
          setTimeout(() => {
            console.log("SMOKE OK");
            app.exit(0);
          }, 300);
        } catch {
          console.error("SMOKE FAIL renderer");
          app.exit(1);
        }
      });
      return;
    }

    if (parsed.guiCheck && parsed.input) {
      const window = createWindow(true);
      window.webContents.on("did-finish-load", () => {
        window.webContents.send("app:open-path", parsed.input as string);
        const started = Date.now();
        const timer = setInterval(() => {
          window.webContents
            .executeJavaScript(`document.querySelector('.output-stats')?.textContent ?? ''`)
            .then((stats: string) => {
              if (stats && !stats.includes("等待")) {
                clearInterval(timer);
                console.log(`GUI-CHECK OK ${stats}`);
                app.exit(0);
              } else if (Date.now() - started > 10000) {
                clearInterval(timer);
                console.error("GUI-CHECK FAIL: no preview");
                app.exit(1);
              }
            })
            .catch((error) => {
              clearInterval(timer);
              console.error(`GUI-CHECK FAIL: ${String(error)}`);
              app.exit(1);
            });
        }, 500);
      });
      return;
    }

    if (cliTaskValue) {
      createWindow(true);
      setTimeout(() => {
        if (!cliFinished) {
          process.stderr.write("CLI 处理超时（45 分钟）\n");
          app.exit(2);
        }
      }, 45 * 60 * 1000);
      return;
    }

    firstLaunchPath = findFileArg(process.argv);
    const shotIndex = process.argv.indexOf("--shot");
    const shotPath = shotIndex >= 0 ? path.resolve(process.argv[shotIndex + 1] ?? "shot.png") : null;
    const window = createWindow(false);
    window.webContents.on("did-finish-load", () => {
      if (firstLaunchPath) {
        window.webContents.send("app:open-path", firstLaunchPath);
        firstLaunchPath = null;
      }
    });
    if (shotPath) {
      // 开发辅助:截取 hero、空态工作室与示例态工作室三张界面图,供视觉审查(不进入发布流程)
      window.webContents.once("did-finish-load", () => {
        const base = shotPath.replace(/\.png$/i, "");
        const capture = async (name: string) => {
          const image = await window.webContents.capturePage();
          await fsp.writeFile(`${base}-${name}.png`, image.toPNG());
        };
        setTimeout(async () => {
          try {
            await capture("hero-empty");
            await window.webContents.executeJavaScript(
              `window.scrollTo(0, (document.querySelector(".studio")?.offsetTop ?? 0) - 8)`,
            );
            await new Promise((resolve) => setTimeout(resolve, 500));
            await capture("studio-empty");
            const clicked = await window.webContents.executeJavaScript(
              `(() => { const button = [...document.querySelectorAll("button")].find((el) => el.textContent?.includes("试印示例")); if (button) { button.click(); return true; } return false; })()`,
            );
            if (clicked) {
              await new Promise((resolve) => setTimeout(resolve, 2800));
              const diag = await window.webContents.executeJavaScript(
                `(() => {
                  const sheet = document.querySelector(".proof-sheet");
                  const mat = document.querySelector(".proof-mat");
                  const canvas = document.querySelector(".bitmap-canvas");
                  const stats = document.querySelector(".output-stats");
                  const errorBar = document.querySelector(".error-bar");
                  let canvasPixel = "no-canvas";
                  if (canvas && canvas.width > 0) {
                    try {
                      const tmp = document.createElement("canvas");
                      tmp.width = 1; tmp.height = 1;
                      const tctx = tmp.getContext("2d");
                      tctx.drawImage(canvas, Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1, 0, 0, 1, 1);
                      const d = tctx.getImageData(0, 0, 1, 1).data;
                      canvasPixel = [d[0], d[1], d[2]].join(",");
                    } catch (e) { canvasPixel = "read-fail:" + String(e); }
                  }
                  return JSON.stringify({
                    dpr: window.devicePixelRatio,
                    scrollY: window.scrollY,
                    stats: stats ? stats.textContent : null,
                    error: errorBar ? errorBar.textContent : null,
                    sheet: sheet ? sheet.getBoundingClientRect().toJSON() : null,
                    mat: mat ? mat.getBoundingClientRect().toJSON() : null,
                    canvas: canvas ? { w: canvas.width, h: canvas.height } : null,
                    canvasPixel,
                  });
                })()`,
              );
              console.log(`SHOT DIAG ${diag}`);
              await capture("studio-working");
              const stamped = await window.webContents.executeJavaScript(
                `(() => { const b = document.querySelector(".seal-button"); if (b && !b.disabled) { b.click(); return true; } return false; })()`,
              );
              if (stamped) {
                await new Promise((resolve) => setTimeout(resolve, 1400));
                const diag2 = await window.webContents.executeJavaScript(
                  `(() => {
                    const archive = JSON.parse(localStorage.getItem("glyphworks.archive.v1") ?? "[]");
                    return JSON.stringify({
                      archiveLen: archive.length,
                      cards: document.querySelectorAll(".archive-card").length,
                      stats: document.querySelector(".output-stats")?.textContent ?? null,
                    });
                  })()`,
                );
                console.log(`SHOT DIAG2 ${diag2}`);
                await capture("studio-stamped");
              }
              const compareClicked = await window.webContents.executeJavaScript(
                `(() => { const b = [...document.querySelectorAll("button")].find((el) => el.textContent?.includes("对比原图")); if (b && !b.disabled) { b.click(); return true; } return false; })()`,
              );
              if (compareClicked) {
                await new Promise((resolve) => setTimeout(resolve, 600));
                const diag3 = await window.webContents.executeJavaScript(
                  `(() => JSON.stringify({ overlay: Boolean(document.querySelector(".compare-overlay")), img: Boolean(document.querySelector(".compare-overlay img")) }))()`,
                );
                console.log(`SHOT DIAG3 ${diag3}`);
                await capture("studio-compare");
                await window.webContents.executeJavaScript(
                  `(() => { const ov = document.querySelector(".compare-overlay"); if (ov) ov.click(); return true; })()`,
                );
              }
              const duotoneSwitched = await window.webContents.executeJavaScript(
                `(() => { const sel = [...document.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "duotone")); if (sel) { sel.value = "duotone"; sel.dispatchEvent(new Event("change", { bubbles: true })); return true; } return false; })()`,
              );
              if (duotoneSwitched) {
                await new Promise((resolve) => setTimeout(resolve, 500));
                const seal = await window.webContents.executeJavaScript(
                  `(() => { const b = document.querySelector(".seal-button"); if (b && !b.disabled) { b.click(); return true; } return false; })()`,
                );
                if (seal) await new Promise((resolve) => setTimeout(resolve, 1200));
                const diag4 = await window.webContents.executeJavaScript(
                  `(() => {
                    const colorA = document.querySelector('input[aria-label="前景墨颜色"]');
                    const sel = [...document.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "duotone"));
                    return JSON.stringify({
                      selectValue: sel ? sel.value : null,
                      inkA: colorA ? colorA.value : null,
                      block: Boolean(document.querySelector(".duotone-block")),
                      archiveLen: JSON.parse(localStorage.getItem("glyphworks.archive.v1") ?? "[]").length,
                    });
                  })()`,
                );
                console.log(`SHOT DIAG4 ${diag4}`);
                await capture("studio-duotone");
              }
            }
            console.log(`SHOT OK ${base}`);
            app.exit(0);
          } catch (error) {
            console.error(`SHOT FAIL: ${String(error)}`);
            app.exit(1);
          }
        }, 1500);
      });
      return;
    }
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("will-quit", () => {
    for (const session of sessions.values()) {
      session.decodeProc?.kill();
      session.encodeProc?.kill();
      void cleanupTemp(session);
    }
    for (const filePath of dragTempFiles) {
      void fsp.rm(filePath, { force: true }).catch(() => undefined);
    }
  });
}
