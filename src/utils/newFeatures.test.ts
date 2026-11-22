import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CanvasMemoryGovernor,
} from './batchYield';
import {
  buildLibgenSearchUrl,
  extractDiscoveredMirrorsFromHtml,
  extractLibgenDirectUrls,
  inferMirrorEngine,
  parseLibgenSearchHtml,
  parseLibgenSizeToBytes,
  sortLibgenResults,
} from './libgenParser';
import {
  parseAiCoursePayload,
  validateLocalAiEndpoint,
} from './localAiClient';
import {
  clampPomodoroSettings,
  DEFAULT_POMODORO_SETTINGS,
  formatTimerSeconds,
  getNextPomodoroTransition,
  getPhaseDurationSeconds,
} from './pomodoro';

test('PomodoroFocusTimer state machine & clamping work deterministically', () => {
  const clamped = clampPomodoroSettings({
    focusMinutes: 300,
    shortBreakMinutes: 0,
    longBreakMinutes: 120,
    roundsBeforeLongBreak: 1,
  });
  assert.equal(clamped.focusMinutes, 180);
  assert.equal(clamped.shortBreakMinutes, 5); // 0 falls back to default then clamped
  assert.equal(clamped.longBreakMinutes, 90);
  assert.equal(clamped.roundsBeforeLongBreak, 2);

  assert.equal(getPhaseDurationSeconds('focus', DEFAULT_POMODORO_SETTINGS), 1500);
  assert.equal(getPhaseDurationSeconds('shortBreak', DEFAULT_POMODORO_SETTINGS), 300);
  assert.equal(getPhaseDurationSeconds('longBreak', DEFAULT_POMODORO_SETTINGS), 900);
  assert.equal(formatTimerSeconds(125), '02:05');

  const firstBreak = getNextPomodoroTransition({
    phase: 'focus',
    completedRoundsInCycle: 0,
    settings: DEFAULT_POMODORO_SETTINGS,
  });
  assert.equal(firstBreak.nextPhase, 'shortBreak');
  assert.equal(firstBreak.nextRoundsInCycle, 1);
  assert.equal(firstBreak.completedFocusWork, true);

  const fourthBreak = getNextPomodoroTransition({
    phase: 'focus',
    completedRoundsInCycle: 3,
    settings: DEFAULT_POMODORO_SETTINGS,
  });
  assert.equal(fourthBreak.nextPhase, 'longBreak');
  assert.equal(fourthBreak.nextRoundsInCycle, 4);

  const resetCycle = getNextPomodoroTransition({
    phase: 'longBreak',
    completedRoundsInCycle: 4,
    settings: DEFAULT_POMODORO_SETTINGS,
  });
  assert.equal(resetCycle.nextPhase, 'focus');
  assert.equal(resetCycle.nextRoundsInCycle, 0);
});

