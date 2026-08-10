'use strict';

/**
 * Revive Polls — live polling & audience feedback rooms.
 *
 * Deliberately zero runtime dependencies: plain Node `http` for routing and
 * static files, and Server-Sent Events (EventSource, built into every
 * browser) for pushing live updates to the big screen and participants.
 * Client actions (vote, create a poll, etc.) are plain POST/DELETE fetch()
 * calls to a small JSON API. No build step, no `npm install` required.
 *
 * Run: node server.js   (defaults to PORT=3000)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------------------------------------------------------------------
// In-memory data store
//
// Everything lives in process memory. That's intentional for a live-event
// tool run as a single Node process: rooms are short-lived (a talk, a class,
// a meetup), the data is small, and there's no personal information to
// persist. Restarting the server clears all rooms. See README for notes on
// scaling this to multiple instances if you ever need to.
// ---------------------------------------------------------------------------

/** @type {Map<string, Room>} code -> room */
const rooms = new Map();
/** @type {Map<string, string>} hostToken -> code */
const hostTokens = new Map();

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const ROOM_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours
const SSE_HEARTBEAT_MS = 25 * 1000;

function makeRoomCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => ROOM_CODE_CHARS[crypto.randomInt(ROOM_CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function makeId() {
  return crypto.randomBytes(12).toString('hex');
}

function createRoom(name) {
  const code = makeRoomCode();
  const hostToken = crypto.randomBytes(20).toString('hex');
  const room = {
    code,
    hostToken,
    name: (name || '').toString().slice(0, 80).trim() || 'Live Session',
    createdAt: Date.now(),
    lastActivity: Date.now(),
    hideAnswers: true, // results start hidden until the host reveals them
    polls: [], // { id, type: 'mcq'|'rating', question, options?, votes, ratingCounts, voters:Set, status }
    activePollId: null,
    qa: [], // { id, text, upvotes:Set(participantId), createdAt }
    qaOpen: true,
    participants: new Set(), // anonymous participant ids seen in this room
    publicSubs: new Set(), // SSE res objects: display + participant clients
    hostSubs: new Set(), // SSE res objects: host control panel clients
  };
  rooms.set(code, room);
  hostTokens.set(hostToken, code);
  return room;
}

function getRoomByToken(token) {
  const code = hostTokens.get(token);
  if (!code) return null;
  return rooms.get(code) || null;
}

function pollPublicView(poll, hide) {
  if (!poll) return null;
  const base = { id: poll.id, type: poll.type, question: poll.question, status: poll.status };
  if (poll.type === 'mcq') {
    base.options = poll.options.map((o) => ({ id: o.id, text: o.text }));
    if (!hide) {
      base.results = poll.options.map((o) => ({ id: o.id, count: poll.votes[o.id] || 0 }));
      base.totalVotes = Object.values(poll.votes).reduce((a, b) => a + b, 0);
    }
  } else if (poll.type === 'rating') {
    base.scale = poll.scale || 5;
    if (!hide) {
      base.results = poll.ratingCounts;
      const entries = Object.entries(poll.ratingCounts);
      const totalVotes = entries.reduce((a, [, c]) => a + c, 0);
      const sum = entries.reduce((a, [v, c]) => a + Number(v) * c, 0);
      base.totalVotes = totalVotes;
      base.average = totalVotes ? sum / totalVotes : 0;
    }
  }
  return base;
}

function hostPollView(poll) {
  return pollPublicView(poll, false); // host always sees full results
}

function qaView(room, forHost) {
  if (!forHost && room.hideAnswers) return { hidden: true, count: room.qa.length };
  return room.qa
    .slice()
    .sort((a, b) => b.upvotes.size - a.upvotes.size || a.createdAt - b.createdAt)
    .map((q) => ({ id: q.id, text: q.text, upvotes: q.upvotes.size, createdAt: q.createdAt }));
}

function roomStateFor(room, { forHost }) {
  const activePoll = room.polls.find((p) => p.id === room.activePollId) || null;
  return {
    code: room.code,
    name: room.name,
    hideAnswers: room.hideAnswers,
    qaOpen: room.qaOpen,
    participantCount: room.participants.size,
    activePoll: forHost ? hostPollView(activePoll) : pollPublicView(activePoll, room.hideAnswers),
    polls: forHost ? room.polls.map(hostPollView) : undefined,
    qa: qaView(room, forHost),
  };
}

function sseWrite(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (_) {
    /* client likely disconnected; will be cleaned up on 'close' */
  }
}

function broadcastState(room) {
  const publicState = roomStateFor(room, { forHost: false });
  const hostState = roomStateFor(room, { forHost: true });
  for (const res of room.publicSubs) sseWrite(res, 'state', publicState);
  for (const res of room.hostSubs) sseWrite(res, 'state', hostState);
}

function touch(room) {
  room.lastActivity = Date.now();
}

// Periodic cleanup of stale rooms + dead SSE sockets.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > ROOM_MAX_AGE_MS) {
      for (const res of room.publicSubs) { try { res.end(); } catch (_) {} }
      for (const res of room.hostSubs) { try { res.end(); } catch (_) {} }
      hostTokens.delete(room.hostToken);
      rooms.delete(code);
    }
  }
}, 30 * 60 * 1000).unref();

