import assert from 'node:assert/strict';
import test from 'node:test';
import {BoundedTaskQueue, computeAutofitZoom} from './batchYield';
import {resolveEpubPath, safeDecodeUri} from './parsers/epubParser';

test('computeAutofitZoom handles manual clamping, single page fit-width/fit-page, and 2-up spread', () => {
  assert.equal(
    computeAutofitZoom({
      fitMode: 'manual',
      manualZoom: 1.356,
      pageWidth: 612,
      pageHeight: 792,
      viewportWidth: 1200,
      viewportHeight: 800,
      isDoublePage: false,
    }),
    1.36,
  );

  // Clamp below minZoom and above maxZoom
  assert.equal(
    computeAutofitZoom({
      fitMode: 'manual',
      manualZoom: 0.1,
      pageWidth: 612,
      pageHeight: 792,
      viewportWidth: 1200,
      viewportHeight: 800,
      isDoublePage: false,
    }),
    0.45,
  );
  assert.equal(
    computeAutofitZoom({
      fitMode: 'manual',
      manualZoom: 5.0,
      pageWidth: 612,
      pageHeight: 792,
      viewportWidth: 1200,
      viewportHeight: 800,
      isDoublePage: false,
    }),
    2.6,
  );

  // Fit width: single page vs double page
  const singleWidthZoom = computeAutofitZoom({
    fitMode: 'width',
    manualZoom: 1.0,
    pageWidth: 600,
    pageHeight: 800,
    viewportWidth: 1284,
    viewportHeight: 900,
    isDoublePage: false,
  });
  // usableW = 1284 - 84 = 1200 -> 1200 / 600 = 2.0
  assert.equal(singleWidthZoom, 2);

  const doubleWidthZoom = computeAutofitZoom({
    fitMode: 'width',
    manualZoom: 1.0,
    pageWidth: 600,
    pageHeight: 800,
    viewportWidth: 1328,
    viewportHeight: 900,
    isDoublePage: true,
  });
  // usableW = 1328 - 114 = 1214 -> singleColW = (1214 - 14) / 2 = 600 -> 600 / 600 = 1.0
  assert.equal(doubleWidthZoom, 1);

  // Fit page constrains by height when viewport is short
  const fitPageZoom = computeAutofitZoom({
    fitMode: 'page',
    manualZoom: 1.0,
    pageWidth: 600,
    pageHeight: 1000,
    viewportWidth: 1400,
    viewportHeight: 564,
    isDoublePage: false,
  });
  // usableH = 564 - 64 = 500 -> 500 / 1000 = 0.5
  assert.equal(fitPageZoom, 0.5);
});

test('BoundedTaskQueue strictly enforces concurrency cap and runs tasks in FIFO order', async () => {
  const queue = new BoundedTaskQueue(2);
  let active = 0;
  let maxActive = 0;
  const startedOrder: number[] = [];

  const tasks = [1, 2, 3, 4, 5, 6].map((id) =>
    queue.run(async () => {
      startedOrder.push(id);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 8));
      active -= 1;
      return id * 10;
    }),
  );

  const results = await Promise.all(tasks);
  assert.deepEqual(results, [10, 20, 30, 40, 50, 60]);
  assert.deepEqual(startedOrder, [1, 2, 3, 4, 5, 6]);
  assert.ok(maxActive <= 2, `Expected maxActive <= 2, got ${maxActive}`);
});

test('safeDecodeUri and resolveEpubPath normalize relative, encoded, and nested EPUB paths safely', () => {
  assert.equal(safeDecodeUri('Chapter%201%2FIntro.xhtml'), 'Chapter 1/Intro.xhtml');
  assert.equal(safeDecodeUri('Malformed%E0%A4%A'), 'Malformed%E0%A4%A');

  assert.equal(resolveEpubPath('OEBPS/Text', '../Images/cover%20page.jpg#top'), 'OEBPS/Images/cover%20page.jpg');
  assert.equal(resolveEpubPath('OEBPS/Text', '..\\Styles\\main.css?v=2'), 'OEBPS/Styles/main.css');
  assert.equal(resolveEpubPath('OEBPS/Text', '/META-INF/container.xml'), 'META-INF/container.xml');
  assert.equal(resolveEpubPath('', './chapter1.xhtml'), 'chapter1.xhtml');
});
