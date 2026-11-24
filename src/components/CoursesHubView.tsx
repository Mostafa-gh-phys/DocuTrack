import React, {useEffect, useState} from 'react';
import {BookOpen, Cpu, Download, GraduationCap, RefreshCw} from 'lucide-react';
import type {BookMetadata, StudyCourse} from '../types/library';
import {
  type AiCourseProvider,
  fetchLocalAiModels,
  type LocalAiConfig,
} from '../utils/localAiClient';
import {getBookBinary, getBookTextChunks} from '../utils/offlineStorage';
import {extractPdfOutlineAndMeta, extractPdfPageTextRange, loadPdfDocument, closePdfDocument} from '../utils/parsers/pdfParser';
import {parseEpubQuickIndex} from '../utils/parsers/epubParser';
import {openDjvuDocument, closeDjvuDocument, extractDjvuPageTextRange} from '../utils/parsers/djvuParser';

interface CoursesHubViewProps {
  books: BookMetadata[];
  courses: StudyCourse[];
  isOnline: boolean;
  simulatedOffline: boolean;
  localAiConfig: LocalAiConfig;
  onUpdateLocalAiConfig: (next: LocalAiConfig) => void;
  onOpenBook: (book: BookMetadata) => void;
  onGenerateCourse: (book: BookMetadata, mode: 'course' | 'summary', textContent: string) => Promise<StudyCourse | null>;
}

