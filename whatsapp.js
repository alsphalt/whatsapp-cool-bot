'use strict'

/*
 * DARKNOTE WhatsApp Shazam compatibility module.
 *
 * This is the supplied Shazam implementation adapted only from ESM to the
 * project's existing CommonJS runtime. Existing Shazam command/settings stay
 * untouched; the exported identifyBuffer() helper lets lib/shazam.js use the
 * same ACRCloud identification settings without replacing its result cards,
 * YouTube search, or download settings.
 */

const fs = require('fs')

const ACR_HOST = 'identify-ap-southeast-1.acrcloud.com'
const ACR_ACCESS_KEY = '26afd4eec96b0f5e5ab16a7e6e05ab37'
const ACR_ACCESS_SECRET = 'wXOZIqdMNZmaHJP1YDWVyeQLg579uK2CfY6hWMN8'

function createAcrClient() {
    const acrcloud = require('acrcloud')
    const Ctor = acrcloud?.default || acrcloud
    return new Ctor({
        host: ACR_HOST,
        access_key: ACR_ACCESS_KEY,
        access_secret: ACR_ACCESS_SECRET
    })
}

/** Identify a media buffer using the exact ACRCloud settings supplied. */
async function identifyBuffer(buffer) {
    const acr = createAcrClient()
    return acr.identify(buffer)
}

const shazam = async (client, m, q, mime, qmsg) => {
    const acr = createAcrClient()

    if (!/video|audio/.test(String(mime || ''))) {
        return m.reply('Tag a video or audio for the bot to analyse.')
    }

    const p = m.quoted ? m.quoted : m
    const buffer = await p.download()
    await m.reply('A moment. . .')

    const { status, metadata } = await acr.identify(buffer)
    if (status.code !== 0) return m.reply(status.msg)

    const { title, artists, album, genres, release_date } = metadata.music[0]
    let txt = `Title: ${title}${artists ? `\nArtists: ${artists.map(v => v.name).join(', ')}` : ''}`
    txt += `${album ? `\nAlbum: ${album.name}` : ''}${genres ? `\nGenres: ${genres.map(v => v.name).join(', ')}` : ''}\n`
    txt += `Release Date: ${release_date}`
    await m.reply(txt.trim())

    const ytSearch = require('yt-search')
    const yts = typeof ytSearch === 'function' ? ytSearch : ytSearch?.default
    if (typeof yts !== 'function') throw new Error('yt-search is unavailable')
    const { videos } = await yts(txt.trim())
    if (!videos || videos.length <= 0) return m.reply('Not found')

    const urlYt = videos[0].url
    const ytdl = require('ytdl-core')
    const infoYt = await ytdl.getInfo(urlYt)
    const getRandonm = (ext) => `${Math.floor(Math.random() * 10000)}${ext}`

    const titleYt = infoYt.videoDetails.title
    const randomName = getRandonm('.mp3')
    const stream = ytdl(urlYt, {
        filter: (info) => info.audioBitrate == 160 || info.audioBitrate == 128,
    }).pipe(fs.createWriteStream(`./${randomName}`))

    await new Promise((resolve, reject) => {
        stream.on('error', reject)
        stream.on('finish', resolve)
    })

    try {
        await client.sendMessage(
            m.chat,
            {
                document: fs.readFileSync(`./${randomName}`),
                mimetype: 'audio/mpeg',
                fileName: titleYt + '.mp3',
            },
            { quoted: m }
        )
    } finally {
        try { await fs.promises.rm(`./${randomName}`, { force: true }) } catch {}
    }
}

module.exports = {
    shazam,
    identifyBuffer,
    createAcrClient
}
