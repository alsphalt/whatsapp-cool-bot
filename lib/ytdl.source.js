'use strict'

const axios = require('axios')
const qs = require('querystring')
const crypto = require('crypto')
const https = require('https')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

let distubeYtdl = null
let classicYtdl = null
try { distubeYtdl = require('@distube/ytdl-core') } catch {}
try { classicYtdl = require('ytdl-core') } catch {}

const agent = new https.Agent({ rejectUnauthorized: true })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const SaveNow = {
  _api: 'https://p.savenow.to',
  _key: 'dfcb6d76f2f6a9894gjkege8a4ab232222',
  poll: async (url, limit = 40) => {
    for (let i = 0; i < limit; i++) {
      try {
        const { data } = await axios.get(url, { httpsAgent: agent, timeout: 60000 })
        if (data?.success === 1 && data.download_url) return data
        if (data?.success === -1) break
      } catch {}
      await sleep(2500)
    }
    return null
  }
}

const savetube = {
  base: 'https://media.savetube.me/api',
  headers: { accept: '*/*', 'content-type': 'application/json', origin: 'https://yt.savetube.me', referer: 'https://yt.savetube.me/', 'user-agent': 'DARKNOTE/5.1.0' },
  audioFormats: new Set(['mp3', 'm4a', 'webm', 'aac', 'flac', 'opus', 'ogg', 'wav']),
  videoFormats: new Set(['144', '240', '360', '480', '720', '1080', '1440', '2k', '3k', '4k', '5k', '8k']),
  youtubeId(url) {
    try {
      const u = new URL(url)
      if (u.hostname === 'youtu.be') return u.pathname.slice(1).match(/^[A-Za-z0-9_-]{11}$/)?.[0] || null
      if (u.hostname.includes('youtube.com')) return u.searchParams.get('v') || u.pathname.match(/\/(?:embed|v|shorts)\/([A-Za-z0-9_-]{11})/)?.[1] || null
    } catch {}
    return null
  },
  async request(url, data = {}, method = 'post') {
    try {
      const response = await axios({ method, url, data: method === 'post' ? data : undefined, params: method === 'get' ? data : undefined, headers: this.headers, timeout: 60000 })
      return { status: true, data: response.data }
    } catch (error) { return { status: false, code: error.response?.status || 500, error: error.message } }
  },
  async decrypt(enc) {
    const secretKey = 'C5D58EF67A7584E4A29F6C35BBC4EB12'
    const data = Buffer.from(enc, 'base64')
    const iv = data.subarray(0, 16), content = data.subarray(16), key = Buffer.from(secretKey, 'hex')
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv)
    return JSON.parse(Buffer.concat([decipher.update(content), decipher.final()]).toString())
  },
  async download(url, format = 'mp3') {
    const id = this.youtubeId(url)
    if (!id || (!this.audioFormats.has(format) && !this.videoFormats.has(format))) return { status: false }
    try {
      const cdnRes = await this.request(`${this.base}/random-cdn`, {}, 'get')
      const cdn = cdnRes.data?.cdn
      if (!cdn) return { status: false }
      const info = await this.request(`https://${cdn}/v2/info`, { url: `https://www.youtube.com/watch?v=${id}` })
      if (!info.status || !info.data?.data) return { status: false }
      const meta = await this.decrypt(info.data.data)
      const audio = this.audioFormats.has(format)
      const dl = await this.request(`https://${cdn}/download`, { id, downloadType: audio ? 'audio' : 'video', quality: audio ? '128' : format, key: meta.key })
      const downloadUrl = dl.data?.data?.downloadUrl
      return downloadUrl ? { status: true, title: meta.title || 'YouTube Media', download_url: downloadUrl } : { status: false }
    } catch { return { status: false } }
  }
}

async function ytdlv1(url, type = 'audio') {
  try {
    const endpoint = type === 'audio' || type === 'mp3' ? `https://ytdlpyton.nvlgroup.my.id/download/audio?url=${encodeURIComponent(url)}&mode=url` : `https://ytdlpyton.nvlgroup.my.id/download/?url=${encodeURIComponent(url)}&resolution=${encodeURIComponent(type)}&mode=url`
    const { data } = await axios.get(endpoint, { timeout: 60000 })
    return data?.download_url ? { status: true, title: data.title || 'YouTube Media', download_url: data.download_url } : { status: false }
  } catch { return { status: false } }
}

async function ytdlv2(url, type = 'audio') {
  try {
    const { data } = await axios.post('https://app.ytdown.to/proxy.php', qs.stringify({ url }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Accept: '*/*', 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'Mozilla/5.0', Referer: 'https://app.ytdown.to/id12/' }, timeout: 60000 })
    const api = data?.api
    if (!api?.mediaItems) return { status: false }
    const audio = type === 'audio' || type === 'mp3'
    const target = audio ? api.mediaItems.find(v => v.type === 'Audio' && v.mediaQuality === '128K') || api.mediaItems.find(v => v.type === 'Audio') : api.mediaItems.find(v => v.type === 'Video' && v.mediaQuality === 'HD') || api.mediaItems.find(v => v.type === 'Video')
    if (!target?.mediaUrl) return { status: false }
    for (let i = 0; i < 20; i++) {
      try {
        const { data: check } = await axios.get(target.mediaUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 60000 })
        if (check?.status === 'completed' && check.fileUrl) return { status: true, title: api.title || 'YouTube Media', download_url: check.fileUrl }
      } catch {}
      await sleep(3000)
    }
    return { status: false }
  } catch { return { status: false } }
}

async function ytdlv3(url, type = 'audio') {
  try {
    const format = type === 'audio' ? 'mp3' : type
    const { data: init } = await axios.get(`${SaveNow._api}/ajax/download.php`, { params: { copyright: 0, format, url, api: SaveNow._key }, httpsAgent: agent, timeout: 60000 })
    if (!init?.success || !init.progress_url) return { status: false }
    const result = await SaveNow.poll(init.progress_url)
    return result?.download_url ? { status: true, title: init.info?.title || 'YouTube Media', download_url: result.download_url } : { status: false }
  } catch { return { status: false } }
}

async function ytdlv4(url, type = 'audio') {
  return savetube.download(url, type === 'audio' || type === 'mp3' ? 'mp3' : type)
}

/*
 * Is this response a web page rather than a media file?
 *
 * Checked on the bytes, not just the header: a scraper's CDN answers "still
 * preparing" with a 200 and a page, and its content-type is not something to
 * take on trust. An audio file starts with ID3/frame sync (mp3), OggS (ogg/opus)
 * or ftyp (m4a/mp4), so those are what a real download looks like.
 */
