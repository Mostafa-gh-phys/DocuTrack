import type {AppAccentColor, ReaderFontFamily, ReaderTheme, UITheme} from '../types/library';

export const UI_THEMES: {
  id: UITheme;
  label: string;
  isDark: boolean;
  swatchBg: string;
  swatchBorder: string;
}[] = [
  {id: 'light', label: 'Crisp Light', isDark: false, swatchBg: '#F8F9FA', swatchBorder: '#CBD5E1'},
  {id: 'parchment', label: 'Warm Parchment', isDark: false, swatchBg: '#F3EDE0', swatchBorder: '#CBB89D'},
  {id: 'sage', label: 'Botanical Sage', isDark: false, swatchBg: '#EDF2EE', swatchBorder: '#9BB5A2'},
  {id: 'dark', label: 'Deep Slate', isDark: true, swatchBg: '#0B1120', swatchBorder: '#334155'},
  {id: 'obsidian', label: 'True Obsidian', isDark: true, swatchBg: '#06070A', swatchBorder: '#2D3140'},
];

export const ACCENT_COLORS: {id: AppAccentColor; label: string; hex: string}[] = [
  {id: 'cobalt', label: 'Oxford Cobalt', hex: '#1E40AF'},
  {id: 'forest', label: 'Forest Green', hex: '#166534'},
  {id: 'burgundy', label: 'Claret Burgundy', hex: '#881337'},
  {id: 'ochre', label: 'Warm Ochre', hex: '#B45309'},
  {id: 'indigo', label: 'Royal Indigo', hex: '#4338CA'},
  {id: 'graphite', label: 'Monochrome Slate', hex: '#334155'},
];

export const READER_THEMES: Record<
  ReaderTheme,
  {label: string; bg: string; surface: string; text: string; muted: string; border: string; swatch: string; isDark: boolean}
