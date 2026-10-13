'use strict'

/*
 * lib/ytdl.source -- the yt-dlp provider.
 *
 * WHY THIS SUITE EXISTS. Every other audio route in that file is dead from a
 * datacenter IP: YouTube answers the player request with LOGIN_REQUIRED
 * ("Sign in to confirm you're not a bot"), the innertube clients return zero
 * formats, and the four scraping providers return a webpage. yt-dlp is the only
 * route that can act on credentials, so it is what stands between .play /
 * .song / .ytvideo and a synthesised fallback.
 *
 * It cannot be tested against real YouTube here (that is exactly the thing that
 * is blocked), so the suite drives it against a FAKE yt-dlp binary. That still
 * covers everything the provider itself owns: which arguments it builds, how it
 * finds the output file, the extension -> mimetype map, temp cleanup, and the
 * error text shown to the user.
 *
 * One of these assertions is a straight regression guard: yt-dlp's --print
 * implies --simulate, which silently skips the download AND reports the path as
 * "NA". Passing --print made the provider claim success with a zero byte file,
 * so the suite asserts it is never passed.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const {
    ytdlYtDlpBuffer, ytDlpConfigured, ytdlPreviewBuffer,
    ytdlSongBuffer, ytDlpSoundCloudBuffer, ytDlpSearch, buildSongQueries, songScore
} = require('../lib/ytdl.source')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdlp-test-'))

/** Write an executable shell script standing in for the yt-dlp binary. */
function fakeBinary(name, body) {
    const file = path.join(TMP, name)
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    return file
}

/*
 * A successful fake: records its argv, then writes a file at the --output
 * template, which is how the provider locates the result.
 */
const ARGS_LOG = path.join(TMP, 'args.txt')
const OK_BIN = fakeBinary('yt-dlp-ok', `
# Log the argv BEFORE consuming it: the shift loop below empties "$@".
echo "$@" > "${ARGS_LOG}"
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --output) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
out=$(printf '%s' "$out" | sed 's/%(ext)s/webm/')
head -c 30000 /dev/zero | tr '\\0' 'x' > "$out"
exit 0
`)

/* A failing fake: the exact bot-check wording YouTube returns from this host. */
const FAIL_BIN = fakeBinary('yt-dlp-fail', `
echo "ERROR: [youtube] 4NRXx6U8ABQ: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication." >&2
exit 1
`)

/* A fake that succeeds but writes nothing, to exercise the empty-result branch. */
const EMPTY_BIN = fakeBinary('yt-dlp-empty', 'exit 0')

const withEnv = async (overrides, fn) => {
    const saved = {}
    for (const key of Object.keys(overrides)) {
        saved[key] = process.env[key]
        if (overrides[key] === undefined) delete process.env[key]
        else process.env[key] = overrides[key]
    }
    try { return await fn() } finally {
        for (const key of Object.keys(saved)) {
            if (saved[key] === undefined) delete process.env[key]
            else process.env[key] = saved[key]
        }
    }
}

