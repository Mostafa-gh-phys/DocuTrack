import JSZip from 'jszip';
import type {Annotation, BookMetadata, DocumentTextChunk} from '../types/library';

function buildMinimalPdfBytes(title: string, author: string, pages: {heading: string; paragraphs: string[]}[]): Uint8Array {
  const escapePdfStr = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

  const wrapLines = (text: string, maxChars: number): string[] => {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
      if ((current + ' ' + word).trim().length > maxChars) {
        if (current) lines.push(current);
        current = word;
      } else {
        current = (current + ' ' + word).trim();
      }
    }
    if (current) lines.push(current);
    return lines;
  };

  // Objects:
  // 1: Catalog, 2: Pages, 3: Font (Helvetica), 4: Font-Bold, then per page: pageObj, contentObj
  const objects: string[] = [];
  const pageIds: number[] = [];

  let nextId = 5;
  const pageContents: {pageObjId: number; contentObjId: number; stream: string}[] = [];

  pages.forEach((p, idx) => {
    const pageObjId = nextId++;
    const contentObjId = nextId++;
    pageIds.push(pageObjId);

    const commands: string[] = ['BT'];
    let y = 740;
    commands.push(`/F2 16 Tf`);
    commands.push(`72 ${y} Td (${escapePdfStr(p.heading)}) Tj`);
    y -= 28;
    commands.push(`/F1 11 Tf`);

    let prevY = y + 28;
    const moveTo = (targetY: number) => {
      const dy = targetY - prevY;
      prevY = targetY;
      return `0 ${dy} Td`;
    };

    for (const para of p.paragraphs) {
      const lines = wrapLines(para, 76);
      for (const line of lines) {
        if (y < 76) break;
        commands.push(`${moveTo(y)} (${escapePdfStr(line)}) Tj`);
        y -= 16;
      }
      y -= 10;
    }

    // Footer page number
    commands.push(`${moveTo(42)} (${escapePdfStr(`${title} — Page ${idx + 1} of ${pages.length}`)}) Tj`);
    commands.push('ET');
    const stream = commands.join('\n');
    pageContents.push({pageObjId, contentObjId, stream});
  });

  objects[1] = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`;
  objects[2] = `2 0 obj\n<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>\nendobj\n`;
  objects[3] = `3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`;
  objects[4] = `4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n`;

  for (const pc of pageContents) {
    objects[pc.pageObjId] =
      `${pc.pageObjId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pc.contentObjId} 0 R >>\nendobj\n`;
    objects[pc.contentObjId] =
      `${pc.contentObjId} 0 obj\n<< /Length ${pc.stream.length} >>\nstream\n${pc.stream}\nendstream\nendobj\n`;
  }

  const infoId = nextId++;
  objects[infoId] =
    `${infoId} 0 obj\n<< /Title (${escapePdfStr(title)}) /Author (${escapePdfStr(author)}) >>\nendobj\n`;

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (let i = 1; i < nextId; i++) {
    offsets[i] = pdf.length;
    pdf += objects[i];
  }
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${nextId}\n0000000000 65535 f \n`;
  for (let i = 1; i < nextId; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${nextId} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return new TextEncoder().encode(pdf);
}

async function buildMinimalEpubBytes(
  id: string,
  title: string,
  author: string,
  chapters: {id: string; title: string; paragraphs: string[]}[],
): Promise<Uint8Array> {
  const zip = new JSZip();
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

  const manifestItems = chapters
    .map((ch) => `<item id="${ch.id}" href="${ch.id}.xhtml" media-type="application/xhtml+xml"/>`)
    .join('\n    ');
  const spineItems = chapters.map((ch) => `<itemref idref="${ch.id}"/>`).join('\n    ');

  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${title}</dc:title>
    <dc:creator>${author}</dc:creator>
    <dc:language>en</dc:language>
    <dc:identifier id="BookId">${id}</dc:identifier>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    ${manifestItems}
  </manifest>
  <spine toc="ncx">
    ${spineItems}
  </spine>
</package>`,
  );

  const navPoints = chapters
    .map(
      (ch, i) => `
    <navPoint id="nav-${i + 1}" playOrder="${i + 1}">
      <navLabel><text>${ch.title}</text></navLabel>
      <content src="${ch.id}.xhtml"/>
    </navPoint>`,
    )
    .join('');

  zip.file(
    'OEBPS/toc.ncx',
    `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="${id}"/></head>
  <docTitle><text>${title}</text></docTitle>
  <navMap>${navPoints}</navMap>
</ncx>`,
  );

  for (const ch of chapters) {
    const bodyHtml = ch.paragraphs.map((p) => `<p>${p}</p>`).join('\n    ');
    zip.file(
      `OEBPS/${ch.id}.xhtml`,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
  <head><title>${ch.title}</title></head>
  <body>
    <h1>${ch.title}</h1>
    ${bodyHtml}
  </body>
</html>`,
    );
  }

  return await zip.generateAsync({type: 'uint8array'});
}

