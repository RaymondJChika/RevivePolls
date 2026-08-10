// Revive Polls — host control panel

const hostToken = location.pathname.split('/').pop();
let currentState = null;
let pollType = 'mcq';
let optionCount = 2;

function makeOptionRow(index) {
  return el('div', { class: 'row' }, [
    el('input', { type: 'text', class: 'grow opt-input', maxlength: '120', placeholder: `Option ${index + 1}` }),
  ]);
}

// Full rebuild — only used when switching poll type or resetting the form.
// Wipes any typed text, so never call this in response to +/- option clicks.
function optionsEditorMarkup() {
  const wrap = qs('#options-editor');
  wrap.innerHTML = '';
  if (pollType !== 'mcq') return;
  wrap.appendChild(el('label', { class: 'field-label' }, ['Options']));
  const list = el('div', { class: 'stack', id: 'option-inputs' });
  for (let i = 0; i < optionCount; i++) list.appendChild(makeOptionRow(i));
  wrap.appendChild(list);
  const controls = el('div', { class: 'row', style: 'margin-top:8px;' }, [
    el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: addOptionRow }, ['+ Add option']),
    el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: removeOptionRow }, ['− Remove option']),
  ]);
  wrap.appendChild(controls);
}

// +/- only ever add or remove a single row at the end, so existing inputs
// (and whatever the host already typed into them) are left untouched.
function addOptionRow() {
  if (optionCount >= 8) return;
  const list = qs('#option-inputs');
  list.appendChild(makeOptionRow(optionCount));
  optionCount++;
}
function removeOptionRow() {
  if (optionCount <= 2) return;
  const list = qs('#option-inputs');
  if (list.lastElementChild) list.removeChild(list.lastElementChild);
  optionCount--;
}

optionsEditorMarkup();

