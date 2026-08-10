# Revive Polls

Live polls and audience feedback rooms, branded for Revive Youth Ministry.
Put a QR code on the big screen, people scan it and join anonymously on their
phones, and answers show up live — multiple-choice polls, 1–5 rating polls,
and a live Q&A wall, with a "hide answers" toggle for suspense before a
reveal.

**Zero runtime dependencies.** The server is plain Node.js (`http` module) —
no Express, no Socket.io, no `npm install` step. Live updates use
Server-Sent Events (built into every browser). This means you can deploy it
to almost any free Node host in a couple of minutes with nothing to install.

## How it works

- **Host** creates a room at `/` → gets a control panel at `/host/<secret-token>`.
- That page shows a **QR code + room code** pointing to `/join/<CODE>`.
- **Launch Survey** button on the host panel → opens `/present/<secret-token>`
  — the screen you put on the projector. Full-screen question, a live
  "N responses submitted" tally, and Prev/Next buttons (also ← → / Space on
  a keyboard or clicker) to move through your polls one at a time, plus the
  hide/reveal toggle right there. When answers are hidden, it shows the
  options with no counts instead of spoiling the distribution.
  (There's also a plain `/display/<CODE>` page — a passive mirror with a
  Q&A wall — still in the codebase if you ever want it, just not linked
  from the host panel since Launch Survey covers the projector use case.)
- Anyone who scans the QR code lands on `/join/<CODE>` and answers **anonymously**
  — no name, no login, no account. A random ID is generated in their browser's
  local storage purely so the server can stop the same phone voting twice on
  one poll; it's never shown to anyone and carries no personal information.
- The **hide answers** toggle on the host panel hides live results from the
  big screen and from participants (they just see "submitted!") until you
  flip it off to reveal — you always see full results on the host panel.
- A **live Q&A wall** lets participants post questions/feedback and upvote
  each other's; the host can moderate (delete individual messages, clear all,
  or close submissions).
- Participants can **change their answer** any time while a poll is live —
  tapping a different option updates their vote instead of locking them in,
  and the tally moves with them (no double-counting).
- **Save as template / Load template** on the host panel lets you reuse the
  same set of questions next time: "Save as template" downloads your current
  poll set as a small `.json` file (questions/options only, no votes);
  "Load template" on a future room re-adds them all in one click. No account
  needed — you just keep the file wherever you keep files.

Everything is stored in memory in the one Node process — intentional for a
live-event tool. Rooms auto-expire after 12 hours; restarting the server
clears everything. There's no database to set up.

## Run it locally

Requires Node.js 18+.

```bash
node server.js
```

Then open `http://localhost:3000`. If you want to test the QR flow on your
phone while developing, make sure your phone is on the same Wi-Fi and use
your computer's local IP instead of `localhost`, e.g. `http://192.168.1.23:3000`
(find your IP with `ipconfig getifaddr en0` on Mac, or `ipconfig` on Windows).

There is no build step and no `npm install` needed — the app has zero
dependencies.

## Deploying so phones can reach it

You need a public URL for the QR code to work from anywhere (not just your
Wi-Fi). Any of these work well and have a free tier; pick whichever you
already have an account with.

### Render (recommended — simplest free option)
1. Push this folder to a GitHub repo.
2. On [render.com](https://render.com) → New → Web Service → connect the repo.
3. Build command: *(leave blank)* — Start command: `node server.js`.
4. Deploy. Render gives you a public `https://your-app.onrender.com` URL.
   Free-tier services sleep after inactivity and take ~30s to wake up on the
   next request — fine for a talk you schedule in advance, worth knowing if
   you're demoing on the spot.

### Railway
1. [railway.app](https://railway.app) → New Project → Deploy from GitHub repo.
2. It auto-detects Node and runs `node server.js`. Generate a public domain
   under Settings → Networking.

### Fly.io / a VPS you already have
Any host that runs `node server.js` and exposes the `PORT` it listens on
(defaults to 3000, or set the `PORT` env var) works — there's nothing
framework-specific here.

### Running it at an in-person event with no public internet
If everyone (host + audience) is on the same venue Wi-Fi, you don't need a
public deploy at all — run `node server.js` on your laptop and put your
laptop's local IP + port in the QR code (see "Run it locally" above). No
internet dependency, works entirely on the local network.

## Customizing

- **Logo**: `public/img/revive-logo-256.png` (shown in the header) and
  `public/img/favicon.png` (browser tab icon) — both generated from
  `public/img/revive-logo.jpeg`. Swap in a new image at the same paths (or
  update the `<img src>` references in the HTML files) to rebrand.
- **Branding**: colors live as CSS variables at the top of
  `public/css/style.css` (`--accent`, `--series-1..8`, etc.) — the palette
  is colorblind-safe and validated; swap the hex values for your own brand
  if you have one, keeping the same structure.
- **Poll option limit**: 8 options per multiple-choice poll, 5-point rating
  scale — both adjustable in `server.js` (`slice(0, 8)` and `scale: 5`).
- **Room lifetime**: `ROOM_MAX_AGE_MS` in `server.js` (default 12 hours).

## Scaling beyond one process

This is built for a single-event, single-process use case (a talk, a class,
a meetup) — which covers the vast majority of "run a poll for my audience"
needs and keeps the whole thing dependency-free. If you ever need multiple
server instances behind a load balancer (e.g. a very large recurring
conference platform), the parts to change are: move the room/poll state out
of the in-memory `Map`s into Redis or a small database, and replace the
in-process SSE subscriber lists with a pub/sub layer (e.g. Redis pub/sub)
so a broadcast reaches clients connected to any instance.

## Privacy notes

- No accounts, no names, no emails collected from participants — ever.
- The only per-participant identifier is a random ID generated in the
  participant's own browser (`localStorage`), used solely to stop duplicate
  votes on the same poll. It never leaves the room it was created in and
  isn't linked to anything else.
- All data lives in server memory only and disappears when the server
  restarts or a room expires (12h) — nothing is written to disk.