test('LibGen parser handles Classic & Plus HTML tables, sizes, sorting & mirror discovery', () => {
  assert.equal(parseLibgenSizeToBytes('4 MB'), 4 * 1024 * 1024);
  assert.equal(parseLibgenSizeToBytes('512 KB'), 512 * 1024);
  assert.equal(inferMirrorEngine('https://libgen.li'), 'plus');
  assert.equal(inferMirrorEngine('https://libgen.is'), 'classic');

  const plusUrl = buildLibgenSearchUrl('https://libgen.li/', 'linear algebra', 'title', 50);
  assert.match(plusUrl, /^https:\/\/libgen\.li\/index\.php\?req=linear%20algebra/);
  const classicUrl = buildLibgenSearchUrl('https://libgen.is', 'calculus', 'author', 25);
  assert.match(classicUrl, /^https:\/\/libgen\.is\/search\.php\?req=calculus.*column=author/);

  const classicHtml = `
    <table class="c">
      <tr><th>ID</th><th>Author(s)</th><th>Title</th><th>Publisher</th><th>Year</th><th>Pages</th><th>Language</th><th>Size</th><th>Extension</th><th>Mirrors</th></tr>
      <tr>
        <td>1042</td>
        <td>Gilbert Strang</td>
        <td><a href="book/index.php?md5=0123456789abcdef0123456789abcdef">Introduction to Linear Algebra<font> 5th ed.</font></a></td>
        <td>Wellesley-Cambridge</td>
        <td>2016</td>
        <td>584</td>
        <td>English</td>
        <td>12 MB</td>
        <td>pdf</td>
        <td><a href="https://library.lol/main/0123456789abcdef0123456789abcdef">[1]</a></td>
      </tr>
      <tr>
        <td>1043</td>
        <td>Sheldon Axler</td>
        <td><a href="book/index.php?md5=fedcba9876543210fedcba9876543210">Linear Algebra Done Right</a></td>
        <td>Springer</td>
        <td>2024</td>
        <td>340</td>
        <td>English</td>
        <td>4 MB</td>
        <td>epub</td>
        <td><a href="https://library.lol/main/fedcba9876543210fedcba9876543210">[1]</a></td>
      </tr>
    </table>
  `;

  const parsed = parseLibgenSearchHtml(classicHtml, 'https://libgen.is');
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].title, 'Introduction to Linear Algebra');
  assert.equal(parsed[0].authors, 'Gilbert Strang');
  assert.equal(parsed[0].year, 2016);
  assert.equal(parsed[0].extension, 'pdf');
  assert.equal(parsed[1].extension, 'epub');

  const sortedByYearDesc = sortLibgenResults(parsed, 'year', 'desc');
  assert.equal(sortedByYearDesc[0].title, 'Linear Algebra Done Right');

  const sortedBySizeAsc = sortLibgenResults(parsed, 'sizeBytes', 'asc');
  assert.equal(sortedBySizeAsc[0].extension, 'epub');

  const landingHtml = `<a href="https://cdn.example.com/get.php?md5=abc"><h2>GET</h2></a>`;
  const directUrls = extractLibgenDirectUrls(landingHtml, 'https://library.lol/main/abc');
  assert.deepEqual(directUrls, ['https://cdn.example.com/get.php?md5=abc']);

  const discovered = extractDiscoveredMirrorsFromHtml(
    'Active links: https://libgen.bz/ and https://libgen.gl/plus',
  );
  assert.equal(discovered.some((m) => m.url === 'https://libgen.bz'), true);
});

test('Local AI client validates endpoints and normalizes strict, fenced, and prose model outputs', () => {
  assert.equal(validateLocalAiEndpoint('http://localhost:11434/').baseUrl, 'http://localhost:11434');
  assert.equal(validateLocalAiEndpoint('ftp://bad.local').valid, false);

  const fenced = parseAiCoursePayload(
    '```json\n{"title":"Quantum Study","summary":"Wave mechanics.","keyConcepts":["Superposition"],"modules":[{"moduleNumber":1,"title":"States","durationMinutes":20,"objectives":["Define ket"],"lectureNotes":"Hilbert space.","quizQuestion":"Q?","quizAnswer":"A."}]}\n```',
    'Quantum Book',
  );
  assert.equal(fenced.title, 'Quantum Study');
  assert.equal(fenced.modules.length, 1);
  assert.equal(fenced.modules[0].quizAnswer, 'A.');

  const prose = parseAiCoursePayload(
    'This introductory overview summarizes key ideas from the manuscript across chapters.\n\nThe first section details foundational theorems and proofs in clear prose for review.',
    'Analysis Notes',
  );
  assert.equal(prose.title, 'Analysis Notes — Local AI Study Guide');
  assert.equal(prose.modules.length, 1);
});

test('CanvasMemoryGovernor enforces strict canvas count and byte caps via LRU eviction', () => {
  const gov = new CanvasMemoryGovernor(3, 8 * 1024 * 1024);
  const makeFakeCanvas = (w: number, h: number) =>
    ({width: w, height: h}) as unknown as HTMLCanvasElement;

  const c1 = makeFakeCanvas(1000, 1000); // ~4MB
  const c2 = makeFakeCanvas(1000, 1000); // ~4MB
  const c3 = makeFakeCanvas(1000, 1000); // ~4MB (exceeds 8MB cap -> evicts c1)
  gov.register('p1', c1);
  gov.register('p2', c2);
  gov.register('p3', c3);

  assert.equal(gov.getEntryCount(), 2);
  assert.equal((c1 as unknown as {width: number}).width, 0);
  assert.equal((c3 as unknown as {width: number}).width, 1000);

  gov.clearAll();
  assert.equal(gov.getEntryCount(), 0);
});
