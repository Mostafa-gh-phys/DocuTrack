import React from 'react';
import {Check, Palette, Type, X} from 'lucide-react';
import type {ReaderPreferences} from '../types/library';
import {ACCENT_COLORS, FONT_OPTIONS, READER_THEMES, UI_THEMES} from '../utils/themeTokens';

interface AppearanceDialogProps {
  open: boolean;
  preferences: ReaderPreferences;
  onUpdatePreferences: (next: ReaderPreferences) => void;
  onClose: () => void;
}

export const AppearanceDialog: React.FC<AppearanceDialogProps> = ({
  open,
  preferences,
  onUpdatePreferences,
  onClose,
}) => {
  if (!open) return null;

  const activeAccent = preferences.accentColor || 'cobalt';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="appearance-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/45 backdrop-blur-xs"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl max-h-[88vh] overflow-y-auto rounded-2xl border app-border app-surface p-6 space-y-6 shadow-xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <Palette className="w-5 h-5 accent-text" aria-hidden="true" />
            <div>
              <h2 id="appearance-dialog-title" className="text-base font-semibold">
                Themes, Accent Colors &amp; Typography
              </h2>
              <p className="text-xs opacity-70">
                Customize both your workspace atmosphere and default reading typeface.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close appearance settings"
            className="p-1.5 rounded-lg opacity-60 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/10"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* App Workspace Theme */}
        <section className="space-y-2.5">
          <h3 className="text-xs font-semibold uppercase tracking-wide opacity-70">
            Workspace Theme
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
            {UI_THEMES.map((t) => {
              const active = preferences.uiTheme === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() =>
                    onUpdatePreferences({...preferences, uiTheme: t.id, updatedAtMs: Date.now()})
                  }
                  className={`p-2.5 rounded-xl border text-left transition-all ${
                    active ? 'accent-border ring-2 ring-offset-1 ring-current' : 'app-border'
                  }`}
                >
                  <div
                    className="h-8 w-full rounded-lg border mb-2 flex items-center justify-end px-2"
                    style={{backgroundColor: t.swatchBg, borderColor: t.swatchBorder}}
                  >
                    {active && <Check className="w-3.5 h-3.5 text-blue-600" aria-hidden="true" />}
                  </div>
                  <div className="text-xs font-medium truncate">{t.label}</div>
                </button>
              );
            })}
          </div>
        </section>

        {/* Accent Palette */}
        <section className="space-y-2.5">
          <h3 className="text-xs font-semibold uppercase tracking-wide opacity-70">
            Accent Palette
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
            {ACCENT_COLORS.map((acc) => {
              const active = activeAccent === acc.id;
              return (
                <button
                  key={acc.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() =>
                    onUpdatePreferences({...preferences, accentColor: acc.id, updatedAtMs: Date.now()})
                  }
                  className={`px-3 py-2.5 rounded-xl border flex items-center gap-2.5 text-xs font-medium transition-colors ${
                    active ? 'accent-border accent-soft' : 'app-border hover:bg-black/5 dark:hover:bg-white/5'
                  }`}
                >
                  <span
                    className="w-4 h-4 rounded-full shrink-0 border border-black/15"
                    style={{backgroundColor: acc.hex}}
                  />
                  <span className="truncate">{acc.label}</span>
                </button>
              );
            })}
          </div>
        </section>

        {/* Curated Fonts */}
        <section className="space-y-2.5">
          <div className="flex items-center gap-2">
            <Type className="w-3.5 h-3.5 opacity-65" aria-hidden="true" />
            <h3 className="text-xs font-semibold uppercase tracking-wide opacity-70">
              Reading Typeface
            </h3>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {FONT_OPTIONS.map((f) => {
              const active = preferences.fontFamily === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() =>
                    onUpdatePreferences({...preferences, fontFamily: f.id, updatedAtMs: Date.now()})
                  }
                  className={`px-3.5 py-2.5 rounded-xl border text-left flex items-center justify-between gap-3 transition-colors ${
                    active ? 'accent-border accent-soft' : 'app-border hover:bg-black/5 dark:hover:bg-white/5'
                  }`}
                >
                  <div className="min-w-0">
                    <div className={`text-sm font-semibold truncate ${f.cssClass}`}>{f.label}</div>
                    <div className="text-[11px] opacity-65">{f.category}</div>
                  </div>
                  <span className={`text-base opacity-70 shrink-0 ${f.cssClass}`}>Ag</span>
                </button>
              );
            })}
          </div>
        </section>

        {/* Reader Paper Surface */}
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide opacity-70">
              Default Reader Surface ({Object.keys(READER_THEMES).length} Themes)
            </h3>
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={preferences.applyThemeToDocument !== false}
                onChange={(e) =>
                  onUpdatePreferences({
                    ...preferences,
                    applyThemeToDocument: e.target.checked,
                    updatedAtMs: Date.now(),
                  })
                }
              />
              <span>Extend theme to document pages</span>
            </label>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {(Object.keys(READER_THEMES) as Array<keyof typeof READER_THEMES>).map((key) => {
              const item = READER_THEMES[key];
              const active = preferences.theme === key;
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={active}
                  onClick={() =>
                    onUpdatePreferences({...preferences, theme: key, updatedAtMs: Date.now()})
                  }
                  className={`px-3 py-2 rounded-xl border text-xs font-medium flex items-center gap-2 ${
                    active ? 'accent-border accent-soft' : 'app-border'
                  }`}
                >
                  <span
                    className="w-3.5 h-3.5 rounded-full border border-black/20 shrink-0"
                    style={{backgroundColor: item.swatch}}
                  />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
};
