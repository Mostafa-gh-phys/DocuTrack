import 'dotenv/config';
import dns from 'node:dns/promises';
import net from 'node:net';
import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import {fileURLToPath} from 'url';
import {GoogleGenAI, ThinkingLevel, Type} from '@google/genai';
import {
  buildLibgenSearchUrl,
  DEFAULT_LIBGEN_MIRRORS,
  extractDiscoveredMirrorsFromHtml,
  extractLibgenDirectUrls,
  inferMirrorEngine,
  parseLibgenSearchHtml,
  type LibgenMirrorCandidate,
  type LibgenMirrorStatus,
} from './src/utils/libgenParser';
import {parseAiCoursePayload} from './src/utils/localAiClient';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function extractReadableGeminiError(err: unknown): {status: number; message: string; retryable: boolean} {
  const raw = err instanceof Error ? err.message : String(err || 'Gemini request failed');
  const isTimeout =
    (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) ||
    /timed out|aborted|ETIMEDOUT/i.test(raw);
  let status = isTimeout ? 504 : 502;
  let message = isTimeout ? 'Cloud Gemini request timed out under heavy load.' : raw;
  try {
    const parsed = JSON.parse(raw) as {error?: {code?: number; message?: string; status?: string}};
    if (parsed?.error) {
      if (typeof parsed.error.code === 'number') status = parsed.error.code;
      if (typeof parsed.error.message === 'string' && parsed.error.message.trim()) {
        message = parsed.error.message.trim();
      }
    }
  } catch {
    if (!isTimeout) {
      const statusMatch = raw.match(/\b(400|403|404|429|500|502|503|504)\b/);
      if (statusMatch) status = Number(statusMatch[1]);
    }
  }
  const retryable =
    isTimeout ||
    status === 503 ||
    status === 429 ||
    status === 504 ||
    /UNAVAILABLE|high demand|RESOURCE_EXHAUSTED|timeout|fetch failed/i.test(raw);
  return {status, message, retryable};
}

async function generateTextWithRetry(
  ai: GoogleGenAI,
  buildRequest: (model: string, abortSignal: AbortSignal) => Parameters<GoogleGenAI['models']['generateContent']>[0],
) {
  const models = ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'];
  let lastError: unknown;

  for (let mIdx = 0; mIdx < models.length; mIdx++) {
    const model = models[mIdx];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Gemini upstream call timed out')), 14000);
    try {
      const req = buildRequest(model, controller.signal);
      const result = await Promise.race([
        ai.models.generateContent(req),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener(
            'abort',
            () => reject(new Error('Gemini upstream call timed out')),
            {once: true},
          );
        }),
      ]);
      return result;
    } catch (err) {
      lastError = err;
      const info = extractReadableGeminiError(err);
      if (!info.retryable) throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

function isLoopbackIp(rawIp: string | undefined): boolean {
  if (!rawIp) return false;
  let ip = rawIp.trim().toLowerCase();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip === '127.0.0.1' || ip === '::1';
}

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

interface SearchChunkInput {
  bookId: string;
  bookTitle: string;
  page: number;
  text: string;
}

function isPrivateOrReservedIp(rawIp: string): boolean {
  let ip = rawIp.trim().toLowerCase();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1' || ip === '::' || ip === '0.0.0.0') return true;
  if (net.isIPv6(ip)) {
    // Block loopback, link-local (fe80::/10), unique-local (fc00::/7), multicast
    if (ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb') || ip.startsWith('ff')) {
      return true;
    }
    return false;
  }
  if (!net.isIPv4(ip)) return true;
  const parts = ip.split('.').map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // Cloud metadata / link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

async function assertSafeExternalUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('Invalid remote endpoint URL.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only HTTP and HTTPS remote endpoints are allowed.');
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new Error('Private or local network hostnames are blocked.');
  }
  if (net.isIP(host)) {
    if (isPrivateOrReservedIp(host)) {
      throw new Error('Private, loopback, or metadata IP addresses are blocked.');
    }
    return parsed;
  }
  const records = await dns.lookup(host, {all: true});
  if (!records || records.length === 0) {
    throw new Error(`Could not resolve remote host "${host}".`);
  }
  for (const rec of records) {
    if (isPrivateOrReservedIp(rec.address)) {
      throw new Error('Remote endpoint resolves to a private or reserved network address.');
    }
  }
  return parsed;
}

