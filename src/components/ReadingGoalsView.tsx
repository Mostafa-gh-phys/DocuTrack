import React, {useEffect, useMemo, useState} from 'react';
import {BookCheck, Calendar, Clock, Flame, Plus, RotateCcw, Target} from 'lucide-react';
import type {BookMetadata, ReadingGoal} from '../types/library';
import {getMonthlyReadingStats, getReadingGoalStats} from '../utils/libraryLogic';
import {PomodoroFocusTimer} from './PomodoroFocusTimer';

interface ReadingGoalsViewProps {
  goal: ReadingGoal;
  books: BookMetadata[];
  onLogActivity: (pages: number, minutes: number) => void;
  onUpdateTargets: (targets: {
    dailyPagesTarget: number;
    weeklyMinutesTarget: number;
    yearlyBooksTarget: number;
  }) => void;
  onResetStats?: (scope: '7days' | '30days' | 'all') => void;
}

export const ReadingGoalsView: React.FC<ReadingGoalsViewProps> = ({
  goal,
  books,
  onLogActivity,
  onUpdateTargets,
  onResetStats,
}) => {
  const stats = useMemo(() => getReadingGoalStats(goal, books), [goal, books]);
  const monthlyStats = useMemo(() => getMonthlyReadingStats(goal, books), [goal, books]);
  const [chartWindow, setChartWindow] = useState<'7days' | '30days'>('7days');
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);
  const [resetFeedback, setResetFeedback] = useState<string | null>(null);

  const [pagesInput, setPagesInput] = useState('10');
  const [minutesInput, setMinutesInput] = useState('15');
  const [logFeedback, setLogFeedback] = useState<string | null>(null);

  const [dailyTarget, setDailyTarget] = useState(String(goal.dailyPagesTarget));
  const [weeklyTarget, setWeeklyTarget] = useState(String(goal.weeklyMinutesTarget));
  const [yearlyTarget, setYearlyTarget] = useState(String(goal.yearlyBooksTarget));
  const [targetSaved, setTargetSaved] = useState(false);

  useEffect(() => {
    setDailyTarget(String(goal.dailyPagesTarget));
    setWeeklyTarget(String(goal.weeklyMinutesTarget));
    setYearlyTarget(String(goal.yearlyBooksTarget));
  }, [goal.dailyPagesTarget, goal.weeklyMinutesTarget, goal.yearlyBooksTarget]);

  const activeDaysSeries = chartWindow === '7days' ? stats.last7Days : monthlyStats.last30Days;
  const maxChartPages = Math.max(
    goal.dailyPagesTarget,
    ...activeDaysSeries.map((d) => d.pages),
    10,
  );

  const handleLogSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const p = Math.max(0, Math.floor(Number(pagesInput) || 0));
    const m = Math.max(0, Math.floor(Number(minutesInput) || 0));
    if (p === 0 && m === 0) return;
    onLogActivity(p, m);
    setLogFeedback(`Logged +${p} pages and +${m} min to today's reading tally.`);
    window.setTimeout(() => setLogFeedback(null), 3500);
  };

  const handleTargetsSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onUpdateTargets({
      dailyPagesTarget: Math.max(1, Math.min(1000, Math.floor(Number(dailyTarget) || 25))),
      weeklyMinutesTarget: Math.max(10, Math.min(5000, Math.floor(Number(weeklyTarget) || 180))),
      yearlyBooksTarget: Math.max(1, Math.min(500, Math.floor(Number(yearlyTarget) || 24))),
    });
    setTargetSaved(true);
    window.setTimeout(() => setTargetSaved(false), 3000);
  };

  const handlePerformReset = (scope: '7days' | '30days' | 'all') => {
    onResetStats?.(scope);
    setConfirmResetOpen(false);
    setResetFeedback(
      scope === '7days'
        ? 'Restarted last 7 days reading output.'
        : scope === '30days'
          ? 'Restarted last 30 days monthly reading statistics.'
          : 'Restarted all reading output and streaks.',
    );
    window.setTimeout(() => setResetFeedback(null), 4000);
  };

  return (
    <div className="flex-1 p-6 max-w-6xl mx-auto w-full space-y-6">
      <div className="pb-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 tracking-tight">
            Reading Goals &amp; Study Cadence
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Track daily pages, 7-day and monthly reading output, annual book completions, and streak consistency automatically as you read.
          </p>
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
          Lifetime: {goal.totalPagesRead} pages · {goal.totalMinutesRead} min logged · 30d: {monthlyStats.monthlyPages}p
        </div>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500 dark:text-slate-400">
            <span>Daily Pages Target</span>
            <Target className="w-4 h-4 text-blue-700 dark:text-blue-400" aria-hidden="true" />
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-2xl font-bold text-slate-900 dark:text-slate-100 tabular-nums">
              {stats.todayPages}
              <span className="text-sm font-normal text-slate-500 dark:text-slate-400">
                {' '}
                / {goal.dailyPagesTarget} pages
              </span>
            </span>
            <span className="text-xs font-semibold text-blue-700 dark:text-blue-400 tabular-nums">
              {stats.dailyPct}%
            </span>
          </div>
          <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
            <div
              className="h-full bg-blue-700 dark:bg-blue-500 transition-all"
              style={{width: `${stats.dailyPct}%`}}
            />
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500 dark:text-slate-400">
            <span>Weekly Reading Time</span>
            <Clock className="w-4 h-4 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-2xl font-bold text-slate-900 dark:text-slate-100 tabular-nums">
              {stats.weeklyMinutes}
              <span className="text-sm font-normal text-slate-500 dark:text-slate-400">
                {' '}
                / {goal.weeklyMinutesTarget} min
              </span>
            </span>
            <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 tabular-nums">
              {stats.weeklyPct}%
            </span>
          </div>
          <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
            <div
              className="h-full bg-emerald-600 dark:bg-emerald-500 transition-all"
              style={{width: `${stats.weeklyPct}%`}}
            />
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500 dark:text-slate-400">
            <span>Annual Book Goal</span>
            <BookCheck className="w-4 h-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-2xl font-bold text-slate-900 dark:text-slate-100 tabular-nums">
              {stats.completedBooks}
              <span className="text-sm font-normal text-slate-500 dark:text-slate-400">
                {' '}
                / {goal.yearlyBooksTarget} books
              </span>
            </span>
            <span className="text-xs font-semibold text-amber-700 dark:text-amber-400 tabular-nums">
              {stats.yearlyPct}%
            </span>
          </div>
          <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
            <div
              className="h-full bg-amber-600 dark:bg-amber-500 transition-all"
              style={{width: `${stats.yearlyPct}%`}}
            />
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500 dark:text-slate-400">
            <span>Active Reading Streak</span>
            <Flame className="w-4 h-4 text-orange-600 dark:text-orange-400" aria-hidden="true" />
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-2xl font-bold text-slate-900 dark:text-slate-100 tabular-nums">
              {goal.currentStreakDays}
              <span className="text-sm font-normal text-slate-500 dark:text-slate-400">
                {' '}
                day{goal.currentStreakDays === 1 ? '' : 's'}
              </span>
            </span>
            <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
              Best: {goal.longestStreakDays}d
            </span>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
            {stats.todayPages >= goal.dailyPagesTarget
              ? "Today's daily goal reached."
              : `${Math.max(0, goal.dailyPagesTarget - stats.todayPages)} pages remaining today.`}
          </p>
        </section>
      </div>

      {/* Middle Row: 7-Day / Monthly Activity Chart + Log & Targets */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <section className="lg:col-span-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 flex flex-col justify-between space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                {chartWindow === '7days' ? 'Last 7 Days Reading Output' : 'Monthly (30-Day) Reading Statistics'}
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                {chartWindow === '7days'
                  ? `${stats.weeklyPages} pages · ${stats.weeklyMinutes} minutes over the past week`
                  : `${monthlyStats.monthlyPages} pages · ${monthlyStats.monthlyMinutes} minutes · ${monthlyStats.activeDays}/30 active days · Best: ${monthlyStats.bestDayPages}p`}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 p-0.5 text-xs">
                <button
                  type="button"
                  aria-pressed={chartWindow === '7days'}
                  onClick={() => setChartWindow('7days')}
                  className={`px-2.5 py-1 rounded-md font-medium transition-colors ${
                    chartWindow === '7days'
                      ? 'accent-btn'
                      : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                >
                  Last 7 Days
                </button>
                <button
                  type="button"
                  aria-pressed={chartWindow === '30days'}
                  onClick={() => setChartWindow('30days')}
                  className={`px-2.5 py-1 rounded-md font-medium flex items-center gap-1 transition-colors ${
                    chartWindow === '30days'
                      ? 'accent-btn'
                      : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                >
                  <Calendar className="w-3 h-3" aria-hidden="true" />
                  Monthly (30d)
                </button>
              </div>

              {onResetStats && (
                <button
                  type="button"
                  onClick={() => setConfirmResetOpen((prev) => !prev)}
                  className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1"
                >
                  <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                  Restart Output
                </button>
              )}
            </div>
          </div>

          {confirmResetOpen && (
            <div className="p-3 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-medium text-amber-950 dark:text-amber-200">
                Choose reading history range to restart:
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => handlePerformReset('7days')}
                  className="px-2.5 py-1 rounded bg-amber-700 text-white font-medium hover:bg-amber-800"
                >
                  Restart 7 Days
                </button>
                <button
                  type="button"
                  onClick={() => handlePerformReset('30days')}
                  className="px-2.5 py-1 rounded bg-amber-700 text-white font-medium hover:bg-amber-800"
                >
                  Restart 30 Days
                </button>
                <button
                  type="button"
                  onClick={() => handlePerformReset('all')}
                  className="px-2.5 py-1 rounded bg-red-700 text-white font-medium hover:bg-red-800"
                >
                  Restart All
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmResetOpen(false)}
                  className="px-2.5 py-1 rounded border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {resetFeedback && (
            <p className="text-xs text-emerald-700 dark:text-emerald-400 font-medium">{resetFeedback}</p>
          )}

          {chartWindow === '30days' && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/70">
                <div className="text-[11px] text-slate-500 dark:text-slate-400">Monthly Pages</div>
                <div className="text-sm font-semibold tabular-nums">{monthlyStats.monthlyPages}</div>
              </div>
              <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/70">
                <div className="text-[11px] text-slate-500 dark:text-slate-400">Daily Avg (30d)</div>
                <div className="text-sm font-semibold tabular-nums">{monthlyStats.avgDailyPages} p/day</div>
              </div>
              <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/70">
                <div className="text-[11px] text-slate-500 dark:text-slate-400">Days Met Target</div>
                <div className="text-sm font-semibold tabular-nums">{monthlyStats.daysMetTarget} / 30</div>
              </div>
              <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/70">
                <div className="text-[11px] text-slate-500 dark:text-slate-400">Best Day</div>
                <div className="text-sm font-semibold tabular-nums">{monthlyStats.bestDayPages} pages</div>
              </div>
            </div>
          )}

          <div className="space-y-2 pt-3">
            <div className="flex items-center justify-end text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
              Target line: {goal.dailyPagesTarget} pages/day
            </div>
            <div className={`relative h-40 flex items-end justify-between ${chartWindow === '7days' ? 'gap-3' : 'gap-1'}`}>
              {/* Target reference rule aligned to bar plot height */}
              <div
                className="absolute left-0 right-0 border-t border-dashed border-blue-500/80 dark:border-blue-400/70 pointer-events-none z-10"
                style={{
                  bottom: `${Math.min(100, Math.round((goal.dailyPagesTarget / maxChartPages) * 100))}%`,
                }}
              />

              {activeDaysSeries.map((day) => {
                const heightPct = Math.max(4, Math.round((day.pages / maxChartPages) * 100));
                return (
                  <div key={day.date} className="flex-1 h-full flex flex-col items-center justify-end">
                    <div
                      title={`${day.date}: ${day.pages} pages, ${day.minutes} min`}
                      className={`w-full ${
                        chartWindow === '7days' ? 'max-w-[44px]' : 'max-w-[14px]'
                      } rounded-t-md transition-all relative flex items-start justify-center ${
                        day.metTarget
                          ? 'bg-blue-700 dark:bg-blue-500'
                          : 'bg-slate-300 dark:bg-slate-700'
                      }`}
                      style={{height: `${heightPct}%`}}
                    >
                      {chartWindow === '7days' && (
                        <span className="-mt-5 text-[11px] font-medium text-slate-600 dark:text-slate-300 tabular-nums">
                          {day.pages}p
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {chartWindow === '7days' ? (
              <div className="flex items-center justify-between gap-3 border-t border-slate-100 dark:border-slate-800 pt-2">
                {stats.last7Days.map((day) => (
                  <div key={day.date} className="flex-1 text-center">
                    <div className="text-xs font-medium text-slate-700 dark:text-slate-300">{day.label}</div>
                    <div className="text-[10px] text-slate-400 tabular-nums">{day.minutes}m</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex items-center justify-between border-t border-slate-100 dark:border-slate-800 pt-2 text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                <span>{monthlyStats.last30Days[0]?.date}</span>
                <span>{monthlyStats.last30Days[14]?.date}</span>
                <span>{monthlyStats.last30Days[monthlyStats.last30Days.length - 1]?.date} (Today)</span>
              </div>
            )}
          </div>
        </section>

        {/* Log Session + Target Configuration */}
        <div className="space-y-4">
          <form
            onSubmit={handleLogSubmit}
            className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3"
          >
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Log Reading Session
            </h2>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="log-pages" className="block text-xs text-slate-500 dark:text-slate-400 mb-1">
                  Pages Read
                </label>
                <input
                  id="log-pages"
                  type="number"
                  min={0}
                  max={500}
                  value={pagesInput}
                  onChange={(e) => setPagesInput(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent text-sm tabular-nums"
                />
              </div>
              <div>
                <label htmlFor="log-minutes" className="block text-xs text-slate-500 dark:text-slate-400 mb-1">
                  Minutes
                </label>
                <input
                  id="log-minutes"
                  type="number"
                  min={0}
                  max={600}
                  value={minutesInput}
                  onChange={(e) => setMinutesInput(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent text-sm tabular-nums"
                />
              </div>
            </div>
            <button
              type="submit"
              className="w-full py-2 px-3 rounded-lg bg-blue-800 text-white text-xs font-medium hover:bg-blue-900 flex items-center justify-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" aria-hidden="true" />
              Record Progress
            </button>
            {logFeedback && <p className="text-xs text-emerald-700 dark:text-emerald-400">{logFeedback}</p>}
          </form>

          <form
            onSubmit={handleTargetsSubmit}
            className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3"
          >
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Adjust Reading Targets
            </h2>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label htmlFor="target-daily" className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">
                  Pages/Day
                </label>
                <input
                  id="target-daily"
                  type="number"
                  min={1}
                  max={1000}
                  value={dailyTarget}
                  onChange={(e) => setDailyTarget(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent text-xs tabular-nums"
                />
              </div>
              <div>
                <label htmlFor="target-weekly" className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">
                  Min/Week
                </label>
                <input
                  id="target-weekly"
                  type="number"
                  min={10}
                  max={5000}
                  value={weeklyTarget}
                  onChange={(e) => setWeeklyTarget(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent text-xs tabular-nums"
                />
              </div>
              <div>
                <label htmlFor="target-yearly" className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">
                  Books/Yr
                </label>
                <input
                  id="target-yearly"
                  type="number"
                  min={1}
                  max={500}
                  value={yearlyTarget}
                  onChange={(e) => setYearlyTarget(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent text-xs tabular-nums"
                />
              </div>
            </div>
            <button
              type="submit"
              className="w-full py-2 px-3 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              Save Goal Targets
            </button>
            {targetSaved && (
              <p className="text-xs text-blue-700 dark:text-blue-400">Targets updated and synchronized.</p>
            )}
          </form>
        </div>
      </div>

      {/* Internal Pomodoro Focus Timer (inspired by Linux Focus Timer) */}
      <PomodoroFocusTimer
        books={books}
        onCompleteFocusBlock={(mins) => onLogActivity(0, mins)}
      />
    </div>
  );
};
