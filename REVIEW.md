# DARKNOTE L2 (WhatsApp bot) — Code Review

Source: `https://filetourl.org/f/mANE2R8V` → `darknote_final.zip` (1.15 MB)
Extracted to: `/tmp/dn/extracted/darknote_final` (99 JS files, 23,136 lines, 2.3 MB)
Reviewed: 2026-09-16 — read-only. Nothing in the archive was modified.

---

## 1. What it is

A single-connection, multi-session **WhatsApp bot** (Node.js, CommonJS) built on a
Baileys fork, plus a Telegram control panel and a large autonomous AI chatbot.
Branding is `DARKNOTE` / version `L2`, author `Bigbrother`.

| Layer | Files | Purpose |
|---|---|---|
| `index.js` (1,279 lines) | 1 | Boot, primary socket (`auth/`), pairing engine, console Pair Panel, reconnect, secondary-session startup |
| `BIGBRO.js` (3,049 lines) | 1 | The ONE command dispatcher — `module.exports = async (conn, m)` (line 833). 148 unique `case` labels |
| `lib/` | 46 | Commands, media, security, sessions, cards, Telegram controller |
| `ai/` | 26 | Autonomous chatbot stack + 10 inert tool modules |
| `tests/` | 14 | Dependency-free harness + 11 suites (see §6) |
| `scripts/` | 3 | Static audit + source-protection (obfuscation) builds |

Runtime: `node v22.23.2`, `npm 10.9.8`. `package.json` → Baileys is aliased to the
npm fork `levvleys` (exists on the registry, v2.1.0); `.npmrc` sets `legacy-peer-deps=true`.

## 2. Architecture

**One socket, one listener, one dispatcher.** `index.js` owns the socket lifecycle
(`lib/runtime.js` = "RUNTIME ALIVE", the single authority on connection state);
`BIGBRO.js` owns commands. Message flow (`index.js:1160-1244`):

```
messages.upsert → status check → antidelete revoke detect → captureMessage
  → smsg() → autoread → group activity → anti-link → auto view-once
  → sticker-trigger lookup → presence → BIGBRO dispatcher → presence reset
```

Then, only after the command path declines the message, the AI chatbot
(`ai/chatbot.js`) may answer — so it can never intercept a registered command and
there is no second listener.

**Multi-session.** `lib/bot-instance.js` is the per-socket factory (used by both
`index.js` for `main` and by Telegram/secondary sessions); `lib/sessions.js` is the
registry; `lib/session.js` wraps `auth/`. All state (reconnect timers, presence
intervals, connection flags) is keyed by session id, with a backoff ladder
2s→60s (`lib/runtime.js:58`) and four honest states
(CONNECTED/CONNECTING/DISCONNECTED/AUTH_REQUIRED). Global cap: **25 paired devices**.

**Command aliases.** `lib/command-system.js` — aliases live in `config.json →
cmdAliases` keyed by the paired number, the registry is scanned out of `BIGBRO.js`
`case` labels at runtime, cycles are rejected, and aliases resolve before dispatch.

**Security engine.** `lib/security.js` is ONE engine with a `FEATURES` table
(anti-demote/kick/add/promote/sticker/view-once/media/mention-status); both entry
points funnel through one `escalate()` (warn 1 → delete 2 → kick 3). Owner and the
bot itself are always exempt; nothing acts unless the bot is group admin.
Anti-demote/kick/promote punish the *executor* by demotion, not the victim.

**Media / downloads.** `lib/ytdl.js` is a loader shim → `lib/ytdl.protected.js`
(obfuscated build of `lib/ytdl.source.js`). Shazam = ACRCloud identify +
`yt-search` cards (`lib/shazam.js`); `.igstalk` = `lib/instagram.js`; `.lyrics` =
`lib/lyrics.js`; `.weather` = `lib/weather.js`.

