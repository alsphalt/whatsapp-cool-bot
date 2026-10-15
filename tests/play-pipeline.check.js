'use strict'
/*
 * Mirrors the .play pipeline (WHOLE song embedded, no clip) and measures the
 * real card size. Sends nothing.
 *   node tests/play-pipeline.check.js "song name"
 */
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const ytSearch = require('yt-search')
const ytdl = require('../lib/ytdl.js')

/* Must match the constants in BIGBRO.js's .play case. */
const EMBED_QUALITY_BPS = 32000      // a CAP on quality, never a reason to trim
const CARD_BUDGET_KB = 240
const CARD_OVERHEAD_KB = 62
const MIN_AUDIO_BPS = 2800
const MAX_AUDIO_BPS = 96000
const CBR_OVERSHOOT = 1.12

const audioBinaryBytes = () => Math.floor(Math.max(8 * 1024, (CARD_BUDGET_KB - CARD_OVERHEAD_KB) * 1024) * 3 / 4)

const bitrateForDuration = (seconds) => {
    const bps = Math.floor((audioBinaryBytes() * 8) / (Math.max(1, seconds) * CBR_OVERSHOOT))
    return Math.min(MAX_AUDIO_BPS, Math.max(MIN_AUDIO_BPS, bps))
}

const secondsAtBitrate = (bps) => Math.floor((audioBinaryBytes() * 8) / (Math.max(1, bps) * CBR_OVERSHOOT))

/* A full length tone, so the whole-song card can be measured with no network. */
const tone = (seconds) => new Promise((resolve, reject) => {
    const bin = require('ffmpeg-static')
    const ff = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
        '-i', `sine=frequency=440:sample_rate=44100:duration=${seconds}`,
        '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', 'pipe:1'],
        { stdio: ['ignore', 'pipe', 'pipe'] })
    const out = [], err = []
    ff.stdout.on('data', d => out.push(d))
    ff.stderr.on('data', d => err.push(d))
    ff.on('error', reject)
    ff.on('close', c => c === 0 && out.length ? resolve(Buffer.concat(out))
        : reject(new Error('tone exit ' + c + ' ' + Buffer.concat(err).toString().slice(0, 120))))
})

const encodeAudio = (input, bitrate, limitSeconds = 0) => new Promise((resolve, reject) => {
    let bin
    try { bin = require('ffmpeg-static') } catch { return reject(new Error('ffmpeg-static unavailable')) }
    const trim = limitSeconds > 0 ? ['-t', String(Math.floor(limitSeconds))] : []
    const ff = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
        ...trim,
        '-map', '0:a:0', '-vn', '-map_metadata', '-1',
        '-ac', '1', '-ar', '48000',
        '-c:a', 'libopus', '-b:a', String(bitrate), '-vbr', 'off', '-frame_duration', '60', '-f', 'ogg', 'pipe:1'],
        { stdio: ['pipe', 'pipe', 'pipe'] })
    const out = [], err = []
    ff.stdout.on('data', d => out.push(d))
    ff.stderr.on('data', d => err.push(d))
    ff.on('error', reject)
    ff.on('close', c => c === 0 && out.length ? resolve(Buffer.concat(out))
        : reject(new Error('ffmpeg exit ' + c + ' ' + Buffer.concat(err).toString().slice(0, 160))))
    ff.stdin.on('error', () => { })
    ff.stdin.end(input)
})

const safe = (s = '') => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;')

const QUERY = process.argv[2] || 'blinding lights'
/*
 * --tone skips the downloaders entirely and encodes a full length tone instead.
 * The providers are rate limited and answer a "still preparing" page when they
 * are, which says nothing about whether the card can hold a whole song - and the
 * whole song is the thing being measured here.
 */
const FORCE_TONE = process.argv.includes('--tone')

