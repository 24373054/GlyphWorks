import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AppApi,
  CliTask,
  ExportProgress,
  ExtractedFrame,
  OpenedFile,
  ProbeResult,
} from "../src/shared/ipc";

const api: AppApi = {
  openFile: () => ipcRenderer.invoke("app:open-file") as Promise<OpenedFile | null>,
  getPathForFile: (file) => webUtils.getPathForFile(file),
  mediaUrl: (filePath) => `media://local/${encodeURIComponent(filePath)}`,
  probe: (filePath) => ipcRenderer.invoke("app:probe", filePath) as Promise<ProbeResult>,
  extractFrame: (filePath, timeSeconds, maxWidth) =>
    ipcRenderer.invoke("app:extract-frame", filePath, timeSeconds, maxWidth) as Promise<ExtractedFrame>,
  decodeImage: (filePath, maxWidth) =>
    ipcRenderer.invoke("app:decode-image", filePath, maxWidth) as Promise<ExtractedFrame>,
  copyText: (text) => ipcRenderer.invoke("app:copy-text", text) as Promise<void>,
  saveText: (defaultName, text) =>
    ipcRenderer.invoke("app:save-text", defaultName, text) as Promise<string | null>,
  saveBuffer: (defaultName, data, mime) =>
    ipcRenderer.invoke("app:save-buffer", defaultName, data, mime) as Promise<string | null>,
  saveDirect: (filePath, data) =>
    ipcRenderer.invoke("app:save-direct", filePath, data) as Promise<void>,
  chooseSavePath: (defaultName) =>
    ipcRenderer.invoke("app:choose-save-path", defaultName) as Promise<string | null>,
  startExport: (request) =>
    ipcRenderer.invoke("app:start-export", request) as Promise<string>,
  readDecodedFrame: (sessionId, index) =>
    ipcRenderer.invoke("app:read-decoded-frame", sessionId, index) as Promise<Uint8Array | null>,
  writeFrame: (sessionId, index, jpeg) =>
    ipcRenderer.invoke("app:write-frame", sessionId, index, jpeg) as Promise<void>,
  finishExport: (sessionId) =>
    ipcRenderer.invoke("app:finish-export", sessionId) as Promise<{ ok: boolean; error?: string }>,
  cancelExport: (sessionId) => ipcRenderer.invoke("app:cancel-export", sessionId) as Promise<void>,
  onExportProgress: (callback) => {
    const listener = (_event: unknown, progress: ExportProgress) => callback(progress);
    ipcRenderer.on("app:export-progress", listener);
    return () => ipcRenderer.removeListener("app:export-progress", listener);
  },
  onOpenPath: (callback) => {
    const listener = (_event: unknown, filePath: string) => callback(filePath);
    ipcRenderer.on("app:open-path", listener);
    return () => ipcRenderer.removeListener("app:open-path", listener);
  },
  cliTask: () => ipcRenderer.invoke("app:cli-task") as Promise<CliTask | null>,
  cliDone: (code, message) => ipcRenderer.send("app:cli-done", code, message),
  showItemInFolder: (filePath) => ipcRenderer.send("app:show-item", filePath),
};

contextBridge.exposeInMainWorld("app", api);
