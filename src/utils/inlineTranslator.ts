export interface WebTranslatorLink {
  id: 'google' | 'deepl' | 'bing' | 'reverso';
  label: string;
  url: string;
}

export interface InlineTranslationOutcome {
  method: 'system-translator' | 'web-links';
  translatedText?: string;
  sourceLanguage?: string;
  targetLanguageLabel: string;
  targetLangCode: string;
  note: string;
  links: WebTranslatorLink[];
}

const LANGUAGE_TO_ISO: Record<string, string> = {
  English: 'en',
  Spanish: 'es',
  French: 'fr',
  German: 'de',
  Persian: 'fa',
  Japanese: 'ja',
  Chinese: 'zh',
  Arabic: 'ar',
  Portuguese: 'pt',
  Korean: 'ko',
  Italian: 'it',
  Russian: 'ru',
  Turkish: 'tr',
  Hindi: 'hi',
};

export function resolveTranslatorLanguageCode(languageLabel: string): string {
  return LANGUAGE_TO_ISO[languageLabel] || 'es';
}

export function buildWebTranslatorLinks(
  rawText: string,
  targetLanguageLabel: string,
): WebTranslatorLink[] {
  const code = resolveTranslatorLanguageCode(targetLanguageLabel);
  const clipped = (rawText || '').trim().slice(0, 1800);

  const googleUrl = new URL('https://translate.google.com/');
  googleUrl.searchParams.set('sl', 'auto');
  googleUrl.searchParams.set('tl', code);
  googleUrl.searchParams.set('text', clipped);
  googleUrl.searchParams.set('op', 'translate');

  const deeplCode = code === 'zh' ? 'zh-hans' : code === 'pt' ? 'pt-pt' : code;
  const deeplUrl = new URL('https://www.deepl.com/translator');
  deeplUrl.hash = `#auto/${encodeURIComponent(deeplCode)}/${encodeURIComponent(clipped)}`;

  const bingUrl = new URL('https://www.bing.com/translator');
  bingUrl.searchParams.set('from', 'auto');
  bingUrl.searchParams.set('to', code === 'zh' ? 'zh-Hans' : code);
  bingUrl.searchParams.set('text', clipped);

  const reversoUrl = new URL('https://www.reverso.net/text-translation');
  reversoUrl.hash = `#sl=auto&tl=${encodeURIComponent(code)}&text=${encodeURIComponent(clipped.slice(0, 900))}`;

  return [
    {id: 'google', label: 'Open in Google Translate', url: googleUrl.toString()},
    {id: 'deepl', label: 'Open in DeepL Translator', url: deeplUrl.toString()},
    {id: 'bing', label: 'Open in Bing Translator', url: bingUrl.toString()},
    {id: 'reverso', label: 'Open in Reverso Context', url: reversoUrl.toString()},
  ];
}

interface BrowserTranslatorInstance {
  translate(input: string): Promise<string>;
  destroy?: () => void;
}

interface BrowserTranslatorApi {
  availability?: (opts: {sourceLanguage: string; targetLanguage: string}) => Promise<string>;
  create(opts: {sourceLanguage: string; targetLanguage: string}): Promise<BrowserTranslatorInstance>;
}

export function isSystemTranslatorAvailable(): boolean {
  const g = globalThis as unknown as {Translator?: BrowserTranslatorApi; translation?: {createTranslator?: unknown}};
  return Boolean(g.Translator && typeof g.Translator.create === 'function');
}

export async function translateWithSystemOrWeb(
  rawText: string,
  targetLanguageLabel: string,
  sourceLangCode = 'en',
): Promise<InlineTranslationOutcome> {
  const clipped = (rawText || '').trim().slice(0, 2000);
  const targetLangCode = resolveTranslatorLanguageCode(targetLanguageLabel);
  const links = buildWebTranslatorLinks(clipped, targetLanguageLabel);

  if (!clipped) {
    return {
      method: 'web-links',
      targetLanguageLabel,
      targetLangCode,
      note: 'Select a passage in the document or paste text above to translate.',
      links,
    };
  }

  const g = globalThis as unknown as {Translator?: BrowserTranslatorApi};
  if (g.Translator && typeof g.Translator.create === 'function') {
    const src = sourceLangCode === targetLangCode ? 'en' : sourceLangCode;
    const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Translator timeout')), ms);
        promise.then(
          (val) => {
            clearTimeout(timer);
            resolve(val);
          },
          (err) => {
            clearTimeout(timer);
            reject(err);
          },
        );
      });

    try {
      let allowed = true;
      if (typeof g.Translator.availability === 'function') {
        const status = await withTimeout(
          g.Translator.availability({
            sourceLanguage: src,
            targetLanguage: targetLangCode,
          }),
          1500,
        );
        if (status !== 'available' && status !== 'readily' && status !== 'yes') {
          allowed = false;
        }
      }

      if (allowed) {
        const translator = await withTimeout(
          g.Translator.create({
            sourceLanguage: src,
            targetLanguage: targetLangCode,
          }),
          2500,
        );
        try {
          const translatedText = await withTimeout(translator.translate(clipped), 2500);
          if (translatedText && translatedText.trim()) {
            return {
              method: 'system-translator',
              translatedText: translatedText.trim(),
              sourceLanguage: src.toUpperCase(),
              targetLanguageLabel,
              targetLangCode,
              note: 'Translated locally using your browser on-device Translator engine (no AI JSON needed).',
              links,
            };
          }
        } finally {
          translator.destroy?.();
        }
      }
    } catch {
      // Fall through gracefully to verified external web links
    }
  }

  return {
    method: 'web-links',
    targetLanguageLabel,
    targetLangCode,
    note: 'Direct web translation links ready below (no AI or JSON required). Click any provider to view the translation safely in a new tab.',
    links,
  };
}
