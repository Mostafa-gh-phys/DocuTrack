import type {Annotation, HighlightColor} from '../types/library';

const HIGHLIGHT_FILL: Record<HighlightColor, string> = {
  amber: 'rgba(251, 191, 36, 0.36)',
  sage: 'rgba(52, 211, 153, 0.34)',
  sky: 'rgba(56, 189, 248, 0.34)',
  rose: 'rgba(251, 113, 133, 0.32)',
  violet: 'rgba(167, 139, 250, 0.34)',
};

const UNDERLINE_STROKE: Record<HighlightColor, string> = {
  amber: '#d97706',
  sage: '#059669',
  sky: '#0284c7',
  rose: '#e11d48',
  violet: '#7c3aed',
};

/**
 * Populates a managed DOM element with sanitized EPUB chapter HTML, then wraps
 * matching highlight & underline annotation quotes in interactive <mark data-ann-id="...">
 * elements directly inside the prose without altering underlying stored HTML.
 */
export function renderEpubChapterWithAnnotations(
  container: HTMLElement,
  sanitizedHtml: string,
  chapterAnnotations: Annotation[],
  focusedAnnotationId: string | null,
): void {
  container.innerHTML = sanitizedHtml || '<p>Empty chapter.</p>';

  const textMarks = chapterAnnotations.filter((a) => {
    const k = a.kind || 'highlight';
    return (k === 'highlight' || k === 'underline') && a.quote && a.quote.trim().length >= 3;
  });
  if (textMarks.length === 0) return;

  for (const ann of textMarks) {
    const needleRaw = ann.quote.replace(/\s+/g, ' ').trim();
    if (!needleRaw) continue;
    const needle = needleRaw.slice(0, 260);
    const shortNeedle = needle.slice(0, 80);

    // Collect current Text nodes inside container
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const textNodes: {node: Text; text: string; start: number; end: number}[] = [];
    let fullText = '';
    let node: Node | null = walker.nextNode();
    while (node) {
      const t = node as Text;
      const val = t.nodeValue || '';
      if (val.length > 0 && !t.parentElement?.closest('mark[data-ann-id]')) {
        const start = fullText.length;
        fullText += val;
        textNodes.push({node: t, text: val, start, end: fullText.length});
      }
      node = walker.nextNode();
    }

    if (!fullText) continue;

    // Try exact match first, then whitespace-normalized fuzzy search
    let matchStart = fullText.indexOf(needle);
    let matchLen = needle.length;

    if (matchStart === -1 && shortNeedle.length >= 12) {
      matchStart = fullText.indexOf(shortNeedle);
      matchLen = shortNeedle.length;
    }

    if (matchStart === -1) {
      // Normalized whitespace regex match across nodes
      const escaped = shortNeedle
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\s+/g, '\\s+');
      try {
        const rx = new RegExp(escaped);
        const m = rx.exec(fullText);
        if (m) {
          matchStart = m.index;
          matchLen = m[0].length;
        }
      } catch {
        // Ignore invalid regex patterns
      }
    }

    if (matchStart === -1) continue;
    const matchEnd = matchStart + matchLen;
    const kind = ann.kind || 'highlight';
    const isFocused = focusedAnnotationId === ann.id;

    // Wrap each overlapping Text node slice in <mark>
    const overlapping = textNodes.filter((tn) => tn.end > matchStart && tn.start < matchEnd);
    for (const seg of overlapping) {
      const localStart = Math.max(0, matchStart - seg.start);
      const localEnd = Math.min(seg.text.length, matchEnd - seg.start);
      if (localEnd <= localStart) continue;

      const range = document.createRange();
      range.setStart(seg.node, localStart);
      range.setEnd(seg.node, localEnd);

      const mark = document.createElement('mark');
      mark.dataset.annId = ann.id;
      mark.dataset.annKind = kind;
      mark.title = ann.note ? `${ann.note}` : 'Click to inspect or edit annotation';

      if (kind === 'underline') {
        mark.style.backgroundColor = isFocused ? 'rgba(59, 130, 246, 0.14)' : 'transparent';
        mark.style.borderBottom = `2px solid ${UNDERLINE_STROKE[ann.color] || UNDERLINE_STROKE.amber}`;
        mark.style.paddingBottom = '1px';
      } else {
        mark.style.backgroundColor = HIGHLIGHT_FILL[ann.color] || HIGHLIGHT_FILL.amber;
        if (isFocused) {
          mark.style.outline = `2px solid ${UNDERLINE_STROKE[ann.color] || '#1e40af'}`;
        }
      }

      try {
        range.surroundContents(mark);
      } catch {
        // Skip partial range errors if DOM changed unexpectedly
      }
    }
  }
}