**AI stack (`ai/`).** Facade `ai/index.js`; orchestrator `ai/chatbot.js` (pipeline:
gate → rate limit → context → provider router → typing → reply → memory →
background summary). Provider registry `ai/providers.js`, health/cooldown
`ai/health.js`, language detection EN/Kiswahili/Sheng (`ai/language.js`),
human-like delay windows (`ai/timing.js`), per-chat memory (`ai/memory.js`),
`ai/autohuman.js` (3-stage human emulation), plus 10 tool modules in
`ai/modules/` that are inert unless switched on in `config.json → ai.modules`
(currently only `assistant`, `vision`, `sticker` are on).

A **separate legacy** AI path exists: `lib/ai-chat.js` for the prefixed `.ai`
command, with its own store `database/ai-sessions.json` and a hard 300-character
provider limit (context capped at 292 chars).

**Source protection.** `scripts/protect.js` obfuscates
`lib/{block-status,shazam,ytdl.source}.js` → `*.protected.js` with an
export-equality check before writing; `requireProtected()` (`BIGBRO.js:63`) falls
back to readable source. Obfuscation only — not encryption (README is honest about this).

## 3. Pairing (relevant to connecting a number)

- Gate: `requestCode()` (`index.js:160`) waits for Baileys' real
  `connecting`/QR readiness — never the raw WebSocket OPEN. Window
  `PAIRING_WINDOW_MS = 20000`, request timeout 12000.
- Console **Pair Panel** (`index.js:784`, started at `:1264` because
  `config.telegram.enabled === false`): option `1` = one device, `2` = up to three,
  `0` = exit. Prints the code in a box; enter it on the phone at
  WhatsApp → Linked Devices → Link with phone number.
- Panel pairing uses `config.pairingCode = "DARKNOTE"` (upper-cased alnum, 8 chars).
  The WhatsApp `!pair` command instead picks a random code from
  `PAIR_CASE_CODES = [DARKNOTE, DARKNT23, BIGBRO56, DEADNOTE, UNSENBRO]` (`index.js:65`).
- `createPairingSocket()` (`index.js:220`) retires the old unregistered socket and
  **wipes a half-written `auth/` folder** first — a partial `creds.json` from an
  earlier failed attempt is the usual cause of "pairing socket closed before it opened".
- Telegram controller is configured but **disabled** (`config.json → telegram.enabled: false`),
  so the console panel owns pairing and `/pair` is not active. The token is still
  present in `config.js` and `lib/telegram.js` still loads.
- Archive state is clean: no `auth/`, no `.env`, no `database/*.json`, no `node_modules`
  → first run is an unregistered session.

## 4. Verified in this review

| Check | Result |
|---|---|
| Syntax (`node --check`) on all 99 JS files | **99/99 pass** |
| Every relative `require()` resolves to a real file | **0 unresolved** |
| JSON manifests (`package.json`, `package-lock.json`, `config.json`) | valid |
| Duplicate command `case` labels | none (148 unique) |
| Dependency-free test suites | 7 suites, **202/202 pass** |
| `tests/menu.test.js` | **11 failures** (see §6) |
| `scripts/stability-audit.js` | **2 failures** (see §6) |

## 5. Findings that matter

### 5.1 Live credentials are shipped in the archive — rotate them
The README says credentials are read "**only** from the environment — never from
source". Three files contradict that:

| File:line | Secret |
|---|---|
| `api.js:6,8` | `MZAZI_API_KEY` and `GENIUS_LYRICS_API_KEY` = `mzazi_c_zHM8uR_…` (same value for both) |
| `config.js:6` | `TELEGRAM_BOT_TOKEN` = `8615317958:AAG4…` (note: a trailing space is inside the string) |
| `whatsapp.js:16-17` | ACRCloud `ACCESS_KEY` / `ACCESS_SECRET` in plaintext |

`config.js` and `api.js` are in `.gitignore`, but **`whatsapp.js` is not** — so the
ACRCloud key pair would be committed to any repo built from this tree. All of these
keys travelled through a public file-sharing link, so treat them as compromised.

