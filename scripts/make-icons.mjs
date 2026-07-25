// Generates the PWA icons with zero dependencies (Node's zlib writes the PNG).
// Run:  node scripts/make-icons.mjs
//
// Draws a parking "P" sign. Everything is supersampled 4x then box-filtered,
// which is enough antialiasing for an app icon.

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SS = 4; // supersample factor

const BLUE = [47, 123, 255];
const DEEP = [16, 62, 148];
const WHITE = [255, 255, 255];

/** Signed-distance helpers, all in supersampled pixel space. */
function roundedRectInside(x, y, S, radius, inset) {
  const lo = inset;
  const hi = S - inset;
  const cx = Math.min(Math.max(x, lo + radius), hi - radius);
  const cy = Math.min(Math.max(y, lo + radius), hi - radius);
  if (x < lo || x > hi || y < lo || y > hi) return false;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/** The letter P, sized relative to the icon box it sits in. */
function inLetterP(x, y, box) {
  const { left, top, size } = box;
  const stemW = size * 0.2;
  const stemX = left + size * 0.24;
  const letterTop = top + size * 0.12;
  const letterBot = top + size * 0.88;

  // Vertical stem.
  if (x >= stemX && x <= stemX + stemW && y >= letterTop && y <= letterBot) return true;

  // Bowl: right-hand half-annulus sitting flush against the stem.
  const outerR = size * 0.31;
  const innerR = outerR - stemW;
  const cx = stemX + stemW;
  const cy = letterTop + outerR;
  if (x >= cx) {
    const d = Math.hypot(x - cx, y - cy);
    if (d <= outerR && d >= innerR) return true;
  }
  return false;
}

function render(size, { maskable = false } = {}) {
  const S = size * SS;
  const px = new Uint8Array(S * S * 4);

  // Maskable icons get cropped to a circle by the OS, so keep the art small
  // and let the background bleed to every edge.
  const inset = maskable ? 0 : S * 0.055;
  const radius = maskable ? 0 : S * 0.22;
  const letterScale = maskable ? 0.52 : 0.7;
  const box = {
    size: S * letterScale,
    left: (S - S * letterScale) / 2,
    top: (S - S * letterScale) / 2,
  };

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const onSign = maskable ? true : roundedRectInside(x, y, S, radius, inset);

      if (!onSign) {
        px[i + 3] = 0;
        continue;
      }
      // Vertical gradient so the sign doesn't look flat.
      const t = y / S;
      const bg = [
        Math.round(BLUE[0] + (DEEP[0] - BLUE[0]) * t),
        Math.round(BLUE[1] + (DEEP[1] - BLUE[1]) * t),
        Math.round(BLUE[2] + (DEEP[2] - BLUE[2]) * t),
      ];
      const c = inLetterP(x, y, box) ? WHITE : bg;
      px[i] = c[0];
      px[i + 1] = c[1];
      px[i + 2] = c[2];
      px[i + 3] = 255;
    }
  }
  return downsample(px, S, size);
}

/** Box-filter SSxSS blocks down to one output pixel (premultiplied). */
function downsample(src, S, out) {
  const dst = Buffer.alloc(out * out * 4);
  for (let y = 0; y < out; y++) {
    for (let x = 0; x < out; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = (((y * SS + sy) * S) + (x * SS + sx)) * 4;
          const al = src[i + 3] / 255;
          r += src[i] * al;
          g += src[i + 1] * al;
          b += src[i + 2] * al;
          a += src[i + 3];
        }
      }
      const n = SS * SS;
      const alpha = a / n;
      const norm = alpha > 0 ? (alpha / 255) * n : 1;
      const o = (y * out + x) * 4;
      dst[o] = Math.round(r / norm);
      dst[o + 1] = Math.round(g / norm);
      dst[o + 2] = Math.round(b / norm);
      dst[o + 3] = Math.round(alpha);
    }
  }
  return dst;
}

// ------------------------------------------------------------ PNG encoding

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(rgba, size) {
  // Filter type 0 (None) on every scanline — small icons compress fine anyway.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ----------------------------------------------------------------- outputs

const targets = [
  ["icon-192.png", 192, {}],
  ["icon-512.png", 512, {}],
  ["apple-touch-icon.png", 180, {}],
  ["icon-maskable-512.png", 512, { maskable: true }],
];

for (const [name, size, opts] of targets) {
  writeFileSync(join(OUT, name), encodePNG(render(size, opts), size));
  console.log(`wrote ${name} (${size}x${size})`);
}
