/**
 * Assemble docs/demo.gif from the PNG frames in tmp-frames/ (Playwright
 * captures). Frames are nearest-neighbor downscaled (keeps text crisp) and
 * palette-quantized with gifenc. Per-frame delays come from the filename
 * prefix `dNN-` (NN = delay in 100ths of a second), default 120 (1.2 s).
 *
 * Run: node scripts/make-gif.mjs [framesDir] [outFile] [targetWidth]
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import gifenc from "gifenc";

const { GIFEncoder, quantize, applyPalette } = gifenc;

const framesDir = process.argv[2] ?? "tmp-frames";
const outFile = process.argv[3] ?? "docs/demo.gif";
const targetWidth = Number(process.argv[4] ?? 800);

const files = readdirSync(framesDir)
  .filter((f) => f.endsWith(".png"))
  .sort(); // name prefixes (f00-…, d40-…) define the frame order
if (files.length === 0) {
  console.error(`no .png frames in ${framesDir}`);
  process.exit(1);
}

/** Nearest-neighbor downscale — text stays readable, GIF stays small. */
function resize(png, targetW) {
  const { width, height, data } = png;
  if (width <= targetW) return { width, height, data };
  const scale = targetW / width;
  const outH = Math.round(height * scale);
  const out = Buffer.alloc(targetW * outH * 4);
  for (let y = 0; y < outH; y++) {
    const srcY = Math.min(height - 1, Math.round(y / scale));
    for (let x = 0; x < targetW; x++) {
      const srcX = Math.min(width - 1, Math.round(x / scale));
      const si = (srcY * width + srcX) * 4;
      const di = (y * targetW + x) * 4;
      out[di] = data[si];
      out[di + 1] = data[si + 1];
      out[di + 2] = data[si + 2];
      out[di + 3] = data[si + 3];
    }
  }
  return { width: targetW, height: outH, data: out };
}

const gif = GIFEncoder();
for (const file of files) {
  const png = PNG.sync.read(readFileSync(path.join(framesDir, file)));
  const small = resize(png, targetWidth);
  // 256-color quantization; chat UI is dark + indigo so this holds up well
  const palette = quantize(small.data, 256, { format: "rgb565" });
  const index = applyPalette(small.data, palette, "rgb565");
  const delay = Number(file.match(/d(\d+)-/)?.[1] ?? 120);
  gif.writeFrame(index, small.width, small.height, { palette, delay });
  console.log(`${file} → ${small.width}x${small.height} delay=${delay}ms`);
}
gif.finish();

const bytes = gif.bytes();
writeFileSync(outFile, bytes);
console.log(`✅ ${outFile} (${(bytes.length / 1024 / 1024).toFixed(2)} MB, ${files.length} frames)`);