qsa('.tabs button', qs('.tabs')).forEach((btn) => {
  btn.addEventListener('click', () => {
    qsa('.tabs button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    pollType = btn.dataset.type;
    optionsEditorMarkup();
  });
});

qs('#add-poll-btn').addEventListener('click', async () => {
  const question = qs('#poll-question').value.trim();
  if (!question) { toast('Add a question first', 'error'); return; }
  const btn = qs('#add-poll-btn');
  const payload = { hostToken, poll: { type: pollType, question } };
  if (pollType === 'mcq') {
    payload.poll.options = qsa('.opt-input').map((i) => i.value.trim()).filter(Boolean);
    if (payload.poll.options.length < 2) { toast('Add at least two options', 'error'); return; }
  }
  btn.disabled = true;
  try {
    await api('POST', '/api/host/polls', payload);
    qs('#poll-question').value = '';
    optionCount = 2;
    optionsEditorMarkup();
    toast('Poll added');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

qs('#hide-toggle').addEventListener('change', async (e) => {
  const hide = e.target.checked;
  try {
    await api('POST', '/api/host/hide', { hostToken, hide });
  } catch (err) {
    toast(err.message, 'error');
    e.target.checked = !hide;
  }
});

qs('#qa-open-toggle').addEventListener('change', async (e) => {
  const open = e.target.checked;
  try {
    await api('POST', '/api/host/qa/toggle', { hostToken, open });
  } catch (err) {
    toast(err.message, 'error');
    e.target.checked = !open;
  }
});

qs('#qa-clear-btn').addEventListener('click', async () => {
  if (!currentState || !currentState.qa || !currentState.qa.length) return;
  if (!confirm('Clear all Q&A messages? This cannot be undone.')) return;
  try { await api('POST', '/api/host/qa/clear', { hostToken }); } catch (e) { toast(e.message, 'error'); }
});

qs('#copy-link-btn').addEventListener('click', async () => {
  const url = qs('#join-url-text').textContent;
  try {
    await navigator.clipboard.writeText(url);
    toast('Join link copied');
  } catch (_) {
    toast('Could not copy — copy it manually');
  }
});

qs('#present-btn').addEventListener('click', () => {
  window.open(`/present/${hostToken}`, '_blank');
});

// --- Save / load a poll set as a plain JSON file, so a host can reuse the
// same set of questions next time without an account or a database. Save
// exports the poll *definitions* only (question/type/options) — not votes,
// which don't make sense to carry into a new session.
qs('#save-template-btn').addEventListener('click', () => {
  if (!currentState || !currentState.polls || !currentState.polls.length) {
    toast('No polls to save yet', 'error');
    return;
  }
  const exportPolls = currentState.polls.map((p) => (
    p.type === 'mcq'
      ? { type: 'mcq', question: p.question, options: p.options.map((o) => o.text) }
      : { type: 'rating', question: p.question }
  ));
  const payload = {
    app: 'revive-polls-template',
    version: 1,
    name: currentState.name,
    savedAt: new Date().toISOString(),
    polls: exportPolls,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const safeName = (currentState.name || 'revive-polls').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '') || 'revive-polls';
  const a = el('a', { href: url, download: `${safeName}-template.json` }, []);
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast('Template downloaded');
});

qs('#load-template-btn').addEventListener('click', () => qs('#template-file-input').click());

qs('#template-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = ''; // allow re-selecting the same file later
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (err) {
    toast("That file isn't valid JSON", 'error');
    return;
  }
  const polls = Array.isArray(data.polls) ? data.polls : Array.isArray(data) ? data : null;
  if (!polls || !polls.length) {
    toast('No polls found in that file', 'error');
    return;
  }
  let added = 0;
  let failed = 0;
  for (const p of polls) {
    const poll = { type: p.type === 'rating' ? 'rating' : 'mcq', question: p.question };
    if (poll.type === 'mcq') poll.options = Array.isArray(p.options) ? p.options : [];
    try {
      await api('POST', '/api/host/polls', { hostToken, poll });
      added++;
    } catch (err) {
      failed++;
    }
  }
  toast(failed ? `Loaded ${added} poll(s), ${failed} failed` : `Loaded ${added} poll(s) from template`);
});

let qrRendered = false;
function renderQr(code) {
  if (qrRendered) return;
  qrRendered = true;
  const url = `${location.origin}/join/${code}`;
  qs('#join-url-text').textContent = url;
  if (window.QRCode) {
    new QRCode(qs('#qr-box'), { text: url, width: 200, height: 200, correctLevel: QRCode.CorrectLevel.M });
  } else {
    qs('#qr-box').textContent = url;
  }
}

function renderPollList(state) {
  const wrap = qs('#poll-list');
  wrap.innerHTML = '';
  if (!state.polls || !state.polls.length) {
    wrap.appendChild(el('div', { class: 'empty-state' }, [
      el('div', { class: 'glyph' }, ['📊']),
      el('p', {}, ['No polls yet — create one on the left.']),
    ]));
    return;
  }
  state.polls.slice().reverse().forEach((poll) => {
    const badgeClass = poll.status === 'active' ? 'badge-live' : poll.status === 'ended' ? 'badge-ended' : 'badge-draft';
    const badgeText = poll.status === 'active' ? 'Live' : poll.status === 'ended' ? 'Ended' : 'Draft';
    const item = el('div', { class: 'poll-list-item' }, [
      el('div', { class: 'q' }, [
        poll.question,
        el('span', { class: 'meta' }, [`${poll.type === 'mcq' ? 'Multiple choice' : 'Rating'} · ${poll.totalVotes || 0} response${(poll.totalVotes || 0) === 1 ? '' : 's'}`]),
      ]),
      el('span', { class: `badge ${badgeClass}` }, [poll.status === 'active' ? el('span', { class: 'pulse-dot' }) : null, badgeText]),
    ]);
    const actions = el('div', { class: 'row', style: 'flex:none;' });
    if (poll.status !== 'active') {
      actions.appendChild(el('button', { class: 'btn btn-secondary btn-sm', onclick: () => launchPoll(poll.id) }, ['Launch']));
    } else {
      actions.appendChild(el('button', { class: 'btn btn-secondary btn-sm', onclick: () => endPoll(poll.id) }, ['End']));
    }
    actions.appendChild(el('button', { class: 'btn btn-danger btn-sm', onclick: () => deletePoll(poll.id) }, ['Delete']));
    item.appendChild(actions);
    wrap.appendChild(item);
  });
}

async function launchPoll(id) {
  try { await api('POST', `/api/host/polls/${id}/launch`, { hostToken }); }
  catch (e) { toast(e.message, 'error'); }
}
async function endPoll(id) {
  try { await api('POST', `/api/host/polls/${id}/end`, { hostToken }); }
  catch (e) { toast(e.message, 'error'); }
}
async function deletePoll(id) {
  if (!confirm('Delete this poll?')) return;
  try { await api('POST', `/api/host/polls/${id}/delete`, { hostToken }); }
  catch (e) { toast(e.message, 'error'); }
}

function renderActivePoll(state) {
  const panel = qs('#active-poll-panel');
  panel.innerHTML = '';
  const poll = state.activePoll;
  if (!poll) {
    panel.appendChild(el('div', { class: 'empty-state' }, [
      el('div', { class: 'glyph' }, ['⏸']),
      el('p', {}, ['No poll is live. Launch one from the list below.']),
    ]));
    return;
  }
  panel.appendChild(el('p', { style: 'font-weight:600; margin: 0 0 14px;' }, [poll.question]));
  const chart = el('div');
  panel.appendChild(chart);
  if (poll.type === 'mcq') renderMcqBars(chart, poll);
  else renderRatingBars(chart, poll);
}

async function upvoteFromHost() { /* host doesn't upvote; placeholder kept out */ }

function renderQa(state) {
  const wrap = qs('#qa-list');
  wrap.innerHTML = '';
  const items = state.qa || [];
  if (!items.length) {
    wrap.appendChild(el('p', { class: 'muted', style: 'font-size:13px;' }, ['No messages yet.']));
    return;
  }
  items.forEach((q) => {
    wrap.appendChild(
      el('div', { class: 'qa-item' }, [
        el('div', { class: 'txt' }, [
          q.text,
          el('div', { class: 'muted', style: 'font-size:12px; margin-top:4px;' }, [`▲ ${q.upvotes} · ${timeAgo(q.createdAt)}`]),
        ]),
        el('button', { class: 'btn btn-ghost btn-sm', onclick: () => deleteQa(q.id) }, ['Remove']),
      ])
    );
  });
}
async function deleteQa(id) {
  try { await api('POST', `/api/host/qa/${id}/delete`, { hostToken }); }
  catch (e) { toast(e.message, 'error'); }
}

function render(state) {
  currentState = state;
  qs('#room-name').textContent = state.name;
  qs('#room-code').textContent = state.code;
  qs('#room-code-2').textContent = state.code;
  document.title = `${state.name} — Host — Revive Polls`;
  qs('#participant-count').textContent = `${state.participantCount} participant${state.participantCount === 1 ? '' : 's'} connected`;
  qs('#hide-toggle').checked = !!state.hideAnswers;
  qs('#qa-open-toggle').checked = !!state.qaOpen;
  renderQr(state.code);
  renderActivePoll(state);
  renderPollList(state);
  renderQa(state);
}

connectEvents(`/events/host/${hostToken}`, render, (message) => {
  document.querySelector('.wrap-wide').innerHTML = `
    <div class="card center" style="margin-top:60px;">
      <h2>Room unavailable</h2>
      <p class="lede">${escapeHtml(message)}</p>
      <a class="btn btn-primary" href="/">Start a new room</a>
    </div>`;
});
