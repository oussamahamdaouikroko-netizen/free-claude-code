'use strict';
/**
 * Generate the application icon without any image dependency.
 *
 * ImageMagick can be missing an SVG delegate on a build machine, and adding a
 * native image library just for one PNG would bloat every install. This script
 * draws the icon mathematically with 3×3 supersampling (smooth edges) and
 * writes a plain 512×512 RGBA PNG using Node's built-in zlib.
 *
 * Usage:  npm run icon
 * Output: assets/icon.png (installer / window icon)
 *         src/renderer/img/icon.png (sidebar logo)
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 512;
const SS = 3; // supersampling factor per axis

/* ------------------------------ geometry ---------------------------------- */

const clamp01 = (value) => Math.min(1, Math.max(0, value));

/** Signed-distance test for a rounded rectangle (negative = inside). */
function sdRoundRect(px, py, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(px - cx) - (halfW - radius);
  const qy = Math.abs(py - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - radius;
}

/** Distance from a point to a segment (used for the capsule body). */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const lengthSq = abx * abx + aby * aby || 1;
  const t = clamp01((apx * abx + apy * aby) / lengthSq);
  return Math.hypot(apx - abx * t, apy - aby * t);
}

const CENTER = SIZE / 2;

// Background: rounded square
const BG_HALF = SIZE / 2 - 8;
const BG_RADIUS = 104;

// Pharmacy cross (thick, readable at 16 px)
const CROSS_ARM = 62; // half thickness
const CROSS_LEN = 178; // half length
const CROSS_RADIUS = 12;

// Capsule, rotated -45°
const CAPSULE_HALF = 64;
const CAPSULE_RADIUS = 42;

/** Colour of one sample point, or null when transparent. */
function sample(x, y) {
  const insideBackdrop = sdRoundRect(x, y, CENTER, CENTER, BG_HALF, BG_HALF, BG_RADIUS) <= 0;
  if (!insideBackdrop) return null;

  // Diagonal green gradient (top-left → bottom-right)
  const t = clamp01((x + y) / (2 * SIZE));
  let r = Math.round(18 + (10 - 18) * t);
  let g = Math.round(103 + (58 - 103) * t);
  let b = Math.round(79 + (44 - 79) * t);

  const crossVertical =
    sdRoundRect(x, y, CENTER, CENTER, CROSS_ARM, CROSS_LEN, CROSS_RADIUS) <= 0;
  const crossHorizontal =
    sdRoundRect(x, y, CENTER, CENTER, CROSS_LEN, CROSS_ARM, CROSS_RADIUS) <= 0;

  if (crossVertical || crossHorizontal) {
    r = 252;
    g = 254;
    b = 253;
  }

  // Capsule drawn on top of the cross, rotated -45° around the centre.
  const angle = -Math.PI / 4;
  const dx = x - CENTER;
  const dy = y - CENTER;
  const localX = dx * Math.cos(-angle) - dy * Math.sin(-angle);
  const localY = dx * Math.sin(-angle) + dy * Math.cos(-angle);

  const distance = distanceToSegment(localX, localY, -CAPSULE_HALF + CAPSULE_RADIUS, 0, CAPSULE_HALF - CAPSULE_RADIUS, 0);
  const insideCapsule = distance <= CAPSULE_RADIUS;
  const insideStroke =
    distance <= CAPSULE_RADIUS && distance >= CAPSULE_RADIUS - 7 && Math.abs(localX) <= CAPSULE_HALF;

  if (insideCapsule) {
    if (insideStroke) {
      r = 18;
      g = 103;
      b = 79;
    } else if (localX > 4) {
      r = 143;
      g = 214;
      b = 182;
    } else {
      r = 250;
      g = 255;
      b = 252;
    }
  }

  return [r, g, b, 255];
}

/* -------------------------------- render ---------------------------------- */

function render() {
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  const step = 1 / SS;

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let hits = 0;

      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const colour = sample(x + (sx + 0.5) * step, y + (sy + 0.5) * step);
          if (colour) {
            r += colour[0];
            g += colour[1];
            b += colour[2];
            a += colour[3];
            hits += 1;
          }
        }
      }

      const total = SS * SS;
      const offset = (y * SIZE + x) * 4;
      if (hits === 0) {
        pixels[offset] = 0;
        pixels[offset + 1] = 0;
        pixels[offset + 2] = 0;
        pixels[offset + 3] = 0;
      } else {
        pixels[offset] = Math.round(r / hits);
        pixels[offset + 1] = Math.round(g / hits);
        pixels[offset + 2] = Math.round(b / hits);
        // Coverage-based alpha gives anti-aliased edges.
        pixels[offset + 3] = Math.round((a / hits) * (hits / total));
      }
    }
  }
  return pixels;
}

/* --------------------------------- PNG ------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

function encodePng(pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type RGBA
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  // One filter byte (0 = None) at the start of every scan line.
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  for (let y = 0; y < SIZE; y += 1) {
    const rowStart = y * (SIZE * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --------------------------------- main ----------------------------------- */

function writeIcon(target, pixels) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, encodePng(pixels));
  return target;
}

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const pixels = render();
  const written = [
    writeIcon(path.join(root, 'assets', 'icon.png'), pixels),
    writeIcon(path.join(root, 'src', 'renderer', 'img', 'icon.png'), pixels),
  ];
  for (const file of written) {
    console.log(`[icon] wrote ${path.relative(root, file)} (${SIZE}×${SIZE}, ${fs.statSync(file).size} bytes)`);
  }
}

module.exports = { render, encodePng, SIZE, crc32 };
