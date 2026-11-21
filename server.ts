import 'dotenv/config';
import dns from 'node:dns/promises';
import net from 'node:net';
import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import {fileURLToPath} from 'url';
import {GoogleGenAI, ThinkingLevel, Type} from '@google/genai';

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

    if (!content || typeof content !== 'string' || content.trim().length < 20) {
      res.status(400).json({error: 'Document content is required (minimum 20 characters).'});
      return;
    }

    const clippedContent = content.slice(0, 32000);
    const prompt =
      mode === 'summary'
        ? `Analyze the document "${title || 'Untitled'}" by ${author || 'Unknown'} and produce a crisp executive summary, key concepts, and a structured 3-module study guide.\n\nDocument excerpt:\n${clippedContent}`
        : `Transform the document "${title || 'Untitled'}" by ${author || 'Unknown'} into a comprehensive, well-paced lecture course with an executive summary, core concepts, and 4 progressive lecture modules. Each module should have clear learning objectives, detailed lecture notes grounded in the source text, key takeaways, and a comprehension check question with its answer.\n\nDocument text:\n${clippedContent}`;

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: prompt,
        config: {
          systemInstruction:
            'You are an expert academic curriculum designer and research synthesizer. Ground every module, summary, and quiz strictly in the provided document text. Write clear, structured, scholarly prose.',
          thinkingConfig: {thinkingLevel: ThinkingLevel.LOW},
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
      });

      const parsed = JSON.parse((response.text ?? '{}').trim());
      res.json(parsed);
    } catch (error) {
      console.error('Gemini course generation error:', error);
      const message = error instanceof Error ? error.message : 'Failed to generate AI course.';
      res.status(502).json({error: message});
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
      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: `Translate the following passage from "${contextTitle || 'Document'}" into ${targetLanguage}. Preserve technical accuracy, tone, and paragraph structure.\n\nPassage:\n${text.slice(0, 8000)}`,
        config: {
          systemInstruction:
            'You are a literary and technical translator. Return accurate, natural translation along with detected source language and up to 4 brief domain-term notes if helpful.',
          thinkingConfig: {thinkingLevel: ThinkingLevel.LOW},
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
      });

      const parsed = JSON.parse((response.text ?? '{}').trim());
      res.json(parsed);
    } catch (error) {
      console.error('Gemini translation error:', error);
      const message = error instanceof Error ? error.message : 'Failed to translate passage.';
      res.status(502).json({error: message});
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
