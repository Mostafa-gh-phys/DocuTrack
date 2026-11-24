import type {CourseModule} from '../types/library';

export type AiCourseProvider = 'gemini' | 'ollama' | 'lmstudio' | 'openai-compat';

export interface LocalAiConfig {
  provider: AiCourseProvider;
  ollamaUrl: string;
  ollamaModel: string;
  lmStudioUrl: string;
  lmStudioModel: string;
  customBaseUrl: string;
  customModel: string;
  customApiKey: string;
}

export const DEFAULT_LOCAL_AI_CONFIG: LocalAiConfig = {
  provider: 'gemini',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'llama3.2',
  lmStudioUrl: 'http://localhost:1234',
  lmStudioModel: '',
  customBaseUrl: 'http://localhost:8080',
  customModel: '',
  customApiKey: '',
};

const STORAGE_KEY = 'docutrack_ai_course_provider_v1';

export function loadLocalAiConfig(): LocalAiConfig {
  if (typeof localStorage === 'undefined') return DEFAULT_LOCAL_AI_CONFIG;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_LOCAL_AI_CONFIG;
    const parsed = JSON.parse(raw) as Partial<LocalAiConfig>;
    return {
      ...DEFAULT_LOCAL_AI_CONFIG,
      ...parsed,
    };
  } catch {
    return DEFAULT_LOCAL_AI_CONFIG;
  }
}

export function saveLocalAiConfig(config: LocalAiConfig): void {
  if (typeof localStorage === 'undefined') return;
  try {
    // Keep customApiKey ephemeral if desired; store endpoint + model choices cleanly
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...config,
        customApiKey: '',
      }),
    );
  } catch {
    // Ignore storage quota restrictions
  }
}

export function validateLocalAiEndpoint(rawUrl: string): {valid: boolean; baseUrl?: string; error?: string} {
  const trimmed = (rawUrl || '').trim().replace(/\/+$/, '');
  if (!trimmed) {
    return {valid: false, error: 'Enter the local AI server URL (e.g. http://localhost:11434).'};
  }
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return {valid: false, error: 'Only HTTP and HTTPS endpoints are supported.'};
    }
    const cleanPath = (u.pathname === '/' ? '' : u.pathname).replace(/\/+$/, '');
    return {valid: true, baseUrl: `${u.origin}${cleanPath}`};
  } catch {
    return {valid: false, error: 'Invalid URL format. Example: http://localhost:11434'};
  }
}

function getOllamaRoot(baseUrl: string): string {
  return baseUrl.replace(/\/(api|v1)$/i, '').replace(/\/+$/, '');
}

function getOpenAiV1Root(baseUrl: string): string {
  const stripped = baseUrl.replace(/\/api$/i, '').replace(/\/+$/, '');
  return stripped.endsWith('/v1') ? stripped : `${stripped}/v1`;
}

function buildLocalNetworkHelpHint(providerLabel: string, baseUrl: string): string {
  const isHttpsPage =
    typeof window !== 'undefined' &&
    window.location?.protocol === 'https:' &&
    baseUrl.startsWith('http://');
  if (isHttpsPage) {
    return `Browser security blocked HTTP call to ${providerLabel} (${baseUrl}) from an HTTPS page. Allow insecure local connections for this site or run DocuTrack on http://localhost / the desktop app, and enable CORS (${providerLabel === 'Ollama' ? 'OLLAMA_ORIGINS="*"' : 'CORS = ON'}).`;
  }
  return `Could not reach ${providerLabel} at ${baseUrl}. Ensure the local server is running and CORS is enabled (${providerLabel === 'Ollama' ? 'OLLAMA_ORIGINS="*"' : 'Enable CORS in Server Settings'}).`;
}

export interface GeneratedCoursePayload {
  title: string;
  summary: string;
  keyConcepts: string[];
  modules: CourseModule[];
}

/**
 * Extracts and normalizes structured course JSON from either strict JSON or markdown-fenced LLM output.
 */
