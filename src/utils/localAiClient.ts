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
    return {valid: true, baseUrl: `${u.origin}${u.pathname === '/' ? '' : u.pathname}`.replace(/\/+$/, '')};
  } catch {
    return {valid: false, error: 'Invalid URL format. Example: http://localhost:11434'};
  }
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
    const res = await fetch(`${check.baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
    const data = (await res.json()) as {models?: Array<{name?: string; model?: string}>};
    return (data.models || [])
      .map((m) => m.name || m.model || '')
      .filter(Boolean);
  }

  // LM Studio & OpenAI-compatible (/v1/models)
  const v1Base = check.baseUrl.endsWith('/v1') ? check.baseUrl : `${check.baseUrl}/v1`;
  const headers: Record<string, string> = {};
  if (config.provider === 'openai-compat' && config.customApiKey.trim()) {
    headers.Authorization = `Bearer ${config.customApiKey.trim()}`;
  }
  const res = await fetch(`${v1Base}/models`, {
    headers,
    signal: AbortSignal.timeout(5000),
  });
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
  const clipped = params.content.slice(0, 18000);
  const count = params.mode === 'summary' ? 3 : 4;
  return {
    system:
      'You are an expert curriculum designer. Respond ONLY with a valid JSON object matching this exact schema: {"title": string, "summary": string, "keyConcepts": string[], "modules": [{"moduleNumber": number, "title": string, "durationMinutes": number, "objectives": string[], "lectureNotes": string, "quizQuestion": string, "quizAnswer": string}]}. Do not include markdown commentary outside the JSON.',
    user: `Transform "${params.title}" by ${params.author} into a ${params.mode === 'summary' ? 'concise 3-module study guide' : `structured ${count}-module lecture course`} strictly grounded in the text below.\n\nDocument text:\n${clipped}`,
  };
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
  if (config.provider === 'gemini') {
    const res = await fetch('/api/ai/course', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(params),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to generate AI course.');
    return {
      title: data.title || `${params.title} — Study Course`,
      summary: data.summary || '',
      keyConcepts: Array.isArray(data.keyConcepts) ? data.keyConcepts : [],
      modules: Array.isArray(data.modules) ? data.modules : [],
    };
  }

  const prompt = buildLocalCoursePrompt(params);

  if (config.provider === 'ollama') {
    const check = validateLocalAiEndpoint(config.ollamaUrl);
    if (!check.valid || !check.baseUrl) throw new Error(check.error || 'Invalid Ollama URL');
    const model = config.ollamaModel.trim();
    if (!model) throw new Error('Select or enter an Ollama model name (e.g. llama3.2).');

    let res: Response;
    try {
      res = await fetch(`${check.baseUrl}/api/chat`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          model,
          stream: false,
          format: 'json',
          messages: [
            {role: 'system', content: prompt.system},
            {role: 'user', content: prompt.user},
          ],
          options: {temperature: 0.3},
        }),
        signal: AbortSignal.timeout(120000),
      });
    } catch {
      throw new Error(
        `Could not reach Ollama at ${check.baseUrl}. Ensure Ollama is running (and set OLLAMA_ORIGINS="*" if calling from an HTTPS browser tab).`,
      );
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Ollama error (HTTP ${res.status}): ${errText.slice(0, 180)}`);
    }
    const json = (await res.json()) as {message?: {content?: string}; response?: string};
    return parseAiCoursePayload(json.message?.content || json.response || '', params.title);
  }

  // LM Studio or Custom OpenAI-Compatible endpoint
  const rawBase = config.provider === 'lmstudio' ? config.lmStudioUrl : config.customBaseUrl;
  const check = validateLocalAiEndpoint(rawBase);
  if (!check.valid || !check.baseUrl) throw new Error(check.error || 'Invalid endpoint URL');
  const v1Base = check.baseUrl.endsWith('/v1') ? check.baseUrl : `${check.baseUrl}/v1`;
  const model =
    (config.provider === 'lmstudio' ? config.lmStudioModel : config.customModel).trim() || 'local-model';

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
      `Could not reach ${config.provider === 'lmstudio' ? 'LM Studio' : 'local AI server'} at ${check.baseUrl}. Verify the local server is started and CORS is enabled.`,
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
