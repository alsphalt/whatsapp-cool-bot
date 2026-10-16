# DARKNOTE L2 — full project audit

**Target:** `alsphalt/whatsapp-cool-bot` @ `dc1d4e0` — includes the `.say` / `lib/tts.js` change, which is committed
**Date:** 2026-10-16
**Runtime:** Node.js v22.23.2, npm 10.9.8, Linux x64
**Scope:** 164 tracked files · 135 JS files / 40,255 lines · 5 HTML / 12,925 lines · 53,422 lines total (excl. `package-lock.json`)

---

## 1. Verdict

The project is structurally sound and its own gates pass. **No code-execution path, credential or data store was found to be reachable by a non-owner.** The serious findings are all about what is *published*, not about what an attacker can trigger remotely: a live ACRCloud credential and a pairing passcode sit in public version control, and six high-severity advisories sit in the dependency tree.

| Gate | Result |
|---|---|
| `npm install` | 389 packages, no native build failures |
| `npm test` | **478/488** — 10 failures, all pre-existing `ai/autohuman` with the switch off in `config.json` |
| `npm run audit` | **PASS** — 135 files syntax-clean, 162 unique case labels, all external imports declared |
| `npm audit --omit=dev` | **10 advisories** — 4 moderate, 6 high |

---

## 2. What this change adds

`.say <text>` speaks text back as a WhatsApp voice note, or speaks a replied-to message.

| File | Change |
|---|---|
| `lib/tts.js` | **new**, 277 lines — the single TTS pipeline |
| `BIGBRO.js` | `case 'say'` at :3911; `require('./lib/tts.js')` at :44 |
| `config.json` | `"sayVoice": "en"` |
| `lib/menu.js` | `say` added to MAIN → 153 menu commands, 162 case labels |

### Why it is one module and not inline

The case body is deliberately thin. Language choice, pitch and the Opus container conversion live in `lib/tts.js` because the two copies of those steps are exactly what let `.say` drift into sending an MP3 with `ptt: true` — a voice note whose bytes are the wrong container arrives and plays silently, which reads as "the bot is broken" rather than "the wrong mimetype was sent". AI voice replies need the same three steps, so there is now one implementation to fix.

### Endpoint verification (live, this host)

```
https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q=...
  -> HTTP 200, content-type: audio/mpeg, 24000 Hz, mono, 64 kb/s
  -> tl=sw / fr / es / hi / ar also HTTP 200
```

No API key, nothing to configure. That 24,000 Hz mono source rate is not inferred — the male-voice pitch shift is computed from it (`asetrate=20640,aresample=48000,atempo=1.162791`), so if the endpoint ever changes format the male voice would sound wrong rather than go silent.

### Verification performed

| Check | Result |
|---|---|
| Output container | `opus, 48000 Hz, mono` in OGG — what a `ptt` note requires |
| `en`, `en-male`, `sw`, `fr` | all produce real Opus audio |
| Voice shapes: `en`, `sw`, `en-gb`, `male`, `en-male`, `male-en`, `en-gb-male`, `MALE` | all resolve correctly; unknown language falls back to `en` and is flagged, never fails |
| `''`, `'   '`, `null`, `undefined` | `buffer: null`, reason `nothing to say` — **never throws** |
| 479-character input | trimmed to 200 and still produces audio |
| Graceful degradation | Opus failure still returns the raw MP3 with `ok: false`, so the caller sends a normal audio file (`ptt: false`) rather than nothing |

The invariant that matters: `synthesize()` never throws. It always answers `{ buffer, ok, reason }`, and `ok` is true only when the buffer is a genuine Opus voice note.

---

## 3. Findings

### HIGH — live credential published in version control

**H1 · ACRCloud credentials hard-coded in `whatsapp.js:16-17`**

```js
const ACR_ACCESS_KEY = '26afd4ee…ab37'
const ACR_ACCESS_SECRET = 'wXOZIqdM…MN8'
```

These are real values on a public repository's `main`, and they contradict the project's own contract — the README states Shazam credentials are read *"only from the environment — never from source"*, and `.env.example` already documents `ACRCLOUD_ACCESS_KEY` / `ACRCLOUD_ACCESS_SECRET`.

**Not fixed on purpose.** Removing the literals without the environment set breaks Shazam on the host. The fix is two steps and the second belongs to the operator:

1. Rotate the key in the ACRCloud console — the current one is already public, so a code change alone does not undo the exposure.
2. Then env-var it, matching `lib/shazam.js`.

**H2 · `config.json` is tracked, and it holds secrets**

| Key | Committed value | Why it matters |
|---|---|---|
| `pairPasscode` | `112410` | A shared secret for the pairing card — publicly known |
| `ownerNumber` | `254107287140` | Publishes the operator's number |
| `ai.apikey` | *(absent)* | `.env.example` documents this as a valid home for the AI provider key, so a key pasted here **would be committed** |

