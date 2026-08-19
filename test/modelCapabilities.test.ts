import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertVideoInputSupported, resetVideoModelCapabilityCache } from '../src/services/search/modelCapabilities.js';

/** The slug `env.OPENROUTER_VIDEO_MODEL` defaults to in test config. */
const CONFIGURED_MODEL = 'qwen/qwen3-vl-32b-instruct';

afterEach(() => {
  vi.unstubAllGlobals();
  resetVideoModelCapabilityCache();
});

function catalogue(entries: Array<{ id: string; modalities: string[] }>): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        data: entries.map((entry) => ({
          id: entry.id,
          architecture: { input_modalities: entry.modalities },
        })),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );
}

describe('video model capability preflight', () => {
  it('passes when the configured model accepts video', async () => {
    vi.stubGlobal('fetch', catalogue([{ id: CONFIGURED_MODEL, modalities: ['text', 'image', 'video'] }]));

    await expect(assertVideoInputSupported()).resolves.toBeUndefined();
  });

  /**
   * The production failure this guard exists for: the configured model is
   * image-capable but has no video endpoints, so OpenRouter refuses every
   * chunk with a 404 after each one has uploaded megabytes of base64 MP4.
   */
  it('fails before any chunk uploads when the model cannot take video', async () => {
    vi.stubGlobal('fetch', catalogue([
      { id: CONFIGURED_MODEL, modalities: ['text', 'image'] },
      { id: 'vendor/sees-video', modalities: ['text', 'image', 'video'] },
    ]));

    await expect(assertVideoInputSupported()).rejects.toThrow(
      /does not accept video input.*vendor\/sees-video/s,
    );
  });

  it('marks that failure terminal so the job does not retry a config error', async () => {
    vi.stubGlobal('fetch', catalogue([
      { id: CONFIGURED_MODEL, modalities: ['text', 'image'] },
      { id: 'vendor/sees-video', modalities: ['video'] },
    ]));

    await expect(assertVideoInputSupported()).rejects.toMatchObject({ retryable: false });
  });

  /**
   * A diagnostic must not be able to take down search on its own — if the
   * catalogue is unreachable, the per-chunk request still surfaces the truth.
   */
  it('allows the search through when the catalogue cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    await expect(assertVideoInputSupported()).resolves.toBeUndefined();
  });

  it('allows the search through when the catalogue lists no video models at all', async () => {
    vi.stubGlobal('fetch', catalogue([{ id: 'vendor/text-only', modalities: ['text'] }]));

    await expect(assertVideoInputSupported()).resolves.toBeUndefined();
  });

  it('reads the catalogue once and reuses it across searches', async () => {
    const fetchMock = catalogue([{ id: CONFIGURED_MODEL, modalities: ['video'] }]);
    vi.stubGlobal('fetch', fetchMock);

    await assertVideoInputSupported();
    await assertVideoInputSupported();
    await assertVideoInputSupported();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed lookup', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', failing);
    await assertVideoInputSupported();

    const recovered = catalogue([{ id: CONFIGURED_MODEL, modalities: ['text'] }]);
    vi.stubGlobal('fetch', recovered);
    await assertVideoInputSupported();

    expect(recovered).toHaveBeenCalledTimes(1);
  });
});
