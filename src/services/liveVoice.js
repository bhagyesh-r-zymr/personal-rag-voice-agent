/**
 * Server-side Gemini Live voice proxy.
 *
 * The browser never sees the Gemini API key: it opens a WebSocket to this
 * server at `/api/live`, and the server opens a Gemini Live session on its
 * behalf, grounding answers in the indexed policies through a
 * `search_policies` tool that runs the RAG retrieval server-side.
 *
 * Protocol (browser <-> server, one WebSocket per voice session)
 * -------------------------------------------------------------
 * Browser -> server
 *   - binary frame: raw 16-bit little-endian PCM, mono, 16 kHz microphone audio.
 *   - text frame (JSON):
 *       { "type": "text", "text": "..." }   send a typed user turn
 *       { "type": "audioStreamEnd" }        the microphone was turned off
 *
 * Server -> browser
 *   - binary frame: raw 16-bit little-endian PCM, mono, 24 kHz model audio.
 *   - text frame (JSON):
 *       { "type": "ready" }                                        Gemini setup complete; start streaming
 *       { "type": "transcript", "role": "user"|"assistant", "text": "...", "final"?: true }
 *                                                                  incremental transcription chunks
 *       { "type": "citations", "citations": [{ id, docId, source, page, score, text }] }
 *                                                                  policy passages used for the current answer
 *       { "type": "interrupted" }                                  user barged in; flush queued playback
 *       { "type": "turnComplete" }                                 model finished its turn
 *       { "type": "error", "message": "..." }                      fatal or per-message error
 *
 * Closing either side closes the other. Messages larger than MAX_PAYLOAD_BYTES
 * are rejected by the WebSocket server (the connection is closed with 1009).
 */
import { WebSocketServer } from 'ws';
import { config } from '../config.js';

export const LIVE_WS_PATH = '/api/live';
export const INPUT_SAMPLE_RATE = 16000;
export const OUTPUT_SAMPLE_RATE = 24000;
export const MAX_PAYLOAD_BYTES = 1024 * 1024;
export const NOT_FOUND_ANSWER = "I couldn't find that in the company policies.";

export const SEARCH_POLICIES_TOOL = 'search_policies';

export const SYSTEM_INSTRUCTION = `You are a voice assistant for company policies.
Rules:
1) Before answering ANY question about company policies, benefits, leave, conduct, IT, security, expenses or other workplace rules, call the ${SEARCH_POLICIES_TOOL} tool with a concise search query.
2) Answer ONLY from the passages returned by ${SEARCH_POLICIES_TOOL}. Never use outside knowledge or guess.
3) If the tool returns no results, or the results do not contain the answer, say exactly: "${NOT_FOUND_ANSWER}"
4) Keep spoken answers short: one to three sentences, plain conversational language, no lists, no markdown and no citation markers.
5) When it helps, mention the name of the policy document the answer comes from.
6) For greetings or small talk, reply briefly and invite a policy question.`;

/**
 * Builds the LiveConnectConfig used for every browser session.
 * Plain strings are used for enum values ('AUDIO', 'OBJECT', 'STRING'), which
 * equal the SDK's Modality.AUDIO and Type.* values.
 */
export function buildLiveConnectConfig() {
  return {
    responseModalities: ['AUDIO'],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    systemInstruction: SYSTEM_INSTRUCTION,
    tools: [
      {
        functionDeclarations: [
          {
            name: SEARCH_POLICIES_TOOL,
            description:
              'Searches the indexed company policy documents and returns the most relevant passages with their source document and page.',
            parameters: {
              type: 'OBJECT',
              properties: {
                query: {
                  type: 'STRING',
                  description: 'A short search query describing what the user wants to know.'
                }
              },
              required: ['query']
            }
          }
        ]
      }
    ]
  };
}

function toCitation(result) {
  return {
    id: result.id,
    docId: result.docId,
    source: result.source,
    page: result.page,
    score: result.score,
    text: result.text
  };
}

function rawToBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(String(data));
}

