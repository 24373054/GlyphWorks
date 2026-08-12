import fs from "node:fs/promises";
import path from "node:path";
import pngToIco from "png-to-ico";

const root = path.resolve(import.meta.dirname, "..");
const buildDir = path.join(root, "build");
const sizes = [16, 24, 32, 48, 64, 128, 256];

const buffers = await Promise.all(
  sizes.map(async (size) =>
    fs.readFile(path.join(buildDir, `icon-${size}.png`)),
  ),
);

const ico = await pngToIco(buffers);
await fs.writeFile(path.join(buildDir, "icon.ico"), ico);
console.log(`icon.ico written (${ico.length} bytes)`);