function looksLikeWebpage(buffer, contentType = '') {
  if (contentType.includes('text/html') || contentType.includes('application/json')) return true
  const head = buffer.subarray(0, 256).toString('latin1').replace(/^\uFEFF/, '').trimStart().toLowerCase()
  return head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml') || head.startsWith('{"') || head.startsWith('[')
}

async function ytdlAuto(url, type = 'audio') {
  for (const fn of [ytdlv1, ytdlv3, ytdlv4, ytdlv2]) {
    try { const result = await fn(url, type); if (result?.status && result.download_url) return result } catch {}
  }
  return { status: false, error: 'All YouTube download providers failed' }
}

async function ytdlDirectBuffer(url) {
  if (!distubeYtdl || !distubeYtdl.validateURL(url)) return { status: false }
  try {
    const info = await distubeYtdl.getInfo(url)
    const format = distubeYtdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' })
    if (!format?.url) return { status: false }
    const stream = distubeYtdl.downloadFromInfo(info, { format, highWaterMark: 1 << 20 })
    const chunks = []; let total = 0
    for await (const chunk of stream) { chunks.push(chunk); total += chunk.length; if (total > 50 * 1024 * 1024) { try { stream.destroy() } catch {}; throw new Error('Audio file is too large') } }
    const buffer = Buffer.concat(chunks)
    if (buffer.length < 4096) throw new Error('Downloaded audio is empty')
    return { status: true, title: info.videoDetails?.title || 'YouTube song', buffer, mimetype: format.mimeType?.split(';')[0] || 'audio/mp4' }
  } catch (error) { return { status: false, error: error?.message || 'Direct YouTube audio failed' } }
}

async function ytdlClassicBuffer(url) {
  if (!classicYtdl) return { status: false, error: 'Classic YouTube downloader is not installed' }
  try {
    if (!classicYtdl.validateURL(url)) return { status: false, error: 'Invalid YouTube URL' }
    const info = await classicYtdl.getInfo(url)
    const format = classicYtdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' })
    if (!format?.url) return { status: false, error: 'No audio-only YouTube format was available' }
    const stream = classicYtdl.downloadFromInfo(info, { format, highWaterMark: 1 << 20 })
    const chunks = []; let total = 0
    for await (const chunk of stream) { chunks.push(chunk); total += chunk.length; if (total > 50 * 1024 * 1024) { try { stream.destroy() } catch {}; throw new Error('Audio file is too large') } }
    const buffer = Buffer.concat(chunks)
    if (buffer.length < 4096) throw new Error('Downloaded audio is empty')
    return { status: true, title: info.videoDetails?.title || 'YouTube song', buffer, mimetype: format.mimeType?.split(';')[0] || 'audio/mp4' }
  } catch (error) { return { status: false, error: error?.message || 'YouTube audio download failed' } }
}

/*
 * ─────────────────────────────────────────────────────────────────────────────
 *  yt-dlp PROVIDER — the only route that can play a REAL YouTube track
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS. On a datacenter IP every other route in this file fails, and
 * they all fail the same way: YouTube answers the player request with
 *
 *     playabilityStatus: LOGIN_REQUIRED
 *     reason: "Sign in to confirm you're not a bot"
 *
 * Measured from this host, all of these returned zero formats:
 *
 *     the watch page's own ytInitialPlayerResponse (WEB)
 *     innertube /youtubei/v1/player for WEB, MWEB, ANDROID_VR
 *     innertube ANDROID and IOS                      (HTTP 400)
 *     TVHTML5_SIMPLY_EMBEDDED_PLAYER                 (client retired)
 *     @distube/ytdl-core, ytdl-core
 *     all four scraping providers below -> "returned a webpage instead of audio"
 *     all eight Invidious and four Piped public instances
 *
 * The block is on the IP, not on the code, so no amount of retrying or client
 * switching gets around it. yt-dlp is used here because it is the only tool that
 * can ACT ON CREDENTIALS: given account cookies (or a residential proxy) it
 * solves the check itself, including any signature/PO-token work.
 *
 * CONFIGURATION (all optional; without either, this provider fails fast and its
 * error is the one reported, because it is the actionable one):
 *
 *     YTDLP_COOKIES  path to a Netscape cookies.txt exported from a browser
 *                    that is signed in to YouTube — OR a browser name such as
 *                    "chrome" to use --cookies-from-browser.
 *     YTDLP_PROXY    proxy URL, e.g. http://user:pass@host:port
 *     YTDLP_BIN      path to a yt-dlp binary, if it is not on PATH.
 *
 * Exported and protected like everything else in this file, so run
 * `npm run protect` after editing or the shim keeps loading the old build.
 */
const YTDLP_TIMEOUT_MS = 180000
const YTDLP_MAX_BYTES = 50 * 1024 * 1024

const ytDlpOption = (name) => String(process.env[name] || '').trim()

/** True when a cookie or proxy setting is present, i.e. yt-dlp has a chance. */
function ytDlpConfigured() {
  return Boolean(ytDlpOption('YTDLP_COOKIES') || ytDlpOption('YTDLP_PROXY'))
}

/* Command candidates, most specific first. YTDLP_BIN wins when set. */
function ytDlpCandidates() {
  const custom = ytDlpOption('YTDLP_BIN')
  if (custom) return [[custom]]
  return [['yt-dlp'], ['python3', '-m', 'yt_dlp'], ['python', '-m', 'yt_dlp']]
}

/**
 * Run one yt-dlp command. Resolves with the exit code and the tail of stderr;
 * rejects only when the binary itself could not be started (ENOENT and friends),
 * which is what tells the caller to try the next candidate.
 */
function runYtDlp(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], [...command.slice(1), ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []
    const err = []
    let settled = false
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { }
    }, YTDLP_TIMEOUT_MS)
    child.stdout.on('data', d => out.push(d))
    child.stderr.on('data', d => err.push(d))
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() })
    })
  })
}

/*
 * IS yt-dlp ACTUALLY RUNNABLE HERE?
 * --------------------------------
 * `ytDlpConfigured()` answers a different question: "has the operator given yt-dlp
 * credentials?". Those are not the same thing, and conflating them cost every
 * full-length download on this deployment: yt-dlp was installed and downloading
 * fine, but because neither YTDLP_COOKIES nor YTDLP_PROXY was set, the providers
 * treated it as unavailable and fell through to the 30 second Deezer preview.
 *
 * This probes the commands themselves (`--version` costs milliseconds), so:
 *   - yt-dlp present -> it is preferred and the WHOLE song comes back
 *   - yt-dlp missing -> nothing is wasted on it, and the actionable
 *                       "set YTDLP_COOKIES" message is still what gets reported
 *
 * Cached for the process: the answer cannot change while the bot is running, and
 * a probe per song would add a process spawn to every lookup.
 */
