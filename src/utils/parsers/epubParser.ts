import JSZip from 'jszip';

export interface EpubChapter {
  index: number;
  id: string;
  title: string;
  html: string;
  plainText: string;
}

export interface ParsedEpubDocument {
  title?: string;
  author?: string;
  language?: string;
  chapters: EpubChapter[];
}

function resolvePath(baseDir: string, relativePath: string): string {
  const cleanRel = relativePath.split('#')[0];
  if (!baseDir) return cleanRel;
  const stack = baseDir.split('/').filter(Boolean);
  for (const part of cleanRel.split('/')) {
    if (part === '.' || !part) continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

function sanitizeChapterHtml(rawHtml: string): {html: string; plainText: string; extractedHeading?: string} {
  const parser = new DOMParser();
  const doc = parser.parseFromString(rawHtml, 'text/html');

  // Remove unsafe or distracting tags
  doc.querySelectorAll('script, style, iframe, object, embed, link').forEach((el) => el.remove());
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.toLowerCase().startsWith('on')) {
        el.removeAttribute(attr.name);
      }
    }
  });

  const headingEl = doc.querySelector('h1, h2, h3, title');
  const extractedHeading = headingEl?.textContent?.trim() || undefined;
  const body = doc.body;
  const html = body ? body.innerHTML : rawHtml;
  const plainText = (body?.textContent || '').replace(/\s+/g, ' ').trim();

  return {html, plainText, extractedHeading};
}

export async function parseEpubDocument(buffer: ArrayBuffer): Promise<ParsedEpubDocument> {
  const zip = await JSZip.loadAsync(buffer);
  const parser = new DOMParser();

  // 1. Locate OPF path from META-INF/container.xml
  let opfPath = 'OEBPS/content.opf';
  const containerFile = zip.file('META-INF/container.xml');
  if (containerFile) {
    const containerXml = await containerFile.async('text');
    const containerDoc = parser.parseFromString(containerXml, 'application/xml');
    const rootfile = containerDoc.querySelector('rootfile');
    const fullPath = rootfile?.getAttribute('full-path');
    if (fullPath) opfPath = fullPath;
  }

  const opfFile = zip.file(opfPath);
  if (!opfFile) {
    throw new Error('Invalid EPUB archive: missing content.opf');
  }

  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
  const opfXml = await opfFile.async('text');
  const opfDoc = parser.parseFromString(opfXml, 'application/xml');

  const getMetaText = (selector: string): string | undefined => {
    const el = opfDoc.querySelector(selector);
    const val = el?.textContent?.trim();
    return val || undefined;
  };

  const title = getMetaText('title, dc\\:title');
  const author = getMetaText('creator, dc\\:creator');
  const language = getMetaText('language, dc\\:language');

  // 2. Build manifest lookup
  const manifest = new Map<string, {href: string; mediaType: string}>();
  opfDoc.querySelectorAll('manifest > item').forEach((item) => {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    const mediaType = item.getAttribute('media-type') || '';
    if (id && href) {
      manifest.set(id, {href: resolvePath(opfDir, decodeURIComponent(href)), mediaType});
    }
  });

  // 3. Parse NCX TOC titles if available
  const tocTitleByHref = new Map<string, string>();
  const spineEl = opfDoc.querySelector('spine');
  const ncxId = spineEl?.getAttribute('toc');
  const ncxEntry = (ncxId && manifest.get(ncxId)) || Array.from(manifest.values()).find((m) => m.href.endsWith('.ncx'));
  if (ncxEntry) {
    const ncxFile = zip.file(ncxEntry.href);
    if (ncxFile) {
      const ncxXml = await ncxFile.async('text');
      const ncxDoc = parser.parseFromString(ncxXml, 'application/xml');
      const ncxDir = ncxEntry.href.includes('/') ? ncxEntry.href.slice(0, ncxEntry.href.lastIndexOf('/')) : '';
      ncxDoc.querySelectorAll('navPoint').forEach((np) => {
        const label = np.querySelector('navLabel > text')?.textContent?.trim();
        const src = np.querySelector('content')?.getAttribute('src');
        if (label && src) {
          tocTitleByHref.set(resolvePath(ncxDir, decodeURIComponent(src)), label);
        }
      });
    }
  }

  // 4. Walk spine items
  const spineRefs = Array.from(opfDoc.querySelectorAll('spine > itemref'))
    .map((ref) => ref.getAttribute('idref'))
    .filter((id): id is string => Boolean(id));

  const chapters: EpubChapter[] = [];
  for (let i = 0; i < spineRefs.length; i++) {
    const entry = manifest.get(spineRefs[i]);
    if (!entry) continue;
    const chapterFile = zip.file(entry.href);
    if (!chapterFile) continue;

    const rawHtml = await chapterFile.async('text');
    const {html, plainText, extractedHeading} = sanitizeChapterHtml(rawHtml);
    const chapterTitle =
      tocTitleByHref.get(entry.href) || extractedHeading || `Chapter ${chapters.length + 1}`;

    chapters.push({
      index: chapters.length + 1,
      id: spineRefs[i],
      title: chapterTitle,
      html,
      plainText,
    });
  }

  if (chapters.length === 0) {
    throw new Error('EPUB contains no readable chapters in spine');
  }

  return {title, author, language, chapters};
}

