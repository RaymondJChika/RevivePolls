// Revive Polls — presenter mode (step through polls with Next/Prev, meant to
// be projected directly). Uses the host stream for control + poll ordering,
// but renders results the same way the audience would see them (respecting
// the hide-answers toggle) since this screen IS what's projected.

const hostToken = location.pathname.split('/').pop();
let currentState = null;

function activeIndex(state) {
  if (!state.polls || !state.activePoll) return -1;
  return state.polls.findIndex((p) => p.id === state.activePoll.id);
}

function renderPanel(state) {
  const panel = qs('#p-panel');
  panel.innerHTML = '';
  const polls = state.polls || [];

  if (!polls.length) {
    panel.appendChild(el('div', { class: 'p-empty' }, [
      el('h1', {}, ['No polls yet']),
      el('p', { class: 'muted' }, ['Add a poll from the host dashboard, then come back here and hit Next.']),
    ]));
    return;
  }

  if (!state.activePoll) {
    panel.appendChild(el('div', { class: 'p-empty' }, [
      el('h1', {}, ['Ready to present']),
      el('p', { class: 'muted' }, [`${polls.length} poll${polls.length === 1 ? '' : 's'} queued — click Next to launch the first one.`]),
    ]));
    return;
  }

  const poll = state.activePoll;
  panel.appendChild(el('p', { class: 'p-question' }, [poll.question]));

  // Response tally is always visible (host state carries totalVotes even
  // while hideAnswers is on) so the presenter can see engagement build
  // without spoiling the actual distribution.
  const total = poll.totalVotes || 0;
  panel.appendChild(el('div', { class: 'p-tally' }, [
    '👥 ', el('span', { class: 'n' }, [String(total)]), ` response${total === 1 ? '' : 's'} submitted`,
  ]));

  if (state.hideAnswers) {
    const list = el('div');
    panel.appendChild(list);
    if (poll.type === 'mcq') {
      poll.options.forEach((opt, i) => {
        list.appendChild(el('div', { class: 'p-option-plain' }, [`${i + 1}. ${opt.text}`]));
      });
    } else {
      list.appendChild(el('p', { class: 'p-scale-hint' }, [`Rating from 1 (Poor) to ${poll.scale || 5} (Excellent).`]));
    }
  } else {
    const chart = el('div');
    panel.appendChild(chart);
    if (poll.type === 'mcq') renderMcqBars(chart, poll, 'big-bar-row');
    else renderRatingBars(chart, poll, 'big-bar-row');
  }
}

function render(state) {
  currentState = state;
  qs('#p-room-name').textContent = state.name;
  qs('#p-code').textContent = state.code;
  document.title = `${state.name} — Present — Revive Polls`;
  qs('#p-hide-toggle').checked = !!state.hideAnswers;

  const polls = state.polls || [];
  const idx = activeIndex(state);
  qs('#p-counter').textContent = polls.length ? `${idx >= 0 ? idx + 1 : 0} / ${polls.length}` : '— / —';
  qs('#p-prev-btn').disabled = idx <= 0;
  qs('#p-next-btn').disabled = polls.length === 0 || idx >= polls.length - 1;
  qs('#p-next-btn').textContent = idx === -1 && polls.length > 0 ? 'Start ▶' : 'Next ▶';

  renderPanel(state);
}

async function launchByIndex(idx) {
  if (!currentState || !currentState.polls || !currentState.polls[idx]) return;
  const targetId = currentState.polls[idx].id;
  try {
    await api('POST', `/api/host/polls/${targetId}/launch`, { hostToken });
  } catch (e) {
    toast(e.message, 'error');
  }
}

function goNext() {
  if (!currentState) return;
  const polls = currentState.polls || [];
  if (!polls.length) return;
  const idx = activeIndex(currentState);
  const target = idx + 1;
  if (target >= polls.length) return;
  launchByIndex(target);
}

function goPrev() {
  if (!currentState) return;
  const idx = activeIndex(currentState);
  if (idx <= 0) return;
  launchByIndex(idx - 1);
}

qs('#p-next-btn').addEventListener('click', goNext);
qs('#p-prev-btn').addEventListener('click', goPrev);
qs('#p-hide-toggle').addEventListener('change', async (e) => {
  const hide = e.target.checked;
  try {
    await api('POST', '/api/host/hide', { hostToken, hide });
  } catch (err) {
    toast(err.message, 'error');
    e.target.checked = !hide;
  }
});

document.addEventListener('keydown', (e) => {
  if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); goNext(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev(); }
});

connectEvents(`/events/host/${hostToken}`, render, (message) => {
  qs('#p-panel').innerHTML = '';
  qs('#p-panel').appendChild(el('div', { class: 'p-empty' }, [
    el('h1', {}, ['Room unavailable']),
    el('p', { class: 'muted' }, [message]),
  ]));
  qs('#p-prev-btn').disabled = true;
  qs('#p-next-btn').disabled = true;
});
