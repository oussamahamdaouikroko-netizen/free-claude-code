'use strict';
/**
 * Zero-dependency offline ISO/IEC 18004 Version-2-L QR Code SVG generator
 * for DentaRDV document verification tokens (e.g. "DRDV:RX:42:A1B2C3D4E5").
 *
 * Privacy / Algerian Law 18-07 guarantee:
 *  - Accepts ONLY compact alphanumeric verification tokens (<= 32 ASCII bytes).
 *  - NEVER embeds patient names, diagnoses, medications, or clinical content.
 */

const crypto = require('node:crypto');

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    const root = GF_EXP[i];
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(dataBytes, ecCount) {
  const gen = rsGeneratorPoly(ecCount);
  const rem = new Array(ecCount).fill(0);
  for (const byte of dataBytes) {
    const factor = byte ^ rem[0];
    rem.shift();
    rem.push(0);
    for (let i = 0; i < ecCount; i += 1) {
      rem[i] ^= gfMul(gen[i + 1], factor);
    }
  }
  return rem;
}

function buildVerificationToken(docKind, docId, secretMaterial = '') {
  const kind = String(docKind || 'DOC')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 4) || 'DOC';
  const idNum = Number.parseInt(docId, 10) || 0;
  const digest = crypto
    .createHash('sha256')
    .update(`dentardv-v2|${kind}|${idNum}|${secretMaterial}`)
    .digest('hex')
    .slice(0, 10)
    .toUpperCase();
  return `DRDV:${kind}:${idNum}:${digest}`;
}

function qrSvg(rawToken, { size = 76 } = {}) {
  const token = String(rawToken || '').trim();
  if (!token || token.length > 32 || !/^[\x21-\x7E]+$/.test(token)) {
    throw new Error('QR_TOKEN_INVALID: only compact verification tokens (<=32 printable ASCII chars, no spaces) are permitted');
  }
  const bytes = Buffer.from(token, 'ascii');
  const N = 25;
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i -= 1) bits.push((val >> i) & 1);
  };
  pushBits(0b0100, 4);
  pushBits(bytes.length, 8);
  for (const b of bytes) pushBits(b, 8);
  const maxBits = 34 * 8;
  for (let i = 0; i < 4 && bits.length < maxBits; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (bits.length < maxBits) {
    pushBits(padBytes[padIdx % 2], 8);
    padIdx += 1;
  }

  const dataCw = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j += 1) b = (b << 1) | bits[i + j];
    dataCw.push(b);
  }
  const ecCw = rsEncode(dataCw, 10);
  const allBits = [];
  for (const cw of [...dataCw, ...ecCw]) {
    for (let i = 7; i >= 0; i -= 1) allBits.push((cw >> i) & 1);
  }
  for (let i = 0; i < 7; i += 1) allBits.push(0);

  const grid = Array.from({ length: N }, () => new Array(N).fill(0));
  const reserved = Array.from({ length: N }, () => new Array(N).fill(false));
  const setMod = (r, c, dark) => {
    if (r >= 0 && r < N && c >= 0 && c < N) {
      grid[r][c] = dark ? 1 : 0;
      reserved[r][c] = true;
    }
  };

  const placeFinder = (r0, c0) => {
    for (let dr = -1; dr <= 7; dr += 1) {
      for (let dc = -1; dc <= 7; dc += 1) {
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const onRing = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setMod(r0 + dr, c0 + dc, inOuter && (onRing || inCore));
      }
    }
  };
  placeFinder(0, 0);
  placeFinder(0, N - 7);
  placeFinder(N - 7, 0);

  for (let dr = -2; dr <= 2; dr += 1) {
    for (let dc = -2; dc <= 2; dc += 1) {
      const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
      setMod(18 + dr, 18 + dc, dark);
    }
  }

  for (let i = 8; i < N - 8; i += 1) {
    if (!reserved[6][i]) setMod(6, i, i % 2 === 0);
    if (!reserved[i][6]) setMod(i, 6, i % 2 === 0);
  }
  setMod(N - 8, 8, true);
  for (let i = 0; i <= 8; i += 1) {
    if (!reserved[8][i]) reserved[8][i] = true;
    if (!reserved[i][8]) reserved[i][8] = true;
  }
  for (let i = 0; i < 8; i += 1) {
    reserved[8][N - 1 - i] = true;
    reserved[N - 1 - i][8] = true;
  }

  let bitIdx = 0;
  let upward = true;
  for (let col = N - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (let step = 0; step < N; step += 1) {
      const r = upward ? N - 1 - step : step;
      for (let dc = 0; dc < 2; dc += 1) {
        const c = col - dc;
        if (!reserved[r][c]) {
          const bit = bitIdx < allBits.length ? allBits[bitIdx] : 0;
          bitIdx += 1;
          const masked = (r + c) % 2 === 0 ? bit ^ 1 : bit;
          grid[r][c] = masked;
        }
      }
    }
    upward = !upward;
  }

  const fmt = 0x77c4;
  const fmtBits = [];
  for (let i = 14; i >= 0; i -= 1) fmtBits.push((fmt >> i) & 1);
  const fmtCoordsA = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  const fmtCoordsB = [
    [N - 1, 8], [N - 2, 8], [N - 3, 8], [N - 4, 8], [N - 5, 8], [N - 6, 8], [N - 7, 8],
    [8, N - 8], [8, N - 7], [8, N - 6], [8, N - 5], [8, N - 4], [8, N - 3], [8, N - 2], [8, N - 1],
  ];
  for (let i = 0; i < 15; i += 1) {
    grid[fmtCoordsA[i][0]][fmtCoordsA[i][1]] = fmtBits[i];
    grid[fmtCoordsB[i][0]][fmtCoordsB[i][1]] = fmtBits[i];
  }

  const quiet = 2;
  const view = N + quiet * 2;
  const rects = [];
  for (let r = 0; r < N; r += 1) {
    for (let c = 0; c < N; c += 1) {
      if (grid[r][c]) rects.push(`<rect x="${c + quiet}" y="${r + quiet}" width="1" height="1"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${view} ${view}" width="${size}" height="${size}" shape-rendering="crispEdges" role="img" aria-label="${token}"><rect width="${view}" height="${view}" fill="#fff"/><g fill="#0f1f33">${rects.join('')}</g></svg>`;
}

function buildDocumentQr(docKindOrOpts, docId, secretMaterial = '', { size = 64 } = {}) {
  let kind = docKindOrOpts;
  let id = docId;
  let secret = secretMaterial;
  if (docKindOrOpts && typeof docKindOrOpts === 'object') {
    kind = docKindOrOpts.kind || 'DOC';
    id = docKindOrOpts.id || 0;
    secret = `${docKindOrOpts.day || ''}|${docKindOrOpts.doctorOrdre || ''}`;
  }
  const token = buildVerificationToken(kind, id, secret);
  const shortHmac = token.split(':').pop() || '';
  const svg = qrSvg(token, { size });
  const dataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  return { token, shortHmac, svg, dataUrl };
}

module.exports = { buildVerificationToken, qrSvg, buildDocumentQr };
