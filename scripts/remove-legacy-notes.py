from pathlib import Path
import re


def read(p): return Path(p).read_text()
def write(p, s): Path(p).write_text(s)
def must_replace(s, old, new, label):
    if old not in s:
        raise SystemExit(f'missing expected block: {label}')
    return s.replace(old, new, 1)
def remove_between(s, start, end, label):
    a=s.find(start)
    if a<0: raise SystemExit(f'missing start: {label}')
    b=s.find(end,a)
    if b<0: raise SystemExit(f'missing end: {label}')
    return s[:a] + s[b:]

# Preprocess: stop creating the old notes index; SimpleMem is now the only upload-time memory index.
p='src/worker/handlers/preprocess.ts'; s=read(p)
s=s.replace('getVideo, replaceChunks, setIndexStatus, setTranscriptStatus, setVideoStatus, updateVideoMedia',
            'getVideo, replaceChunks, setTranscriptStatus, setVideoStatus, updateVideoMedia')
s=s.replace('  enqueueIndexing,\n','')
s=remove_between(s,
    '      // 5. Read the video into notes, once, so questions can be answered from',
    '      // 6. Send the video to Omni-SimpleMem after preprocessing.',
    'preprocess legacy notes enqueue')
s=s.replace('      // 6. Send the video to Omni-SimpleMem after preprocessing.\n      //    Its own read, its own row, its own failure: the notes above are\n      //    untouched by it, which is what keeps the fallback whole.\n',
            '      // 5. Send the prepared video to Omni-SimpleMem, the upload-time memory index.\n')
write(p,s)

# Queues: remove the obsolete video-indexing queue and its job contract.
p='src/queues/index.ts'; s=read(p)
s=s.replace("  indexing: 'video-indexing',\n",'')
s=re.sub(r'/\*\* Read a video into notes, once, after preprocessing\. \*/\nexport interface IndexingJob \{\n  videoId: string;\n\}\n\n','',s)
s=s.replace('  indexing: Queue<IndexingJob>;\n','')
s=s.replace('      indexing: new Queue<IndexingJob>(QUEUE_NAMES.indexing, { connection, defaultJobOptions }),\n','')
s=re.sub(r"export async function enqueueIndexing\(data: IndexingJob\): Promise<void> \{\n  await addWithStableId\(getQueues\(\)\.indexing, 'index', data, `index-\$\{data\.videoId\}`\);\n\}\n\n",'',s)
s=s.replace('/** Milliseconds already spent waiting for an in-flight transcript or index. */',
            '/** Milliseconds already spent waiting for an in-flight transcript. */')
s=s.replace("   * apart from `waitedMs`: the notes and the transcript get their whole\n   * allowance once the video is ready, however long preparation took.\n",
            "   * apart from `waitedMs`: transcript waiting gets its whole allowance once\n   * the video is ready, however long preparation took.\n")
write(p,s)

# Worker: remove the old indexing worker entirely.
p='src/worker/main.ts'; s=read(p)
s=s.replace("import { handleIndexing } from './handlers/indexing.js';\n",'')
s=s.replace('    indexing: env.INDEXING_ENABLED,\n','')
s=remove_between(s,
    '  // One video at a time. Reading a video is many model calls, and the shared',
    '  // One at a time as well: a SimpleMem read is a captioning call per kept',
    'worker legacy index consumer')
s=s.replace('    // One number, and it governs everything that sends video: reading a video\n    // at upload and searching its footage both pass through the same gate.\n',
            '    // The configured ceiling for actual-footage verification/search calls.\n')
write(p,s)

# Clip search: SimpleMem -> actual footage only. Remove every notes lookup/wait path.
p='src/worker/handlers/clipSearch.ts'; s=read(p)
for old in [
    "import { searchNotes } from '../../services/search/noteSearch.js';\n",
    "import { listScenes, sceneProgress } from '../../db/repositories/scenes.js';\n",
]: s=s.replace(old,'')
s=s.replace("import type { NoteLine, TranscriptLine } from '../../services/search/prompt.js';",
            "import type { TranscriptLine } from '../../services/search/prompt.js';")
