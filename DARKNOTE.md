# DARKNOTE — all documentation, one file

Everything that used to be a separate .md in this repo is now in here, on the operator's
instruction ("all md place them in one md file"). Each section below is the original file,
kept as it was written — only a heading and a rule were added around it. The old files have
been removed.

## What is in here

| Section | Was | Bytes |
|---|---|---|
| DARKNOTE L2 | `README.md` | 10247 |
| DARKNOTE L2 Surgical Integration | `FIXES.md` | 31495 |
| DARKNOTE L2 — fixes applied, round 2 | `FIXES-ROUND2.md` | 11583 |
| DARKNOTE L2 — pairing fixes applied on this host | `PATCH-NOTES.md` | 4875 |
| DARKNOTE LEVEL 2 — inspection, integration plan, and the changes that need your approval | `LEVEL2-PLAN.md` | 9790 |
| DARKNOTE L2 (WhatsApp bot) — Code Review | `REVIEW.md` | 11078 |
| DARKNOTE — Whole Bot Stability Audit | `STABILITY_AUDIT.md` | 1918 |

---


<!-- ============================================================================== -->
<!-- BEGIN README.md -->
==============================================================================

# [README.md]

# DARKNOTE L2

Existing DARKNOTE WhatsApp bot. This release contains surgical feature integrations only.

## Protected command implementation

The requested command implementations are isolated in protected modules with runtime string reconstruction and compact control-flow dispatch. This is JavaScript source protection/obfuscation, not cryptographic secrecy.

## Runtime architecture

- One WhatsApp connection
- Existing `auth` multi-file session
- One `messages.upsert` listener
- Existing central command dispatcher
- Existing Baileys dependency preserved as `npm:levvleys`

## New surgical additions

- `.conver` now shows an in-place processing reaction (`⏳`) and removes it when conversion completes/fails.
- `.ss` saves an accessible quoted WhatsApp Status image/video into the current chat.
- `.sss` silently saves an accessible quoted Status image/video into the paired DARKNOTE account's own private/self chat.
- `.cmdset <command> <alias>` persists aliases in the existing `config.json` settings object and resolves them through the existing dispatcher.
- `.stckcmd <command>` persists sticker fingerprints per paired account and routes matching stickers through the existing dispatcher.
- Sticker triggers never bypass the target command's normal permission checks.
- The existing single `messages.upsert` pipeline remains the only message event entry point.

## AI chat with memory (`lib/ai-chat.js`)

- `.ai <message>` — chat with the AI. Memory is kept per session.
- `.ai` as a reply to any message — the quoted text becomes the prompt.
- `.aireset` — clear the memory for the current session.
- `.aimem` — show exactly what the bot remembers.

Provider: `https://www.mzazi.shop/api/ai/gpt-5`. The endpoint is **stateless** and
**hard-rejects any prompt longer than 300 characters** (HTTP 400, measured against
both GET and POST). Memory is therefore stored in
`database/ai-sessions.json` and rebuilt into a compact context block on every
turn, capped at 292 characters so the live message always survives the budget.

Sessions are scoped per member per group (`g:<group>:<number>`) and per user in
direct chats (`d:<number>`), so two people in the same group never share a memory.
Facts are extracted only from what the user actually wrote (name, age, location,
work, likes, dislikes, language preference, plus explicit "remember X" notes).

Endpoint, key, timeout and retry count are overridable in `config.json`:

```json
{
  "ai": {
    "enabled": true,
    "endpoint": "https://www.mzazi.shop/api/ai/gpt-5",
    "apikey": "your-key",
    "timeoutMs": 90000,
    "retries": 4
  }
}
```

## Source protection (`npm run protect`)

The sensitive command modules are obfuscated with `javascript-obfuscator` — the
same tooling the project already used for ytdl:

| Readable source | Protected build |
|---|---|
| `lib/block-status.js` | `lib/block-status.protected.js` |
| `lib/shazam.js` | `lib/shazam.protected.js` |
| `lib/ytdl.source.js` | `lib/ytdl.protected.js` |

`BIGBRO.js` loads the protected build through `requireProtected()` and falls back
to the readable source if it is missing. `lib/ytdl.js` is a loader shim, so every
existing `require('./ytdl.js')` automatically gets the protected downloader.

Each build is verified before it is written — the script loads the obfuscated file
and checks its exports match the source, so a broken build can never replace a
good one.

**This is obfuscation, not encryption.** It stops casual reading and copying; it is
not mathematically unrecoverable. If you hand the bot to somebody else and want
the protection to mean anything, don't ship the readable sources — the trade-off
is losing the fallback.

After editing any protected module, run `npm run protect`. Always edit the
readable source, never the `.protected.js` file. Add a module by appending to
`TARGETS` in `scripts/protect.js`.

## Shazam (`lib/shazam.js`)

Two ways in:

- `.shazam` — **reply to (or attach) an audio or video**. ACRCloud identifies the
  track, then up to 5 unique YouTube results appear as horizontally swipable cards.
- `.shazam <name>` — **search by name**, e.g. `.shazam Burna Boy Last Last`.
  No media and no ACRCloud call.

Cards carry `🎧 AUDIO` and `🎬 VIDEO`. VIDEO downloads and sends the video
straight away. AUDIO first **asks how to send it**:

- `🎵 AUDIO SONG` — a playable audio message
- `📁 FILE SONG` — a downloadable MP3 document

Only the option you pick is downloaded and sent.

Credentials are read **only** from the environment — never from source:

```bash
cp .env.example .env       # then fill in your own keys
ACRCLOUD_HOST=identify-ap-southeast-1.acrcloud.com
ACRCLOUD_ACCESS_KEY=...
ACRCLOUD_ACCESS_SECRET=...
```

