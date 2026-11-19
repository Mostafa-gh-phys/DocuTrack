import JSZip from 'jszip';
import {PDFDocument, StandardFonts, rgb} from 'pdf-lib';
import type {BookFormat, ScanEnhanceSettings} from '../types/library';
import {openDjvuDocument, renderDjvuPageToCanvas} from './parsers/djvuParser';
import {parseEpubDocument} from './parsers/epubParser';
import {extractPdfOutlineAndMeta, extractPdfPageTextRange, loadPdfDocument} from './parsers/pdfParser';
import {applyScanEnhancementToCanvas, getScanPresetSettings} from './scanEnhance';

export type ConvertibleSourceFormat = BookFormat | 'txt' | 'md' | 'html';
export type ConvertibleTargetFormat = 'pdf' | 'epub' | 'md' | 'html' | 'txt';

export interface DocumentSection {
  title: string;
  paragraphs: string[];
}

export interface LocalConversionResult {
  filename: string;
  targetFormat: ConvertibleTargetFormat;
  mimeType: string;
  bytes: Uint8Array;
  pageOrChapterCount: number;
  summaryNote: string;
}

export function detectAnyConvertibleFormat(filename: string): ConvertibleSourceFormat | null {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = filename.slice(dot + 1).toLowerCase();
  if (ext === 'pdf' || ext === 'epub' || ext === 'djvu' || ext === 'txt' || ext === 'html' || ext === 'htm') {
    return ext === 'htm' ? 'html' : ext;
  }
  if (ext === 'md' || ext === 'markdown') return 'md';
  return null;
}

export function stripHtmlToParagraphs(rawHtml: string): {title?: string; paragraphs: string[]} {
  const cleanTitleMatch = rawHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const headingMatch = rawHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = (headingMatch?.[1] || cleanTitleMatch?.[1] || '').replace(/<[^>]+>/g, '').trim() || undefined;

  const withoutScripts = rawHtml
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  const normalized = withoutScripts
    .replace(/<\/(p|div|h1|h2|h3|h4|li|blockquote|br)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"');

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  return {title, paragraphs};
}

export function parsePlainOrMarkdownSections(rawText: string, fallbackTitle: string): DocumentSection[] {
  const lines = rawText.replace(/\r\n/g, '\n').split('\n');
  const sections: DocumentSection[] = [];
  let current: DocumentSection = {title: fallbackTitle, paragraphs: []};
  let buffer: string[] = [];

  const flushPara = () => {
    const joined = buffer.join(' ').replace(/\s+/g, ' ').trim();
    if (joined) current.paragraphs.push(joined);
    buffer = [];
  };

  for (const line of lines) {
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      flushPara();
      if (current.paragraphs.length > 0) sections.push(current);
      current = {title: heading[1].trim(), paragraphs: []};
      continue;
    }
    if (line.trim() === '') {
      flushPara();
    } else {
      buffer.push(line.replace(/^[-*+]\s+/, '• ').trim());
    }
  }
  flushPara();
  if (current.paragraphs.length > 0 || sections.length === 0) {
    sections.push(current);
  }
  return sections;
}

export function renderSectionsToMarkdown(title: string, author: string, sections: DocumentSection[]): string {
  const lines: string[] = [`# ${title}`, `*By ${author}*`, ''];
  for (const sec of sections) {
    lines.push(`## ${sec.title}`, '');
    for (const para of sec.paragraphs) {
      lines.push(para, '');
    }
  }
  return lines.join('\n').trim() + '\n';
}