module.exports = async function ytDlpSuite({ section, ok, eq }) {
    section('lib/ytdl.source -- yt-dlp provider')

    eq('both new entry points are exported',
        [typeof ytdlYtDlpBuffer, typeof ytDlpConfigured], ['function', 'function'])

    // ── credentialed detection drives the attempt order ──
    await withEnv({ YTDLP_COOKIES: undefined, YTDLP_PROXY: undefined }, async () => {
        ok('unconfigured by default, so the scrapers are still tried first', ytDlpConfigured() === false)
    })
    await withEnv({ YTDLP_COOKIES: '/tmp/some-cookies.txt' }, async () => {
        ok('a cookies file counts as configured', ytDlpConfigured() === true)
    })
    await withEnv({ YTDLP_PROXY: 'http://127.0.0.1:8080' }, async () => {
        ok('a proxy counts as configured', ytDlpConfigured() === true)
    })

    // ── the happy path ──
    const good = await withEnv({ YTDLP_BIN: OK_BIN, YTDLP_COOKIES: undefined, YTDLP_PROXY: undefined },
        () => ytdlYtDlpBuffer('https://www.youtube.com/watch?v=4NRXx6U8ABQ'))

    ok('a successful run returns a buffer', good.status === true && Buffer.isBuffer(good.buffer), JSON.stringify({ status: good.status, error: good.error }))
    eq('and the file it wrote came back whole', good.buffer ? good.buffer.length : 0, 30000)
    eq('the extension picks the mimetype (.webm)', good.mimetype, 'audio/webm')

    const argv = fs.existsSync(ARGS_LOG) ? fs.readFileSync(ARGS_LOG, 'utf8') : ''
    ok('it asks for an audio-only format', argv.includes('--format'), argv.slice(0, 160))
    ok('it never passes --print (which implies --simulate and skips the download)',
        !argv.includes('--print'))
    ok('it disables playlists, so one URL is one file', argv.includes('--no-playlist'))
    ok('it writes into the output template it is given', argv.includes('--output'))
    ok('no cookie flag when no cookies are configured',
        !argv.includes('--cookies') && !argv.includes('--cookies-from-browser'))

    // ── cookie handling: a real file vs a browser name ──
    const cookieFile = path.join(TMP, 'cookies.txt')
    fs.writeFileSync(cookieFile, '# Netscape HTTP Cookie File\n')
    await withEnv({ YTDLP_BIN: OK_BIN, YTDLP_COOKIES: cookieFile }, () => ytdlYtDlpBuffer('https://youtu.be/x'))
    const fileArgv = fs.readFileSync(ARGS_LOG, 'utf8')
    ok('an existing path is passed to --cookies', fileArgv.includes('--cookies ') && fileArgv.includes(cookieFile), fileArgv.slice(0, 200))

    await withEnv({ YTDLP_BIN: OK_BIN, YTDLP_COOKIES: 'chrome' }, () => ytdlYtDlpBuffer('https://youtu.be/x'))
    const browserArgv = fs.readFileSync(ARGS_LOG, 'utf8')
    ok('a browser name is passed to --cookies-from-browser',
        browserArgv.includes('--cookies-from-browser') && browserArgv.includes('chrome'), browserArgv.slice(0, 200))

    await withEnv({ YTDLP_BIN: OK_BIN, YTDLP_COOKIES: undefined, YTDLP_PROXY: 'http://127.0.0.1:9' }, () => ytdlYtDlpBuffer('https://youtu.be/x'))
    ok('a proxy is forwarded to --proxy', fs.readFileSync(ARGS_LOG, 'utf8').includes('--proxy'))

    // ── failure paths ──
    const botChecked = await withEnv({ YTDLP_BIN: FAIL_BIN, YTDLP_COOKIES: undefined, YTDLP_PROXY: undefined },
        () => ytdlYtDlpBuffer('https://www.youtube.com/watch?v=4NRXx6U8ABQ'))
    ok('a bot check is reported as a failure', botChecked.status === false)
    ok('and the message names the actual fix (cookies or proxy)',
        /YTDLP_COOKIES/.test(botChecked.error || '') && /YTDLP_PROXY/.test(botChecked.error || ''), botChecked.error)
    ok('it does not leak yt-dlp\'s stack of advice to the user',
        (botChecked.error || '').length < 220, String((botChecked.error || '').length))

    const empty = await withEnv({ YTDLP_BIN: EMPTY_BIN, YTDLP_COOKIES: undefined, YTDLP_PROXY: undefined },
        () => ytdlYtDlpBuffer('https://youtu.be/x'))
    ok('exit 0 with no file is still a failure', empty.status === false, empty.error)

    const missing = await withEnv({ YTDLP_BIN: path.join(TMP, 'does-not-exist'), YTDLP_COOKIES: undefined, YTDLP_PROXY: undefined },
        () => ytdlYtDlpBuffer('https://youtu.be/x'))
    ok('a missing binary fails cleanly instead of throwing', missing.status === false, missing.error)

    // ── temp files ──
    const leftovers = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('ytdlp-') && n !== path.basename(TMP))
    eq('every temp directory is cleaned up', leftovers.length, 0)

    /*
     * ── the official-preview provider ──
     *
     * This is the route that makes the card play the REAL song with no
     * credentials at all, so it is the one that matters most in practice. Only
     * its input guard is asserted here: the rest talks to api.deezer.com, and a
     * suite that needs the open internet is a suite that fails for reasons that
     * have nothing to do with this code. The network path is covered by the
     * opt-in block below.
     */
    section('lib/ytdl.source -- official preview provider')

    ok('the preview provider is exported', typeof ytdlPreviewBuffer === 'function')

    const blank = await ytdlPreviewBuffer('   ')
    ok('a blank query fails without touching the network', blank.status === false, blank.error)

    const noQuery = await ytdlPreviewBuffer(null)
    ok('a missing query fails cleanly instead of throwing', noQuery.status === false, noQuery.error)

    /*
     * ── building the query ──
     *
     * THE BUG THIS SUITE EXISTS FOR. A YouTube search result carries a channel
     * name and a bracketed suffix that no catalogue understands. The first real
     * request - ".play hope", which resolved to "XXXTENTACION - Hope (Lyrics)"
     * on the channel "7clouds" - was passed through verbatim as
     * "7clouds XXXTENTACION - Hope (Lyrics)" and matched NOTHING on Deezer or
     * iTunes, dropping the user onto the synth fallback. "XXXTENTACION Hope"
     * matches five releases with previews.
     *
     * These are pure functions, so they are asserted directly and offline.
     */
    section('lib/ytdl.source -- song queries are built, not copied')

    eq('the channel and the (Lyrics) suffix are dropped',
        buildSongQueries('XXXTENTACION - Hope (Lyrics)', '7clouds')[0], 'XXXTENTACION Hope')

    ok('no candidate contains bracketed noise',
        buildSongQueries('Song (Official Video) [4K]', 'Ch').every(q => !/[\(\)\[\]]/.test(q)))

    eq('the title\'s own ARTIST - Song split wins',
        buildSongQueries('Sia - Cheap Thrills (Lyric Video) ft. Sean Paul', 'SiaVEVO')[0],
        'Sia Cheap Thrills ft. Sean Paul')

    eq('a "- Topic" channel suffix is stripped',
        buildSongQueries('Video Games', 'Lana Del Rey - Topic')[1], 'Lana Del Rey Video Games')

    ok('a bare title is not over-stripped',
        buildSongQueries('Video Games', 'Lana Del Rey').includes('Video Games'),
        JSON.stringify(buildSongQueries('Video Games', 'Lana Del Rey')))

    ok('duplicate candidates are not produced',
        buildSongQueries('A - B', 'A').length === new Set(buildSongQueries('A - B', 'A')).size)

    eq('an empty title produces no queries', buildSongQueries('', ''), [])

    /*
     * ── scoring ──
     *
     * SoundCloud search returns the reworked versions FIRST, so a lookup that
     * takes the top hit hands the user a remix. Measured for "The Weeknd
     * Blinding Lights" (200 s), the top hit really is
     * "Blinding Lights - The Weeknd (SPARKZ Remix)", 205 s.
     */
    section('lib/ytdl.source -- candidates are scored, not taken in order')

    const blTokens = ['the', 'weeknd', 'blinding', 'lights']
    const real = songScore({ title: 'Blinding Lights', artist: 'The Weeknd', duration: 200 }, blTokens, 200)
    const remix = songScore({ title: 'Blinding Lights - The Weeknd (SPARKZ Remix)', artist: 'SPARKZ', duration: 205 }, blTokens, 200)
    const snippet = songScore({ title: 'Blinding Lights', artist: 'The Weeknd', duration: 30 }, blTokens, 200)
    const liveEdit = songScore({ title: 'The Weeknd - Blinding Lights (Fideles Edit)', artist: 'X', duration: 301 }, blTokens, 200)

    ok('a perfect-name remix still loses to the plain recording', real > remix,
        `real=${real} remix=${remix}`)
    ok('the remix is pushed below the acceptance bar', remix < 12, `remix=${remix}`)
    ok('a 30 s snippet is not treated as the song', real > snippet && snippet < 12, `snippet=${snippet}`)
    ok('an edit is pushed below the acceptance bar', liveEdit < 12, `edit=${liveEdit}`)

    const hopeTokens = ['xxxtentacion', 'hope']
    const hopeReal = songScore({ title: 'HOPE', artist: 'XXXTENTACION', duration: 105.262 }, hopeTokens, 111)
    const hopeSlowed = songScore({ title: 'XXXTentacion - Hope (slowed + reverb)', artist: 'ASTROYOHAN', duration: 146.567 }, hopeTokens, 111)
    ok('the artist\'s own upload clears the acceptance bar', hopeReal >= 12, `real=${hopeReal}`)
    ok('the slowed + reverb edit is rejected', hopeSlowed < 12, `slowed=${hopeSlowed}`)
    ok('the real upload beats the slowed edit by a wide margin', hopeReal - hopeSlowed > 15,
        `real=${hopeReal} slowed=${hopeSlowed}`)

    const queenReal = songScore({ title: 'Queen - Bohemian Rhapsody', artist: 'rizky.rilos', duration: 352.856 }, ['queen', 'bohemian', 'rhapsody'], 355)
    ok('a plain re-upload of the right recording clears the bar', queenReal >= 12, `score=${queenReal}`)

    /* ── the resolver's own entry point ── */
    section('lib/ytdl.source -- the song resolver')

    ok('the resolver and its helpers are exported',
        [ytdlSongBuffer, ytDlpSoundCloudBuffer, ytDlpSearch, buildSongQueries, songScore].every(f => typeof f === 'function'))

    const noTitle = await ytdlSongBuffer({})
    ok('an empty request fails without touching the network', noTitle.status === false, noTitle.error)

    if (process.env.YTDL_TEST_NETWORK === '1') {
        const hit = await ytdlPreviewBuffer('The Weeknd Blinding Lights')
        ok('a real song resolves to real audio', hit.status === true && Buffer.isBuffer(hit.buffer), hit.error)
        ok('the audio is big enough to be a real recording, not a stub',
            (hit.buffer ? hit.buffer.length : 0) > 100 * 1024)
        ok('it is flagged as a preview, so the card can label it honestly', hit.preview === true)
        ok('it carries a mimetype the audio message can use', /^audio\//.test(hit.mimetype || ''), hit.mimetype)

        const nonsense = await ytdlPreviewBuffer('zzzqqq nonexistent song title xyzzy')
        ok('an unfindable song fails instead of playing a random one', nonsense.status === false)

        /*
         * The regression test for the exact request that broke. "Hope" by
         * XXXTENTACION is on SoundCloud under the artist's own account, so this
         * must come back FULL LENGTH from SoundCloud - not a preview, and above
         * all not a failure.
         */
        const hope = await ytdlSongBuffer({ title: 'XXXTENTACION - Hope (Lyrics)', artist: '7clouds', seconds: 111 })
        ok('the request that used to fail now returns real audio', hope.status === true && Buffer.isBuffer(hope.buffer), hope.error)
        ok('and it is the full song, not a 30 s preview', hope.preview === false && (hope.duration || 0) > 60,
            `source=${hope.source} duration=${hope.duration} preview=${hope.preview}`)
        ok('it came from SoundCloud, which needs no credentials', hope.source === 'SoundCloud', hope.source)
        ok('the match is the artist\'s own upload', /xxxtentacion/i.test(`${hope.artist} ${hope.title}`), `${hope.title} / ${hope.artist}`)

        /*
         * And the counterpart: for a track SoundCloud only carries as reworks,
         * the official 30 s preview must win over the remix.
         */
        const blinding = await ytdlSongBuffer({ title: 'The Weeknd - Blinding Lights (Official Video)', artist: 'The Weeknd', seconds: 200 })
        ok('a mainstream track still resolves to real audio', blinding.status === true, blinding.error)
        ok('and it is not one of the SoundCloud reworks',
            !/remix|edit|bootleg|instrumental|slowed/i.test(`${blinding.title} ${blinding.artist}`),
            `${blinding.source}: ${blinding.title} / ${blinding.artist}`)

        const notASong = await ytdlSongBuffer({ title: 'HOPE Official Trailer (2026)', artist: 'SomeChannel', seconds: 120 })
        ok('content that is not a song is refused rather than mis-matched', notASong.status === false)
    } else {
        console.log('  SKIP  network assertions (set YTDL_TEST_NETWORK=1 to run them)')
    }

    try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
}