function fastStripHtmlToText(rawHtml: string): string {
  return rawHtml
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

async function extractCoverFromLoadedZip(
  zip: JSZip,
  opfDoc: Document | null,
  opfDir: string,
  fallbackTitle?: string,
  fallbackAuthor?: string,
): Promise<string | undefined> {
  if (typeof document === 'undefined') return undefined;
  try {
    if (opfDoc) {
      const metaCoverId = opfDoc.querySelector('meta[name="cover"]')?.getAttribute('content');
      const items = Array.from(opfDoc.querySelectorAll('manifest > item'));
      const coverItem =
        items.find((it) => (it.getAttribute('properties') || '').split(/\s+/).includes('cover-image')) ||
        (metaCoverId ? items.find((it) => it.getAttribute('id') === metaCoverId) : undefined) ||
        items.find((it) => {
          const id = (it.getAttribute('id') || '').toLowerCase();
          const href = (it.getAttribute('href') || '').toLowerCase();
          const mt = (it.getAttribute('media-type') || '').toLowerCase();
          return mt.startsWith('image/') && (id.includes('cover') || href.includes('cover'));
        });

      const coverHref = coverItem?.getAttribute('href');
      if (coverHref) {
        const resolved = resolvePath(opfDir, decodeURIComponent(coverHref));
        const imgFile = zip.file(resolved);
        if (imgFile) {
          const blob = await imgFile.async('blob');
          const objectUrl = URL.createObjectURL(blob);
          try {
            const img = await new Promise<HTMLImageElement>((resolve, reject) => {
              const el = new Image();
              el.onload = () => resolve(el);
              el.onerror = reject;
              el.src = objectUrl;
            });
            const maxH = 300;
            const scale = Math.min(1, maxH / Math.max(1, img.naturalHeight));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
              return canvas.toDataURL('image/jpeg', 0.78);
            }
          } finally {
            URL.revokeObjectURL(objectUrl);
          }
        }
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = 220;
    canvas.height = 310;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.fillStyle = '#F5F0E6';
    ctx.fillRect(0, 0, 220, 310);
    ctx.strokeStyle = '#C9BDA6';
    ctx.lineWidth = 2;
    ctx.strokeRect(12, 12, 196, 286);
    ctx.fillStyle = '#7C6A53';
    ctx.font = '600 10px monospace';
    ctx.fillText('EPUB EDITION', 24, 40);
    ctx.fillStyle = '#1E293B';
    ctx.font = 'bold 18px Georgia, serif';
    const words = (fallbackTitle || 'Untitled Book').split(/\s+/);
    let line = '';
    let y = 94;
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (ctx.measureText(next).width > 168) {
        ctx.fillText(line, 24, y);
        line = w;
        y += 24;
        if (y > 210) break;
      } else {
        line = next;
      }
    }
    if (line && y <= 220) ctx.fillText(line, 24, y);
    ctx.fillStyle = '#64748B';
    ctx.font = 'italic 12px Georgia, serif';
    ctx.fillText((fallbackAuthor || 'Unknown Author').slice(0, 26), 24, 268);
    return canvas.toDataURL('image/jpeg', 0.78);
  } catch {
    return undefined;
  }
}

export async function parseEpubQuickIndex(
  buffer: ArrayBuffer,
  maxSampleChapters = 10,
  includeCover = true,
): Promise<{
  title?: string;
  author?: string;
  language?: string;
  chapterCount: number;
  chapters: {index: number; title: string; plainText: string}[];
  coverDataUrl?: string;
}> {
  const zip = await JSZip.loadAsync(buffer);
  const parser = new DOMParser();

  let opfPath = 'OEBPS/content.opf';
  const containerFile = zip.file('META-INF/container.xml');
  if (containerFile) {
    const containerXml = await containerFile.async('text');
    const containerDoc = parser.parseFromString(containerXml, 'application/xml');
    const fullPath = containerDoc.querySelector('rootfile')?.getAttribute('full-path');
    if (fullPath) opfPath = fullPath;
  }

  const opfFile = zip.file(opfPath);
  if (!opfFile) {
    throw new Error('Invalid EPUB archive: missing content.opf');
  }

  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
  const opfXml = await opfFile.async('text');
  const opfDoc = parser.parseFromString(opfXml, 'application/xml');

  const getMetaText = (selector: string): string | undefined => {
    const val = opfDoc.querySelector(selector)?.textContent?.trim();
    return val || undefined;
  };

  const title = getMetaText('title, dc\\:title');
  const author = getMetaText('creator, dc\\:creator');
  const language = getMetaText('language, dc\\:language');

  const manifest = new Map<string, string>();
  opfDoc.querySelectorAll('manifest > item').forEach((item) => {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (id && href) {
      manifest.set(id, resolvePath(opfDir, decodeURIComponent(href)));
    }
  });

  const tocTitleByHref = new Map<string, string>();
  const ncxId = opfDoc.querySelector('spine')?.getAttribute('toc');
  const ncxHref =
    (ncxId && manifest.get(ncxId)) || Array.from(manifest.values()).find((href) => href.endsWith('.ncx'));
  if (ncxHref) {
    const ncxFile = zip.file(ncxHref);
    if (ncxFile) {
      const ncxXml = await ncxFile.async('text');
      const ncxDoc = parser.parseFromString(ncxXml, 'application/xml');
      const ncxDir = ncxHref.includes('/') ? ncxHref.slice(0, ncxHref.lastIndexOf('/')) : '';
      ncxDoc.querySelectorAll('navPoint').forEach((np) => {
        const label = np.querySelector('navLabel > text')?.textContent?.trim();
        const src = np.querySelector('content')?.getAttribute('src');
        if (label && src) {
          tocTitleByHref.set(resolvePath(ncxDir, decodeURIComponent(src)), label);
        }
      });
    }
  }

  const spineHrefs = Array.from(opfDoc.querySelectorAll('spine > itemref'))
    .map((ref) => ref.getAttribute('idref'))
    .filter((id): id is string => Boolean(id))
    .map((id) => manifest.get(id))
    .filter((href): href is string => Boolean(href));

  if (spineHrefs.length === 0) {
    throw new Error('EPUB contains no readable chapters in spine');
  }

  const sampleLimit = maxSampleChapters > 0 ? Math.min(spineHrefs.length, maxSampleChapters) : spineHrefs.length;
  const sampleHrefs = spineHrefs.slice(0, sampleLimit);

  const [sampled, coverDataUrl] = await Promise.all([
    Promise.all(
      sampleHrefs.map(async (href, i) => {
        const chapterFile = zip.file(href);
        const rawHtml = chapterFile ? await chapterFile.async('text') : '';
        const plainText = fastStripHtmlToText(rawHtml);
        const chTitle = tocTitleByHref.get(href) || `Chapter ${i + 1}`;
        return {
          index: i + 1,
          title: chTitle,
          plainText,
        };
      }),
    ),
    includeCover ? extractCoverFromLoadedZip(zip, opfDoc, opfDir, title, author) : Promise.resolve(undefined),
  ]);

  return {
    title,
    author,
    language,
    chapterCount: spineHrefs.length,
    chapters: sampled,
    coverDataUrl,
  };
}

export async function extractEpubCoverThumbnail(
  buffer: ArrayBuffer,
  fallbackTitle?: string,
  fallbackAuthor?: string,
): Promise<string | undefined> {
  if (typeof document === 'undefined') return undefined;
  try {
    const zip = await JSZip.loadAsync(buffer);
    const parser = new DOMParser();

    let opfPath = 'OEBPS/content.opf';
    const containerFile = zip.file('META-INF/container.xml');
    if (containerFile) {
      const containerXml = await containerFile.async('text');
      const containerDoc = parser.parseFromString(containerXml, 'application/xml');
      const fullPath = containerDoc.querySelector('rootfile')?.getAttribute('full-path');
      if (fullPath) opfPath = fullPath;
    }

    const opfFile = zip.file(opfPath);
    const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
    const opfDoc = opfFile ? parser.parseFromString(await opfFile.async('text'), 'application/xml') : null;
    return await extractCoverFromLoadedZip(zip, opfDoc, opfDir, fallbackTitle, fallbackAuthor);
  } catch {
    return undefined;
  }
}