s=s.replace("import { listTranscriptSegments, listTranscriptSegmentsInRange } from '../../db/repositories/transcripts.js';",
            "import { listTranscriptSegmentsInRange } from '../../db/repositories/transcripts.js';")
s=s.replace('  findUncoveredRanges,\n','')
s=remove_between(s,
    '    /**\n     * Waiting for the video to finish being read.',
    "    if (desired.mode !== 'visual' && transcriptPending && waitedMs < env.TRANSCRIPT_WAIT_TIMEOUT_MS) {",
    'clip search note-index wait')
s=remove_between(s,
    "    const notesAvailable = !correcting && video.indexStatus === 'ready';",
    '    // One cheap check before uploading megabytes per chunk:',
    'clip search notes answer')
marker='/**\n * A hole in the notes shorter than this is not worth telling anyone about —'
a=s.find(marker)
if a>=0:
    b=s.find('const MATCH_SOURCE:',a)
    if b<0: raise SystemExit('could not locate MATCH_SOURCE after notes tolerance')
    s=s[:a]+s[b:]
s=remove_between(s,
    '/**\n * Answers from what was written down at upload, or reports that it cannot.',
    'async function searchSingleChunk(input: SearchSingleChunkInput): Promise<NewClipMatch[]> {',
    'answerFromNotes')
if 'async function searchSingleChunk(input: SearchSingleChunkInput): Promise<NewClipMatch[]> {' not in s:
    raise SystemExit('searchSingleChunk declaration lost')
s=s.replace('     * the notes have already had their turn and did not settle it.\n',
            '     * a correction requests a fresh actual-footage check.\n')
s=s.replace('     * Omni-SimpleMem first once upload-time reading has settled.\n     *\n     * Another memory, asked before the notes because it holds a different\n     * thing: the notes say what a model thought worth writing down, while its\n     * timestamped visual memories describe selected frames. Anything but\n     * a confident hit hands the question straight on to the notes below, with\n     * the reason recorded — the index is never allowed to end a search by\n     * finding nothing.\n',
            '     * Omni-SimpleMem is the memory/retrieval layer. A confident candidate is\n     * verified against actual footage before it can become evidence. A miss or\n     * unavailable index falls through to the full actual-footage search; memory\n     * is never allowed to prove absence by itself.\n')
s=s.replace("    // lost if this process stops. Notes and footage are both Clipit's own\n    // search; only the external retrieval systems are the other thing.\n",
            '    // lost if this process stops.\n')
write(p,s)

# OpenRouter video transport: actual footage only; remove notes text lane/index purpose.
p='src/services/search/openrouterVideo.ts'; s=read(p)
s=s.replace(" * Search and indexing send the same kind of request — a system prompt, some\n * text, and a chunk of MP4 — and both need the timeout split, the usage\n",
            " * Actual-footage searches send a system prompt, text, and a chunk of MP4,\n * and need the timeout split, the usage\n")
s=re.sub(r"  /\*\*\n   \* Room for the answer\. Describing everything in two minutes of video needs\n   \* more of it than naming a few matching moments does\.\n   \*/\n  answerMaxTokens\?: number;\n  /\*\*\n   \* What the call is for\. Also picks the queue: a `notes` call carries no\n   \* video and returns in seconds, so it must not wait behind an indexing run\n   \* — the whole point of the notes is that answering from them is immediate\.\n   \*/\n  purpose: 'search' \| 'index' \| 'notes';",
         "  /** Room for the model answer. */\n  answerMaxTokens?: number;\n  purpose: 'search';",s)
s=re.sub(r'/\*\*\n \* Text-only calls get their own lane\.[\s\S]*?\*/\nconst textLimiter = new Semaphore\(env\.OPENROUTER_TEXT_CONCURRENCY\);\n','',s, count=1)
s=re.sub(r'/\*\* The same, for the text lane that answers from notes\. \*/\nexport function textCallStats\(\): \{ limit: number; inFlight: number; peak: number \} \{\n  return textLimiter\.snapshot\(\);\n\}\n\n','',s)
s=s.replace(' * every caller, so indexing a video cannot crowd out a search someone is\n * waiting on beyond the configured concurrency.\n',
            ' * every caller, so actual-footage work stays within the configured concurrency.\n')
