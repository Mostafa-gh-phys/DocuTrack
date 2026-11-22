import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Pause, Play, RotateCcw, SkipForward, Timer, Volume2, VolumeX} from 'lucide-react';
import type {BookMetadata} from '../types/library';
import {
  clampPomodoroSettings,
  DEFAULT_POMODORO_SETTINGS,
  formatTimerSeconds,
  getNextPomodoroTransition,
  getPhaseDurationSeconds,
  getPhaseLabel,
  POMODORO_PRESETS,
  type PomodoroPhase,
  type PomodoroSettings,
} from '../utils/pomodoro';

interface PomodoroFocusTimerProps {
  books: BookMetadata[];
  onCompleteFocusBlock: (minutes: number) => void;
}

const STORAGE_KEY = 'docutrack_focus_timer_v1';

interface PersistedFocusStats {
  date: string;
  completedSessions: number;
  focusedMinutes: number;
  settings: PomodoroSettings;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function loadInitialFocusState(): PersistedFocusStats {
  const today = todayKey();
  if (typeof localStorage === 'undefined') {
    return {date: today, completedSessions: 0, focusedMinutes: 0, settings: DEFAULT_POMODORO_SETTINGS};
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {date: today, completedSessions: 0, focusedMinutes: 0, settings: DEFAULT_POMODORO_SETTINGS};
    }
    const parsed = JSON.parse(raw) as Partial<PersistedFocusStats>;
    const settings = clampPomodoroSettings(parsed.settings || {});
    if (parsed.date !== today) {
      return {date: today, completedSessions: 0, focusedMinutes: 0, settings};
    }
    return {
      date: today,
      completedSessions: Math.max(0, Number(parsed.completedSessions) || 0),
      focusedMinutes: Math.max(0, Number(parsed.focusedMinutes) || 0),
      settings,
    };
  } catch {
    return {date: today, completedSessions: 0, focusedMinutes: 0, settings: DEFAULT_POMODORO_SETTINGS};
  }
}

function playGentleFocusChime(): void {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as {webkitAudioContext?: typeof AudioContext}).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const notes = [523.25, 659.25];
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = ctx.currentTime + idx * 0.16;
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.exponentialRampToValueAtTime(0.11, start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.45);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.48);
    });
    window.setTimeout(() => {
      void ctx.close().catch(() => {});
    }, 1200);
  } catch {
    // Audio playback optional if blocked by autoplay policy
  }
}

