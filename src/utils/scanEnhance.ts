import type {ScanEnhanceSettings, ScanPreset} from '../types/library';

export const DEFAULT_SCAN_SETTINGS: ScanEnhanceSettings = {
  preset: 'original',
  contrast: 1,
  brightness: 0,
  sharpness: 0,
  cleanBackground: false,
};

export function getScanPresetSettings(preset: ScanPreset): ScanEnhanceSettings {
  switch (preset) {
    case 'clean-scan':
      return {
        preset: 'clean-scan',
        contrast: 1.45,
        brightness: 12,
        sharpness: 0.45,
        cleanBackground: true,
      };
    case 'high-contrast':
      return {
        preset: 'high-contrast',
        contrast: 1.85,
        brightness: 4,
        sharpness: 0.65,
        cleanBackground: true,
      };
    case 'bleed-reduce':
      return {
        preset: 'bleed-reduce',
        contrast: 1.35,
        brightness: 18,
        sharpness: 0.3,
        cleanBackground: true,
      };
    case 'original':
    default:
      return {...DEFAULT_SCAN_SETTINGS};
  }
}

export function isScanEnhancementActive(settings: ScanEnhanceSettings): boolean {
  return (
    settings.preset !== 'original' ||
    Math.abs(settings.contrast - 1) > 0.02 ||
    Math.abs(settings.brightness) > 1 ||
    settings.sharpness > 0.02 ||
    settings.cleanBackground
  );
}

function clampByte(v: number): number {
  if (v < 0) return 0;
  if (v > 255) return 255;
  return Math.round(v);
}

/**
 * Pure pixel-level enhancement optimized for low-quality scanned PDF & DjVu pages:
 * 1) Brightness & contrast curve around mid-gray
 * 2) Optional paper-background whitening & bleed-through removal
 * 3) Optional 3x3 unsharp-mask edge crispening on luminance
 */
export function enhanceImageDataPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  settings: ScanEnhanceSettings,
): Uint8ClampedArray {
  if (!isScanEnhancementActive(settings)) {
    return pixels;
  }

  const contrast = Math.max(0.5, Math.min(2.6, settings.contrast));
  const brightness = Math.max(-80, Math.min(80, settings.brightness));
  const cleanBg = Boolean(settings.cleanBackground);
  const sharpness = Math.max(0, Math.min(1, settings.sharpness));

  // Paper threshold slightly more aggressive for bleed-reduce / clean-scan
  const paperThreshold = settings.preset === 'bleed-reduce' ? 192 : 206;
  const inkKnee = settings.preset === 'high-contrast' ? 92 : 68;

  const totalPixels = width * height;
  const out = new Uint8ClampedArray(pixels.length);

  for (let i = 0; i < totalPixels * 4; i += 4) {
    let r = pixels[i];
    let g = pixels[i + 1];
    let b = pixels[i + 2];
    const a = pixels[i + 3];

    if (cleanBg) {
      // Remove color tint / yellowing on paper background & suppress reverse-side bleed-through
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      if (lum >= paperThreshold && chroma < 48) {
        r = 255;
        g = 255;
        b = 255;
      } else if (lum <= inkKnee && chroma < 38) {
        // Slightly deepen faded gray ink strokes for legibility
        const darken = 0.82;
        r *= darken;
        g *= darken;
        b *= darken;
      } else if (lum > 140 && lum < paperThreshold && chroma < 32) {
        // Gently push mottled gray scan speckle toward clean paper white
        const t = (lum - 140) / (paperThreshold - 140);
        const lift = t * t * 34;
        r += lift;
        g += lift;
        b += lift;
      }
    }

    r = (r - 128) * contrast + 128 + brightness;
    g = (g - 128) * contrast + 128 + brightness;
    b = (b - 128) * contrast + 128 + brightness;

    out[i] = clampByte(r);
    out[i + 1] = clampByte(g);
    out[i + 2] = clampByte(b);
    out[i + 3] = a;
  }

  if (sharpness > 0.02 && width >= 3 && height >= 3) {
    const srcCopy = new Uint8ClampedArray(out);
    const amount = sharpness * 0.85;
    for (let y = 1; y < height - 1; y++) {
      const row = y * width;
      for (let x = 1; x < width - 1; x++) {
        const idx = (row + x) * 4;
        const up = ((y - 1) * width + x) * 4;
        const dn = ((y + 1) * width + x) * 4;
        const lf = (row + x - 1) * 4;
        const rt = (row + x + 1) * 4;

        for (let ch = 0; ch < 3; ch++) {
          const center = srcCopy[idx + ch];
          const blur = (srcCopy[up + ch] + srcCopy[dn + ch] + srcCopy[lf + ch] + srcCopy[rt + ch]) * 0.25;
          const sharpened = center + (center - blur) * amount;
          out[idx + ch] = clampByte(sharpened);
        }
      }
    }
  }

  return out;
}

export function applyScanEnhancementToCanvas(
  canvas: HTMLCanvasElement,
  settings: ScanEnhanceSettings,
): boolean {
  if (!isScanEnhancementActive(settings)) return false;
  const ctx = canvas.getContext('2d', {willReadFrequently: true});
  if (!ctx || canvas.width === 0 || canvas.height === 0) return false;

  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const enhanced = enhanceImageDataPixels(img.data, canvas.width, canvas.height, settings);
  if (enhanced !== img.data) {
    img.data.set(enhanced);
    ctx.putImageData(img, 0, 0);
  }
  return true;
}