export function parseAiCoursePayload(rawText: string, fallbackTitle: string): GeneratedCoursePayload {
  let cleaned = (rawText || '').trim();

  // Strip ```json ... ``` fences if present
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // Locate outermost JSON object braces
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    parsed = null;
  }

  if (parsed && typeof parsed === 'object') {
    const title =
      typeof parsed.title === 'string' && parsed.title.trim()
        ? parsed.title.trim()
        : `${fallbackTitle} — Study Course`;
    const summary =
      typeof parsed.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim()
        : rawText.slice(0, 800).trim();
    const keyConcepts = Array.isArray(parsed.keyConcepts)
      ? parsed.keyConcepts.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 12)
      : [];

    const rawMods = Array.isArray(parsed.modules) ? parsed.modules : [];
    const modules: CourseModule[] = rawMods
      .map((m, idx): CourseModule | null => {
        if (!m || typeof m !== 'object') return null;
        const rec = m as Record<string, unknown>;
        return {
          moduleNumber: typeof rec.moduleNumber === 'number' && rec.moduleNumber > 0 ? Math.round(rec.moduleNumber) : idx + 1,
          title: typeof rec.title === 'string' && rec.title.trim() ? rec.title.trim() : `Module ${idx + 1}`,
          durationMinutes: typeof rec.durationMinutes === 'number' && rec.durationMinutes > 0 ? Math.round(rec.durationMinutes) : 15,
          objectives: Array.isArray(rec.objectives)
            ? rec.objectives.filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
            : [],
          lectureNotes: typeof rec.lectureNotes === 'string' ? rec.lectureNotes.trim() : '',
          quizQuestion: typeof rec.quizQuestion === 'string' ? rec.quizQuestion.trim() : 'Summarize the key idea of this module.',
          quizAnswer: typeof rec.quizAnswer === 'string' ? rec.quizAnswer.trim() : 'Refer to the core lecture notes above.',
        };
      })
      .filter((m): m is CourseModule => m !== null);

    if (modules.length > 0) {
      return {title, summary, keyConcepts, modules};
    }
  }

  // Fallback structured conversion if a small local model responded in prose
  const cleanProse = (rawText || '').trim();
  if (!cleanProse) {
    throw new Error('Local model returned an empty response.');
  }
  const paragraphs = cleanProse.split(/\n{2,}/).filter((p) => p.trim().length > 20);
  return {
    title: `${fallbackTitle} — Local AI Study Guide`,
    summary: paragraphs[0] || cleanProse.slice(0, 500),
    keyConcepts: [fallbackTitle],
    modules: (paragraphs.length > 1 ? paragraphs.slice(1, 5) : [cleanProse]).map((p, idx) => ({
      moduleNumber: idx + 1,
      title: `Section ${idx + 1}`,
      durationMinutes: 15,
      objectives: [`Understand key takeaways from section ${idx + 1}`],
      lectureNotes: p.trim(),
      quizQuestion: `What is the central point covered in Section ${idx + 1}?`,
      quizAnswer: p.trim().slice(0, 220),
    })),
  };
}

