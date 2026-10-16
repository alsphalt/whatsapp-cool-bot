'use strict'

/*
 * TEXT TO SPEECH — ONE PIPELINE
 * ----------------------------
 * `.say` and the AI voice replies must produce the SAME kind of audio, so the
 * whole job lives here and nowhere else. There were two copies of these steps
 * before, and the copy inside `.say` is exactly what let it drift into sending an
 * MP3 with `ptt: true`: a voice note carrying the wrong container arrives and
 * plays no sound, which looks like "the bot is broken" rather than "the wrong
 * mimetype was sent".
 *
 * The steps, in order:
 *   1. pick the language for the requested voice
 *   2. fetch the MP3 from the public translate endpoint (no key, nothing to
 *      configure)
 *   3. lower the pitch when the voice is male
 *   4. re-container it as mono OGG/Opus, which is what a WhatsApp ptt voice
 *      note actually is
 *
 * VERIFIED BEFORE THIS FILE WAS WRITTEN (live, this deployment):
 *   https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q=...
 *   -> HTTP 200, content-type audio/mpeg, 24000 Hz, mono, 64 kb/s
 *   -> tl=sw / fr / es / hi / ar also return HTTP 200
 * That 24000 Hz mono source rate is not a guess: the pitch shift below is
 * computed from it, so if the endpoint ever changes its format the male voice
 * would be wrong rather than silent.
 *
 * THE CONTRACT — synthesize NEVER THROWS. It always answers with
 *   { buffer, ok, reason }
 *     buffer  the audio, or null when nothing could be produced at all
 *     ok      true only when buffer is a real Opus/OGG voice note
 *     reason  why, when ok is false
 * When the Opus step fails it still hands back the plain MP3 with ok:false, and
 * the caller sends that as a NORMAL audio file (ptt off). Degrading to "audible
 * but not a voice note" is always better than "sent nothing".
 */

const axios = require('axios')
const { spawn } = require('child_process')
const { toOpusOgg } = require('./ytdl.js')

/*
 * The endpoint is hard-limited to roughly 200 characters per request and answers
 * HTTP 400 past that. The caller caps its own input too; this is the backstop so
 * an over-long string can never reach the network.
 */
const MAX_CHARS = 200

/*
 * translate_tts always replies 24 kHz mono MP3 (measured above). The pitch shift
 * has to be computed from that number: asetrate changes the playback rate, then
 * atempo puts the duration back, which lowers the pitch without slowing the
 * speech down.
 */
const SOURCE_RATE = 24000
const MALE_PITCH = 0.86

const TIMEOUT_MS = 20000
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const ENDPOINT = 'https://translate.google.com/translate_tts'

const DEFAULT_VOICE = 'en'

/*
 * Languages the endpoint actually speaks. Region forms are separate entries
 * rather than a suffix rule, so `en-gb` is a real voice and not `en` with
 * something ignored - resolveVoice tries the longest match first.
 */
const LANGUAGES = {
    en: 'en', 'en-us': 'en-us', 'en-gb': 'en-gb', 'en-au': 'en-au', 'en-in': 'en-in',
    sw: 'sw', fr: 'fr', es: 'es', de: 'de', it: 'it', pt: 'pt', nl: 'nl', pl: 'pl',
    ru: 'ru', uk: 'uk', tr: 'tr', ar: 'ar', fa: 'fa', hi: 'hi', ur: 'ur', bn: 'bn',
    ta: 'ta', te: 'te', mr: 'mr', ne: 'ne', si: 'si', id: 'id', ms: 'ms', fil: 'fil',
    tl: 'tl', vi: 'vi', th: 'th', ja: 'ja', ko: 'ko', zh: 'zh-CN', 'zh-cn': 'zh-CN',
    'zh-tw': 'zh-TW', he: 'iw', am: 'am', ha: 'ha', yo: 'yo', ig: 'ig', zu: 'zu',
    af: 'af', so: 'so', el: 'el', cs: 'cs', sv: 'sv', da: 'da', fi: 'fi', no: 'no',
    hu: 'hu', ro: 'ro', bg: 'bg', hr: 'hr', sk: 'sk', ca: 'ca', is: 'is', lv: 'lv',
    lt: 'lt', et: 'et', sr: 'sr', sl: 'sl', mk: 'mk', sq: 'sq', hy: 'hy', ka: 'ka',
    az: 'az', kk: 'kk', uz: 'uz', mn: 'mn', km: 'km', lo: 'lo', my: 'my', gl: 'gl',
    cy: 'cy', ga: 'ga', mt: 'mt', eu: 'eu', jw: 'jw', su: 'su', ceb: 'ceb', ny: 'ny'
}

