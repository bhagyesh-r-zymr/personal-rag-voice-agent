import { VOICE_STATES } from './voiceHelpers.js';

// Captures the mic, resamples it to 16-bit PCM and hands each chunk to the page.
const CAPTURE_WORKLET = `
class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ratio = sampleRate / options.processorOptions.targetRate;
    this.pos = 0;
    this.out = [];
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    for (; this.pos < input.length; this.pos += this.ratio) {
      const s = Math.max(-1, Math.min(1, input[Math.floor(this.pos)]));
      this.out.push(s < 0 ? s * 0x8000 : s * 0x7fff);
    }
    this.pos -= input.length;
    if (this.out.length >= 1600) {
      this.port.postMessage(Int16Array.from(this.out).buffer, []);
      this.out = [];
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
`;

function wsUrl(path) {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${path}`;
}

// Talks to the server's Gemini Live proxy. Binary frames carry audio both ways;
// text frames carry JSON events (ready, transcript, citations, interrupted, turnComplete, error).
export function createLiveVoice({ liveConfig, onState, onTranscript, onCitations, onTurnComplete }) {
  let socket = null;
  let micStream = null;
  let captureCtx = null;
  let playCtx = null;
  let playhead = 0;
  let playing = [];
  let active = false;

  function playPcm(buffer) {
    const samples = new Int16Array(buffer);
    if (!samples.length) return;

    const audio = playCtx.createBuffer(1, samples.length, liveConfig.outputSampleRate);
    const channel = audio.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) channel[i] = samples[i] / 0x8000;

    const source = playCtx.createBufferSource();
    source.buffer = audio;
    source.connect(playCtx.destination);
    playhead = Math.max(playhead, playCtx.currentTime + 0.03);
    source.start(playhead);
    playhead += audio.duration;
    playing.push(source);
    source.onended = () => {
      playing = playing.filter((s) => s !== source);
      if (!playing.length && active) onState(VOICE_STATES.LISTENING, 'Go ahead, I am listening.');
    };
    onState(VOICE_STATES.SPEAKING, 'Answering from your policies.');
  }

  function stopPlayback() {
    playing.forEach((s) => {
      try {
        s.stop();
      } catch (error) {
        // Already stopped.
      }
    });
    playing = [];
    playhead = 0;
  }

  function handleEvent(event) {
    switch (event.type) {
      case 'ready':
        onState(VOICE_STATES.LISTENING, 'Connected. Ask your policy question out loud.');
        break;
      case 'transcript':
        if (event.role === 'user' && event.text?.trim()) onState(VOICE_STATES.PROCESSING, 'Searching your policies.');
        onTranscript(event.role, event.text || '', Boolean(event.final));
        break;
      case 'citations':
        onCitations(event.citations || []);
        break;
      case 'interrupted':
        stopPlayback();
        onState(VOICE_STATES.LISTENING, 'Listening.');
        break;
      case 'turnComplete':
        onTurnComplete();
        break;
      case 'error':
        stop(event.message || 'The live voice session hit an error.');
        break;
      default:
        break;
    }
  }

  async function startMic() {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    captureCtx = new AudioContext();
    const moduleUrl = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'text/javascript' }));
    await captureCtx.audioWorklet.addModule(moduleUrl);
    URL.revokeObjectURL(moduleUrl);

    const node = new AudioWorkletNode(captureCtx, 'pcm-capture', {
      processorOptions: { targetRate: liveConfig.inputSampleRate }
    });
    node.port.onmessage = (e) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(e.data);
    };
    captureCtx.createMediaStreamSource(micStream).connect(node);
  }

  async function start() {
    active = true;
    onState(VOICE_STATES.GREETING, 'Connecting to Gemini Live…');

    try {
      playCtx = new AudioContext();
      await startMic();
    } catch (error) {
      const denied = error?.name === 'NotAllowedError';
      stop(denied ? 'Microphone permission was denied. Allow it or use text chat.' : 'Could not start the microphone.');
      return;
    }

    socket = new WebSocket(wsUrl(liveConfig.wsPath));
    socket.binaryType = 'arraybuffer';
    socket.onmessage = (e) => {
      if (typeof e.data === 'string') {
        try {
          handleEvent(JSON.parse(e.data));
        } catch (error) {
          // Ignore malformed events.
        }
      } else {
        playPcm(e.data);
      }
    };
    socket.onclose = () => {
      if (active) stop('The live voice session ended.');
    };
  }

  function stop(detail = 'You can restart it whenever you are ready.') {
    const wasActive = active;
    active = false;
    stopPlayback();
    micStream?.getTracks().forEach((t) => t.stop());
    captureCtx?.close();
    playCtx?.close();
    if (socket && socket.readyState <= WebSocket.OPEN) socket.close();
    socket = micStream = captureCtx = playCtx = null;
    if (wasActive) onState(VOICE_STATES.STOPPED, detail);
  }

  return { start, stop, isActive: () => active };
}
