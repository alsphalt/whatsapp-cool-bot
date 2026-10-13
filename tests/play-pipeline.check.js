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
const { ytdlAutoBuffer } = require('../lib/ytdl.js')

/* Must match the constants in BIGBRO.js's .play case. */
const CARD_BUDGET_KB = 240
const CARD_OVERHEAD_KB = 62
const MIN_AUDIO_BPS = 2800
const MAX_AUDIO_BPS = 96000
const CBR_OVERSHOOT = 1.12

const bitrateForDuration = (seconds) => {
    const audioB64Bytes = Math.max(8 * 1024, (CARD_BUDGET_KB - CARD_OVERHEAD_KB) * 1024)
    const binaryBytes = Math.floor(audioB64Bytes * 3 / 4)
    const bps = Math.floor((binaryBytes * 8) / (Math.max(1, seconds) * CBR_OVERSHOOT))
    return Math.min(MAX_AUDIO_BPS, Math.max(MIN_AUDIO_BPS, bps))
}

const encodeAudio = (input, bitrate) => new Promise((resolve, reject) => {
    let bin
    try { bin = require('ffmpeg-static') } catch { return reject(new Error('ffmpeg-static unavailable')) }
    const ff = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
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

    console.log('2. ytdlAutoBuffer (same API .song uses)')
    const audio = await ytdlAutoBuffer(video.url, 'audio')
    if (!audio?.status || !Buffer.isBuffer(audio.buffer)) throw new Error('audio failed: ' + (audio?.error || 'no buffer'))
    console.log('   -> ' + (audio.buffer.length / 1024 / 1024).toFixed(2) + ' MB, ' + (audio.mimetype || '?'))

    const bps = bitrateForDuration(seconds)
    console.log('3. encode WHOLE song @ ' + Math.round(bps / 1000) + ' kbps opus (auto-sized to the budget)')
    const enc = await encodeAudio(audio.buffer, bps)
    const audioB64 = enc.toString('base64')
    console.log('   -> ogg ' + (enc.length / 1024).toFixed(0) + ' KB | base64 ' + (audioB64.length / 1024).toFixed(0) + ' KB')

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
        '[]', audioB64, seconds, 'Full song · in-card')
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
