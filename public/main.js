import { VOICE_STATES, getVoiceStatusText } from './voiceHelpers.js';
import { createBrowserVoice } from './browserVoice.js';
import { createLiveVoice } from './liveVoiceClient.js';

const SUGGESTIONS = [
  'How many days of annual leave do I get?',
  'What is the work from home policy?',
  'How do I claim travel expenses?',
  'What is the notice period for resignation?'
];

const dom = {
  chat: document.getElementById('chat'),
  citations: document.getElementById('citations'),
  docCount: document.getElementById('docCount'),
  docList: document.getElementById('docList'),
  dropzone: document.getElementById('dropzone'),
  exportButton: document.getElementById('exportButton'),
  historyList: document.getElementById('historyList'),
  libraryPill: document.getElementById('libraryPill'),
  libraryPillText: document.getElementById('libraryPillText'),
  message: document.getElementById('message'),
  newSessionButton: document.getElementById('newSessionButton'),
  pdf: document.getElementById('pdf'),
  sendButton: document.getElementById('sendButton'),
  uploadProgress: document.getElementById('uploadProgress'),
  uploadStatus: document.getElementById('uploadStatus'),
  voiceBar: document.getElementById('voiceBar'),
  voiceMode: document.getElementById('voiceMode'),
  voiceStatus: document.getElementById('voiceStatus'),
  voiceStopButton: document.getElementById('voiceStopButton'),
  voiceToggleButton: document.getElementById('voiceToggleButton')
};

const state = {
  sessionId: null,
  transcript: [],
  documents: [],
  history: [],
  busy: false,
  voice: null,
  liveTurn: { user: null, assistant: null, citations: [] }
};

// ---------- helpers ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function timeLabel(date = new Date()) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

async function getJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Renders answer text with [1] / [1, 2] markers turned into clickable source chips.
function renderAnswerText(container, text) {
  const pattern = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    container.append(text.slice(last, match.index));
    match[1].split(',').forEach((n) => {
      const id = Number(n.trim());
      const chip = el('button', 'cite', String(id));
      chip.type = 'button';
      chip.title = `Show source ${id}`;
      chip.addEventListener('click', () => focusSource(id));
      container.append(chip);
    });
    last = match.index + match[0].length;
  }
  container.append(text.slice(last));
}

// ---------- chat ----------

function renderWelcome() {
  dom.chat.innerHTML = '';
  const welcome = el('div', 'welcome');
  welcome.append(el('h1', '', 'Ask anything about company policy'));
  welcome.append(
    el(
      'p',
      '',
      state.documents.length
        ? 'Answers are grounded in your uploaded policies, with the exact pages cited.'
        : 'Upload a policy PDF on the left to get started. Answers cite the exact pages they come from.'
    )
  );
  const chips = el('div', 'suggestions');
  SUGGESTIONS.forEach((q) => {
    const chip = el('button', 'chip', q);
    chip.type = 'button';
    chip.addEventListener('click', () => void submitQuestion(q));
    chips.append(chip);
  });
  welcome.append(chips);
  dom.chat.append(welcome);
}

function appendMessage(role, text, { error = false, at = new Date() } = {}) {
  dom.chat.querySelector('.welcome')?.remove();

  const row = el('div', `msg ${role}${error ? ' error' : ''}`);
  row.append(el('div', 'avatar', role === 'user' ? 'Y' : '§'));
  const body = el('div');
  const bubble = el('div', 'bubble');
  if (role === 'assistant') renderAnswerText(bubble, text);
  else bubble.textContent = text;
  const meta = el('div', 'msg-meta', timeLabel(at));
  body.append(bubble, meta);
  row.append(body);
  dom.chat.append(row);
  dom.chat.scrollTop = dom.chat.scrollHeight;

  const entry = { role, text, at };
  state.transcript.push(entry);
  return { row, bubble, entry };
}

function showTyping() {
  const row = el('div', 'msg assistant');
  row.append(el('div', 'avatar', '§'));
  const bubble = el('div', 'bubble');
  const dots = el('span', 'typing');
  dots.append(el('span'), el('span'), el('span'));
  dots.setAttribute('aria-label', 'Searching policies');
  bubble.append(dots);
  row.append(bubble);
  dom.chat.append(row);
  dom.chat.scrollTop = dom.chat.scrollHeight;
  return row;
}

function setBusy(busy) {
  state.busy = busy;
  dom.sendButton.disabled = busy;
}

