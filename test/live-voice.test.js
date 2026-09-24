import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import {
  attachLiveVoiceServer,
  buildLiveConnectConfig,
  createLiveBridge,
  SEARCH_POLICIES_TOOL
} from '../src/services/liveVoice.js';

const silentLogger = { error() {}, warn() {} };

function makeFakeSession() {
  return {
    realtime: [],
    toolResponses: [],
    clientContent: [],
    closed: false,
    sendRealtimeInput(p) {
      this.realtime.push(p);
    },
    sendToolResponse(p) {
      this.toolResponses.push(p);
    },
    sendClientContent(p) {
      this.clientContent.push(p);
    },
    close() {
      this.closed = true;
    }
  };
}

async function makeBridge({ retrievePolicyContext = async () => [] } = {}) {
  const session = makeFakeSession();
  const sent = [];
  const closes = [];
  let callbacks;
  const queries = [];
  const bridge = createLiveBridge({
    connectGemini: async (cb) => {
      callbacks = cb;
      return session;
    },
    retrievePolicyContext: async (q) => {
      queries.push(q);
      return retrievePolicyContext(q);
    },
    sendToBrowser: (m) => sent.push(m),
    closeBrowser: (code, reason) => closes.push({ code, reason }),
    logger: silentLogger
  });
  await bridge.start();
  return { bridge, session, sent, closes, queries, callbacks: () => callbacks };
}

const RESULTS = [
  { id: 1, docId: 'leave-policy', source: 'Leave Policy.pdf', page: 3, score: 0.82, text: 'Employees get 20 days PTO.' },
  { id: 2, docId: 'leave-policy', source: 'Leave Policy.pdf', page: 4, score: 0.71, text: 'PTO carries over up to 5 days.' }
];

test('buildLiveConnectConfig requests audio, transcriptions and the search_policies tool', () => {
  const cfg = buildLiveConnectConfig();
  assert.deepEqual(cfg.responseModalities, ['AUDIO']);
  assert.deepEqual(cfg.inputAudioTranscription, {});
  assert.deepEqual(cfg.outputAudioTranscription, {});
  assert.match(cfg.systemInstruction, /search_policies/);
  assert.match(cfg.systemInstruction, /I couldn't find that in the company policies\./);
  const [decl] = cfg.tools[0].functionDeclarations;
  assert.equal(decl.name, SEARCH_POLICIES_TOOL);
  assert.equal(decl.parameters.properties.query.type, 'STRING');
  assert.deepEqual(decl.parameters.required, ['query']);
});

test('tool call runs retrieval, sends tool response and citations to the browser', async () => {
  const { bridge, session, sent, queries } = await makeBridge({ retrievePolicyContext: async () => RESULTS });

  await bridge.handleGeminiMessage({
    toolCall: { functionCalls: [{ id: 'call-1', name: 'search_policies', args: { query: 'how much PTO' } }] }
  });

  assert.deepEqual(queries, ['how much PTO']);
  assert.equal(session.toolResponses.length, 1);
  assert.deepEqual(session.toolResponses[0], {
    functionResponses: [
      {
        id: 'call-1',
        name: 'search_policies',
        response: {
          results: [
            { source: 'Leave Policy.pdf', page: 3, text: 'Employees get 20 days PTO.' },
            { source: 'Leave Policy.pdf', page: 4, text: 'PTO carries over up to 5 days.' }
          ]
        }
      }
    ]
  });
  assert.deepEqual(sent, [{ type: 'citations', citations: RESULTS }]);
});

test('tool call with no results returns empty results and no citations message', async () => {
  const { bridge, session, sent } = await makeBridge({ retrievePolicyContext: async () => [] });
  await bridge.handleGeminiMessage({
    toolCall: { functionCalls: [{ id: 'c', name: 'search_policies', args: { query: 'pet insurance' } }] }
  });
  const [resp] = session.toolResponses[0].functionResponses;
  assert.deepEqual(resp.response.results, []);
  assert.match(resp.response.note, /couldn't find that in the company policies/);
  assert.deepEqual(sent, []);
});

test('retrieval failure still answers the tool call with an error', async () => {
  const { bridge, session } = await makeBridge({
    retrievePolicyContext: async () => {
      throw new Error('pinecone down');
    }
  });
  await bridge.handleGeminiMessage({
    toolCall: { functionCalls: [{ id: 'c', name: 'search_policies', args: { query: 'x' } }] }
  });
  const [resp] = session.toolResponses[0].functionResponses;
  assert.equal(resp.id, 'c');
  assert.ok(resp.response.error);
  assert.deepEqual(resp.response.results, []);
});

test('model audio parts become binary frames to the browser', async () => {
  const { bridge, sent } = await makeBridge();
  const pcm = Buffer.from([1, 2, 3, 4, 5, 6]);
  await bridge.handleGeminiMessage({
    serverContent: {
      modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcm.toString('base64') } }] }
    }
  });
  assert.equal(sent.length, 1);
  assert.ok(Buffer.isBuffer(sent[0]));
  assert.deepEqual(sent[0], pcm);
});

