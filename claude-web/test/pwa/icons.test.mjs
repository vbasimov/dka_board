import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { countNonBackground, readPng } from './png.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const claudeWeb = join(here, '..', '..');
const iconsDir = join(claudeWeb, 'pwa', 'public', 'claude', 'icons');

/** #1a1917 — the opaque background every install icon must use. */
const BACKGROUND = [0x1a, 0x19, 0x17];

const EXPECTED = [
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
  { file: 'apple-touch-icon-180.png', size: 180 },
  { file: 'favicon-96.png', size: 96 },
];

test('icons: five committed PNG install assets with expected sizes', () => {
  for (const target of EXPECTED) {
    const png = readPng(join(iconsDir, target.file));
    assert.equal(png.chunks[0].type, 'IHDR', `${target.file}: первый чанк должен быть IHDR`);
    assert.equal(png.chunks[png.chunks.length - 1].type, 'IEND', `${target.file}: последний чанк должен быть IEND`);
    assert.ok(png.chunks.some((chunk) => chunk.type === 'IDAT'), `${target.file}: нет IDAT`);
    assert.ok(png.chunks.every((chunk) => chunk.crcOk), `${target.file}: битый CRC`);
    assert.equal(png.ihdr.width, target.size, `${target.file}: ширина`);
    assert.equal(png.ihdr.height, target.size, `${target.file}: высота`);
    assert.equal(png.ihdr.bitDepth, 8, `${target.file}: глубина цвета`);
    assert.ok(png.ihdr.colorType === 6 || png.ihdr.colorType === 2, `${target.file}: цветовой тип`);
    assert.equal(png.ihdr.interlace, 0, `${target.file}: interlace должен быть 0`);
    assert.equal(png.ihdr.compression, 0, `${target.file}: compression должен быть 0`);
  }
});

test('icons: fully opaque (no transparent pixels released to installers)', () => {
  for (const target of EXPECTED) {
    const png = readPng(join(iconsDir, target.file));
    if (png.channels !== 4) continue;
    for (let y = 0; y < png.ihdr.height; y += 1) {
      for (let x = 0; x < png.ihdr.width; x += 1) {
        const alpha = png.pixelAt(x, y)[3];
        if (alpha !== 255) assert.fail(`${target.file}: полупрозрачный пиксель (${x},${y}) alpha=${alpha}`);
      }
    }
  }
});

test('icons: dark opaque background and a visible own mark', () => {
  for (const target of EXPECTED) {
    const png = readPng(join(iconsDir, target.file));
    // Corners are outside the artwork: they must be exactly the background colour.
    for (const [x, y] of [
      [0, 0],
      [png.ihdr.width - 1, 0],
      [0, png.ihdr.height - 1],
      [png.ihdr.width - 1, png.ihdr.height - 1],
    ]) {
      const [r, g, b] = png.pixelAt(x, y);
      assert.deepEqual([r, g, b], BACKGROUND, `${target.file}: угол (${x},${y}) не равен #1a1917`);
    }
    const painted = countNonBackground(png, BACKGROUND);
    const total = png.ihdr.width * png.ihdr.height;
    const ratio = painted / total;
    assert.ok(ratio > 0.005, `${target.file}: знак не нарисован (${(ratio * 100).toFixed(2)}% пикселей)`);
    assert.ok(ratio < 0.5, `${target.file}: слишком большая заливка (${(ratio * 100).toFixed(2)}%)`);
  }
});

test('icons: maskable artwork stays inside the 80% safe zone', () => {
  const png = readPng(join(iconsDir, 'icon-maskable-512.png'));
  const { width, height } = png.ihdr;
  // The maskable safe zone is a circle of radius 40% of the side; everything
  // outside the inscribed square (|dx| > 0.4*size or |dy| > 0.4*size) must be background.
  const margin = Math.round(width * 0.1);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x >= margin && x < width - margin && y >= margin && y < height - margin) continue;
      const [r, g, b] = png.pixelAt(x, y);
      if (r !== BACKGROUND[0] || g !== BACKGROUND[1] || b !== BACKGROUND[2]) {
        assert.fail(`maskable: содержимое вне safe zone в (${x},${y})`);
      }
    }
  }
});

test('icons: palette stays in the dark theme (amber accent on #1a1917)', () => {
  const png = readPng(join(iconsDir, 'icon-512.png'));
  let amberPixels = 0;
  for (let y = 0; y < png.ihdr.height; y += 1) {
    for (let x = 0; x < png.ihdr.width; x += 1) {
      const [r, g, b] = png.pixelAt(x, y);
      // The accent is warm: red channel dominant, blue clearly the smallest.
      if (r > 120 && r > b + 40 && g > 60) amberPixels += 1;
    }
  }
  assert.ok(amberPixels > 500, 'акцентный цвет знака отсутствует');
});
