import { readFile, writeFile, rm } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const at = (path) => new URL(path, root);
const read = (path) => readFile(at(path), 'utf8');
const write = (path, content) => writeFile(at(path), content, 'utf8');

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`Could not find migration target: ${label}`);
  return source.replace(before, after);
}

// 1. Finish the SimpleMem sidecar correctness fixes that must land before the
// end-to-end smoke test.
{
  const path = 'tools/simplemem/sidecar.py';
  let s = await read(path);

  s = replaceOnce(
    s,
    'def _cache_ready(video_dir: Path) -> bool:\n',
    'def _cache_ready(video_dir: Path, expected_video_id: str | None = None) -> bool:\n',
    'cache-ready signature',
  );
  s = replaceOnce(
    s,
    '        if marker is None or marker.get("videoId") != video_dir.name:\n',
    '        if marker is None or marker.get("videoId") != (expected_video_id or video_dir.name):\n',
    'cache-ready expected video id',
  );
  s = replaceOnce(s, '    if _cache_ready(final_dir):\n', '    if _cache_ready(final_dir, video_id):\n', 'final cache readiness');
  s = replaceOnce(s, '    if _cache_ready(backup_dir):\n', '    if _cache_ready(backup_dir, video_id):\n', 'backup cache readiness');
  s = replaceOnce(
    s,
    '    if not _cache_ready(final_dir):\n',
    '    if not _cache_ready(final_dir, video_id):\n',
    'restored cache readiness',
  );

  s = replaceOnce(s, '    manifest_committed = False\n', '', 'manifest committed flag declaration');
  s = replaceOnce(s, '        manifest_committed = True\n', '', 'manifest committed flag assignment');
  s = replaceOnce(
    s,
    `    except Exception:\n        # A failed pre-commit replacement must leave the prior manifest and its\n        # referenced bytes intact. The new unreferenced generation is safe to\n        # remove unless it is the same content-addressed key as the prior one.\n        if new_key and not manifest_committed and new_key != previous_key:\n            try:\n                client.delete_object(Bucket=bucket, Key=new_key)\n            except Exception:\n                pass\n        raise\n`,
    `    except Exception:\n        # Once the generation upload succeeded and the manifest write was\n        # attempted, an exception cannot tell us whether S3 rejected the write\n        # or committed it and only lost the response. Deleting the new\n        # generation here could therefore delete the bytes referenced by a\n        # successfully committed manifest. Leave a possible orphan instead; a\n        # later successful replacement/delete can clean it safely.\n        raise\n`,
    'ambiguous manifest write cleanup',
  );

  s = replaceOnce(
    s,
    '        result = memory.query(question, top_k=top_k)\n',
    `        # Upstream Omni-SimpleMem derives its own strategy and otherwise\n        # replaces the caller's top_k with 5/10/20 depending on query type.\n        # Clipit owns the candidate budget, so preserve every other strategy\n        # choice while making our requested top_k authoritative. This memory\n        # instance is request-local and sidecar operations are serialized.\n        original_strategy = memory.query_processor.determine_retrieval_strategy\n\n        def clipit_strategy(parsed):\n            strategy = dict(original_strategy(parsed))\n            strategy["top_k"] = top_k\n            return strategy\n\n        memory.query_processor.determine_retrieval_strategy = clipit_strategy\n        try:\n            result = memory.query(question, top_k=top_k)\n        finally:\n            memory.query_processor.determine_retrieval_strategy = original_strategy\n`,
    'authoritative SimpleMem top_k',
  );

  await write(path, s);
}

// 2. Make the internal sidecar token part of central startup validation so a
// bad deployment fails before accepting jobs, and make the client use that
// validated value rather than reading process.env ad hoc.
{
  const path = 'src/config/env.ts';
  let s = await read(path);
  s = replaceOnce(
    s,
    '  SIMPLEMEM_URL: z.string().trim().url().optional(),\n',
    '  SIMPLEMEM_URL: z.string().trim().url().optional(),\n  /** Shared internal credential required whenever this process can call the sidecar. */\n  SIMPLEMEM_INTERNAL_TOKEN: z.string().trim().min(32).optional(),\n',
    'SimpleMem token schema',
  );
  s = replaceOnce(
    s,
    "  if (value.RETRIEVAL_PRIMARY === 'simplemem' && !value.SIMPLEMEM_INDEX_ENABLED) {\n",
    "  if (value.SIMPLEMEM_URL && !value.SIMPLEMEM_INTERNAL_TOKEN) {\n    problems.push('SIMPLEMEM_URL requires SIMPLEMEM_INTERNAL_TOKEN with at least 32 characters');\n  }\n  if (value.RETRIEVAL_PRIMARY === 'simplemem' && !value.SIMPLEMEM_INDEX_ENABLED) {\n",
    'SimpleMem token startup validation',
  );
  await write(path, s);
}

