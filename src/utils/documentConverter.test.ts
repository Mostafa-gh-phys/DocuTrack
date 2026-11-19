import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import {
  buildEpubFromSections,
  buildPdfFromSections,
  convertDocumentLocally,
  detectAnyConvertibleFormat,
  parsePlainOrMarkdownSections,
  renderSectionsToHtml,
  renderSectionsToMarkdown,
  renderSectionsToText,
  stripHtmlToParagraphs,
} from './documentConverter';

test('detectAnyConvertibleFormat identifies all supported source extensions', () => {
  assert.equal(detectAnyConvertibleFormat('thesis.PDF'), 'pdf');
  assert.equal(detectAnyConvertibleFormat('novel.epub'), 'epub');
  assert.equal(detectAnyConvertibleFormat('scan.djvu'), 'djvu');
  assert.equal(detectAnyConvertibleFormat('notes.markdown'), 'md');
  assert.equal(detectAnyConvertibleFormat('chapter.htm'), 'html');
  assert.equal(detectAnyConvertibleFormat('draft.txt'), 'txt');
  assert.equal(detectAnyConvertibleFormat('archive.zip'), null);
});

test('parsePlainOrMarkdownSections, stripHtmlToParagraphs, and renderers preserve document hierarchy', () => {
  const md = `# Prologue\n\nFirst paragraph of the journey.\n\n## Chapter One\n\nSecond paragraph begins.\n`;
  const sections = parsePlainOrMarkdownSections(md, 'Fallback');
  assert.equal(sections.length, 2);
  assert.equal(sections[0].title, 'Prologue');
  assert.equal(sections[1].title, 'Chapter One');

  const mdOut = renderSectionsToMarkdown('Odyssey', 'Homer', sections);
  assert.match(mdOut, /# Odyssey/);
  assert.match(mdOut, /## Chapter One/);

  const htmlOut = renderSectionsToHtml('Odyssey', 'Homer', sections);
  assert.match(htmlOut, /<h1>Odyssey<\/h1>/);
  const stripped = stripHtmlToParagraphs(htmlOut);
  assert.equal(stripped.title, 'Odyssey');
  assert.ok(stripped.paragraphs.some((p) => p.includes('First paragraph of the journey.')));

  const txtOut = renderSectionsToText('Odyssey', 'Homer', sections);
  assert.match(txtOut, /ODYSSEY/);
  assert.match(txtOut, /Second paragraph begins\./);
});

test('buildPdfFromSections generates valid multi-line %PDF bytes', async () => {
  const sections = [
    {
      title: 'Chapter 1: Distributed Consensus',
      paragraphs: [
        'Quorum systems remain live as long as a strict majority of replicas acknowledge writes.',
        'Leader leases bound read staleness under bounded clock drift assumptions.',
      ],
    },
  ];
  const {bytes, pageCount} = await buildPdfFromSections('Systems Monograph', 'E. Vance', sections);
  assert.ok(pageCount >= 1);
  const header = new TextDecoder().decode(bytes.slice(0, 5));
  assert.equal(header, '%PDF-');
  assert.ok(bytes.byteLength > 500);
});

test('buildEpubFromSections packages valid EPUB archive with mimetype, OPF, NCX, and XHTML', async () => {
  const sections = [
    {title: 'Part I', paragraphs: ['Opening scene.', 'Second paragraph.']},
    {title: 'Part II', paragraphs: ['Closing scene.']},
  ];
  const {bytes, chapterCount} = await buildEpubFromSections('Short Fiction', 'A. Author', sections);
  assert.equal(chapterCount, 2);

  const zip = await JSZip.loadAsync(bytes);
  assert.equal(await zip.file('mimetype')?.async('string'), 'application/epub+zip');
  assert.ok(zip.file('META-INF/container.xml'));
  const opf = await zip.file('OEBPS/content.opf')?.async('string');
  assert.ok(opf?.includes('<dc:title>Short Fiction</dc:title>'));
  assert.ok(opf?.includes('ch2.xhtml'));
  const ch1 = await zip.file('OEBPS/ch1.xhtml')?.async('string');
  assert.ok(ch1?.includes('Opening scene.'));
});

test('convertDocumentLocally transforms Markdown -> EPUB and HTML -> PDF offline', async () => {
  const mdBytes = new TextEncoder().encode('# Chapter One\n\nOffline conversion works smoothly.\n');
  const epubRes = await convertDocumentLocally({
    sourceBuffer: mdBytes.buffer,
    sourceFormat: 'md',
    targetFormat: 'epub',
    title: 'Sample Notes',
    author: 'Tester',
    baseFilename: 'sample-notes.md',
  });
  assert.equal(epubRes.filename, 'sample-notes.epub');
  assert.equal(epubRes.targetFormat, 'epub');
  const zip = await JSZip.loadAsync(epubRes.bytes);
  assert.ok(zip.file('OEBPS/ch1.xhtml'));

  const htmlBytes = new TextEncoder().encode('<html><body><h1>Web Essay</h1><p>Paragraph one.</p></body></html>');
  const pdfRes = await convertDocumentLocally({
    sourceBuffer: htmlBytes.buffer,
    sourceFormat: 'html',
    targetFormat: 'pdf',
    title: 'Web Essay',
    author: 'Tester',
    baseFilename: 'essay.html',
  });
  assert.equal(pdfRes.filename, 'essay.pdf');
  assert.equal(new TextDecoder().decode(pdfRes.bytes.slice(0, 5)), '%PDF-');
});
