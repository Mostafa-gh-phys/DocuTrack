export interface LibgenMirrorCandidate {
  url: string;
  label: string;
  engine: 'classic' | 'plus';
}

export interface LibgenMirrorStatus extends LibgenMirrorCandidate {
  open: boolean;
  latencyMs: number | null;
  statusCode?: number;
  error?: string;
}

export interface LibgenBookResult {
  id: string;
  md5: string;
  title: string;
  authors: string;
  publisher: string;
  year: number | null;
  pages: number | null;
  language: string;
  sizeLabel: string;
  sizeBytes: number;
  extension: string;
  mirrorOrigin: string;
  detailUrl: string;
  downloadPageUrl: string;
}

export type LibgenSortField = 'relevance' | 'title' | 'authors' | 'year' | 'sizeBytes' | 'extension';
export type LibgenSortDirection = 'asc' | 'desc';

export const DEFAULT_LIBGEN_MIRRORS: LibgenMirrorCandidate[] = [
  {url: 'https://libgen.is', label: 'libgen.is (Classic)', engine: 'classic'},
  {url: 'https://libgen.rs', label: 'libgen.rs (Classic)', engine: 'classic'},
  {url: 'https://libgen.st', label: 'libgen.st (Classic)', engine: 'classic'},
  {url: 'https://libgen.li', label: 'libgen.li (Plus)', engine: 'plus'},
  {url: 'https://libgen.gs', label: 'libgen.gs (Plus)', engine: 'plus'},
  {url: 'https://libgen.vg', label: 'libgen.vg (Plus)', engine: 'plus'},
  {url: 'https://libgen.la', label: 'libgen.la (Plus)', engine: 'plus'},
];

export function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCharCode(Number(dec)))
    .replace(/\s+/g, ' ')
    .trim();
}

export function stripHtmlTags(input: string): string {
  return decodeHtmlEntities(input.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' '));
}

export function parseLibgenSizeToBytes(sizeLabel: string): number {
  const match = (sizeLabel || '').trim().match(/^([\d.,]+)\s*(B|KB|Kb|KiB|MB|Mb|MiB|GB|Gb|GiB)?$/i);
  if (!match) return 0;
  const num = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(num) || num <= 0) return 0;
  const unit = (match[2] || 'B').toUpperCase();
  if (unit.startsWith('G')) return Math.round(num * 1024 * 1024 * 1024);
  if (unit.startsWith('M')) return Math.round(num * 1024 * 1024);
  if (unit.startsWith('K')) return Math.round(num * 1024);
  return Math.round(num);
}

export function inferMirrorEngine(mirrorUrl: string): 'classic' | 'plus' {
  const lower = mirrorUrl.toLowerCase();
  if (/(libgen\.li|libgen\.gs|libgen\.vg|libgen\.la|libgen\.bz|libgen\.gl)/.test(lower)) {
    return 'plus';
  }
  return 'classic';
}

export function buildLibgenSearchUrl(
  mirrorOrigin: string,
  query: string,
  column: 'def' | 'title' | 'author' | 'identifier' | 'publisher' = 'def',
  limit = 50,
): string {
  const origin = mirrorOrigin.replace(/\/+$/, '');
  const engine = inferMirrorEngine(origin);
  const cleanQ = encodeURIComponent(query.trim());
  const safeRes = [25, 50, 100].includes(limit) ? limit : 50;

  if (engine === 'plus') {
    const colMap: Record<string, string> = {
      def: 't',
      title: 't',
      author: 'a',
      identifier: 'i',
      publisher: 'p',
    };
    return `${origin}/index.php?req=${cleanQ}&columns%5B%5D=${colMap[column] || 't'}&objects%5B%5D=f&objects%5B%5D=e&objects%5B%5D=s&objects%5B%5D=a&objects%5B%5D=p&objects%5B%5D=w&topics%5B%5D=l&topics%5B%5D=c&topics%5B%5D=f&topics%5B%5D=a&topics%5B%5D=m&topics%5B%5D=r&topics%5B%5D=s&res=${safeRes}&filesuns=all`;
  }

  return `${origin}/search.php?req=${cleanQ}&lg_topic=libgen&open=0&view=simple&res=${safeRes}&phrase=1&column=${column}`;
}