export const CoursesHubView: React.FC<CoursesHubViewProps> = ({
  books,
  courses,
  isOnline,
  simulatedOffline,
  localAiConfig,
  onUpdateLocalAiConfig,
  onOpenBook,
  onGenerateCourse,
}) => {
  const [selectedBookId, setSelectedBookId] = useState<string>(books[0]?.id || '');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeCourseId, setActiveCourseId] = useState<string | null>(courses[0]?.id || null);
  const [revealedAnswers, setRevealedAnswers] = useState<Record<string, boolean>>({});
  const [detectingModels, setDetectingModels] = useState(false);
  const [detectedModels, setDetectedModels] = useState<string[]>([]);
  const [detectFeedback, setDetectFeedback] = useState<{ok: boolean; message: string} | null>(null);

  useEffect(() => {
    if (books.length > 0 && !books.some((b) => b.id === selectedBookId)) {
      setSelectedBookId(books[0].id);
    }
  }, [books, selectedBookId]);

  const activeCourse = courses.find((c) => c.id === activeCourseId) || courses[0] || null;
  const isLocalProvider = localAiConfig.provider !== 'gemini';

  const activeUrl =
    localAiConfig.provider === 'ollama'
      ? localAiConfig.ollamaUrl
      : localAiConfig.provider === 'lmstudio'
        ? localAiConfig.lmStudioUrl
        : localAiConfig.customBaseUrl;

  const activeModel =
    localAiConfig.provider === 'ollama'
      ? localAiConfig.ollamaModel
      : localAiConfig.provider === 'lmstudio'
        ? localAiConfig.lmStudioModel
        : localAiConfig.customModel;

  const handleUrlChange = (val: string) => {
    setDetectFeedback(null);
    if (localAiConfig.provider === 'ollama') {
      onUpdateLocalAiConfig({...localAiConfig, ollamaUrl: val});
    } else if (localAiConfig.provider === 'lmstudio') {
      onUpdateLocalAiConfig({...localAiConfig, lmStudioUrl: val});
    } else {
      onUpdateLocalAiConfig({...localAiConfig, customBaseUrl: val});
    }
  };

  const handleModelChange = (val: string) => {
    if (localAiConfig.provider === 'ollama') {
      onUpdateLocalAiConfig({...localAiConfig, ollamaModel: val});
    } else if (localAiConfig.provider === 'lmstudio') {
      onUpdateLocalAiConfig({...localAiConfig, lmStudioModel: val});
    } else {
      onUpdateLocalAiConfig({...localAiConfig, customModel: val});
    }
  };

  const handleDetectModels = async () => {
    setDetectingModels(true);
    setDetectFeedback(null);
    try {
      const models = await fetchLocalAiModels(localAiConfig);
      setDetectedModels(models);
      if (models.length === 0) {
        setDetectFeedback({
          ok: false,
          message: 'Connected, but no models were returned. Load or pull a model in your local runtime first.',
        });
      } else {
        if (!activeModel.trim() || !models.includes(activeModel.trim())) {
          handleModelChange(models[0]);
        }
        setDetectFeedback({
          ok: true,
          message: `Found ${models.length} local model${models.length === 1 ? '' : 's'} ready.`,
        });
      }
    } catch (err) {
      setDetectFeedback({
        ok: false,
        message: err instanceof Error ? err.message : 'Unable to reach local AI server.',
      });
    } finally {
      setDetectingModels(false);
    }
  };

  const handleGenerate = async (mode: 'course' | 'summary') => {
    const targetBook = books.find((b) => b.id === selectedBookId) || books[0];
    if (!targetBook) return;
    if (!isLocalProvider && (!isOnline || simulatedOffline)) {
      setError(
        'Cloud Gemini requires an online connection. Switch AI Provider to Ollama or LM Studio to generate courses offline.',
      );
      return;
    }

    setGenerating(true);
    setError(null);
    try {
      const chunks = await getBookTextChunks(targetBook.id);
      let text = chunks.map((c) => `${c.chapterTitle || ''}\n${c.text}`).join('\n\n').trim();

      if (text.length < 120) {
        try {
          const bin = await getBookBinary(targetBook.id);
          if (bin) {
            if (targetBook.format === 'pdf') {
              const doc = await loadPdfDocument(bin);
              try {
                const [meta, pages] = await Promise.all([
                  extractPdfOutlineAndMeta(doc),
                  extractPdfPageTextRange(doc, 1, Math.min(6, doc.numPages)),
                ]);
                const outlineList = meta.outline.slice(0, 25).map((o) => `- ${o.title} (p.${o.page})`).join('\n');
                const sampled = pages.map((p) => p.text).filter(Boolean).join('\n\n');
                text = [sampled, outlineList ? `Contents:\n${outlineList}` : ''].filter(Boolean).join('\n\n').trim();
              } finally {
                await closePdfDocument(doc);
              }
            } else if (targetBook.format === 'epub') {
              const quick = await parseEpubQuickIndex(bin, 6, false);
              text = quick.chapters.map((c) => `${c.title}\n${c.plainText}`).join('\n\n').trim();
            } else if (targetBook.format === 'djvu') {
              const doc = await openDjvuDocument(bin);
              try {
                const pages = await extractDjvuPageTextRange(doc, 1, Math.min(6, doc.page_count()));
                text = pages.map((p) => p.text).filter(Boolean).join('\n\n').trim();
              } finally {
                closeDjvuDocument(doc);
              }
            }
          }
        } catch {
          // Fall back to book metadata context below
        }
      }

      if (text.length < 40) {
        text = [
          `Title: ${targetBook.title}`,
          `Author: ${targetBook.author}`,
          `Format: ${targetBook.format.toUpperCase()} (${targetBook.pageCount} pages)`,
          targetBook.folderPath ? `Collection Folder: ${targetBook.folderPath}` : '',
          targetBook.tags.length > 0 ? `Tags: ${targetBook.tags.join(', ')}` : '',
          targetBook.excerpt ? `Excerpt: ${targetBook.excerpt}` : '',
          text,
        ]
          .filter(Boolean)
          .join('\n');
      }

      const created = await onGenerateCourse(targetBook, mode, text);
      if (created) setActiveCourseId(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate course.');
    } finally {
      setGenerating(false);
    }
  };

  const handleExportMarkdown = (course: StudyCourse) => {
    const md = [
      `# ${course.title}`,
      '',
      '## Executive Summary',
      course.summary,
      '',
      '## Key Concepts',
      ...course.keyConcepts.map((k) => `- ${k}`),
      '',
      ...course.modules.flatMap((m) => [
        `## Module ${m.moduleNumber}: ${m.title} (${m.durationMinutes} min)`,
        '',
        '### Learning Objectives',
        ...m.objectives.map((o) => `- ${o}`),
        '',
        '### Lecture Notes',
        m.lectureNotes,
        '',
        `**Comprehension Check:** ${m.quizQuestion}`,
        `**Answer:** ${m.quizAnswer}`,
        '',
      ]),
    ].join('\n');

    const blob = new Blob([md], {type: 'text/markdown;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${course.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex-1 p-6 max-w-6xl mx-auto w-full space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 tracking-tight">
            AI Lecture Courses & Summaries
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Synthesize any PDF, EPUB, or DjVu document into structured lecture modules, study notes, and self-test quizzes.
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <label htmlFor="course-book-select" className="sr-only">
            Select document
          </label>
          <select
            id="course-book-select"
            value={selectedBookId}
            onChange={(e) => setSelectedBookId(e.target.value)}
            className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium text-slate-800 dark:text-slate-200 max-w-xs"
          >
            {books.map((b) => (
              <option key={b.id} value={b.id}>
                {b.title} ({b.format.toUpperCase()})
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={generating || !selectedBookId}
            onClick={() => void handleGenerate('course')}
            className="px-4 py-2 rounded-lg bg-blue-800 text-white text-xs font-medium hover:bg-blue-900 disabled:opacity-50 whitespace-nowrap"
          >
            {generating ? 'Synthesizing...' : 'Generate Lecture Course'}
          </button>
          <button
            type="button"
            disabled={generating || !selectedBookId}
            onClick={() => void handleGenerate('summary')}
            className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
          >
            Generate Summary
          </button>
        </div>
      </div>

      {/* Local & Cloud AI Model Configuration */}
      <section
        aria-label="AI course model engine"
        className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-800 dark:text-slate-100">
            <Cpu className="w-4 h-4 accent-text" aria-hidden="true" />
            <span>Study Course AI Engine</span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="AI provider">
            {(
              [
                {id: 'gemini', label: 'Cloud Gemini'},
                {id: 'ollama', label: 'Ollama (Local)'},
                {id: 'lmstudio', label: 'LM Studio (Local)'},
                {id: 'openai-compat', label: 'Custom Local / OpenAI-API'},
              ] as {id: AiCourseProvider; label: string}[]
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                aria-pressed={localAiConfig.provider === opt.id}
                onClick={() => {
                  setDetectedModels([]);
                  setDetectFeedback(null);
                  setError(null);
                  onUpdateLocalAiConfig({...localAiConfig, provider: opt.id});
                }}
                className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
                  localAiConfig.provider === opt.id
                    ? 'accent-btn border-transparent'
                    : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {isLocalProvider && (
          <div className="grid grid-cols-1 md:grid-cols-12 gap-3 pt-2 border-t border-slate-100 dark:border-slate-800 text-xs items-end">
            <div className="md:col-span-5 space-y-1">
              <label htmlFor="local-ai-url" className="block font-medium text-slate-600 dark:text-slate-400">
                {localAiConfig.provider === 'ollama'
                  ? 'Ollama Server URL'
                  : localAiConfig.provider === 'lmstudio'
                    ? 'LM Studio Server URL'
                    : 'Base Endpoint URL (/v1)'}
              </label>
              <input
                id="local-ai-url"
                type="url"
                value={activeUrl}
                onChange={(e) => handleUrlChange(e.target.value)}
                placeholder={localAiConfig.provider === 'ollama' ? 'http://localhost:11434' : 'http://localhost:1234'}
                className="w-full px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent font-mono text-xs"
              />
            </div>

            <div className="md:col-span-4 space-y-1">
              <label htmlFor="local-ai-model" className="block font-medium text-slate-600 dark:text-slate-400">
                Model Name
              </label>
              <input
                id="local-ai-model"
                type="text"
                list="local-ai-detected-models"
                value={activeModel}
                onChange={(e) => handleModelChange(e.target.value)}
                placeholder={
                  localAiConfig.provider === 'ollama'
                    ? 'llama3.2, qwen2.5, mistral...'
                    : 'loaded-model-id'
                }
                className="w-full px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent font-mono text-xs"
              />
              <datalist id="local-ai-detected-models">
                {detectedModels.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>

            <div className="md:col-span-3 flex items-center gap-2">
              <button
                type="button"
                disabled={detectingModels}
                onClick={() => void handleDetectModels()}
                className="w-full px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 font-medium hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center justify-center gap-1.5 disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${detectingModels ? 'animate-spin' : ''}`} aria-hidden="true" />
                {detectingModels ? 'Detecting...' : 'Detect Models'}
              </button>
            </div>

            {localAiConfig.provider === 'openai-compat' && (
              <div className="md:col-span-5 space-y-1">
                <label htmlFor="local-ai-key" className="block font-medium text-slate-600 dark:text-slate-400">
                  Optional Bearer Key (session-only)
                </label>
                <input
                  id="local-ai-key"
                  type="password"
                  value={localAiConfig.customApiKey}
                  onChange={(e) => onUpdateLocalAiConfig({...localAiConfig, customApiKey: e.target.value})}
                  placeholder="Optional token for custom local gateway"
                  className="w-full px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent font-mono text-xs"
                />
              </div>
            )}

            {detectedModels.length > 0 && (
              <div className="md:col-span-12 flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-slate-500 dark:text-slate-400 mr-1">Available:</span>
                {detectedModels.slice(0, 10).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => handleModelChange(m)}
                    className={`px-2 py-0.5 rounded border text-[11px] font-mono ${
                      activeModel === m
                        ? 'accent-soft accent-border font-semibold'
                        : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}

            {detectFeedback && (
              <p
                className={`md:col-span-12 text-xs ${
                  detectFeedback.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
                }`}
              >
                {detectFeedback.message}
              </p>
            )}
          </div>
        )}
      </section>

      {error && (
        <div className="p-3.5 rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {courses.length === 0 ? (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-12 text-center">
          <GraduationCap className="w-10 h-10 text-slate-300 dark:text-slate-600 mx-auto" aria-hidden="true" />
          <h2 className="mt-4 text-base font-semibold text-slate-900 dark:text-slate-100">
            No generated courses yet
          </h2>
          <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400 max-w-md mx-auto">
            Pick a book from the selector above and click Generate Lecture Course to create offline-cached study modules.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-4 space-y-2">
            <h2 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide px-1">
              Saved Courses ({courses.length})
            </h2>
            <div className="space-y-2">
              {courses.map((course) => {
                const sourceBook = books.find((b) => b.id === course.bookId);
                const selected = activeCourse?.id === course.id;
                return (
                  <button
                    key={course.id}
                    type="button"
                    onClick={() => setActiveCourseId(course.id)}
                    className={`w-full text-left p-3.5 rounded-xl border transition-colors ${
                      selected
                        ? 'border-blue-700 bg-blue-50/70 dark:bg-blue-950/40 dark:border-blue-700'
                        : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300'
                    }`}
                  >
                    <p className="text-sm font-semibold text-slate-900 dark:text-slate-100 line-clamp-2">
                      {course.title}
                    </p>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                      {sourceBook?.title || 'Source Book'} · {course.modules.length} modules
                    </p>
                  </button>
                );
              })}
            </div>
          </div>

          {activeCourse && (
            <div className="lg:col-span-8 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-6">
              <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-slate-100 dark:border-slate-800">
                <div>
                  <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                    {activeCourse.title}
                  </h2>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                    {activeCourse.modules.length} lecture modules · Saved locally for offline study
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {books.find((b) => b.id === activeCourse.bookId) && (
                    <button
                      type="button"
                      onClick={() => {
                        const b = books.find((item) => item.id === activeCourse.bookId);
                        if (b) onOpenBook(b);
                      }}
                      className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 flex items-center gap-1.5"
                    >
                      <BookOpen className="w-3.5 h-3.5" />
                      Open Source
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleExportMarkdown(activeCourse)}
                    className="px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-xs font-medium flex items-center gap-1.5"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Export Markdown
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Executive Summary
                </h3>
                <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed whitespace-pre-wrap">
                  {activeCourse.summary}
                </p>
              </div>

              {activeCourse.keyConcepts.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Core Concepts
                  </h3>
                  <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-xs text-slate-700 dark:text-slate-300 list-disc pl-4">
                    {activeCourse.keyConcepts.map((kc, i) => (
                      <li key={i}>{kc}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="space-y-4">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Curriculum Modules
                </h3>
                {activeCourse.modules.map((mod) => {
                  const key = `${activeCourse.id}-${mod.moduleNumber}`;
                  return (
                    <div
                      key={key}
                      className="pt-4 border-t border-slate-100 dark:border-slate-800 space-y-2.5"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                          Module {mod.moduleNumber}: {mod.title}
                        </h4>
                        <span className="text-xs font-mono tabular-nums text-slate-500">
                          {mod.durationMinutes} min
                        </span>
                      </div>
                      {mod.objectives.length > 0 && (
                        <ul className="text-xs text-slate-600 dark:text-slate-400 list-disc pl-4 space-y-0.5">
                          {mod.objectives.map((obj, idx) => (
                            <li key={idx}>{obj}</li>
                          ))}
                        </ul>
                      )}
                      <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
                        {mod.lectureNotes}
                      </p>
                      <div className="pt-1 text-xs">
                        <span className="font-medium text-slate-900 dark:text-slate-100">
                          Review Question:{' '}
                        </span>
                        <span className="text-slate-700 dark:text-slate-300">{mod.quizQuestion}</span>
                        {revealedAnswers[key] ? (
                          <p className="mt-1 text-emerald-700 dark:text-emerald-400 font-medium">
                            Answer: {mod.quizAnswer}
                          </p>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setRevealedAnswers((prev) => ({...prev, [key]: true}))}
                            className="ml-2 text-blue-700 dark:text-blue-400 hover:underline font-medium"
                          >
                            Show Answer
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
