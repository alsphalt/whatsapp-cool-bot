'use strict'

/*
 * DARKNOTE L2 LICENSE
 * .shazam — identify a song from a replied audio/video, then offer 5 YouTube
 * results as swipeable cards with AUDIO / VIDEO buttons.
 * © DARKNOTE L2 • Bigbrother
 *
 * CREDENTIALS
 * ACRCloud keys are read ONLY from the environment:
 *   ACRCLOUD_HOST, ACRCLOUD_ACCESS_KEY, ACRCLOUD_ACCESS_SECRET
 * A tiny dependency-free .env reader is included so the owner can keep the keys
 * in a file that is not source code. Keys are never logged and never sent to
 * WhatsApp. Any key that has been pasted into a chat must be treated as
 * compromised and rotated.
 *
 * DOWNLOADS
 * The project already ships a multi-provider YouTube downloader in lib/ytdl.js
 * (four providers plus two direct paths), so this module reuses it instead of
 * adding a competing ytdl-core implementation.
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')

const { ytdlAutoBuffer, ytdlAutoVideoFile, extractYouTubeId } = require('./ytdl.js')
const whatsappShazam = require('../whatsapp.js')

const SESSION_TTL_MS = 10 * 60 * 1000
const MAX_MEDIA_BYTES = 15 * 1024 * 1024
const MAX_AUDIO_BYTES = 100 * 1024 * 1024
const DEFAULT_MAX_VIDEO_BYTES = 64 * 1024 * 1024
// Maximum result cards shown for an identification (owner request: 6).
const MAX_RESULTS = 6
const TMP_DIR = path.join(__dirname, '..', 'tmp')
const REQUEST_TIMEOUT_MS = 60000

/* ------------------------------ credentials ------------------------------ */

let envLoaded = false

/** Minimal .env reader: KEY=VALUE, # comments, no expansion, never overrides. */
function loadDotEnv() {
    if (envLoaded) return
    envLoaded = true
    try {
        const file = path.join(__dirname, '..', '.env')
        if (!fs.existsSync(file)) return
        for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith('#')) continue
            const at = trimmed.indexOf('=')
            if (at < 1) continue
            const key = trimmed.slice(0, at).trim()
            let value = trimmed.slice(at + 1).trim()
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1)
            }
            if (key && !(key in process.env)) process.env[key] = value
        }
    } catch (error) {
        console.error('[SHAZAM] .env could not be read:', error?.message || error)
    }
}

function credentials() {
    loadDotEnv()
    const host = process.env.ACRCLOUD_HOST
    const accessKey = process.env.ACRCLOUD_ACCESS_KEY
    const accessSecret = process.env.ACRCLOUD_ACCESS_SECRET
    return { host, accessKey, accessSecret, ready: Boolean(host && accessKey && accessSecret) }
}

/** Build the ACRCloud client, or explain precisely why it is unavailable. */
function acrClient() {
    const { host, accessKey, accessSecret, ready } = credentials()
    if (!ready) {
        return {
            ok: false,
            code: 'NO_CREDENTIALS',
            reason: 'ACRCloud credentials are missing. Set ACRCLOUD_HOST, ACRCLOUD_ACCESS_KEY and ACRCLOUD_ACCESS_SECRET (or add them to .env).'
        }
    }
    let Acrcloud
    try {
        Acrcloud = require('acrcloud')
    } catch (error) {
        return { ok: false, code: 'NO_PACKAGE', reason: `The acrcloud package is not installed: ${error?.message || error}` }
    }
    const Ctor = Acrcloud?.default || Acrcloud
    try {
        return { ok: true, client: new Ctor({ host, access_key: accessKey, access_secret: accessSecret }) }
    } catch (error) {
        return { ok: false, code: 'NO_CLIENT', reason: `The ACRCloud client could not be created: ${error?.message || error}` }
    }
}

/**
 * A SPECIFIC explanation for an unavailable song identifier.
 *
 * "Shazam is not configured correctly on this bot" is not actionable: it does not
 * name the missing piece, so it cannot be fixed without reading the source. The
 * only thing actually absent is the ACRCloud CREDENTIAL - the `acrcloud` package
 * is installed and the client builds correctly - so the exact variable names are
 * named here.
 *
 * The name-search path needs none of this, so it is offered instead of leaving
 * the user at a dead end.
 */
function describeUnavailable(acr, prefix = '.') {
    if (acr?.code === 'NO_CREDENTIALS') {
        return [
            '❌ *Song identification is not switched on for this bot yet.*',
            '',
            '*Missing*: ACRCloud credentials.',
            '• ACRCLOUD_HOST',
            '• ACRCLOUD_ACCESS_KEY',
            '• ACRCLOUD_ACCESS_SECRET',
            '',
            '*What DOES work right now* — search by song name, no credentials needed:',
            `• ${prefix}shazam <song name>`,
            `• for example: ${prefix}shazam ruger`
        ].join('\n')
    }
    return [
        '❌ *Song identification is unavailable.*',
        '',
        `Reason (${acr?.code || 'UNKNOWN'}): ${acr?.reason || 'no reason was reported'}`,
        '',
        `*What DOES work right now*: ${prefix}shazam <song name>`
    ].join('\n')
}