{
  const path = 'src/services/retrieval/simplemem/client.ts';
  let s = await read(path);
  s = replaceOnce(
    s,
    '  const value = process.env.SIMPLEMEM_INTERNAL_TOKEN?.trim();\n',
    '  const value = env.SIMPLEMEM_INTERNAL_TOKEN?.trim();\n',
    'SimpleMem validated client token',
  );
  await write(path, s);
}

// 3. Add regression guards for the four pre-smoke blockers and ensure the old
// migration machinery does not accidentally remain in the shipped tree.
await write(
  'test/simplememPreSmokeCompletion.test.ts',
  `import { readFile, access } from 'node:fs/promises';\nimport { constants } from 'node:fs';\nimport { describe, expect, it } from 'vitest';\n\nconst read = (path: string) => readFile(new URL('../' + path, import.meta.url), 'utf8');\n\nasync function exists(path: string): Promise<boolean> {\n  try {\n    await access(new URL('../' + path, import.meta.url), constants.F_OK);\n    return true;\n  } catch {\n    return false;\n  }\n}\n\ndescribe('SimpleMem pre-smoke completion guards', () => {\n  it('keeps a remotely committed archive generation when the manifest response is ambiguous', async () => {\n    const source = await read('tools/simplemem/sidecar.py');\n    expect(source).toContain('an exception cannot tell us whether S3 rejected the write');\n    expect(source).not.toContain('not manifest_committed');\n  });\n\n  it('validates crash backups against the requested video id', async () => {\n    const source = await read('tools/simplemem/sidecar.py');\n    expect(source).toContain('def _cache_ready(video_dir: Path, expected_video_id: str | None = None)');\n    expect(source).toContain('_cache_ready(backup_dir, video_id)');\n  });\n\n  it('makes Clipit top_k authoritative without discarding upstream strategy choices', async () => {\n    const source = await read('tools/simplemem/sidecar.py');\n    expect(source).toContain('strategy["top_k"] = top_k');\n    expect(source).toContain('memory.query(question, top_k=top_k)');\n  });\n\n  it('validates the internal token at startup and consumes only the validated env value', async () => {\n    const envSource = await read('src/config/env.ts');\n    const clientSource = await read('src/services/retrieval/simplemem/client.ts');\n    expect(envSource).toContain('SIMPLEMEM_INTERNAL_TOKEN: z.string().trim().min(32).optional()');\n    expect(envSource).toContain('SIMPLEMEM_URL requires SIMPLEMEM_INTERNAL_TOKEN');\n    expect(clientSource).toContain('env.SIMPLEMEM_INTERNAL_TOKEN?.trim()');\n    expect(clientSource).not.toContain('process.env.SIMPLEMEM_INTERNAL_TOKEN');\n  });\n\n  it('does not ship temporary migration scaffolding', async () => {\n    for (const path of [\n      '.github/workflows/complete-simplemem-migration.yml',\n      'scripts/complete-simplemem-migration.mjs',\n      'scripts/finish-simplemem-migration.mjs',\n      'test-output.txt',\n    ]) {\n      expect(await exists(path)).toBe(false);\n    }\n  });\n});\n`,
);

// 4. Remove migration-only files that accidentally landed on main, plus this
// one-shot script/workflow. The running workflow has already loaded them.
for (const path of [
  '.github/workflows/complete-simplemem-migration.yml',
  'scripts/complete-simplemem-migration.mjs',
  'scripts/finish-simplemem-migration.mjs',
  'test-output.txt',
  '.github/workflows/finalize-simplemem-pre-smoke.yml',
  'scripts/finalize-simplemem-pre-smoke.mjs',
]) {
  await rm(at(path), { force: true });
}

console.log('SimpleMem pre-smoke completion applied.');
