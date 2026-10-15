'use strict'
/*
 * How long can a song be and still fit ONE card?
 *
 * The .play pipeline needs no network for the part that decides this: ffmpeg can
 * generate the source itself. This check synthesises audio of a given length,
 * encodes it exactly like .play does, builds the REAL card template and measures
 * it, so the duration ceiling can be found without a YouTube download.
 *
 *   node tests/play-size.check.js             -> 240s 300s 330s 420s
 *   node tests/play-size.check.js 300         -> just 300s
 */
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const sharp = require('sharp')

/* Must match the constants in BIGBRO.js's .play case. */
const EMBED_QUALITY_BPS = 32000
const CARD_BUDGET_KB = 240
const CARD_OVERHEAD_KB = 62
const MIN_AUDIO_BPS = 2800
const MAX_AUDIO_BPS = 96000
const CBR_OVERSHOOT = 1.12
const CARD_CEILING_KB = 256
/* Measured non-audio cost of the card: ~18 KB markup + ~10 KB inlined thumbnail. */
const CARD_FIXED_KB = 30

/* Audio bytes the card can carry once base64 inflates them by 4/3. */
const audioBinaryBytes = () => Math.floor(
    Math.max(8 * 1024, (CARD_BUDGET_KB - CARD_OVERHEAD_KB) * 1024) * 3 / 4)

const bitrateForDuration = (seconds) => {
    const bps = Math.floor((audioBinaryBytes() * 8) / (Math.max(1, seconds) * CBR_OVERSHOOT))
    return Math.min(MAX_AUDIO_BPS, Math.max(MIN_AUDIO_BPS, bps))
}

const secondsAtBitrate = (bps) => Math.floor(
    (audioBinaryBytes() * 8) / (Math.max(1, bps) * CBR_OVERSHOOT))

const ffmpegBin = () => require('ffmpeg-static')

/* Synthesise `seconds` of noise and encode it to mono Opus in one pass.
   White noise is used because it is the least compressible thing we can feed
   the encoder, so the size it reports is a pessimistic (safe) bound. */
const encodeLength = (seconds, bitrate) => new Promise((resolve, reject) => {
    const ff = spawn(ffmpegBin(), ['-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `anoisesrc=color=white:duration=${seconds}:sample_rate=48000`,
        '-ac', '1', '-ar', '48000', '-map_metadata', '-1',
        '-c:a', 'libopus', '-b:a', String(bitrate), '-vbr', 'off', '-frame_duration', '60',
        '-f', 'ogg', 'pipe:1'],
        { stdio: ['ignore', 'pipe', 'pipe'] })
    const out = [], err = []
    ff.stdout.on('data', d => out.push(d))
    ff.stderr.on('data', d => err.push(d))
    ff.on('error', reject)
    ff.on('close', c => c === 0 && out.length ? resolve(Buffer.concat(out))
        : reject(new Error('ffmpeg exit ' + c + ' ' + Buffer.concat(err).toString().slice(0, 160))))
})

const safe = (s = '') => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;')

const arg = process.argv[2]
const LENGTHS = arg ? [Number(arg)] : [240, 300, 348, 420, 442]

;(async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'BIGBRO.js'), 'utf8')
    const tpl = src.match(/const htmlPayload = `([\s\S]*?)`;/)[1]

    /* Thumbnail, exactly as .play builds it (480x270 q58). */
    let thumbData = ''
    try {
        const res = await fetch('https://i.ytimg.com/vi/4NRXx6U8ABQ/hqdefault.jpg')
        const jpeg = await sharp(Buffer.from(await res.arrayBuffer()))
            .resize(480, 270, { fit: 'cover' }).jpeg({ quality: 58 }).toBuffer()
        thumbData = 'data:image/jpeg;base64,' + jpeg.toString('base64')
        console.log('thumbnail: ' + (jpeg.length / 1024).toFixed(1) + ' KB jpeg | ' +
            (thumbData.length / 1024).toFixed(1) + ' KB base64')
    } catch (e) {
        console.log('thumbnail: UNAVAILABLE (' + e.message + ') - markup measured without it')
    }

    const SONG = {
        title: 'Size Probe (synthesised)', artist: 'test', duration: '?',
        bpm: 171, thumbUrl: '', lyrics: []
    }
    const heroStyle = thumbData
        ? `background-image:url('${thumbData}');background-size:cover;background-position:center;`
        : 'background:linear-gradient(135deg,#1db954,#0b3d20 55%,#05050a);'

    /* A song only fits whole while bitrateForDuration() is at or above the floor. */
    const wholeSongLimit = () => {
        let seconds = 1
        while (seconds < 4000 && bitrateForDuration(seconds + 1) >= EMBED_QUALITY_BPS) seconds++
        return seconds
    }

    console.log('\nthe card holds ' + secondsAtBitrate(EMBED_QUALITY_BPS) + 's at the ' +
        Math.round(EMBED_QUALITY_BPS / 1000) + ' kbps clarity floor, and carries a song whole')
    console.log('up to ' + wholeSongLimit() + 's at that rate or better')
    console.log('\n   song   embed  reqbps  oggKB  achkbps  cardKB  verdict')
    console.log('   ' + '-'.repeat(58))
    for (const seconds of LENGTHS) {
        /* Mirrors .play: hold the floor, then take however many seconds fit there. */
        const bps = Math.max(EMBED_QUALITY_BPS, bitrateForDuration(seconds))
        const cardSeconds = Math.min(seconds, secondsAtBitrate(bps))
        const enc = await encodeLength(cardSeconds, bps)
        const b64 = enc.toString('base64')
        const label = cardSeconds >= seconds ? 'Full song · in-card' : 'First ' + cardSeconds + 's · in-card'
        const html = new Function('SONG', 'safe', 'heroStyle', 'badgeLabel', 'hasTimedLyrics',
            'lyricsJson', 'encodedBase64', 'totalSeconds', 'sourceLabel',
            'return `' + tpl + '`')(
            SONG, safe, heroStyle, '?', false, '[]', b64, cardSeconds, label)
        const cardKB = Buffer.byteLength(html) / 1024
        const kbps = (enc.length * 8 / cardSeconds / 1000).toFixed(2)
        console.log('   ' + String(seconds).padEnd(7) + String(cardSeconds).padEnd(7) +
            String(bps).padEnd(8) + String((enc.length / 1024).toFixed(0)).padEnd(7) +
            String(kbps).padEnd(9) + cardKB.toFixed(0).padEnd(8) +
            (cardKB < CARD_CEILING_KB ? 'FITS' : 'OVER by ' + (cardKB - CARD_CEILING_KB).toFixed(0) + ' KB'))
    }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
