'use strict'

/*
 * DARKNOTE GLOBAL BUTTON SYSTEM
 * =============================
 * ONE place that decides how buttons are laid out, so every case/feature -
 * existing or future - gets the same structure without hand-designing rows.
 *
 * LAYOUT RULE (maximum two buttons per row; an odd count leaves the final
 * button alone on its own row):
 *
 *     1 -> [a]                    5 -> [a b] [c d] [e]
 *     2 -> [a b]                  6 -> [a b] [c d] [e f]
 *     3 -> [a b] [c]              7 -> [a b] [c d] [e f] [g]
 *     4 -> [a b] [c d]            8 -> [a b] [c d] [e f] [g h]
 *
 * HOW TO USE IT
 * -------------
 *     const { createButtons } = require('./lib/buttons.js')
 *     const built = createButtons([
 *         { id: 'general',  text: '⚙️ General' },
 *         { id: 'privacy',  text: '🔒 Privacy' },
 *         { id: 'security', text: '🛡️ Security' }
 *     ])
 *     // built.rows    -> [[general, privacy], [security]]
 *     // built.nativeFlow -> ready for interactiveMessage.nativeFlowMessage.buttons
 *
 * Existing callers keep working exactly as before: ids and display texts pass
 * through untouched, and the emitted button objects are byte-identical in shape
 * to what the code built by hand. Only the ORDER/grouping is decided here.
 *
 * WHY THE OUTPUT IS ALSO A FLAT ARRAY
 * -----------------------------------
 * WhatsApp renders quick_reply buttons client-side and the message protobuf used
 * by this project carries a FLAT list - there is no "row" field to set. So the
 * row grouping is applied here in button order (which is the part this bot can
 * control), and `.flat` / `.nativeFlow` hand the client the same list it has
 * always received. `.rows` is the canonical structure for anything that DOES
 * support explicit rows (e.g. single_select lists) and for tests.
 */

/** WhatsApp truncates quickly; keep display text inside the limit the codebase uses. */
const MAX_DISPLAY_TEXT = 24
const DEFAULT_MAX_PER_ROW = 2

function cleanText(value, max = MAX_DISPLAY_TEXT) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/[\r\n]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max)
}

/**
 * Turn any accepted button shape into one canonical shape.
 * Accepts the three kinds the bot actually uses:
 *   { id, text }            -> quick_reply (a callback id, handled by the dispatcher)
 *   { url, text }           -> cta_url    (opens a link)
 *   { copy, text }          -> cta_copy   (copies text to the clipboard)
 * `id`/`text` also accept the legacy aliases buttonId/displayText/action.
 */
function normaliseButton(item) {
    if (!item || typeof item !== 'object') return null

    const text = cleanText(item.text !== undefined ? item.text : item.displayText)
    if (!text) return null

    const url = item.url || item.ctaUrl || ''
    if (url) return { kind: 'cta_url', text, url: String(url), id: item.id === undefined ? undefined : String(item.id) }

    const copy = item.copy || item.copyCode || ''
    // `id` is optional here but is kept when supplied: the pairing button carries
    // one (darknote_pair_<code>) and some clients expect it present.
    if (copy) return { kind: 'cta_copy', text, copy: String(copy), id: item.id === undefined ? undefined : String(item.id) }

    const id = item.id !== undefined ? item.id : (item.buttonId !== undefined ? item.buttonId : item.action)
    if (id === undefined || id === null || String(id) === '') return null

    return { kind: 'quick_reply', text, id: String(id) }
}

/** Group buttons into rows of at most `maxPerRow`; an odd count leaves the last alone. */
function rowsFor(items, maxPerRow = DEFAULT_MAX_PER_ROW) {
    const size = Math.max(1, Math.min(DEFAULT_MAX_PER_ROW, Number(maxPerRow) || DEFAULT_MAX_PER_ROW))
    const rows = []
    for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size))
    return rows
}

/** One canonical button -> the object the project's interactive messages expect. */
function toNativeFlowButton(button) {
    if (button.kind === 'cta_url') {
        const params = { display_text: button.text, url: button.url }
        if (button.id) params.id = button.id
        return { name: 'cta_url', buttonParamsJson: JSON.stringify(params) }
    }
    if (button.kind === 'cta_copy') {
        const params = { display_text: button.text, copy_code: button.copy }
        if (button.id) params.id = button.id
        return { name: 'cta_copy', buttonParamsJson: JSON.stringify(params) }
    }
    return {
        name: 'quick_reply',
        buttonParamsJson: JSON.stringify({ display_text: button.text, id: button.id })
    }
}

/**
 * THE helper. Give it buttons, get rows + the flat list to send.
 * Returns `{ rows: [], flat: [], nativeFlow: [], texts: [] }` for empty input,
 * so callers can rely on the shape and never need a null check.
 */
function createButtons(items, options = {}) {
    const list = (Array.isArray(items) ? items : [])
        .map(normaliseButton)
        .filter(Boolean)

    const rows = rowsFor(list, options.maxPerRow)

    return {
        rows,
        flat: rows.flat(),
        nativeFlow: rows.flat().map(toNativeFlowButton),
        texts: list.map(button => button.text)
    }
}

/** Convenience: just the array for `nativeFlowMessage.buttons`. */
function nativeFlowButtons(items, options = {}) {
    return createButtons(items, options).nativeFlow
}

module.exports = {
    MAX_DISPLAY_TEXT,
    DEFAULT_MAX_PER_ROW,
    cleanText,
    normaliseButton,
    rowsFor,
    toNativeFlowButton,
    createButtons,
    nativeFlowButtons
}