export function renderSectionsToText(title: string, author: string, sections: DocumentSection[]): string {
  const lines: string[] = [title.toUpperCase(), `Author: ${author}`, '='.repeat(48), ''];
  for (const sec of sections) {
    lines.push(sec.title, '-'.repeat(Math.min(40, sec.title.length)), '');
    for (const para of sec.paragraphs) {
      lines.push(para, '');
    }
  }
  return lines.join('\n').trim() + '\n';
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderSectionsToHtml(title: string, author: string, sections: DocumentSection[]): string {
  const body = sections
    .map(
      (sec) => `
    <section>
      <h2>${escapeXml(sec.title)}</h2>
      ${sec.paragraphs.map((p) => `<p>${escapeXml(p)}</p>`).join('\n      ')}
    </section>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeXml(title)}</title>
  <style>
    body { max-width: 68ch; margin: 3rem auto; padding: 0 1.5rem; font-family: Georgia, serif; line-height: 1.72; color: #1f2937; background: #fdfcf8; }
    header { margin-bottom: 2.5rem; border-bottom: 1px solid #e5e7eb; padding-bottom: 1.25rem; }
    h1 { font-size: 2rem; margin: 0 0 0.4rem; }
    .author { color: #6b7280; font-style: italic; margin: 0; }
    h2 { margin-top: 2.25rem; font-size: 1.3rem; }
    p { margin: 0 0 1rem; text-align: justify; }
  </style>
</head>
<body>
  <header>
    <h1>${escapeXml(title)}</h1>
    <p class="author">${escapeXml(author)}</p>
  </header>
  ${body}
</body>
</html>`;
}

function toAsciiSafePdfText(input: string): string {
  return input
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[^\x20-\x7E]/g, ' ');
}

export async function buildPdfFromSections(
  title: string,
  author: string,
  sections: DocumentSection[],
): Promise<{bytes: Uint8Array; pageCount: number}> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(toAsciiSafePdfText(title));
  pdfDoc.setAuthor(toAsciiSafePdfText(author));
  pdfDoc.setCreator('DocuTrack Local Converter');

  const bodyFont = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const boldFont = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);

  const pageWidth = 612; // US Letter
  const pageHeight = 792;
  const marginX = 64;
  const marginTop = 68;
  const marginBottom = 60;
  const usableWidth = pageWidth - marginX * 2;
  const fontSize = 11.5;
  const lineHeight = 17.5;

  let page = pdfDoc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - marginTop;

  const ensureSpace = (needed: number) => {
    if (y - needed < marginBottom) {
      page = pdfDoc.addPage([pageWidth, pageHeight]);
      y = pageHeight - marginTop;
    }
  };

  const wrapWords = (text: string, font: typeof bodyFont, size: number): string[] => {
    const safe = toAsciiSafePdfText(text);
    const words = safe.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) > usableWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
    return lines;
  };

  // Document Cover Title Header on Page 1
  const titleLines = wrapWords(title, boldFont, 20);
  for (const tl of titleLines) {
    ensureSpace(26);
    page.drawText(tl, {x: marginX, y, size: 20, font: boldFont, color: rgb(0.08, 0.1, 0.15)});
    y -= 26;
  }
  ensureSpace(24);
  page.drawText(toAsciiSafePdfText(`By ${author}`), {
    x: marginX,
    y,
    size: 12,
    font: bodyFont,
    color: rgb(0.35, 0.4, 0.48),
  });
  y -= 28;

  for (const section of sections) {
    ensureSpace(40);
    const headingLines = wrapWords(section.title, boldFont, 14);
    for (const hl of headingLines) {
      ensureSpace(22);
      page.drawText(hl, {x: marginX, y, size: 14, font: boldFont, color: rgb(0.1, 0.14, 0.22)});
      y -= 20;
    }
    y -= 6;

    for (const para of section.paragraphs) {
      const lines = wrapWords(para, bodyFont, fontSize);
      for (const line of lines) {
        ensureSpace(lineHeight);
        page.drawText(line, {x: marginX, y, size: fontSize, font: bodyFont, color: rgb(0.12, 0.14, 0.18)});
        y -= lineHeight;
      }
      y -= 8;
    }
    y -= 8;
  }

  // Stamp running page numbers at bottom center
  const pages = pdfDoc.getPages();
  pages.forEach((p, idx) => {
    const label = `${idx + 1} / ${pages.length}`;
    const labelWidth = bodyFont.widthOfTextAtSize(label, 9.5);
    p.drawText(label, {
      x: (pageWidth - labelWidth) / 2,
      y: 28,
      size: 9.5,
      font: bodyFont,
      color: rgb(0.45, 0.5, 0.56),
    });
  });

  const bytes = await pdfDoc.save();
  return {bytes, pageCount: pages.length};
}