Rotate any key that has been shared in a chat or in public.

Downloads reuse the project's existing multi-provider downloader (`lib/ytdl.js`),
so no competing `ytdl-core` code path is added. Buttons carry only
`shazam_<audio|video>_<resultIndex>_<sessionId>` — not a YouTube URL — and are
dispatched through the existing button handler. Card sessions expire after 10
minutes. Temporary files under `tmp/` are always deleted, on success and failure.

```json
{ "shazam": { "results": 5, "maxVideoBytes": 67108864 } }
```

`results` is how many cards to show (1-5); `maxVideoBytes` bounds the video
download. Both are re-read on use, so an edit applies without a restart, and both
are shown in the `.shazam` usage text.

An oversized video returns a clear message pointing at the AUDIO button.

## Instagram stalk (`lib/instagram.js`)

`.igstalk <username>` (alias `.ig`) sends the profile picture with the profile
information as its caption. A leading `@` is accepted; a URL is refused.

> **The default API is dead.** `aemt.me` no longer resolves at all (NXDOMAIN), so
> the command returns `❌ Instagram user information could not be retrieved.`
> until you point it at a working provider. Instagram's own endpoint requires a
> logged-in session (`401 require_login`).

Point it anywhere with `config.json`:

```json
{
  "instagram": {
    "endpoint": "https://your-provider.example/ig?username={username}",
    "timeoutMs": 20000
  }
}
```

The literal `{username}` is replaced with the encoded username; without a
placeholder, `?username=` (or `&username=`) is appended. Several common response
shapes are understood, so most providers work unchanged. A missing or unsendable
profile picture falls back to a plain text message.

## Blocking

`.block` / `.unblock` accept a replied message, a mention (`@number`) or a bare
number, are owner-only, and verify the result against WhatsApp's real blocklist
before reporting success.

Numbers that can never be blocked are configured — never hard-coded:

```json
{ "protectedBlockJids": ["2547XXXXXXXX"] }
```

The bot's own number and `config.ownerNumber` are always protected. Targets are
resolved by LID (which is what the blocklist RPC requires); a number's LID is
looked up through the session, group metadata, and WhatsApp's `onWhatsApp()`. The
result is read back with `fetchBlocklist()`, so no separate local block store is
kept — WhatsApp's blocklist is the single source of truth.

## Ownership

The number the bot is paired to is **always** the owner and creator, regardless of
`config.ownerNumber`. Re-linking to a different number transfers ownership
automatically. Additional owners are stored per session in `database/owner.json`
and managed with `.addowner` / `.delowner`.

## Owner configuration (`lib/config-commands.js`)

- `.setprefix <symbol>` — owner only. Changes the command prefix (max 3 characters,
  no spaces; `$` and `]` are rejected because the dispatcher reserves them for the
  shell and eval shortcuts). Persisted to `config.json` and applied immediately,
  no restart needed.
- `.setgcpp` — sets the current group's photo. Group only. Reply to an image, or
  send an image with `setgcpp` as the caption. Requires group-admin (or owner)
  permission and DARKNOTE must itself be a group admin. The image is normalised to
  a 640x640 JPEG before upload and the temp file is always cleaned up.

## Interactive member cards (`lib/cards.js`)

Member lists render as horizontally swipable carousels of **exactly 15 real
members per card**, each labelled with its position (`CARD 2/3`, `Members 16–30 of 31`).
Members are never duplicated between cards, never truncated, and never invented to
fill a card. Applies to `listonline`, `listactive`, `listinactive`,
`groupadmins` and `admin`. `.tagall` and `.callall` do not use the card layer:
they send a single boxed plain-text broadcast that still carries a real
`mentions` array.

`lib/cards.js` also fixes the `Cannot read properties of undefined (reading 'create')`
crash: it prefers the generated protobuf `.create()` helper when the installed
Baileys build exposes it and falls back to plain object literals when it does not.
If a build cannot relay a carousel at all, the same content is sent as paginated
text pages that still carry the real `mentions` array.

Each card also carries a **media header** taken from
`config.json -> "cards": { "image": "./src/img/menu.jpg" }` (a carousel card with
no media is not rendered as a real card). The picture is downscaled to 600x600
JPEG, uploaded once, and cached against the file's path/mtime/size, so a whole
carousel and every later send reuse that single upload. Relative paths resolve
against the project root, not the shell's working directory. Set the value to
`false` or `""` for text-only cards; any image failure is logged and the command
still sends.

Delivery mode is owner-selectable:

```json
{ "cards": { "mode": "auto", "image": "./src/img/menu.jpg" } }
```

`auto` tries the carousel and falls back to text, `carousel` only uses cards,
`text` forces the guaranteed-mention text pages (and never triggers an
"update WhatsApp" placeholder, because no interactive message is sent).

`cmdset` accepts the new `.ss`, `.sss`, `.cmdset`, and `.stckcmd` commands as well as existing/protected commands. The native `.ss` Status Save behavior keeps priority when `.ss` is used as a reply to an accessible Status, allowing the documented `.cmdset vv ss` fallback behavior without replacing the native Status Save command.

<!-- END README.md -->


<!-- ============================================================================== -->
<!-- BEGIN FIXES.md -->
==============================================================================

# [FIXES.md]

# DARKNOTE L2 Surgical Integration