export const PomodoroFocusTimer: React.FC<PomodoroFocusTimerProps> = ({
  books,
  onCompleteFocusBlock,
}) => {
  const initial = useMemo(() => loadInitialFocusState(), []);
  const [settings, setSettings] = useState<PomodoroSettings>(initial.settings);
  const [phase, setPhase] = useState<PomodoroPhase>('focus');
  const [secondsLeft, setSecondsLeft] = useState(() =>
    getPhaseDurationSeconds('focus', initial.settings),
  );
  const [running, setRunning] = useState(false);
  const [roundsInCycle, setRoundsInCycle] = useState(0);
  const [completedToday, setCompletedToday] = useState(initial.completedSessions);
  const [focusedMinutesToday, setFocusedMinutesToday] = useState(initial.focusedMinutes);
  const [linkedBookId, setLinkedBookId] = useState<string>(books[0]?.id || '');
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Persist timer settings + today's stats
  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          date: todayKey(),
          completedSessions: completedToday,
          focusedMinutes: focusedMinutesToday,
          settings,
        }),
      );
    } catch {
      // Ignore quota restrictions
    }
  }, [completedToday, focusedMinutesToday, settings]);

  const finishCurrentPhase = (autoContinue = false) => {
    const activeSettings = settingsRef.current;
    const transition = getNextPomodoroTransition({
      phase,
      completedRoundsInCycle: roundsInCycle,
      settings: activeSettings,
    });

    if (activeSettings.soundEnabled) {
      playGentleFocusChime();
    }

    if (transition.completedFocusWork) {
      setCompletedToday((c) => c + 1);
      setFocusedMinutesToday((m) => m + activeSettings.focusMinutes);
      if (activeSettings.autoLogToReadingMinutes) {
        onCompleteFocusBlock(activeSettings.focusMinutes);
      }
      setSessionNotice(
        `Completed ${activeSettings.focusMinutes}-minute focus block. Time for a ${
          transition.nextPhase === 'longBreak' ? 'long' : 'short'
        } break.`,
      );
    } else {
      setSessionNotice('Break complete — ready for your next focus session.');
    }

    setPhase(transition.nextPhase);
    setRoundsInCycle(transition.nextRoundsInCycle);
    setSecondsLeft(getPhaseDurationSeconds(transition.nextPhase, activeSettings));
    setRunning(autoContinue);
  };

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [running]);

  useEffect(() => {
    if (running && secondsLeft === 0) {
      finishCurrentPhase(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, secondsLeft]);

  const selectPhase = (nextPhase: PomodoroPhase) => {
    setRunning(false);
    setPhase(nextPhase);
    setSecondsLeft(getPhaseDurationSeconds(nextPhase, settings));
    setSessionNotice(null);
  };

  const applyPreset = (presetId: string) => {
    const preset = POMODORO_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    const next = clampPomodoroSettings({
      ...settings,
      focusMinutes: preset.focusMinutes,
      shortBreakMinutes: preset.shortBreakMinutes,
      longBreakMinutes: preset.longBreakMinutes,
      roundsBeforeLongBreak: preset.roundsBeforeLongBreak,
    });
    setSettings(next);
    setRunning(false);
    setSecondsLeft(getPhaseDurationSeconds(phase, next));
  };

  const updateNumericSetting = (
    key: 'focusMinutes' | 'shortBreakMinutes' | 'longBreakMinutes' | 'roundsBeforeLongBreak',
    raw: string,
  ) => {
    const val = Number(raw);
    const next = clampPomodoroSettings({...settings, [key]: val});
    setSettings(next);
    if (!running) {
      setSecondsLeft(getPhaseDurationSeconds(phase, next));
    }
  };

  const totalPhaseSeconds = getPhaseDurationSeconds(phase, settings);
  const progressRatio = totalPhaseSeconds > 0 ? (totalPhaseSeconds - secondsLeft) / totalPhaseSeconds : 0;
  const radius = 84;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * (1 - Math.max(0, Math.min(1, progressRatio)));
  const linkedBook = books.find((b) => b.id === linkedBookId);

  return (
    <section
      aria-label="Focus Timer Pomodoro Workspace"
      className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-100 dark:border-slate-800">
        <div className="flex items-center gap-2.5">
          <Timer className="w-5 h-5 accent-text" aria-hidden="true" />
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Focus Timer (Pomodoro Method)
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Distraction-free Pomodoro intervals inspired by Linux Focus Timer — credit completed focus blocks directly to your weekly reading time.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs tabular-nums text-slate-600 dark:text-slate-300">
          <span>{completedToday} sessions today</span>
          <span aria-hidden="true">·</span>
          <span>{focusedMinutesToday} focused min</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
        {/* Left/Center Circular Countdown Dial (GNOME Focus Timer / Solanum inspired) */}
        <div className="lg:col-span-7 flex flex-col items-center space-y-5">
          {/* Phase Switcher */}
          <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800">
            {(
              [
                {id: 'focus', label: 'Focus'},
                {id: 'shortBreak', label: 'Short Break'},
                {id: 'longBreak', label: 'Long Break'},
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                aria-pressed={phase === tab.id}
                onClick={() => selectPhase(tab.id)}
                className={`px-3.5 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                  phase === tab.id
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Minimalist SVG Dial Ring */}
          <div className="relative w-52 h-52 flex items-center justify-center">
            <svg className="w-full h-full -rotate-90" viewBox="0 0 200 200" aria-hidden="true">
              <circle
                cx="100"
                cy="100"
                r={radius}
                fill="none"
                stroke="currentColor"
                strokeWidth="8"
                className="text-slate-100 dark:text-slate-800"
              />
              <circle
                cx="100"
                cy="100"
                r={radius}
                fill="none"
                stroke="currentColor"
                strokeWidth="8"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={strokeDashoffset}
                className={
                  phase === 'focus'
                    ? 'text-blue-700 dark:text-blue-500 transition-[stroke-dashoffset] duration-300'
                    : phase === 'shortBreak'
                      ? 'text-emerald-600 dark:text-emerald-500 transition-[stroke-dashoffset] duration-300'
                      : 'text-amber-600 dark:text-amber-500 transition-[stroke-dashoffset] duration-300'
                }
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
              <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                {getPhaseLabel(phase)}
              </span>
              <span
                data-testid="pomodoro-clock"
                className="mt-1 text-4xl font-bold font-mono tabular-nums tracking-tight text-slate-900 dark:text-slate-100"
              >
                {formatTimerSeconds(secondsLeft)}
              </span>
              <div className="mt-2.5 flex items-center gap-1.5" aria-label={`Round ${roundsInCycle} of ${settings.roundsBeforeLongBreak}`}>
                {Array.from({length: settings.roundsBeforeLongBreak}, (_, idx) => (
                  <span
                    key={idx}
                    className={`w-2 h-2 rounded-full transition-colors ${
                      idx < roundsInCycle
                        ? 'bg-blue-700 dark:bg-blue-400'
                        : 'bg-slate-200 dark:bg-slate-700'
                    }`}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Primary Transport Controls */}
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => {
                setSessionNotice(null);
                setRunning((prev) => !prev);
              }}
              className="px-6 py-2.5 rounded-lg accent-btn text-xs font-semibold flex items-center gap-2 transition-colors whitespace-nowrap"
            >
              {running ? (
                <>
                  <Pause className="w-4 h-4" aria-hidden="true" />
                  Pause
                </>
              ) : (
                <>
                  <Play className="w-4 h-4" aria-hidden="true" />
                  Start {phase === 'focus' ? 'Focus' : 'Break'}
                </>
              )}
            </button>

            <button
              type="button"
              onClick={() => {
                setRunning(false);
                setSecondsLeft(getPhaseDurationSeconds(phase, settings));
                setSessionNotice(null);
              }}
              aria-label="Reset timer"
              className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              <RotateCcw className="w-4 h-4" aria-hidden="true" />
            </button>

            <button
              type="button"
              onClick={() => finishCurrentPhase(false)}
              aria-label="Skip to next phase"
              className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              <SkipForward className="w-4 h-4" aria-hidden="true" />
            </button>

            <button
              type="button"
              onClick={() =>
                setSettings((prev) => ({...prev, soundEnabled: !prev.soundEnabled}))
              }
              aria-label={settings.soundEnabled ? 'Mute chime' : 'Enable chime'}
              className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              {settings.soundEnabled ? (
                <Volume2 className="w-4 h-4" aria-hidden="true" />
              ) : (
                <VolumeX className="w-4 h-4 opacity-50" aria-hidden="true" />
              )}
            </button>
          </div>

          {sessionNotice && (
            <p className="text-xs text-emerald-700 dark:text-emerald-400 text-center">
              {sessionNotice}
            </p>
          )}
        </div>

        {/* Right Column: Presets, Durations & Study Target */}
        <div className="lg:col-span-5 space-y-5 border-t lg:border-t-0 lg:border-l border-slate-100 dark:border-slate-800 pt-5 lg:pt-0 lg:pl-7">
          <div className="space-y-2">
            <span className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              Cadence Presets
            </span>
            <div className="flex flex-wrap gap-1.5">
              {POMODORO_PRESETS.map((preset) => {
                const active =
                  settings.focusMinutes === preset.focusMinutes &&
                  settings.shortBreakMinutes === preset.shortBreakMinutes;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => applyPreset(preset.id)}
                    className={`px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap ${
                      active
                        ? 'accent-border accent-soft'
                        : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'
                    }`}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-2 gap-3 text-xs">
            <div>
              <label htmlFor="pomo-focus-min" className="block text-slate-500 dark:text-slate-400 mb-1">
                Focus (min)
              </label>
              <input
                id="pomo-focus-min"
                type="number"
                min={1}
                max={180}
                value={settings.focusMinutes}
                onChange={(e) => updateNumericSetting('focusMinutes', e.target.value)}
                className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent tabular-nums"
              />
            </div>
            <div>
              <label htmlFor="pomo-short-min" className="block text-slate-500 dark:text-slate-400 mb-1">
                Short Break
              </label>
              <input
                id="pomo-short-min"
                type="number"
                min={1}
                max={60}
                value={settings.shortBreakMinutes}
                onChange={(e) => updateNumericSetting('shortBreakMinutes', e.target.value)}
                className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent tabular-nums"
              />
            </div>
            <div>
              <label htmlFor="pomo-long-min" className="block text-slate-500 dark:text-slate-400 mb-1">
                Long Break
              </label>
              <input
                id="pomo-long-min"
                type="number"
                min={1}
                max={90}
                value={settings.longBreakMinutes}
                onChange={(e) => updateNumericSetting('longBreakMinutes', e.target.value)}
                className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent tabular-nums"
              />
            </div>
            <div>
              <label htmlFor="pomo-rounds" className="block text-slate-500 dark:text-slate-400 mb-1">
                Cycles / Long
              </label>
              <input
                id="pomo-rounds"
                type="number"
                min={2}
                max={10}
                value={settings.roundsBeforeLongBreak}
                onChange={(e) => updateNumericSetting('roundsBeforeLongBreak', e.target.value)}
                className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent tabular-nums"
              />
            </div>
          </div>

          {books.length > 0 && (
            <div className="space-y-1.5 text-xs">
              <label htmlFor="pomo-book-select" className="block text-slate-500 dark:text-slate-400">
                Active Study Document
              </label>
              <select
                id="pomo-book-select"
                value={linkedBookId}
                onChange={(e) => setLinkedBookId(e.target.value)}
                className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200"
              >
                <option value="">General deep reading</option>
                {books.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.title}
                  </option>
                ))}
              </select>
              {linkedBook && (
                <p className="text-[11px] text-slate-400 truncate">
                  Focused on: {linkedBook.title} ({linkedBook.format.toUpperCase()})
                </p>
              )}
            </div>
          )}

          <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.autoLogToReadingMinutes}
              onChange={(e) =>
                setSettings((prev) => ({
                  ...prev,
                  autoLogToReadingMinutes: e.target.checked,
                }))
              }
            />
            <span>Automatically add completed focus blocks to Weekly Reading Time</span>
          </label>
        </div>
      </div>
    </section>
  );
};
