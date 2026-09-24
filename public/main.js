import { VOICE_STATES, getVoiceStatusText } from './voiceHelpers.js';
import { createBrowserVoice } from './browserVoice.js';
import { createLiveVoice } from './liveVoiceClient.js';

const SUGGESTIONS = [
  'How many days of annual leave do I get?',
  'What is the work from home policy?',
  'How do I claim travel expenses?',
  'What is the notice period for resignation?'
];

const ROLE_LABELS = { admin: 'Admin', manager: 'Manager', employee: 'Employee' };

const dom = {
  addUserForm: document.getElementById('addUserForm'),
  adminUpload: document.getElementById('adminUpload'),
  appView: document.getElementById('appView'),
  loginEmail: document.getElementById('loginEmail'),
  loginError: document.getElementById('loginError'),
  loginForm: document.getElementById('loginForm'),
  loginPassword: document.getElementById('loginPassword'),
  loginView: document.getElementById('loginView'),
  logoutButton: document.getElementById('logoutButton'),
  newUserEmail: document.getElementById('newUserEmail'),
  newUserName: document.getElementById('newUserName'),
  newUserPassword: document.getElementById('newUserPassword'),
  newUserRole: document.getElementById('newUserRole'),
  uploadRoles: document.getElementById('uploadRoles'),
  userList: document.getElementById('userList'),
  userName: document.getElementById('userName'),
  userRole: document.getElementById('userRole'),
  usersButton: document.getElementById('usersButton'),
  usersCloseButton: document.getElementById('usersCloseButton'),
  usersDialog: document.getElementById('usersDialog'),
  usersError: document.getElementById('usersError'),
  chat: document.getElementById('chat'),
  citations: document.getElementById('citations'),
  docCount: document.getElementById('docCount'),
  docList: document.getElementById('docList'),
  dropzone: document.getElementById('dropzone'),
  exportButton: document.getElementById('exportButton'),
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
  user: null,
  sessionId: null,
  transcript: [],
  documents: [],
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
  // The session expired or was revoked: go back to the sign-in screen.
  if (res.status === 401 && state.user) showLogin('Your session ended. Please sign in again.');
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function sendJson(url, method, body) {
  return getJson(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function isAdmin() {
  return state.user?.role === 'admin';
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
        : isAdmin()
          ? 'Upload a policy PDF on the left to get started. Answers cite the exact pages they come from.'
          : 'No policies have been shared with you yet. Ask an admin to upload them.'
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

function appendMessage(role, text, { error = false } = {}) {
  dom.chat.querySelector('.welcome')?.remove();

  const row = el('div', `msg ${role}${error ? ' error' : ''}`);
  row.append(el('div', 'avatar', role === 'user' ? 'Y' : '§'));
  const body = el('div');
  const bubble = el('div', 'bubble');
  if (role === 'assistant') renderAnswerText(bubble, text);
  else bubble.textContent = text;
  const meta = el('div', 'msg-meta', timeLabel());
  body.append(bubble, meta);
  row.append(body);
  dom.chat.append(row);
  dom.chat.scrollTop = dom.chat.scrollHeight;

  const entry = { role, text, at: new Date() };
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
    const audience = isAdmin() ? ` · ${describeAudience(doc.allowedRoles)}` : '';
    info.append(name, el('div', 'doc-meta', `${doc.pages} pages · ${doc.chunks} sections · ${when}${audience}`));
    item.append(info);
    if (!isAdmin()) {
      dom.docList.append(item);
      return;
    }
    const remove = el('button', 'doc-remove', '✕');
    remove.type = 'button';
    remove.title = `Remove ${doc.name}`;
    remove.setAttribute('aria-label', `Remove ${doc.name}`);
    remove.addEventListener('click', () => void removeDoc(doc));
    item.append(remove);
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
  const roles = [...dom.uploadRoles.querySelectorAll('input:checked')].map((input) => input.value);
  const fd = new FormData();
  // Admins can always read every policy; this adds who else can.
  fd.append('roles', ['admin', ...roles].join(','));
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

function describeAudience(roles) {
  if (!roles?.length) return 'Admins only (re-upload to share)';
  if (roles.includes('employee')) return 'Everyone';
  if (roles.includes('manager')) return 'Managers and admins';
  return 'Admins only';
}

// ---------- sign-in and users ----------

function showLogin(message = '') {
  state.user = null;
  state.voice?.stop();
  state.voice = null;
  dom.usersDialog.close?.();
  dom.appView.hidden = true;
  dom.loginView.hidden = false;
  dom.loginError.textContent = message;
  dom.loginPassword.value = '';
  dom.loginEmail.focus();
}

function showApp(user) {
  state.user = user;
  dom.loginView.hidden = true;
  dom.appView.hidden = false;
  dom.userName.textContent = user.name || user.email;
  dom.userRole.textContent = ROLE_LABELS[user.role] || user.role;
  dom.adminUpload.hidden = !isAdmin();
  dom.usersButton.hidden = !isAdmin();
  setUploadStatus('');
  setVoiceState(VOICE_STATES.IDLE);
  renderCitations([]);
  void newSession();
  void loadLibrary();
  void loadLiveConfig().then((liveConfig) => {
    if (state.user) state.voice = createVoice(liveConfig);
  });
}

async function login(event) {
  event.preventDefault();
  dom.loginError.textContent = '';
  try {
    const data = await sendJson('/api/auth/login', 'POST', {
      email: dom.loginEmail.value,
      password: dom.loginPassword.value
    });
    dom.loginPassword.value = '';
    showApp(data.user);
  } catch (error) {
    dom.loginError.textContent = error.message || 'Could not sign in.';
  }
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  state.transcript = [];
  showLogin();
}

async function loadUsers() {
  dom.usersError.textContent = '';
  try {
    const { users } = await getJson('/api/users');
    renderUsers(users);
  } catch (error) {
    dom.usersError.textContent = error.message;
  }
}

function renderUsers(users) {
  dom.userList.innerHTML = '';
  users.forEach((user) => {
    const row = el('li', 'user-row');
    const who = el('div', 'who', user.name || user.email);
    who.append(el('small', '', user.email));
    const role = el('select');
    role.setAttribute('aria-label', `Role for ${user.email}`);
    Object.entries(ROLE_LABELS).forEach(([value, label]) => {
      const option = el('option', '', label);
      option.value = value;
      option.selected = value === user.role;
      role.append(option);
    });
    role.addEventListener('change', () => void changeRole(user, role));
    const remove = el('button', 'doc-remove', '✕');
    remove.type = 'button';
    remove.title = `Remove ${user.email}`;
    remove.setAttribute('aria-label', `Remove ${user.email}`);
    remove.disabled = user.id === state.user?.id;
    remove.addEventListener('click', () => void removeUser(user));
    row.append(who, role, remove);
    dom.userList.append(row);
  });
}

async function changeRole(user, select) {
  try {
    await sendJson(`/api/users/${user.id}`, 'PATCH', { role: select.value });
  } catch (error) {
    dom.usersError.textContent = error.message;
  }
  await loadUsers();
}

async function removeUser(user) {
  if (!window.confirm(`Remove ${user.email}? They will no longer be able to sign in.`)) return;
  try {
    await getJson(`/api/users/${user.id}`, { method: 'DELETE' });
  } catch (error) {
    dom.usersError.textContent = error.message;
  }
  await loadUsers();
}

async function addUser(event) {
  event.preventDefault();
  dom.usersError.textContent = '';
  try {
    await sendJson('/api/users', 'POST', {
      email: dom.newUserEmail.value,
      name: dom.newUserName.value,
      password: dom.newUserPassword.value,
      role: dom.newUserRole.value
    });
    dom.addUserForm.reset();
    await loadUsers();
  } catch (error) {
    dom.usersError.textContent = error.message;
  }
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

dom.loginForm.addEventListener('submit', (event) => void login(event));
dom.logoutButton.addEventListener('click', () => void logout());
dom.usersButton.addEventListener('click', () => {
  dom.usersDialog.showModal();
  void loadUsers();
});
dom.usersCloseButton.addEventListener('click', () => dom.usersDialog.close());
dom.addUserForm.addEventListener('submit', (event) => void addUser(event));

setVoiceState(VOICE_STATES.IDLE);
fetch('/api/auth/me')
  .then((res) => (res.ok ? res.json() : null))
  .then((data) => (data?.user ? showApp(data.user) : showLogin()))
  .catch(() => showLogin());
