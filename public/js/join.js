// Revive Polls — participant view (fully anonymous)

const roomCode = location.pathname.split('/').pop().toUpperCase();
const participantId = getParticipantId();
let currentState = null;

// What I picked for a given poll, remembered locally so I can highlight my
// selection and change it later. Never sent anywhere except back to the
// server as an ordinary vote/rate call — this is just this browser's memory
// of its own answer, not tied to any identity.
function choiceKey(pollId) { return `pulse_choice_${pollId}`; }
function getChoice(pollId) { return localStorage.getItem(choiceKey(pollId)); }
function setChoice(pollId, value) { localStorage.setItem(choiceKey(pollId), String(value)); }
function clearChoice(pollId) { localStorage.removeItem(choiceKey(pollId)); }

const app = qs('#app');

function renderShell(state) {
  app.innerHTML = '';

  if (state.ended) {
    renderSurveyEnded(state);
    return;
  }

  app.appendChild(el('div', { class: 'center', style: 'margin: 18px 0 22px;' }, [
    el('h1', { style: 'font-size:22px; margin-bottom:2px;' }, [state.name]),
    el('p', { class: 'muted', style: 'font-size:13px;' }, [`${state.participantCount} people here · room ${state.code}`]),
  ]));

  const pollCard = el('div', { class: 'card' });
  pollCard.appendChild(renderPollSection(state));
  app.appendChild(pollCard);

  const qaCard = el('div', { class: 'card' });
  qaCard.appendChild(renderQaSection(state));
  app.appendChild(qaCard);
}

function renderSurveyEnded(state) {
  if (state.statsReleased) {
    app.appendChild(el('div', { class: 'center', style: 'margin: 18px 0 22px;' }, [
      el('p', { class: 'eyebrow' }, ['Survey complete']),
      el('h1', { style: 'font-size:22px; margin-bottom:2px;' }, [state.name]),
      el('p', { class: 'muted', style: 'font-size:13px;' }, ['Thanks for taking part — here’s how everyone answered.']),
    ]));

    const summaryCard = el('div', { class: 'card' });
    const list = el('div');
    summaryCard.appendChild(list);
    renderSurveySummary(list, state.polls || []);
    app.appendChild(summaryCard);
  } else {
    app.appendChild(el('div', { class: 'center', style: 'margin: 18px 0 22px;' }, [
      el('p', { class: 'eyebrow' }, ['Survey complete']),
      el('h1', { style: 'font-size:22px; margin-bottom:2px;' }, [state.name]),
    ]));
    app.appendChild(el('div', { class: 'card center' }, [
      el('div', { class: 'glyph', style: 'font-size:36px; margin-bottom:10px;' }, ['🙏']),
      el('p', { class: 'lede', style: 'margin:0;' }, ['Thanks for taking part! The host will share the results summary here shortly.']),
    ]));
  }

  app.appendChild(el('div', { class: 'center', style: 'margin-top:20px;' }, [
    el('a', { class: 'btn btn-secondary', href: '/' }, ['Exit survey']),
  ]));
}

function renderPollSection(state) {
  const frag = el('div');
  const poll = state.activePoll;
  if (!poll) {
    frag.appendChild(el('div', { class: 'empty-state', style: 'padding:24px 4px;' }, [
      el('div', { class: 'glyph' }, ['⏳']),
      el('p', {}, ['Waiting for the host to launch a poll…']),
    ]));
    return frag;
  }

  frag.appendChild(el('h2', { style: 'font-size:19px;' }, [poll.question]));

  const closed = poll.status !== 'active';
  const myChoice = getChoice(poll.id);

  if (closed) {
    if (state.hideAnswers) {
      frag.appendChild(el('div', { class: 'hidden-banner' }, [
        myChoice ? '✅ Thanks — your answer was submitted anonymously.' : '⏹ This poll has closed.',
      ]));
    } else {
      const chart = el('div', { style: 'margin-top:6px;' });
      if (poll.type === 'mcq') renderMcqBars(chart, poll);
      else renderRatingBars(chart, poll);
      frag.appendChild(chart);
      if (myChoice) frag.appendChild(el('p', { class: 'muted', style: 'font-size:13px; margin-top:12px;' }, ['✅ You answered this poll.']));
    }
    return frag;
  }

  // Poll is live — always show the interactive picker, highlight whatever
  // I've currently got selected, and let clicking any option change it.
  if (poll.type === 'mcq') {
    const list = el('div', { class: 'stack' });
    poll.options.forEach((opt) => {
      const selected = myChoice === opt.id;
      list.appendChild(el('button', {
        class: `option-btn${selected ? ' selected' : ''}`,
        type: 'button',
        onclick: (e) => submitVote(poll.id, opt.id, e.currentTarget),
      }, [selected ? `✓ ${opt.text}` : opt.text]));
    });
    frag.appendChild(list);
  } else {
    const scale = poll.scale || 5;
    const row = el('div', { class: 'rating-scale' });
    for (let v = 1; v <= scale; v++) {
      const selected = myChoice === String(v);
      row.appendChild(el('button', {
        type: 'button',
        class: selected ? 'selected' : '',
        onclick: (e) => submitRating(poll.id, v, e.currentTarget),
      }, [String(v)]));
    }
    frag.appendChild(row);
    frag.appendChild(el('div', { class: 'row between', style: 'margin-top:8px;' }, [
      el('span', { class: 'muted', style: 'font-size:12px;' }, ['Poor']),
      el('span', { class: 'muted', style: 'font-size:12px;' }, ['Excellent']),
    ]));
  }
  frag.appendChild(el('p', { class: 'muted', style: 'font-size:12px; margin-top:14px;' }, [
    myChoice ? 'Tap a different option to change your answer.' : 'Your response is anonymous — you can change it any time while the poll is live.',
  ]));

  // The host can reveal live results mid-poll (flipping the "hide answers"
  // toggle off) — when they do, show the same running tally here too,
  // underneath the picker so people can still change their answer.
  if (!state.hideAnswers) {
    const liveResults = el('div', { style: 'margin-top:20px; padding-top:16px; border-top:1px solid var(--border);' });
    liveResults.appendChild(el('p', { class: 'eyebrow', style: 'margin-bottom:10px;' }, ['Live results']));
    if (poll.type === 'mcq') renderMcqBars(liveResults, poll);
    else renderRatingBars(liveResults, poll);
    frag.appendChild(liveResults);
  }
  return frag;
}

