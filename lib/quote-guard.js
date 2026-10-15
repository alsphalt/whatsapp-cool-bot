'use strict'

/*
 * CAN WHATSAPP PREVIEW THIS MESSAGE IN A QUOTE?
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * Replying to a button tap produced this in the chat, inside the quote box:
 *
 *   "You received a message but your version of WhatsApp doesn't support it.
 *    Update WhatsApp"
 *
 * Nothing was broken in the bot and nothing had to be reconnected: a native-flow
 * button tap arrives as an `interactiveResponseMessage`, which carries no
 * renderable user content. When the next message is sent as a reply to it,
 * WhatsApp has to draw that message inside the quote bubble, cannot, and falls
 * back to the "Update WhatsApp" placeholder. The same happens for our HTML cards
 * (`botForwardedMessage` + `richResponseMessage`) and for the view-once
 * wrappers: they render once on arrival and cannot be re-rendered as a quote.
 * It is a CLIENT RENDERING limit, not a connection problem — which is why the
 * message looked like it "appeared after the card had been there a while".
 *
 * THE FIX
 * -------
 * Before quoting, check that the target message can actually be previewed. If it
 * cannot, send the same content WITHOUT the quote. Nothing functional depends on
 * the outgoing quote — it is decoration — so dropping it is always safe, and the
 * "Update WhatsApp" banner disappears.
 *
 * Usage: `conn.reply(...)` already applies this automatically (lib/msg.js), and
 * the pairing card uses `quoteOption()` where it builds its own payloads.
 */

/*
 * Types WhatsApp will not draw inside a quote bubble.
 *   interactiveResponseMessage / templateButtonReplyMessage / listResponseMessage
 *        — button, list and native-flow taps: the tap has no previewable body.
 *   buttonsResponseMessage — same class of reply, kept here so it cannot regress.
 *   richResponseMessage / botForwardedMessage — our AIRich HTML card and the
 *        wrapper it travels in.
 *   viewOnceMessage(V2/V2Extension) — view-once wrappers, also unquotable.
 *   protocolMessage — receipts/edits/deletes have no content at all.
 */
const UNQUOTABLE = new Set([
    'interactiveResponseMessage',
    'templateButtonReplyMessage',
    'listResponseMessage',
    'buttonsResponseMessage',
    'richResponseMessage',
    'botForwardedMessage',
    'viewOnceMessage',
    'viewOnceMessageV2',
    'viewOnceMessageV2Extension',
    'protocolMessage'
])

/** The wrapper key of a raw WhatsApp message object, e.g. 'conversation'. */
function wrapperType(message) {
    if (!message || typeof message !== 'object') return ''
    return Object.keys(message)[0] || ''
}

/** The message type of an smsg/M-like object, preferring Baileys' own `mtype`. */
function messageType(m) {
    if (!m || typeof m !== 'object') return ''
    if (typeof m.mtype === 'string' && m.mtype) return m.mtype
    return wrapperType(m.message) || wrapperType(m)
}

/** The payload inside a wrapper ({ viewOnceMessage: { message: {...} } }). */
function innerMessage(container, type) {
    const value = container?.[type]
    if (!value || typeof value !== 'object') return null
    // Wrappers carry the real message under `.message`; leaf content does not.
    return value.message && typeof value.message === 'object' ? value.message : null
}

/**
 * True when WhatsApp can draw this message inside a quote bubble.
 *
 * Wrappers are peeled (up to four deep) and the INNER type is checked too, so a
 * rich card hidden inside the forwarded wrapper is still caught.
 *
 * An UNKNOWN shape is deliberately allowed through. Call sites sometimes pass a
 * key-only object (`{ key }`, no body); WhatsApp resolves those against its own
 * local copy of the message and quotes them fine, so refusing them would break
 * working replies. Only a positively identified unquotable type is dropped.
 */
function quotableMessage(m) {
    if (!m || typeof m !== 'object') return false
    let message = m.message
    let type = messageType(m)
    if (!type) return true

    for (let depth = 0; depth < 4 && type; depth++) {
        if (UNQUOTABLE.has(type)) return false
        const container = message && typeof message === 'object' ? message : {}
        const inner = innerMessage(container, type) || innerMessage(m, type)
        if (!inner) return true
        const next = wrapperType(inner)
        if (!next || next === type) return true
        message = inner
        type = next
    }
    return true
}

/**
 * Spread into a send call: `{ ...quoteOption(m), ... }`.
 * Returns `{}` when the message must not be quoted, so the send still happens —
 * just without the quote bubble.
 */
function quoteOption(m) {
    return quotableMessage(m) ? { quoted: m } : {}
}

/*
 * THE `{ quoted: X }`-WHERE-X-WAS-EXPECTED TRAP
 * --------------------------------------------
 * `quoteOption(m)` returns an OPTIONS object (`{ quoted: m }`). A caller that
 * forwards a parameter literally named `quoted` therefore produces
 * `{ quoted: { quoted: m } }`, and Baileys reads `quoted.key.fromMe` on the inner
 * object — which has no `.key`, so the send dies with
 *
 *   TypeError: Cannot read properties of undefined (reading 'fromMe')
 *
 * That is not theoretical: `.runtime` passed `quoteOption(m)` through
 * `sendRuntimeCard` into `sendHtmlCard`, so every document send in that path threw
 * on the live bot (logs/console.log, 21:43:47 and 21:58:48).
 *
 * `unwrapQuote` makes the shape forgiving at the one boundary that matters: give it
 * either a WAMessage (has `.key`) or an options object wrapping one, and it returns
 * the WAMessage — or undefined when there is nothing quotable at all. Depth-capped
 * so a self-referential object cannot spin.
 */
function unwrapQuote(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 4) return undefined
    if (value.key) return value
    if (value.quoted) return unwrapQuote(value.quoted, depth + 1)
    return undefined
}

/**
 * Drop `options.quoted` when the quoted message cannot be previewed; return the
 * options untouched otherwise. Never throws — a malformed value keeps the old
 * behaviour rather than losing the send.
 */
function stripQuoted(options) {
    try {
        if (!options || typeof options !== 'object' || !options.quoted) return options
        if (quotableMessage(options.quoted)) return options
        const { quoted, ...rest } = options
        return rest
    } catch {
        return options
    }
}

module.exports = { quotableMessage, quoteOption, stripQuoted, unwrapQuote, messageType, wrapperType, UNQUOTABLE }
