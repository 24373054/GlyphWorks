export type MediaKind = "image" | "video";

export interface ProbeResult {
  ok: boolean;
  error?: string;
  kind: MediaKind | "unknown";
  width: number;
  height: number;
  duration: number | null;
  fps: number | null;
  hasAudio: boolean;
  formatName: string;
  codecName: string;
}

export interface OpenedFile {
  path: string;
  name: string;
  url: string;
  probe: ProbeResult;
}

export interface ExtractedFrame {
  data: Uint8Array;
}

export interface ExportStartRequest {
  sourcePath: string;
  columns: number;
  sampleRows: number;
  fps: number;
  hasAudio: boolean;
  totalFrames: number;
  outputPath: string;
}

export interface ExportProgress {
  phase: "decode" | "render" | "encode";
  progress: number;
  message?: string;
  error?: string;
}

export interface CliOptions {
  columns: number;
  ramp: "classic" | "block" | "simple";
  contrast: number;
  invert: boolean;
  halfBlock: boolean;
  dither: "none" | "floyd" | "bayer";
  theme: "dark" | "light";
  channel: "density" | "luminance" | "dual";
}

export interface CliTask {
  input: string;
  output: string;
  options: CliOptions;
}

export interface AppApi {
  openFile(): Promise<OpenedFile | null>;
  getPathForFile(file: File): string;
  mediaUrl(path: string): string;
  probe(path: string): Promise<ProbeResult>;
  extractFrame(path: string, timeSeconds: number, maxWidth: number): Promise<ExtractedFrame>;
  decodeImage(path: string, maxWidth: number): Promise<ExtractedFrame>;
  copyText(text: string): Promise<void>;
  saveText(defaultName: string, text: string): Promise<string | null>;
  saveBuffer(defaultName: string, data: ArrayBuffer, mime: string): Promise<string | null>;
  saveDirect(path: string, data: ArrayBuffer | string): Promise<void>;
  chooseSavePath(defaultName: string): Promise<string | null>;
  startExport(request: ExportStartRequest): Promise<string>;
  readDecodedFrame(sessionId: string, index: number): Promise<Uint8Array | null>;
  writeFrame(sessionId: string, index: number, jpeg: ArrayBuffer): Promise<void>;
  finishExport(sessionId: string): Promise<{ ok: boolean; error?: string }>;
  cancelExport(sessionId: string): Promise<void>;
  onExportProgress(callback: (progress: ExportProgress) => void): () => void;
  onOpenPath(callback: (path: string) => void): () => void;
  cliTask(): Promise<CliTask | null>;
  cliDone(code: number, message?: string): void;
  showItemInFolder(path: string): void;
}

declare global {
  interface Window {
    app: AppApi;
  }
}