test('transcriptions, setup, interruption and turn completion map to JSON messages', async () => {
  const { bridge, sent } = await makeBridge();
  await bridge.handleGeminiMessage({ setupComplete: {} });
  await bridge.handleGeminiMessage({ serverContent: { inputTranscription: { text: 'How much PTO' } } });
  await bridge.handleGeminiMessage({ serverContent: { inputTranscription: { text: ' do I get?', finished: true } } });
  await bridge.handleGeminiMessage({ serverContent: { outputTranscription: { text: 'You get 20 days.' } } });
  await bridge.handleGeminiMessage({ serverContent: { interrupted: true } });
  await bridge.handleGeminiMessage({ serverContent: { turnComplete: true } });
  assert.deepEqual(sent, [
    { type: 'ready' },
    { type: 'transcript', role: 'user', text: 'How much PTO' },
    { type: 'transcript', role: 'user', text: ' do I get?', final: true },
    { type: 'transcript', role: 'assistant', text: 'You get 20 days.' },
    { type: 'interrupted' },
    { type: 'turnComplete' }
  ]);
});

test('browser binary audio is forwarded as base64 PCM realtime input', async () => {
  const { bridge, session } = await makeBridge();
  const pcm = Buffer.from([0x10, 0x00, 0xff, 0x7f]);
  bridge.handleBrowserMessage(pcm, true);
  assert.deepEqual(session.realtime, [
    { audio: { data: pcm.toString('base64'), mimeType: 'audio/pcm;rate=16000' } }
  ]);
});

test('browser JSON text and audioStreamEnd messages are forwarded', async () => {
  const { bridge, session, sent } = await makeBridge();
  bridge.handleBrowserMessage(Buffer.from(JSON.stringify({ type: 'text', text: 'What is the dress code?' })), false);
  bridge.handleBrowserMessage(Buffer.from(JSON.stringify({ type: 'audioStreamEnd' })), false);
  bridge.handleBrowserMessage(Buffer.from('not json'), false);
  assert.deepEqual(session.realtime, [{ text: 'What is the dress code?' }, { audioStreamEnd: true }]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'error');
});

test('closing the bridge closes the Gemini session; Gemini close closes the browser', async () => {
  const a = await makeBridge();
  a.bridge.close();
  assert.equal(a.session.closed, true);

  const b = await makeBridge();
  b.callbacks().onclose({ code: 1000, reason: '' });
  assert.deepEqual(b.closes, [{ code: 1000, reason: 'Gemini session closed' }]);
});

async function startServer(deps) {
  const server = http.createServer();
  attachLiveVoiceServer(server, { logger: silentLogger, authenticate: () => ({ id: 1, role: 'employee' }), ...deps });
  server.listen(0);
  await once(server, 'listening');
  return { server, url: `ws://127.0.0.1:${server.address().port}/api/live` };
}