async function newSession() {
  state.voice?.stop('Starting a new chat.');
  state.transcript = [];
  renderCitations([]);
  try {
    const data = await getJson('/api/session', { method: 'POST' });
    state.sessionId = data.sessionId;
  } catch (error) {
    state.sessionId = null;
  }
  renderWelcome();
  renderHistory();
}

async function submitQuestion(message) {
  const question = message.trim();
  if (!question || state.busy) return null;

  if (!state.sessionId) await newSession();
  appendMessage('user', question);
  dom.message.value = '';
  autosize();

  setBusy(true);
  const typing = showTyping();
  try {
    const data = await getJson('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId, message: question })
    });
    typing.remove();
    appendMessage('assistant', data.text);
    renderCitations(data.citations || []);
    void loadHistory();
    return data.text;
  } catch (error) {
    typing.remove();
    const text = error.message || 'Something went wrong while checking the policies. Please try again.';
    appendMessage('assistant', text, { error: true });
    return text;
  } finally {
    setBusy(false);
  }
}

// ---------- history ----------

function historyWhen(iso) {
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay ? timeLabel(date) : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function renderHistory() {
  dom.historyList.innerHTML = '';
  if (!state.history.length) {
    dom.historyList.append(el('li', 'empty-note', 'Your past chats will appear here.'));
    return;
  }

  state.history.forEach((chat) => {
    const item = el('li', `history-item${chat.id === state.sessionId ? ' active' : ''}`);
    const open = el('button', 'history-open');
    open.type = 'button';
    open.title = chat.title;
    open.append(
      el('span', 'history-title', chat.title),
      el('span', 'history-meta', `${historyWhen(chat.updatedAt)} · ${chat.messageCount} messages`)
    );
    open.addEventListener('click', () => void openSession(chat.id));
    const remove = el('button', 'doc-remove', '✕');
    remove.type = 'button';
    remove.title = 'Delete this chat';
    remove.setAttribute('aria-label', `Delete chat "${chat.title}"`);
    remove.addEventListener('click', () => void deleteChat(chat));
    item.append(open, remove);
    dom.historyList.append(item);
  });
}

async function loadHistory() {
  try {
    const data = await getJson('/api/sessions');
    state.history = data.sessions || [];
  } catch (error) {
    state.history = [];
  }
  renderHistory();
}

async function openSession(sessionId) {
  if (state.busy || sessionId === state.sessionId) return;
  if (state.voice?.isActive()) state.voice.stop('Opening a saved chat.');
  try {
    const data = await getJson(`/api/session/${encodeURIComponent(sessionId)}`);
    state.sessionId = data.id;
    state.transcript = [];
    dom.chat.innerHTML = '';
    data.messages.forEach((m) => appendMessage(m.role, m.text, { at: new Date(m.ts) }));
    if (!data.messages.length) renderWelcome();
    const lastAnswer = [...data.messages].reverse().find((m) => m.role === 'assistant');
    renderCitations(lastAnswer?.citations || []);
    renderHistory();
  } catch (error) {
    setUploadStatus(error.message || 'Could not open that chat.', 'error');
    await loadHistory();
  }
}

async function deleteChat(chat) {
  if (!window.confirm(`Delete the chat "${chat.title}"?`)) return;
  try {
    await getJson(`/api/session/${encodeURIComponent(chat.id)}`, { method: 'DELETE' });
    if (chat.id === state.sessionId) await newSession();
  } catch (error) {
    setUploadStatus(error.message || 'Could not delete the chat.', 'error');
  }
  await loadHistory();
}

// Gemini Live answers over its own socket, so save each finished turn here.
async function saveLiveTurn(turn) {
  const messages = [];
  if (turn.user?.entry.text.trim()) messages.push({ role: 'user', text: turn.user.entry.text });
  if (turn.assistant?.entry.text.trim()) {
    messages.push({ role: 'assistant', text: turn.assistant.entry.text, citations: turn.citations });
  }
  if (!messages.length || !state.sessionId) return;
  try {
    await getJson(`/api/session/${encodeURIComponent(state.sessionId)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages })
    });
    await loadHistory();
  } catch (error) {
    // Losing a voice turn from history should not interrupt the conversation.
  }
}

// ---------- sources ----------

function renderCitations(citations) {
  dom.citations.innerHTML = '';
  if (!citations.length) {
    dom.citations.append(el('p', 'empty-note', 'Sources for the latest answer will appear here.'));
    return;
  }

  citations.forEach((c) => {
    const card = el('article', 'source');
    card.dataset.sourceId = c.id;

    const head = el('div', 'source-head');
    head.append(el('span', 'source-num', String(c.id)), el('span', 'source-title', c.source || 'Policy document'));

    const meta = el('div', 'source-meta');
    meta.append(el('span', '', `Page ${c.page ?? '?'}`));
    const pct = Math.round(Math.max(0, Math.min(1, c.score ?? 0)) * 100);
    const score = el('span', 'score');
    score.title = `Relevance ${pct}%`;
    const fill = el('span');
    fill.style.width = `${pct}%`;
    score.append(fill);
    meta.append(score, el('span', '', `${pct}% match`));

    const text = el('p', 'source-text', c.text || '');
    const toggle = el('button', 'source-toggle', 'Show more');
    toggle.type = 'button';
    toggle.addEventListener('click', () => {
      toggle.textContent = card.classList.toggle('open') ? 'Show less' : 'Show more';
    });

    card.append(head, meta, text, toggle);
    dom.citations.append(card);
  });
}

function focusSource(id) {
  const card = dom.citations.querySelector(`[data-source-id="${id}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  card.classList.add('flash', 'open');
  card.querySelector('.source-toggle').textContent = 'Show less';
  setTimeout(() => card.classList.remove('flash'), 1400);
}

// ---------- library ----------

function renderLibrary() {
  const docs = state.documents;
  dom.docList.innerHTML = '';
  dom.docCount.textContent = docs.length ? `${docs.length} indexed` : '';
  dom.libraryPill.classList.toggle('ok', docs.length > 0);
  dom.libraryPillText.textContent = docs.length
    ? `${docs.length} ${docs.length === 1 ? 'policy' : 'policies'} ready`
    : 'No policies yet';

  if (!docs.length) {
    dom.docList.append(el('li', 'empty-note', 'No policies uploaded yet.'));
    return;
  }

  docs.forEach((doc) => {
    const item = el('li', 'doc');
    item.append(el('div', 'doc-icon', 'PDF'));
    const info = el('div');
    info.style.minWidth = '0';
    const name = el('div', 'doc-name', doc.name);
    name.title = doc.name;
    const when = new Date(doc.indexedAt).toLocaleDateString([], { month: 'short', day: 'numeric' });
    info.append(name, el('div', 'doc-meta', `${doc.pages} pages · ${doc.chunks} sections · ${when}`));
    const remove = el('button', 'doc-remove', '✕');
    remove.type = 'button';
    remove.title = `Remove ${doc.name}`;
    remove.setAttribute('aria-label', `Remove ${doc.name}`);
    remove.addEventListener('click', () => void removeDoc(doc));
    item.append(info, remove);
    dom.docList.append(item);
  });
}

async function loadLibrary() {
  try {
    const data = await getJson('/api/documents');
    state.documents = data.documents || [];
  } catch (error) {
    state.documents = [];
  }
  renderLibrary();
  if (!state.transcript.length) renderWelcome();
}

function setUploadStatus(text, kind = '') {
  dom.uploadStatus.textContent = text;
  dom.uploadStatus.className = `upload-status ${kind}`;
}

async function uploadFile(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name)) {
    setUploadStatus('Only PDF files are supported.', 'error');
    return;
  }

  const replacing = state.documents.some((d) => d.name.toLowerCase() === file.name.toLowerCase());
  const fd = new FormData();
  fd.append('file', file);
  setUploadStatus(`${replacing ? 'Replacing' : 'Indexing'} ${file.name}…`);
  dom.uploadProgress.classList.add('on');

  try {
    const data = await getJson('/api/upload-handbook', { method: 'POST', body: fd });
    setUploadStatus(`${replacing ? 'Updated' : 'Added'} ${data.name}: ${data.pages} pages indexed.`, 'ok');
    await loadLibrary();
  } catch (error) {
    setUploadStatus(error.message || 'Upload failed.', 'error');
  } finally {
    dom.uploadProgress.classList.remove('on');
    dom.pdf.value = '';
  }
}

async function removeDoc(doc) {
  if (!window.confirm(`Remove "${doc.name}" from the policy library?`)) return;
  try {
    await getJson(`/api/documents/${encodeURIComponent(doc.docId)}`, { method: 'DELETE' });
    setUploadStatus(`Removed ${doc.name}.`, 'ok');
  } catch (error) {
    setUploadStatus(error.message || 'Could not remove the document.', 'error');
  }
  await loadLibrary();
}

// ---------- voice ----------

function setVoiceState(voiceState, detail = '') {
  const on = ![VOICE_STATES.IDLE, VOICE_STATES.STOPPED].includes(voiceState);
  dom.voiceBar.dataset.state = voiceState;
  dom.voiceBar.classList.toggle('on', on || Boolean(detail && voiceState === VOICE_STATES.STOPPED));
  dom.voiceStatus.textContent = getVoiceStatusText(voiceState, detail);
  dom.voiceToggleButton.classList.toggle('active', on);
  dom.voiceToggleButton.setAttribute('aria-pressed', String(on));
  dom.voiceStopButton.hidden = !on;
}

// Live transcripts arrive in fragments; grow one bubble per speaker per turn.
function appendLiveTranscript(role, text) {
  if (!text) return;
  let turn = state.liveTurn[role];
  if (!turn) {
    turn = appendMessage(role, '');
    state.liveTurn[role] = turn;
  }
  turn.entry.text += text;
  turn.bubble.textContent = turn.entry.text;
  dom.chat.scrollTop = dom.chat.scrollHeight;
}

function createVoice(liveConfig) {
  if (liveConfig?.available) {
    dom.voiceMode.textContent = 'Gemini Live';
    return createLiveVoice({
      liveConfig,
      onState: setVoiceState,
      onTranscript: (role, text) => appendLiveTranscript(role, text),
      onCitations: (citations) => {
        state.liveTurn.citations.push(...citations);
        renderCitations(state.liveTurn.citations.map((c, i) => ({ ...c, id: i + 1 })));
      },
      onTurnComplete: () => {
        void saveLiveTurn(state.liveTurn);
        state.liveTurn = { user: null, assistant: null, citations: [] };
      }
    });
  }

  dom.voiceMode.textContent = 'Browser voice';
  return createBrowserVoice({ ask: submitQuestion, onState: setVoiceState });
}

async function toggleVoice() {
  if (!state.voice) return;
  if (state.voice.isActive()) {
    state.voice.stop();
    return;
  }
  if (!state.sessionId) await newSession();
  state.liveTurn = { user: null, assistant: null, citations: [] };
  await state.voice.start();
}

async function loadLiveConfig() {
  try {
    return await getJson('/api/live-config');
  } catch (error) {
    return null;
  }
}

// ---------- export ----------

function exportConversation() {
  const lines = ['# Policy Assistant conversation', ''];
  state.transcript
    .filter((m) => m.text)
    .forEach((m) => {
      lines.push(`**${m.role === 'user' ? 'You' : 'Assistant'}** (${timeLabel(m.at)})`, '', m.text, '');
    });
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
  const link = el('a');
  link.href = URL.createObjectURL(blob);
  link.download = `policy-conversation-${new Date().toISOString().slice(0, 10)}.md`;
  link.click();
  URL.revokeObjectURL(link.href);
}

// ---------- wiring ----------

function autosize() {
  dom.message.style.height = 'auto';
  dom.message.style.height = `${Math.min(dom.message.scrollHeight, 160)}px`;
}

dom.sendButton.addEventListener('click', () => void submitQuestion(dom.message.value));
dom.message.addEventListener('input', autosize);
dom.message.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void submitQuestion(dom.message.value);
  }
});
dom.newSessionButton.addEventListener('click', () => void newSession());
dom.exportButton.addEventListener('click', exportConversation);
dom.voiceToggleButton.addEventListener('click', () => void toggleVoice());
dom.voiceStopButton.addEventListener('click', () => state.voice?.stop());

dom.dropzone.addEventListener('click', () => dom.pdf.click());
dom.dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    dom.pdf.click();
  }
});
dom.pdf.addEventListener('change', () => void uploadFile(dom.pdf.files[0]));
['dragenter', 'dragover'].forEach((type) =>
  dom.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dom.dropzone.classList.add('drag');
  })
);
['dragleave', 'drop'].forEach((type) =>
  dom.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dom.dropzone.classList.remove('drag');
  })
);
dom.dropzone.addEventListener('drop', (event) => void uploadFile(event.dataTransfer.files[0]));

setVoiceState(VOICE_STATES.IDLE);
renderCitations([]);
void newSession();
void loadLibrary();
void loadHistory();
void loadLiveConfig().then((liveConfig) => {
  state.voice = createVoice(liveConfig);
});
