'use strict'

/*
 * .play two-step flow: the picker card, and the fall-through into the card builder.
 *
 * Deliberately offline and deterministic. It checks the WIRING - the button id
 * format, the fall-through, the internal-command classification - rather than
 * sending anything to WhatsApp, which a unit test cannot do.
 */
const fs = require('fs')
const path = require('path')
const { createButtons } = require('../lib/buttons.js')
const menu = require('../lib/menu.js')

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'BIGBRO.js'), 'utf8')

/* Mirrors the id sendPlayPicker() puts on each button. */
const idFor = (token, i) => `play_card ${token} ${i}`

module.exports = function playPickerSuite({ section, ok, eq }) {
    section('play picker')

    // ── button layout ──
    const items = ['One', 'Two', 'Three', 'Four', 'Five', 'Six']
        .map((t, i) => ({ id: idFor('tok123', i), text: `${i + 1}. ${t}` }))
    const built = createButtons(items)

    ok('six results build six buttons', built.nativeFlow.length === 6)
    eq('they lay out as three rows of two', built.rows.map(r => r.length), [2, 2, 2])
    ok('every button is a quick_reply', built.nativeFlow.every(b => b.name === 'quick_reply'))

    const parsed = built.nativeFlow.map(b => JSON.parse(b.buttonParamsJson))
    eq('button ids carry the token and index', parsed.map(p => p.id), items.map(i => i.id))
    ok('display text is numbered', parsed.every((p, i) => p.display_text.startsWith(`${i + 1}.`)))

    // ── the id survives the dispatcher's parse rule ──
    // BIGBRO.js: isButtonResponse -> body.split(/ +/) -> command = parts[0], args = rest
    const parsedId = idFor('tok123', 4).split(/ +/)
    eq('id parses back to the command', parsedId[0], 'play_card')
    eq('id parses back to the token', parsedId[1], 'tok123')
    eq('id parses back to the index', Number(parsedId[2]), 4)

    // ── internal command classification (keeps it out of .menu/.allmenu) ──
    ok('play_card is internal', menu.isInternal('play_card') === true)
    ok('a real command is not', menu.isInternal('play') === false)

    // ── wiring in BIGBRO.js ──
    const cardCase = SOURCE.indexOf("case 'play_card':")
    const playCase = SOURCE.indexOf("case 'play':")
    ok('both cases exist', cardCase !== -1 && playCase !== -1)
    ok('play_card is declared above play', playCase > cardCase)

    const block = SOURCE.slice(cardCase, playCase)
    ok('play_card hands the song over', block.includes('m.__playPicked = picked'))
    ok('play_card refuses an expired selection', block.includes('has expired'))

    /*
     * THE FALL-THROUGH IS THE HAND-OFF. If a break or return is ever added after
     * the song is stashed, the press would select a song and then do nothing.
     */
    const afterStash = SOURCE.slice(
        SOURCE.indexOf('m.__playPicked = picked', cardCase),
        playCase
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    ok('control falls through into play (no break/return after the stash)',
        !/\b(break|return)\b/.test(afterStash), afterStash.trim().slice(0, 120))

    // ── the two steps themselves ──
    const pickerCall = SOURCE.indexOf('await sendPlayPicker(conn, m, query, results)')
    ok('play calls the picker', pickerCall !== -1)
    ok('play stops after offering the picker (card comes from the button press)',
        /return;/.test(SOURCE.slice(pickerCall, pickerCall + 300)))
    ok('the picker builds the id the case expects', SOURCE.includes('id: `play_card ${token} ${i}`'))
    ok('the picker limit is defined', /const PLAY_PICKER_LIMIT = 6/.test(SOURCE))
    ok('the card is only built from a picked song',
        SOURCE.includes('if (picked) {') && SOURCE.includes('const video = picked;'))

    /*
     * ── label disambiguation ──
     * Runs the REAL pickerLabels pulled out of BIGBRO.js, because the whole point
     * of it is that six buttons for one query must not all read the same.
     */
    const labelStart = SOURCE.indexOf('const LABEL_CHARS = 24;')
    const labelEnd = SOURCE.indexOf('\n}\n', SOURCE.indexOf('function pickerLabels(results) {'))
    const pickerLabels = new Function(`${SOURCE.slice(labelStart, labelEnd + 2)}; return pickerLabels;`)()

    const rows = (list) => list.map(([title, author]) => ({ title, author, timestamp: '' }))
    const distinct = (list) => new Set(pickerLabels(rows(list)).map(l => l.slice(0, 24).toLowerCase())).size

    const blinding = [
        ['The Weeknd - Blinding Lights (Official Video)', 'The Weeknd'],
        ['The Weeknd - Blinding Lights (Official Audio)', 'The Weeknd'],
        ['The Weeknd - Blinding Lights (Lyrics)', '7clouds'],
        ['the weeknd - blinding lights (slowed + reverb)', 'PLAYYYPRETEND'],
        ['The Weeknd - Blinding Lights (Live)', 'The Weeknd'],
        ['The Weeknd - Blinding Lights (Remix)', 'DJ']
    ]
    eq('six same-song uploads get six distinct labels', distinct(blinding), blinding.length)

    // "Queen - ..." vs "Queen – ..." must still register as a shared prefix.
    const queen = [
        ['Queen – Bohemian Rhapsody (Official Video Remastered)', 'Queen'],
        ['Queen - Bohemian Rhapsody (Lyrics)', 'Queen'],
        ['Queen - Bohemian Rhapsody (Live Aid 1985)', 'Queen'],
        ['Queen - Bohemian Rhapsody (Official Audio)', 'Queen']
    ]
    eq('dash variants are still told apart', distinct(queen), queen.length)

    // Identical titles cannot yield identical buttons.
    const identical = [['Same Song', 'Channel A'], ['Same Song', 'Channel B'], ['Same Song', 'Channel C']]
    eq('identical titles fall back to the channel', distinct(identical), identical.length)
    ok('and they keep the whole title rather than a fragment',
        pickerLabels(rows(identical)).every(l => l.startsWith('Same Song')))
}