export async function buildEpubFromSections(
  title: string,
  author: string,
  sections: DocumentSection[],
): Promise<{bytes: Uint8Array; chapterCount: number}> {
  const zip = new JSZip();
  const bookUid = `docutrack-${Date.now()}`;
  const validSections = sections.length > 0 ? sections : [{title, paragraphs: ['Empty document.']}];

  zip.file('mimetype', 'application/epub+zip', {compression: 'STORE'});
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
  );

  zip.file(
    'OEBPS/styles.css',
    `body { font-family: Georgia, serif; line-height: 1.7; margin: 1.5em; color: #1f2937; }
h1 { font-size: 1.55em; margin-bottom: 0.7em; }
p { text-indent: 1.4em; margin: 0 0 0.9em; text-align: justify; }
p.first { text-indent: 0; }`,
  );

  const manifestItems = validSections
    .map((_, idx) => `<item id="ch${idx + 1}" href="ch${idx + 1}.xhtml" media-type="application/xhtml+xml"/>`)
    .join('\n    ');
  const spineItems = validSections.map((_, idx) => `<itemref idref="ch${idx + 1}"/>`).join('\n    ');

  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:creator>${escapeXml(author)}</dc:creator>
    <dc:language>en</dc:language>
    <dc:identifier id="BookId">${bookUid}</dc:identifier>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="styles.css" media-type="text/css"/>
    ${manifestItems}
  </manifest>
  <spine toc="ncx">
    ${spineItems}
  </spine>
</package>`,
  );

  const navPoints = validSections
    .map(
      (sec, idx) => `
    <navPoint id="nav-${idx + 1}" playOrder="${idx + 1}">
      <navLabel><text>${escapeXml(sec.title)}</text></navLabel>
      <content src="ch${idx + 1}.xhtml"/>
    </navPoint>`,
    )
    .join('');

  zip.file(
    'OEBPS/toc.ncx',
    `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="${bookUid}"/></head>
  <docTitle><text>${escapeXml(title)}</text></docTitle>
  <navMap>${navPoints}</navMap>
</ncx>`,
  );

  validSections.forEach((sec, idx) => {
    const parasHtml = sec.paragraphs
      .map((p, pIdx) => `<p${pIdx === 0 ? ' class="first"' : ''}>${escapeXml(p)}</p>`)
      .join('\n    ');

    zip.file(
      `OEBPS/ch${idx + 1}.xhtml`,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
  <head>
    <title>${escapeXml(sec.title)}</title>
    <link rel="stylesheet" type="text/css" href="styles.css"/>
  </head>
  <body>
    <h1>${escapeXml(sec.title)}</h1>
    ${parasHtml}
  </body>
</html>`,
    );
  });

  const bytes = await zip.generateAsync({type: 'uint8array'});
  return {bytes, chapterCount: validSections.length};
}

function splitLongTextToParagraphs(text: string): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  const rawParas = clean.split(/\n{2,}/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (rawParas.length > 1) return rawParas;

  // For flat extracted PDF text blocks, chunk cleanly by ~420-char sentence groups
  const sentences = clean.split(/(?<=[.!?])\s+/);
  const grouped: string[] = [];
  let acc = '';
  for (const s of sentences) {
    if ((acc + ' ' + s).length > 420 && acc) {
      grouped.push(acc.trim());
      acc = s;
    } else {
      acc = (acc ? `${acc} ` : '') + s;
    }
  }
  if (acc.trim()) grouped.push(acc.trim());
  return grouped;
}