/**
 * Transport-independent bridge between one browser connection and one Gemini
 * Live session. All I/O is injected so it can be unit tested without network.
 *
 * @param {object} deps
 * @param {(callbacks: {onopen, onmessage, onerror, onclose}) => Promise<{sendRealtimeInput, sendToolResponse, sendClientContent, close}>} deps.connectGemini
 * @param {(query: string) => Promise<Array<{id:number, docId, source, page, score, text}>>} deps.retrievePolicyContext
 * @param {(message: object | Buffer) => void} deps.sendToBrowser  Buffers are sent as binary frames, objects as JSON text frames.
 * @param {(code?: number, reason?: string) => void} [deps.closeBrowser]
 * @param {{ error: Function, warn?: Function }} [deps.logger]
 */
export function createLiveBridge({
  connectGemini,
  retrievePolicyContext,
  sendToBrowser,
  closeBrowser = () => {},
  logger = console
}) {
  let session = null;
  let closed = false;

  function send(message) {
    if (closed && !Buffer.isBuffer(message) && message?.type !== 'error') return;
    try {
      sendToBrowser(message);
    } catch (error) {
      logger.error('[live] failed to send to browser', error);
    }
  }

  function sendError(message) {
    send({ type: 'error', message });
  }

  async function runSearch(call) {
    const query = String(call?.args?.query || '').trim();
    let results = [];
    let errorMessage = null;
    if (query) {
      try {
        results = (await retrievePolicyContext(query)) || [];
      } catch (error) {
        logger.error('[live] policy retrieval failed', error);
        errorMessage = 'Policy search failed.';
      }
    }

    const citations = results.map(toCitation);
    if (citations.length) send({ type: 'citations', citations });

    const response = errorMessage
      ? { error: errorMessage, results: [] }
      : {
          results: results.map((r) => ({ source: r.source, page: r.page, text: r.text })),
          ...(results.length ? {} : { note: `No matching policy passages. Say: "${NOT_FOUND_ANSWER}"` })
        };
    return { id: call.id, name: call.name, response };
  }

  async function handleToolCall(toolCall) {
    const calls = toolCall?.functionCalls || [];
    const functionResponses = await Promise.all(
      calls.map((call) =>
        call.name === SEARCH_POLICIES_TOOL
          ? runSearch(call)
          : { id: call.id, name: call.name, response: { error: `Unknown tool: ${call.name}` } }
      )
    );
    if (!functionResponses.length || closed || !session) return;
    try {
      session.sendToolResponse({ functionResponses });
    } catch (error) {
      logger.error('[live] failed to send tool response', error);
    }
  }

  /** Handles one LiveServerMessage from Gemini. Returns a promise that settles when any tool call is answered. */
  function handleGeminiMessage(message) {
    if (!message || closed) return Promise.resolve();

    if (message.setupComplete) send({ type: 'ready' });

    const content = message.serverContent;
    if (content) {
      if (content.interrupted) send({ type: 'interrupted' });

      for (const part of content.modelTurn?.parts || []) {
        const data = part.inlineData?.data;
        if (data && String(part.inlineData.mimeType || 'audio/pcm').startsWith('audio/')) {
          send(Buffer.from(data, 'base64'));
        }
      }

      if (content.inputTranscription?.text || content.inputTranscription?.finished) {
        send(transcript('user', content.inputTranscription));
      }
      if (content.outputTranscription?.text || content.outputTranscription?.finished) {
        send(transcript('assistant', content.outputTranscription));
      }

      if (content.turnComplete) send({ type: 'turnComplete' });
    }

    if (message.goAway) {
      logger.warn?.('[live] Gemini sent goAway', message.goAway);
    }

    if (message.toolCall) {
      return handleToolCall(message.toolCall).catch((error) => {
        logger.error('[live] tool call handling failed', error);
      });
    }
    return Promise.resolve();
  }

  function transcript(role, t) {
    const msg = { type: 'transcript', role, text: t.text || '' };
    if (t.finished) msg.final = true;
    return msg;
  }

  /** Handles one frame from the browser. */
  function handleBrowserMessage(data, isBinary) {
    if (closed) return;
    if (!session) {
      // Mic audio that arrives before Gemini is connected is dropped silently.
      if (!isBinary) sendError('Live session is not ready yet.');
      return;
    }

    if (isBinary) {
      const buf = rawToBuffer(data);
      if (!buf.length) return;
      session.sendRealtimeInput({
        audio: { data: buf.toString('base64'), mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}` }
      });
      return;
    }

    let msg;
    try {
      msg = JSON.parse(rawToBuffer(data).toString('utf8'));
    } catch {
      sendError('Invalid JSON message.');
      return;
    }

    if (msg?.type === 'text') {
      const text = String(msg.text || '').trim();
      if (!text) return;
      // Realtime text is accepted by current Live models (including gemini-3.x
      // Live, where sendClientContent is limited to seeding history) and is
      // treated as a user turn by voice activity handling.
      session.sendRealtimeInput({ text });
    } else if (msg?.type === 'audioStreamEnd') {
      session.sendRealtimeInput({ audioStreamEnd: true });
    } else {
      sendError(`Unknown message type: ${msg?.type}`);
    }
  }

  async function start() {
    try {
      const s = await connectGemini({
        onopen: () => {},
        onmessage: (message) => {
          handleGeminiMessage(message);
        },
        onerror: (event) => {
          logger.error('[live] Gemini error', event?.message || event);
          sendError('Voice service error.');
        },
        onclose: (event) => {
          if (closed) return;
          closed = true;
          const reason = event?.reason ? String(event.reason).slice(0, 120) : '';
          if (event?.code && event.code !== 1000) {
            sendError(`Voice session ended by Gemini${reason ? `: ${reason}` : ''}.`);
          }
          closeBrowser(1000, 'Gemini session closed');
        }
      });
      if (closed) {
        s?.close?.();
        return;
      }
      session = s;
    } catch (error) {
      logger.error('[live] failed to connect to Gemini Live', error);
      sendError('Could not connect to the voice service.');
      closed = true;
      closeBrowser(1011, 'Gemini connection failed');
    }
  }

  /** Called when the browser disconnects. */
  function close() {
    if (closed && !session) return;
    closed = true;
    try {
      session?.close();
    } catch (error) {
      logger.error('[live] failed to close Gemini session', error);
    }
    session = null;
  }

  return { start, close, handleBrowserMessage, handleGeminiMessage, handleToolCall };
}

async function defaultRetrievePolicyContext(query) {
  const chat = await import('./chat.js');
  return chat.retrievePolicyContext(query);
}

async function defaultConnectGemini(callbacks) {
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
  return ai.live.connect({ model: config.liveModel, config: buildLiveConnectConfig(), callbacks });
}

/**
 * Attaches the `/api/live` WebSocket endpoint to an existing HTTP server.
 */
export function attachLiveVoiceServer(httpServer, deps = {}) {
  const {
    connectGemini = defaultConnectGemini,
    retrievePolicyContext = defaultRetrievePolicyContext,
    apiKey = config.geminiApiKey,
    logger = console
  } = deps;

  const wss = new WebSocketServer({ server: httpServer, path: LIVE_WS_PATH, maxPayload: MAX_PAYLOAD_BYTES });

  wss.on('connection', (ws) => {
    const sendToBrowser = (message) => {
      if (ws.readyState !== ws.OPEN) return;
      if (Buffer.isBuffer(message)) ws.send(message, { binary: true });
      else ws.send(JSON.stringify(message));
    };

    if (!apiKey) {
      sendToBrowser({ type: 'error', message: 'Gemini Live is not configured on the server (GEMINI_API_KEY is empty).' });
      ws.close(1011, 'Gemini Live not configured');
      return;
    }

    const bridge = createLiveBridge({
      connectGemini,
      retrievePolicyContext,
      sendToBrowser,
      closeBrowser: (code, reason) => {
        if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, reason);
      },
      logger
    });

    ws.on('message', (data, isBinary) => {
      try {
        bridge.handleBrowserMessage(data, isBinary);
      } catch (error) {
        logger.error('[live] failed to forward browser message', error);
        sendToBrowser({ type: 'error', message: 'Failed to forward message to the voice service.' });
      }
    });
    ws.on('close', () => bridge.close());
    ws.on('error', (error) => {
      logger.error('[live] browser socket error', error);
      bridge.close();
    });

    bridge.start();
  });

  return wss;
}