### 5.2 The `.igstalk` default endpoint is dead
`config.json → instagram.endpoint` = `https://aemt.me/download/igstalk?username={username}`.
The README itself states `aemt.me` no longer resolves (NXDOMAIN), so `.igstalk`
cannot work until repointed at a live provider.

### 5.3 Menu advertises commands the test says must stay hidden
`tests/menu.test.js:27-30` asserts `chatbot, chatbotdelay, replydelay, darknote,
ask, statusview, statuslike, statusreact, aisticker, aivision` are **not** listed.
`lib/menu.js:14` puts all ten in the `AI & CHAT` category, and `build()`
(`lib/menu.js:68-79`) prints every registered name in `CATEGORIES`. Result:
**11/22 assertions fail** (10 "stays hidden" + "the rendered menu does not show
`.chatbot`"). Either the menu list or the test expectation is stale — as shipped,
`.menu` shows those commands.

### 5.4 The bundled stability audit no longer matches the code
`npm run audit` → `12/14 PASS, 2 FAIL`. Both are **stale regexes, not behaviour
regressions**:

- "pairing has a finite open deadline" — the audit greps `index.js` for the literal
  `Date.now() + 20000`; the code now uses the `PAIRING_WINDOW_MS` constant
  (`index.js:74`, used at `:187` and `:432`). The deadline exists.
- "secondary pairing sockets do not auto-reconnect" — the audit expects
  `__darknotePairingSocket || !state.creds.registered`; the code has
  `conn.__darknotePairingSocket && !state.creds.registered` (`lib/bot-instance.js:185`,
  flag set at `:96`). The behaviour is present.

`STABILITY_AUDIT.md` also claims "98 JavaScript files"; the tree now has **99** —
the document predates the 2026-09-16 edits (`index.js`, `package.json`).

### 5.5 Housekeeping
- `config.json`: `ownerNumber` is a real number (`254107287140`); `channelLink` is
  still the placeholder `REPLACE_WITH_YOUR_CHANNEL`.
- `tests/lyrics.test.js` is a self-running `node:assert` script (prints
  "lyrics tests: PASS", verified) and is **not** wired into `tests/run.js`.
- `src/img/menu.jpg` is the card/menu image; `src/audio/` and `src/img/img di sini`
  are empty placeholders.
- `scripts/protect-downloader.js`, `lib/protected-*.js` and the `.protected.js`
  files are all present, so the obfuscated path is intact.

### 5.6 Nothing hostile found
The one destructive feature, `lib/evil-pain.js` (`evil_pain confirm` — mass group
removal), is fenced: owner-only + group-only + bot-must-be-admin + explicit
`confirm` sub-argument; the bare command only prints a warning. It reports real
per-step outcomes and claims no removals it did not perform.

## 6. Test results (as run)

Passing dependency-free suites: `security` 1/1, `timing` 29/29, `presence` 36/36,
`status-author` 28/28, `ai-providers` 58/58, `autohuman` 29/29, `ai-router` 21/21.

Not runnable yet: `menu` (11/22 — §5.3), and `weather`, `ytdl-stream`, `shazam`
which abort on `Cannot find module 'axios'` because `node_modules` is empty.

## 7. To connect this to a phone number

1. `npm install` in the project directory (nothing is installed yet).
2. `node index.js` — logs the BIGBRO banner, then the **DARKNOTE PAIR PANEL**
   (option `1`), because Telegram pairing is disabled.
3. Pick option `1`, enter the number in international digits (e.g. `2547XXXXXXXX`),
   and the terminal prints the pairing code. Enter it on the phone at
   WhatsApp → Linked Devices → Link a device → Link with phone number.
4. Watch the console: `✅ Connected to WhatsApp` means the session opened; the
   reconnect ladder and every error path print to the same console.

## 8. Assumptions / limits of this review

- Dependency-backed code paths (Axios providers, Sharp, ffmpeg, ACRCloud, Baileys
  itself) were **read, not executed** — nothing is installed yet. Runtime behaviour
  is unverified until `npm install` runs.
- No Git history is present in the archive, so the review is of this snapshot only.
