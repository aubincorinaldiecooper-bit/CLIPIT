import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConversationalAnswer, writeConversationalAnswer } from '../src/services/search/conversationalAnswer.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('conversational answer contract', () => {
  it('accepts a grounded answer and removes duplicate citations', () => {
    expect(parseConversationalAnswer(
      '{"answer":"It happens at 00:12.","citation_ids":["m1","m1"]}',
      new Set(['m1']),
    )).toEqual({ text: 'It happens at 00:12.', citationIds: ['m1'] });
  });

  it('rejects citations that were not in the supplied evidence', () => {
    expect(() => parseConversationalAnswer(
      '{"answer":"It happens at 00:20.","citation_ids":["invented"]}',
      new Set(['m1']),
    )).toThrow(/not supplied/);
  });

  it('requires a citation whenever Qwen was given evidence', () => {
    expect(() => parseConversationalAnswer(
      '{"answer":"It happens in the video.","citation_ids":[]}',
      new Set(['m1']),
    )).toThrow(/did not cite/);
  });

  it('uses Qwen Flash without reasoning for every final response', async () => {
    globalThis.fetch = vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      expect(request.model).toBe('qwen/qwen3.6-flash');
      expect(request.reasoning).toEqual({ enabled: false, exclude: true });
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"answer":"The price appears at 00:12.","citation_ids":["m1"]}' } }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, cost: 0.001 },
      }), { status: 200 });
    }) as typeof fetch;
    const onUsage = vi.fn();

    const answer = await writeConversationalAnswer({
      question: 'Where is the price?',
      evidence: [{ id: 'm1', startSeconds: 12, endSeconds: 18, description: 'Price slide', source: 'visual' }],
      onUsage,
    });

    expect(answer.text).toBe('The price appears at 00:12.');
    expect(answer.citationIds).toEqual(['m1']);
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ model: 'qwen/qwen3.6-flash', totalTokens: 30 }));
  });

  it('records a billable successful response before rejecting empty content', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: null } }],
      usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13, cost: 0.0004 },
    }), { status: 200 })) as typeof fetch;
    const onUsage = vi.fn();

    await expect(writeConversationalAnswer({
      question: 'Where is it?', evidence: [], onUsage,
    })).rejects.toThrow(/returned no answer/);

    expect(onUsage).toHaveBeenCalledOnce();
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ totalTokens: 13, costUsd: 0.0004 }));
  });
});
