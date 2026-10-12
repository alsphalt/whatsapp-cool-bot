'use strict'

/*
 * DARKNOTE Genius Lyrics service.
 *
 * This is deliberately isolated from every AI, image, sticker, music and
 * YouTube provider. It owns its endpoint, key, timeout and response parsing.
 *
 * THE PROVIDER NEEDS TWO CALLS.
 * ----------------------------
 * `/api/lyrics/genius?q=<free text>` is a SEARCH only: it answers with an array
 * of matches (id, title, full_title, artist, artist_url, song_art, url, stats)
 * and never contains a single line of lyrics. The previous version parsed that
 * payload and always fell through to NOT_FOUND, so `.lyrics` never returned
 * anything.
 *
 * The lyrics themselves live on a second endpoint:
 *     /api/lyrics?t=<title>&a=<artist>
 * which answers `{status:true, result:{title, artist, thumbnail, lyrics}}`.
 *
 * So: search first, then resolve the best match's lyrics. A payload that
 * already carries lyrics is still honoured directly, in case the provider ever
 * decides to inline them.
 */
const api = require('../api.js')

const DEFAULT_TIMEOUT_MS = 15000
const MAX_QUERY_CHARS = 180
const MAX_REPLY_CHARS = 12000
const MAX_SEARCH_RESULTS = 5

function getApiKey() {
    return String(process.env.GENIUS_LYRICS_API_KEY || api.GENIUS_LYRICS_API_KEY || '').trim()
}

function baseUrl() {
    return String(api.BASE_URL || 'https://www.mzazi.shop').replace(/\/+$/, '')
}

/** SEARCH endpoint. Kept as-is: callers and tests read `q` and `apikey` here. */
function endpointFor(query) {
    const url = new URL(`${baseUrl()}/api/lyrics/genius`)
    url.searchParams.set('q', String(query || '').trim())
    url.searchParams.set('apikey', getApiKey())
    return url.toString()
}

/** LYRICS endpoint: title + artist, which is what the provider needs. */
function lyricsEndpointFor(title, artist) {
    const url = new URL(`${baseUrl()}/api/lyrics`)
    url.searchParams.set('t', String(title || '').trim())
    url.searchParams.set('a', String(artist || '').trim())
    url.searchParams.set('apikey', getApiKey())
    return url.toString()
}

function cleanLyrics(value) {
    if (value === undefined || value === null) return ''
    if (typeof value === 'string') return value.trim()
    if (Array.isArray(value)) return value.map(cleanLyrics).filter(Boolean).join('\n').trim()
    if (typeof value === 'object') {
        for (const key of ['lyrics', 'lyric', 'text', 'content', 'body', 'answer', 'result']) {
            if (Object.prototype.hasOwnProperty.call(value, key)) {
                const found = cleanLyrics(value[key])
                if (found) return found
            }
        }
    }
    return ''
}

/** Normalise the search payload's array of matches into usable {title, artist, url}. */
function parseSearchResults(payload) {
    const list = Array.isArray(payload?.result) ? payload.result
        : Array.isArray(payload?.results) ? payload.results
            : Array.isArray(payload?.data) ? payload.data
                : []

    return list
        .map((item) => ({
            title: String(item?.title || item?.song || '').trim(),
            artist: String(item?.artist || item?.artistName || item?.author || '').trim(),
            url: String(item?.url || '').trim()
        }))
        .filter((item) => item.title)
        .slice(0, MAX_SEARCH_RESULTS)
}

function parseResponse(payload) {
    if (!payload || typeof payload !== 'object') return { ok: false, code: 'BAD_RESPONSE' }
    if (payload.status === false) {
        const providerCode = String(payload.error || payload.code || payload.message || '').toUpperCase()
        if (/INVALID_API_KEY|MISSING_API_KEY|UNAUTHORIZED|FORBIDDEN/.test(providerCode)) return { ok: false, code: providerCode.includes('MISSING') ? 'MISSING_API_KEY' : 'INVALID_API_KEY' }
        return { ok: false, code: 'PROVIDER_ERROR' }
    }

    // A search payload is an array of matches, not lyrics. Report it as such so
    // the caller knows to carry on to the lyrics endpoint instead of treating it
    // as a dead end.
    if (Array.isArray(payload.result) || Array.isArray(payload.results)) {
        return { ok: false, code: 'SEARCH_RESULTS', results: parseSearchResults(payload) }
    }

    const result = payload.result
    const candidates = [
        result,
        payload.lyrics,
        payload.lyric,
        payload.data,
        payload.result?.lyrics,
        payload.result?.lyric,
        payload.result?.data,
        payload.result?.text,
        payload.result?.content
    ]

    let lyrics = ''
    for (const candidate of candidates) {
        lyrics = cleanLyrics(candidate)
        if (lyrics) break
    }

    const info = (result && typeof result === 'object') ? result : (payload.data && typeof payload.data === 'object' ? payload.data : {})
    const title = String(info.title || info.song || payload.title || '').trim()
    const artist = String(info.artist || info.artistName || info.author || payload.artist || '').trim()

    if (!lyrics) return { ok: false, code: 'NOT_FOUND', title, artist }
    return { ok: true, lyrics: lyrics.slice(0, MAX_REPLY_CHARS), title, artist, thumbnail: info.thumbnail || null }
}

