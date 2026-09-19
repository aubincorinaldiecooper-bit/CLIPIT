'use strict';
/**
 * Genesis live — the phone surface over Gander's existing WebSocket runtime.
 *
 * This adds no transport and no protocol. It speaks exactly what the desktop
 * client already speaks: `/ws/duplex` for PCM16 audio both ways, `/ws/screen`
 * for JPEG frames behind a per-session token, and the same event vocabulary.
 *
 * Two rules shape the whole file.
 *
 * It never claims Genesis can see before the server has said so. "Genesis can
 * see your camera" appears on the first `screen.frame.accepted` and not one
 * moment earlier — sending a frame is not evidence that a frame arrived.
 *
 * And End means off. Tracks stopped, sockets closed, worklet released,
 * playback dropped, so the phone's own camera and microphone indicators go out.
 */

const INPUT_RATE = 16000;
const JPEG_QUALITY = 0.72;
const MAX_EDGE = 640;

const ui = {
  root: document.getElementById('live'),
  preview: document.getElementById('preview'),
  scratch: document.getElementById('scratch'),
  status: document.getElementById('status'),
  says: document.getElementById('says'),
  start: document.getElementById('start'),
  end: document.getElementById('end'),
};

/** Everything a running session owns, so End can let go of all of it. */
let live = null;

function show(text, { state, tone } = {}) {
  ui.status.textContent = text;
  ui.status.hidden = !text;
  if (state) ui.root.dataset.state = state;
  if (tone === null) delete ui.root.dataset.tone;
  else if (tone) ui.root.dataset.tone = tone;
}

function say(text) {
  ui.says.textContent = text || '';
}

// --- audio ---------------------------------------------------------------

/** Linear resample to 16 kHz PCM16, which is what /ws/duplex expects. */
function toPcm16(samples, fromRate) {
  const ratio = fromRate / INPUT_RATE;
  const count = Math.max(1, Math.round(samples.length / ratio));
  const out = new Int16Array(count);
  for (let i = 0; i < count; i += 1) {
    const at = i * ratio;
    const low = Math.floor(at);
    const high = Math.min(low + 1, samples.length - 1);
    const value = samples[low] + (samples[high] - samples[low]) * (at - low);
    out[i] = Math.max(-32768, Math.min(32767, Math.round(value * 32767)));
  }
  return out.buffer;
}

/** Schedules Gander's speech so consecutive packets do not overlap or gap. */
function createPlayback() {
  const context = new (window.AudioContext || window.webkitAudioContext)();
  const sources = new Set();
  let cursor = 0;
  return {
    context,
    play(bytes, rate) {
      const pcm = new Int16Array(bytes);
      if (!pcm.length) return;
      const buffer = context.createBuffer(1, pcm.length, rate);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i += 1) channel[i] = pcm[i] / 32768;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      const at = Math.max(context.currentTime + 0.02, cursor);
      source.start(at);
      cursor = at + buffer.duration;
      sources.add(source);
      source.onended = () => sources.delete(source);
    },
    cancel() {
      for (const source of sources) {
        try { source.stop(); } catch { /* already finished */ }
      }
      sources.clear();
      cursor = 0;
    },
    async close() {
      this.cancel();
      try { await context.close(); } catch { /* already closed */ }
    },
  };
}

// --- session -------------------------------------------------------------