- Added `.add` with phone-number normalization, real group add, and private group-invite fallback for WhatsApp privacy restrictions.
- Restored `.tagall` as a 12-member-per-card horizontal carousel with real mention metadata and the existing DARKNOTE card image.
- Removed the automatic startup/reconnect profile-picture updater. Profile-picture changes now occur only through the explicit `.pp` command.
- Hardened `.block`/`.unblock` target resolution with WhatsApp account resolution and blocklist verification while retaining the existing authenticated connection.
- Added protected command modules for `.pp`, `.antilink`, `.anticall`, `.promote`, `.demote`, `.vv`, and `.vv2`.
- Added `.conver` for automatic static-sticker-to-image and animated-sticker-to-video conversion.
- Preserved the existing Baileys implementation, auth/session, single WhatsApp connection, and single `messages.upsert` listener.


## Surgical additions in this release
- Added conversion processing reaction lifecycle to protected `.conver`.
- Added `.ss` Status Save and silent `.sss` paired-account Status Save using only media available in the quoted message.
- Added persistent `.cmdset` alias resolution through the existing command dispatcher; aliases work with protected commands without exposing or copying their implementations.
- Added persistent per-session `.stckcmd` sticker fingerprints with runtime alias resolution and normal command permissions.
- Preserved one WhatsApp connection, one auth/session system, one `messages.upsert`, and the existing Baileys dependency (`npm:levvleys`).

## Latest surgical fixes
- Protected the existing `.ss` / `.sss` status implementation using runtime hexadecimal string reconstruction and compact state dispatch; command registration/API remains unchanged.
- Removed the LID resolver's blind `sendPresenceUpdate()` call. Presence is now lifecycle-gated by the single existing socket and suppressed during close/reconnect races.
- Hardened `.block`: bare DM targets the current private chat; group usage without a target never guesses; WhatsApp blocklist verification is performed when supported.
- Centralized owner authorization through the existing `database/owner.json` store. Added owners are recognized by the existing authorization checks, including SELF mode; primary creator cannot be removed.
- Hardened animated sticker conversion FFmpeg discovery to prefer an installed `ffmpeg-static` binary, then `FFMPEG_PATH`, then system `ffmpeg`, with real internal diagnostics.
- Existing `ffmpeg-static`, `sharp`, and protobufjs install-script allowances remain explicitly present; no Baileys/package upgrade was introduced.

## Master surgical integration — 2026-09-10
- Added session-scoped persistent Antidelete / Antidelete2 / Antidelete3 settings using existing `config.json` storage.
- Integrated message retention into the existing single `messages.upsert` pipeline; no second upsert listener was added.
- Added deletion/update handling through the existing socket event system with duplicate-event suppression.
- Antidelete retains only content actually received by the current DARKNOTE session; view-once media is unwrapped and retained as normal media when a mode is enabled.
- Added owner-session isolation while preserving `database/owner.json`; legacy flat owner storage is migrated to the primary session.
- Added session-scoped command aliases; sticker triggers remain session-scoped and resolve aliases through the same dispatcher.
- Added `antidelete on|off`, `antidelete2 on|off`, and `antidelete3 <number|off>` to the command menu.
- Expanded `allmenu` with the complete registered command list so newly registered commands are visible.
- No Baileys upgrade, replacement, second socket, second `messages.upsert`, or duplicate command dispatcher was introduced.

## AI chat + interactive card repair — 2026-09-11
- Added `.ai` / `.ask` (chat with persistent session memory), `.aireset` and `.aimem`, backed by the new `lib/ai-chat.js`. Provider: `https://www.mzazi.shop/api/ai/gpt-5`.
- The provider hard-rejects any prompt above 300 characters (measured: HTTP 400 on GET and POST, for both `prompt` and `message` parameter names). Memory is therefore a budgeted context block rebuilt from `database/ai-sessions.json`, not a replayed transcript. The builder enforces a 292 character budget and always gives the live message priority.
- Session memory is keyed per member per group (`g:<group>:<number>`) and per user in DMs (`d:<number>`), persists across restarts, keeps the last 8 turns, and extracts only verifiable facts (name, age, location, work, likes, dislikes, language preference and explicit "remember X" notes). No fact is ever invented.
- Added retry/backoff for the provider's intermittent `PROVIDER_TIMEOUT` / `PROVIDER_ERROR` responses, a per-session in-flight lock against duplicate handling, corrupt-store recovery, and 30-day / 800-session bounds.
- Fixed `TypeError: Cannot read properties of undefined (reading 'create')`: added `lib/cards.js`, which prefers the protobuf `.create()` helper when the installed Baileys build exposes it and falls back to plain object literals when it does not. The song carousel, YouTube video carousel and channel button now route through the same compatibility layer.
- Member lists now paginate into horizontal carousels of exactly 15 real members per card, labelled `CARD i/N` and `Members a–b of N`, with no duplicated members, no truncation and no invented filler.
- Wired `.tagall`, `.listonline`, `.listactive`, `.listinactive`, `.groupadmins` and `.admin` to the paginated card layer. When a build cannot relay a carousel at all, the same content is delivered as paginated text pages that still carry the real `mentions` array.
- Card delivery is owner-selectable with `config.json -> "cards": { "mode": "auto" | "carousel" | "text" }`.
- Fixed a literal `\n\n` in the `.block` / `.unblock` usage text, made `.public` / `.self` write `config.json` relative to the module instead of the process working directory, and made the `.menu` ping robust when Baileys returns a protobuf Long timestamp.
- Unchanged: one WhatsApp connection, the existing `auth` session, one `messages.upsert` listener, one command dispatcher and the existing `npm:levvleys` dependency. No Baileys upgrade was required.

