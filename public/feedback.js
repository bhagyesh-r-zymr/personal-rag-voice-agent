// Thumbs up/down under each answer, and the admin view of weak spots.

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function postFeedback(body) {
  const res = await fetch('/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Adds rating controls below an answer. Clicking the chosen thumb again clears it.
// A thumbs-down opens an optional "what was wrong?" note.
export function attachFeedback(container, { answerId, sessionId }) {
  const bar = el('div', 'feedback');
  const up = el('button', 'fb-btn', '👍');
  const down = el('button', 'fb-btn', '👎');
  up.type = down.type = 'button';
  up.title = 'Helpful answer';
  down.title = 'Not helpful';
  up.setAttribute('aria-label', 'Helpful answer');
  down.setAttribute('aria-label', 'Not helpful');
  const status = el('span', 'fb-status');
  status.setAttribute('role', 'status');
  bar.append(up, down, status);

  const form = el('form', 'fb-note');
  form.hidden = true;
  const label = el('label', 'sr-only', 'What was wrong with this answer? (optional)');
  const note = el('textarea');
  note.rows = 2;
  note.maxLength = 1000;
  note.placeholder = 'What was wrong or missing? (optional)';
  note.id = `fb-note-${answerId}`;
  label.htmlFor = note.id;
  const send = el('button', 'btn', 'Send');
  send.type = 'submit';
  const skip = el('button', 'btn ghost', 'Skip');
  skip.type = 'button';
  const actions = el('div', 'fb-note-actions');
  actions.append(skip, send);
  form.append(label, note, actions);

  let rating = 'none';

  function show(next) {
    rating = next;
    up.setAttribute('aria-pressed', String(next === 'up'));
    down.setAttribute('aria-pressed', String(next === 'down'));
  }
  show('none');

  async function save(next, comment) {
    const previous = rating;
    show(next);
    status.textContent = '';
    try {
      await postFeedback({ answerId, sessionId: sessionId(), rating: next, comment });
      status.textContent = next === 'none' ? '' : 'Thanks for the feedback.';
      return true;
    } catch (error) {
      show(previous);
      status.textContent = error.message || 'Could not save feedback.';
      return false;
    }
  }

  up.addEventListener('click', async () => {
    form.hidden = true;
    await save(rating === 'up' ? 'none' : 'up');
  });
  down.addEventListener('click', async () => {
    if (rating === 'down') {
      form.hidden = true;
      await save('none');
      return;
    }
    if (await save('down')) {
      form.hidden = false;
      note.focus({ preventScroll: true });
      form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });
  skip.addEventListener('click', () => {
    form.hidden = true;
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!note.value.trim()) {
      form.hidden = true;
      return;
    }
    if (await save('down', note.value)) {
      form.hidden = true;
      status.textContent = 'Thanks, your note was sent.';
    }
  });

  container.append(bar, form);
}

// ---------- weak spots view ----------

function stat(label, value, tone = '') {
  const box = el('div', `fb-stat ${tone}`);
  box.append(el('b', '', String(value)), el('span', '', label));
  return box;
}

function renderSummary(body, data) {
  body.innerHTML = '';
  const { totals, documents, uncovered, lowRated } = data;

  if (!totals.total) {
    body.append(el('p', 'empty-note', 'No answers have been rated yet. Ratings appear here as people use 👍 and 👎.'));
    return;
  }

  const stats = el('div', 'fb-stats');
  stats.append(stat('rated answers', totals.total), stat('helpful', totals.up, 'good'), stat('not helpful', totals.down, 'bad'));
  body.append(stats);

  body.append(el('h3', '', 'By document'));
  const rows = [...documents];
  if (uncovered.up || uncovered.down) rows.push({ source: 'No policy found', up: uncovered.up, down: uncovered.down, gap: true });
  if (!rows.length) {
    body.append(el('p', 'empty-note', 'No rated answers cited a document yet.'));
  } else {
    const table = el('table', 'fb-table');
    const head = el('tr');
    ['Document', '👍', '👎'].forEach((h) => head.append(el('th', '', h)));
    table.append(head);
    rows.forEach((r) => {
      const tr = el('tr', r.gap ? 'gap' : '');
      const name = el('td', '', r.source || r.docId || 'Unknown document');
      if (r.gap) name.title = 'Questions the policies did not answer';
      tr.append(name, el('td', '', String(r.up)), el('td', r.down ? 'bad' : '', String(r.down)));
      table.append(tr);
    });
    body.append(table);
  }

  body.append(el('h3', '', 'Answers marked not helpful'));
  if (!lowRated.length) {
    body.append(el('p', 'empty-note', 'Nothing has been marked not helpful.'));
    return;
  }
  const list = el('ul', 'fb-list');
  lowRated.forEach((item) => {
    const li = el('li');
    li.append(el('div', 'fb-q', item.question));
    li.append(el('div', 'fb-a', item.answer));
    if (item.comment) li.append(el('div', 'fb-comment', `“${item.comment}”`));
    const sources = item.sources.map((s) => s.source || s.docId).join(', ') || 'No policy found';
    const when = new Date(item.ratedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    li.append(el('div', 'fb-meta', `${sources} · ${when}`));
    list.append(li);
  });
  body.append(list);
}

export async function openFeedbackView(dialog) {
  const body = dialog.querySelector('.fb-body');
  body.innerHTML = '';
  body.append(el('p', 'empty-note', 'Loading feedback…'));
  if (!dialog.open) dialog.showModal();

  try {
    const res = await fetch('/api/feedback/summary');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    renderSummary(body, data);
  } catch (error) {
    body.innerHTML = '';
    body.append(el('p', 'empty-note', error.message || 'Could not load feedback.'));
  }
}
