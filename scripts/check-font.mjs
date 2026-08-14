/**
 * 零依赖字体覆盖检查:TTF 直接解析 sfnt;woff2 先解压 brotli 得到 sfnt。
 * 解析 cmap 表,验证区块字符 / 制表符 / 拉丁字符覆盖,供内置字体选型把关。
 * 用法:node scripts/check-font.mjs <font.ttf|font.woff2>
 */
import zlib from "node:zlib";
import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node check-font.mjs <font.ttf|font.woff2>");
  process.exit(2);
}

const buf = fs.readFileSync(file);
let sfnt;
if (buf.toString("latin1", 0, 4) === "wOF2") {
  const totalSize = buf.readUInt32BE(8);
  const numTables = buf.readUInt16BE(12);
  for (let start = 48; start <= 48 + numTables * 23; start += 1) {
    try {
      const candidate = zlib.brotliDecompressSync(buf.subarray(start, totalSize));
      const sig = candidate.readUInt32BE(0);
      if (
        sig === 0x00010000 ||
        ["OTTO", "true", "typ1"].includes(candidate.toString("latin1", 0, 4))
      ) {
        sfnt = candidate;
        break;
      }
    } catch {
      // 继续尝试下一个起点
    }
  }
} else {
  sfnt = buf;
}
if (!sfnt) {
  console.error("cannot locate sfnt stream");
  process.exit(1);
}

// sfnt:numTables@4,表记录 16 字节(tag@0, offset@8, length@12)
const sfntTables = sfnt.readUInt16BE(4);
let cmap = null;
for (let i = 0; i < sfntTables; i += 1) {
  const record = 12 + i * 16;
  const tag = sfnt.toString("latin1", record, record + 4);
  if (tag === "cmap") {
    cmap = sfnt.subarray(sfnt.readUInt32BE(record + 8));
    break;
  }
}
if (!cmap) {
  console.error("cmap table not found");
  process.exit(1);
}

const glyphSet = new Set();
const numSubtables = cmap.readUInt16BE(2);
for (let s = 0; s < numSubtables; s += 1) {
  const platform = cmap.readUInt16BE(4 + s * 8);
  const format = cmap.readUInt16BE(6 + s * 8);
  const offset = cmap.readUInt32BE(8 + s * 8);
  if (platform === 0 || platform === 3) {
    if (format === 4) {
      const segCountX2 = cmap.readUInt16BE(offset + 6);
      const segCount = segCountX2 / 2;
      const endCodes = offset + 14;
      const startCodes = endCodes + segCountX2 + 2;
      const idDeltas = startCodes + segCountX2;
      const idRange = idDeltas + segCountX2;
      for (let i = 0; i < segCount; i += 1) {
        const start = cmap.readUInt16BE(startCodes + i * 2);
        const end = cmap.readUInt16BE(endCodes + i * 2);
        const delta = cmap.readInt16BE(idDeltas + i * 2);
        const rangeOffsetPos = idRange + i * 2;
        const rangeOffset = cmap.readUInt16BE(rangeOffsetPos);
        for (let cp = start; cp <= end; cp += 1) {
          if (cp === 0xffff) continue;
          if (rangeOffset === 0) {
            glyphSet.add((cp + delta) & 0xffff);
          } else {
            const glyphIndexPos = rangeOffsetPos + rangeOffset + (cp - start) * 2;
            const glyph = cmap.readUInt16BE(glyphIndexPos);
            if (glyph !== 0) glyphSet.add(glyph);
          }
        }
      }
    } else if (format === 12) {
      const numGroups = cmap.readUInt32BE(offset + 12);
      let pos = offset + 16;
      for (let g = 0; g < numGroups; g += 1) {
        const start = cmap.readUInt32BE(pos);
        const end = cmap.readUInt32BE(pos + 4);
        const startGlyph = cmap.readUInt32BE(pos + 8);
        for (let cp = start; cp <= end; cp += 1) {
          glyphSet.add(startGlyph + (cp - start));
        }
        pos += 12;
      }
    }
  }
}

const ranges = [
  [0x20, 0x7e, "ASCII"],
  [0x2500, 0x257f, "Box Drawing"],
  [0x2580, 0x259f, "Block Elements"],
  [0x2190, 0x21ff, "Arrows"],
  [0x00a0, 0x00ff, "Latin-1"],
];
for (const [start, end, name] of ranges) {
  const missing = [];
  for (let cp = start; cp <= end; cp += 1) {
    if (!glyphSet.has(cp)) missing.push(cp);
  }
  console.log(
    `${name} U+${start.toString(16)}-U+${end.toString(16)}: missing=${
      missing.length ? missing.map((c) => "U+" + c.toString(16)).join(",") : "none"
    }`,
  );
}
console.log(`total glyphs=${glyphSet.size}`);
