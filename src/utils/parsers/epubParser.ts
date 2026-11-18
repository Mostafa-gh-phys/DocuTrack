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
