# DARKNOTE L2 — fixes applied, round 2

Date: 2026-09-16 (after the first pairing fixes in `PATCH-NOTES.md`)
Every item below was verified by running it, not by reading it.

---

## 1. 307 commands were silently dead — `BIGBRO.js`

`ReferenceError: bigboreply is not defined`, thrown from **303 call sites** inside the
dispatcher and swallowed by the per-command `try/catch`. The console only ever showed
`ERROR Error in command handler: {}` and the user saw nothing.

`m.bigboreply` is defined at `lib/msg.js:466`, but 303 handlers called the bare
identifier. Verified every one of those sites sits inside
`module.exports = async (conn, m) => {` (`BIGBRO.js:833`) — the one scope holding both
`m` and `conn` — so a single local alias repairs all of them without touching a call site:

```js
const bigboreply = (text, chatId, options) => {
    if (typeof m.bigboreply === 'function') return m.bigboreply(text, chatId, options);
    return conn.reply(chatId || m.chat, text, m, options);
};
```

## 2. `.lyrics` never returned lyrics — `lib/lyrics.js`

The provider's `/api/lyrics/genius?q=` is a **search only**: it answers with an array of
matches (`title`, `artist`, `url`, `stats`) and contains no lyrics at all, so
`parseResponse()` always fell through to `NOT_FOUND`. Live proof: HTTP 200 in 1.9s.

The lyrics live on a second endpoint, `GET /api/lyrics?t=<title>&a=<artist>` →
`{status:true, result:{title, artist, thumbnail, lyrics}}`.

`lib/lyrics.js` now searches, then resolves the best match's lyrics, with the same
timeout/abort/error-code behaviour per request. Verified live:
`Last Last` → 1575 chars, `Hope` → 1085 chars, and `tests/lyrics.test.js` still passes.

## 3. Shazam could never identify a real song — `lib/shazam.js`

**Root cause:** the whole track was uploaded and ACRCloud rejects it:
`3016 — "the file you upload is too large ... 10-20 seconds audio data is enough"`.
Only tiny clips ever got through, so `.shazam` reported "couldn't identify" for every
real song. Verified live: a 6.7 MB download → `3016`.

Now `acrReadySample()` cuts a **20-second mono 64 kbps window** (taken from the *middle*
for anything over a minute, since music-video intros match poorly; short clips are used
whole) and falls back to the original buffer if ffmpeg is unavailable.

Verified end-to-end against real music:
- *Last Last* — Burna Boy → **IDENTIFIED** (157 KB sample from a 172s clip, offset 76s)
- *Dior* — Ruger → **IDENTIFIED** (157 KB sample from a 231s clip, offset 105s)

### Media selection — `resolveMediaTarget()` in `lib/shazam.js` + `lib/msg.js`

The command now reliably works out *which* media it was aimed at: the replied message
first, then the attachment on the command message. Two real gaps were fixed:

- **View-once was never detected.** For a quoted view-once, `m.quoted.mtype` stayed
  `viewOnceMessageV2`, so detection rejected it and
  `m.quoted.mtype.replace(/Message/i,'')` produced the nonsense type `viewOnceV2` —
  the download could not resolve the content key either. `lib/msg.js` now unwraps a
  quoted view-once to its real media type and points `msg` at the inner content, and
  `unwrapMediaNode()` does the same defensively (nested wrappers included).
- **Audio/video documents** are now accepted via their mimetype.

13/13 media-selection cases pass (replied audio, replied video, replied view-once
audio/video in both raw and pre-unwrapped shapes, ephemeral wrapper, attached video,
audio note, audio document, and four "no media" shapes).

## 4. Global button system — new `lib/buttons.js`

There was **no** row logic anywhere in the project: every button list was a flat array
handed straight to `nativeFlowMessage`. Added one canonical helper:

