'use strict'

/*
 * The GLOBAL button system.
 *
 * One rule has to hold everywhere: at most TWO buttons per row, and when the
 * count is odd the final button sits ALONE on its own row. These assertions
 * pin the layout for every count from 1 to 8 so a future case cannot invent its
 * own structure, and they check that existing button ids and display texts pass
 * through the helper untouched (no command behaviour may change).
 */

const buttons = require('../lib/buttons.js')

module.exports = function buttonsSuite({ section, ok, eq }) {
    section('lib/buttons -- rows are at most two, odd count ends alone')

    const expected = {
        1: [[0]],
        2: [[0, 1]],
        3: [[0, 1], [2]],
        4: [[0, 1], [2, 3]],
        5: [[0, 1], [2, 3], [4]],
        6: [[0, 1], [2, 3], [4, 5]],
        7: [[0, 1], [2, 3], [4, 5], [6]],
        8: [[0, 1], [2, 3], [4, 5], [6, 7]]
    }

    for (const count of Object.keys(expected).map(Number)) {
        const items = Array.from({ length: count }, (_, i) => ({ id: `id${i}`, text: `Button ${i + 1}` }))
        const built = buttons.createButtons(items)
        const shape = built.rows.map(row => row.map(button => Number(button.id.replace('id', ''))))
        eq(`${count} button(s) -> ${JSON.stringify(expected[count])}`, JSON.stringify(shape), JSON.stringify(expected[count]))

        ok(`${count} button(s): no row exceeds two`, built.rows.every(row => row.length <= 2))
        if (count % 2 === 1 && count > 1) {
            const last = built.rows[built.rows.length - 1]
            eq(`${count} button(s): the final button is alone`, last.length, 1)
        }
        ok(`${count} button(s): every button survives the layout`, built.flat.length === count)
    }

    section('lib/buttons -- existing ids and texts are preserved exactly')

    const preserved = buttons.createButtons([
        { id: 'shazam_audio_1_abc123', displayText: '🎧 AUDIO' },
        { id: 'shazam_video_2_abc123', displayText: '🎬 VIDEO' },
        { id: 'allmenu', displayText: '📚 All Menu' }
    ])

    eq('the first id is untouched', preserved.flat[0].id, 'shazam_audio_1_abc123')
    eq('the second id is untouched', preserved.flat[1].id, 'shazam_video_2_abc123')
    eq('the third id is untouched', preserved.flat[2].id, 'allmenu')
    eq('legacy displayText is used as the label', preserved.flat[0].text, '🎧 AUDIO')

    const native = JSON.parse(preserved.nativeFlow[0].buttonParamsJson)
    eq('the native flow button keeps its shape', preserved.nativeFlow[0].name, 'quick_reply')
    eq('the id reaches buttonParamsJson unchanged', native.id, 'shazam_audio_1_abc123')
    eq('the label reaches buttonParamsJson unchanged', native.display_text, '🎧 AUDIO')

    section('lib/buttons -- other button kinds still work')

    const mixed = buttons.createButtons([
        { id: 'ownermenu', text: '👑 Owner' },
        { url: 'https://example.com/channel', text: '📢 Channel' },
        { copy: 'DARKNOTE', text: '📋 Copy code' }
    ])
    eq('a link button becomes cta_url', mixed.nativeFlow[1].name, 'cta_url')
    eq('a copy button becomes cta_copy', mixed.nativeFlow[2].name, 'cta_copy')
    eq('the channel url survives',
        JSON.parse(mixed.nativeFlow[1].buttonParamsJson).url, 'https://example.com/channel')
    eq('the copied code survives',
        JSON.parse(mixed.nativeFlow[2].buttonParamsJson).copy_code, 'DARKNOTE')

    section('lib/buttons -- unusable input is dropped, never thrown')

    eq('empty input is a clean empty result', JSON.stringify(buttons.createButtons([])), JSON.stringify({ rows: [], flat: [], nativeFlow: [], texts: [] }))
    eq('null input is a clean empty result', buttons.createButtons(null).flat.length, 0)
    eq('a button with no id and no url is dropped', buttons.createButtons([{ text: 'Nowhere' }]).flat.length, 0)
    eq('a button with no text is dropped', buttons.createButtons([{ id: 'x' }]).flat.length, 0)
    eq('junk entries are ignored, real ones kept',
        buttons.createButtons([null, 42, 'nope', { id: 'ok', text: 'Fine' }]).flat.length, 1)

    section('lib/buttons -- long labels are trimmed to the platform limit')

    const long = buttons.createButtons([{ id: 'x', text: 'A'.repeat(200) }])
    eq('the label is capped at 24 characters', long.flat[0].text.length, 24)
}