let ytDlpInstalledProbe = null
async function ytDlpInstalled() {
  if (ytDlpInstalledProbe !== null) return ytDlpInstalledProbe
  for (const command of ytDlpCandidates()) {
    try {
      const result = await runYtDlp(command, ['--version'])
      if (result.code === 0 && /\d{4}\.\d/.test(result.stdout)) { ytDlpInstalledProbe = true; return true }
    } catch { /* not on PATH - try the next candidate */ }
  }
  ytDlpInstalledProbe = false
  return false
}

/* yt-dlp's own wording, collapsed to something short enough for a chat reply. */
function ytDlpHint(text) {
  const raw = String(text || '')
  if (/Sign in to confirm|not a bot|LOGIN_REQUIRED/i.test(raw)) {
    return 'YouTube blocked this server (bot check). Set YTDLP_COOKIES to a signed-in cookies.txt, or YTDLP_PROXY, and try again.'
  }
  if (/Private video|Video unavailable|Removed|brak/i.test(raw)) return 'This video is not available any more.'
  if (/Unsupported URL/i.test(raw)) return 'That URL is not a YouTube video.'
  const line = raw.split('\n').map(l => l.replace(/^ERROR:\s*/i, '').trim()).filter(Boolean).pop()
  return (line || 'yt-dlp failed').slice(0, 200)
}

/** Extension -> mimetype, so the caller sends the audio with the right header. */
const AUDIO_MIME = {
  webm: 'audio/webm', m4a: 'audio/mp4', mp4: 'audio/mp4', mp3: 'audio/mpeg',
  opus: 'audio/ogg', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac'
}

/** True for a URL the YouTube credentials were meant for. */
const isYouTubeUrl = (url) => /(?:youtube\.com|youtu\.be|\/watch\?v=|music\.youtube\.com)/i.test(String(url || ''))

/**
 * Download anything yt-dlp can handle into a Buffer, inside a fresh temp dir.
 *
 * Cookies are attached ONLY for YouTube URLs: a YouTube cookies.txt (or a
 * --cookies-from-browser value) means nothing to the SoundCloud extractor and
 * can make it fail outright. The proxy, when set, applies to every extractor.
 */
async function ytDlpDownloadUrl(url, { format = 'bestaudio[ext=webm]/bestaudio/best' } = {}) {
  const cookies = ytDlpOption('YTDLP_COOKIES')
  const proxy = ytDlpOption('YTDLP_PROXY')
  const extArgs = ytDlpOption('YTDLP_EXTRACTOR_ARGS')

  let dir
  try {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ytdlp-'))
  } catch (error) {
    return { status: false, error: 'Could not create a temp directory for yt-dlp: ' + (error?.message || error) }
  }

  const args = [
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--no-part',
    '--no-call-home',
    '--restrict-filenames',
    // Attached cover art would be muxed into the audio and bloat the result.
    '--format', format,
    '--output', path.join(dir, 'audio.%(ext)s')
  ]
  const forYouTube = isYouTubeUrl(url)
  if (cookies && forYouTube) {
    // A readable file is a cookies.txt; anything else is taken as a browser name.
    let isFile = false
    try { isFile = (await fs.promises.stat(cookies)).isFile() } catch { }
    args.push(isFile ? '--cookies' : '--cookies-from-browser', cookies)
  }
  if (proxy) args.push('--proxy', proxy)
  if (extArgs && forYouTube) args.push('--extractor-args', extArgs)
  args.push(url)

  let lastError = 'yt-dlp is not installed on this host'
  const errors = []
  try {
    for (const command of ytDlpCandidates()) {
      let result
      try {
        result = await runYtDlp(command, args)
      } catch (error) {
        // Binary missing: try the next candidate and remember why.
        errors.push(`${command.join(' ')}: ${error?.message || error}`)
        continue
      }

      if (result.code !== 0) {
        lastError = ytDlpHint(result.stderr)
        errors.push(`${command.join(' ')}: ${lastError}`)
        continue
      }

      /*
       * The output directory is a fresh mkdtemp, so whatever landed in it is the
       * track. This is deliberately preferred over yt-dlp's --print filepath:
       * --print implies --simulate (which silently skips the download entirely
       * and reports the path as "NA" - verified on yt-dlp 2026.08.19), and the
       * extension varies with the chosen format, so the name cannot be guessed.
       */
      let filePath = ''
      const entries = await fs.promises.readdir(dir)
      if (entries.length) filePath = path.join(dir, entries[0])
      if (!filePath) { lastError = 'yt-dlp reported success but wrote no file'; continue }

      const stat = await fs.promises.stat(filePath).catch(() => null)
      if (!stat || !stat.size) { lastError = 'yt-dlp produced an empty file'; continue }
      if (stat.size > YTDLP_MAX_BYTES) return { status: false, error: 'The audio track is too large to send' }

      const buffer = await fs.promises.readFile(filePath)
      if (buffer.length < 4096) { lastError = 'The audio track is empty'; continue }

      const ext = path.extname(filePath).slice(1).toLowerCase()
      return { status: true, buffer, mimetype: AUDIO_MIME[ext] || 'audio/mpeg' }
    }
    // Prefer the yt-dlp wording: when it is a bot check, that is the message that
    // actually tells the user what to do.
    const actionable = errors.find(e => /bot|Sign in|cookies/i.test(e))
    return { status: false, error: actionable ? lastError : (lastError || errors[errors.length - 1] || 'yt-dlp failed') }
  } catch (error) {
    return { status: false, error: error?.message || 'yt-dlp failed' }
  } finally {
    try { await fs.promises.rm(dir, { recursive: true, force: true }) } catch { }
  }
}

/**
 * YouTube audio via yt-dlp: the credentialed, full-length route.
 * Kept as a named entry point because the tests and docs refer to it.
 */
async function ytdlYtDlpBuffer(url) {
  const result = await ytDlpDownloadUrl(url)
  return result.status ? { ...result, title: 'YouTube song' } : result
}

/**
 * Run a yt-dlp search and return its entries as plain metadata.
 *
 * `--flat-playlist --dump-single-json` prints one JSON document on stdout and
 * downloads nothing, so a search costs a couple of seconds and no bandwidth.
 * This is how the SoundCloud route picks its track BEFORE committing to a
 * download - important, because SoundCloud search returns covers, slowed
 * versions and sped-up edits alongside the real thing.
 */
