import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFile(new URL('../' + path, import.meta.url), 'utf8');

async function exists(path: string): Promise<boolean> {
  try {
    await access(new URL('../' + path, import.meta.url), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

describe('SimpleMem pre-smoke completion guards', () => {
  it('keeps a remotely committed archive generation when the manifest response is ambiguous', async () => {
    const source = await read('tools/simplemem/sidecar.py');
    expect(source).toContain('an exception cannot tell us whether S3 rejected the write');
    expect(source).not.toContain('not manifest_committed');
  });

  it('validates crash backups against the requested video id', async () => {
    const source = await read('tools/simplemem/sidecar.py');
    expect(source).toContain('def _cache_ready(video_dir: Path, expected_video_id: str | None = None)');
    expect(source).toContain('_cache_ready(backup_dir, video_id)');
  });

  it('makes Clipit top_k authoritative without discarding upstream strategy choices', async () => {
    const source = await read('tools/simplemem/sidecar.py');
    expect(source).toContain('strategy["top_k"] = top_k');
    expect(source).toContain('memory.query(question, top_k=top_k)');
  });

  it('validates the internal token at startup and consumes only the validated env value', async () => {
    const envSource = await read('src/config/env.ts');
    const clientSource = await read('src/services/retrieval/simplemem/client.ts');
    expect(envSource).toContain('SIMPLEMEM_INTERNAL_TOKEN: z.string().trim().min(32).optional()');
    expect(envSource).toContain('SIMPLEMEM_URL requires SIMPLEMEM_INTERNAL_TOKEN');
    expect(clientSource).toContain('env.SIMPLEMEM_INTERNAL_TOKEN?.trim()');
    expect(clientSource).not.toContain('process.env.SIMPLEMEM_INTERNAL_TOKEN');
  });

  it('does not ship temporary migration scaffolding', async () => {
    for (const path of [
      '.github/workflows/complete-simplemem-migration.yml',
      'scripts/complete-simplemem-migration.mjs',
      'scripts/finish-simplemem-migration.mjs',
      'test-output.txt',
    ]) {
      expect(await exists(path)).toBe(false);
    }
  });
});