;(async () => {
    const t0 = Date.now()
    const src = fs.readFileSync(path.join(__dirname, '..', 'BIGBRO.js'), 'utf8')
    const tpl = src.match(/const htmlPayload = `([\s\S]*?)`;/)[1]

    console.log('1. ytSearch("' + QUERY + '")')
    const search = await ytSearch(QUERY)
    const video = (search?.videos || [])[0]
    if (!video?.url) throw new Error('no search result')
    const SONG = {
        title: String(video.title || QUERY).slice(0, 90),
        artist: String(video.author?.name || 'YouTube'),
        duration: String(video.timestamp || ''),
        bpm: 171,
        thumbUrl: String(video.thumbnail || ''),
        lyrics: []
    }
    const seconds = Number(video.seconds) || 0
    console.log('   ->', SONG.title, '|', SONG.artist, '|', SONG.duration, '=' + seconds + 's')

    /*
     * THE SAME CHAIN .play RUNS: the YouTube URL first, then the by-name
     * resolver, and only if neither answers a local tone of the same length -
     * so this mirror always finishes and always measures a FULL LENGTH card,
     * instead of reporting the provider's mood.
     */
    console.log('2. audio: ytdlAutoBuffer -> ytdlSongBuffer -> local tone')
    let audio = null, from = ''
    if (FORCE_TONE) {
        console.log('   (--tone: skipping the network sources so the FULL LENGTH path is what gets measured)')
    } else {
        try { const r = await ytdl.ytdlAutoBuffer(video.url, 'audio'); if (r?.status && Buffer.isBuffer(r.buffer)) { audio = r; from = 'ytdlAutoBuffer (YouTube URL)' } } catch { }
        if (!audio) {
            const byName = await ytdl.ytdlSongBuffer({ title: video.title, artist: video.author?.name, seconds })
            if (byName?.status && Buffer.isBuffer(byName.buffer)) {
                audio = byName
                from = 'ytdlSongBuffer (' + byName.source + ', preview=' + Boolean(byName.preview) + ')'
            }
        }
    }
    if (!audio) {
        audio = { status: true, buffer: await tone(seconds || 204), mimetype: 'audio/mpeg' }
        from = 'local tone (no network source answered)'
    }
    // The AUDIO's length wins, exactly as in BIGBRO.js: a SoundCloud upload or a
    // preview can differ from the video's runtime, and sizing from the video
    // would then overshoot the card budget.
    const songSeconds = Number(audio.duration) || seconds
    console.log('   -> ' + from + ' | ' + (audio.buffer.length / 1024 / 1024).toFixed(2) + ' MB, ' +
        (audio.mimetype || '?') + ', ' + songSeconds + 's')

    const bps = Math.min(EMBED_QUALITY_BPS, bitrateForDuration(songSeconds))
    const ceiling = Math.ceil(secondsAtBitrate(bps))
    const whole = ceiling >= songSeconds
    console.log('3. encode ' + (whole ? 'WHOLE song' : 'opening ' + ceiling + 's (the only trim case)') +
        ' @ ' + Math.round(bps / 1000) + ' kbps opus, auto-sized to the budget')
    const enc = await encodeAudio(audio.buffer, bps, whole ? 0 : ceiling)
    const audioB64 = enc.toString('base64')
    console.log('   -> ogg ' + (enc.length / 1024).toFixed(0) + ' KB | base64 ' + (audioB64.length / 1024).toFixed(0) + ' KB' +
        ' | whole song embedded: ' + whole)

    console.log('4. inline thumbnail')
    const sharp = require('sharp')
    const res = await fetch(SONG.thumbUrl)
    const jpeg = await sharp(Buffer.from(await res.arrayBuffer())).resize(480, 270, { fit: 'cover' }).jpeg({ quality: 58 }).toBuffer()
    const thumbData = 'data:image/jpeg;base64,' + jpeg.toString('base64')
    console.log('   -> jpeg ' + (jpeg.length / 1024).toFixed(0) + ' KB | base64 ' + (thumbData.length / 1024).toFixed(0) + ' KB')

    console.log('5. build the REAL card and measure it')
    const heroStyle = `background-image:url('${thumbData}');background-size:cover;background-position:center;`
    const html = new Function('SONG', 'safe', 'heroStyle', 'badgeLabel', 'hasTimedLyrics',
        'lyricsJson', 'encodedBase64', 'totalSeconds', 'sourceLabel',
        'return `' + tpl + '`')(
        SONG, safe, heroStyle, SONG.duration || 'YouTube', false,
        '[]', audioB64, songSeconds, whole ? 'Full song · in-card' : `First ${ceiling}s · in-card`)
    const bytes = Buffer.byteLength(html)
    console.log('   -> CARD: ' + (bytes / 1024).toFixed(0) + ' KB  (documented ceiling ~256 KB) -> ' +
        (bytes < 262144 ? 'FITS' : 'OVER by ' + ((bytes - 262144) / 1024).toFixed(0) + ' KB'))
    const leftovers = [...html.matchAll(/\$\{[^}]*\}/g)].map(x => x[0])
    const urls = [...new Set(html.match(/https?:\/\/[^"'\s)]+/g) || [])]
    console.log('   -> unresolved placeholders:', leftovers.join(' ') || 'NONE')
    console.log('   -> network URLs:', urls.join(' ') || 'NONE')
    console.log('   -> whole song embedded:', html.includes('var AUDIO_B64   = "' + audioB64.slice(0, 20)))
    console.log('   -> decodes via Web Audio:', html.includes('decodeAudioData'))
    console.log('   -> no <audio> tag / no remote src:', !html.includes('<audio') )

    console.log('\nPIPELINE OK in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's')
})().catch(e => { console.error('PIPELINE FAILED:', e.message); process.exit(1) })