## Owner configuration commands — 2026-09-11
- Added `.setprefix <symbol>` (owner only) and `.setgcpp` (group admins or the owner), backed by the new `lib/config-commands.js`.
- `.setprefix` validates the input (no spaces, maximum 3 characters, `$` and `]` rejected because they collide with the dispatcher's built-in shell/eval shortcuts), persists it to `config.json` atomically and applies it immediately without a restart, since every module shares the same `config` object. Alphanumeric prefixes are accepted but the reply warns that they turn ordinary chat into commands.
- `.setgcpp` sets the current group's photo. It requires a group context, an image (replied to, or attached with the command as its caption, including wrapped view-once/ephemeral images), the sender to be a group admin or the bot owner, and DARKNOTE itself to be a group admin. The image is normalised to a 640x640 JPEG through `sharp`, uploaded with `updateProfilePicture`, and the temporary file is always removed. WhatsApp's own rejection reason is surfaced to the user and logged.
- Both commands appear in the `OWNER / MANAGEMENT` section of `allmenu` and are picked up automatically by the `.cmdset` registry scan.

## Owner is the paired number — 2026-09-11
- The linked (paired) number is now always the bot owner, without editing `config.json`. `isOwner()` and `isPrimaryCreator()` treat `conn.user.id` as the creator, in addition to `config.ownerNumber` and the stored owner list, so re-linking the bot to a different number transfers ownership automatically.
- **Latent bug fixed:** `owner-system.js` read `m.__darknoteConn` but nothing in the codebase ever assigned it, so the per-session owner store silently keyed on the literal string `"unpaired"`. `BIGBRO.js` now attaches the connection at the dispatcher entry, and legacy `"unpaired"` entries are folded into the real session key on first read so previously added owners are not lost.
- **Second latent bug fixed:** a JID is `254107287140:5@s.whatsapp.net` and `normalizeNumber()` kept the `:5` device suffix. That suffix changes on every re-link, which would both hide the bot's own number from the "cannot add yourself" guard and orphan the owner store after a re-pair. Device ids are now stripped.
- `.owner` / `.cekowner` report the actual creator (the paired number) instead of the static config value.

## Shazam — 2026-09-11
- Added `.shazam` with 5-result horizontal cards carrying `🎧 AUDIO` and `🎬 VIDEO` buttons, backed by the new `lib/shazam.js`. It identifies the replied/attached audio or video with ACRCloud, then searches YouTube with a clean `title - artists` query.
- **Credentials are read only from the environment** (`ACRCLOUD_HOST`, `ACRCLOUD_ACCESS_KEY`, `ACRCLOUD_ACCESS_SECRET`) with a dependency-free `.env` reader, so the keys never live in source. `.env.example` is provided and `.gitignore` excludes `.env` and `auth/`. The keys previously pasted into chat were confirmed still live and must be rotated.
- **Reuses the existing downloader.** `lib/ytdl.js` already ships a four-provider YouTube downloader plus two direct paths, so shazam calls `ytdlAutoBuffer` (audio) and `ytdlAutoVideoFile` (video) instead of adding a competing `ytdl-core` implementation. No exact-bitrate filter is used.
- Buttons carry only `shazam_<audio|video>_<resultIndex>_<sessionId>` — never a YouTube URL. They are dispatched through the **existing** button path (the same one `ytvideo_select_` uses); no second listener or dispatcher was added. Sessions live in memory with a 10-minute TTL, a self-clearing interval that is `unref()`ed, so nothing is left running.
- Each card uses its own YouTube thumbnail; a failed thumbnail falls back to the configured card image so a card is never dropped, which would otherwise shift the buttons onto the wrong result.
- Unique temp files under `tmp/` (`shazam-audio-<id>.mp3`, `shazam-video-<id>.mp4`) are always removed in `finally`, including on download, send, size-guard and expiry failures. An oversized video reports a clear message pointing at AUDIO.
- `config.json -> "shazam": { "maxVideoBytes": 67108864 }` bounds the video download; it is re-read on each use so an edit applies without a restart.
- Dependency added: `acrcloud@^1.4.0` (`yt-search` and `ytdl-core` were already declared). Verified against the published package that `new acrcloud({host, access_key, access_secret})` and `identify(buffer)` are the real API.
- **Known limitation:** on a Baileys build that exposes no `InteractiveMessage` at all, cards cannot be rendered, so the five results are delivered as a numbered text list and the AUDIO/VIDEO buttons are unavailable. The installed `levvleys` build does expose them, so this only affects such a build.

## Shazam: search by name, audio sub-choice, live-fix round — 2026-09-11
- **`.shazam <name>`** now searches YouTube directly, with no media and no ACRCloud call. Typed text takes priority over a replied clip; `.shazam` with neither shows usage documenting both forms.
- **AUDIO now asks before downloading.** Pressing 🎧 AUDIO shows a second choice — `🎵 AUDIO SONG` (a playable audio message) or `📁 FILE SONG` (an MP3 document). Only the chosen form is downloaded and sent. Ids are `shazam_play_<n>_<sid>` and `shazam_file_<n>_<sid>`; the pre-dispatch mapping accepts `audio|play|file|video`, all still routed through the one existing button dispatcher.
- **`config.json -> "shazam"`** now carries `results` (how many cards, 1-5) and `maxVideoBytes`, both re-read on use and both shown in the usage text.
- **Fixed: a rejected progress message aborted the whole command.** WhatsApp intermittently answers a send with `not-acceptable` — in the stack this was `assertSessions` failing inside `assertNodeErrorFree`, reached from `m.bigboreply` inside `handleShazam`. Because the flow awaited that reply, the command died with `[SHAZAM] Fatal error: Error: not-acceptable` *and* the error reply failed too. `safeReply()` now wraps every user-facing message inside shazam, so a dropped notification is logged and the real work continues.
- **Fixed: `.block <bare number>` could not be resolved and fell back to the rejectable phone-number-only form** (`[BLOCK] attempt 1/1 with {"action":"block","jid":"<pn>"} failed: bad-request (server code 400)`). The installed build implements `onWhatsApp()` as a USync query that includes the LID protocol and returns `{ jid, exists, lid }`, so `lib/block-status.js` now asks WhatsApp for the LID when the session has no local mapping. A bare number now sends the upstream-correct `<item action="block" jid="<lid>" pn_jid="<pn>"/>` in a single request.
- Live confirmation from the running bot: ACRCloud identified real tracks and the 5-result carousel sent successfully, e.g. `[SHAZAM] Nikurira Ndirarira -> session 86a9d17e36467136 -> 5 results (CAROUSEL)`. Full song identification and the carousel are therefore confirmed working end-to-end, not just in tests.

## Block hardening + Instagram stalk — 2026-09-11

### Block
- Added a **configurable protected-number guard**. `config.json -> "protectedBlockJids"` (a string or an array, numbers or JIDs) is checked before any request is sent; the bot's own number and `config.ownerNumber` are always included. Nothing is hard-coded in the command. A protected target is refused with `No, 🙂‍↕🙂‍↔` and logged.
- **Fixed: a LID target whose phone number could not be mapped was rejected outright.** The live bot logged `[BLOCK] Target resolution error: Error: Unable to resolve the target WhatsApp account`, because the code demanded a `@s.whatsapp.net` target and threw when `resolveLidEnhanced()` could not map a LID. A LID is exactly what the blocklist RPC wants, so the guard now accepts `@s.whatsapp.net` **or** `@lid`, and the PN lookup became a best-effort bonus rather than a requirement.
- The `onWhatsApp()` follow-up lookup now only runs for a phone-number target, so it can no longer overwrite a LID target with an unrelated JID.
- The guard now reads `config.json` from disk (`liveConfig()`), so an edit to `protectedBlockJids` applies immediately instead of using the load-time snapshot.
- **Verified live against real WhatsApp** (not just in tests) by running the block through the connected session for `254798608399`:
  - `onWhatsApp` returned `{"jid":"254798608399@s.whatsapp.net","exists":true,"lid":"168865615106296@lid"}`
  - `resolveIdentity` produced both identities, so the first request was `<item action="block" jid="168865615106296@lid" pn_jid="254798608399@s.whatsapp.net"/>`
  - block applied on **attempt 1**, and `fetchBlocklist()` then returned `["168865615106296@lid"]` — the block is real on the account
  - unblock applied on attempt 1 and the blocklist returned to `[]`, leaving the account exactly as it was
- Deliberately **not** added: a second blocked-user store. WhatsApp's own blocklist is the source of truth and is read back with `fetchBlocklist()`; a duplicate local list would be the "duplicate block system" the brief warns against. Nothing else is needed for "access to bot commands is restricted" either — a blocked user cannot deliver messages to the bot at all.

### Instagram
- Added `.igstalk <username>` (alias `.ig`), backed by the new `lib/instagram.js`. Usage is shown when no username is given; `@name` is accepted and the `@` stripped; URLs are refused rather than scraped.
- Uses the specified endpoint as the default (`https://aemt.me/download/igstalk?username={username}`) with `encodeURIComponent` on the user input, and is overridable with `config.json -> "instagram": { "endpoint": ... }`. The `{username}` placeholder is substituted, otherwise `?username=` / `&username=` is appended, so any provider shape can be dropped in.
- Parses several common response shapes (`result.user_info`, `result.user`, `data.user`, `user_info`, and Instagram-native `edge_followed_by.count` etc.), so replacing the provider usually needs no code change.
- Every failure is handled and reported cleanly with the real reason logged: missing fetch, network failure, timeout (20s default), HTTP error, non-JSON body, missing `user_info`. A missing or unsendable profile picture falls back to a text message instead of failing.
- **`aemt.me` is dead.** The domain returns NXDOMAIN (`Could not resolve host: aemt.me`) while general outbound HTTPS from the same host works, so the command cannot return live data until the endpoint is pointed at a working provider. Instagram's own `web_profile_info` answers `401 {"require_login":true}` without a logged-in session. See the README for the config line.
- Progress messages are wrapped (same pattern as shazam) so a rejected send cannot abort the lookup.
- No dependency added: native `fetch` is used.

## Source protection for block, shazam and ytdl — 2026-09-11
- Added `scripts/protect.js` and `npm run protect`, using the project's existing `javascript-obfuscator` devDependency (the same tooling `scripts/protect-downloader.js` already used for ytdl). It produces:
  - `lib/block-status.protected.js` — block / unblock protocol
  - `lib/shazam.protected.js` — shazam
  - `lib/ytdl.protected.js` — YouTube downloader
- The pipeline **verifies each build before writing it**: it loads the obfuscated file and asserts its export names match the readable source exactly, so a broken build can never overwrite a good one. Current results: 11 / 25 / 11 exports matched.
- `BIGBRO.js` loads these through a `requireProtected()` helper, and `lib/ytdl.js` became a loader shim (the implementation now lives in `lib/ytdl.source.js`). That is deliberate: BIGBRO and the *protected* shazam both `require('./ytdl.js')`, so routing through the shim means the protected downloader is used everywhere **without changing a single consumer**.
- Every loader falls back to the readable source when a protected build is absent, and logs loudly if one exists but fails to load — a missing file is normal, a broken file is not silent.
- Verified, not assumed: the shim really loads the obfuscated build (`ytdlAutoBuffer` source contains obfuscated identifiers), the fallback really works when the protected file is moved away, and the whole suite passes against the protected code — **179/179, 179/179, 168/168**.
- Plain-text hints eliminated from the protected builds: `blocklist` → 0, full env var names → 0, and the button-id prefix → 0. The prefix needed a source change because a **regex literal and a template string cannot be moved into an obfuscator's string array**; shazam now assembles the id root at runtime.
- **No credential value appears in any protected build** (checked for both leaked keys: 0 matches).
- HONEST SCOPE — this is **obfuscation, not cryptographic encryption**. It stops casual reading, copying and grep-ing for protocol details; it is not mathematically unrecoverable. To make it meaningful when handing the bot to somebody else, do not ship the readable sources (`block-status.js`, `shazam.js`, `ytdl.source.js`) — the trade-off is that the automatic fallback then has nothing to fall back to.
- Workflow note: always edit the readable source and re-run `npm run protect`. Never edit a `.protected.js` file, it will be overwritten.
- Not protected: `lib/instagram.js` (it was not in scope). Add `{ source: 'instagram', output: 'instagram' }` to `TARGETS` in `scripts/protect.js` to include it.
- One test-harness artefact worth recording: loading the readable source in a *test* while the dispatcher loads the protected build creates two module instances with separate session maps. Production never does this — all three shazam call sites use the same loader — but any harness must use `requireProtected` for the same module or session lookups will miss.

## Custom pairing code — 2026-09-11
- `index.js` now passes a custom pairing code to `requestPairingCode()` as its second argument. The installed levvleys fork accepts `requestPairingCode(phoneNumber, pairKey)` and this companion asserts the code during the `link_code_companion_reg` handshake, so the code printed by the bot is the one the phone must be given. The previous comment claiming a custom code was impossible was wrong for this fork and has been corrected.
- The code is configurable with `config.json -> "pairingCode"` and defaults to `DARKNOTE`. It is normalised to 8 uppercase characters because that is what the phone's entry field accepts.
- Verified live: the bot prints `🔐 DARKNOTE PAIRING CODE: DARKNOTE` and waits for the phone to enter it.

## Block / unblock repair — 2026-09-11
- **Root cause of `[BLOCK] Error: Error: bad-request`**: WhatsApp migrated accounts to LID addressing and the blocklist RPC now requires the target's LID, plus its phone-number JID when blocking:
  - `block`   -> `<item action="block" jid="<lid>" pn_jid="<pn>"/>`
  - `unblock` -> `<item action="unblock" jid="<lid>"/>`

  The installed Baileys build (`levvleys` v2.0.22) still sends the phone-number JID alone, so WhatsApp answers with an error node that Baileys surfaces as `bad-request`. Upstream Baileys resolves the LID via `signalRepository.lidMapping` before sending; this fork has no such repository.
- Added `lib/block-status.js`, which issues the correctly-shaped `blocklist` IQ directly through `conn.query` (exposed by the build) and takes the LID only from state the session already holds: the contact directory, the `conn.lidToJidMap` maintained by `lib/msg.js`, and group metadata participants. No LID is ever invented.
- The command now tries the upstream-correct form first and falls back to the legacy forms, logging every attempt with the server's numeric error code. Ten distinct outcomes are surfaced instead of a blanket failure, and the target is never reported as blocked unless `fetchBlocklist` confirms it.
- The pre-check (`already blocked` / `not blocked`) and the post-verification both accept either the LID form or the phone-number form, because the server may key the blocklist entry by either.
- Kept: the owner-only gate, the group-JID rejection, the self/sender guard (now also compared against the account's own LID), and the sanitised error output.
- Note: the LID cannot always be discovered from a bare phone number. Replying to one of the contact's messages, or mentioning them in a group, supplies the LID directly and is the reliable route; the command now says so when it has to fall back.

## Card images — 2026-09-11
- Member-list cards now carry a **media header**. A WhatsApp carousel card without media is not rendered as a real card (the client falls back to an "update WhatsApp" style placeholder), so each card header is now built with `hasMediaAttachment: true` and an `imageMessage`.
- The image is `config.json -> "cards": { "image": "./src/img/menu.jpg" }`. Relative paths resolve against the project root rather than the shell's working directory. Setting it to `false` or `""` renders text-only cards.
- The picture is downscaled to 600x600 JPEG, uploaded **once** through `prepareWAMessageMedia` with `conn.waUploadToServer`, and the prepared `imageMessage` is cached against the file's path/mtime/size so repeat sends (and all 15-member cards of one carousel) reuse the same upload instead of re-uploading.
- Every image failure path degrades safely and is logged with the real reason: unreadable file, no `waUploadToServer` on the build, no `prepareWAMessageMedia` export, or a rejected upload. The command still sends; it just sends cards without a picture.
- `cards.mode: "text"` remains the option that avoids interactive messages entirely if a client still refuses to render cards.
- Also fixed: the `allmenu` thumbnail was read from `./src/img/menu.jpg` relative to the working directory; it now resolves against the project root, so the bot no longer breaks on every command when started from another directory.

## Whole-code stability audit — 2026-09-14
- Hardened pairing WebSocket detection for Baileys forks: pairing now accepts `ws.isOpen === true` as well as the standard `readyState === 1`, with a 20-second bounded wait and transient retry handling.
- Corrected an important auth-state race: `requestPairingCode()` can populate temporary `creds.me` data before the phone finishes linking, so DARKNOTE now treats only `creds.registered === true` as a completed session. Failed/partial pairing state can therefore be safely retried instead of being mistaken for a live account.
- Fixed stale-socket reconnect races. A late `connection.update: close` from an old socket can no longer mark a replacement socket disconnected or schedule an unwanted reconnect.
- Secondary Telegram pairing sockets are explicitly marked as pairing sockets and never auto-reconnected. If a pairing attempt closes, the session waits for a new `/pair` instead of silently creating competing sockets.
- Fixed the main `/pair` in-flight lock so a failed/expired pairing clears the lock and does not block future pairing requests.
- Added a secondary pairing lock to prevent two Telegram updates for the same owner/number from creating duplicate session records/sockets.
- Fixed anti-demote/anti-promote/anti-kick final punishment to demote the unauthorised EXECUTOR rather than kick the affected target member. Protected users remain exempt, and the existing escalation threshold remains in place.
- Fixed a security pipeline bug where a message could be deleted/warned by an anti-feature but still continue into the command dispatcher. A handled security violation now stops normal command execution for that message.
- Made auto-typing and auto-recording mutually exclusive at command time; enabling one automatically disables the other.
- Made menu thumbnail processing lazy. A missing/corrupt `src/img/menu.jpg` can no longer prevent unrelated commands from executing.
- Hardened message parsing for missing `remoteJid` / `conn.user` fields and moved temporary downloaded files under the project root instead of the process working directory.
- Added `npm test` and `npm run audit` scripts plus `scripts/stability-audit.js`, which performs JSON validation, full JavaScript syntax checks, command duplicate checks, pairing invariants, auth-state checks, crash-guard checks, and dependency declaration checks.
- Added a focused security regression test for anti-demote executor punishment.

### Audit results
- Static audit: **PASS — 98 JavaScript files, 0 syntax failures, 148 unique command case labels, 0 undeclared external imports detected.**
- Dependency-backed full test suite could not be completed in this audit environment because the interrupted dependency installation left `axios` unavailable. The source/package manifests are intact; run `npm install` (or `npm ci`) and then `npm test` on the bot host for the complete integration suite.
- Lightweight suites that do not require the missing dependency passed, including AI provider/router, autohuman, timing, status-author, presence, and the new security regression test.

---

## 2026-09-14 pairing repair

- Fixed `/pair` waiting on the raw WebSocket `readyState === OPEN`. Pairing now waits for the actual Baileys `connection.update` `connecting`/QR phase, which is the correct point to call `requestPairingCode()`.
- Added a per-socket pairing-readiness promise for both the primary Telegram pairing socket and secondary Telegram sessions, preventing the request from racing the initial connection event.
- `/pair` now passes the configured `config.json` `pairingCode` when it is exactly 8 alphanumeric characters; otherwise WhatsApp generates the pairing code normally.
- Kept the existing fresh-socket and stale-auth cleanup behavior.


## 2026-09-14 fast login optimization
- Reduced the artificial post-`connecting` pairing delay from 150ms to 25ms.
- Pairing sockets now stay lightweight during the WhatsApp authentication handshake: message/contact handlers are attached only after the socket reaches `open`.
- Registered/reconnecting sockets keep their normal handler setup.
- Kept `fireInitQueries: true` and `syncFullHistory: false` for connection stability and minimal history bootstrap.

## 2026-09-16 DARKNOTE multi-device Telegram pairing merge
- Consolidated the pairing flow around the DARKNOTE multi-session architecture.
- Telegram `/pair` keeps each WhatsApp number in its own isolated session, so new pairings do not replace an existing connected session.
- Increased the configurable default capacity to 100 Telegram accounts and 20 WhatsApp sessions per Telegram account.
- Removed the normal-path artificial pairing delay and the per-socket retry backoff; each pairing socket makes one pairing-code request after the real Baileys `connecting`/QR readiness event.
- Marked a pairing socket as a normal live session after `connection=open`, preventing later disconnects from being mistaken for an unfinished pairing.
- Updated user-facing branding to DARKNOTE.

## 2026-09-16 DARKNOTE multi-device pairing repair
- Fixed the `Connection Closed` failure during Telegram `/pair` by waiting for the actual Baileys transport to become writable before `requestPairingCode()`. This is an event/readiness wait, not an artificial sleep.
- Kept pairing gated on the real `connection.update` `connecting`/QR phase.
- `/pair` now detects numbers already registered in the DARKNOTE session registry and on-disk auth folders, preventing duplicate WhatsApp sessions.
- If an existing registered secondary session is offline, DARKNOTE rebuilds that same session instead of creating another session or disconnecting other users.
- Each Telegram user's WhatsApp sessions remain isolated; restarting/reconnecting one session does not intentionally replace another session.
- Telegram status/session displays now include the WhatsApp number and Baileys version where available.
- All user-facing branding in the changed pairing/session paths is DARKNOTE.

## 2026-09-16 Telegram pairing engine
- Added `lib/telegram-pairing.js` as the dedicated DARKNOTE Telegram `/pair` pairing engine.
- `/pair` now waits only for Baileys `connection.update` `connecting`/QR readiness and does not poll or sleep for the raw WebSocket OPEN state.
- The pairing engine validates the phone number, keeps the request bound to the exact session socket, supports the configured 8-character DARKNOTE pairing code, and applies a request timeout without adding an artificial delay.
- The existing multi-session Telegram registry remains responsible for per-user isolation and duplicate-number detection.


## 2026-09-16 Local panel pairing
- Telegram pairing is disabled without deleting the configured Telegram token/settings.
- Added a terminal DARKNOTE Pair Panel with option 1 for one device and option 2 for up to three devices per panel run.
- Added WhatsApp `!pair <number>` for owner-only pairing, with a global maximum of 25 active paired devices.
- `!pair` randomly selects one of: `DARKNOTE`, `DARKNT23`, `BIGBRO56`, `DEADNOTE`, `UNSENBRO`.
- The pairing response includes a native `cta_copy` Copy Code button that copies the actual pairing code to the user's clipboard.
- Existing bot menu/style and the installed Baileys dependency/configuration were left unchanged.

<!-- END FIXES.md -->


<!-- ============================================================================== -->
<!-- BEGIN FIXES-ROUND2.md -->
==============================================================================

# [FIXES-ROUND2.md]

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

<!-- END FIXES-ROUND2.md -->


<!-- ============================================================================== -->
<!-- BEGIN PATCH-NOTES.md -->
==============================================================================

# [PATCH-NOTES.md]

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

<!-- END PATCH-NOTES.md -->


<!-- ============================================================================== -->
<!-- BEGIN LEVEL2-PLAN.md -->
==============================================================================

# [LEVEL2-PLAN.md]

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

<!-- END LEVEL2-PLAN.md -->


<!-- ============================================================================== -->
<!-- BEGIN REVIEW.md -->
==============================================================================

# [REVIEW.md]

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

<!-- END REVIEW.md -->


<!-- ============================================================================== -->
<!-- BEGIN STABILITY_AUDIT.md -->
==============================================================================

# [STABILITY_AUDIT.md]

# DARKNOTE — Whole Bot Stability Audit

Date: 2026-09-14

## Result

The source was audited without replacing the existing architecture. Baileys connection/session handling, command dispatch, group functions, database/config, and the existing per-socket event model were preserved.

### Fixed

1. Pairing WebSocket detection (`ws.isOpen` + `readyState` fallback).
2. 20-second bounded pairing-open wait.
3. Temporary pairing credentials no longer count as a completed login; only `creds.registered === true` does.
4. Stale socket close events can no longer corrupt replacement-session runtime state.
5. Secondary pairing sockets do not auto-reconnect.
6. Main and secondary pairing locks are released correctly and duplicate secondary pairing requests are blocked.
7. Anti-demote/anti-promote/anti-kick punish the unauthorized executor by demotion instead of kicking the target.
8. Security-handled messages no longer continue into the command dispatcher.
9. Auto-typing and auto-recording are mutually exclusive.
10. Menu thumbnail work is lazy so unrelated commands do not depend on the menu image.
11. Safer message parsing and project-root temporary-file paths.
12. Added `npm test`, `npm run audit`, a static stability audit, and a security regression test.

## Verification

- 98 JavaScript files: syntax check PASS.
- 148 command case labels: unique.
- JSON manifests/config: valid.
- External imports: declared in package manifests.
- Pairing lifecycle invariants: PASS.
- Process crash guards: PASS.
- Security executor-punishment regression: PASS.

## Environment limitation

The complete dependency-backed test runner could not be executed here because the dependency installation was interrupted and `axios` remained unavailable. This is an environment limitation, not a source syntax failure. After installing dependencies on the bot host, run:

```bash
npm install
npm run audit
npm test
npm start
```

<!-- END STABILITY_AUDIT.md -->

<!-- ============================================================================ -->
<!-- APPENDED: keepalive.sh, added after the documentation merge                  -->
<!-- ============================================================================ -->

# [keepalive.sh] — the supervisor this host does not provide

## Why it exists

`lib/runtime.js` **deliberately exits** on any uncaught exception or unhandled rejection.
Its own comment explains the design:

> *"Exit cleanly and let the Pterodactyl/panel supervisor start a fresh process with the
> same persisted auth."*

That is a sound design — a socket can look connected while its internal state is corrupt,
and a fresh process holding the same `auth/` is the honest cure. But **this runtime has no
panel supervisor**: there is no cron and no service manager here, so nothing was restarting
the bot. Every unhandled rejection therefore ended the session *permanently*, and the bot sat
dead until someone ran `run-bot.sh` by hand.

`keepalive.sh` is that missing supervisor, so the exit-on-fatal design finally works the way
its author intended.

## Using it

```bash
bash keepalive.sh                 # start supervising (returns immediately)
bash keepalive.sh --foreground    # supervise in this terminal instead
tail -f logs/keepalive.log        # watch what it decides
```

- **Restarts when the process dies.** Polls every 10s, so recovery is typically 10–20s.
- **Watches the connection, not just the process.** A start that produces no *new*
  `Connected to WhatsApp` line within 90s is treated as failed and retried. That check is
  offset-based, so a stale "Connected" line left by an earlier run cannot be mistaken for a
  fresh one.
- **Backs off.** 10s, 20s, 40s, 60s, 120s, capped at 300s. The backoff resets only after a
  connection has lasted at least 120s, so a bot that connects and instantly dies does not
  become a restart loop.
- **One supervisor per checkout**, enforced by `logs/keepalive.pid`. A second
  `bash keepalive.sh` reports the running one and does nothing.

## Stopping

```bash
touch .keepalive.stop      # stand the supervisor down
rm .keepalive.stop         # let it supervise again
```

Without that file, killing the bot on purpose would simply make the supervisor restart it —
the right default for uptime, the wrong one for "stop the bot now". Note that
`.keepalive.stop` stops *supervising*; it does not itself kill a running bot.

## What it cannot do

**It cannot survive the runtime container being replaced.** The process goes with the
container, supervisor included, and nothing running inside that container can prevent it.
When the container is replaced, start it again with `bash keepalive.sh`. What it does fix is
everything else: crashes, unhandled rejections, dead sockets, and starts that never connect.