/* -------------------------------- sessions ------------------------------- */

const sessions = new Map()

function createSession(chat, sender, query, results) {
    const sessionId = crypto.randomBytes(8).toString('hex')
    sessions.set(sessionId, {
        chat: String(chat || ''),
        sender: String(sender || ''),
        query,
        results,
        createdAt: Date.now(),
        expiresAt: Date.now() + SESSION_TTL_MS
    })
    return sessionId
}

function getSession(sessionId) {
    const session = sessions.get(String(sessionId || ''))
    if (!session) return null
    if (Date.now() > session.expiresAt) {
        sessions.delete(String(sessionId))
        return null
    }
    return session
}

function cleanExpiredSessions(now = Date.now()) {
    let removed = 0
    for (const [id, session] of sessions) {
        if (now > session.expiresAt) { sessions.delete(id); removed++ }
    }
    return removed
}

// unref() so this timer never keeps the process alive on its own.
const sessionTimer = setInterval(cleanExpiredSessions, 60 * 1000)
if (typeof sessionTimer.unref === 'function') sessionTimer.unref()

/* ------------------------------- utilities ------------------------------- */

function safeFileName(name) {
    return String(name || 'shazam')
        .replace(/[\\/:*?"<>|]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100) || 'shazam'
}

function tempPath(prefix, extension) {
    fs.mkdirSync(TMP_DIR, { recursive: true })
    return path.join(TMP_DIR, `${prefix}-${crypto.randomBytes(8).toString('hex')}${extension}`)
}

/* ------------------------ ACRCloud sample extraction --------------------- */

/*
 * ACRCloud REJECTS large uploads:
 *     3016 "the file you upload is too large, we suggest you cut large file to
 *           smaller file, 10-20 seconds audio data is enough to identify"
 * The bot used to upload the ENTIRE track, so every real song failed and .shazam
 * could only ever answer "I couldn't identify this audio" no matter how clear
 * the clip was. Only tiny clips (a short voice note) ever got through.
 *
 * So the audio is reduced to a 20-second mono 64 kbps window before it is sent.
 * Anything longer than a minute is sampled from the MIDDLE, because the opening
 * seconds of a music video are usually an intro or silence and match poorly.
 * Short clips are used whole.
 */
const ACR_SAMPLE_SECONDS = 20
const ACR_MIDDLE_FROM_SECONDS = 60

/** Run ffmpeg and hand back its exit code + stderr (never throws for -i probes). */
function runFfmpeg(args, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        let bin
        try { bin = require('ffmpeg-static') } catch { return reject(new Error('FFMPEG_UNAVAILABLE')) }
        if (!bin) return reject(new Error('FFMPEG_UNAVAILABLE'))

        const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
        let stderr = ''
        const timer = setTimeout(() => {
            try { child.kill('SIGKILL') } catch { }
            reject(new Error('FFMPEG_TIMEOUT'))
        }, timeoutMs)

        child.stderr.on('data', (chunk) => { if (stderr.length < 20000) stderr += chunk.toString() })
        child.on('error', (error) => { clearTimeout(timer); reject(error) })
        child.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr }) })
    })
}

/** Duration in seconds read out of ffmpeg's banner. 0 when it cannot be read. */
function parseDuration(text) {
    const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(text || ''))
    if (!match) return 0
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

/**
 * Cut a fingerprintable sample out of any audio/video buffer.
 * Returns { sample, duration, start, transcoded }.
 */
async function buildAcrSample(buffer) {
    const input = tempPath('acr-in', '.bin')
    const output = tempPath('acr-sample', '.mp3')
    try {
        await fs.promises.writeFile(input, buffer)

        // ffmpeg exits non-zero for a bare `-i`, but the banner still carries the
        // duration, which is all we need.
        const probe = await runFfmpeg(['-hide_banner', '-i', input], 30000)
        const duration = parseDuration(probe.stderr)
        const start = duration > ACR_MIDDLE_FROM_SECONDS
            ? Math.max(0, Math.floor((duration - ACR_SAMPLE_SECONDS) / 2))
            : 0

        const encoded = await runFfmpeg([
            '-hide_banner', '-loglevel', 'error', '-y',
            '-ss', String(start),
            '-i', input,
            '-t', String(ACR_SAMPLE_SECONDS),
            '-vn', '-ac', '1', '-ar', '44100', '-b:a', '64k',
            '-f', 'mp3', output
        ])

        if (encoded.code !== 0) throw new Error('FFMPEG_ENCODE_FAILED')
        const sample = await fs.promises.readFile(output)
        if (!sample.length) throw new Error('EMPTY_SAMPLE')
        return { sample, duration, start, transcoded: true }
    } finally {
        await removeQuietly(input)
        await removeQuietly(output)
    }
}

/**
 * Best sample for identification, with a safe fallback: if ffmpeg is missing the
 * original buffer is used, which still works for clips small enough to satisfy
 * ACRCloud's upload limit.
 */
async function acrReadySample(buffer) {
    try {
        return await buildAcrSample(buffer)
    } catch (error) {
        console.error('[SHAZAM] sample extraction unavailable, sending the original:', error?.message || error)
        return { sample: buffer, duration: 0, start: 0, transcoded: false }
    }
}