function socketUrl(path, query) {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}${path}${query ? `?${query}` : ''}`;
}

async function openCamera() {
  show('Requesting camera…', { state: 'connecting', tone: null });
  // Rear camera by preference: someone pointing a phone at a thing wants the
  // lens on the far side. `ideal` rather than `exact` so a laptop or a phone
  // without a rear camera still works instead of throwing.
  const video = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  show('Requesting microphone…');
  let audio;
  try {
    audio = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    for (const track of video.getTracks()) track.stop();
    throw error;
  }
  return { video, audio };
}

function startFrames(session, hints) {
  const canvas = ui.scratch;
  const context = canvas.getContext('2d', { alpha: false });
  const rate = Math.min(Math.max(Number(hints.recommended_frame_rate) || 2, 0.5), 10);
  let sequence = 0;
  let inFlight = false;

  const tick = async () => {
    if (!live || live.stopped || inFlight) return;
    const video = ui.preview;
    if (!video.videoWidth) return;
    inFlight = true;
    try {
      const scale = Math.min(1, MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
      const width = Math.max(2, Math.round(video.videoWidth * scale));
      const height = Math.max(2, Math.round(video.videoHeight * scale));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.drawImage(video, 0, 0, width, height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
      if (!blob || !live || live.stopped) return;
      const screen = live.screen;
      if (!screen || screen.readyState !== WebSocket.OPEN) return;
      sequence += 1;
      screen.send(JSON.stringify({
        type: 'screen.frame',
        frame_id: `live-${sequence}`,
        captured_at_ms: Date.now(),
        encoding: 'jpeg',
        video_source: 'camera',
      }));
      screen.send(await blob.arrayBuffer());
      live.stats.sent += 1;
    } finally {
      inFlight = false;
    }
  };

  return setInterval(() => { void tick(); }, Math.round(1000 / rate));
}

async function startMicrophone(session) {
  const context = new (window.AudioContext || window.webkitAudioContext)();
  await context.audioWorklet.addModule('/assets/mic-worklet.js');
  const source = context.createMediaStreamSource(session.media.audio);
  const capture = new AudioWorkletNode(context, 'minicpm-mic-capture', {
    processorOptions: { frameSize: 2048 },
  });
  capture.port.onmessage = (event) => {
    if (!live || live.stopped) return;
    const duplex = live.duplex;
    if (!duplex || duplex.readyState !== WebSocket.OPEN) return;
    duplex.send(toPcm16(event.data.samples, context.sampleRate));
    live.stats.audio += 1;
  };
  source.connect(capture);
  // Not connected to the destination: routing the microphone to the speaker
  // would feed Gander's own voice straight back into it.
  return { context, source, capture };
}

function attachScreen(session, ready) {
  const screen = ready.screen || {};
  if (!screen.enabled || !screen.token) {
    show('Genesis is not accepting video right now.', { tone: 'busy' });
    return null;
  }
  const socket = new WebSocket(
    socketUrl(screen.path || '/ws/screen', `session_id=${encodeURIComponent(ready.session_id)}&token=${encodeURIComponent(screen.token)}`)
  );
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return;
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }
    if (payload.type === 'screen.ready') {
      live.frameTimer = startFrames(session, payload);
      return;
    }
    if (payload.type === 'screen.frame.accepted') {
      live.stats.accepted += 1;
      if (live.stats.accepted === 1) {
        // The first proof that a real frame arrived. Only now is it true.
        show('Genesis can see your camera. Listening…', { state: 'live', tone: 'live' });
      }
      return;
    }
    if (payload.type === 'screen.frame.dropped') live.stats.dropped += 1;
  });
  return socket;
}

function handleDuplex(session, event) {
  if (typeof event.data !== 'string') {
    // Binary always follows the audio.chunk header that describes it.
    const header = live.pendingAudio;
    live.pendingAudio = null;
    if (header) live.playback.play(event.data, header.audio_sample_rate || 24000);
    return;
  }
  let payload;
  try { payload = JSON.parse(event.data); } catch { return; }

  switch (payload.type) {
    case 'ready':
      live.sessionId = payload.session_id;
      live.screen = attachScreen(session, payload);
      show('Connected. Waiting for the first frame…', { state: 'connecting' });
      void startMicrophone(session).then((mic) => { if (live) live.mic = mic; });
      break;
    case 'audio.chunk':
      live.pendingAudio = payload;
      break;
    case 'playback.cancel':
      live.playback.cancel();
      break;
    case 'turn.final.accepted':
      if (payload.text) say(payload.text);
      break;
    case 'error':
      // Raw engineering wording never reaches the page.
      show(payload.fatal ? 'Genesis could not start.' : 'Something went wrong.', { tone: 'bad' });
      break;
    default:
      break;
  }
}

async function start() {
  ui.start.disabled = true;
  say('');
  let media;
  try {
    media = await openCamera();
  } catch (error) {
    const denied = error && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
    show(
      denied ? 'Camera or microphone access was not granted.' : 'This device would not start the camera.',
      { state: 'idle', tone: 'bad' }
    );
    ui.start.disabled = false;
    return;
  }

  ui.preview.srcObject = media.video;
  const session = { media };
  live = {
    media,
    duplex: null,
    screen: null,
    mic: null,
    playback: createPlayback(),
    frameTimer: null,
    pendingAudio: null,
    sessionId: null,
    stopped: false,
    stats: { sent: 0, accepted: 0, dropped: 0, audio: 0 },
  };

  ui.start.hidden = true;
  ui.end.hidden = false;
  show('Connecting…', { state: 'connecting' });

  const duplex = new WebSocket(socketUrl('/ws/duplex'));
  duplex.binaryType = 'arraybuffer';
  live.duplex = duplex;
  duplex.addEventListener('message', (event) => handleDuplex(session, event));
  duplex.addEventListener('close', (event) => {
    if (!live || live.stopped) return;
    if (event.code === 1013) {
      // The single model slot is taken. Say that in words a person can act on.
      show('Genesis is in another live session right now. Try again in a moment.', { tone: 'busy' });
    } else {
      show('Connection lost.', { tone: 'bad' });
    }
    void stop({ keepMessage: true });
  });
  duplex.addEventListener('error', () => {
    if (live && !live.stopped) show('Could not connect to Genesis.', { tone: 'bad' });
  });
}

async function stop({ keepMessage = false } = {}) {
  const session = live;
  if (!session || session.stopped) return;
  session.stopped = true;
  live = null;

  if (session.frameTimer) clearInterval(session.frameTimer);
  for (const socket of [session.screen, session.duplex]) {
    if (socket && socket.readyState <= WebSocket.OPEN) {
      try { socket.close(1000, 'ended'); } catch { /* already closing */ }
    }
  }
  if (session.mic) {
    session.mic.capture.port.onmessage = null;
    try { session.mic.source.disconnect(); } catch { /* not connected */ }
    try { session.mic.capture.disconnect(); } catch { /* not connected */ }
    try { await session.mic.context.close(); } catch { /* already closed */ }
  }
  await session.playback.close();
  // Last, and unconditionally: this is what turns the phone's indicators off.
  for (const stream of [session.media.video, session.media.audio]) {
    for (const track of stream.getTracks()) track.stop();
  }
  ui.preview.srcObject = null;

  ui.end.hidden = true;
  ui.start.hidden = false;
  ui.start.disabled = false;
  if (!keepMessage) show('Session ended.', { state: 'idle', tone: null });
  else ui.root.dataset.state = 'idle';
}

ui.start.addEventListener('click', () => { void start(); });
ui.end.addEventListener('click', () => { void stop(); });
// A backgrounded or closed tab must not leave the camera on.
window.addEventListener('pagehide', () => { void stop({ keepMessage: true }); });
