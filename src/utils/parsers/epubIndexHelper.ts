import {parseEpubDocument} from './epubParser';

export async function parseEpubForIndex(buffer: ArrayBuffer) {
  return await parseEpubDocument(buffer);
}

export function extractEpubInfoFallback(title: string, page: number): string {
  return `${title} — Page ${page}`;
}