export function extractAttributeValue(htmlTag: string, attrName: string): string | null {
  const regex = new RegExp(`${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = htmlTag.match(regex);
  return m ? decodeHtmlEntities(m[1] ?? m[2] ?? m[3] ?? '') : null;
}

export function resolveSafeHttpUrl(rawHref: string, baseOrigin: string): string | null {
  if (!rawHref) return null;
  try {
    const resolved = new URL(rawHref.trim(), baseOrigin);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

/**
 * Parses HTML search tables from both classic LibGen (.is/.rs/.st) and Plus (.li/.gs/.vg) mirrors.
 */
export function parseLibgenSearchHtml(html: string, mirrorOrigin: string): LibgenBookResult[] {
  const origin = mirrorOrigin.replace(/\/+$/, '');
  const results: LibgenBookResult[] = [];
  const seenKeys = new Set<string>();

  // Locate primary result table (class="c" or id="tablelibgen")
  const tableMatch =
    html.match(/<table[^>]*class=["'][^"']*\bc\b[^"']*["'][^>]*>([\s\S]*?)<\/table>/i) ||
    html.match(/<table[^>]*id=["']tablelibgen["'][^>]*>([\s\S]*?)<\/table>/i);

  const tableBody = tableMatch ? tableMatch[1] : html;
  const rowMatches = tableBody.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];

  for (let i = 0; i < rowMatches.length; i++) {
    const row = rowMatches[i];
    if (/<th\b/i.test(row) && !/<td\b/i.test(row)) continue;

    const cellMatches = row.match(/<td\b[^>]*>([\s\S]*?)<\/td>/gi) || [];
    if (cellMatches.length < 8) continue;

    const cellTexts = cellMatches.map((c) => stripHtmlTags(c));
    const md5Match = row.match(/md5=([a-fA-F0-9]{32})/i) || row.match(/\b([a-fA-F0-9]{32})\b/);
    const md5 = md5Match ? md5Match[1].toLowerCase() : '';

    // Classic table columns:
    // [0] ID, [1] Author(s), [2] Title, [3] Publisher, [4] Year, [5] Pages, [6] Language, [7] Size, [8] Extension, [9+] Mirrors
    const idCandidate = cellTexts[0].match(/^\d+$/) ? cellTexts[0] : `row_${i}`;
    let authors = '';
    let title = '';
    let publisher = '';
    let yearRaw = '';
    let pagesRaw = '';
    let language = '';
    let sizeLabel = '';
    let extension = '';

    // Extract title cleanly from <a href="book/index.php?md5=..."> or cell[2] / cell[0]
    const linkHrefMatches = Array.from(row.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi));
    const detailLink = linkHrefMatches.find((m) =>
      /(book\/index\.php|edition\.php|file\.php|ads\.php)/i.test(m[1]),
    );
    const titleFromCell2 = cellMatches[2]
      ? stripHtmlTags(cellMatches[2].replace(/<font[^>]*>[\s\S]*?<\/font>/gi, ' '))
      : '';

    if (cellMatches.length >= 9 && /^\d+$/.test(cellTexts[0])) {
      authors = cellTexts[1];
      title = titleFromCell2 || cellTexts[2];
      publisher = cellTexts[3];
      yearRaw = cellTexts[4];
      pagesRaw = cellTexts[5];
      language = cellTexts[6];
      sizeLabel = cellTexts[7];
      extension = cellTexts[8];
    } else {
      // Plus engine layout: cell[0] = title/edition, cell[1] = authors, cell[2] = publisher, cell[3] = year, cell[4] = lang, cell[5] = pages, cell[6] = size, cell[7] = ext
      title = stripHtmlTags(cellMatches[0] || '') || (detailLink ? stripHtmlTags(detailLink[2]) : '');
      authors = cellTexts[1] || '';
      publisher = cellTexts[2] || '';
      yearRaw = cellTexts[3] || '';
      language = cellTexts[4] || '';
      pagesRaw = cellTexts[5] || '';
      sizeLabel = cellTexts[6] || '';
      extension = cellTexts[7] || '';
    }

    title = title.trim();
    if (!title || /^(id|title)$/i.test(title)) continue;

    const cleanExt = (extension || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!cleanExt && !md5) continue;

    const yearMatch = yearRaw.match(/\b(1[5-9]\d{2}|20\d{2})\b/);
    const year = yearMatch ? Number(yearMatch[1]) : null;
    const pagesMatch = pagesRaw.match(/\d+/);
    const pages = pagesMatch ? Number(pagesMatch[0]) : null;

    // Extract mirror/download link candidates
    let detailUrl = md5 ? `${origin}/book/index.php?md5=${md5}` : origin;
    if (detailLink) {
      const href = extractAttributeValue(detailLink[1], 'href');
      const resolved = href ? resolveSafeHttpUrl(href, origin) : null;
      if (resolved) detailUrl = resolved;
    }

    const downloadLinkCandidate = linkHrefMatches.find((m) => {
      const href = extractAttributeValue(m[1], 'href') || '';
      return /(library\.lol|libgen\.(li|is|rs|st|gs|vg|la)\/(ads|get)\.php|\/ads\.php|\/get\.php)/i.test(href);
    });
    const fallbackDownloadUrl = md5
      ? inferMirrorEngine(origin) === 'plus'
        ? `${origin}/ads.php?md5=${md5}`
        : `https://library.lol/main/${md5}`
      : detailUrl;

    const extractedHref = downloadLinkCandidate
      ? extractAttributeValue(downloadLinkCandidate[1], 'href')
      : null;
    const downloadPageUrl =
      (extractedHref ? resolveSafeHttpUrl(extractedHref, origin) : null) || fallbackDownloadUrl;

    const key = md5 || `${title.toLowerCase()}|${cleanExt}|${sizeLabel}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    results.push({
      id: md5 || idCandidate,
      md5,
      title,
      authors: authors || 'Unknown Author',
      publisher: publisher || '—',
      year,
      pages,
      language: language || 'English',
      sizeLabel: sizeLabel || '—',
      sizeBytes: parseLibgenSizeToBytes(sizeLabel),
      extension: cleanExt || 'pdf',
      mirrorOrigin: origin,
      detailUrl,
      downloadPageUrl,
    });
  }

  return results;
}

/**
 * Extracts direct file download URLs from a LibGen mirror landing page (library.lol / ads.php / get.php).
 */
export function extractLibgenDirectUrls(html: string, pageUrl: string): string[] {
  const candidates: string[] = [];
  const links = Array.from(html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi));

  for (const m of links) {
    const href = extractAttributeValue(m[1], 'href');
    if (!href) continue;
    const label = stripHtmlTags(m[2]).toLowerCase();
    const resolved = resolveSafeHttpUrl(href, pageUrl);
    if (!resolved) continue;

    if (
      /\bget\b|download|cloudflare|ipfs|pinata|dweb/i.test(label) ||
      /(get\.php|download\/|cloudflare-ipfs|ipfs\.io)/i.test(resolved)
    ) {
      if (!candidates.includes(resolved)) {
        candidates.push(resolved);
      }
    }
  }
  return candidates;
}

export function sortLibgenResults(
  items: LibgenBookResult[],
  sortBy: LibgenSortField,
  direction: LibgenSortDirection,
): LibgenBookResult[] {
  if (sortBy === 'relevance') {
    return direction === 'asc' ? [...items].reverse() : [...items];
  }
  const factor = direction === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    switch (sortBy) {
      case 'title':
        return a.title.localeCompare(b.title) * factor;
      case 'authors':
        return a.authors.localeCompare(b.authors) * factor;
      case 'year':
        return ((a.year || 0) - (b.year || 0)) * factor;
      case 'sizeBytes':
        return (a.sizeBytes - b.sizeBytes) * factor;
      case 'extension':
        return a.extension.localeCompare(b.extension) * factor;
      default:
        return 0;
    }
  });
}

/**
 * Discovers additional mirror URLs listed on LibGen wiki/mirror directory HTML pages.
 */
export function extractDiscoveredMirrorsFromHtml(html: string): LibgenMirrorCandidate[] {
  const discovered: LibgenMirrorCandidate[] = [];
  const seen = new Set(DEFAULT_LIBGEN_MIRRORS.map((m) => m.url.toLowerCase()));
  const matches = html.match(/https?:\/\/libgen\.[a-z]{2,6}/gi) || [];

  for (const raw of matches) {
    const clean = raw.toLowerCase().replace(/\/+$/, '');
    if (seen.has(clean)) continue;
    seen.add(clean);
    const host = clean.replace(/^https?:\/\//, '');
    discovered.push({
      url: clean,
      label: `${host} (Discovered)`,
      engine: inferMirrorEngine(clean),
    });
    if (discovered.length >= 8) break;
  }
  return discovered;
}
