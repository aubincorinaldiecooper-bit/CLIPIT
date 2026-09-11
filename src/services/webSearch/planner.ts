import { z } from 'zod';
import { env } from '../../config/env.js';
import { getWebVideoSearchConfig } from './config.js';

const planSchema = z.object({
  queries: z.array(z.string().trim().min(2).max(400)).min(1).max(8),
});

const SYSTEM_PROMPT = [
  'You plan video-search queries for an internet video research system.',
  'Return only JSON: {"queries":["..."]}.',
  'Preserve the user intent. The original question must be one of the queries unless it is longer than a search engine can accept.',
  'For a narrow factual request, use one query. For a broad exploratory request, use a few genuinely different search angles.',
  'Do not create cosmetic rewrites or synonyms that search for the same thing.',
  'Prefer queries likely to surface footage that can visually answer the question, not articles explaining it.',
  'Never exceed the requested maximum number of queries.',
].join('\n');

function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('planner response contained no JSON object');
  return JSON.parse(text.slice(start, end + 1));
}

function cleanQueries(question: string, values: readonly string[], maxQueries: number): string[] {
  const normalizedQuestion = question.trim().slice(0, 400);
  const output: string[] = [];
  const seen = new Set<string>();

  const add = (value: string) => {
    const cleaned = value.replace(/\s+/g, ' ').trim().slice(0, 400);
    const key = cleaned.toLowerCase();
    if (!cleaned || seen.has(key) || output.length >= maxQueries) return;
    seen.add(key);
    output.push(cleaned);
  };

  add(normalizedQuestion);
  for (const value of values) add(value);
  return output.length > 0 ? output : [normalizedQuestion];
}

export interface VideoSearchPlan {
  queries: string[];
  planner: 'openrouter' | 'fallback';
  model: string | null;
  latencyMs: number;
  error: string | null;
}

/**
 * MindSearch-style decomposition without introducing a second runtime. The
 * planner is deliberately non-critical: if it fails, the exact user question
 * is still a perfectly valid Brave query.
 */
export async function planVideoSearch(question: string): Promise<VideoSearchPlan> {
  const config = getWebVideoSearchConfig();
  const maxQueries = config.WEB_VIDEO_MAX_SUBQUERIES;
  const started = performance.now();
  const fallback = (error: unknown): VideoSearchPlan => ({
    queries: cleanQueries(question, [], maxQueries),
    planner: 'fallback',
    model: null,
    latencyMs: Math.round(performance.now() - started),
    error: error instanceof Error ? error.message : String(error),
  });

  try {
    const response = await fetch(`${env.OPENROUTER_API_BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        ...(env.OPENROUTER_SITE_URL ? { 'HTTP-Referer': env.OPENROUTER_SITE_URL } : {}),
        ...(env.OPENROUTER_APP_NAME ? { 'X-Title': env.OPENROUTER_APP_NAME } : {}),
      },
      body: JSON.stringify({
        model: env.OPENROUTER_ANSWER_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: JSON.stringify({ question, max_queries: maxQueries }),
          },
        ],
        max_tokens: 450,
        temperature: 0,
        reasoning: { enabled: false, exclude: true },
        stream: false,
      }),
      signal: AbortSignal.timeout(Math.min(env.OPENROUTER_REQUEST_TIMEOUT_MS, 30_000)),
    });

    if (!response.ok) throw new Error(`planner request failed with status ${response.status}`);
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error('planner returned no content');
    const parsed = planSchema.safeParse(extractJson(content));
    if (!parsed.success) throw new Error('planner response did not match query plan contract');

    return {
      queries: cleanQueries(question, parsed.data.queries, maxQueries),
      planner: 'openrouter',
      model: env.OPENROUTER_ANSWER_MODEL,
      latencyMs: Math.round(performance.now() - started),
      error: null,
    };
  } catch (error) {
    return fallback(error);
  }
}