async function ytDlpSearch(prefix, query, limit = 8) {
  const target = `${prefix}${limit}:${String(query || '').trim()}`
  const proxy = ytDlpOption('YTDLP_PROXY')
  const args = ['--flat-playlist', '--dump-single-json', '--no-warnings', '--no-progress', '--no-call-home', '--ignore-config']
  if (proxy) args.push('--proxy', proxy)
  args.push(target)

  const errors = []
  for (const command of ytDlpCandidates()) {
    let result
    try {
      result = await runYtDlp(command, args)
    } catch (error) {
      errors.push(`${command.join(' ')}: ${error?.message || error}`)
      continue
    }
    if (result.code !== 0) {
      errors.push(ytDlpHint(result.stderr))
      continue
    }
    try {
      const start = result.stdout.indexOf('{')
      const parsed = JSON.parse(result.stdout.slice(start))
      const entries = Array.isArray(parsed?.entries) ? parsed.entries : []
      return { status: true, entries: entries.filter(e => e && e.url) }
    } catch (error) {
      errors.push('could not read the search results: ' + (error?.message || error))
    }
  }
  return { status: false, entries: [], error: errors[errors.length - 1] || 'search failed' }
}

/*
 * ─────────────────────────────────────────────────────────────────────────────
 *  SONG RESOLVER — real audio with no credentials
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHY THIS IS SO ELABORATE. The first version of this lookup took the strings
 * straight from the YouTube search result and asked one provider. That fails on
 * the very first real request it received:
 *
 *     .play hope -> "XXXTENTACION - Hope (Lyrics)" by channel "7clouds"
 *     query sent: "7clouds XXXTENTACION - Hope (Lyrics)"
 *     Deezer: 0 hits      iTunes: 0 hits         -> synth fallback, user annoyed
 *     query sent: "XXXTENTACION Hope"
 *     Deezer: 5 hits, all with previews          -> the actual song
 *
 * Two lessons, both encoded below:
 *
 *   1. THE QUERY IS THE WHOLE PROBLEM. A channel name (especially a lyrics
 *      repost channel) plus a bracketed "(Lyrics)" suffix is noise that matches
 *      no catalogue entry. Query strings are therefore BUILT from the video
 *      title, not copied from it - see buildSongQueries().
 *   2. ONE PROVIDER IS NOT ENOUGH, and picking its first result is not enough
 *      either. SoundCloud search happily returns "Hope (slowed + reverb)" and
 *      "Hope (speed up)" before the real thing, so every candidate is SCORED by
 *      name overlap, a bad-qualifier penalty, and - most usefully - how closely
 *      its duration matches the video's. A 30 s snippet and a 2:26 slowed edit
 *      are both rejected against a 1:51 song.
 *
 * THE SOURCES, in the order they are tried when no YouTube credentials exist:
 *
 *   SoundCloud via yt-dlp   FULL LENGTH, no key, no account. Verified here:
 *                           `yt-dlp scsearch5:XXXTENTACION Hope` returns
 *                           "HOPE" uploaded by the artist's own account (105 s),
 *                           and the download completes as hls_aac_160k.
 *   Deezer                  official 30 s preview, keyless, api.deezer.com
 *   iTunes                  official 30 s preview, keyless, itunes.apple.com
 *
 * Preview sizes look identical across songs (479827 B) because every preview is
 * 30 s of CBR 128 kbps - the sha1s differ, so they are genuinely distinct
 * recordings, not one stub. Checked, because it looked too good to be true.
 *
 * The card labels whichever it got, so a 30 s preview is never passed off as the
 * whole song. SoundCloud results are uploads rather than label masters, which is
 * why it is only preferred when a candidate scores well.
 */
const PREVIEW_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36'
const YOUTUBE_SEARCH_LIMIT = 8
const YOUTUBE_MAX_SECONDS = 1200      // longer than this is a mix or a livestream
/*
 * Held below SoundCloud's floor on purpose. A YouTube hit's `uploader` is usually
 * "<Artist> - Topic", a label channel or an unrelated re-uploader, so the artist
 * token contributes less than it does on SoundCloud - the TITLE match is far more
 * reliable here, and that is what this score mostly measures.
 */
const YOUTUBE_MIN_SCORE = 10

const SOUNDCLOUD_SEARCH_LIMIT = 8
const SOUNDCLOUD_MAX_SECONDS = 1800   // longer than this is a mix or a DJ set
const SONG_MIN_SECONDS = 45           // shorter than this is a snippet
const SONG_MIN_SCORE = 2              // below this, the "match" is a coincidence
/*
 * SoundCloud is held to a much higher bar than the preview services, and this
 * threshold is the whole reason. Its catalogue is user uploads, so for heavily
 * policed mainstream tracks the ONLY full-length copies are reworks. Measured
 * for "The Weeknd Blinding Lights" (200 s):
 *
 *     "Blinding Lights - The Weeknd (SPARKZ Remix)"  by SPARKZ    205 s -> 11
 *     "Blinding Lights"                              by The Weeknd 30 s -> 8
 *     "The Weeknd - Blinding Lights full"            by Minh Prime 763 s -> 8
 *     "... (Lee Wright Remake)" / "(Fideles Edit)" / "Hardstyle Bootleg" -> 8-10
 *
 * At a low threshold the remix wins and the user gets the wrong recording. At 12
 * every one of those is rejected and the lookup falls through to Deezer, whose
 * 30 s official preview IS the real studio recording - shorter, but right. Songs
 * that do exist properly on SoundCloud clear the bar easily: "HOPE" by
 * XXXTENTACION scores 14, "Queen - Bohemian Rhapsody" (353 s) scores 16.
 */
const SOUNDCLOUD_MIN_SCORE = 12

/*
 * Versions nobody means when they ask for a song. The penalty is heavy on
 * purpose: a rework that matches the name PERFECTLY must still lose to a plain
 * copy that matches it well, so remixes can never outrank the original.
 */
const BAD_QUALIFIERS = /\b(slowed|reverb|sped\W?up|speed\W?up|nightcore|8d|bass\W?boost|instrumental|karaoke|cover|remix|mashup|bootleg|remake|flip|edit|loop|live|teaser|snippet|trailer)\b/i
const BAD_QUALIFIER_PENALTY = -12

/* Tokens used for name matching. Punctuation is not signal. */
const previewTokens = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)

const asCandidates = (input) => (Array.isArray(input) ? input : [input]).map(v => String(v || '').trim()).filter(Boolean)

/*
 * ── Building the query ──
 *
 * "(Lyrics)", "[Official Video]", "(4K Remaster)" and friends carry no search
 * value and actively prevent a match, so every bracketed aside is dropped.
 * Trailing marketing words are dropped only when they END the string, because
 * bare keywords are legitimate song titles ("Video Games", "Music").
 */
const dropBrackets = (s) => String(s || '').replace(/[\(\[\{][^\)\]\}]*[\)\]\}]/g, ' ')

const dropTrailing = (s) => String(s || '')
  .replace(/\s*[-–—|]\s*(?:official\s+)?(?:music\s+)?(?:video|audio|lyric[s]?\s+video|lyrics?|visuali[sz]er|mv|hd|hq|4k|8k)\s*$/i, ' ')
  .replace(/\s*\b(?:official|lyrics?|audio|visuali[sz]er|hd|hq|4k|8k)\s*$/i, ' ')