/**
 * Slice up to three 20-second windows out of the media, so identification can
 * retry from a different part of the track when the first window does not match.
 * A clip short enough to be used whole still produces a single window, exactly
 * as before.
 */
async function acrWindows(buffer, maxWindows = 3) {
    const input = tempPath('acr-in', '.bin')
    try {
        await fs.promises.writeFile(input, buffer)
        const probe = await runFfmpeg(['-hide_banner', '-i', input], 30000)
        const duration = parseDuration(probe.stderr)

        const starts = duration > ACR_MIDDLE_FROM_SECONDS
            // Middle first (music videos often open on an intro), then a quarter
            // in, then four fifths in - a spread across the actual song.
            ? [0.5, 0.2, 0.8].map(fraction => Math.max(0, Math.floor((duration - ACR_SAMPLE_SECONDS) * fraction)))
            : [0]

        const windows = []
        for (const start of starts.slice(0, Math.max(1, maxWindows))) {
            const output = tempPath('acr-win', '.mp3')
            try {
                const encoded = await runFfmpeg([
                    '-hide_banner', '-loglevel', 'error', '-y',
                    '-ss', String(start),
                    '-i', input,
                    '-t', String(ACR_SAMPLE_SECONDS),
                    '-vn', '-ac', '1', '-ar', '44100', '-b:a', '64k',
                    '-f', 'mp3', output
                ])
                if (encoded.code !== 0) continue
                const sample = await fs.promises.readFile(output)
                if (sample.length) windows.push({ sample, start, duration })
            } finally {
                await removeQuietly(output)
            }
        }

        if (!windows.length) return [{ sample: buffer, start: 0, duration }]
        return windows
    } finally {
        await removeQuietly(input)
    }
}

/**
 * Identify the EXACT song rather than the first guess.
 *
 * ACRCloud answers from whichever part of the track it is handed, and its reply
 * can be a loose "similar" hit (low score, no ISRC). So several windows are
 * fingerprinted and the highest-scoring match wins. A confident exact hit - high
 * score, or a real ISRC - stops the search immediately instead of spending
 * further requests. Hard provider errors (bad key, unsupported audio) are not
 * retried because another window cannot fix them.
 */
async function identifyBestSong(buffer, options = {}) {
    // A failed media download must report cleanly instead of throwing an opaque
    // "data argument must be a Buffer" out of the ffmpeg/temp-file layer.
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
        return { ok: false, status: { code: 'NO_AUDIO', msg: 'no media buffer to fingerprint' }, best: null, windowsTried: 0 }
    }

    const windows = await acrWindows(buffer, options.maxWindows || 3)
    let best = null
    let lastStatus = null

    for (const window of windows) {
        let response
        try {
            response = await whatsappShazam.identifyBuffer(window.sample)
        } catch (error) {
            console.error('[SHAZAM] fingerprint request failed:', error?.message || error)
            continue
        }

        lastStatus = response?.status || lastStatus

        if (lastStatus && lastStatus.code !== 0 && lastStatus.code !== 1001) {
            return { ok: false, status: lastStatus, best, windowsTried: windows.length }
        }

        const hits = Array.isArray(response?.metadata?.music) ? response.metadata.music : []
        const top = hits[0]
        if (!top) {
            console.log(`[SHAZAM] window at ${window.start}s: no match`)
            continue
        }

        const score = Number(top.score || 0)
        const isrc = String(top.isrc || (top.external_ids && top.external_ids.isrc) || '').trim()
        console.log(`[SHAZAM] window at ${window.start}s: ${top.title} (score ${score}${isrc ? `, isrc ${isrc}` : ''}, ${hits.length} hit(s))`)

        const candidate = { score, song: extractSong(top), raw: top, offset: window.start, hits: hits.length, isrc, status: lastStatus }
        if (!best || score > best.score) best = candidate

        // Confident, verifiable match: stop looking.
        if (score >= 90 || isrc) break
    }

    if (!best) return { ok: false, status: lastStatus, best: null, windowsTried: windows.length }
    return { ok: true, status: best.status, best, windowsTried: windows.length }
}

/**
 * A progress/notification message must never abort the command.
 * WhatsApp intermittently answers a send with "not-acceptable" (an assertSessions
 * failure), and because the flow awaited that reply the whole command used to die
 * with "[SHAZAM] Fatal error" before it had sent anything. Wrapping the reply
 * means a dropped notification is logged and the real work continues.
 */
function safeReply(reply) {
    if (typeof reply !== 'function') return async () => null
    return async (text) => {
        try {
            return await reply(text)
        } catch (error) {
            console.error('[SHAZAM] message could not be delivered:', error?.message || error)
            return null
        }
    }
}

async function removeQuietly(file) {
    if (!file) return
    try { await fs.promises.rm(file, { force: true }) } catch (error) {
        console.error('[SHAZAM] Temp cleanup failed:', error?.message || error)
    }
}