async function fetchExternalChecked(
  initialUrl: string,
  init: RequestInit,
  maxRedirects = 2,
): Promise<Response> {
  let currentUrl = initialUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const validated = await assertSafeExternalUrl(currentUrl);
    const res = await fetch(validated.toString(), {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc || hop === maxRedirects) {
        throw new Error(`Remote endpoint returned unexpected redirect (HTTP ${res.status}).`);
      }
      currentUrl = new URL(loc, validated).toString();
      continue;
    }
    return res;
  }
  throw new Error('Too many redirects from remote endpoint.');
}

async function startServer() {
  const app = express();
  const port = Number(process.env.PORT) || 3000;

  const standardJson = express.json({limit: '4mb'});
  const syncJson = express.json({limit: '12mb'});
  app.use((req, res, next) => {
    if (req.path === '/api/cloud/custom-sync') {
      syncJson(req, res, next);
    } else {
      standardJson(req, res, next);
    }
  });

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      aiConfigured: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'),
    });
  });

  // 1. AI Lecture Course & Summary Generation
  app.post('/api/ai/course', async (req, res) => {
    const ai = createGeminiClient();
    if (!ai) {
      res.status(503).json({
        error: 'Gemini API key is not configured on the server. Set GEMINI_API_KEY in Settings > Secrets.',
      });
      return;
    }

    const {title, author, content, mode} = req.body as {
      title?: string;
      author?: string;
      content?: string;
      mode?: 'course' | 'summary';
    };

    const normalizedContent =
      (typeof content === 'string' && content.trim().length >= 20
        ? content.trim()
        : `Title: ${title || 'Untitled Document'}\nAuthor: ${author || 'Unknown'}\n${typeof content === 'string' ? content.trim() : ''}`.trim());

    if (!normalizedContent || normalizedContent.length < 3) {
      res.status(400).json({error: 'Document title or content is required to generate a study course.'});
      return;
    }

    const clippedContent = normalizedContent.slice(0, 32000);
    const prompt =
      mode === 'summary'
        ? `Analyze the document "${title || 'Untitled'}" by ${author || 'Unknown'} and produce a crisp executive summary, key concepts, and a structured 3-module study guide.\n\nDocument excerpt:\n${clippedContent}`
        : `Transform the document "${title || 'Untitled'}" by ${author || 'Unknown'} into a comprehensive, well-paced lecture course with an executive summary, core concepts, and 4 progressive lecture modules. Each module should have clear learning objectives, detailed lecture notes grounded in the source text, key takeaways, and a comprehension check question with its answer.\n\nDocument text:\n${clippedContent}`;

    try {
      const response = await generateTextWithRetry(ai, (model, abortSignal) => ({
        model,
        contents: prompt,
        config: {
          abortSignal,
          systemInstruction:
            'You are an expert academic curriculum designer and research synthesizer. Ground every module, summary, and quiz in the provided document text or metadata. Write clear, structured, scholarly prose.',
          ...(model === 'gemini-4-hydrogen' ? {thinkingConfig: {thinkingLevel: ThinkingLevel.LOW}} : {}),
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              title: {type: Type.STRING, description: 'Course or study guide title'},
              summary: {type: Type.STRING, description: 'Executive summary (2-3 cohesive paragraphs)'},
              keyConcepts: {
                type: Type.ARRAY,
                items: {type: Type.STRING},
                description: '5 to 8 concise core concepts from the document',
              },
              modules: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    moduleNumber: {type: Type.INTEGER},
                    title: {type: Type.STRING},
                    durationMinutes: {type: Type.INTEGER},
                    objectives: {
                      type: Type.ARRAY,
                      items: {type: Type.STRING},
                    },
                    lectureNotes: {type: Type.STRING},
                    quizQuestion: {type: Type.STRING},
                    quizAnswer: {type: Type.STRING},
                  },
                  required: [
                    'moduleNumber',
                    'title',
                    'durationMinutes',
                    'objectives',
                    'lectureNotes',
                    'quizQuestion',
                    'quizAnswer',
                  ],
                },
              },
            },
            required: ['title', 'summary', 'keyConcepts', 'modules'],
          },
        },
      }));

      const rawText = (response.text ?? '').trim();
      const parsed = parseAiCoursePayload(rawText || '{}', title || 'Study Course');
      res.json(parsed);
    } catch (error) {
      const info = extractReadableGeminiError(error);
      console.error('Gemini course generation error:', info.message);
      res.status(info.status >= 400 && info.status < 600 ? info.status : 502).json({
        error: `${info.message} You can also switch Study Course AI Engine to Ollama or LM Studio to run offline with local models.`,
      });
    }
  });

  // 1b. Strict Loopback-Only Proxy for Local Ollama / LM Studio (avoids browser CORS failures on localhost)
  app.post('/api/ai/local-proxy', async (req, res) => {
    const reqHost = String(req.headers.host || '').split(':')[0].toLowerCase();
    if (!isLoopbackIp(req.socket.remoteAddress) || (reqHost !== 'localhost' && reqHost !== '127.0.0.1')) {
      res.status(403).json({error: 'Local AI proxy is restricted to loopback desktop sessions.'});
      return;
    }

    const {targetUrl, method, headers, body} = (req.body || {}) as {
      targetUrl?: string;
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
    };
    if (!targetUrl || typeof targetUrl !== 'string') {
      res.status(400).json({error: 'Missing local target URL.'});
      return;
    }
    const upperMethod = (method || 'GET').toUpperCase();
    if (upperMethod !== 'GET' && upperMethod !== 'POST') {
      res.status(400).json({error: 'Unsupported HTTP method.'});
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(targetUrl.trim());
    } catch {
      res.status(400).json({error: 'Invalid local AI endpoint URL.'});
      return;
    }

    const host = parsed.hostname.toLowerCase();
    const isTargetLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    if (!isTargetLoopback || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      res.status(400).json({error: 'Local proxy only permits loopback Ollama/LM Studio endpoints.'});
      return;
    }
    const cleanPath = parsed.pathname.replace(/\/+$/, '');
    const allowedPaths = new Set(['/api/tags', '/api/chat', '/v1/models', '/v1/chat/completions']);
    if (!allowedPaths.has(cleanPath)) {
      res.status(400).json({error: 'Unsupported local AI endpoint path.'});
      return;
    }

    const forwardedHeaders: Record<string, string> = {};
    if (upperMethod === 'POST') {
      forwardedHeaders['Content-Type'] = 'application/json';
    }
    if (headers && typeof headers.Authorization === 'string' && headers.Authorization.startsWith('Bearer ')) {
      forwardedHeaders.Authorization = headers.Authorization.slice(0, 512);
    }

    try {
      const upstream = await fetch(parsed.toString(), {
        method: upperMethod,
        headers: forwardedHeaders,
        body: upperMethod === 'POST' && body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(120000),
      });
      const text = await upstream.text();
      res.status(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text);
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Local AI runtime unreachable on loopback.',
      });
    }
  });

  // 2. Online Translation in Document
  app.post('/api/ai/translate', async (req, res) => {
    const ai = createGeminiClient();
    if (!ai) {
      res.status(503).json({
        error: 'Gemini API key is not configured on the server. Set GEMINI_API_KEY in Settings > Secrets.',
      });
      return;
    }

    const {text, targetLanguage, contextTitle} = req.body as {
      text?: string;
      targetLanguage?: string;
      contextTitle?: string;
    };

    if (!text || typeof text !== 'string' || !text.trim()) {
      res.status(400).json({error: 'Text to translate is required.'});
      return;
    }
    if (!targetLanguage || typeof targetLanguage !== 'string') {
      res.status(400).json({error: 'Target language is required.'});
      return;
    }

    try {
      const response = await generateTextWithRetry(ai, (model, abortSignal) => ({
        model,
        contents: `Translate the following passage from "${contextTitle || 'Document'}" into ${targetLanguage}. Preserve technical accuracy, tone, and paragraph structure.\n\nPassage:\n${text.slice(0, 8000)}`,
        config: {
          abortSignal,
          systemInstruction:
            'You are a literary and technical translator. Return accurate, natural translation along with detected source language and up to 4 brief domain-term notes if helpful.',
          ...(model === 'gemini-4-hydrogen' ? {thinkingConfig: {thinkingLevel: ThinkingLevel.LOW}} : {}),
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              detectedLanguage: {type: Type.STRING},
              translatedText: {type: Type.STRING},
              glossaryNotes: {
                type: Type.ARRAY,
                items: {type: Type.STRING},
              },
            },
            required: ['detectedLanguage', 'translatedText', 'glossaryNotes'],
          },
        },
      }));

      const parsed = JSON.parse((response.text ?? '{}').trim());
      res.json(parsed);
    } catch (error) {
      const info = extractReadableGeminiError(error);
      console.error('Gemini translation error:', info.message);
      res.status(info.status >= 400 && info.status < 600 ? info.status : 502).json({error: info.message});
    }
  });

  // 3. Semantic Search via Gemini Embeddings + Conceptual Match Explanation
  app.post('/api/ai/semantic-search', async (req, res) => {
    const ai = createGeminiClient();
    if (!ai) {
      res.status(503).json({
        error: 'Gemini API key is not configured on the server.',
      });
      return;
    }

    const {query, chunks} = req.body as {
      query?: string;
      chunks?: SearchChunkInput[];
    };

    if (!query || !query.trim() || !Array.isArray(chunks) || chunks.length === 0) {
      res.status(400).json({error: 'Search query and document chunks are required.'});
      return;
    }

    const limitedChunks = chunks.slice(0, 40);

    try {
      const contentsToEmbed = [
        query.trim(),
        ...limitedChunks.map((c) => `${c.bookTitle} (p.${c.page}): ${c.text.slice(0, 1200)}`),
      ];

      const embedResponse = await ai.models.embedContent({
        model: 'gemini-embedding-2',
        contents: contentsToEmbed,
      });

      const embeddings = embedResponse.embeddings || [];
      const queryVec = embeddings[0]?.values || [];

      const scored = limitedChunks
        .map((chunk, idx) => {
          const vec = embeddings[idx + 1]?.values || [];
          const similarity = cosineSimilarity(queryVec, vec);
          return {
            ...chunk,
            score: Math.round(similarity * 1000) / 1000,
          };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);

      // Generate concise semantic rationale for top hits
      let reasons: Record<string, string> = {};
      try {
        const reasonPrompt = `Query: "${query.trim()}"\nExplain in one short phrase (max 12 words) why each passage below is semantically relevant to the query.\n${scored
          .slice(0, 5)
          .map((s, i) => `[${i}] ${s.bookTitle} p.${s.page}: ${s.text.slice(0, 320)}`)
          .join('\n')}`;
        const reasonRes = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: reasonPrompt,
          config: {
            thinkingConfig: {thinkingLevel: ThinkingLevel.LOW},
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                explanations: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      index: {type: Type.INTEGER},
                      reason: {type: Type.STRING},
                    },
                    required: ['index', 'reason'],
                  },
                },
              },
              required: ['explanations'],
            },
          },
        });
        const reasonJson = JSON.parse((reasonRes.text ?? '{}').trim()) as {
          explanations?: {index: number; reason: string}[];
        };
        for (const item of reasonJson.explanations || []) {
          reasons[String(item.index)] = item.reason;
        }
      } catch {
        // Non-fatal: vector scores still succeed
      }

      res.json({
        mode: 'semantic-embedding',
        results: scored.map((item, idx) => ({
          bookId: item.bookId,
          bookTitle: item.bookTitle,
          page: item.page,
          snippet: item.text.slice(0, 260),
          score: item.score,
          reason: reasons[String(idx)] || 'High semantic vector similarity',
        })),
      });
    } catch (error) {
      console.error('Gemini semantic search error:', error);
      const message = error instanceof Error ? error.message : 'Semantic search failed.';
      res.status(502).json({error: message});
    }
  });

  // 4. Custom Cloud Storage Sync Proxy (WebDAV / Nextcloud / ownCloud / Custom HTTPS JSON)
  app.post('/api/cloud/custom-sync', async (req, res) => {
    const {action, provider, targetUrl, authType, username, secret, archive} = (req.body || {}) as {
      action?: 'test' | 'pull' | 'push';
      provider?: 'webdav' | 'custom-json';
      targetUrl?: string;
      authType?: 'basic' | 'bearer' | 'none';
      username?: string;
      secret?: string;
      archive?: unknown;
    };

    if (action !== 'test' && action !== 'pull' && action !== 'push') {
      res.status(400).json({error: 'Invalid sync action.'});
      return;
    }
    if (!targetUrl || typeof targetUrl !== 'string') {
      res.status(400).json({error: 'Remote target URL is required.'});
      return;
    }

    const headers: Record<string, string> = {};
    if (authType === 'basic' && (username || secret)) {
      const token = Buffer.from(`${username || ''}:${secret || ''}`, 'utf8').toString('base64');
      headers.Authorization = `Basic ${token}`;
    } else if (authType === 'bearer' && secret) {
      headers.Authorization = `Bearer ${secret}`;
    }

    try {
      await assertSafeExternalUrl(targetUrl);

      if (action === 'test') {
        let remoteRes = await fetchExternalChecked(targetUrl, {
          method: provider === 'webdav' ? 'PROPFIND' : 'HEAD',
          headers: provider === 'webdav' ? {...headers, Depth: '0'} : headers,
        });
        if (remoteRes.status === 405 || remoteRes.status === 501) {
          remoteRes = await fetchExternalChecked(targetUrl, {
            method: 'GET',
            headers,
          });
        }
        if (remoteRes.status === 401 || remoteRes.status === 403) {
          res.json({
            ok: false,
            status: remoteRes.status,
            message: `Authentication rejected by server (HTTP ${remoteRes.status}). Check username / app password or token.`,
          });
          return;
        }
        const ok = (remoteRes.status >= 200 && remoteRes.status < 400) || remoteRes.status === 404;
        res.json({
          ok,
          status: remoteRes.status,
          message: ok
            ? remoteRes.status === 404
              ? 'Endpoint reachable (remote file will be created on first sync).'
              : `Connected successfully (HTTP ${remoteRes.status}).`
            : `Remote server returned HTTP ${remoteRes.status}.`,
        });
        return;
      }

      if (action === 'pull') {
        const remoteRes = await fetchExternalChecked(targetUrl, {
          method: 'GET',
          headers: {...headers, Accept: 'application/json'},
        });
        if (remoteRes.status === 404) {
          res.json({found: false});
          return;
        }
        if (!remoteRes.ok) {
          res.status(remoteRes.status >= 400 && remoteRes.status < 600 ? remoteRes.status : 502).json({
            error: `Pull failed: remote endpoint returned HTTP ${remoteRes.status}.`,
          });
          return;
        }
        const text = await remoteRes.text();
        if (!text.trim()) {
          res.json({found: false});
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          res.status(502).json({error: 'Remote sync endpoint did not return valid JSON.'});
          return;
        }
        res.json({found: true, archive: parsed});
        return;
      }

      // action === 'push'
      if (!archive || typeof archive !== 'object') {
        res.status(400).json({error: 'Valid backup archive payload is required for push.'});
        return;
      }
      const bodyText = JSON.stringify(archive);

      if (provider === 'webdav') {
        const lastSlash = targetUrl.lastIndexOf('/');
        if (lastSlash > 8) {
          const parentDir = targetUrl.slice(0, lastSlash);
          try {
            await fetchExternalChecked(parentDir, {method: 'MKCOL', headers});
          } catch {
            // Directory already exists or server disallows redundant MKCOL
          }
        }
      }

      const remoteRes = await fetchExternalChecked(targetUrl, {
        method: 'PUT',
        headers: {
          ...headers,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: bodyText,
      });
      if (!remoteRes.ok) {
        res.status(remoteRes.status >= 400 && remoteRes.status < 600 ? remoteRes.status : 502).json({
          error: `Push failed: remote server returned HTTP ${remoteRes.status}.`,
        });
        return;
      }
      res.json({
        status: remoteRes.status,
        uploadedBytes: Buffer.byteLength(bodyText, 'utf8'),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Custom cloud sync request failed.';
      const status = /blocked|invalid|required/i.test(msg) ? 400 : 502;
      res.status(status).json({error: msg});
    }
  });

  // 5. LibGen Mirror Auto-Discovery, Search & Verified File Fetch
  app.post('/api/libgen/mirrors', async (req, res) => {
    const {customMirror} = (req.body || {}) as {customMirror?: string};
    const candidates: LibgenMirrorCandidate[] = [...DEFAULT_LIBGEN_MIRRORS];

    if (customMirror && typeof customMirror === 'string' && customMirror.trim()) {
      try {
        const safeCustom = await assertSafeExternalUrl(customMirror.trim());
        const normalized = safeCustom.origin;
        if (!candidates.some((c) => c.url.toLowerCase() === normalized.toLowerCase())) {
          candidates.unshift({
            url: normalized,
            label: `${safeCustom.hostname} (Custom)`,
            engine: inferMirrorEngine(normalized),
          });
        }
      } catch (err) {
        res.status(400).json({
          error: err instanceof Error ? err.message : 'Invalid custom mirror URL.',
        });
        return;
      }
    }

    // Attempt lightweight auto-discovery of any newly listed mirrors from Wikipedia mirror table if reachable
    let discoveredCount = 0;
    try {
      const wikiRes = await fetchExternalChecked(
        'https://en.wikipedia.org/wiki/Library_Genesis',
        {method: 'GET', headers: {'User-Agent': 'DocuTrack/1.0'}},
        1,
      );
      if (wikiRes.ok) {
        const wikiHtml = await wikiRes.text();
        const extra = extractDiscoveredMirrorsFromHtml(wikiHtml);
        for (const item of extra) {
          if (!candidates.some((c) => c.url.toLowerCase() === item.url.toLowerCase())) {
            candidates.push(item);
            discoveredCount++;
          }
        }
      }
    } catch {
      // Optional discovery fallback
    }

    const probeOne = async (candidate: LibgenMirrorCandidate): Promise<LibgenMirrorStatus> => {
      const started = Date.now();
      try {
        const validated = await assertSafeExternalUrl(candidate.url);
        const probeRes = await fetch(validated.toString(), {
          method: 'GET',
          headers: {'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) DocuTrack/1.0'},
          redirect: 'follow',
          signal: AbortSignal.timeout(4500),
        });
        const latencyMs = Date.now() - started;
        if (!probeRes.ok) {
          return {...candidate, open: false, latencyMs, statusCode: probeRes.status, error: `HTTP ${probeRes.status}`};
        }
        const snippet = (await probeRes.text()).slice(0, 14000);
        const looksLikeLibgen = /libgen|library genesis|search\.php|index\.php|<form/i.test(snippet);
        return {
          ...candidate,
          open: looksLikeLibgen,
          latencyMs,
          statusCode: probeRes.status,
          error: looksLikeLibgen ? undefined : 'Unexpected response page',
        };
      } catch (err) {
        return {
          ...candidate,
          open: false,
          latencyMs: null,
          error: err instanceof Error ? err.message : 'Unreachable',
        };
      }
    };

    const probed = await Promise.all(candidates.slice(0, 10).map(probeOne));
    probed.sort((a, b) => {
      if (a.open !== b.open) return a.open ? -1 : 1;
      return (a.latencyMs ?? 99999) - (b.latencyMs ?? 99999);
    });
    const bestMirror = probed.find((m) => m.open)?.url || null;
    res.json({mirrors: probed, bestMirror, discoveredCount});
  });

  app.get('/api/libgen/search', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const requestedMirror = typeof req.query.mirror === 'string' ? req.query.mirror.trim() : '';
    const column = (typeof req.query.column === 'string' ? req.query.column : 'def') as
      | 'def'
      | 'title'
      | 'author'
      | 'identifier'
      | 'publisher';
    const limit = Number(req.query.limit) || 50;

    if (!q || q.length < 2) {
      res.status(400).json({error: 'Search query must be at least 2 characters.'});
      return;
    }

    const mirrorList: string[] = [];
    if (requestedMirror) {
      try {
        const parsed = await assertSafeExternalUrl(requestedMirror);
        mirrorList.push(parsed.origin);
      } catch (err) {
        res.status(400).json({error: err instanceof Error ? err.message : 'Invalid mirror URL.'});
        return;
      }
    }
    for (const def of DEFAULT_LIBGEN_MIRRORS) {
      if (!mirrorList.includes(def.url)) mirrorList.push(def.url);
    }

    let lastError = 'All probed LibGen mirrors failed to respond.';
    for (const mirrorOrigin of mirrorList.slice(0, 4)) {
      try {
        const searchUrl = buildLibgenSearchUrl(mirrorOrigin, q, column, limit);
        const searchRes = await fetchExternalChecked(
          searchUrl,
          {
            method: 'GET',
            headers: {
              'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) DocuTrack/1.0',
              Accept: 'text/html,application/xhtml+xml',
            },
          },
          2,
        );
        if (!searchRes.ok) {
          lastError = `${mirrorOrigin} returned HTTP ${searchRes.status}`;
          continue;
        }
        const html = await searchRes.text();
        const results = parseLibgenSearchHtml(html, mirrorOrigin);
        res.json({usedMirror: mirrorOrigin, results});
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : `Failed querying ${mirrorOrigin}`;
      }
    }

    res.status(502).json({error: lastError});
  });

  app.post('/api/libgen/download', async (req, res) => {
    const {downloadPageUrl, mirrorOrigin, title, extension} = (req.body || {}) as {
      md5?: string;
      downloadPageUrl?: string;
      mirrorOrigin?: string;
      title?: string;
      extension?: string;
    };

    if (!downloadPageUrl || typeof downloadPageUrl !== 'string') {
      res.status(400).json({error: 'Download page URL is required.'});
      return;
    }

    const MAX_DOWNLOAD_BYTES = 120 * 1024 * 1024;
    try {
      await assertSafeExternalUrl(downloadPageUrl);
      const landingRes = await fetchExternalChecked(
        downloadPageUrl,
        {
          method: 'GET',
          headers: {'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) DocuTrack/1.0'},
        },
        2,
      );
      if (!landingRes.ok) {
        res.status(502).json({error: `Download mirror returned HTTP ${landingRes.status}.`});
        return;
      }

      const contentType = (landingRes.headers.get('content-type') || '').toLowerCase();
      let fileRes: Response = landingRes;

      // If landing URL returned HTML (library.lol / ads.php), extract the direct GET binary link
      if (contentType.includes('text/html')) {
        const html = await landingRes.text();
        const directUrls = extractLibgenDirectUrls(html, landingRes.url || downloadPageUrl);
        if (directUrls.length === 0) {
          res.status(502).json({
            error: `No direct file link found on ${mirrorOrigin || 'mirror'} download page. Open the mirror link externally.`,
          });
          return;
        }

        let fetchedFile: Response | null = null;
        for (const candidateUrl of directUrls.slice(0, 4)) {
          try {
            await assertSafeExternalUrl(candidateUrl);
            const attempt = await fetchExternalChecked(
              candidateUrl,
              {
                method: 'GET',
                headers: {'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) DocuTrack/1.0'},
              },
              3,
            );
            const ct = (attempt.headers.get('content-type') || '').toLowerCase();
            if (attempt.ok && !ct.includes('text/html')) {
              fetchedFile = attempt;
              break;
            }
          } catch {
            // Try next candidate mirror link
          }
        }
        if (!fetchedFile) {
          res.status(502).json({error: 'Direct file mirrors rejected the download request.'});
          return;
        }
        fileRes = fetchedFile;
      }

      const contentLen = Number(fileRes.headers.get('content-length') || 0);
      if (contentLen > MAX_DOWNLOAD_BYTES) {
        res.status(413).json({error: 'File exceeds DocuTrack 120 MB direct download safety cap.'});
        return;
      }

      const arrayBuf = await fileRes.arrayBuffer();
      if (arrayBuf.byteLength > MAX_DOWNLOAD_BYTES) {
        res.status(413).json({error: 'Downloaded file exceeds 120 MB safety cap.'});
        return;
      }

      const cleanTitle = (title || 'document').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'document';
      const cleanExt = (extension || 'pdf').toLowerCase().replace(/[^a-z0-9]/g, '') || 'pdf';
      const filename = `${cleanTitle}.${cleanExt}`;

      res.setHeader('Content-Type', fileRes.headers.get('content-type') || 'application/octet-stream');
      res.setHeader('X-Filename', encodeURIComponent(filename));
      res.send(Buffer.from(arrayBuf));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Download failed.';
      res.status(/blocked|invalid|required/i.test(msg) ? 400 : 502).json({error: msg});
    }
  });

  const httpServer = http.createServer(app);

  if (process.env.NODE_ENV !== 'production') {
    const disableHmr = process.env.DISABLE_HMR === 'true';
    const {createServer: createViteServer} = await import('vite');
    const vite = await createViteServer({
      plugins: disableHmr
        ? [
            {
              name: 'disable-vite-client-ws-when-hmr-off',
              enforce: 'post',
              transform(code, id) {
                if (id.includes('vite/dist/client/client.mjs')) {
                  return code.replace(
                    'let wsTransport = createWebSocketModuleRunnerTransport({',
                    'let wsTransport = { connect() {}, disconnect() {}, send() {} }; if (false) createWebSocketModuleRunnerTransport({',
                  );
                }
              },
            },
          ]
        : [],
      server: {
        middlewareMode: true,
        hmr: !disableHmr,
        ws: disableHmr ? false : {server: httpServer},
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`DocuTrack server running at http://localhost:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
