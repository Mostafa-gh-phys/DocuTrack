import JSZip from 'jszip';
import type {OutlineItem} from '../../types/library';
import {releaseCanvasMemory, yieldToMain} from '../batchYield';

export interface EpubChapter {
  index: number;
  id: string;
  href: string;
  title: string;
  html: string;
  plainText: string;
}

export interface ParsedEpubDocument {
  title?: string;
  author?: string;
  language?: string;
  chapters: EpubChapter[];
  toc: OutlineItem[];
  dispose: () => void;
}

export function safeDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function resolveEpubPath(baseDir: string, relativePath: string): string {
  const cleanRel = relativePath.split('#')[0].split('?')[0].replace(/\\/g, '/').trim();
  if (!cleanRel) return '';
  if (cleanRel.startsWith('/')) {
    return cleanRel.replace(/^\/+/, '');
  }
  const stack = baseDir ? baseDir.replace(/\\/g, '/').split('/').filter(Boolean) : [];
  for (const part of cleanRel.split('/')) {
    if (part === '.' || !part) continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

function findZipEntry(zip: JSZip, targetPath: string): JSZip.JSZipObject | null {
  if (!targetPath) return null;
  const normalized = targetPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const decoded = safeDecodeUri(normalized);

  const direct = zip.file(normalized) || zip.file(decoded);
  if (direct) return direct;

  const lower = normalized.toLowerCase();
  const decodedLower = decoded.toLowerCase();
  for (const [key, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const normKey = key.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
    if (normKey === lower || normKey === decodedLower || safeDecodeUri(normKey) === decodedLower) {
      return entry;
    }
  }
  return null;
}

function getElementsByLocalName(root: Document | Element, localName: string): Element[] {
  const target = localName.toLowerCase();
  const out: Element[] = [];
  const all = root.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if ((el.localName || el.nodeName.split(':').pop() || '').toLowerCase() === target) {
      out.push(el);
    }
  }
  return out;
}

function getFirstTextByLocalName(root: Document | Element, localName: string): string | undefined {
  const matches = getElementsByLocalName(root, localName);
  for (const m of matches) {
    const val = m.textContent?.trim();
    if (val) return val;
  }
  return undefined;
}

function guessMimeFromExt(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

function isSafeExternalOrDataUrl(url: string): boolean {
  const trimmed = url.trim().toLowerCase();
  if (!trimmed) return false;
  if (trimmed.startsWith('blob:') || trimmed.startsWith('data:image/')) return true;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return true;
  return false;
}

async function resolveAssetBlobUrl(
  zip: JSZip,
  chapterDir: string,
  rawRef: string,
  blobUrlCache: Map<string, string>,
  createdBlobUrls: string[],
): Promise<string | null> {
  const trimmed = rawRef.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('#') || isSafeExternalOrDataUrl(trimmed)) return trimmed;
  // Block dangerous schemes like javascript:, vbscript:, data:text/html
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;

  const resolved = resolveEpubPath(chapterDir, safeDecodeUri(trimmed));
  if (!resolved) return null;

  const cached = blobUrlCache.get(resolved.toLowerCase());
  if (cached) return cached;

  const entry = findZipEntry(zip, resolved);
  if (!entry) return null;

  try {
    const bytes = await entry.async('uint8array');
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const mime = guessMimeFromExt(resolved);
    const blobUrl = URL.createObjectURL(new Blob([copy], {type: mime}));
    blobUrlCache.set(resolved.toLowerCase(), blobUrl);
    createdBlobUrls.push(blobUrl);
    return blobUrl;
  } catch {
    return null;
  }
}

async function sanitizeAndHydrateChapterHtml(
  rawHtml: string,
  chapterHref: string,
  zip: JSZip,
  blobUrlCache: Map<string, string>,
  createdBlobUrls: string[],
): Promise<{html: string; plainText: string; extractedHeading?: string}> {
  const parser = new DOMParser();
  const doc = parser.parseFromString(rawHtml, 'text/html');
  const chapterDir = chapterHref.includes('/') ? chapterHref.slice(0, chapterHref.lastIndexOf('/')) : '';

  // Remove executable/unsafe elements
  doc.querySelectorAll('script, style, iframe, object, embed, link, base').forEach((el) => el.remove());

  const elements = Array.from(doc.querySelectorAll('*'));
  for (const el of elements) {
    for (const attr of Array.from(el.attributes)) {
      const lowerName = attr.name.toLowerCase();
      if (lowerName.startsWith('on')) {
        el.removeAttribute(attr.name);
        continue;
      }
      if ((lowerName === 'href' || lowerName === 'xlink:href') && el.tagName.toLowerCase() === 'a') {
        const v = attr.value.trim().toLowerCase();
        if (v.startsWith('javascript:') || v.startsWith('vbscript:') || v.startsWith('data:text/html')) {
          el.removeAttribute(attr.name);
        }
      }
    }

    const tag = el.tagName.toLowerCase();
    if (tag === 'img') {
      const src = el.getAttribute('src');
      if (src) {
        const hydrated = await resolveAssetBlobUrl(zip, chapterDir, src, blobUrlCache, createdBlobUrls);
        if (hydrated) {
          el.setAttribute('src', hydrated);
          el.setAttribute('loading', 'lazy');
        } else {
          el.removeAttribute('src');
        }
      }
    } else if (tag === 'image') {
      const href = el.getAttribute('xlink:href') || el.getAttribute('href');
      if (href) {
        const hydrated = await resolveAssetBlobUrl(zip, chapterDir, href, blobUrlCache, createdBlobUrls);
        if (hydrated) {
          el.setAttribute('href', hydrated);
          el.setAttribute('xlink:href', hydrated);
        } else {
          el.removeAttribute('href');
          el.removeAttribute('xlink:href');
        }
      }
    }
  }

  const headingEl = doc.querySelector('h1, h2, h3, title');
  const extractedHeading = headingEl?.textContent?.trim() || undefined;
  const body = doc.body;
  const html = body ? body.innerHTML : rawHtml;
  const plainText = (body?.textContent || '').replace(/\s+/g, ' ').trim();

  return {html, plainText, extractedHeading};
}

async function locateOpfPackage(zip: JSZip, parser: DOMParser): Promise<{
  opfPath: string;
  opfDir: string;
  opfDoc: Document | null;
}> {
  let opfPath = 'OEBPS/content.opf';
  const containerFile = findZipEntry(zip, 'META-INF/container.xml');
  if (containerFile) {
    try {
      const containerXml = await containerFile.async('text');
      const containerDoc = parser.parseFromString(containerXml, 'application/xml');
      const rootfiles = getElementsByLocalName(containerDoc, 'rootfile');
      const fullPath = rootfiles[0]?.getAttribute('full-path');
      if (fullPath) opfPath = fullPath;
    } catch {
      // Fall back to archive scan below
    }
  }

  let opfFile = findZipEntry(zip, opfPath);
  if (!opfFile) {
    // Scan archive for first .opf file regardless of case or subfolder
    for (const [key, entry] of Object.entries(zip.files)) {
      if (!entry.dir && key.toLowerCase().endsWith('.opf')) {
        opfPath = key;
        opfFile = entry;
        break;
      }
    }
  }

  if (!opfFile) {
    return {opfPath, opfDir: '', opfDoc: null};
  }

  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
  const opfXml = await opfFile.async('text');
  const opfDoc = parser.parseFromString(opfXml, 'application/xml');
  return {opfPath, opfDir, opfDoc};
}

interface RawEpubTocEntry {
  title: string;
  href: string;
  fragmentId?: string;
  depth: number;
}

function getDirectChildrenByLocalName(el: Element, localName: string): Element[] {
  const target = localName.toLowerCase();
  return Array.from(el.children).filter(
    (child) => (child.localName || child.nodeName.split(':').pop() || '').toLowerCase() === target,
  );
}

async function buildTocData(
  zip: JSZip,
  parser: DOMParser,
  opfDoc: Document,
  opfDir: string,
  manifest: Map<string, {href: string; mediaType: string; properties: string}>,
): Promise<{tocTitleByHref: Map<string, string>; rawTocEntries: RawEpubTocEntry[]}> {
  const tocTitleByHref = new Map<string, string>();
  const rawTocEntries: RawEpubTocEntry[] = [];

  // 1. EPUB 2 NCX TOC (preserves nested navPoint hierarchy)
  const spineEl = getElementsByLocalName(opfDoc, 'spine')[0];
  const ncxId = spineEl?.getAttribute('toc') || '';
  const ncxEntry =
    (ncxId ? manifest.get(ncxId) : undefined) ||
    Array.from(manifest.values()).find((m) => m.href.toLowerCase().endsWith('.ncx'));

  if (ncxEntry) {
    const ncxFile = findZipEntry(zip, ncxEntry.href);
    if (ncxFile) {
      try {
        const ncxXml = await ncxFile.async('text');
        const ncxDoc = parser.parseFromString(ncxXml, 'application/xml');
        const ncxDir = ncxEntry.href.includes('/') ? ncxEntry.href.slice(0, ncxEntry.href.lastIndexOf('/')) : '';

        const walkNavPoints = (parent: Element, depth: number) => {
          for (const np of getDirectChildrenByLocalName(parent, 'navPoint')) {
            if (rawTocEntries.length >= 250) break;
            const navLabel = getDirectChildrenByLocalName(np, 'navLabel')[0];
            const label = navLabel ? getFirstTextByLocalName(navLabel, 'text') : getFirstTextByLocalName(np, 'text');
            const contentEl = getDirectChildrenByLocalName(np, 'content')[0] || getElementsByLocalName(np, 'content')[0];
            const src = contentEl?.getAttribute('src');
            if (label && src) {
              const decodedSrc = safeDecodeUri(src);
              const [pathPart, fragPart] = decodedSrc.split('#');
              const resolved = resolveEpubPath(ncxDir, pathPart || decodedSrc);
              if (resolved) {
                if (!tocTitleByHref.has(resolved.toLowerCase())) {
                  tocTitleByHref.set(resolved.toLowerCase(), label);
                }
                rawTocEntries.push({
                  title: label,
                  href: resolved,
                  fragmentId: fragPart?.trim() || undefined,
                  depth: Math.min(depth, 5),
                });
              }
            }
            walkNavPoints(np, depth + 1);
          }
        };

        const navMap = getElementsByLocalName(ncxDoc, 'navMap')[0];
        if (navMap) {
          walkNavPoints(navMap, 0);
        }
      } catch {
        // Non-fatal
      }
    }
  }

  // 2. EPUB 3 HTML <nav epub:type="toc"> (prefer nested <ol>/<li> structure if present)
  const navEntry = Array.from(manifest.values()).find((m) =>
    m.properties.toLowerCase().split(/\s+/).includes('nav'),
  );
  if (navEntry) {
    const navFile = findZipEntry(zip, navEntry.href);
    if (navFile) {
      try {
        const navHtml = await navFile.async('text');
        const navDoc = parser.parseFromString(navHtml, 'text/html');
        const navDir = navEntry.href.includes('/') ? navEntry.href.slice(0, navEntry.href.lastIndexOf('/')) : '';
        const navEl =
          navDoc.querySelector('nav[epub\\:type="toc"], nav[role="doc-toc"], nav') || navDoc.body;
        const epub3Entries: RawEpubTocEntry[] = [];

        const walkList = (listEl: Element, depth: number) => {
          for (const li of Array.from(listEl.children).filter((c) => c.tagName.toLowerCase() === 'li')) {
            if (epub3Entries.length >= 250) break;
            const anchor = Array.from(li.children).find((c) => c.tagName.toLowerCase() === 'a') || li.querySelector('a[href]');
            if (anchor) {
              const href = anchor.getAttribute('href');
              const label = anchor.textContent?.replace(/\s+/g, ' ').trim();
              if (href && label) {
                const decodedHref = safeDecodeUri(href);
                const [pathPart, fragPart] = decodedHref.split('#');
                const resolved = resolveEpubPath(navDir, pathPart || navEntry.href);
                if (resolved) {
                  if (!tocTitleByHref.has(resolved.toLowerCase())) {
                    tocTitleByHref.set(resolved.toLowerCase(), label);
                  }
                  epub3Entries.push({
                    title: label,
                    href: resolved,
                    fragmentId: fragPart?.trim() || undefined,
                    depth: Math.min(depth, 5),
                  });
                }
              }
            }
            for (const sub of Array.from(li.children).filter((c) => c.tagName.toLowerCase() === 'ol' || c.tagName.toLowerCase() === 'ul')) {
              walkList(sub, depth + 1);
            }
          }
        };

        const rootList = navEl?.querySelector('ol, ul');
        if (rootList) {
          walkList(rootList, 0);
        }
        if (epub3Entries.length > 0 && rawTocEntries.length === 0) {
          rawTocEntries.push(...epub3Entries);
        }
      } catch {
        // Non-fatal
      }
    }
  }

  void opfDir;
  return {tocTitleByHref, rawTocEntries};
}

async function buildTocTitleMap(
  zip: JSZip,
  parser: DOMParser,
  opfDoc: Document,
  opfDir: string,
  manifest: Map<string, {href: string; mediaType: string; properties: string}>,
): Promise<Map<string, string>> {
  const {tocTitleByHref} = await buildTocData(zip, parser, opfDoc, opfDir, manifest);
  return tocTitleByHref;
}

export async function parseEpubDocument(buffer: ArrayBuffer): Promise<ParsedEpubDocument> {
  const zip = await JSZip.loadAsync(buffer);
  const parser = new DOMParser();
  const createdBlobUrls: string[] = [];
  const blobUrlCache = new Map<string, string>();

  const dispose = () => {
    for (const u of createdBlobUrls) {
      try {
        URL.revokeObjectURL(u);
      } catch {
        // Ignore already revoked
      }
    }
    createdBlobUrls.length = 0;
    blobUrlCache.clear();
  };

  try {
    const {opfDir, opfDoc} = await locateOpfPackage(zip, parser);

    let title: string | undefined;
    let author: string | undefined;
    let language: string | undefined;
    let tocTitleByHref = new Map<string, string>();
    let rawTocEntries: RawEpubTocEntry[] = [];
    let orderedEntries: {id: string; href: string}[] = [];

    if (opfDoc) {
      title = getFirstTextByLocalName(opfDoc, 'title');
      author = getFirstTextByLocalName(opfDoc, 'creator');
      language = getFirstTextByLocalName(opfDoc, 'language');

      const manifest = new Map<string, {href: string; mediaType: string; properties: string}>();
      for (const item of getElementsByLocalName(opfDoc, 'item')) {
        const id = item.getAttribute('id');
        const href = item.getAttribute('href');
        const mediaType = item.getAttribute('media-type') || '';
        const properties = item.getAttribute('properties') || '';
        if (id && href) {
          manifest.set(id, {
            href: resolveEpubPath(opfDir, safeDecodeUri(href)),
            mediaType,
            properties,
          });
        }
      }

      const tocData = await buildTocData(zip, parser, opfDoc, opfDir, manifest);
      tocTitleByHref = tocData.tocTitleByHref;
      rawTocEntries = tocData.rawTocEntries;

      const spineRefs = getElementsByLocalName(opfDoc, 'itemref')
        .map((ref) => ref.getAttribute('idref'))
        .filter((id): id is string => Boolean(id));

      for (const idref of spineRefs) {
        const entry = manifest.get(idref);
        if (entry) orderedEntries.push({id: idref, href: entry.href});
      }

      if (orderedEntries.length === 0) {
        for (const [id, entry] of manifest.entries()) {
          if (
            entry.mediaType.includes('html') ||
            /\.(xhtml|html|htm)$/i.test(entry.href)
          ) {
            orderedEntries.push({id, href: entry.href});
          }
        }
      }
    }

    // Last-resort archive scan for malformed EPUBs missing OPF/spine
    if (orderedEntries.length === 0) {
      const htmlKeys = Object.keys(zip.files)
        .filter((k) => !zip.files[k].dir && /\.(xhtml|html|htm)$/i.test(k) && !/nav\.xhtml$/i.test(k))
        .sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));
      orderedEntries = htmlKeys.map((href, idx) => ({id: `sec_${idx + 1}`, href}));
    }

    const chapters: EpubChapter[] = [];
    for (let i = 0; i < orderedEntries.length; i++) {
      const entry = orderedEntries[i];
      const chapterFile = findZipEntry(zip, entry.href);
      if (!chapterFile) continue;

      const rawHtml = await chapterFile.async('text');
      const {html, plainText, extractedHeading} = await sanitizeAndHydrateChapterHtml(
        rawHtml,
        entry.href,
        zip,
        blobUrlCache,
        createdBlobUrls,
      );

      // Skip totally empty structural wrappers only if non-HTML or 0 text & 0 images
      if (!plainText && !/<img|<svg/i.test(html)) continue;

      const chapterTitle =
        tocTitleByHref.get(entry.href.toLowerCase()) || extractedHeading || `Chapter ${chapters.length + 1}`;

      chapters.push({
        index: chapters.length + 1,
        id: entry.id,
        href: entry.href,
        title: chapterTitle,
        html,
        plainText,
      });

      if (i % 10 === 9) {
        await yieldToMain(0);
      }
    }

    if (chapters.length === 0) {
      throw new Error('EPUB archive contains no readable HTML or XHTML chapters.');
    }

    const chapterByHref = new Map<string, number>();
    for (const ch of chapters) {
      chapterByHref.set(ch.href.toLowerCase(), ch.index);
    }
    const toc: OutlineItem[] = rawTocEntries
      .map((entry): OutlineItem | null => {
        const page = chapterByHref.get(entry.href.toLowerCase());
        if (!page) return null;
        return {
          title: entry.title,
          page,
          depth: entry.depth,
          href: entry.href,
          fragmentId: entry.fragmentId,
        };
      })
      .filter((item): item is OutlineItem => item !== null);

    if (toc.length === 0) {
      for (const ch of chapters) {
        toc.push({title: ch.title, page: ch.index, depth: 0, href: ch.href});
      }
    }

    return {title, author, language, chapters, toc, dispose};
  } catch (err) {
    dispose();
    throw err;
  }
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
  const coverCanvas = document.createElement('canvas');
  try {
    if (opfDoc) {
      const metaEls = getElementsByLocalName(opfDoc, 'meta');
      const metaCoverId = metaEls
        .find((m) => (m.getAttribute('name') || '').toLowerCase() === 'cover')
        ?.getAttribute('content');

      const items = getElementsByLocalName(opfDoc, 'item');
      const coverItem =
        items.find((it) => (it.getAttribute('properties') || '').toLowerCase().split(/\s+/).includes('cover-image')) ||
        (metaCoverId ? items.find((it) => it.getAttribute('id') === metaCoverId) : undefined) ||
        items.find((it) => {
          const id = (it.getAttribute('id') || '').toLowerCase();
          const href = (it.getAttribute('href') || '').toLowerCase();
          const mt = (it.getAttribute('media-type') || '').toLowerCase();
          return mt.startsWith('image/') && (id.includes('cover') || href.includes('cover'));
        });

      const coverHref = coverItem?.getAttribute('href');
      if (coverHref) {
        const resolved = resolveEpubPath(opfDir, safeDecodeUri(coverHref));
        const imgFile = findZipEntry(zip, resolved);
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
            coverCanvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
            coverCanvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
            const ctx = coverCanvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(img, 0, 0, coverCanvas.width, coverCanvas.height);
              return coverCanvas.toDataURL('image/jpeg', 0.78);
            }
          } finally {
            URL.revokeObjectURL(objectUrl);
          }
        }
      }
    }

    coverCanvas.width = 220;
    coverCanvas.height = 310;
    const ctx = coverCanvas.getContext('2d');
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
    return coverCanvas.toDataURL('image/jpeg', 0.78);
  } catch {
    return undefined;
  } finally {
    releaseCanvasMemory(coverCanvas);
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
  const {opfDir, opfDoc} = await locateOpfPackage(zip, parser);

  let title: string | undefined;
  let author: string | undefined;
  let language: string | undefined;
  let tocTitleByHref = new Map<string, string>();
  let spineHrefs: string[] = [];

  if (opfDoc) {
    title = getFirstTextByLocalName(opfDoc, 'title');
    author = getFirstTextByLocalName(opfDoc, 'creator');
    language = getFirstTextByLocalName(opfDoc, 'language');

    const manifest = new Map<string, {href: string; mediaType: string; properties: string}>();
    for (const item of getElementsByLocalName(opfDoc, 'item')) {
      const id = item.getAttribute('id');
      const href = item.getAttribute('href');
      const mediaType = item.getAttribute('media-type') || '';
      const properties = item.getAttribute('properties') || '';
      if (id && href) {
        manifest.set(id, {
          href: resolveEpubPath(opfDir, safeDecodeUri(href)),
          mediaType,
          properties,
        });
      }
    }

    tocTitleByHref = await buildTocTitleMap(zip, parser, opfDoc, opfDir, manifest);
    spineHrefs = getElementsByLocalName(opfDoc, 'itemref')
      .map((ref) => ref.getAttribute('idref'))
      .filter((id): id is string => Boolean(id))
      .map((id) => manifest.get(id)?.href)
      .filter((href): href is string => Boolean(href));

    if (spineHrefs.length === 0) {
      spineHrefs = Array.from(manifest.values())
        .filter((m) => m.mediaType.includes('html') || /\.(xhtml|html|htm)$/i.test(m.href))
        .map((m) => m.href);
    }
  }

  if (spineHrefs.length === 0) {
    spineHrefs = Object.keys(zip.files)
      .filter((k) => !zip.files[k].dir && /\.(xhtml|html|htm)$/i.test(k))
      .sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));
  }

  if (spineHrefs.length === 0) {
    throw new Error('EPUB contains no readable chapters');
  }

  const sampleLimit = maxSampleChapters > 0 ? Math.min(spineHrefs.length, maxSampleChapters) : spineHrefs.length;
  const sampleHrefs = spineHrefs.slice(0, sampleLimit);

  const sampled: {index: number; title: string; plainText: string}[] = [];
  for (let i = 0; i < sampleHrefs.length; i++) {
    const href = sampleHrefs[i];
    const chapterFile = findZipEntry(zip, href);
    const rawHtml = chapterFile ? await chapterFile.async('text') : '';
    const plainText = fastStripHtmlToText(rawHtml);
    const chTitle = tocTitleByHref.get(href.toLowerCase()) || `Chapter ${i + 1}`;
    sampled.push({index: i + 1, title: chTitle, plainText});
    if (i % 8 === 7) await yieldToMain(0);
  }

  const coverDataUrl = includeCover
    ? await extractCoverFromLoadedZip(zip, opfDoc, opfDir, title, author)
    : undefined;

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
    const {opfDir, opfDoc} = await locateOpfPackage(zip, parser);
    return await extractCoverFromLoadedZip(zip, opfDoc, opfDir, fallbackTitle, fallbackAuthor);
  } catch {
    return undefined;
  }
}