```js
const { createButtons } = require('./lib/buttons.js')
const built = createButtons([
    { id: 'general',  text: '⚙️ General' },
    { id: 'privacy',  text: '🔒 Privacy' },
    { id: 'security', text: '🛡️ Security' }
])
// built.rows       -> [[general, privacy], [security]]
// built.nativeFlow -> ready for interactiveMessage.nativeFlowMessage.buttons
```

Layout: **max 2 per row, and an odd count always leaves the final button alone on its
own row** (1→1, 2→2, 3→2+1, 4→2+2, 5→2+2+1, 6→2+2+2, 7→2+2+2+1, 8→2+2+2+2). Ids and
display texts pass through byte-identical, so no command changes behaviour. Link
(`cta_url`) and copy (`cta_copy`) buttons are supported alongside `quick_reply`.

Wired into the only two places that build interactive buttons —
`lib/cards.js:tryCardCarousel` and `lib/cards.js:sendChoiceButtons` — so every existing
and future case inherits the standard. Legacy `buttonsMessage` sites (`.menu`,
`.allmenu`) are untouched: they use a different protobuf and already hold ≤2 buttons.
Unknown button ids are already a safe no-op (`default: break;` + the outer try/catch),
so nothing new can crash.

New suite `tests/buttons.test.js` (44 assertions) — **44/44 pass**.

## 5. Menu no longer contradicts the registry — `lib/menu.js`

`tests/menu.test.js` was failing 11/22: the menu advertised AI-family commands the test
requires to stay hidden, and they also leaked into the "MORE" bucket. Added a
`PRIVATE_COMMANDS` set to `isInternal()` — the single filter both `build()` and
`listCommands()` already route through — so the listing and the reported count agree.
**22/22 pass** (was 11/22).

## 6. Stopped the "waiting" messages

- `lib/ai-chat.js:515` — removed `'⏳ I am still answering your previous message. Please
  wait a moment.'` (sent in DMs on a duplicate request). The duplicate guard stays; the
  reply is silent now.
- `ai/chatbot.js:scheduleFollowUp` — **disabled outright.** It armed an unprompted
  "you went quiet" DM nudge (an LLM follow-up, or literally
  `'Looks like you are busy 😅 no rush.'`). Returns immediately regardless of config.
- `config.json → ai.followUpMaxPerSilence` set to `0`.
- `BIGBRO.js:sendPairProgress` — the flow opened with
  `'⏳ Waiting for the pairing code......'`; replaced with the requested pairing UX
  (`🔗 PAIRING REQUEST` / `Number:` / `Creating your dedicated session...`).

## 7. Pairing for a SECOND number never worked — `index.js`