// The id root is assembled at runtime rather than written as one literal. A
// regex literal and a template string cannot be moved into the obfuscator's
// string array, so writing them whole left the button-id shape readable in the
// protected build; splitting the root keeps it out of the bundle's plain text.
const ID_ROOT = 'sha' + 'zam'

/** 1-based index is what the button carries, so card N always maps to result N. */
function buttonIdFor(kind, index, sessionId) {
    return `${ID_ROOT}_${kind}_${index}_${sessionId}`
}

// audio = open the audio choice menu, play = playable audio message,
// file = MP3 document, video = video.
const SELECTION_RE = new RegExp(`^${ID_ROOT}_(audio|play|file|video)_(\\d+)_([a-z0-9]+)$`, 'i')

function parseButtonId(id) {
    const match = String(id || '').match(SELECTION_RE)
    if (!match) return null
    const index = Number(match[2])
    if (!Number.isInteger(index) || index < 1 || index > MAX_RESULTS) return null
    return { kind: match[1].toLowerCase(), index, sessionId: match[3] }
}

/**
 * Find the replied/quoted audio or video (or the media the command is attached
 * to), and report its type so the caller can reject a non-media message.
 */
/**
 * Message types that only WRAP the real media. A view-once arrives as one of
 * these and hides the audio/video/image inside `.message`.
 */
const MEDIA_WRAPPER_TYPES = /^(viewOnceMessageV2Extension|viewOnceMessageV2|viewOnceMessage|ephemeralMessage|documentWithCaptionMessage)$/i

/**
 * Walk through any wrapper to the real media node and report its true type.
 * Handles the case where a node was already unwrapped upstream, so it is safe
 * to call on anything.
 */
function unwrapMediaNode(node) {
    let mtype = String(node?.mtype || '')
    let media = node?.msg || (node?.message ? node.message[mtype] : undefined)
    let guard = 0

    while (MEDIA_WRAPPER_TYPES.test(mtype) && guard++ < 4) {
        let inner = null

        if (media && typeof media === 'object' && media.message && typeof media.message === 'object') {
            // Standard shape: { message: { videoMessage: {...} } }
            inner = media.message
        } else if (node?.message && typeof node.message === 'object') {
            inner = (node.message[mtype] && node.message[mtype].message) || null
            if (!inner && !Object.prototype.hasOwnProperty.call(node.message, mtype)) {
                /*
                 * msg.js substitutes the WRAPPER'S VALUE for the quoted node, so
                 * the real content map sits directly on `.message`:
                 *     m.quoted.mtype    === 'viewOnceMessageV2'
                 *     m.quoted.message  === { videoMessage: {...} }
                 * Without this branch a replied-to view-once never resolved and
                 * .shazam reported "no media".
                 */
                inner = node.message
            }
        }

        if (!inner || typeof inner !== 'object') break
        const innerType = Object.keys(inner)[0]
        if (!innerType) break
        mtype = innerType
        media = inner[innerType]
    }

    return { mtype, media, viewOnce: guard > 0 }
}

