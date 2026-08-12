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
import type { CliTask, ExportStartRequest, ProbeResult } from "../src/shared/ipc";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "media",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
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
  canceled: boolean;
  decodeDone: Promise<void>;
}

const sessions = new Map<string, ExportSession>();

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
  cliError: string | null;
  input: string | null;
  output: string | null;
  options: CliTask["options"];
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(1);
  const map = new Map<string, string>();
  const positional: string[] = [];
  let cli = false;
  let smoke = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--cli") {
      cli = true;
    } else if (arg === "--smoke") {
      smoke = true;
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
  const input = map.get("input") ?? map.get("i") ?? (positional.length > 0 ? positional[0] : null);
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
    channel: pick(map.get("channel"), ["density", "luminance", "dual"] as const, "density"),
  };
  let cliError: string | null = null;
  if (cli && !input) cliError = "CLI 模式缺少 --input <文件>";
  if (cli && input && !fs.existsSync(path.resolve(input))) {
    cliError = `输入文件不存在：${input}`;
  }
  return {
    smoke,
    cli,
    cliError,
    input: input ? path.resolve(input) : null,
    output: output ? path.resolve(output) : null,
    options,
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
    backgroundColor: "#0b0e0a",
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

function spawnDecode(session: ExportSession, columns: number, sampleRows: number): ChildProcess {
  return spawn(
    ffmpegExe(),
    [
      "-hide_banner",
      "-loglevel", "error",
      "-i", session.sourcePath,
      "-map", "0:v:0",
      "-vf", `scale=${columns}:${sampleRows}:flags=lanczos,format=rgb24`,
      "-c:v", "rawvideo",
      "-f", "image2",
      "-start_number", "0",
      "frame_%06d.rgb",
    ],
    { cwd: session.tempDir, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
  );
}

async function cleanupTemp(session: ExportSession): Promise<void> {
  await fsp.rm(session.tempDir, { recursive: true, force: true }).catch(() => undefined);
}

async function removeOutput(session: ExportSession): Promise<void> {
  await fsp.rm(session.outputPath, { force: true }).catch(() => undefined);
}

function runEncode(session: ExportSession, withAudio: boolean): Promise<number | null> {
  return new Promise((resolve, reject) => {
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
          "-preset", "slow",
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
          "-preset", "slow",
          "-crf", "16",
          "-pix_fmt", "yuv420p",
          "-r", String(session.fps),
          "-movflags", "+faststart",
          session.outputPath,
        ];
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
      session.decodeError = tail.join("\n");
      resolve(code);
    });
  });
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

  ipcMain.handle("app:choose-save-path", async (_event, defaultName: string) => {
    const result = await showSaveDialog({
      title: "保存字符视频",
      defaultPath: path.join(lastSaveDir ?? "", defaultName),
      filters: [{ name: "MP4 视频", extensions: ["mp4"] }],
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
      canceled: false,
      decodeDone: Promise.resolve(),
    };
    session.decodeProc = spawnDecode(session, request.columns, request.sampleRows);
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
    let code = await runEncode(session, session.hasAudio);
    if (session.canceled) {
      await Promise.all([cleanupTemp(session), removeOutput(session)]);
      sessions.delete(sessionId);
      return { ok: false, error: "cancelled" };
    }
    if (code !== 0 && session.hasAudio) {
      code = await runEncode(session, false);
      if (session.canceled) {
        await Promise.all([cleanupTemp(session), removeOutput(session)]);
        sessions.delete(sessionId);
        return { ok: false, error: "cancelled" };
      }
    }
    if (code !== 0) {
      await Promise.all([cleanupTemp(session), removeOutput(session)]);
      sessions.delete(sessionId);
      return { ok: false, error: `ffmpeg 编码失败（退出码 ${code}）：${session.decodeError.slice(-800)}` };
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
    protocol.handle("media", (request) => {
      try {
        const url = new URL(request.url);
        const filePath = decodeURIComponent(url.pathname.replace(/^\//, ""));
        if (!path.isAbsolute(filePath)) return new Response("bad request", { status: 400 });
        return net.fetch(pathToFileURL(filePath).toString());
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
    const window = createWindow(false);
    window.webContents.on("did-finish-load", () => {
      if (firstLaunchPath) {
        window.webContents.send("app:open-path", firstLaunchPath);
        firstLaunchPath = null;
      }
    });
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
  });
}
