import {parseEpubQuickIndex} from './epubParser';

export async function parseEpubForIndex(
  buffer: ArrayBuffer,
  maxSampleChapters = 10,
  includeCover = true,
) {
  return await parseEpubQuickIndex(buffer, maxSampleChapters, includeCover);
}

export function extractEpubInfoFallback(title: string, page: number): string {
  return `${title} — Page ${page}`;
}
