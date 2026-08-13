/**
 * Procedural woodcut demo image (no bundled assets, fully offline).
 * A small "sun over mountains" print in ink-on-paper, with carved
 * gouge lines, water bands and a cinnabar seal — the workshop's
 * own calling card for the first-run "试印示例" experience.
 */

export function demoWoodcut(): string {
  const width = 1024;
  const height = 576;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return "";

  const paper = "#e9e0cd";
  const ink = "#241f18";

  // 纸底
  context.fillStyle = paper;
  context.fillRect(0, 0, width, height);

  // 纸面颗粒
  for (let i = 0; i < 2400; i += 1) {
    const x = Math.random() * width;
    const y = Math.random() * height;
    context.fillStyle = `rgba(36, 31, 24, ${0.02 + Math.random() * 0.035})`;
    context.fillRect(x, y, 1, 1);
  }

  // 太阳(朱砂)
  const sun = { x: width * 0.74, y: height * 0.26, r: width * 0.052 };
  context.fillStyle = "#b23a24";
  context.beginPath();
  context.arc(sun.x, sun.y, sun.r, 0, Math.PI * 2);
  context.fill();
  // 太阳内的刻线
  context.strokeStyle = "rgba(233, 224, 205, 0.5)";
  context.lineWidth = 1;
  for (let i = -3; i <= 3; i += 1) {
    context.beginPath();
    context.moveTo(sun.x - sun.r, sun.y + i * 8);
    context.lineTo(sun.x + sun.r, sun.y + i * 8);
    context.stroke();
  }

  // 远山三层(刀刻斜线纹理)
  const mountain = (baseY: number, amplitude: number, color: string, seed: number) => {
    context.save();
    context.beginPath();
    context.moveTo(0, height);
    context.lineTo(0, baseY);
    let x = 0;
    while (x < width) {
      const y = baseY - Math.abs(Math.sin(x * 0.006 + seed)) * amplitude;
      context.lineTo(x, y);
      x += 48;
    }
    context.lineTo(width, baseY);
    context.lineTo(width, height);
    context.closePath();
    context.fillStyle = color;
    context.fill();
    context.clip();
    context.strokeStyle = "rgba(233, 224, 205, 0.14)";
    context.lineWidth = 1;
    for (let px = -height; px < width; px += 7) {
      context.beginPath();
      context.moveTo(px, 0);
      context.lineTo(px - height * 0.6, height);
      context.stroke();
    }
    context.restore();
  };
  mountain(height * 0.5, 92, "#8a7a55", 1.7);
  mountain(height * 0.62, 118, "#4c4332", 4.1);
  mountain(height * 0.78, 148, ink, 6.3);

  // 水面波纹
  context.strokeStyle = ink;
  context.lineWidth = 1.2;
  for (let y = height * 0.82; y < height; y += 9) {
    context.beginPath();
    for (let x = 0; x <= width; x += 16) {
      const yy = y + Math.sin(x * 0.02 + y * 0.05) * 2.2;
      if (x === 0) context.moveTo(x, yy);
      else context.lineTo(x, yy);
    }
    context.stroke();
  }

  // 落款印章
  const seal = 32;
  context.fillStyle = "#c23f26";
  context.fillRect(width - seal - 26, height - seal - 22, seal, seal);
  context.fillStyle = "#f4eeda";
  context.font = '17px KaiTi, "STKaiti", serif';
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText("工", width - seal - 26 + seal / 2, height - 22 - seal / 2 + 1);

  return canvas.toDataURL("image/png");
}