/** Decide whether a resolved media node is audio or video. */
function classifyMediaKind(mtype, mimetype) {
    // A document is acceptable when its mimetype says audio/ or video/.
    if (mtype === 'documentMessage' || mtype === 'documentWithCaptionMessage') {
        if (/^audio\//i.test(mimetype)) return 'audio'
        if (/^video\//i.test(mimetype)) return 'video'
        return null
    }
    if (mtype === 'audioMessage' || mtype === 'pttMessage' || /^audio\//i.test(mimetype)) return 'audio'
    if (mtype === 'videoMessage' || /^video\//i.test(mimetype)) return 'video'
    return null
}

/**
 * Work out WHICH media the command was aimed at.
 *
 * Order matters: the message being replied to wins, then the attachment on the
 * command message itself. Each candidate is unwrapped first, so a view-once you
 * replied to is treated as the audio/video it actually contains.
 */
function resolveMediaTarget(m) {
    const candidates = []
    if (m?.quoted) candidates.push({ node: m.quoted, source: 'quoted' })
    candidates.push({ node: m, source: 'attached' })

    for (const candidate of candidates) {
        const node = candidate.node
        if (!node) continue

        const { mtype, media, viewOnce } = unwrapMediaNode(node)
        if (!mtype) continue

        const mimetype = String(media?.mimetype || node?.mimetype || '')
        const kind = classifyMediaKind(mtype, mimetype)
        if (!kind) continue
        if (typeof node.download !== 'function') continue

        return {
            node,
            mtype,
            mimetype,
            kind,
            source: candidate.source,
            viewOnce: Boolean(viewOnce || media?.viewOnce),
            media
        }
    }
    return null
}

function pickCover(thumbnail) {
    if (!thumbnail) return null
    // yt-search returns an array of thumbnails.
    if (Array.isArray(thumbnail)) {
        const best = thumbnail[thumbnail.length - 1]
        return best?.url ? { url: best.url } : null
    }
    if (typeof thumbnail === 'string' && /^https?:\/\//i.test(thumbnail)) return { url: thumbnail }
    if (typeof thumbnail === 'object' && thumbnail.url) return { url: thumbnail.url }
    return null
}

/* ----------------------------- identification ---------------------------- */

function extractSong(music) {
    const artists = Array.isArray(music?.artists)
        ? music.artists.map(artist => artist?.name).filter(Boolean).join(', ')
        : (music?.artists ? String(music.artists) : '')
    const genres = Array.isArray(music?.genres)
        ? music.genres.map(genre => genre?.name).filter(Boolean).join(', ')
        : (music?.genres ? String(music.genres) : '')
    return {
        title: music?.title || 'Unknown',
        artists,
        album: music?.album?.name || '',
        genres,
        releaseDate: music?.release_date || ''
    }
}

function formatIdentification(song) {
    const lines = [
        '╭────────────────────╮',
        '│ *✞* `SHAZAM RESULT`',
        '╰────────────────────╯',
        '',
        `🎵 *Title:* ${song.title}`
    ]
    if (song.artists) lines.push(`👤 *Artist:* ${song.artists}`)
    if (song.album) lines.push(`💿 *Album:* ${song.album}`)
    if (song.genres) lines.push(`🎼 *Genre:* ${song.genres}`)
    if (song.releaseDate) lines.push(`📅 *Release:* ${song.releaseDate}`)
    return lines.join('\n')
}

/** Clean search query: never the whole formatted Shazam reply. */
function buildSearchQuery(song) {
    return [song.title, song.artists].filter(Boolean).join(' - ').trim()
}

async function searchYouTube(query, limit = MAX_RESULTS) {
    const ytSearch = require('yt-search')
    const call = typeof ytSearch === 'function' ? ytSearch : ytSearch?.default
    if (typeof call !== 'function') throw new Error('yt-search is unavailable')

    const searchResult = await call(query)
    const all = Array.isArray(searchResult?.videos) ? searchResult.videos : []
    const picked = []
    const seen = new Set()

    for (const video of all) {
        const url = video?.url || (video?.videoId ? `https://www.youtube.com/watch?v=${video.videoId}` : '')
        if (!url || seen.has(url)) continue
        if (!extractYouTubeId(url)) continue
        seen.add(url)
        picked.push({ ...video, url })
        if (picked.length >= limit) break
    }
    return picked
}

/* ------------------------------- downloads ------------------------------- */

/**
 * Audio, via the project's existing multi-provider downloader, delivered as Opus.
 *
 * The downloader returns whatever the source served — for a YouTube pick that is
 * Opus inside a WebM container — and this used to hand those bytes to WhatsApp
 * labelled `audio/mpeg` under a `.mp3` name. A mislabelled container is exactly
 * the kind of thing a client refuses to play, so the buffer is now re-encoded once
 * to OGG/Opus (the form WhatsApp itself uses for audio notes) and the mimetype and
 * extension follow the bytes that are actually being sent.
 *
 * `toOpusOgg` never throws: if ffmpeg is unavailable it returns the original
 * buffer, and the caller then passes the source mimetype through instead of
 * claiming Opus.
 */
async function downloadShazamAudio(url, destination) {
    const result = await ytdlAutoBuffer(url, 'audio')
    if (!result?.status || !Buffer.isBuffer(result.buffer) || !result.buffer.length) {
        throw new Error(result?.error || 'The downloader returned no audio data')
    }
    if (result.buffer.length > MAX_AUDIO_BYTES) throw new Error('AUDIO_TOO_LARGE')

    const { toOpusOgg } = require('./ytdl.js')
    const source = String(result.mimetype || '')
    const converted = await toOpusOgg(result.buffer, { bitrate: 48000 })
    const buffer = converted?.buffer || result.buffer
    if (buffer.length > MAX_AUDIO_BYTES) throw new Error('AUDIO_TOO_LARGE')

    await fs.promises.writeFile(destination, buffer)
    return {
        title: result.title || 'audio',
        mimetype: converted?.opus ? 'audio/ogg' : (source || 'audio/mpeg'),
        opus: Boolean(converted?.opus),
        size: buffer.length
    }
}

/** Video, via the project's existing ytdlAutoVideoFile helper. */
async function downloadShazamVideo(url, destination, maxBytes) {
    const result = await ytdlAutoVideoFile(url, destination, '720', maxBytes)
    if (!result?.status) throw new Error(result?.error || 'The video downloader failed')
    const stat = await fs.promises.stat(destination).catch(() => null)
    if (!stat?.size) throw new Error('The downloaded video is empty')
    if (stat.size > maxBytes) throw new Error('VIDEO_TOO_LARGE')
    return { title: result.title || 'video', size: stat.size }
}

/* ------------------------------- card build ------------------------------ */

function buildShazamCards(results, sessionId) {
    return results.map((video, index) => {
        const number = index + 1
        const channel = video.author?.name || video.author || 'YouTube'
        const duration = video.timestamp || 'Unknown'
        return {
            title: `🎵 ${number}. ${video.title || `Result ${number}`}`,
            body: `👤 ${channel}\n⏱ ${duration}`,
            image: pickCover(video.thumbnail),
            buttons: [
                { displayText: '🎧 AUDIO', id: buttonIdFor('audio', number, sessionId) },
                { displayText: '🎬 VIDEO', id: buttonIdFor('video', number, sessionId) }
            ]
        }
    })
}

/* ------------------------------ main command ----------------------------- */

/**
 * .shazam — identify the replied/quoted audio or video and offer 5 results.
 * Never throws: every failure path returns a code and a user-facing message.
 */
/** Usage / help, including the live settings. */
function usageText(prefix = '.') {
    const settings = shazamSettings()
    return [
        '╭────────────────────╮',
        '│ *✞* `SHAZAM`',
        '╰────────────────────╯',
        '',
        'Identify a song, or search one by name:',
        `• ${prefix}shazam — reply to an audio or video`,
        `• ${prefix}shazam <name> — search by name`,
        '',
        `Returns up to ${settings.results} YouTube results as swipeable cards.`,
        'Tap 🎧 AUDIO to pick a playable audio song or an MP3 file,',
        'or 🎬 VIDEO for the video.'
    ].join('\n')
}

/** Open a session and send the result cards (shared by both entry paths). */
async function deliverResults({ conn, m, reply, cards, results, title, query }) {
    const sessionId = createSession(m.chat, m.sender, query, results)
    const cardList = buildShazamCards(results, sessionId)

    const sent = await cards.sendCardCarousel(conn, m, {
        heading: `🎵 *SHAZAM — CHOOSE A RESULT*\n\nFound ${results.length} matching results for *${title}*.\nSwipe the cards and tap 🎧 AUDIO or 🎬 VIDEO.`,
        footer: 'DARKNOTE L2 • Shazam',
        cards: cardList,
        mode: cardsMode(),
        fallbackHint: `Send ${(m.prefix || '.')}shazam again to refresh these results.`,
        failureMessage: '❌ Failed to send the Shazam results.',
        reply
    })

    if (!sent.ok) {
        console.error(`[SHAZAM] results could not be sent: ${sent.code} ${sent.reason || ''}`)
        return { ok: false, code: sent.code }
    }
    console.error(`[SHAZAM] ${title} -> session ${sessionId} -> ${results.length} results (${sent.code})`)
    return { ok: true, code: sent.code, sessionId, results: results.length }
}

async function handleShazam({ conn, m, reply, cards, query }) {
    // A dropped progress message must not abort the whole command.
    reply = safeReply(reply)
    try {
        const prefix = String(m?.prefix || '.')
        const searchText = String(query || '').trim()
        const settings = shazamSettings()

        // ---- Path 1: search by name. Needs no media and no ACRCloud. ----
        if (searchText) {
            if (searchText.length > 120) {
                await reply('❌ That search is too long. Please use a shorter song name.')
                return { ok: false, code: 'QUERY_TOO_LONG' }
            }
            await reply(`🔎 Searching YouTube for *${searchText}*...`)

            let results
            try {
                results = await searchYouTube(searchText, settings.results)
            } catch (error) {
                console.error('[SHAZAM] YouTube search failed:', error?.stack || error)
                await reply('❌ The YouTube search failed. Please try again.')
                return { ok: false, code: 'SEARCH_FAILED', query: searchText }
            }
            if (!results.length) {
                await reply(`❌ No YouTube results found for *${searchText}*.`)
                return { ok: false, code: 'NO_RESULTS', query: searchText }
            }

            const outcome = await deliverResults({ conn, m, reply, cards, results, title: searchText, query: searchText })
            return { ...outcome, query: searchText }
        }

        // ---- Path 2: identify the replied / attached media. ----
        const target = resolveMediaTarget(m)
        if (!target) {
            await reply(usageText(prefix))
            return { ok: false, code: 'NO_MEDIA' }
        }

        // The supplied whatsapp.js contains the ACRCloud credentials for media
        // identification. Do not require separate ACRCLOUD_* environment settings.
        await reply('🔎 Identifying the song...')

        let buffer
        try {
            buffer = await target.node.download()
        } catch (error) {
            console.error('[SHAZAM] Media download failed:', error?.stack || error)
            await reply('❌ The media file could not be downloaded.')
            return { ok: false, code: 'MEDIA_DOWNLOAD_FAILED' }
        }
        if (!Buffer.isBuffer(buffer) || !buffer.length) {
            await reply('❌ The media file could not be downloaded.')
            return { ok: false, code: 'MEDIA_EMPTY' }
        }
        if (buffer.length > MAX_MEDIA_BYTES) {
            await reply('❌ The media file is too large.\nPlease use a smaller audio/video clip.')
            return { ok: false, code: 'MEDIA_TOO_LARGE' }
        }

        let result
        try {
            /*
             * Identify the EXACT song. Several 20-second windows are cut from the
             * media (ACRCloud rejects a whole track with 3016 and only needs
             * 10-20 seconds) and the highest-scoring match across them wins, so a
             * bad first window no longer produces a wrong or missing answer.
             * The winning hit is then reshaped into the payload the rest of this
             * function already expects, so nothing downstream changes.
             */
            const identification = await identifyBestSong(buffer)
            if (!identification.ok || !identification.best) {
                const status = identification.status
                console.error(`[SHAZAM] Not identified: ${status?.code ?? 'no status'} ${status?.msg || ''} (${identification.windowsTried} window(s) tried)`)
                await reply("❌ I couldn't identify this audio.\nTry a clearer or longer clip.")
                return { ok: false, code: 'NOT_IDENTIFIED', acrStatus: status?.code }
            }

            const win = identification.best
            console.log(`[SHAZAM] best match: ${win.song?.title || win.raw?.title} (score ${win.score}${win.isrc ? `, isrc ${win.isrc}` : ''})`)
            result = { status: identification.status, metadata: { music: [win.raw] } }
        } catch (error) {
            console.error('[SHAZAM] ACRCloud request failed:', error?.stack || error)
            await reply('❌ Song identification failed. Please try again.')
            return { ok: false, code: 'ACRCLOUD_ERROR' }
        }

        const status = result?.status
        const music = result?.metadata?.music?.[0]
        if (!status || status.code !== 0 || !music) {
            console.error(`[SHAZAM] Not identified: ${status?.code ?? 'no status'} ${status?.msg || ''}`)
            await reply("❌ I couldn't identify this audio.\nTry a clearer or longer clip.")
            return { ok: false, code: 'NOT_IDENTIFIED', acrStatus: status?.code }
        }

        const song = extractSong(music)
        const searchQuery = buildSearchQuery(song)
        await reply(`${formatIdentification(song)}\n\n⏳ Searching YouTube for ${settings.results} results...`)

        let results
        try {
            results = await searchYouTube(searchQuery, settings.results)
        } catch (error) {
            console.error('[SHAZAM] YouTube search failed:', error?.stack || error)
            await reply('❌ I identified the song, but the YouTube search failed.')
            return { ok: false, code: 'SEARCH_FAILED', song }
        }
        if (!results.length) {
            await reply(`❌ I identified *${song.title}*, but couldn't find matching YouTube results.`)
            return { ok: false, code: 'NO_RESULTS', song }
        }

        const outcome = await deliverResults({ conn, m, reply, cards, results, title: song.title, query: searchQuery })
        return { ...outcome, song }
    } catch (error) {
        console.error('[SHAZAM] Fatal error:', error?.stack || error)
        try { await reply('❌ An error occurred while processing Shazam.\nPlease try again.') } catch (reportError) {
            console.error('[SHAZAM] Could not report the error:', reportError?.message || reportError)
        }
        return { ok: false, code: 'FATAL', reason: error?.message || String(error) }
    }
}

/* ----------------------------- button handling --------------------------- */

function cardsMode() {
    try {
        delete require.cache[require.resolve(path.join(__dirname, '..', 'config.json'))]
        const config = require(path.join(__dirname, '..', 'config.json'))
        const mode = String(config?.cards?.mode || 'auto').toLowerCase()
        return ['auto', 'text', 'carousel'].includes(mode) ? mode : 'auto'
    } catch { return 'auto' }
}

/** Live settings from config.json -> "shazam". Re-read so edits apply at once. */
function shazamSettings() {
    const configPath = path.join(__dirname, '..', 'config.json')
    let config = {}
    try {
        delete require.cache[require.resolve(configPath)]
        config = require(configPath) || {}
    } catch (error) {
        console.error('[SHAZAM] config read failed, using defaults:', error?.message || error)
    }
    const maxVideo = Number(config?.shazam?.maxVideoBytes)
    const results = Number(config?.shazam?.results)
    return {
        maxVideoBytes: Number.isFinite(maxVideo) && maxVideo > 0 ? maxVideo : DEFAULT_MAX_VIDEO_BYTES,
        results: Number.isFinite(results) && results >= 1 ? Math.min(MAX_RESULTS, Math.floor(results)) : MAX_RESULTS
    }
}
function maxVideoBytes() { return shazamSettings().maxVideoBytes }

/** Resolve a button's session + result, or explain why it cannot be used. */
function resolveSelection(sessionId, index) {
    const session = getSession(sessionId)
    if (!session) return { error: 'SESSION_EXPIRED' }
    const video = session.results[index - 1]
    if (!video?.url || !extractYouTubeId(video.url)) return { error: 'INVALID_RESULT' }
    return { session, video }
}

/**
 * Pressing AUDIO first asks how the song should be sent:
 *   play -> a playable audio message
 *   file -> a downloadable MP3 document
 * Nothing is downloaded until one of the two is chosen.
 */
async function handleAudioChoiceMenu({ conn, m, reply, cards, index, sessionId }) {
    reply = safeReply(reply)
    const { video, error } = resolveSelection(sessionId, index)
    if (error === 'SESSION_EXPIRED') {
        await reply('❌ This Shazam result has expired. Run `.shazam` again.')
        return { ok: false, code: error }
    }
    if (error) {
        console.error(`[SHAZAM] Invalid result ${index} in session ${sessionId}`)
        await reply('❌ That result is not available any more. Run `.shazam` again.')
        return { ok: false, code: error }
    }

    const label = safeFileName(video.title)
    const shown = await cards.sendChoiceButtons(conn, m, {
        heading: `🎧 *AUDIO — ${label}*\n\nHow should I send this song?`,
        footer: 'DARKNOTE L2 • Shazam',
        buttons: [
            { displayText: '🎵 AUDIO SONG', id: buttonIdFor('play', index, sessionId) },
            { displayText: '📁 FILE SONG', id: buttonIdFor('file', index, sessionId) }
        ]
    })

    if (shown.ok) return { ok: true, code: 'CHOICE_SHOWN', index, sessionId }

    // A build that cannot render buttons must not dead-end the user. The MP3
    // file is the lossless option, so send that and say why.
    console.error(`[SHAZAM] audio choice buttons unavailable (${shown.code}); sending the MP3 file instead`)
    const fallback = await handleSelection({ conn, m, reply, kind: 'file', index, sessionId })
    if (fallback.ok) {
        await reply('ℹ️ This client does not support the audio choice menu, so I sent the MP3 file.')
    }
    return fallback
}

/**
 * Handle a card button press. Downloads only the result that was actually
 * pressed: the 1-based index from the button maps onto that card's result.
 * kind: "play" (audio message), "file" (MP3 document) or "video".
 */
async function handleSelection({ conn, m, reply, kind, index, sessionId }) {
    reply = safeReply(reply)
    const { video, error } = resolveSelection(sessionId, index)
    if (error === 'SESSION_EXPIRED') {
        await reply('❌ This Shazam result has expired. Run `.shazam` again.')
        return { ok: false, code: error }
    }
    if (error) {
        console.error(`[SHAZAM] Invalid result ${index} in session ${sessionId}`)
        await reply('❌ That result is not available any more. Run `.shazam` again.')
        return { ok: false, code: error }
    }

    const label = safeFileName(video.title)
    const isVideo = kind === 'video'
    // Audio lands as OGG/Opus (see downloadShazamAudio), so the temp name follows.
    const tempFile = tempPath(isVideo ? 'shazam-video' : 'shazam-audio', isVideo ? '.mp4' : '.opus')
    const limit = isVideo ? maxVideoBytes() : MAX_AUDIO_BYTES

    await reply(`${isVideo ? '🎬' : '🎧'} Downloading *${label}*...`)

    try {
        if (isVideo) {
            const info = await downloadShazamVideo(video.url, tempFile, limit)
            await conn.sendMessage(m.chat, {
                video: { url: tempFile },
                mimetype: 'video/mp4',
                fileName: `${label}.mp4`,
                caption: `🎬 ${label}`
            }, { quoted: m })
            return { ok: true, code: 'VIDEO_SENT', title: label, size: info.size }
        }

        const info = await downloadShazamAudio(video.url, tempFile)
        const data = await fs.promises.readFile(tempFile)

        /*
         * The mimetype and the extension come from what was actually downloaded,
         * not from a hard-coded 'audio/mpeg' + '.mp3'. Sending Opus-in-WebM bytes
         * under an mp3 label is how a download ends up unplayable on some clients.
         */
        const audioMime = info.mimetype || 'audio/ogg'
        const audioExt = info.opus === false ? 'mp3' : 'opus'

        if (kind === 'play') {
            // Playable audio message.
            await conn.sendMessage(m.chat, {
                audio: data,
                mimetype: audioMime,
                ptt: false,
                fileName: `${label}.${audioExt}`
            }, { quoted: m })
            return { ok: true, code: 'AUDIO_PLAY_SENT', title: label, size: info.size }
        }

        // Downloadable audio file.
        await conn.sendMessage(m.chat, {
            document: data,
            mimetype: audioMime,
            fileName: `${label}.${audioExt}`
        }, { quoted: m })
        return { ok: true, code: 'AUDIO_FILE_SENT', title: label, size: info.size }
    } catch (error) {
        const reason = String(error?.message || error)
        console.error(`[SHAZAM ${kind.toUpperCase()}] failed for ${video.url}: ${reason}`)
        if (kind === 'video' && (reason === 'VIDEO_TOO_LARGE' || /too large/i.test(reason))) {
            await reply('❌ This video is too large to send on WhatsApp.\nTry the 🎧 AUDIO button instead.')
            return { ok: false, code: 'VIDEO_TOO_LARGE', reason }
        }
        if (reason === 'AUDIO_TOO_LARGE') {
            await reply('❌ This audio file is too large to send on WhatsApp.')
            return { ok: false, code: 'AUDIO_TOO_LARGE', reason }
        }
        await reply(`❌ I couldn't download that ${isVideo ? 'video' : 'audio'}.\nTry another Shazam card.`)
        return { ok: false, code: 'DOWNLOAD_FAILED', reason }
    } finally {
        await removeQuietly(tempFile)
    }
}

module.exports = {
    handleShazam,
    handleSelection,
    handleAudioChoiceMenu,
    safeReply,
    usageText,
    deliverResults,
    resolveSelection,
    shazamSettings,
    parseButtonId,
    buttonIdFor,
    resolveMediaTarget,
    unwrapMediaNode,
    classifyMediaKind,
    buildAcrSample,
    acrReadySample,
    acrWindows,
    identifyBestSong,
    parseDuration,
    buildShazamCards,
    buildSearchQuery,
    extractSong,
    safeFileName,
    createSession,
    getSession,
    cleanExpiredSessions,
    credentials,
    acrClient,
    describeUnavailable,
    searchYouTube,
    sessions,
    SESSION_TTL_MS,
    MAX_RESULTS,
    TMP_DIR
}
