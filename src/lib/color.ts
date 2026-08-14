/**
 * 颜色工具:渲染层共用的十六进制解析与线性插值。
 */
export type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function mixRgb(a: Rgb, b: Rgb, t: number): string {
  const clamp = (v: number) => Math.round(Math.min(255, Math.max(0, v)));
  return `rgb(${clamp(a[0] + (b[0] - a[0]) * t)},${clamp(a[1] + (b[1] - a[1]) * t)},${clamp(a[2] + (b[2] - a[2]) * t)})`;
}
