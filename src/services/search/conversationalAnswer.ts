import { createHash } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { sleep } from '../../lib/concurrency.js';
import { ExternalServiceError } from '../../lib/errors.js';

const SYSTEM_PROMPT = [
  'You answer questions about a video using only the evidence supplied by Clipit.',
  'The difficult retrieval and visual verification have already happened. Explain the evidence clearly and briefly.',
  'Never invent, adjust, average, or infer a timestamp. Cite only evidence ids supplied below.',
  'If no evidence was found, say that no verified answer was found. Do not claim the event is absent from the video.',
  'Do not add coverage limitations; Clipit appends its canonical coverage note after your answer.',
  'Return only JSON: {"answer":"...","citation_ids":["evidence-id"]}.',
].join('\n');

export interface AnswerEvidence {
  id: string;
  startSeconds: number;
  endSeconds: number;
  description: string;
  quote?: string | null;
  source: string;
}

export interface ConversationalAnswer {
  text: string;
  citationIds: string[];
  provider: 'openrouter';
  model: string;
  promptVersion: string;
}

const responseSchema = z.object({
  answer: z.string().trim().min(1).max(4_000),
  citation_ids: z.array(z.string().min(1)).max(50),
});

function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('response contained no JSON object');
  return JSON.parse(text.slice(start, end + 1));
}

/** Validates that Qwen cited only evidence it actually supplied. */
export function parseConversationalAnswer(
  raw: string,
  evidenceIds: ReadonlySet<string>,
  coverageNote?: string | null,
): Omit<ConversationalAnswer, 'provider' | 'model' | 'promptVersion'> {
  const parsed = responseSchema.safeParse(extractJson(raw));
  if (!parsed.success) throw new Error('response did not match the conversational answer contract');
  const citationIds = [...new Set(parsed.data.citation_ids)];
  if (citationIds.some((id) => !evidenceIds.has(id))) throw new Error('response cited evidence that was not supplied');
  if (evidenceIds.size > 0 && citationIds.length === 0) throw new Error('response did not cite its supplied evidence');
  // Coverage is a fact established by retrieval, not prose the answer model
  // is allowed to paraphrase. It is deliberately absent from the model input
  // and appended exactly once at this deterministic boundary.
  const text = coverageNote ? `${parsed.data.answer} ${coverageNote}` : parsed.data.answer;
  return { text, citationIds };
}

export async function writeConversationalAnswer(input: {
  question: string;
  evidence: readonly AnswerEvidence[];
  coverageNote?: string | null;
  onUsage?: (usage: {
    promptTokens: number; completionTokens: number; totalTokens: number; costUsd: number | null;
    latencyMs: number; provider: string; model: string; promptVersion: string;
  }) => void;
}): Promise<ConversationalAnswer> {
  const model = env.OPENROUTER_ANSWER_MODEL;
  const promptVersion = createHash('sha256').update(SYSTEM_PROMPT).digest('hex').slice(0, 16);
  const evidence = input.evidence.map((item) => ({
    id: item.id,
    start_seconds: item.startSeconds,
    end_seconds: item.endSeconds,
    description: item.description,
    quote: item.quote ?? null,
    source: item.source,
  }));
  const body = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({ question: input.question, evidence }) },
    ],
    max_tokens: env.OPENROUTER_ANSWER_MAX_TOKENS,
    temperature: env.OPENROUTER_ANSWER_TEMPERATURE,
    reasoning: { enabled: false, exclude: true },
    stream: false,
  });

  let lastError: unknown;
  for (let attempt = 0; attempt <= env.OPENROUTER_MAX_RETRIES; attempt += 1) {
    const started = performance.now();
    try {
      const response = await fetch(`${env.OPENROUTER_API_BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          ...(env.OPENROUTER_SITE_URL ? { 'HTTP-Referer': env.OPENROUTER_SITE_URL } : {}),
          ...(env.OPENROUTER_APP_NAME ? { 'X-Title': env.OPENROUTER_APP_NAME } : {}),
        },
        body,
        signal: AbortSignal.timeout(env.OPENROUTER_REQUEST_TIMEOUT_MS),
      });
      const raw = await response.text();
      if (!response.ok) {
        throw new ExternalServiceError('openrouter-answer', `Answer request failed with status ${response.status}: ${raw.slice(0, 400)}`, {
          retryable: [408, 409, 425, 429, 500, 502, 503, 504].includes(response.status),
        });
      }
      const payload = JSON.parse(raw) as {
        choices?: Array<{ message?: { content?: string | null } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number };
      };
      // A successful HTTP response is billable even when its content is empty
      // or violates our answer contract. Account for it before either of
      // those validations can throw and trigger another paid attempt.
      const latencyMs = Math.round(performance.now() - started);
      if (input.onUsage && payload.usage) {
        input.onUsage({
          promptTokens: Math.max(0, Math.round(payload.usage.prompt_tokens ?? 0)),
          completionTokens: Math.max(0, Math.round(payload.usage.completion_tokens ?? 0)),
          totalTokens: Math.max(0, Math.round(payload.usage.total_tokens ?? 0)),
          costUsd: typeof payload.usage.cost === 'number' ? payload.usage.cost : null,
          latencyMs, provider: 'openrouter', model, promptVersion,
        });
      }
      const content = payload.choices?.[0]?.message?.content;
      if (!content) throw new ExternalServiceError('openrouter-answer', 'Qwen Flash returned no answer', { retryable: false });
      const parsed = parseConversationalAnswer(
        content,
        new Set(input.evidence.map((item) => item.id)),
        input.coverageNote,
      );
      return { ...parsed, provider: 'openrouter', model, promptVersion };
    } catch (error) {
      lastError = error;
      const retryable = !(error instanceof ExternalServiceError) || error.retryable;
      if (!retryable || attempt === env.OPENROUTER_MAX_RETRIES) break;
      await sleep(Math.min(30_000, 1_000 * 2 ** attempt));
    }
  }
  throw lastError;
}