Per-number sessions already existed and were already correct (`lib/sessions.js:create()`
gives each number `sessions/<id>` with its own auth dir, and the code is requested on that
session's own socket). The gap was the window: WhatsApp closes a pairing socket right
after `companion_hello` and only delivers the approving `pair-success` on a NEW socket, and
`lib/bot-instance.js:185` gave up instead (`onClose('pairing-closed')` →
`DISCONNECTED, send /pair to try again`), so a second number could never complete.

`startSecondarySession().onClose` now re-opens the **same** session — `createBotInstance`
never wipes `authDir`, so the pending `me` + `pairingCode` survive — and re-arms the code
on the fresh socket, bounded by `SECONDARY_PAIRING_RESUME_MAX` (20), clearing its counter
once the session goes live. The first number is unaffected: it lives in `auth/` with its
own keep-alive in `createPairingSocket()`.

Also widened the QR ready-gate timeout in `requestCode()` to 60s
(`Math.max(PAIRING_WINDOW_MS, 60000)`): WhatsApp rotates QR refs only every ~20s, so the
old 20s window could expire between two refs and discard the request. The `!pair` path has
no pre-armed ready promise, so it needed room for at least one ref.

## 8. Test status

| Suite | Result |
|---|---|
| menu | 22/22 (was 11/22) |
| buttons (new) | 44/44 |
| shazam | 22/22 |
| security / timing / presence / status-author | 1/1, 29/29, 36/36, 28/28 |
| ai-providers / autohuman / ai-router | 58/58, 29/29, 21/21 |
| lyrics (standalone) | PASS |

`weather`, `ytdl-stream` still abort on `Cannot find module 'axios'` — unrelated, they need
a dependency install.

## 9. Still open / not changed

- **Part 4 session naming.** The user's example was `session_254700000001`; sessions are
  actually `sessions/<generatedId>` with the number stored in the record's `phone` field.
  Functionally equivalent and already isolated per number, so the directories were **not**
  renamed — renaming would invalidate every existing session.
- Music-video intros: the 20s sample is taken from the middle, so a clip whose only music
  is in the first seconds may still need a second attempt.
- Credentials are still in source (`api.js`, `config.js`, `whatsapp.js:16-17`) — rotate them.
- `config.json → instagram.endpoint` still points at the dead `aemt.me` host.

---

# Round 3 — reactions, exact Shazam, 6 result cards

## Global reaction feedback — new `lib/reactions.js`

A command that does real work now acknowledges the message it was invoked from.
`withReaction(conn, m, work)` puts **⏳** on the trigger message, then settles on
**✅** or **❌**; `setReaction(conn, m, emoji)` is the raw form. The wrapper is strictly
additive — the callback's return value and any throw pass straight through, and a
reaction that cannot be delivered can never abort a command.

Applied to the five commands requested:

| Command | Reaction |
|---|---|
| `.menu` | ✅ on the tap (instant command) |
| `.lyrics` | ⏳ → ✅ / ❌ around the provider calls |
| `.song` | ⏳ at the search, ✅ after the carousel, ❌ on failure |
| `.shazam` | ⏳ → ✅ / ❌ around the whole identify + search |
| `.pair <number>` | ⏳ → ✅ / ❌ around the session + code request |

## Shazam now finds the EXACT song — `lib/shazam.js`

A single window was fingerprinted, so a bad first window meant a wrong or missing
answer. Now up to **three 20-second windows** are cut from the media (middle first,
then 20% and 80% in — music-video intros match poorly) and the **highest-scoring
match wins**. A confident hit stops the search early instead of spending more
requests, and hard provider errors (bad key/format) are not retried.

Verified through the **obfuscated build the bot actually loads**:

| Clip | Result |
|---|---|
| *Calm Down* | score **100**, ISRC `NGA3B2214021` — "Calm Down — Rema, Selena Gomez" |
| *Suzanna* | score **100**, ISRC `ZAUM71901388` — "Suzanna — Sauti Sol" |

Also guarded: a failed media download now reports `NO_AUDIO` instead of throwing an
opaque "data argument must be a Buffer" out of the ffmpeg layer.

## Result cards capped at 6 — `lib/shazam.js`

`MAX_RESULTS` raised from 5 to **6**, so an identification shows at most 6 result
cards (the button-id parser and the card builder both read the same constant, so the
indexes stay consistent).

## IMPORTANT — the obfuscated builds were shadowing every fix

`BIGBRO.js` loads `lib/<name>.protected.js` **when it is present**, and those files
shipped from the archive were built from the *old* sources. Every repair to
`lib/shazam.js` (media selection, sample extraction, exact identification) would have
been invisible in chat while the bot kept running the broken build.

Rebuilt with the project's own pipeline — `npm run protect` — which verifies the
export table before writing:

```
[PROTECT] shazam.js -> shazam.protected.js (41063 -> 62711 bytes, 33 exports match the source)
```

**33/33 exports match** the fixed source, `handleShazam` is a function, and the
identification tests above were run against the protected build. Any future edit to
`block-status.js`, `shazam.js` or `ytdl.source.js` must be followed by
`npm run protect`, or the change will not be loaded.

## Suites after round 3

menu **22/22** · buttons **44/44** · shazam **22/22** · lyrics standalone **PASS**
