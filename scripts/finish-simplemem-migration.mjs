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
