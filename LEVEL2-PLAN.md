# DARKNOTE LEVEL 2 — inspection, integration plan, and the changes that need your approval

Nothing in this document has been applied to your project yet. Stage 1 (new files
only) is the only part already built — see the bottom. Every change to an EXISTING
file is listed in §4 and waits for your explicit go-ahead.

---

## 1. What the project actually looks like (inspected, not assumed)

| Thing | Finding |
|---|---|
| Runtime | Node.js, CommonJS (`"type": "commonjs"`), no transpiler, no build step |
| Entry point | `index.js` (76 KB) — creates the socket, then `let handleMessage = require('./BIGBRO.js')` at line 26 |
| Command engine | `BIGBRO.js` — **279 KB**, one giant `switch` over the command name |
| Message listeners | `messages.upsert` is registered in **exactly two places**: `index.js:484` (main) and `index.js:1578` (pair flow). Each calls `handleMessage(conn, processedMsg)` |
| Command registry | `lib/command-system.js` (`getRegisteredCommands`) rendered by `lib/menu.js` CATEGORIES |
| Authorization | `lib/owner-system.js` → `isOwner(m, config)`: the paired number, the primary creator, or anyone in `database/owner.json` |
| Per-session settings | `config.json → sessionSettings[<number>]` (this is how antidelete's modes are stored) |
| **HTTP server** | **none anywhere** — no `createServer`, no `express`, no `.listen()` |
| Web dependencies | none in `package.json` (no express/ws/socket.io) |
| Existing "phone" HTML | `lib/phone-frame.js` + the pair/runtime cards (skins `ios` and `oneui`) |
| Protected modules | `protected-antilink.js`, `protected-group.js`, `block-status.protected.js` etc. are obfuscated. `npm run protect` regenerates `ytdl.protected.js` / `shazam.protected.js` from their `.source.js` |
| Git-ignored | `.env`, `auth/`, `tmp/`, `**/database/` — so `database/` is a safe home for L2 state and secrets |

### 1.1 The one constraint that shapes everything

The HTML cards the bot sends today (pair card, runtime card) run in WhatsApp's
**offline card sandbox**: no `fetch`/XHR, no remote images, no `<a href>`. That is
documented in the cards' own headers, and it is why the existing cards embed
everything as base64.

So requirement 7 ("the interface updates when the bot returns a result") **cannot**
be met by a WhatsApp card. Level 2 needs a real web page served over HTTP. That in
turn means the page must be *reachable* from your browser — see §6, which is the
one question I cannot answer for you.

---

## 2. The integration design I recommend

```
WhatsApp message
      |
      v
index.js  messages.upsert  (the EXISTING single listener — no new listener added)
      |
      v
handleMessage = level2/router.wrap(BIGBRO)          <-- 1 line changed in index.js
      |
      +-- "performance" command / L2-active + interface-handled?  ->  Level 2
      |
      +-- everything else (unchanged)  ------------------------->  original BIGBRO
```

* **One wrapper, not a second bot.** The router is a function that receives the
  already-built `m` and either answers or calls the original handler. BIGBRO keeps
  the socket, the pairing, the AI, the anti-feature suite, and every current command.
* **Mode is data, not a restart.** The active mode per WhatsApp session lives in
  `database/level2.json`. Switching flips a value and persists it; the socket is not
  touched, so nothing reconnects and no session is reset.
* **The web server runs in-process**, started by `index.js`, so it can call the same
  functions BIGBRO does and report the REAL result. A separate process would have no
  access to the live socket, and polling it from a file would mean a background loop
  (which you have explicitly ruled out).
* **Zero new dependencies.** Node's built-in `http` and `crypto` cover the server,
  the passcode hashing (scrypt) and the session tokens (HMAC). `package.json` does
  not need to change at all.
* **Secrets stay server-side.** The passcode is stored as a scrypt hash with a random
  salt in `database/level2.json` (git-ignored, mode 0600) and is only ever checked on
  the server. The browser receives a short-lived signed token, never the secret.

---

## 3. What is already built in Stage 1 (NEW FILES ONLY — no existing file touched)

```
level2/
  server.js            built-in http server: static files + /api/unlock, /api/state,
                       /api/mode, /api/health. scrypt passcode, HMAC tokens.
  public/index.html    phone shell: lock screen, home screen, app host
  public/styles.css    Samsung One UI inspired shell (punch-hole, status bar, app grid)
  public/app.js        clock, battery, navigation history + Back, app registry
  public/apps/settings.js   Settings foundation (sections, no invented features)
  public/apps/swap.js       Swap app + the Switch User button (calls the real API)
  public/apps/games.js      Games console shell (Tic-Tac-Toe arrives in Stage 5)
  public/apps/registry.js   app registry so new apps need no core edits
database/level2.json   state + passcode hash (git-ignored, created on first run)
```

The Games console is deliberately an empty, branded shell: Stage 5 owns the games,
and an icon that opens a fake game would be exactly the "looks right but does nothing"
outcome you told me to avoid.

---

## 4. EXISTING files I need to change — approval requested

### 4.1 `index.js` — required (procedure: backup, then edit)

| # | Change | Why it cannot be avoided |
|---|---|---|
| 1 | `const level2 = require('./level2/router.js')` (+1 line near the top) | The module has to be loaded before it can wrap anything |
| 2 | `handleMessage = level2.wrap(handleMessage)` immediately after line 26's `require('./BIGBRO.js')` | This is the single place the command engine is bound. Without it, Level 2 has no way to see a message before BIGBRO does — the only alternatives are a second `messages.upsert` listener (duplicate handling, which you forbade) or editing BIGBRO.js (which you forbade) |
| 3 | The same one-line wrap inside the hot-reload helper at ~line 1306 | That helper re-requires BIGBRO and would otherwise silently unwrap the router until the next restart |
| 4 | `level2.startServer(conn)` next to the existing startup (guarded by `try/catch` | The server needs the live socket to perform real actions. Guarded so a failure can never stop the bot from booting |

Total: **4 lines added, 0 removed, 0 existing statements rewritten.** The router
returns `false` for anything it does not own, so current behaviour is untouched.

*Alternative that needs no index.js change at all:* run the server as its own
process (`node level2/server.js`) and accept that it cannot perform live bot actions
until a later stage. Tell me which you prefer — I recommend the in-process one.

### 4.2 `lib/menu.js` — optional, cosmetic only

Add `'performance'` to the `MAIN` category array so `.menu` / `.allmenu` list it.
One word. The command itself works without this (the router intercepts it before
BIGBRO), it just would not be advertised.

### 4.3 `config.json` — NOT changing it

No `level2` block is needed and no secret belongs in a file tracked by git. State and
the passcode hash live in `database/level2.json`. If you later want an on/off switch
in `config.json`, that is a separate, additive request.

### 4.4 `package.json` — NOT changing it

No dependency is required (§2). If a public tunnel is needed (§6) that would add one,
and I will ask first.

### 4.5 `BIGBRO.js` — NOT touching it

Untouched by design. The router wraps it from outside.

**Backup procedure before any approved edit** (you asked for this explicitly):
```
mkdir -p tmp/backups
cp index.js "tmp/backups/index.js.$(date +%Y%m%d-%H%M%S).bak"
git diff > "tmp/backups/pre-level2.$(date +%Y%m%d-%H%M%S).diff"
```
and I will show you the exact `git diff` of `index.js` after the edit.

---

## 5. Stages, and what each one touches

| Stage | Content | Files |
|---|---|---|
| 1 | Phone frame, lock, home, status bar + battery, Settings, Swap, Games icon | new only (done) |
| 2 | Safe integration: router wrapper + server start | **`index.js`** (approval) |
| 3 | Mode management, Switch User, `performance` command | new + the same 4 lines |
| 4 | HTML↔bot: authenticated actions, live results, errors in the UI | new (+ `lib/menu.js` optional) |
| 5 | Games console, loading screen, Tic-Tac-Toe, 3 difficulties, Back | new only |
| 6 | Testing both directions, lock, existing commands, games, responsive | none |

---

## 6. Questions I need answered before Stage 2

1. **Reachability — how will your browser open the Level 2 page?** The bot runs in a
   container with no public address. Options:
   * **(A) LAN / your own machine** — open `http://<bot-host>:PORT`. Works instantly if
     the bot runs where you are, or on a box you can reach on the same network.
   * **(B) Public URL** — the host has a public IP and an open port, so the URL is
     `http://<ip>:PORT` (I can also add HTTPS via a self-signed cert).
   * **(C) A tunnel** (cloudflared/ngrok) — reachable from anywhere, but it needs a
     binary/tool installed, which is a new dependency I will not add without approval.
2. **The "performance" link must be secret-ish.** May I gate it with a one-time signed
   token (valid ~10 minutes, single use) that the command sends, so the link alone is
   useless without it? Recommended.
3. **Passcode:** set it with an owner-only WhatsApp command (e.g. `.l2pass <new>`), or
   keep it in `.env`? The command is more convenient; `.env` survives a wipe better.
4. **Offline card fallback:** when the page is unreachable, should `performance` fall
   back to an offline card (same look, view-only, no live calls)? It gives you
   something in WhatsApp, but it can never perform actions — I would label it as
   view-only.
