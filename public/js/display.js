// Revive Polls — big screen display

const roomCode = location.pathname.split('/').pop().toUpperCase();
let qrRendered = false;

function renderIdle(state) {
  const panel = qs('#main-panel');
  panel.innerHTML = '';
  const box = el('div', { class: 'idle-screen' }, [
    el('h1', {}, [state.name]),
    el('p', { class: 'muted', style: 'font-size:18px;' }, ['Scan to join — waiting for the host to start a poll']),
    el('div', { class: 'qr-box', id: 'stage-qr' }),
    el('p', { class: 'code-chip', style: 'font-size:26px; margin-top:10px;' }, [state.code]),
  ]);
  panel.appendChild(box);
  const url = `${location.origin}/join/${state.code}`;
  if (window.QRCode) {
    new QRCode(qs('#stage-qr'), { text: url, width: 260, height: 260, correctLevel: QRCode.CorrectLevel.M });
  } else {
    qs('#stage-qr').appendChild(el('p', { style: 'padding:20px; max-width:220px; word-break:break-all; color:#111;' }, [url]));
  }
}

function renderHidden(state) {
  const panel = qs('#main-panel');
  panel.innerHTML = '';
  panel.appendChild(el('div', { class: 'idle-screen' }, [
    el('p', { class: 'question-text', style: 'font-size:36px;' }, [state.activePoll.question]),
    el('div', { class: 'hidden-banner', style: 'display:inline-flex; font-size:16px; padding:16px 22px;' }, [
      '🙈 Answers are hidden right now — the host will reveal results shortly.',
    ]),
  ]));
}

function renderActive(state) {
  const panel = qs('#main-panel');
  panel.innerHTML = '';
  const poll = state.activePoll;
  panel.appendChild(el('p', { class: 'question-text' }, [poll.question]));
  const chart = el('div');
  panel.appendChild(chart);
  if (poll.type === 'mcq') renderMcqBars(chart, poll, 'big-bar-row');
  else renderRatingBars(chart, poll, 'big-bar-row');
}

function renderQa(state) {
  const stageBody = qs('#stage-body');
  const items = state.qa;
  const hasContent = items && !items.hidden && items.length > 0;
  const hiddenButOpen = items && items.hidden;
  if (!hasContent && !hiddenButOpen) {
    stageBody.classList.add('no-qa');
    qs('#qa-panel').style.display = 'none';
    return;
  }
  stageBody.classList.remove('no-qa');
  qs('#qa-panel').style.display = 'flex';
  const scroll = qs('#qa-scroll');
  scroll.innerHTML = '';
  if (hiddenButOpen) {
    scroll.appendChild(el('p', { class: 'muted' }, [`${items.count} message${items.count === 1 ? '' : 's'} received — hidden for now.`]));
    return;
  }
  items.slice(0, 20).forEach((q) => {
    scroll.appendChild(el('div', { class: 'qa-big-item' }, [
      el('div', { class: 'txt' }, [q.text]),
      el('div', { class: 'up' }, [`▲ ${q.upvotes}`]),
    ]));
  });
}

function render(state) {
  qs('#stage-room-name').textContent = state.name;
  qs('#stage-code').textContent = state.code;
  qs('#stage-participants').textContent = `${state.participantCount} joined`;
  document.title = `${state.name} — Big Screen`;

  if (state.activePoll) {
    if (state.hideAnswers) renderHidden(state);
    else renderActive(state);
  } else {
    renderIdle(state);
  }
  renderQa(state);
}

connectEvents(`/events/room/${roomCode}`, render, (message) => {
  qs('#main-panel').innerHTML = `
    <div class="idle-screen">
      <h1>Room unavailable</h1>
      <p class="muted" style="font-size:18px;">${escapeHtml(message)}</p>
    </div>`;
  qs('#qa-panel').style.display = 'none';
});