const MALE_WORDS = new Set(['male', 'm', 'man', 'boy', 'deep'])
const FEMALE_WORDS = new Set(['female', 'f', 'woman', 'girl', 'normal', 'default'])

/* ------------------------------- the voice ------------------------------- */

/*
 * Accepts every shape an operator is likely to type, because a voice name is
 * configuration and configuration gets typed by hand:
 *   'en'  'sw'  'en-gb'  'male'  'en-male'  'male-en'  'en-gb-male'  'MALE'
 * An unknown language falls back to English and says so in the result, rather
 * than failing a request over a spelling mistake in config.
 */
function resolveVoice(spec) {
    const requested = String(spec === undefined || spec === null || spec === '' ? DEFAULT_VOICE : spec).toLowerCase().trim()
    const parts = requested.split(/[-_\s]+/).filter(Boolean)

    let gender = null
    const words = []
    for (const part of parts) {
        if (MALE_WORDS.has(part)) { gender = 'male'; continue }
        if (FEMALE_WORDS.has(part)) { gender = 'female'; continue }
        words.push(part)
    }

    let lang = null
    for (let size = words.length; size >= 1 && !lang; size--) {
        const candidate = words.slice(0, size).join('-')
        if (LANGUAGES[candidate]) lang = LANGUAGES[candidate]
    }

    /*
     * A bare two-letter code that is not in the table is passed through: the
     * endpoint supports more languages than are worth listing, and refusing one
     * we merely did not enumerate would be worse than trying it.
     */
    let unknown = false
    if (!lang && words.length) {
        if (/^[a-z]{2}$/.test(words[0])) lang = words[0]
        else { lang = LANGUAGES[DEFAULT_VOICE]; unknown = true }
    }
    if (!lang) lang = LANGUAGES[DEFAULT_VOICE]

    return {
        requested,
        lang,
        gender: gender || 'female',
        pitch: gender === 'male' ? MALE_PITCH : 1,
        unknown
    }
}

/* ------------------------------- transport ------------------------------- */

async function fetchSpeech(text, lang) {
    const url = `${ENDPOINT}?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(lang)}`
        + `&total=1&idx=0&textlen=${text.length}&q=${encodeURIComponent(text)}`
    try {
        const response = await axios.get(url, {
            timeout: TIMEOUT_MS,
            responseType: 'arraybuffer',
            headers: { 'User-Agent': USER_AGENT, Accept: 'audio/mpeg,*/*' },
            validateStatus: () => true
        })
        if (response.status < 200 || response.status >= 300) {
            return { ok: false, reason: `HTTP ${response.status}` }
        }
        const buffer = Buffer.from(response.data || [])
        if (!buffer.length) return { ok: false, reason: 'empty response' }
        /*
         * A 200 that is not audio is the failure mode that hides best: the
         * endpoint answers with HTML when it is unhappy, and sending those bytes
         * as an audio message produces a silent, unplayable note.
         */
        const type = String(response.headers?.['content-type'] || '')
        if (!/audio|mpeg|ogg/i.test(type)) {
            return { ok: false, reason: `unexpected content-type ${type || '(none)'}` }
        }
        return { ok: true, buffer }
    } catch (error) {
        const timedOut = error?.code === 'ECONNABORTED' || /timeout/i.test(String(error?.message || ''))
        return { ok: false, reason: timedOut ? `no reply within ${TIMEOUT_MS}ms` : (error?.message || 'network error') }
    }
}

/* ------------------------------- the pitch ------------------------------- */

/*
 * Lower the pitch, keep the length. asetrate slows the audio (and drops the
 * pitch with it), atempo speeds it back up without touching the pitch again.
 * Never throws: on any ffmpeg problem the unmodified MP3 is returned, so a male
 * voice degrades to a normal voice instead of to nothing.
 */
