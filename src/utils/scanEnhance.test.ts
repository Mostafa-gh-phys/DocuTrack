import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_SCAN_SETTINGS,
  enhanceImageDataPixels,
  getScanPresetSettings,
  isScanEnhancementActive,
} from './scanEnhance';

test('getScanPresetSettings and isScanEnhancementActive distinguish original vs enhanced presets', () => {
  assert.equal(isScanEnhancementActive(DEFAULT_SCAN_SETTINGS), false);

  const clean = getScanPresetSettings('clean-scan');
  assert.equal(isScanEnhancementActive(clean), true);
  assert.equal(clean.cleanBackground, true);

  const bleed = getScanPresetSettings('bleed-reduce');
  assert.equal(isScanEnhancementActive(bleed), true);
  assert.ok(bleed.brightness > clean.brightness);

  const highContrast = getScanPresetSettings('high-contrast');
  assert.ok(highContrast.contrast > clean.contrast);
});

test('enhanceImageDataPixels whitens yellowed paper background and deepens faded ink strokes', () => {
  // 3x3 RGBA pixel grid: surrounding yellowed paper (225, 218, 200) and center faded ink (55, 55, 58)
  const width = 3;
  const height = 3;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const isCenter = i === 4;
    pixels[i * 4] = isCenter ? 55 : 225;
    pixels[i * 4 + 1] = isCenter ? 55 : 218;
    pixels[i * 4 + 2] = isCenter ? 58 : 200;
    pixels[i * 4 + 3] = 255;
  }

  // Original preset returns the exact input buffer untouched
  const untouched = enhanceImageDataPixels(pixels, width, height, DEFAULT_SCAN_SETTINGS);
  assert.equal(untouched, pixels);

  // Clean Scan B&W pushes paper background to pure 255 white and darkens center ink toward crisp black
  const clean = getScanPresetSettings('clean-scan');
  const out = enhanceImageDataPixels(pixels, width, height, clean);
  assert.equal(out[0], 255);
  assert.equal(out[1], 255);
  assert.equal(out[2], 255);
  assert.equal(out[3], 255);

  const centerOffset = 4 * 4;
  assert.ok(out[centerOffset] < 55, `Expected darkened center ink < 55, got ${out[centerOffset]}`);
  assert.ok(out[centerOffset + 1] < 55);
  assert.ok(out[centerOffset + 2] < 58);
});