// SSE heartbeats so idle connections aren't dropped by proxies/load balancers.
setInterval(() => {
  for (const room of rooms.values()) {
    for (const res of room.publicSubs) { try { res.write(': ping\n\n'); } catch (_) {} }
    for (const res of room.hostSubs) { try { res.write(': ping\n\n'); } catch (_) {} }
  }
}, SSE_HEARTBEAT_MS).unref();

// ---------------------------------------------------------------------------
// Tiny HTTP helpers (no framework)
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function ok(res, extra) {
  sendJson(res, 200, Object.assign({ ok: true }, extra));
}

function fail(res, status, error) {
  sendJson(res, status, { ok: false, error });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    const MAX = 64 * 1024; // 64KB is plenty for this app's payloads
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fail(res, 404, 'Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300',
    });
    res.end(data);
  });
}

function startSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
}

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

const routes = [];
function route(method, pattern, handler) {
  // pattern like /api/rooms/:code/vote -> regex with named groups
  const paramNames = [];
  const regexStr = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        paramNames.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  routes.push({ method, regex: new RegExp(`^${regexStr}$`), paramNames, handler });
}

function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.regex.exec(pathname);
    if (!m) continue;
    const params = {};
    r.paramNames.forEach((name, i) => (params[name] = decodeURIComponent(m[i + 1])));
    return { handler: r.handler, params };
  }
  return null;
}

// ---- room + host lifecycle -------------------------------------------------

route('POST', '/api/rooms', async (req, res) => {
  const body = await readJsonBody(req);
  const room = createRoom(body.name);
  ok(res, { code: room.code, hostToken: room.hostToken });
});

route('GET', '/api/rooms/:code', (req, res, params) => {
  const room = rooms.get(params.code.toUpperCase());
  if (!room) return fail(res, 404, 'Room not found. Check the code and try again.');
  ok(res, { name: room.name });
});

route('POST', '/api/rooms/:code/join', async (req, res, params) => {
  const room = rooms.get(params.code.toUpperCase());
  if (!room) return fail(res, 404, 'Room not found. Check the code and try again.');
  const body = await readJsonBody(req);
  if (!body.participantId) return fail(res, 400, 'Missing participant id.');
  room.participants.add(body.participantId);
  touch(room);
  ok(res, { state: roomStateFor(room, { forHost: false }), name: room.name });
  broadcastState(room);
});

route('POST', '/api/rooms/:code/vote', async (req, res, params) => {
  const room = rooms.get(params.code.toUpperCase());
  if (!room) return fail(res, 404, 'Room not found.');
  const body = await readJsonBody(req);
  const poll = room.polls.find((p) => p.id === body.pollId);
  if (!poll || poll.type !== 'mcq') return fail(res, 400, 'Poll not available.');
  if (poll.status !== 'active') return fail(res, 409, 'This poll is not accepting answers.');
  if (!body.participantId) return fail(res, 400, 'Missing participant id.');
  if (!Object.prototype.hasOwnProperty.call(poll.votes, body.optionId)) return fail(res, 400, 'Invalid option.');
  // Participants can change their answer while the poll is live: swap the
  // tally from their previous choice (if any) to the new one.
  const prevChoice = poll.voters.get(body.participantId);
  if (prevChoice === body.optionId) return ok(res); // no change
  if (prevChoice !== undefined && Object.prototype.hasOwnProperty.call(poll.votes, prevChoice)) {
    poll.votes[prevChoice] = Math.max(0, poll.votes[prevChoice] - 1);
  }
  poll.votes[body.optionId] += 1;
  poll.voters.set(body.participantId, body.optionId);
  touch(room);
  ok(res);
  broadcastState(room);
});