async function deepen(buffer, pitch) {
    let bin
    try { bin = require('ffmpeg-static') } catch { return { ok: false, buffer, reason: 'ffmpeg-static is unavailable' } }

    const rate = Math.round(SOURCE_RATE * pitch)
    const tempo = (1 / pitch).toFixed(6)
    const filter = `asetrate=${rate},aresample=48000,atempo=${tempo}`

    try {
        const shifted = await new Promise((resolve, reject) => {
            const ff = spawn(bin, [
                '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
                '-vn', '-map_metadata', '-1', '-af', filter,
                '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3', 'pipe:1'
            ], { stdio: ['pipe', 'pipe', 'pipe'] })
            const out = [], err = []
            ff.stdout.on('data', d => out.push(d))
            ff.stderr.on('data', d => err.push(d))
            ff.on('error', reject)
            ff.on('close', code => {
                if (code === 0 && out.length) return resolve(Buffer.concat(out))
                reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().slice(0, 160)}`))
            })
            ff.stdin.on('error', () => { })
            ff.stdin.end(buffer)
        })
        return { ok: true, buffer: shifted }
    } catch (error) {
        console.error('[TTS] pitch shift failed, using the unmodified voice:', error?.message || error)
        return { ok: false, buffer, reason: error?.message || String(error) }
    }
}

/* ------------------------------- the public bit ------------------------------- */

/**
 * Turn text into a WhatsApp voice note.
 *
 * @param {string} text            what to say (capped at MAX_CHARS)
 * @param {{voice?: string}} opts  voice spec — see resolveVoice
 * @returns {Promise<{buffer: Buffer|null, ok: boolean, reason: string, voice?: object, mimetype?: string}>}
 */
async function synthesize(text, { voice } = {}) {
    const speech = String(text === undefined || text === null ? '' : text).trim()
    if (!speech) return { buffer: null, ok: false, reason: 'nothing to say' }

    const resolved = resolveVoice(voice)
    const spoken = speech.length > MAX_CHARS ? speech.slice(0, MAX_CHARS) : speech
    if (spoken !== speech) {
        console.log(`[TTS] text trimmed from ${speech.length} to ${MAX_CHARS} characters`)
    }

    const fetched = await fetchSpeech(spoken, resolved.lang)
    if (!fetched.ok) return { buffer: null, ok: false, reason: fetched.reason, voice: resolved }

    /*
     * The endpoint applies its own 64 kb/s mono treatment, so this is already a
     * normal audio file. It is only converted to a voice note when the caller
     * asked for a pitch that is not the default.
     */
    let audio = fetched.buffer
    let pitchFailed = ''
    if (resolved.pitch !== 1) {
        const shifted = await deepen(audio, resolved.pitch)
        audio = shifted.buffer
        if (!shifted.ok) pitchFailed = `pitch shift unavailable (${shifted.reason})`
    }

    const converted = await toOpusOgg(audio, { bitrate: 48000, channels: 1 })
    if (converted?.status && converted.buffer && converted.opus) {
        return {
            buffer: converted.buffer,
            ok: true,
            reason: '',
            voice: resolved,
            mimetype: 'audio/ogg; codecs=opus'
        }
    }

    /*
     * No Opus container, but there IS audio: hand back the MP3 and let the caller
     * send it as a normal audio file. Both reasons are reported so the log says
     * whether the pitch shift or the transcode was the part that failed.
     */
    const reason = [pitchFailed, converted?.error || 'opus transcode failed'].filter(Boolean).join('; ')
    return {
        buffer: audio,
        ok: false,
        reason,
        voice: resolved,
        mimetype: 'audio/mpeg'
    }
}

/** The voice spec a given text would use, without synthesising anything. */
function describeVoice(spec) {
    const resolved = resolveVoice(spec)
    return `${resolved.lang}${resolved.gender === 'male' ? ' (male, pitch ' + resolved.pitch + ')' : ''}`
}

module.exports = { synthesize, resolveVoice, describeVoice, LANGUAGES, MAX_CHARS, DEFAULT_VOICE }