The `.gitignore` is otherwise careful and shows this was considered: `.env`, `auth/`, `sessions/`, `auth_tg_*/` and `database/` are all excluded, with comments explaining that the last of those holds third-party messages and phone numbers. `config.json` appears to have been missed rather than ignored.

### HIGH — dependency advisories

**H3 · 6 high, 4 moderate (`npm audit --omit=dev`)**

| Severity | Package | Issue |
|---|---|---|
| high | `sharp` ≤ 0.35.5-rc.1 | inherited libvips CVEs (CVE-2026-33327, CVE-2026-…); fix is **breaking** (sharp@0.35.5) |
| high | `minimatch` ≤ 3.1.3 | ReDoS via repeated wildcards with non-matching literals |
| high | `brace-expansion` ≤ 1.1.20 | quadratic-time `{a,b}` expansion |
| high | `node-fzf` / `yt-search` / `redstar` | reach `minimatch` through `yt-search` |
| moderate | `file-type` 13.0.0–21.3.0 | infinite loop in the ASF parser on malformed input — **this package parses attacker-supplied media** |
| moderate | `phin` < 3.7.1 | may forward sensitive headers across a redirect |
| moderate | `@jimp/core`, `@jimp/custom` | via `file-type` / `phin` |

`file-type` is the one to prioritise: it is the project's own media sniffing (`BIGBRO.js:33`), so its input is whatever a stranger sends the bot.

### MEDIUM

**M1 · Outbound fetch of a third-party-chosen URL** — `lib/ytdl.source.js:990` fetches `result.download_url`, a link supplied by a scraper API rather than by the operator. Not a classic SSRF (the user cannot name the host), and it is well bounded: 120 s timeout, 50 MB `maxContentLength`, `validateStatus` restricted to 2xx/3xx, plus magic-byte validation (`ID3`/`OggS`/`ftyp`) because a scraper's `content-type` is a hint, not a fact. Recorded because the trust boundary is a third party's response body.

### LOW — accepted by design

**L1 · `eval()` and a full shell, gated to the creator** — `]>` at `BIGBRO.js:1132/1138` and `$` at `:2413` execute arbitrary JS and arbitrary shell. Both are behind `if (!isCreator(m)) return …`, which is what the README documents ("`$` and `]` are rejected because the dispatcher reserves them for the shell and eval shortcuts"). This is a deliberate operator escape hatch, not a defect. Its real risk is that it is only as strong as the owner's WhatsApp account, which is also the account that can pair new sessions. The shell has no command allowlist; the 30 s timeout and 5 MB buffer are the only bounds.

**L2 · Predictable temp filename in the working directory** — `whatsapp.js` writes `./${Math.floor(Math.random()*10000)}.mp3`, a 10,000-name space, into the process CWD before sending it. Collision between two concurrent invocations is possible. Cleanup is correct (a `finally` with `fs.promises.rm`).

**L3 · No other hard-coded credentials** — all 164 tracked files were scanned for `secret|api_key|access_key|token|password` followed by a 16+ character literal. `whatsapp.js:16-17` was the only match.

---

## 4. What is in good shape

- **No shell injection.** Zero `exec`/`spawn` call sites interpolate user content: `git grep -E "exec(Sync)?\(\s*[\`\"'].*\\\$\{"` returns nothing. The two shell sites take a fixed slice of the raw message.
- **Every outbound call is bounded.** All 12 `axios` call sites set an explicit timeout; the largest download caps at 50 MB.
- **Session credentials cannot be committed.** `auth/`, `sessions/`, `auth_tg_*/` are excluded, each with a comment naming the file that creates it.
- **Third-party data is excluded.** `database/` is ignored wholesale, with a comment noting it holds other people's messages, phone numbers and the owner store.
- **Registries are defensive.** Both `DarknoteApps` and `DarknoteGames` reject a duplicate id rather than silently shadowing.
- **The boot path is honest.** `ai/config.js` and `api.js` are tracked deliberately (nine modules require the former at load time), and the `.gitignore` anchors `/config.js` so the previous unanchored rule cannot silently exclude them again.

---

## 5. Recommended order

| # | Action | Owner |
|---|---|---|
| 1 | Rotate the ACRCloud key, then env-var `whatsapp.js:16-17` | operator, then code |
| 2 | Decide on `config.json`: untrack it, or move `pairPasscode` / `ownerNumber` (and any future `ai.apikey`) into `.env` | operator |
| 3 | `npm audit fix` for the non-breaking advisories; plan the `sharp` 0.35.5 upgrade separately | code |
| 4 | Prioritise the `file-type` advisory — its input is stranger-supplied media | code |

Findings H1 and H2 are the only ones that need a human decision before code. Everything else is mechanical.
