// Revive Polls — shared client helpers (no external libraries).

// Fix for a classic back/forward-cache bug: navigating away mid-request
// (e.g. clicking "Create room", which disables the button and waits on a
// fetch before redirecting) freezes that in-progress DOM state. Hitting the
// browser Back button then *restores* that frozen snapshot instead of doing
// a fresh page load — so the button stays stuck on "Creating…" forever,
// and on the live pages (host/join/display/present) a restored page also
// carries a stale/dead EventSource. Forcing a real reload whenever the page
// is served from bfcache fixes both at once.
window.addEventListener('pageshow', (event) => {
  if (event.persisted) location.reload();
});

const SERIES_COLORS = [
  'var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)',
  'var(--series-5)', 'var(--series-6)', 'var(--series-7)', 'var(--series-8)',
];

function seriesColor(i) {
  return SERIES_COLORS[i % SERIES_COLORS.length];
}

function qs(sel, root) { return (root || document).querySelector(sel); }
function qsa(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null) node.setAttribute(k, v);
    }
  }
  (children || []).forEach((c) => {
    if (c === null || c === undefined) return;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return node;
}
function escapeHtml(s) {
  return (s || '').toString().replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** Anonymous, per-browser participant id. Never tied to any personal info —
 *  it only exists so the server can stop the same device answering a poll
 *  twice. Regenerating it (e.g. clearing site data) just looks like a new
 *  anonymous participant. */
function getParticipantId() {
  let id = localStorage.getItem('pulse_participant_id');
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
    localStorage.setItem('pulse_participant_id', id);
  }
  return id;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json;
  try { json = await res.json(); } catch (_) { json = { ok: false, error: 'Unexpected server response.' }; }
  if (!res.ok || !json.ok) {
    const err = new Error(json.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return json;
}

let toastHost;
function toast(message, tone) {
  if (!toastHost) {
    toastHost = el('div', { class: 'toast-host' });
    document.body.appendChild(toastHost);
  }
  const t = el('div', { class: 'toast' }, [message]);
  if (tone === 'error') t.style.background = 'var(--critical)';
  toastHost.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

/** Wraps EventSource with auto state tracking + reconnection (EventSource
 *  reconnects on its own; this just gives callers a single onState hook). */
function connectEvents(url, onState, onFatal) {
  const es = new EventSource(url);
  es.addEventListener('state', (e) => {
    try { onState(JSON.parse(e.data)); } catch (_) { /* ignore malformed frame */ }
  });
  es.addEventListener('fatal', (e) => {
    es.close();
    try { onFatal && onFatal(JSON.parse(e.data).error); } catch (_) { onFatal && onFatal('This room is no longer available.'); }
  });
  es.addEventListener('error', () => {
    // EventSource retries automatically; surface nothing noisy to the user.
  });
  return es;
}

function fmtPct(n) {
  return `${Math.round(n)}%`;
}

/** Renders MCQ results as labeled horizontal bars into `container`.
 *  Each option gets a fixed categorical color by its position, per the
 *  palette's "assign hue by identity, never rank" rule — bars don't
 *  reorder or recolor as vote counts change. */
function renderMcqBars(container, poll, rowClass) {
  container.innerHTML = '';
  rowClass = rowClass || 'bar-row';
  const total = poll.totalVotes || 0;
  poll.options.forEach((opt, i) => {
    const result = (poll.results || []).find((r) => r.id === opt.id);
    const count = result ? result.count : 0;
    const pct = total ? (count / total) * 100 : 0;
    const visualPct = count > 0 ? Math.max(pct, 1.5) : 0;
    const row = el('div', { class: rowClass }, [
      el('div', { class: 'bar-label' }, [
        el('span', { class: 'opt-text' }, [`${i + 1}. ${opt.text}`]),
        el('span', { class: 'opt-stat' }, [`${count} · ${fmtPct(pct)}`]),
      ]),
      el('div', { class: 'bar-track' }, [
        el('div', { class: 'bar-fill', style: `width:${visualPct}%; background:${seriesColor(i)};` }),
      ]),
    ]);
    container.appendChild(row);
  });
  container.appendChild(el('p', { class: 'muted', style: 'margin:10px 0 0; font-size:13px;' }, [`${total} response${total === 1 ? '' : 's'}`]));
}

/** Renders a 1–5 rating distribution as bars (single hue — this is a
 *  magnitude-by-ordered-value encoding, not distinct categories). */
function renderRatingBars(container, poll, rowClass) {
  container.innerHTML = '';
  rowClass = rowClass || 'bar-row';
  const counts = poll.results || {};
  const total = poll.totalVotes || 0;
  const max = Math.max(1, ...Object.values(counts).map(Number));
  const scale = poll.scale || 5;
  const avgRow = el('div', { class: 'kv' }, [
    el('span', { class: 'k' }, ['Average']),
    el('span', { class: 'v' }, [total ? poll.average.toFixed(2) : '—']),
  ]);
  container.appendChild(avgRow);
  for (let v = 1; v <= scale; v++) {
    const count = Number(counts[v] || 0);
    const pct = max ? (count / max) * 100 : 0;
    const visualPct = count > 0 ? Math.max(pct, 1.5) : 0;
    const row = el('div', { class: rowClass }, [
      el('div', { class: 'bar-label' }, [
        el('span', { class: 'opt-text' }, [`${v} ${'★'.repeat(v)}`]),
        el('span', { class: 'opt-stat' }, [`${count}`]),
      ]),
      el('div', { class: 'bar-track' }, [
        el('div', { class: 'bar-fill', style: `width:${visualPct}%; background: var(--series-1);` }),
      ]),
    ]);
    container.appendChild(row);
  }
  container.appendChild(el('p', { class: 'muted', style: 'margin:10px 0 0; font-size:13px;' }, [`${total} response${total === 1 ? '' : 's'}`]));
}

function timeAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}
