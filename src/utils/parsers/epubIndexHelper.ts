import {parseEpubQuickIndex} from './epubParser';

export async function parseEpubForIndex(buffer: ArrayBuffer, maxSampleChapters = 10) {
  return await parseEpubQuickIndex(buffer, maxSampleChapters);
}

export function extractEpubInfoFallback(title: string, page: number): string {
  return `${title} — Page ${page}`;
}