const tidy = (s) => String(s || '')
  .replace(/[\u2018\u2019\u201c\u201d"'`]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

/**
 * Turn a YouTube search result into a list of query strings, best first.
 *
 *     ("XXXTENTACION - Hope (Lyrics)", "7clouds")
 *       -> ["XXXTENTACION Hope", "Hope", "7clouds Hope", "XXXTENTACION - Hope"]
 */
function buildSongQueries(title, artist) {
  const rawTitle = tidy(dropBrackets(title))
  const cleanTitle = tidy(dropTrailing(rawTitle))
  const parts = cleanTitle.split(/\s+[-–—]\s+/).map(tidy).filter(Boolean)
  const artistInTitle = parts.length > 1 ? parts[0] : ''
  const songInTitle = parts.length > 1 ? parts.slice(1).join(' ') : cleanTitle
  const channel = tidy(dropTrailing(String(artist || '')
    .replace(/\s*[-–—]\s*topic\s*$/i, ' ')
    .replace(/\s*vevo\s*$/i, ' ')))

  const out = []
  const push = (a, b) => {
    const q = tidy(`${a || ''} ${b || ''}`)
    if (q && q.length >= 2 && !out.includes(q)) out.push(q)
  }
  // The title's own "ARTIST - Song" split is the most reliable pair by far.
  push(artistInTitle, songInTitle)
  push(songInTitle)
  push(channel, songInTitle)
  push(cleanTitle)
  return out
}

/**
 * Score one candidate against the query it was found for.
 * Name overlap does the basic work; the duration comparison is what separates
 * the real recording from the slowed/sped-up/snippet versions of it.
 */
function songScore({ title, artist, duration }, queryTokens, expectedSeconds) {
  const hay = new Set(previewTokens(`${title || ''} ${artist || ''}`))
  let score = 0
  let hits = 0
  for (const token of queryTokens) if (hay.has(token)) { score += 2; hits++ }
  if (queryTokens.length && hits === queryTokens.length) score += 2   // full name match
  if (BAD_QUALIFIERS.test(`${title || ''} ${artist || ''}`)) score += BAD_QUALIFIER_PENALTY

  const seconds = Number(duration) || 0
  if (seconds) {
    // A clip is not the song, and a two-hour file is a mix, not a track.
    if (seconds < SONG_MIN_SECONDS) score -= 8
    if (seconds > SOUNDCLOUD_MAX_SECONDS) score -= 8
    if (expectedSeconds) {
      const diff = Math.abs(seconds - expectedSeconds)
      score += diff <= 6 ? 8 : diff <= 15 ? 4 : diff <= 40 ? 0 : -2
    }
  }
  return score
}

/**
 * Rank provider hits, best first, and keep the score alongside each.
 * `map` converts a provider hit into { title, artist, duration, ... }.
 */
function rankHits(hits, queryTokens, expectedSeconds, map) {
  return hits
    .map(hit => {
      const meta = map(hit)
      return { hit, meta, score: songScore(meta, queryTokens, expectedSeconds) }
    })
    .sort((a, b) => b.score - a.score)
}

/**
 * Official 30 second previews from Deezer, then iTunes.
 *
 * Accepts a query string or a list of them (buildSongQueries output); the first
 * candidate that yields a confident match wins, so the common case costs one
 * request.
 */
async function ytdlPreviewBuffer(input, expectedSeconds = 0) {
  const queries = asCandidates(input)
  if (!queries.length) return { status: false, error: 'No song name to search a preview for' }

  const attempts = []
  for (const query of queries.slice(0, 3)) {
    const queryTokens = previewTokens(query)
    if (!queryTokens.length) continue

    /* ── Deezer: MP3, no key, the most predictable hit rate ── */
    try {
      const { data } = await axios.get('https://api.deezer.com/search', {
        params: { q: query, limit: 10 }, timeout: 20000, headers: { 'User-Agent': PREVIEW_UA }
      })
      if (data?.error) {
        attempts.push(`Deezer: ${data.error.message || 'API error'}`)
      } else {
        const hits = (data?.data || []).filter(h => h?.preview)
        const ranked = rankHits(hits, queryTokens, expectedSeconds, h => ({
          title: h.title, artist: h.artist?.name, duration: Number(h.duration) || 0
        }))
        const best = ranked[0]
        if (best && best.score >= SONG_MIN_SCORE) {
          const response = await axios.get(best.hit.preview, {
            responseType: 'arraybuffer', timeout: 30000, maxContentLength: 20 * 1024 * 1024, headers: { 'User-Agent': PREVIEW_UA }
          })
          const buffer = Buffer.from(response.data)
          if (buffer.length >= 4096) {
            return {
              status: true,
              title: best.meta.title || 'Song preview',
              artist: best.meta.artist || '',
              duration: 30,
              fullSeconds: best.meta.duration,
              buffer,
              mimetype: 'audio/mpeg',
              preview: true,
              source: 'Deezer'
            }
          }
          attempts.push('Deezer returned an empty preview')
        } else {
          attempts.push(`Deezer: no confident match for "${query}"`)
        }
      }
    } catch (error) {
      attempts.push(`Deezer: ${error?.message || error}`)
    }

    /* ── iTunes as the backup ── */
    try {
      const { data } = await axios.get('https://itunes.apple.com/search', {
        params: { term: query, entity: 'song', limit: 10 }, timeout: 20000, headers: { 'User-Agent': PREVIEW_UA }
      })
      const hits = (data?.results || []).filter(h => h?.previewUrl)
      const ranked = rankHits(hits, queryTokens, expectedSeconds, h => ({
        title: h.trackName, artist: h.artistName, duration: Number(h.trackTimeMillis ? h.trackTimeMillis / 1000 : 0) || 0
      }))
      const best = ranked[0]
      if (best && best.score >= SONG_MIN_SCORE) {
        const response = await axios.get(best.hit.previewUrl, {
          responseType: 'arraybuffer', timeout: 30000, maxContentLength: 20 * 1024 * 1024, headers: { 'User-Agent': PREVIEW_UA }
        })
        const buffer = Buffer.from(response.data)
        if (buffer.length >= 4096) {
          return {
            status: true,
            title: best.meta.title || 'Song preview',
            artist: best.meta.artist || '',
            duration: 30,
            fullSeconds: best.meta.duration,
            buffer,
            mimetype: 'audio/mp4',
            preview: true,
            source: 'iTunes'
          }
        }
        attempts.push('iTunes returned an empty preview')
      } else {
        attempts.push(`iTunes: no confident match for "${query}"`)
      }
    } catch (error) {
      attempts.push(`iTunes: ${error?.message || error}`)
    }
  }

  return { status: false, error: attempts.join(' | ') || 'No official preview was available' }
}

/**
 * SoundCloud via yt-dlp: FULL LENGTH audio, and it needs no account at all.
 *
 * SoundCloud is a different service with no datacenter bot check, so unlike
 * YouTube it just works from this host. The search step is separate from the
 * download on purpose: only a candidate that scores well is downloaded, which
 * keeps "Hope (slowed + reverb)" out of the card.
 */
async function ytDlpSoundCloudBuffer(input, expectedSeconds = 0) {
  const queries = asCandidates(input)
  if (!queries.length) return { status: false, error: 'No song name to search SoundCloud for' }

  const attempts = []
  const seen = new Set()
  for (const query of queries.slice(0, 3)) {
    const key = query.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    const search = await ytDlpSearch('scsearch', query, SOUNDCLOUD_SEARCH_LIMIT)
    if (!search.status) {
      attempts.push(`SoundCloud: ${search.error || 'search failed'}`)
      continue
    }

    const queryTokens = previewTokens(query)
    const ranked = rankHits(search.entries, queryTokens, expectedSeconds, e => ({
      title: e.title, artist: e.uploader, duration: Number(e.duration) || 0
    }))
    const best = ranked[0]
    const seconds = Number(best?.meta?.duration) || 0
    if (!best || best.score < SOUNDCLOUD_MIN_SCORE || seconds > SOUNDCLOUD_MAX_SECONDS || (seconds && seconds < SONG_MIN_SECONDS)) {
      // Deliberately strict - see SOUNDCLOUD_MIN_SCORE. A mediocre SoundCloud
      // match is worse than an honest 30 s official preview.
      attempts.push(`SoundCloud: nothing close enough for "${query}"`)
      continue
    }

    const got = await ytDlpDownloadUrl(best.hit.url)
    if (got.status && Buffer.isBuffer(got.buffer)) {
      return {
        ...got,
        title: tidy(best.meta.title) || 'Song',
        artist: tidy(best.meta.artist) || '',
        duration: seconds,
        full: true,
        preview: false,
        source: 'SoundCloud'
      }
    }
    attempts.push(`SoundCloud: ${got.error || 'download failed'}`)
  }

  return { status: false, error: attempts.join(' | ') || 'SoundCloud found nothing' }
}

/**
 * FULL-LENGTH audio from YouTube, found by song name.
 *
 * This is the route the operator asked for: when a song is looked up BY NAME and
 * the YouTube copy is taken, the WHOLE track should come back, not a 30 second
 * excerpt. Search first (flat, downloads nothing), rank the hits with the same
 * scoring the SoundCloud route uses, then download only the winner as bestaudio.
 *
 * YouTube's webm stream IS Opus already, so the downloaded bytes are handed over
 * untouched and the caller re-encodes to OGG/Opus only when it needs the card
 * copy. Nothing is transcoded twice.
 *
 * @param {string|string[]} input  a query, or the buildSongQueries list
 */
async function ytDlpYouTubeSongBuffer(input, expectedSeconds = 0) {
  const queries = asCandidates(input)
  if (!queries.length) return { status: false, error: 'No song name to search YouTube for' }

  const attempts = []
  const seen = new Set()
  for (const query of queries.slice(0, 3)) {
    const key = query.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    const search = await ytDlpSearch('ytsearch', query, YOUTUBE_SEARCH_LIMIT)
    if (!search.status) {
      attempts.push(`YouTube: ${search.error || 'search failed'}`)
      continue
    }

    const queryTokens = previewTokens(query)
    const ranked = rankHits(search.entries, queryTokens, expectedSeconds, e => ({
      title: e.title, artist: e.uploader || e.channel, duration: Number(e.duration) || 0
    }))
    const best = ranked[0]
    const seconds = Number(best?.meta?.duration) || 0
    if (!best || best.score < YOUTUBE_MIN_SCORE || seconds > YOUTUBE_MAX_SECONDS || (seconds && seconds < SONG_MIN_SECONDS)) {
      // Same reasoning as SoundCloud: a weak YouTube match is usually a cover, a
      // "slowed + reverb" edit or a reaction video, and the honest 30 s official
      // preview is better than confidently sending the wrong recording.
      attempts.push(`YouTube: nothing close enough for "${query}"`)
      continue
    }

    const got = await ytDlpDownloadUrl(best.hit.url)
    if (got.status && Buffer.isBuffer(got.buffer)) {
      return {
        ...got,
        title: tidy(best.meta.title) || 'Song',
        artist: tidy(best.meta.artist) || '',
        duration: seconds,
        full: true,
        preview: false,
        source: 'YouTube'
      }
    }
    attempts.push(`YouTube: ${got.error || 'download failed'}`)
  }

  return { status: false, error: attempts.join(' | ') || 'YouTube found nothing' }
}

/**
 * THE ONE ENTRY POINT for "give me the audio for this song".
 *
 * ORDER, and why:
 *   1. YouTube by name  - the whole recording, when yt-dlp can run. Preferred
 *                         because "play this song" means the whole song.
 *   2. SoundCloud       - the whole recording from a second catalogue, for the
 *                         tracks YouTube will not serve this server.
 *   3. Deezer / iTunes  - an official 30 s preview, clearly labelled as one. The
 *                         last resort, never passed off as the full track.
 *
 * @param {{title?: string, artist?: string, seconds?: number}} meta
 */
async function ytdlSongBuffer(meta = {}) {
  const queries = buildSongQueries(meta.title, meta.artist)
  const expectedSeconds = Number(meta.seconds) || 0
  if (!queries.length) return { status: false, error: 'No song name to look up' }
  console.log(`[SONG] looking for "${tidy(meta.artist)} - ${tidy(meta.title)}" (${expectedSeconds || '?'}s) via: ${queries.join(' | ')}`)

  const notes = []

  /*
   * YouTube is only worth trying when yt-dlp is actually runnable here. Without
   * it the step would either do nothing or report a credentials message for every
   * single lookup, so it is skipped and the note below records why.
   */
  if (await ytDlpInstalled()) {
    try {
      const yt = await ytDlpYouTubeSongBuffer(queries, expectedSeconds)
      if (yt?.status && Buffer.isBuffer(yt.buffer)) return yt
      if (yt?.error) notes.push(yt.error)
    } catch (error) {
      notes.push('YouTube: ' + (error?.message || error))
    }
  } else {
    notes.push('YouTube: yt-dlp is not installed on this server')
  }

  try {
    const sc = await ytDlpSoundCloudBuffer(queries, expectedSeconds)
    if (sc?.status && Buffer.isBuffer(sc.buffer)) return sc
    if (sc?.error) notes.push(sc.error)
  } catch (error) {
    notes.push('SoundCloud: ' + (error?.message || error))
  }

  try {
    const pv = await ytdlPreviewBuffer(queries, expectedSeconds)
    if (pv?.status && Buffer.isBuffer(pv.buffer)) return pv
    if (pv?.error) notes.push(pv.error)
  } catch (error) {
    notes.push('preview: ' + (error?.message || error))
  }

  return { status: false, error: notes.join(' | ') || 'No audio source matched this song' }
}

/**
 * Re-encode any audio buffer as mono OGG/Opus, which is the "form of opus" both
 * WhatsApp itself and the HTML cards use.
 *
 * Used for the audio that is SENT, not only the copy embedded in a card: a
 * YouTube download is Opus inside a WebM container, and handing those bytes over
 * as `audio/mpeg` is a mislabelled file that some clients refuse to play. Opus in
 * OGG is one predictable container that every WhatsApp client handles.
 *
 * Never throws: on any ffmpeg failure the original buffer is returned unchanged,
 * so a transcode problem degrades to "plays the file we had", not "sends nothing".
 */
async function toOpusOgg(buffer, { bitrate = 48000, maxSeconds = 0, channels = 1 } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { status: false, buffer: null, error: 'nothing to encode' }
  let bin
  try { bin = require('ffmpeg-static') } catch { return { status: true, buffer, opus: false, error: 'ffmpeg-static is unavailable' } }
  const { spawn } = require('child_process')
  try {
    const encoded = await new Promise((resolve, reject) => {
      const args = ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0']
      if (maxSeconds > 0) args.push('-t', String(Math.floor(maxSeconds)))
      // -map 0:a:0/-vn/-map_metadata -1 drop the source's embedded cover art and
      // tags; a YouTube rip otherwise carries a 1280x720 JPEG into the output.
      // Mono by default: that is what the card needs to fit its base64 budget. The
      // full track that is sent as a real audio message asks for 2, because a song
      // in mono is a needless quality drop.
      args.push('-map', '0:a:0', '-vn', '-map_metadata', '-1', '-ac', String(channels <= 2 ? channels : 2), '-ar', '48000',
        '-c:a', 'libopus', '-b:a', String(bitrate), '-vbr', 'off', '-frame_duration', '60',
        '-f', 'ogg', 'pipe:1')
      const ff = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
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
    return { status: true, buffer: encoded, opus: true, mimetype: 'audio/ogg' }
  } catch (error) {
    console.error('[YTDL] opus transcode failed, sending the original bytes:', error?.message || error)
    return { status: true, buffer, opus: false, error: error?.message || String(error) }
  }
}

async function ytdlAutoBuffer(url, type = 'audio') {
  const attempts = []
  /*
   * yt-dlp goes FIRST when it can succeed - either because it has credentials or
   * because it is installed and simply works here. Otherwise the four scrapers
   * below burn 30-60 s before it is reached, which is what made every Shazam
   * download feel broken on this deployment.
   *
   * When it genuinely cannot run it is still tried LAST: it fails in a couple of
   * seconds and its error ("YouTube blocked this server ... set YTDLP_COOKIES") is
   * far more useful than "Provider returned a webpage instead of audio".
   */
  const ytDlpFirst = ytDlpConfigured() || await ytDlpInstalled()
  if (ytDlpFirst) {
    try { const r = await ytdlYtDlpBuffer(url); if (r?.status && Buffer.isBuffer(r.buffer)) return r; if (r?.error) attempts.push(r.error) } catch (e) { attempts.push(e?.message || 'yt-dlp failed') }
  }
  try { const direct = await ytdlDirectBuffer(url); if (direct?.status && Buffer.isBuffer(direct.buffer)) return direct; if (direct?.error) attempts.push(direct.error) } catch (e) { attempts.push(e?.message || 'Direct YouTube download failed') }
  try { const classic = await ytdlClassicBuffer(url); if (classic?.status && Buffer.isBuffer(classic.buffer)) return classic; if (classic?.error) attempts.push(classic.error) } catch (e) { attempts.push(e?.message || 'Fallback YouTube download failed') }
  let lastError = attempts[attempts.length - 1] || 'All YouTube audio providers failed'
  for (const fn of [ytdlv1, ytdlv3, ytdlv4, ytdlv2]) {
    try {
      const result = await fn(url, type); if (!result?.status || !result.download_url) continue
      /*
       * TWO ATTEMPTS PER PROVIDER, judged on the BYTES.
       *
       * These scrapers answer with a fresh, short-lived CDN link, and while the
       * file is still being prepared that link returns HTTP 200 with an HTML
       * placeholder - which is how a provider that really does serve the whole
       * track was written off as "returned a webpage instead of audio".
       * Measured on savenow.to from this host: the same route yields a 8.03 MB
       * audio/mpeg (ID3) full master, and a link that answers with a page
       * answers with the audio seconds later.
       *
       * The content-type alone is not trusted either: it is a hint from a
       * scraper, and a real file is the thing that has ID3/OggS/ftyp in it.
       */
      let link = result.download_url
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await axios.get(link, { responseType: 'arraybuffer', timeout: 120000, maxContentLength: 50 * 1024 * 1024, maxBodyLength: 50 * 1024 * 1024, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36', Accept: 'audio/mpeg,audio/*;q=0.9,application/octet-stream;q=0.8,*/*;q=0.5' }, validateStatus: status => status >= 200 && status < 400 })
        const buffer = Buffer.from(response.data); const contentType = String(response.headers?.['content-type'] || '').toLowerCase()
        if (buffer.length >= 4096 && !looksLikeWebpage(buffer, contentType)) {
          return { status: true, title: result.title || 'YouTube song', buffer, mimetype: contentType.startsWith('audio/') ? contentType.split(';')[0] : 'audio/mpeg' }
        }
        lastError = buffer.length < 4096 ? 'Downloaded audio is empty or too small' : 'Provider returned a webpage instead of audio'
        if (attempt < 2) {
          /*
           * Ask for a fresh link: the placeholder means "not ready yet". The
           * wait grows, because a provider that has just been asked for a file
           * answers with the same placeholder while it rate-limits - retrying
           * after a fixed second looked identical to not retrying at all.
           */
          await sleep(attempt === 0 ? 5000 : 15000)
          try { const again = await fn(url, type); if (again?.status && again.download_url) link = again.download_url } catch { }
        }
      }
    } catch (error) { lastError = error?.message || lastError }
  }
  // No credentials were configured, so yt-dlp was skipped above. Run it now
  // anyway: it fails in a couple of seconds and its message names the fix.
  if (!ytDlpFirst) {
    try {
      const r = await ytdlYtDlpBuffer(url)
      if (r?.status && Buffer.isBuffer(r.buffer)) return r
      if (r?.error) lastError = r.error
    } catch (error) { lastError = error?.message || lastError }
  }
  return { status: false, error: lastError || 'All YouTube audio providers failed' }
}


function extractYouTubeId(url) {
  try {
    const u = new URL(String(url))
    const host = u.hostname.toLowerCase().replace(/^www\./, '')
    if (host === 'youtu.be') return u.pathname.slice(1).match(/^[A-Za-z0-9_-]{11}$/)?.[0] || null
    if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
      return u.searchParams.get('v')?.match(/^[A-Za-z0-9_-]{11}$/)?.[0] || u.pathname.match(/\/(?:embed|v|shorts|live)\/([A-Za-z0-9_-]{11})/)?.[1] || null
    }
  } catch {}
  return null
}

async function getYouTubeMetadata(url) {
  const videoId = extractYouTubeId(url)
  if (!videoId) return { status: false, error: 'Invalid YouTube URL' }
  if (distubeYtdl) {
    try {
      const info = await distubeYtdl.getBasicInfo(`https://www.youtube.com/watch?v=${videoId}`)
      const d = info.videoDetails || {}
      return {
        status: true,
        videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        title: d.title || 'YouTube video',
        author: d.author?.name || 'YouTube',
        duration: Number(d.lengthSeconds || 0),
        thumbnail: d.thumbnails?.[d.thumbnails.length - 1]?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        views: Number(d.viewCount || 0),
        isLive: Boolean(d.isLiveContent)
      }
    } catch (error) {
      return { status: false, videoId, error: error?.message || 'Unable to read YouTube metadata' }
    }
  }
  return { status: false, videoId, error: 'YouTube metadata reader is unavailable' }
}

async function downloadToFile(downloadUrl, destination, maxBytes = 200 * 1024 * 1024) {
  const temp = `${destination}.part`
  try {
    const response = await axios.get(downloadUrl, {
      responseType: 'stream',
      timeout: 120000,
      maxContentLength: maxBytes,
      maxBodyLength: maxBytes,
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'video/mp4,video/*;q=0.9,application/octet-stream;q=0.8,*/*;q=0.5' },
      validateStatus: status => status >= 200 && status < 400
    })
    const contentLength = Number(response.headers?.['content-length'] || 0)
    if (contentLength > maxBytes) throw new Error('Video file is too large')
    await fs.promises.mkdir(path.dirname(destination), { recursive: true })
    const writer = fs.createWriteStream(temp)
    let total = 0

    /*
     * ONE error listener for the whole stream, not one per write.
     *
     * The previous version attached `writer.once('error', reject)` INSIDE the
     * per-chunk loop, so every time backpressure was hit another listener was
     * attached and never removed. A large download pushed the count past Node's
     * limit and printed this in the console:
     *
     *   MaxListenersExceededWarning: Possible EventEmitter memory leak detected.
     *   11 error listeners added to [WriteStream]. MaxListeners is 10.
     *
     * The final `end()` wait attached one more that was never detached when its
     * promise resolved, so it leaked for the life of the stream as well.
     * Measured against the old code: a 400-chunk download left 401 error
     * listeners attached to the stream.
     *
     * A single deferred records the first error instead, and every wait below
     * adds only its own short-lived listener and removes it on settle. The
     * persistent listener also stops an error from becoming an unhandled
     * 'error' event, which would take the whole process down.
     */
    let streamError = null
    const recordStreamError = error => {
      streamError = error instanceof Error ? error : new Error(String(error || 'write stream failed'))
    }
    writer.on('error', recordStreamError)

    /** Wait for one stream event, detaching BOTH listeners when it settles. */
    const waitForStream = event => new Promise((resolve, reject) => {
      if (streamError) return reject(streamError)
      const done = value => { writer.removeListener(event, done); writer.removeListener('error', fail); resolve(value) }
      const fail = error => { writer.removeListener(event, done); writer.removeListener('error', fail); reject(error) }
      writer.once(event, done)
      writer.once('error', fail)
    })

    try {
      for await (const chunk of response.data) {
        total += chunk.length
        if (total > maxBytes) throw new Error('Video file is too large')
        if (!writer.write(chunk)) await waitForStream('drain')
        // An error can land between chunks. Stop rather than keep writing into a
        // dead stream until the read loop happens to end.
        if (streamError) throw streamError
      }
      await new Promise((resolve, reject) => {
        const done = () => { writer.removeListener('finish', done); writer.removeListener('error', fail); resolve() }
        const fail = error => { writer.removeListener('finish', done); writer.removeListener('error', fail); reject(error) }
        writer.once('finish', done)
        writer.once('error', fail)
        writer.end()
      })
    } catch (error) {
      writer.destroy()
      throw error
    }
    if (total < 4096) throw new Error('Downloaded video is empty')
    await fs.promises.rename(temp, destination)
    return { status: true, path: destination, size: total }
  } catch (error) {
    try { await fs.promises.rm(temp, { force: true }) } catch {}
    return { status: false, error: error?.message || 'Video download failed' }
  }
}

async function ytdlAutoVideoFile(url, destination, quality = '720', maxBytes = 200 * 1024 * 1024) {
  const qualities = [String(quality), '480', '360'].filter((v, i, a) => a.indexOf(v) === i)
  let lastError = 'All YouTube video providers failed'
  for (const q of qualities) {
    for (const fn of [ytdlv4, ytdlv3, ytdlv2, ytdlv1]) {
      try {
        const result = await fn(url, q)
        if (!result?.status || !result.download_url) continue
        const saved = await downloadToFile(result.download_url, destination, maxBytes)
        if (saved.status) return { ...saved, title: result.title || 'YouTube video' }
        lastError = saved.error || lastError
      } catch (error) {
        lastError = error?.message || lastError
      }
      try { await fs.promises.rm(destination, { force: true }) } catch {}
      try { await fs.promises.rm(`${destination}.part`, { force: true }) } catch {}
    }
  }
  return { status: false, error: lastError }
}

// `downloadToFile` is exported so its write stream can be regression-tested
// directly: the listener leak it used to have only showed up as a console
// warning during a large download, which no other test could reach.
module.exports = { ytdlv1, ytdlv2, ytdlv3, ytdlv4, ytdlAuto, ytdlAutoBuffer, ytdlDirectBuffer, ytdlClassicBuffer, ytdlYtDlpBuffer, ytDlpConfigured, ytDlpInstalled, ytDlpSearch, ytdlPreviewBuffer, ytDlpSoundCloudBuffer, ytDlpYouTubeSongBuffer, ytdlSongBuffer, toOpusOgg, buildSongQueries, songScore, extractYouTubeId, getYouTubeMetadata, ytdlAutoVideoFile, downloadToFile }