route('POST', '/api/rooms/:code/rate', async (req, res, params) => {
  const room = rooms.get(params.code.toUpperCase());
  if (!room) return fail(res, 404, 'Room not found.');
  const body = await readJsonBody(req);
  const poll = room.polls.find((p) => p.id === body.pollId);
  if (!poll || poll.type !== 'rating') return fail(res, 400, 'Poll not available.');
  if (poll.status !== 'active') return fail(res, 409, 'This poll is not accepting answers.');
  if (!body.participantId) return fail(res, 400, 'Missing participant id.');
  const v = Number(body.value);
  if (!Number.isInteger(v) || v < 1 || v > poll.scale) return fail(res, 400, 'Invalid rating.');
  // Same "change your answer" behavior as votes above.
  const prevValue = poll.voters.get(body.participantId);
  if (prevValue === v) return ok(res); // no change
  if (prevValue !== undefined && poll.ratingCounts[prevValue] !== undefined) {
    poll.ratingCounts[prevValue] = Math.max(0, poll.ratingCounts[prevValue] - 1);
  }
  poll.ratingCounts[v] += 1;
  poll.voters.set(body.participantId, v);
  touch(room);
  ok(res);
  broadcastState(room);
});

route('POST', '/api/rooms/:code/qa', async (req, res, params) => {
  const room = rooms.get(params.code.toUpperCase());
  if (!room) return fail(res, 404, 'Room not found.');
  const body = await readJsonBody(req);
  if (!room.qaOpen) return fail(res, 409, 'Q&A is currently closed.');
  if (!body.participantId) return fail(res, 400, 'Missing participant id.');
  const clean = (body.text || '').toString().trim().slice(0, 280);
  if (!clean) return fail(res, 400, 'Write a question or comment first.');
  room.qa.push({ id: makeId(), text: clean, upvotes: new Set([body.participantId]), createdAt: Date.now() });
  touch(room);
  ok(res);
  broadcastState(room);
});

route('POST', '/api/rooms/:code/qa/:qaId/upvote', async (req, res, params) => {
  const room = rooms.get(params.code.toUpperCase());
  const item = room && room.qa.find((q) => q.id === params.qaId);
  if (!room || !item) return fail(res, 404, 'Not found.');
  const body = await readJsonBody(req);
  if (!body.participantId) return fail(res, 400, 'Missing participant id.');
  if (item.upvotes.has(body.participantId)) item.upvotes.delete(body.participantId);
  else item.upvotes.add(body.participantId);
  ok(res);
  broadcastState(room);
});

// ---- host actions (hostToken passed in JSON body) --------------------------

route('POST', '/api/host/polls', async (req, res) => {
  const body = await readJsonBody(req);
  const room = getRoomByToken(body.hostToken);
  if (!room) return fail(res, 404, 'Room not found or expired.');
  const poll = body.poll || {};
  if (!poll.question || !poll.question.toString().trim()) return fail(res, 400, 'Add a question.');
  const type = poll.type === 'rating' ? 'rating' : 'mcq';
  const newPoll = {
    id: makeId(),
    type,
    question: poll.question.toString().slice(0, 300),
    status: 'draft',
    createdAt: Date.now(),
  };
  if (type === 'mcq') {
    const options = Array.isArray(poll.options) ? poll.options : [];
    newPoll.options = options
      .filter((o) => o && o.toString().trim())
      .slice(0, 8)
      .map((text) => ({ id: makeId(), text: text.toString().slice(0, 120) }));
    if (newPoll.options.length < 2) return fail(res, 400, 'Add at least two options.');
    newPoll.votes = Object.fromEntries(newPoll.options.map((o) => [o.id, 0]));
    newPoll.voters = new Map(); // participantId -> chosen optionId (lets them change their answer)
  } else {
    newPoll.scale = 5;
    newPoll.ratingCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    newPoll.voters = new Map(); // participantId -> chosen rating value
  }
  room.polls.push(newPoll);
  touch(room);
  ok(res, { poll: hostPollView(newPoll) });
  for (const r of room.hostSubs) sseWrite(r, 'state', roomStateFor(room, { forHost: true }));
});

function withHostRoom(handler) {
  return async (req, res, params) => {
    const body = await readJsonBody(req);
    const room = getRoomByToken(body.hostToken);
    if (!room) return fail(res, 404, 'Room not found or expired.');
    return handler(req, res, params, room, body);
  };
}