function buildMinimalDjvuBytes(text: string): Uint8Array {
  const encoder = new TextEncoder();
  const txtBytes = encoder.encode(text);

  const iffChunk = (id: string, data: Uint8Array): Uint8Array => {
    const pad = data.length % 2 === 1 ? 1 : 0;
    const out = new Uint8Array(8 + data.length + pad);
    out.set(encoder.encode(id), 0);
    const dv = new DataView(out.buffer);
    dv.setUint32(4, data.length, false);
    out.set(data, 8);
    return out;
  };

  // INFO chunk (680x920, 150 DPI)
  const info = new Uint8Array(10);
  const infoView = new DataView(info.buffer);
  infoView.setUint16(0, 680, false);
  infoView.setUint16(2, 920, false);
  info[4] = 24;
  info[5] = 0;
  infoView.setUint16(6, 150, true);
  info[8] = 22;
  info[9] = 1;

  // TXTa chunk
  const txta = new Uint8Array(3 + txtBytes.length + 1);
  txta[0] = (txtBytes.length >> 16) & 0xff;
  txta[1] = (txtBytes.length >> 8) & 0xff;
  txta[2] = txtBytes.length & 0xff;
  txta.set(txtBytes, 3);
  txta[3 + txtBytes.length] = 1;

  const infoChunk = iffChunk('INFO', info);
  const txtChunk = iffChunk('TXTa', txta);
  const magicDjvu = encoder.encode('DJVU');
  const bodyLen = magicDjvu.length + infoChunk.length + txtChunk.length;

  const full = new Uint8Array(12 + bodyLen);
  full.set(encoder.encode('AT&TFORM'), 0);
  new DataView(full.buffer).setUint32(8, bodyLen, false);
  let offset = 12;
  full.set(magicDjvu, offset);
  offset += magicDjvu.length;
  full.set(infoChunk, offset);
  offset += infoChunk.length;
  full.set(txtChunk, offset);

  return full;
}

export interface SeedLibraryBundle {
  books: BookMetadata[];
  binaries: Record<string, ArrayBuffer>;
  annotations: Annotation[];
  textChunks: DocumentTextChunk[];
}

