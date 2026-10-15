'use strict'

/*
 * DARKNOTE LEVEL 2 — the router.
 *
 * WHAT THIS IS. One function that sits between the socket and the command engine.
 * index.js already bound `handleMessage` to BIGBRO.js; this wraps that binding so
 * Level 2 can see a message FIRST and step aside for everything it does not own.
 *
 * TWO RULES MAKE IT SAFE:
 *
 *  1. IT IS NOT A SECOND LISTENER. Nothing new is subscribed to messages.upsert -
 *     the wrapper is called from the existing handler, so a message is still
 *     processed exactly once, by exactly one engine.
 *
 *  2. IT DEFAULTS TO PASSING THROUGH. Anything it does not explicitly own goes
 *     straight to the original handler, unchanged and unwrapped. If this module has
 *     a bug, the failure mode is "the bot behaves normally", not "the bot is silent".
 *
 * WHAT IT OWNS TODAY (the mode switch stage):
 *   performance   owner-only, works in either mode: mints a single-use entry link to
 *                 the interface and activates Level 2.
 *
 * WHAT IT DELIBERATELY DOES NOT DO YET: suppressing ordinary chat replies while
 * Level 2 is active. That belongs with the interface bridge (Stage 4), because
 * silencing a reply before the interface can display its result would just make
 * commands look broken. Until then the mode is recorded and honoured here, and the
 * bot keeps answering exactly as it does now.
 */

const level2Server = require('./server.js')
const ownerSystem = require('../lib/owner-system.js')
const config = require('../config.json')

/*
 * The keyword. Matched as a whole message (optionally with the bot's prefix), so it
 * cannot collide with an argument or a label inside another command, and matched in
 * either mode because it is the way BACK into Level 2.
 */
const COMMAND = /^(?:[./!#]?performance)$/i

/** The public address to build entry links from, if one has been configured. */
function publicBaseUrl() {
    const configured = String(process.env.DARKNOTE_L2_PUBLIC_URL || '').replace(/\/+$/, '')
    if (configured) return configured
    const host = process.env.DARKNOTE_L2_HOST && process.env.DARKNOTE_L2_HOST !== '0.0.0.0'
        ? process.env.DARKNOTE_L2_HOST
        : '127.0.0.1'
    const port = process.env.DARKNOTE_L2_PORT || 8787
    return `http://${host}:${port}`
}

const bodyOf = (m) => String(
    m?.body || m?.text ||
    m?.message?.conversation ||
    m?.message?.extendedTextMessage?.text ||
    m?.message?.ephemeralMessage?.message?.extendedTextMessage?.text ||
    ''
).trim()

/**
 * Handle `performance` and answer honestly about what happened.
 */
async function handlePerformance(conn, m) {
    const reply = async (text) => {
        try { await conn.sendMessage(m.chat, { text }, { quoted: m }) }
        catch (error) { console.error('[LEVEL2] could not send the entry link:', error?.message || error) }
    }

    if (!ownerSystem.isOwner(m, config)) {
        /*
         * FALL THROUGH, do not swallow. An entry link is access, so only the owner
         * gets one - but a non-owner's message must behave EXACTLY as it did before
         * Level 2 existed. Swallowing it would silently eat a message that the
         * normal engine would have handled, which is the one thing this router must
         * never do.
         */
        console.log('[LEVEL2] performance requested by a non-owner; handing it to the normal handler')
        return false
    }

    const base = publicBaseUrl()
    let link
    try {
        const created = level2Server.createLoginLink({ baseUrl: base })
        link = created.url
    } catch (error) {
        console.error('[LEVEL2] could not mint an entry link:', error?.message || error)
        await reply('❌ DARKNOTE LEVEL 2 is not reachable: its interface server is not running, so there is no link to give you.')
        return true
    }

    level2Server.writeStore({
        mode: 'level2',
        modeChangedAt: new Date().toISOString(),
        modeChangedBy: 'performance command'
    })
    console.log('[LEVEL2] mode activated by the performance command')

    const reachable = !/^http:\/\/(127\.0\.0\.1|localhost)/.test(link)
    await reply([
        '🟢 *DARKNOTE LEVEL 2 — ACTIVE*',
        '',
        'Open your phone interface:',
        link,
        '',
        reachable
            ? 'The link works once and expires in 10 minutes.'
            : '⚠️ This address is only reachable from the machine running the bot. Set DARKNOTE_L2_PUBLIC_URL (or a tunnel) to open it from your phone.',
        '',
        'The passcode is required after the link, and opens the phone.'
    ].join('\n'))
    return true
}

/**
 * Wrap the command engine. Returns a function with the same signature, so index.js
 * can keep calling `handleMessage(conn, m)` exactly as before.
 */
function wrap(original) {
    if (typeof original !== 'function') return original

    const routed = async function routedHandleMessage(conn, m) {
        try {
            /*
             * Only rewrite the message when this is definitely the Level 2 command
             * and we are definitely talking about a real incoming message. Anything
             * unexpected falls through to the original handler untouched.
             */
            if (m && m.chat && !m.key?.fromMe && COMMAND.test(bodyOf(m))) {
                const handled = await handlePerformance(conn, m)
                if (handled) return
            }
        } catch (error) {
            // A router fault must never swallow a message: log it and let the
            // original engine have the message as normal.
            console.error('[LEVEL2] router error, falling through to the normal handler:', error?.stack || error)
        }
        return original(conn, m)
    }

    /*
     * CARRY THE ORIGINAL'S OWN PROPERTIES ACROSS.
     *
     * Wrapping a function returns a NEW function, and anything attached to the old one
     * - `handleMessage.recordGroupActivity`, for instance - disappears with it. That
     * is not theoretical: the live log filled with
     *
     *   ❌ Group activity tracking error: handleMessage.recordGroupActivity is not a function
     *
     * because a caller reaches for a helper hung off the handler. Copying the own
     * properties keeps every such caller working, which is the whole point of wrapping
     * rather than replacing.
     */
    for (const key of Reflect.ownKeys(original)) {
        if (['length', 'name', 'prototype', 'arguments', 'caller'].includes(key)) continue
        try {
            Object.defineProperty(routed, key, Object.getOwnPropertyDescriptor(original, key))
        } catch (error) {
            console.error(`[LEVEL2] could not carry "${String(key)}" onto the router:`, error?.message || error)
        }
    }

    // Marked so index.js can re-apply the wrap after a hot reload without stacking
    // one wrapper on top of another.
    routed.__darknoteLevel2Routed = true
    routed.__darknoteOriginal = original
    return routed
}

/** Wrap only if it is not already wrapped. */
function ensureWrapped(handler) {
    if (typeof handler !== 'function') return handler
    if (handler.__darknoteLevel2Routed) return handler
    return wrap(handler)
}

module.exports = { wrap, ensureWrapped, handlePerformance, publicBaseUrl, COMMAND }
