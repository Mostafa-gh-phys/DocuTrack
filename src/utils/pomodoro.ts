export type PomodoroPhase = 'focus' | 'shortBreak' | 'longBreak';

export interface PomodoroSettings {
  focusMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  roundsBeforeLongBreak: number;
  autoLogToReadingMinutes: boolean;
  soundEnabled: boolean;
}

export interface PomodoroPreset {
  id: string;
  label: string;
  focusMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  roundsBeforeLongBreak: number;
}

export const DEFAULT_POMODORO_SETTINGS: PomodoroSettings = {
  focusMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  roundsBeforeLongBreak: 4,
  autoLogToReadingMinutes: true,
  soundEnabled: true,
};

export const POMODORO_PRESETS: PomodoroPreset[] = [
  {
    id: 'classic',
    label: 'Classic (25 / 5)',
    focusMinutes: 25,
    shortBreakMinutes: 5,
    longBreakMinutes: 15,
    roundsBeforeLongBreak: 4,
  },
  {
    id: 'deep',
    label: 'Deep Study (50 / 10)',
    focusMinutes: 50,
    shortBreakMinutes: 10,
    longBreakMinutes: 20,
    roundsBeforeLongBreak: 3,
  },
  {
    id: 'sprint',
    label: 'Quick Sprint (15 / 3)',
    focusMinutes: 15,
    shortBreakMinutes: 3,
    longBreakMinutes: 10,
    roundsBeforeLongBreak: 4,
  },
];

export function clampPomodoroSettings(raw: Partial<PomodoroSettings>): PomodoroSettings {
  const focus = Math.max(1, Math.min(180, Math.round(Number(raw.focusMinutes) || DEFAULT_POMODORO_SETTINGS.focusMinutes)));
  const shortB = Math.max(1, Math.min(60, Math.round(Number(raw.shortBreakMinutes) || DEFAULT_POMODORO_SETTINGS.shortBreakMinutes)));
  const longB = Math.max(1, Math.min(90, Math.round(Number(raw.longBreakMinutes) || DEFAULT_POMODORO_SETTINGS.longBreakMinutes)));
  const rounds = Math.max(2, Math.min(10, Math.round(Number(raw.roundsBeforeLongBreak) || DEFAULT_POMODORO_SETTINGS.roundsBeforeLongBreak)));
  return {
    focusMinutes: focus,
    shortBreakMinutes: shortB,
    longBreakMinutes: longB,
    roundsBeforeLongBreak: rounds,
    autoLogToReadingMinutes: raw.autoLogToReadingMinutes ?? DEFAULT_POMODORO_SETTINGS.autoLogToReadingMinutes,
    soundEnabled: raw.soundEnabled ?? DEFAULT_POMODORO_SETTINGS.soundEnabled,
  };
}

export function getPhaseDurationSeconds(phase: PomodoroPhase, settings: PomodoroSettings): number {
  const safe = clampPomodoroSettings(settings);
  if (phase === 'focus') return safe.focusMinutes * 60;
  if (phase === 'shortBreak') return safe.shortBreakMinutes * 60;
  return safe.longBreakMinutes * 60;
}

export function formatTimerSeconds(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const mins = Math.floor(clamped / 60);
  const secs = clamped % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function getPhaseLabel(phase: PomodoroPhase): string {
  if (phase === 'focus') return 'Focus Session';
  if (phase === 'shortBreak') return 'Short Break';
  return 'Long Break';
}

export function getNextPomodoroTransition(params: {
  phase: PomodoroPhase;
  completedRoundsInCycle: number;
  settings: PomodoroSettings;
}): {
  nextPhase: PomodoroPhase;
  nextRoundsInCycle: number;
  completedFocusWork: boolean;
} {
  const safe = clampPomodoroSettings(params.settings);
  if (params.phase === 'focus') {
    const nextCount = params.completedRoundsInCycle + 1;
    if (nextCount >= safe.roundsBeforeLongBreak) {
      return {
        nextPhase: 'longBreak',
        nextRoundsInCycle: nextCount,
        completedFocusWork: true,
      };
    }
    return {
      nextPhase: 'shortBreak',
      nextRoundsInCycle: nextCount,
      completedFocusWork: true,
    };
  }
  if (params.phase === 'longBreak') {
    return {
      nextPhase: 'focus',
      nextRoundsInCycle: 0,
      completedFocusWork: false,
    };
  }
  return {
    nextPhase: 'focus',
    nextRoundsInCycle: params.completedRoundsInCycle,
    completedFocusWork: false,
  };
}
