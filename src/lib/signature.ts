/**
 * 落款与钤印:版画工坊的"签名"层。
 * 一方朱砂印章(1–4 字竖排)+ 左下缘题款,盖在样张、PNG 与 MP4 每一帧上。
 */
import type { OutputTheme } from "@/lib/ascii";
import type { SignatureOptions } from "@/shared/ipc";

export const DEFAULT_SIGNATURE: SignatureOptions = {
  enabled: true,
  sealText: "工",
  colophon: "GLYPHWORKS",
};

const SEAL_BG = "#c23f26";
const SEAL_BORDER = "rgba(244, 238, 218, 0.4)";
const SEAL_INK = "#f4eeda";
const KAI_STACK = '"KaiTi", "STKaiti", "DFKai-SB", serif';
const MONO_STACK = '"JetBrains Mono", "Cascadia Code", Consolas, monospace';

/**
 * 把落款盖到画布上(右下角方印 + 左下缘题款)。
 * 印章尺寸随画布等比缩放,题款字号取画布最小边的约 1.4%。
 */
export function drawSignature(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  signature: SignatureOptions,
  theme: OutputTheme,
): void {
  if (!signature.enabled) return;
  const chars = (signature.sealText.trim() || "工").slice(0, 4);
  const seal = Math.max(22, Math.round(Math.min(width, height) * 0.058));
  const pad = Math.max(10, Math.round(seal * 0.42));
  const x = width - seal - pad;
  const y = height - seal - pad;

  // 印章
  context.save();
  context.fillStyle = SEAL_BG;
  context.fillRect(x, y, seal, seal);
  context.strokeStyle = SEAL_BORDER;
  context.lineWidth = 1;
  context.strokeRect(x + 0.5, y + 0.5, seal - 1, seal - 1);
  const charHeight = Math.min(seal * 0.42, (seal * 0.82) / chars.length);
  context.font = `${Math.max(9, Math.floor(charHeight * 1.1))}px ${KAI_STACK}`;
  context.fillStyle = SEAL_INK;
  context.textAlign = "center";
  context.textBaseline = "middle";
  const startY = y + seal / 2 - ((chars.length - 1) * charHeight) / 2;
  for (let index = 0; index < chars.length; index += 1) {
    context.fillText(chars[index], x + seal / 2, startY + index * charHeight);
  }
  context.restore();

  // 题款
  if (signature.colophon.trim()) {
    context.save();
    context.font = `${Math.max(9, Math.round(Math.min(width, height) * 0.014))}px ${MONO_STACK}`;
    context.fillStyle = theme === "dark" ? "rgba(198, 232, 138, 0.72)" : "rgba(36, 31, 24, 0.78)";
    context.textAlign = "left";
    context.textBaseline = "alphabetic";
    context.fillText(signature.colophon, pad, height - pad);
    context.restore();
  }
}