export async function createSeedLibraryBundle(): Promise<SeedLibraryBundle> {
  const now = Date.now();

  // 1. PDF Seed Book
  const pdfPages = [
    {
      heading: 'Chapter 1: Consensus Under Partial Synchrony',
      paragraphs: [
        'Distributed systems achieve reliability not by preventing individual node failures, but by ensuring state replication remains linearizable despite network partitions and asymmetric delays.',
        'In leader-based consensus protocols such as Raft and Multi-Paxos, safety guarantees rely on strict quorum intersection. Any two majorities share at least one voting replica that preserves committed log prefixes across leadership terms.',
        'Heartbeats and randomized election timeouts break symmetry during split-vote conditions, allowing clusters to recover liveness quickly once network connectivity stabilizes.',
      ],
    },
    {
      heading: 'Chapter 2: Snapshotting & Log Compaction',
      paragraphs: [
        'Unbounded write-ahead logs eventually exhaust local storage and prolong cold-start recovery. Periodic state machine snapshots capture deterministic checkpoints up to an applied index.',
        'Copy-on-write memory pages or immutable B-trees allow background threads to serialize snapshots to disk without stalling foreground client writes.',
      ],
    },
    {
      heading: 'Chapter 3: Bounded Tail Latency & Hedged Requests',
      paragraphs: [
        'Even when average service latency sits below ten milliseconds, fan-out architectures amplify p99 tail latency. Hedged requests dispatch a secondary read after a tight percentile delay, canceling the slower replica once the first response arrives.',
      ],
    },
  ];
  const pdfBytes = buildMinimalPdfBytes('Designing Reliable Distributed Systems', 'Elena Vance', pdfPages);

  // 2. EPUB Seed Book 1
  const epub1Chapters = [
    {
      id: 'ch1',
      title: '1. Proportion, Measure & Rhythm',
      paragraphs: [
        'Typography exists to honor content. Before choosing a typeface or decorative rule, a designer establishes a comfortable measure—typically between sixty and seventy-five characters per line—so the reader eye travels effortlessly from line to line.',
        'Line height, historically termed leading, opens breathing room between ascenders and descenders. In long-form digital reading, a ratio between 1.55 and 1.75 prevents visual crowding across sustained sessions.',
      ],
    },
    {
      id: 'ch2',
      title: '2. Optical Contrast & Reading Surfaces',
      paragraphs: [
        'Pure white (#FFFFFF) paired with pitch black (#000000) creates excessive luminance glare on backlit LCD and OLED panels. Warm paper tones and deep charcoal inks reduce halation while preserving crisp letterform edges.',
        'Night reading themes require delicate weight compensation: light text on dark slate appears slightly thinner optically, making modest letter-spacing and warmer slate surfaces essential for fatigue-free study.',
      ],
    },
    {
      id: 'ch3',
      title: '3. Structural Hierarchy & Tabular Figures',
      paragraphs: [
        'When documents juxtapose prose with indices, page numbers, and metrics, tabular numerals align columns vertically without horizontal jitter. Clean typographic hierarchy relies on scale and whitespace rather than heavy borders.',
      ],
    },
  ];
  const epub1Bytes = await buildMinimalEpubBytes(
    'seed-epub-typography',
    'The Elements of Digital Typography',
    'Martin Bringhurst',
    epub1Chapters,
  );

  // 3. DjVu Seed Book
  const djvuText = [
    'CHAPTER 1: FOUNDATIONS OF OPTICAL & SIGNAL THEORY',
    '',
    '1.1 Wave Interference & Spectral Decomposition',
    'Coherent wavefields exhibit constructive and destructive interference governed by phase difference and optical path length. Jean-Baptiste Joseph Fourier demonstrated that arbitrary periodic waveforms decompose into orthogonal sinusoidal harmonics.',
    '',
    '1.2 Sampling Theorem & Aliasing Bounds',
    'To reconstruct a band-limited continuous signal without aliasing distortion, the discrete sampling rate must exceed twice the highest frequency component present in the spectrum (the Nyquist criterion).',
    '',
    '1.3 Archival Document Compression with DjVu',
    'DjVu separates scanned manuscripts into a high-resolution bi-level foreground mask (JB2) for crisp typography and a lower-resolution wavelet background layer (IW44) for paper texture and illustrations, achieving 5x to 10x smaller files than uncompressed bitmaps.',
  ].join('\n');
  const djvuBytes = buildMinimalDjvuBytes(djvuText);

  // 4. EPUB Seed Book 2
  const epub2Chapters = [
    {
      id: 'ch1',
      title: '1. Cognitive Patience & Deep Reading',
      paragraphs: [
        'Deep reading is not passive decoding; it is an active synthesis of inference, analogical reasoning, and critical reflection. Rapid skimming trains pattern spotting at the expense of sustained contemplative comprehension.',
        'Distraction-free reading environments protect working memory by stripping away notification badges, chrome clutter, and competing navigation bars, allowing the mind to inhabit an author’s argument.',
      ],
    },
    {
      id: 'ch2',
      title: '2. Marginalia as Externalized Memory',
      paragraphs: [
        'For centuries, scholars conversed with books in the margins. Modern digital annotations bridge ephemeral highlighting with structured synthesis—turning isolated quotes into searchable study courses and interconnected notes.',
      ],
    },
  ];
  const epub2Bytes = await buildMinimalEpubBytes(
    'seed-epub-cognition',
    'Attention, Memory & Deep Reading',
    'Dr. Clara Lindqvist',
    epub2Chapters,
  );

  const books: BookMetadata[] = [
    {
      id: 'seed_pdf_systems',
      ownerId: 'local',
      title: 'Designing Reliable Distributed Systems',
      author: 'Elena Vance',
      format: 'pdf',
      folderPath: '/Computer Science/Distributed Systems',
      fileSize: pdfBytes.byteLength,
      pageCount: pdfPages.length,
      currentPage: 2,
      progress: 67,
      isFavorite: true,
      offlinePinned: true,
      tags: ['consensus', 'raft', 'reliability'],
      coverUrl: '/src/assets/images/cover_distributed_systems_1794990749995.jpg',
      excerpt: pdfPages[0].paragraphs[0],
      language: 'English',
      addedAt: now - 86400000 * 5,
      lastOpenedAt: now - 3600000 * 2,
      updatedAtMs: now - 3600000 * 2,
    },
    {
      id: 'seed_epub_typography',
      ownerId: 'local',
      title: 'The Elements of Digital Typography',
      author: 'Martin Bringhurst',
      format: 'epub',
      folderPath: '/Design/Editorial Craft',
      fileSize: epub1Bytes.byteLength,
      pageCount: epub1Chapters.length,
      currentPage: 1,
      progress: 33,
      isFavorite: true,
      offlinePinned: true,
      tags: ['typography', 'layout', 'reading'],
      coverUrl: '/src/assets/images/cover_typography_craft_1794990750250.jpg',
      excerpt: epub1Chapters[0].paragraphs[0],
      language: 'English',
      addedAt: now - 86400000 * 3,
      lastOpenedAt: now - 3600000 * 8,
      updatedAtMs: now - 3600000 * 8,
    },
    {
      id: 'seed_djvu_optics',
      ownerId: 'local',
      title: 'Foundations of Optical & Signal Theory',
      author: 'H. K. Lindholm',
      format: 'djvu',
      folderPath: '/Physics/Signal Archives',
      fileSize: djvuBytes.byteLength,
      pageCount: 1,
      currentPage: 1,
      progress: 100,
      isFavorite: false,
      offlinePinned: true,
      tags: ['optics', 'fourier', 'djvu'],
      coverUrl: '/src/assets/images/cover_signal_processing_1794990749873.jpg',
      excerpt: 'Coherent wavefields exhibit constructive and destructive interference governed by phase difference.',
      language: 'English',
      addedAt: now - 86400000 * 2,
      lastOpenedAt: now - 86400000,
      updatedAtMs: now - 86400000,
    },
    {
      id: 'seed_epub_cognition',
      ownerId: 'local',
      title: 'Attention, Memory & Deep Reading',
      author: 'Dr. Clara Lindqvist',
      format: 'epub',
      folderPath: '/Cognitive Science/Essays',
      fileSize: epub2Bytes.byteLength,
      pageCount: epub2Chapters.length,
      currentPage: 1,
      progress: 50,
      isFavorite: false,
      offlinePinned: false,
      tags: ['cognition', 'marginalia', 'focus'],
      coverUrl: '/src/assets/images/cover_cognitive_architecture_1794990751259.jpg',
      excerpt: epub2Chapters[0].paragraphs[0],
      language: 'English',
      addedAt: now - 86400000,
      lastOpenedAt: now - 3600000 * 14,
      updatedAtMs: now - 3600000 * 14,
    },
  ];

  const toBuffer = (u8: Uint8Array): ArrayBuffer => {
    const copy = new Uint8Array(u8.byteLength);
    copy.set(u8);
    return copy.buffer;
  };

  const binaries: Record<string, ArrayBuffer> = {
    seed_pdf_systems: toBuffer(pdfBytes),
    seed_epub_typography: toBuffer(epub1Bytes),
    seed_djvu_optics: toBuffer(djvuBytes),
    seed_epub_cognition: toBuffer(epub2Bytes),
  };

  const annotations: Annotation[] = [
    {
      id: 'ann_seed_1',
      ownerId: 'local',
      bookId: 'seed_pdf_systems',
      page: 1,
      chapterTitle: 'Chapter 1: Consensus Under Partial Synchrony',
      kind: 'highlight',
      quote: 'Any two majorities share at least one voting replica that preserves committed log prefixes across leadership terms.',
      note: 'Core invariant behind Raft leader completeness and Paxos quorum overlap.',
      color: 'amber',
      tags: ['consensus', 'quorum'],
      createdAtMs: now - 3600000 * 3,
      updatedAtMs: now - 3600000 * 3,
    },
    {
      id: 'ann_seed_2',
      ownerId: 'local',
      bookId: 'seed_epub_typography',
      page: 1,
      chapterTitle: '1. Proportion, Measure & Rhythm',
      kind: 'underline',
      quote: 'Before choosing a typeface or decorative rule, a designer establishes a comfortable measure—typically between sixty and seventy-five characters per line.',
      note: 'Default reader max-width in DocuTrack should sit near 68ch.',
      color: 'sky',
      tags: ['typography', 'measure'],
      createdAtMs: now - 3600000 * 7,
      updatedAtMs: now - 3600000 * 7,
    },
  ];

  const textChunks: DocumentTextChunk[] = [
    ...pdfPages.map((p, i) => ({
      bookId: 'seed_pdf_systems',
      bookTitle: 'Designing Reliable Distributed Systems',
      page: i + 1,
      chapterTitle: p.heading,
      text: `${p.heading}. ${p.paragraphs.join(' ')}`,
    })),
    ...epub1Chapters.map((c, i) => ({
      bookId: 'seed_epub_typography',
      bookTitle: 'The Elements of Digital Typography',
      page: i + 1,
      chapterTitle: c.title,
      text: `${c.title}. ${c.paragraphs.join(' ')}`,
    })),
    {
      bookId: 'seed_djvu_optics',
      bookTitle: 'Foundations of Optical & Signal Theory',
      page: 1,
      chapterTitle: 'Chapter 1: Foundations of Optical & Signal Theory',
      text: djvuText,
    },
    ...epub2Chapters.map((c, i) => ({
      bookId: 'seed_epub_cognition',
      bookTitle: 'Attention, Memory & Deep Reading',
      page: i + 1,
      chapterTitle: c.title,
      text: `${c.title}. ${c.paragraphs.join(' ')}`,
    })),
  ];

  return {books, binaries, annotations, textChunks};
}