export async function fetchLocalAiModels(config: LocalAiConfig): Promise<string[]> {
  if (config.provider === 'gemini') return ['gemini-4-hydrogen'];

  const rawUrl =
    config.provider === 'ollama'
      ? config.ollamaUrl
      : config.provider === 'lmstudio'
        ? config.lmStudioUrl
        : config.customBaseUrl;

  const check = validateLocalAiEndpoint(rawUrl);
  if (!check.valid || !check.baseUrl) {
    throw new Error(check.error || 'Invalid local AI endpoint.');
  }

  if (config.provider === 'ollama') {
    const root = getOllamaRoot(check.baseUrl);
    let res: Response;
    try {
      res = await fetch(`${root}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new Error(buildLocalNetworkHelpHint('Ollama', root));
    }
    if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
    const data = (await res.json()) as {models?: Array<{name?: string; model?: string}>};
    return (data.models || [])
      .map((m) => m.name || m.model || '')
      .filter(Boolean);
  }

  // LM Studio & OpenAI-compatible (/v1/models)
  const v1Base = getOpenAiV1Root(check.baseUrl);
  const headers: Record<string, string> = {};
  if (config.provider === 'openai-compat' && config.customApiKey.trim()) {
    headers.Authorization = `Bearer ${config.customApiKey.trim()}`;
  }
  let res: Response;
  try {
    res = await fetch(`${v1Base}/models`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new Error(
      buildLocalNetworkHelpHint(config.provider === 'lmstudio' ? 'LM Studio' : 'Local AI Server', check.baseUrl),
    );
  }
  if (!res.ok) throw new Error(`Local OpenAI server returned HTTP ${res.status}`);
  const data = (await res.json()) as {data?: Array<{id?: string}>};
  return (data.data || []).map((m) => m.id || '').filter(Boolean);
}

function buildLocalCoursePrompt(params: {
  title: string;
  author: string;
  content: string;
  mode: 'course' | 'summary';
}): {system: string; user: string} {
  const safeContent =
    params.content && params.content.trim().length >= 20
      ? params.content.slice(0, 18000)
      : `Book Metadata:\nTitle: ${params.title}\nAuthor: ${params.author}\n\n${params.content || ''}`.trim();
  const count = params.mode === 'summary' ? 3 : 4;
  return {
    system:
      'You are an expert curriculum designer. Respond ONLY with a valid JSON object matching this exact schema: {"title": string, "summary": string, "keyConcepts": string[], "modules": [{"moduleNumber": number, "title": string, "durationMinutes": number, "objectives": string[], "lectureNotes": string, "quizQuestion": string, "quizAnswer": string}]}. Do not include markdown commentary outside the JSON.',
    user: `Transform "${params.title}" by ${params.author} into a ${params.mode === 'summary' ? 'concise 3-module study guide' : `structured ${count}-module lecture course`} grounded in the text below.\n\nDocument text:\n${safeContent}`,
  };
}

async function resolveTargetModelName(config: LocalAiConfig): Promise<string> {
  const explicit =
    config.provider === 'ollama'
      ? config.ollamaModel.trim()
      : config.provider === 'lmstudio'
        ? config.lmStudioModel.trim()
        : config.customModel.trim();

  if (explicit && explicit !== 'local-model') return explicit;

  try {
    const models = await fetchLocalAiModels(config);
    if (models.length > 0) return models[0];
  } catch (err) {
    if (config.provider === 'ollama') throw err;
  }

  if (config.provider === 'lmstudio') {
    return 'local-model';
  }
  throw new Error(
    `Select or enter a loaded model name for ${config.provider === 'ollama' ? 'Ollama' : 'your local AI server'}.`,
  );
}

export async function generateCourseWithProvider(
  config: LocalAiConfig,
  params: {
    title: string;
    author: string;
    content: string;
    mode: 'course' | 'summary';
  },
): Promise<GeneratedCoursePayload> {
  const normalizedContent =
    (params.content || '').trim().length >= 20
      ? params.content.trim()
      : `Title: ${params.title || 'Untitled Document'}\nAuthor: ${params.author || 'Unknown'}\n${params.content || ''}`.trim();

  if (config.provider === 'gemini') {
    const res = await fetch('/api/ai/course', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({...params, content: normalizedContent}),
    });
    const raw = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      throw new Error(res.ok ? 'Received malformed JSON from Cloud AI service.' : `Cloud AI error (HTTP ${res.status}): ${raw.slice(0, 140)}`);
    }
    if (!res.ok) {
      throw new Error(typeof data.error === 'string' && data.error ? data.error : `Cloud Gemini failed (HTTP ${res.status}).`);
    }
    return {
      title: typeof data.title === 'string' && data.title ? data.title : `${params.title} — Study Course`,
      summary: typeof data.summary === 'string' ? data.summary : '',
      keyConcepts: Array.isArray(data.keyConcepts) ? data.keyConcepts : [],
      modules: Array.isArray(data.modules) ? (data.modules as CourseModule[]) : [],
    };
  }

  const prompt = buildLocalCoursePrompt({...params, content: normalizedContent});

  if (config.provider === 'ollama') {
    const check = validateLocalAiEndpoint(config.ollamaUrl);
    if (!check.valid || !check.baseUrl) throw new Error(check.error || 'Invalid Ollama URL');
    const root = getOllamaRoot(check.baseUrl);
    const model = await resolveTargetModelName(config);

    const callOllama = async (useJsonFormat: boolean): Promise<Response> => {
      try {
        return await fetch(`${root}/api/chat`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            model,
            stream: false,
            ...(useJsonFormat ? {format: 'json'} : {}),
            messages: [
              {role: 'system', content: prompt.system},
              {role: 'user', content: prompt.user},
            ],
            options: {temperature: 0.3},
          }),
          signal: AbortSignal.timeout(120000),
        });
      } catch {
        throw new Error(buildLocalNetworkHelpHint('Ollama', root));
      }
    };

    let res = await callOllama(true);
    if (!res.ok && res.status === 400) {
      // Retry without strict format='json' for models/versions that disallow JSON grammar mode
      res = await callOllama(false);
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Ollama error (HTTP ${res.status}): ${errText.slice(0, 180)}`);
    }
    const json = (await res.json()) as {message?: {content?: string}; response?: string};
    const rawOut = json.message?.content || json.response || '';
    if (!rawOut.trim()) {
      const retry = await callOllama(false);
      if (retry.ok) {
        const retryJson = (await retry.json()) as {message?: {content?: string}; response?: string};
        return parseAiCoursePayload(retryJson.message?.content || retryJson.response || '', params.title);
      }
    }
    return parseAiCoursePayload(rawOut, params.title);
  }

  // LM Studio or Custom OpenAI-Compatible endpoint
  const rawBase = config.provider === 'lmstudio' ? config.lmStudioUrl : config.customBaseUrl;
  const check = validateLocalAiEndpoint(rawBase);
  if (!check.valid || !check.baseUrl) throw new Error(check.error || 'Invalid endpoint URL');
  const v1Base = getOpenAiV1Root(check.baseUrl);
  const model = await resolveTargetModelName(config);

  const headers: Record<string, string> = {'Content-Type': 'application/json'};
  if (config.provider === 'openai-compat' && config.customApiKey.trim()) {
    headers.Authorization = `Bearer ${config.customApiKey.trim()}`;
  }

  let res: Response;
  try {
    res = await fetch(`${v1Base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        temperature: 0.3,
        messages: [
          {role: 'system', content: prompt.system},
          {role: 'user', content: prompt.user},
        ],
      }),
      signal: AbortSignal.timeout(120000),
    });
  } catch {
    throw new Error(
      buildLocalNetworkHelpHint(config.provider === 'lmstudio' ? 'LM Studio' : 'local AI server', check.baseUrl),
    );
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Local AI server returned HTTP ${res.status}: ${errText.slice(0, 180)}`);
  }
  const data = (await res.json()) as {choices?: Array<{message?: {content?: string}}>};
  const content = data.choices?.[0]?.message?.content || '';
  return parseAiCoursePayload(content, params.title);
}
