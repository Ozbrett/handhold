import { deflateSync } from 'node:zlib';

/** A plain RGB picture. */
export interface Picture {
  width: number;
  height: number;
  /** Three bytes a pixel, rows top to bottom. */
  rgb: Uint8Array;
}

export const picture = (width: number, height: number, fill: [number, number, number] = [0, 0, 0]): Picture => {
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < rgb.length; i += 3) rgb.set(fill, i);
  return { width, height, rgb };
};

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC[(c ^ p[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  const t = new TextEncoder().encode(type);
  out.set(t, 4);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32([t, data]));
  return out;
}

/** The picture as PNG bytes (8-bit RGB, no filtering: the pictures are flat-shaded and deflate well as they are). */
export function encodePng(p: Picture): Uint8Array {
  const raw = new Uint8Array((p.width * 3 + 1) * p.height);
  for (let y = 0; y < p.height; y++) raw.set(p.rgb.subarray(y * p.width * 3, (y + 1) * p.width * 3), y * (p.width * 3 + 1) + 1);
  const head = new Uint8Array(13);
  const v = new DataView(head.buffer);
  v.setUint32(0, p.width);
  v.setUint32(4, p.height);
  head[8] = 8;
  head[9] = 2;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, q) => n + q.length, 0));
  let o = 0;
  for (const q of parts) { out.set(q, o); o += q.length; }
  return out;
}

/** Copies `src` into `dst` with its top left at (x, y). */
export function blit(dst: Picture, src: Picture, x: number, y: number) {
  for (let r = 0; r < src.height; r++) {
    const dy = y + r;
    if (dy < 0 || dy >= dst.height) continue;
    for (let c = 0; c < src.width; c++) {
      const dx = x + c;
      if (dx < 0 || dx >= dst.width) continue;
      const s = (r * src.width + c) * 3, d = (dy * dst.width + dx) * 3;
      dst.rgb[d] = src.rgb[s]; dst.rgb[d + 1] = src.rgb[s + 1]; dst.rgb[d + 2] = src.rgb[s + 2];
    }
  }
}

// a 3x5 font for labels: enough to say which view and which frame a tile is
const GLYPHS: Record<string, string> = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111', F: '111100110100100',
  G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010', K: '101101110101101', L: '100100100100111',
  M: '101111111101101', N: '110101101101101', O: '010101101101010', P: '110101110100100', Q: '010101101110011', R: '110101110101101',
  S: '011100010001110', T: '111010010010010', U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101',
  Y: '101101010010010', Z: '111001010100111', '0': '111101101101111', '1': '010110010010111', '2': '110001010100111', '3': '110001010001110',
  '4': '101101111001001', '5': '111100110001110', '6': '011100111101111', '7': '111001010010010', '8': '111101111101111', '9': '111101111001110',
  ' ': '000000000000000', '.': '000000000000010', '-': '000000111000000', '/': '001001010100100', ':': '000010000010000', '%': '101001010100101',
};

/** Writes upper-case text at (x, y), each font pixel `scale` pixels across. */
export function label(p: Picture, text: string, x: number, y: number, colour: [number, number, number], scale = 2) {
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const g = GLYPHS[ch] ?? GLYPHS[' '];
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) {
      if (g[r * 3 + c] !== '1') continue;
      for (let a = 0; a < scale; a++) for (let b = 0; b < scale; b++) {
        const px = cx + c * scale + b, py = y + r * scale + a;
        if (px < 0 || py < 0 || px >= p.width || py >= p.height) continue;
        p.rgb.set(colour, (py * p.width + px) * 3);
      }
    }
    cx += 4 * scale;
  }
}
