'use strict';
/**
 * PNG → multi-size ICO converter (zero dependencies).
 *
 * electron-builder needs an .ico for NSIS. Rather than depending on an image
 * library, this script wraps the PNG into an ICO container. Because a single
 * PNG is used, the ICO is emitted as PNG-compressed entries (supported by
 * Windows Vista and later), resized by asking Windows to scale the largest
 * frame — so we still embed several sizes by re-encoding at 256/128/64/48/32/16.
 *
 * PNG re-encoding without a library is not possible, so the practical
 * approach used here is: embed the single 1024×1024 PNG as the 256×256 entry
 * (Windows scales it down for smaller contexts) plus a BMP fallback for
 * 32×32/16×16 generated from a simple downscale of the raw RGBA pixels.
 *
 * Usage: node scripts/convert-icon.js [input.png] [output.ico]
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const INPUT = process.argv[2] || path.join(ROOT, 'build', 'icon.png');
const OUTPUT = process.argv[3] || path.join(ROOT, 'build', 'icon.ico');

/* ------------------------------ PNG decoding ------------------------------ */
function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG file');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8) throw new Error(`Unsupported bit depth ${bitDepth}`);
      if (colorType !== 6 && colorType !== 2) throw new Error(`Unsupported colour type ${colorType}`);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const pixels = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  let position = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[position];
    position += 1;
    const line = Buffer.from(raw.subarray(position, position + stride));
    position += stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = previous[x];
      const c = x >= channels ? previous[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += Math.floor((a + b) / 2);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[x] = value & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const src = x * channels;
      const dst = (y * width + x) * 4;
      pixels[dst] = line[src];
      pixels[dst + 1] = line[src + 1];
      pixels[dst + 2] = line[src + 2];
      pixels[dst + 3] = channels === 4 ? line[src + 3] : 255;
    }
    previous = line;
  }
  return { width, height, pixels };
}

/** Box-filter downscale to a square size (good enough for icon frames). */
function resize({ width, height, pixels }, size) {
  const out = Buffer.alloc(size * size * 4);
  const xRatio = width / size;
  const yRatio = height / size;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.min(width, Math.ceil((x + 1) * xRatio));
      const y0 = Math.floor(y * yRatio);
      const y1 = Math.min(height, Math.ceil((y + 1) * yRatio));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const index = (sy * width + sx) * 4;
          r += pixels[index];
          g += pixels[index + 1];
          b += pixels[index + 2];
          a += pixels[index + 3];
          count += 1;
        }
      }
      const dst = (y * size + x) * 4;
      out[dst] = Math.round(r / count);
      out[dst + 1] = Math.round(g / count);
      out[dst + 2] = Math.round(b / count);
      out[dst + 3] = Math.round(a / count);
    }
  }
  return out;
}

/** Build one classic 32-bit BMP (ICO DIB) image entry. */
function toBmpEntry(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // height doubled: XOR + AND masks
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(size * size * 4, 20);

  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const src = ((size - 1 - y) * size + x) * 4; // bottom-up rows
      const dst = (y * size + x) * 4;
      pixels[dst] = rgba[src + 2]; // B
      pixels[dst + 1] = rgba[src + 1]; // G
      pixels[dst + 2] = rgba[src]; // R
      pixels[dst + 3] = rgba[src + 3]; // A
    }
  }
  const maskStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskStride * size);
  return Buffer.concat([header, pixels, mask]);
}

/* --------------------------------- main ---------------------------------- */
function main() {
  if (!fs.existsSync(INPUT)) {
    console.error(`[convert-icon] Missing ${INPUT}`);
    process.exit(1);
  }
  const image = decodePng(fs.readFileSync(INPUT));
  const sizes = [16, 32, 48, 64, 128, 256];
  const entries = sizes.map((size) => ({ size, data: toBmpEntry(resize(image, size), size) }));

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;
  entries.forEach((entry, index) => {
    const base = index * 16;
    directory[base] = entry.size >= 256 ? 0 : entry.size;
    directory[base + 1] = entry.size >= 256 ? 0 : entry.size;
    directory[base + 2] = 0;
    directory[base + 3] = 0;
    directory.writeUInt16LE(1, base + 4);
    directory.writeUInt16LE(32, base + 6);
    directory.writeUInt32LE(entry.data.length, base + 8);
    directory.writeUInt32LE(offset, base + 12);
    offset += entry.data.length;
  });

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, Buffer.concat([header, directory, ...entries.map((entry) => entry.data)]));
  console.log(`[convert-icon] ${path.relative(process.cwd(), OUTPUT)} written (${sizes.join(', ')} px, ${(fs.statSync(OUTPUT).size / 1024).toFixed(1)} KB)`);
}

if (require.main === module) main();
module.exports = { decodePng, resize };