async function submitVote(pollId, optionId, btnEl) {
  const previous = getChoice(pollId);
  if (previous === optionId) return; // already my selection, nothing to do
  // Set the choice *before* the request so any state re-render that arrives
  // while this is in flight (e.g. someone else voting at the same instant)
  // still shows my selection instead of flashing back to the empty picker.
  setChoice(pollId, optionId);
  if (currentState) renderShell(currentState);
  try {
    await api('POST', `/api/rooms/${roomCode}/vote`, { participantId, pollId, optionId });
    toast('Answer submitted');
  } catch (e) {
    toast(e.message, 'error');
    if (previous) setChoice(pollId, previous); else clearChoice(pollId);
    if (currentState) renderShell(currentState);
  }
}

async function submitRating(pollId, value, btnEl) {
  const previous = getChoice(pollId);
  if (previous === String(value)) return;
  setChoice(pollId, value);
  if (currentState) renderShell(currentState);
  try {
    await api('POST', `/api/rooms/${roomCode}/rate`, { participantId, pollId, value });
    toast('Rating submitted');
  } catch (e) {
    toast(e.message, 'error');
    if (previous) setChoice(pollId, previous); else clearChoice(pollId);
    if (currentState) renderShell(currentState);
  }
}

function renderQaSection(state) {
  const frag = el('div');
  frag.appendChild(el('h3', {}, ['Live Q&A']));

  if (!state.qaOpen) {
    frag.appendChild(el('p', { class: 'muted', style: 'font-size:13px;' }, ['Q&A is closed right now.']));
    return frag;
  }

  const form = el('div', { class: 'row', style: 'margin-bottom: 14px;' }, [
    el('input', { type: 'text', id: 'qa-input', class: 'grow', maxlength: '280', placeholder: 'Ask a question or leave feedback…' }),
    el('button', { class: 'btn btn-primary btn-sm', onclick: submitQa }, ['Send']),
  ]);
  frag.appendChild(form);
  const qaInput = form.querySelector('#qa-input');
  if (qaInput) qaInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitQa(); });

  const qa = state.qa;
  if (qa && qa.hidden) {
    frag.appendChild(el('p', { class: 'muted', style: 'font-size:13px;' }, [`${qa.count} message${qa.count === 1 ? '' : 's'} submitted so far — hidden for now.`]));
    return frag;
  }
  if (!qa || !qa.length) {
    frag.appendChild(el('p', { class: 'muted', style: 'font-size:13px;' }, ['No messages yet — be the first!']));
    return frag;
  }
  const list = el('div');
  qa.forEach((q) => {
    list.appendChild(el('div', { class: 'qa-item' }, [
      el('div', { class: 'txt' }, [q.text, el('div', { class: 'muted', style: 'font-size:12px; margin-top:4px;' }, [timeAgo(q.createdAt)])]),
      el('button', { class: 'upvote-btn', onclick: (e) => toggleUpvote(q.id, e.currentTarget) }, [
        el('span', { class: 'arrow' }, ['▲']),
        el('span', { class: 'n' }, [String(q.upvotes)]),
      ]),
    ]));
  });
  frag.appendChild(list);
  return frag;
}

async function submitQa() {
  const input = qs('#qa-input');
  const text = input.value.trim();
  if (!text) return;
  input.disabled = true;
  try {
    await api('POST', `/api/rooms/${roomCode}/qa`, { participantId, text });
    toast('Sent');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    input.disabled = false;
    input.value = '';
  }
}

async function toggleUpvote(qaId, btnEl) {
  btnEl.classList.toggle('voted');
  try {
    await api('POST', `/api/rooms/${roomCode}/qa/${qaId}/upvote`, { participantId });
  } catch (e) {
    toast(e.message, 'error');
  }
}

function showError(message) {
  app.innerHTML = '';
  app.appendChild(el('div', { class: 'card center', style: 'margin-top: 40px;' }, [
    el('h2', {}, ['Can’t join this room']),
    el('p', { class: 'lede' }, [message]),
    el('a', { class: 'btn btn-primary', href: '/' }, ['Back home']),
  ]));
}

async function start() {
  try {
    await api('POST', `/api/rooms/${roomCode}/join`, { participantId });
  } catch (e) {
    showError(e.message);
    return;
  }
  connectEvents(`/events/room/${roomCode}`, (state) => {
    currentState = state;
    renderShell(state);
  }, (message) => showError(message));
}

start();