/**
 * One GET returning the decoded JSON, with every failure collapsed into a code.
 * Kept separate so both steps share the exact same timeout/abort behaviour.
 */
async function requestJson(url, timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: { accept: 'application/json' },
            signal: controller.signal
        })

        let payload
        try { payload = await response.json() } catch { return { ok: false, code: 'BAD_RESPONSE' } }

        if (!response.ok) {
            const code = response.status === 401 || response.status === 403 ? 'INVALID_API_KEY'
                : response.status === 408 || response.status === 504 ? 'PROVIDER_TIMEOUT'
                    : response.status === 404 ? 'NO_RESULT'
                        : 'PROVIDER_ERROR'
            return { ok: false, code }
        }
        return { ok: true, payload }
    } catch (error) {
        if (error?.name === 'AbortError') return { ok: false, code: 'PROVIDER_TIMEOUT' }
        return { ok: false, code: 'PROVIDER_ERROR' }
    } finally {
        clearTimeout(timer)
    }
}

/** Map a provider `{status:false}` payload onto one of our codes. */
function classifyProviderError(payload) {
    const providerCode = String(payload?.error || payload?.code || payload?.message || '').toUpperCase()
    if (/INVALID_API_KEY|UNAUTHORIZED|FORBIDDEN/.test(providerCode)) return 'INVALID_API_KEY'
    if (/MISSING_API_KEY/.test(providerCode)) return 'MISSING_API_KEY'
    if (/MISSING_PARAMETER/.test(providerCode)) return 'MISSING_QUERY'
    if (/NO_RESULT|NOT_FOUND|NO_MATCH|EMPTY/.test(providerCode)) return 'NOT_FOUND'
    return 'PROVIDER_ERROR'
}

async function geniusLyricsSearch(query, options = {}) {
    const q = String(query || '').trim().replace(/\s+/g, ' ')
    if (!q) return { ok: false, code: 'EMPTY_QUERY' }
    if (q.length > MAX_QUERY_CHARS) return { ok: false, code: 'QUERY_TOO_LONG' }

    const key = getApiKey()
    if (!key) return { ok: false, code: 'MISSING_API_KEY' }

    const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Math.max(1000, Number(options.timeoutMs)) : DEFAULT_TIMEOUT_MS

    /*
     * An explicit "song - artist" query goes STRAIGHT to the lyrics endpoint,
     * which is the shape the owner's implementation uses
     * (`.lyrics faded - alan walker` -> ?t=faded&a=alan walker). Only when that
     * yields nothing do we fall back to the free-text search below.
     */
    const explicitTitle = String(options.title || '').trim()
    const explicitArtist = String(options.artist || '').trim()
    if (explicitTitle) {
        const direct = await requestJson(lyricsEndpointFor(explicitTitle, explicitArtist), timeoutMs)
        if (direct.ok && direct.payload?.status !== false) {
            const parsed = parseResponse(direct.payload)
            if (parsed.ok) return parsed
        }
    }

    // Step 1 - search.
    const search = await requestJson(endpointFor(q), timeoutMs)
    if (!search.ok) return { ok: false, code: search.code }

    const payload = search.payload
    if (payload?.status === false) return { ok: false, code: classifyProviderError(payload) }

    // The provider may already inline lyrics: use them if so.
    const inline = parseResponse(payload)
    if (inline.ok) return inline

    // Step 2 - resolve lyrics for the best match.
    const matches = inline.results?.length ? inline.results : parseSearchResults(payload)
    if (!matches.length) return { ok: false, code: 'NOT_FOUND', title: inline.title, artist: inline.artist }

    let lastCode = 'NOT_FOUND'
    for (const match of matches) {
        const found = await requestJson(lyricsEndpointFor(match.title, match.artist), timeoutMs)
        if (!found.ok) {
            lastCode = found.code
            continue
        }
        if (found.payload?.status === false) {
            lastCode = classifyProviderError(found.payload)
            continue
        }
        const parsed = parseResponse(found.payload)
        if (parsed.ok) return parsed
        lastCode = parsed.code
    }

    return { ok: false, code: lastCode, title: matches[0].title, artist: matches[0].artist }
}

function formatLyrics(result) {
    if (!result?.ok || !result.lyrics) return ''
    const title = result.title || 'Unknown song'
    const artist = result.artist ? ` — ${result.artist}` : ''
    return [
        '> ╭────────────────────╮',
        '> │ *✞* `DARKNOTE LYRICS`',
        '> ╰────────────────────╯',
        '>',
        `*${title}${artist}*`,
        '>',
        result.lyrics,
        '>',
        '☬✞ßig ß®°ther✞ 𑲭 ☬'
    ].join('\n')
}

module.exports = {
    geniusLyricsSearch,
    formatLyrics,
    parseResponse,
    parseSearchResults,
    endpointFor,
    lyricsEndpointFor,
    DEFAULT_TIMEOUT_MS
}