function collect(ws) {
  const messages = [];
  const waiters = [];
  ws.on('message', (data, isBinary) => {
    messages.push(isBinary ? Buffer.from(data) : JSON.parse(data.toString()));
    waiters.splice(0).forEach((w) => w());
  });
  return {
    messages,
    async waitFor(n) {
      while (messages.length < n) await new Promise((r) => waiters.push(r));
    }
  };
}

test('WebSocket endpoint rejects connections when GEMINI_API_KEY is empty', async () => {
  const { server, url } = await startServer({ apiKey: '', connectGemini: async () => assert.fail('should not connect') });
  const ws = new WebSocket(url);
  const c = collect(ws);
  await once(ws, 'close');
  assert.equal(c.messages[0].type, 'error');
  server.close();
});

test('WebSocket endpoint bridges browser and fake Gemini end to end', async () => {
  const session = makeFakeSession();
  let callbacks;
  const { server, url } = await startServer({
    apiKey: 'test-key',
    connectGemini: async (cb) => {
      callbacks = cb;
      setImmediate(() => cb.onmessage({ setupComplete: {} }));
      return session;
    },
    retrievePolicyContext: async () => RESULTS.slice(0, 1)
  });

  const ws = new WebSocket(url);
  const c = collect(ws);
  await c.waitFor(1);
  assert.deepEqual(c.messages[0], { type: 'ready' });

  ws.send(Buffer.from([1, 0, 2, 0]), { binary: true });
  ws.send(JSON.stringify({ type: 'text', text: 'hi' }));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(session.realtime[0].audio.data, Buffer.from([1, 0, 2, 0]).toString('base64'));
  assert.deepEqual(session.realtime[1], { text: 'hi' });

  callbacks.onmessage({ toolCall: { functionCalls: [{ id: 't1', name: 'search_policies', args: { query: 'pto' } }] } });
  callbacks.onmessage({
    serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: Buffer.from([9, 9]).toString('base64') } }] } }
  });
  await c.waitFor(3);
  const citations = c.messages.find((m) => m.type === 'citations');
  assert.equal(citations.citations[0].source, 'Leave Policy.pdf');
  assert.ok(c.messages.some((m) => Buffer.isBuffer(m) && m.equals(Buffer.from([9, 9]))));
  assert.equal(session.toolResponses[0].functionResponses[0].id, 't1');

  ws.close();
  await once(ws, 'close');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(session.closed, true);
  server.close();
});

test('WebSocket endpoint refuses voice connections from signed-out users', async () => {
  const { server, url } = await startServer({
    apiKey: 'test-key',
    authenticate: () => null,
    connectGemini: async () => assert.fail('should not connect')
  });
  const ws = new WebSocket(url);
  const [, res] = await once(ws, 'unexpected-response');
  assert.equal(res.statusCode, 401);
  res.destroy();
  server.close();
});

test('WebSocket endpoint searches only the policies the signed-in role may read', async () => {
  const session = makeFakeSession();
  let callbacks;
  const seen = [];
  const { server, url } = await startServer({
    apiKey: 'test-key',
    authenticate: () => ({ id: 7, role: 'manager' }),
    connectGemini: async (cb) => {
      callbacks = cb;
      setImmediate(() => cb.onmessage({ setupComplete: {} }));
      return session;
    },
    retrievePolicyContext: async (query, options) => {
      seen.push([query, options]);
      return [];
    }
  });

  const ws = new WebSocket(url);
  const c = collect(ws);
  await c.waitFor(1);
  await callbacks.onmessage({
    toolCall: { functionCalls: [{ id: 'c1', name: 'search_policies', args: { query: 'bonus' } }] }
  });
  assert.deepEqual(seen, [['bonus', { role: 'manager' }]]);
  ws.close();
  server.close();
});
