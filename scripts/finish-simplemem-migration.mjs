import { readFile, writeFile, rm } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const at = (path) => new URL(path, root);
const read = (path) => readFile(at(path), 'utf8');
const write = (path, content) => writeFile(at(path), content, 'utf8');

// Remove the remaining dead Media Index implementation from clipSearch. The
// first cleanup removed its imports/callsite but an old helper body remained.
{
  const path = 'src/worker/handlers/clipSearch.ts';
  let s = await read(path);
  const start = s.indexOf('/**\n * Answering from the vectors, before the notes are asked.');
  const end = s.indexOf('async function answerFromNotes(', start);
  if (start >= 0 && end > start) s = s.slice(0, start) + s.slice(end);
  await write(path, s);
}

// Captions are generic acquired-source metadata now; yt-dlp is gone. If a
// future source resolver stores a VTT, use it without a YouTube-specific flag.
{
  const path = 'src/worker/handlers/transcription.ts';
  let s = await read(path);
  s = s.replace(
    ' * For YouTube sources, creator or automatic captions downloaded by yt-dlp are\n * used when present, and OpenRouter STT is the fallback.\n',
    ' * If source acquisition supplied a timestamped caption file, use it first;\n * otherwise OpenRouter STT produces the transcript from the stored source.\n',
  );
  s = s.replace('if (env.YOUTUBE_PREFER_CAPTIONS && captionsKey)', 'if (captionsKey)');
  await write(path, s);
}

// This helper and its test existed only to support the retired Media Index's
// Modal embedding/reranking services. MiniCPM has its own client.
await rm(at('src/services/modal/invoke.ts'), { force: true });
await rm(at('test/modalHandleReset.test.ts'), { force: true });

// Retention tests must describe the new durable memory, not a deleted index.
{
  const path = 'test/footageExpiry.test.ts';
  let s = await read(path);
  s = s.replace('  deleteMediaIndex: vi.fn(),\n', '');
  s = s.replace(/vi\.mock\('\.\.\/src\/db\/repositories\/mediaIndex\.js',[\s\S]*?\}\)\);\n/, '');
  s = s.replace("    expect(clears.deleteMediaIndex).toHaveBeenCalledWith('v1');\n", '');
  s = s.replace('    // transcript, the vectors, and a SimpleMem memory that is frames of the\n', '    // transcript and a SimpleMem memory that is frames of the\n');
  await write(path, s);
}

// These tests are specifically OpenRouter routing tests. Make that provider
// explicit before importing the singleton env module, and stub the generated
// probe MP4 so CI does not depend on the runner's ffmpeg build to exercise a
// pure routing test.
{
  const path = 'test/modelCapabilities.test.ts';
  let s = await read(path);
  s = s.replace(
    "import { assertVideoInputSupported, resetVideoModelCapabilityCache } from '../src/services/search/modelCapabilities.js';\n",
    "process.env.VIDEO_PROVIDER = 'openrouter';\nvi.mock('../src/services/media/ffmpeg.js', () => ({\n  createProbeClip: async (file: string) => {\n    const { writeFile } = await import('node:fs/promises');\n    const ftyp = Buffer.alloc(24);\n    ftyp.writeUInt32BE(24, 0);\n    ftyp.write('ftyp', 4, 'ascii');\n    ftyp.write('isom', 8, 'ascii');\n    const mdat = Buffer.alloc(10_000);\n    mdat.writeUInt32BE(10_000, 0);\n    mdat.write('mdat', 4, 'ascii');\n    await writeFile(file, Buffer.concat([ftyp, mdat]));\n  },\n}));\nconst { assertVideoInputSupported, resetVideoModelCapabilityCache } = await import('../src/services/search/modelCapabilities.js');\n",
  );
  // Idempotence when the previous cleanup already converted the import.
  if (!s.includes("vi.mock('../src/services/media/ffmpeg.js'")) {
    s = s.replace(
      "process.env.VIDEO_PROVIDER = 'openrouter';\nconst { assertVideoInputSupported, resetVideoModelCapabilityCache } = await import('../src/services/search/modelCapabilities.js');\n",
      "process.env.VIDEO_PROVIDER = 'openrouter';\nvi.mock('../src/services/media/ffmpeg.js', () => ({\n  createProbeClip: async (file: string) => {\n    const { writeFile } = await import('node:fs/promises');\n    const ftyp = Buffer.alloc(24);\n    ftyp.writeUInt32BE(24, 0);\n    ftyp.write('ftyp', 4, 'ascii');\n    ftyp.write('isom', 8, 'ascii');\n    const mdat = Buffer.alloc(10_000);\n    mdat.writeUInt32BE(10_000, 0);\n    mdat.write('mdat', 4, 'ascii');\n    await writeFile(file, Buffer.concat([ftyp, mdat]));\n  },\n}));\nconst { assertVideoInputSupported, resetVideoModelCapabilityCache } = await import('../src/services/search/modelCapabilities.js');\n",
    );
  }
  await write(path, s);
}

// Remove stale comments left behind after the yt-dlp variables themselves were
// removed; examples must describe the system that can actually run.
{
  const path = '.env.example';
  let s = await read(path);
  s = s.replace(/# Use yt-dlp creator\/auto captions before paying for STT\.\n/g, '');
  s = s.replace(/# Off: YouTube URLs are refused, uploads are the only source, and the worker\n# neither requires nor calls yt-dlp\. The settings below apply only when it is on\.\n/g, '');
  s = s.replace(/# Optional cookie jar, as a path or inline contents\.\n/g, '');
  s = s.replace(/# Transient scratch space for ffmpeg \/ yt-dlp\.\n/g, '# Transient scratch space for ffmpeg.\n');
  await write(path, s);
}

console.log('Final SimpleMem migration cleanup applied.');
