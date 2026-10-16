# DARKNOTE L2 — pairing fixes applied on this host

Date: 2026-09-16
Base: `darknote_final` (the archive from the share link), extracted unmodified.
Host: Node v22.23.2, npm 10.9.8, Linux x64.

Two real defects blocked pairing with a phone number. Both are fixed here.
Nothing else in the project was changed.

---

## Fix 1 — `lib/telegram-pairing.js`: the pairing request never left the socket

**Symptom seen on the console:**

```
⏳ Preparing pairing for +254734641791...
[PAIR] cleared stale auth folder at auth
[SOCKET] created; ws readyState = ...
[SOCKET] connection.update: {"connection":"connecting","hasQr":false}
❌ Connection Closed
Select option:
```

**Cause.** The readiness gate resolved on Baileys' `connection.update`
`connecting` event (or a QR event). The installed fork emits `connecting` from
`process.nextTick()` at socket creation
(`node_modules/@whiskeysockets/baileys/lib/Socket/socket.js:574-579`) — *before*
the WebSocket is open. `requestPairingCode()` then sends its `iq` node through
the raw socket, and Baileys throws
`Boom('Connection Closed', { statusCode: 428 })` whenever `ws.isOpen` is false
(`.../Socket/socket.js:55-57`). So the request failed every single time.

The project already contained the correct helper for this —
`waitForPairingTransport()` in `index.js:109` (it prefers the fork's own
`conn.waitForSocketOpen()`, exported at `.../Socket/socket.js:623`) — but **it was
dead code: nothing ever called it.**

**Fix.** Added `waitForTransport()` and called it in `requestPairingCode()`
after the existing readiness gate, so the request is only sent once the
transport is genuinely writable. Still a real event wait, never a sleep.

## Fix 2 — `index.js`: the code died the moment it was printed

**Symptom seen on the console:** the transport closed 0–1 s after the code was
issued (`lastDisconnect: "Connection Terminated"`, statusCode 428), and no
socket was left to receive the approval.

**Cause.** WhatsApp answers `companion_hello` by closing the stream; once the
phone enters the code it pushes the approving
`link_code_companion_reg / companion_finish` node
(`.../Socket/messages-recv.js:553-600`) on a **new** socket. This build
deliberately never reconnects an unregistered socket (`index.js` close branch,
`lib/bot-instance.js:185`), and the only code that could re-open one wiped
`auth/` first (`createPairingSocket` → `wipeAuthFolder`). Result: nothing was
listening, so a code could never be redeemed.

**Fix.** A bounded keep-alive in the pairing socket's `close` branch:

- re-opens the pairing socket with `createPairingSocket(authDir, sessionId, { keepAuth: true })`;
- `keepAuth` **skips the auth wipe**, so the in-flight pairing state
  (`creds.json` with `me` + `pairingCode`) survives;
- it **never re-requests a code** — `creds.me` is already set by
  `requestPairingCode()`, so each re-opened socket performs a *login* for the
  pending device, which is exactly what lets WhatsApp deliver `companion_finish`;
- bounded by `PAIRING_RESUME_MAX_ATTEMPTS` (200) with an 8 s delay cap;
- prints `[PAIR] transport closed while waiting for the phone; re-opening (n/200) in Xs`
  so the window is visible on the console.

---

## Behaviour you should see when it works

```
[PAIR] transport closed while waiting for the phone; re-opening (1/200) in 2s
[PAIR] re-opening the pairing socket without clearing auth
[SOCKET] connection.update: {"connection":"connecting",...}
[SOCKET] connection.update: {"connection":"close",...,"lastDisconnect":"Connection Failure"}
[PAIR] transport closed while waiting for the phone; re-opening (2/200) in 4s
...
✅ Connected to WhatsApp          <-- after the phone accepts the code
```

`Connection Failure` while waiting is expected: the re-opened socket logs in as
an as-yet-unapproved device, so WhatsApp refuses it until the code is accepted.

## How to pair from here

```bash
cd whatsapp-bot
npm install
node index.js
# DARKNOTE PAIR PANEL -> 1 -> <number in international digits>
# Enter the printed code on the phone:
# WhatsApp -> Settings -> Linked devices -> Link a device -> Link with phone number
```

The same code is also reachable from the bot itself once linked: `!pair <number>`
(owner-only, picks a random code from `PAIR_CASE_CODES`).

## Notes / not fixed

- The archive ships **live credentials in source** (`api.js`, `config.js`,
  `whatsapp.js:16-17`). They are still in this zip. Rotate them.
- `config.json -> instagram.endpoint` still points at the dead `aemt.me` host.
- `tests/menu.test.js` still fails 11/22 (menu lists the AI family the test says
  must stay hidden) and `npm run audit` reports 2 stale-regex failures. These are
  pre-existing and untouched here.
- `node_modules/` and `auth/` are deliberately **not** in this zip
  (`auth/` holds session credentials; `node_modules` is reproducible with
  `npm install`).

## 2026-10-16 — Level 2 Arcade update

- Added **Car Rush**, a touch-friendly three-lane traffic-dodging game with a welcome screen, live score, increasing speed, crash state, and replay button.
- Added **Ludo Mini**, **Ninja Rush**, **Snake**, **Memory Match**, and **Reaction Tap** alongside the existing **Tic-Tac-Toe** game. These are playable mini-game versions designed for the phone UI; Ludo Mini is a quick dice race rather than the full traditional Ludo ruleset.
- Refreshed the Games app into an arcade-style card list that reads games from the registry, so registered games appear automatically.
- Added duplicate game-ID protection to prevent two game modules from silently registering under the same route.
- Added the missing `npm test` and `npm run audit` scripts described by the existing stability audit.
- Updated the stability-audit pairing checks to match the current bounded pairing-window and abandoned-pairing logic rather than stale source patterns.
- Static verification: all 130 JavaScript files pass `node --check`; `npm run audit` passes. `npm test` could not execute in this environment because dependencies are not installed (`axios` is missing); install dependencies on the target host and rerun it.