export async function convertDocumentLocally(options: {
  sourceBuffer: ArrayBuffer;
  sourceFormat: ConvertibleSourceFormat;
  targetFormat: ConvertibleTargetFormat;
  title: string;
  author: string;
  baseFilename: string;
  cleanScannedImages?: boolean;
  onProgress?: (status: string) => void;
}): Promise<LocalConversionResult> {
  const {
    sourceBuffer,
    sourceFormat,
    targetFormat,
    title,
    author,
    baseFilename,
    cleanScannedImages = true,
    onProgress,
  } = options;

  const cleanStem = baseFilename.replace(/\.(pdf|epub|djvu|txt|md|markdown|html|htm)$/i, '') || 'converted';
  const outExt = targetFormat;
  const outFilename = `${cleanStem}.${outExt}`;

  // Special high-fidelity raster/hybrid DjVu -> PDF converter path
  if (sourceFormat === 'djvu' && targetFormat === 'pdf') {
    onProgress?.('Decoding DjVu pages & optimizing bitmaps...');
    const djvuDoc = await openDjvuDocument(sourceBuffer);
    const total = Math.max(1, djvuDoc.page_count());
    const pdfDoc = await PDFDocument.create();
    pdfDoc.setTitle(toAsciiSafePdfText(title));
    pdfDoc.setAuthor(toAsciiSafePdfText(author));
    pdfDoc.setCreator('DocuTrack DjVu->PDF Converter');

    const textSections: DocumentSection[] = [];
    const scanPreset: ScanEnhanceSettings = cleanScannedImages
      ? getScanPresetSettings('clean-scan')
      : getScanPresetSettings('original');

    for (let p = 1; p <= total; p++) {
      onProgress?.(`Rendering page ${p} of ${total}...`);
      const canvas = document.createElement('canvas');
      const rendered = renderDjvuPageToCanvas(djvuDoc, p, canvas, 175);

      if (!rendered.isBlankBitmap) {
        if (cleanScannedImages) {
          applyScanEnhancementToCanvas(canvas, scanPreset);
        }
        const jpgDataUrl = canvas.toDataURL('image/jpeg', 0.88);
        const base64 = jpgDataUrl.split(',')[1] || '';
        const binStr = atob(base64);
        const jpgBytes = new Uint8Array(binStr.length);
        for (let i = 0; i < binStr.length; i++) jpgBytes[i] = binStr.charCodeAt(i);
        const img = await pdfDoc.embedJpg(jpgBytes);
        const page = pdfDoc.addPage([rendered.width, rendered.height]);
        page.drawImage(img, {x: 0, y: 0, width: rendered.width, height: rendered.height});
      } else {
        textSections.push({
          title: `Page ${p}`,
          paragraphs: splitLongTextToParagraphs(rendered.text || `${title} — Page ${p}`),
        });
      }
    }

    if (pdfDoc.getPageCount() === 0 && textSections.length > 0) {
      const built = await buildPdfFromSections(title, author, textSections);
      return {
        filename: outFilename,
        targetFormat,
        mimeType: 'application/pdf',
        bytes: built.bytes,
        pageOrChapterCount: built.pageCount,
        summaryNote: `Converted archival DjVu text (${total} pages) to clean vector PDF (${built.pageCount} pages).`,
      };
    }

    const bytes = await pdfDoc.save();
    return {
      filename: outFilename,
      targetFormat,
      mimeType: 'application/pdf',
      bytes,
      pageOrChapterCount: pdfDoc.getPageCount(),
      summaryNote: `Converted ${pdfDoc.getPageCount()} DjVu pages to PDF${cleanScannedImages ? ' with Clean Scan enhancement' : ''}.`,
    };
  }

  // Extract normalized DocumentSections from any source format
  onProgress?.('Extracting structured chapters & text...');
  let resolvedTitle = title;
  let resolvedAuthor = author;
  let sections: DocumentSection[] = [];

  if (sourceFormat === 'pdf') {
    const doc = await loadPdfDocument(sourceBuffer);
    const [meta, pageTexts] = await Promise.all([
      extractPdfOutlineAndMeta(doc),
      extractPdfPageTextRange(doc, 1, doc.numPages),
    ]);
    if (meta.title) resolvedTitle = meta.title;
    if (meta.author) resolvedAuthor = meta.author;
    const outlineByPage = new Map(meta.outline.map((o) => [o.page, o.title]));
    sections = pageTexts.map((pt) => ({
      title: outlineByPage.get(pt.page) || `Page ${pt.page}`,
      paragraphs: splitLongTextToParagraphs(pt.text || `[Page ${pt.page} contains scanned artwork without OCR text]`),
    }));
  } else if (sourceFormat === 'epub') {
    const parsed = await parseEpubDocument(sourceBuffer);
    if (parsed.title) resolvedTitle = parsed.title;
    if (parsed.author) resolvedAuthor = parsed.author;
    sections = parsed.chapters.map((ch) => {
      const extracted = stripHtmlToParagraphs(ch.html);
      return {
        title: ch.title,
        paragraphs: extracted.paragraphs.length > 0 ? extracted.paragraphs : splitLongTextToParagraphs(ch.plainText),
      };
    });
  } else if (sourceFormat === 'djvu') {
    const doc = await openDjvuDocument(sourceBuffer);
    const count = Math.max(1, doc.page_count());
    for (let p = 1; p <= count; p++) {
      const text = doc.page(p - 1).text() || '';
      sections.push({
        title: `Page ${p}`,
        paragraphs: splitLongTextToParagraphs(text || `[DjVu page ${p} image layer]`),
      });
    }
  } else {
    const raw = new TextDecoder('utf-8').decode(sourceBuffer);
    if (sourceFormat === 'html') {
      const parsed = stripHtmlToParagraphs(raw);
      if (parsed.title) resolvedTitle = parsed.title;
      sections = [{title: resolvedTitle, paragraphs: parsed.paragraphs}];
    } else {
      sections = parsePlainOrMarkdownSections(raw, resolvedTitle);
    }
  }

  onProgress?.(`Building ${targetFormat.toUpperCase()} output...`);

  if (targetFormat === 'pdf') {
    const {bytes, pageCount} = await buildPdfFromSections(resolvedTitle, resolvedAuthor, sections);
    return {
      filename: outFilename,
      targetFormat,
      mimeType: 'application/pdf',
      bytes,
      pageOrChapterCount: pageCount,
      summaryNote: `Generated ${pageCount}-page paginated PDF locally with embedded typography.`,
    };
  }

  if (targetFormat === 'epub') {
    const {bytes, chapterCount} = await buildEpubFromSections(resolvedTitle, resolvedAuthor, sections);
    return {
      filename: outFilename,
      targetFormat,
      mimeType: 'application/epub+zip',
      bytes,
      pageOrChapterCount: chapterCount,
      summaryNote: `Packaged reflowable EPUB with ${chapterCount} chapter${chapterCount > 1 ? 's' : ''} and NCX navigation.`,
    };
  }

  if (targetFormat === 'md') {
    const md = renderSectionsToMarkdown(resolvedTitle, resolvedAuthor, sections);
    return {
      filename: outFilename,
      targetFormat,
      mimeType: 'text/markdown;charset=utf-8',
      bytes: new TextEncoder().encode(md),
      pageOrChapterCount: sections.length,
      summaryNote: `Exported structured Markdown with ${sections.length} sections.`,
    };
  }

  if (targetFormat === 'html') {
    const html = renderSectionsToHtml(resolvedTitle, resolvedAuthor, sections);
    return {
      filename: outFilename,
      targetFormat,
      mimeType: 'text/html;charset=utf-8',
      bytes: new TextEncoder().encode(html),
      pageOrChapterCount: sections.length,
      summaryNote: `Built self-contained semantic HTML edition (${sections.length} sections).`,
    };
  }

  const txt = renderSectionsToText(resolvedTitle, resolvedAuthor, sections);
  return {
    filename: outFilename,
    targetFormat: 'txt',
    mimeType: 'text/plain;charset=utf-8',
    bytes: new TextEncoder().encode(txt),
    pageOrChapterCount: sections.length,
    summaryNote: `Extracted clean UTF-8 plain text across ${sections.length} sections.`,
  };
}
