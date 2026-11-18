import React, {useState} from 'react';
import {BookOpen, Download, GraduationCap} from 'lucide-react';
import type {BookMetadata, StudyCourse} from '../types/library';
import {getBookTextChunks} from '../utils/offlineStorage';

interface CoursesHubViewProps {
  books: BookMetadata[];
  courses: StudyCourse[];
  isOnline: boolean;
  simulatedOffline: boolean;
  onOpenBook: (book: BookMetadata) => void;
  onGenerateCourse: (book: BookMetadata, mode: 'course' | 'summary', textContent: string) => Promise<StudyCourse | null>;
}

export const CoursesHubView: React.FC<CoursesHubViewProps> = ({
  books,
  courses,
  isOnline,
  simulatedOffline,
  onOpenBook,
  onGenerateCourse,
}) => {
  const [selectedBookId, setSelectedBookId] = useState<string>(books[0]?.id || '');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeCourseId, setActiveCourseId] = useState<string | null>(courses[0]?.id || null);
  const [revealedAnswers, setRevealedAnswers] = useState<Record<string, boolean>>({});

  const activeCourse = courses.find((c) => c.id === activeCourseId) || courses[0] || null;

  const handleGenerate = async (mode: 'course' | 'summary') => {
    const targetBook = books.find((b) => b.id === selectedBookId);
    if (!targetBook) return;
    if (!isOnline || simulatedOffline) {
      setError('Generating new AI courses requires an online connection. Existing courses remain readable offline.');
      return;
    }

    setGenerating(true);
    setError(null);
    try {
      const chunks = await getBookTextChunks(targetBook.id);
      const text = chunks.map((c) => `${c.chapterTitle || ''}\n${c.text}`).join('\n\n') || targetBook.excerpt || targetBook.title;
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