> = {
  paper: {
    label: 'Crisp Paper',
    bg: 'bg-[#FDFCF8]',
    surface: 'bg-white',
    text: 'text-[#1F2937]',
    muted: 'text-slate-500',
    border: 'border-stone-200',
    swatch: '#FDFCF8',
    isDark: false,
  },
  cream: {
    label: 'Ivory Cream',
    bg: 'bg-[#FAF7EC]',
    surface: 'bg-[#FFFDF5]',
    text: 'text-[#2D2A24]',
    muted: 'text-[#6E6758]',
    border: 'border-[#E6DFCA]',
    swatch: '#FAF7EC',
    isDark: false,
  },
  sepia: {
    label: 'Warm Sepia',
    bg: 'bg-[#F4ECD8]',
    surface: 'bg-[#FAF5E8]',
    text: 'text-[#433422]',
    muted: 'text-[#7A664D]',
    border: 'border-[#E2D5B9]',
    swatch: '#F4ECD8',
    isDark: false,
  },
  parchment: {
    label: 'Aged Linen',
    bg: 'bg-[#EFE6D5]',
    surface: 'bg-[#F7F1E4]',
    text: 'text-[#33271B]',
    muted: 'text-[#6D5B47]',
    border: 'border-[#D8C8AE]',
    swatch: '#EFE6D5',
    isDark: false,
  },
  sage: {
    label: 'Quiet Matcha',
    bg: 'bg-[#EBF2EC]',
    surface: 'bg-[#F5F9F6]',
    text: 'text-[#1D2D23]',
    muted: 'text-[#526B5B]',
    border: 'border-[#C8D9CC]',
    swatch: '#EBF2EC',
    isDark: false,
  },
  'solarized-light': {
    label: 'Solarized Day',
    bg: 'bg-[#FDF6E3]',
    surface: 'bg-[#EEE8D5]',
    text: 'text-[#586E75]',
    muted: 'text-[#839496]',
    border: 'border-[#DDD6C1]',
    swatch: '#FDF6E3',
    isDark: false,
  },
  dusk: {
    label: 'Evening Dusk',
    bg: 'bg-[#1E2430]',
    surface: 'bg-[#262D3B]',
    text: 'text-[#D8DEE9]',
    muted: 'text-[#94A3B8]',
    border: 'border-[#353E50]',
    swatch: '#1E2430',
    isDark: true,
  },
  nord: {
    label: 'Nordic Charcoal',
    bg: 'bg-[#242933]',
    surface: 'bg-[#2E3440]',
    text: 'text-[#ECEFF4]',
    muted: 'text-[#9AA5B8]',
    border: 'border-[#3B4252]',
    swatch: '#2E3440',
    isDark: true,
  },
  'solarized-dark': {
    label: 'Solarized Night',
    bg: 'bg-[#002B36]',
    surface: 'bg-[#073642]',
    text: 'text-[#EEE8D5]',
    muted: 'text-[#93A1A1]',
    border: 'border-[#0F4959]',
    swatch: '#002B36',
    isDark: true,
  },
  forest: {
    label: 'Pine Forest',
    bg: 'bg-[#132019]',
    surface: 'bg-[#1A2B22]',
    text: 'text-[#DCE8DF]',
    muted: 'text-[#8BA693]',
    border: 'border-[#273E32]',
    swatch: '#132019',
    isDark: true,
  },
  gruvbox: {
    label: 'Gruvbox Warm',
    bg: 'bg-[#1D2021]',
    surface: 'bg-[#282828]',
    text: 'text-[#EBDBB2]',
    muted: 'text-[#A89984]',
    border: 'border-[#3C3836]',
    swatch: '#282828',
    isDark: true,
  },
  night: {
    label: 'Midnight Blue',
    bg: 'bg-[#0B0F17]',
    surface: 'bg-[#111827]',
    text: 'text-[#E2E8F0]',
    muted: 'text-slate-400',
    border: 'border-slate-800',
    swatch: '#0B0F17',
    isDark: true,
  },
  amoled: {
    label: 'AMOLED Ink',
    bg: 'bg-[#050507]',
    surface: 'bg-[#0E0E12]',
    text: 'text-[#E5E7EB]',
    muted: 'text-zinc-400',
    border: 'border-zinc-800',
    swatch: '#050507',
    isDark: true,
  },
  'high-contrast': {
    label: 'High Contrast',
    bg: 'bg-[#000000]',
    surface: 'bg-[#0A0A0A]',
    text: 'text-[#FFFFFF]',
    muted: 'text-[#D4D4D8]',
    border: 'border-[#52525B]',
    swatch: '#000000',
    isDark: true,
  },
};

export const FONT_OPTIONS: {
  id: ReaderFontFamily;
  label: string;
  category: string;
  cssClass: string;
}[] = [
  {id: 'serif', label: 'Source Serif 4', category: 'Editorial Serif', cssClass: 'font-serif-reader'},
  {id: 'literary', label: 'Lora', category: 'Novel Serif', cssClass: 'font-literary-reader'},
  {id: 'garamond', label: 'EB Garamond', category: 'Classical Book', cssClass: 'font-garamond-reader'},
  {id: 'merriweather', label: 'Merriweather', category: 'Book Print', cssClass: 'font-merriweather-reader'},
  {id: 'sans', label: 'Plus Jakarta Sans', category: 'Modern Sans', cssClass: 'font-sans-reader'},
  {id: 'humanist', label: 'DM Sans', category: 'Humanist Sans', cssClass: 'font-humanist-reader'},
  {id: 'accessible', label: 'Atkinson Hyperlegible', category: 'High Legibility', cssClass: 'font-accessible-reader'},
  {id: 'mono', label: 'JetBrains Mono', category: 'Technical Mono', cssClass: 'font-mono-reader'},
];

export function getReaderFontClass(fontFamily: ReaderFontFamily): string {
  return FONT_OPTIONS.find((f) => f.id === fontFamily)?.cssClass || 'font-serif-reader';
}

export function isDarkUiTheme(uiTheme: UITheme): boolean {
  return uiTheme === 'dark' || uiTheme === 'obsidian';
}