route('POST', '/api/host/polls/:pollId/launch', withHostRoom((req, res, params, room) => {
  const poll = room.polls.find((p) => p.id === params.pollId);
  if (!poll) return fail(res, 404, 'Poll not found.');
  room.polls.forEach((p) => { if (p.status === 'active') p.status = 'ended'; });
  poll.status = 'active';
  room.activePollId = poll.id;
  touch(room);
  ok(res);
  broadcastState(room);
}));

route('POST', '/api/host/polls/:pollId/end', withHostRoom((req, res, params, room) => {
  const poll = room.polls.find((p) => p.id === params.pollId);
  if (!poll) return fail(res, 404, 'Poll not found.');
  poll.status = 'ended';
  if (room.activePollId === params.pollId) room.activePollId = null;
  touch(room);
  ok(res);
  broadcastState(room);
}));

route('POST', '/api/host/polls/:pollId/delete', withHostRoom((req, res, params, room) => {
  room.polls = room.polls.filter((p) => p.id !== params.pollId);
  if (room.activePollId === params.pollId) room.activePollId = null;
  ok(res);
  broadcastState(room);
}));

route('POST', '/api/host/hide', withHostRoom((req, res, params, room, body) => {
  room.hideAnswers = !!body.hide;
  touch(room);
  ok(res, { hideAnswers: room.hideAnswers });
  broadcastState(room);
}));

route('POST', '/api/host/qa/toggle', withHostRoom((req, res, params, room, body) => {
  room.qaOpen = !!body.open;
  ok(res, { qaOpen: room.qaOpen });
  broadcastState(room);
}));

route('POST', '/api/host/qa/clear', withHostRoom((req, res, params, room) => {
  room.qa = [];
  ok(res);
  broadcastState(room);
}));

route('POST', '/api/host/qa/:qaId/delete', withHostRoom((req, res, params, room) => {
  room.qa = room.qa.filter((q) => q.id !== params.qaId);
  ok(res);
  broadcastState(room);
}));

route('GET', '/healthz', (req, res) => ok(res, { rooms: rooms.size }));

// ---- SSE live streams --------------------------------------------------

route('GET', '/events/room/:code', (req, res, params) => {
  const room = rooms.get(params.code.toUpperCase());
  if (!room) {
    startSse(res);
    sseWrite(res, 'fatal', { error: 'Room not found. Check the code and try again.' });
    return res.end();
  }
  startSse(res);
  room.publicSubs.add(res);
  sseWrite(res, 'state', roomStateFor(room, { forHost: false }));
  req.on('close', () => room.publicSubs.delete(res));
});

route('GET', '/events/host/:token', (req, res, params) => {
  const room = getRoomByToken(params.token);
  if (!room) {
    startSse(res);
    sseWrite(res, 'fatal', { error: 'This host link is invalid or has expired.' });
    return res.end();
  }
  startSse(res);
  room.hostSubs.add(res);
  sseWrite(res, 'state', roomStateFor(room, { forHost: true }));
  req.on('close', () => room.hostSubs.delete(res));
});

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  const match = matchRoute(req.method, pathname);
  if (match) {
    Promise.resolve(match.handler(req, res, match.params)).catch((err) => {
      fail(res, 400, err.message || 'Bad request.');
    });
    return;
  }

  if (pathname.startsWith('/api/') || pathname.startsWith('/events/')) {
    return fail(res, 404, 'Not found.');
  }

  if (req.method !== 'GET') return fail(res, 405, 'Method not allowed.');

  if (pathname === '/' || pathname === '') {
    return serveStatic(req, res, path.join(PUBLIC_DIR, 'index.html'));
  }
  const hostMatch = pathname.match(/^\/host\/([^/]+)$/);
  if (hostMatch) return serveStatic(req, res, path.join(PUBLIC_DIR, 'host.html'));
  const presentMatch = pathname.match(/^\/present\/([^/]+)$/);
  if (presentMatch) return serveStatic(req, res, path.join(PUBLIC_DIR, 'present.html'));
  const displayMatch = pathname.match(/^\/display\/([^/]+)$/);
  if (displayMatch) return serveStatic(req, res, path.join(PUBLIC_DIR, 'display.html'));
  const joinMatch = pathname.match(/^\/join\/([^/]+)$/);
  if (joinMatch) return serveStatic(req, res, path.join(PUBLIC_DIR, 'join.html'));

  // Static files (css/js/etc). Guard against path traversal.
  const safePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!safePath.startsWith(PUBLIC_DIR)) return fail(res, 400, 'Bad request.');
  serveStatic(req, res, safePath);
});

server.listen(PORT, () => {
  console.log(`Revive Polls listening on http://localhost:${PORT}`);
});