old="""  /**
   * The provider seam. Notes lookups carry no video and stay on OpenRouter's
   * text lane under either provider — the switch governs only calls that
   * read actual footage. MiniCPM keeps its own queue, retries and cost
   * accounting behind the same answer shape, so nothing above this line
   * knows which service watched the video.
   */
  if (env.VIDEO_PROVIDER === 'minicpm' && input.purpose !== 'notes') {
"""
new="""  /** Provider seam for actual-footage calls. */
  if (env.VIDEO_PROVIDER === 'minicpm') {
"""
s=must_replace(s,old,new,'openrouter provider seam')
s=s.replace("  const limiter = input.purpose === 'notes' ? textLimiter : videoLimiter;\n  return limiter.run(async () => {",
            '  return videoLimiter.run(async () => {')
write(p,s)

# Prompt module: remove upload-time notes/index prompt family while preserving search + reclip.
p='src/services/search/prompt.ts'; s=read(p)
start=s.find('/**\n * The prompt for reading a video at upload, before anyone has asked anything.')
recl=s.find('/**\n * The Re-clip voice:', start)
if start<0 or recl<0: raise SystemExit('prompt: could not isolate pre-index comment')
s=s[:start]+s[recl:]
start=s.find('export const INDEX_SYSTEM_PROMPT = [')
if start<0: raise SystemExit('prompt: INDEX_SYSTEM_PROMPT missing')
s=s[:start].rstrip()+"\n"
write(p,s)

# Environment: remove settings whose only job was the legacy notes index/lookup.
p='src/config/env.ts'; s=read(p)
legacy_keys=['INDEXING_ENABLED','INDEX_WAIT_TIMEOUT_MS','INDEX_WAIT_POLL_MS','INDEX_ANSWER_MAX_TOKENS','OPENROUTER_TEXT_CONCURRENCY','NOTES_PER_LOOKUP','NOTES_ANSWER_MAX_TOKENS']
lines=s.splitlines(True); out=[]; i=0
while i<len(lines):
    if any(re.match(rf'\s*{re.escape(k)}\s*:', lines[i]) for k in legacy_keys):
        while out and out[-1].strip()=='': out.pop()
        if out and out[-1].lstrip().startswith('*/'):
            while out:
                x=out.pop()
                if x.lstrip().startswith('/**'): break
        i+=1
        continue
    out.append(lines[i]); i+=1
s=''.join(out)
s=s.replace('   * Which service reads the actual video. `openrouter` is the current\n   * behaviour, unchanged. `minicpm` sends chunks to our own MiniCPM-V 4.6\n   * deployment on Modal instead. Notes lookups and transcription stay on\n   * OpenRouter under either setting — this switch governs only the calls that\n   * carry video.\n',
            '   * Which service reads actual footage for verification/search. `openrouter`\n   * is the default; `minicpm` sends footage to our own MiniCPM-V 4.6 deployment.\n')
write(p,s)

# Env example.
p='.env.example'; s=read(p)
legacy=['INDEXING_ENABLED','INDEX_WAIT_TIMEOUT_MS','INDEX_WAIT_POLL_MS','INDEX_ANSWER_MAX_TOKENS','OPENROUTER_TEXT_CONCURRENCY','NOTES_PER_LOOKUP','NOTES_ANSWER_MAX_TOKENS']
s=''.join(line for line in s.splitlines(True) if not any(line.startswith(k+'=') for k in legacy))
write(p,s)

# Delete implementation/tests that only existed for retired notes.
for f in [
  'src/worker/handlers/indexing.ts',
  'src/services/search/noteSearch.ts',
  'src/services/search/sceneIndex.ts',
  'test/sceneIndex.test.ts',
  'test/readProgress.test.ts',
]:
    Path(f).unlink(missing_ok=True)

# Current docs should not advertise notes-first architecture. Historical migrations stay untouched.
for p in ['README.md','CLAUDE.md']:
    s=read(p)
    s=s.replace('notes first', 'SimpleMem first').replace('Notes first', 'SimpleMem first')
    s=s.replace('notes-first', 'SimpleMem-first').replace('Notes-first', 'SimpleMem-first')
    write(p,s)
