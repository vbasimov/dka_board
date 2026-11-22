/**
 * Minimal PNG reader for the PWA artifact tests: signature, chunk CRCs, IHDR
 * fields, and decoded RGBA pixels. No dependencies (node:zlib only).
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Reverse the per-scanline filter into a packed pixel buffer. */
function unfilter(raw, ihdr) {
  const channels = ihdr.colorType === 6 ? 4 : ihdr.colorType === 2 ? 3 : ihdr.colorType === 4 ? 2 : 1;
  const stride = ihdr.width * channels;
  const pixels = Buffer.alloc(stride * ihdr.height);
  const rowBytes = stride + 1;
  for (let y = 0; y < ihdr.height; y += 1) {
    const filter = raw[y * rowBytes];
    const src = raw.subarray(y * rowBytes + 1, y * rowBytes + 1 + stride);
    const dst = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? dst[x - channels] : 0;
      const up = prev ? prev[x] : 0;
      const upLeft = prev && x >= channels ? prev[x - channels] : 0;
      let value = src[x];
      switch (filter) {
        case 0:
          break;
        case 1:
          value = (value + left) & 0xff;
          break;
        case 2:
          value = (value + up) & 0xff;
          break;
        case 3:
          value = (value + ((left + up) >> 1)) & 0xff;
          break;
        case 4:
          value = (value + paeth(left, up, upLeft)) & 0xff;
          break;
        default:
          throw new Error(`unsupported PNG filter ${filter} on row ${y}`);
      }
      dst[x] = value;
    }
  }
  return { pixels, channels };
}

/**
 * Parse a PNG file. Throws on a bad signature or a chunk with a wrong CRC, which
 * also proves the generator wrote a structurally valid PNG.
 */
export function readPng(filePath) {
  const buffer = readFileSync(filePath);
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`bad PNG signature in ${filePath}`);
  }

  let offset = 8;
  let ihdr = null;
  const chunks = [];
  const idat = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const storedCrc = buffer.readUInt32BE(offset + 8 + length);
    const computedCrc = crc32(buffer.subarray(offset + 4, offset + 8 + length));
    chunks.push({ type, length, crcOk: storedCrc === computedCrc });
    if (storedCrc !== computedCrc) throw new Error(`bad CRC on ${type} chunk in ${filePath}`);

    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  if (ihdr === null) throw new Error(`PNG without IHDR: ${filePath}`);
  const raw = inflateSync(Buffer.concat(idat));
  const { pixels, channels } = unfilter(raw, ihdr);

  return {
    buffer,
    ihdr,
    chunks,
    pixels,
    channels,
    /** RGBA/RGB pixel at (x, y); alpha defaults to 255 for RGB images. */
    pixelAt(x, y) {
      const base = (y * ihdr.width + x) * channels;
      const alpha = channels === 4 ? pixels[base + 3] : 255;
      return [pixels[base], pixels[base + 1], pixels[base + 2], alpha];
    },
  };
}

/** Count pixels whose RGB differs from `color`. */
export function countNonBackground(png, color) {
  let count = 0;
  for (let y = 0; y < png.ihdr.height; y += 1) {
    for (let x = 0; x < png.ihdr.width; x += 1) {
      const [r, g, b] = png.pixelAt(x, y);
      if (r !== color[0] || g !== color[1] || b !== color[2]) count += 1;
    }
  }
  return count;
}
