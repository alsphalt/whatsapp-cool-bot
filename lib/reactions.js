'use strict'

/*
 * DARKNOTE GLOBAL REACTION FEEDBACK
 * =================================
 * A command that does real work should acknowledge the message it was invoked
 * from, then settle on a final state. ONE helper so every command reacts the
 * same way and nobody hand-rolls `sendMessage({ react })` again.
 *
 *     const { withReaction } = require('./reactions.js')
 *
 *     case 'lyrics': {
 *         return withReaction(conn, m, async () => {
 *             ... existing work, untouched ...
 *         })
 *     }
 *
 * ⏳ while working, ✅ when it succeeded, ❌ when it failed. The wrapper is
 * strictly additive: the callback's return value (and any throw) passes straight
 * through, and a reaction failure can never abort a command, so behaviour is
 * unchanged when reactions cannot be delivered (e.g. a status broadcast chat).
 */

const START = '⏳'
const DONE = '✅'
const FAIL = '❌'

/**
 * Put one emoji on the message. Never throws: a chat that cannot be reacted to
 * must not be able to break the command that called this.
 */
async function setReaction(conn, m, emoji) {
    try {
        if (!conn || typeof conn.sendMessage !== 'function') return false
        if (!m?.chat || !m?.key) return false
        if (emoji === undefined || emoji === null || emoji === '') return false
        await conn.sendMessage(m.chat, { react: { text: String(emoji), key: m.key } })
        return true
    } catch (error) {
        return false
    }
}

/** Remove the reaction this bot placed on a message. */
async function clearReaction(conn, m) {
    return setReaction(conn, m, '')
}

/**
 * Work wrapped in reaction feedback.
 *
 * `work` may return anything; the value is passed straight back to the caller.
 * A result is treated as a failure when it explicitly says so (`ok === false` /
 * `status === false`), or when `isFailure` decides otherwise. A thrown error
 * leaves ❌ and re-throws, so the dispatcher's existing handling still applies.
 */
async function withReaction(conn, m, work, options = {}) {
    const startEmoji = options.start === undefined ? START : options.start
    if (startEmoji) await setReaction(conn, m, startEmoji)

    try {
        const result = await work()
        const failed = typeof options.isFailure === 'function'
            ? Boolean(options.isFailure(result))
            : Boolean(result && (result.ok === false || result.status === false))
        await setReaction(conn, m, failed ? (options.fail || FAIL) : (options.done || DONE))
        return result
    } catch (error) {
        await setReaction(conn, m, options.fail || FAIL)
        throw error
    }
}

/**
 * Play a SHORT SEQUENCE of reactions on one message, e.g. the `.menu` run
 * 🫵🏼💔🥱💀🌚💯✅. Each emoji REPLACES the previous one (that is how WhatsApp
 * reactions work - one per message), so the last one is what stays.
 *
 * WhatsApp rate limits reaction traffic, hence the gap between frames. Every
 * frame goes through setReaction(), which swallows its own errors, so a
 * sequence can never break the command that triggered it.
 */
async function reactSequence(conn, m, emojis, options = {}) {
    const frames = (Array.isArray(emojis) ? emojis : []).filter(Boolean)
    if (!frames.length) return false

    const gapMs = Number.isFinite(Number(options.gapMs)) ? Math.max(0, Number(options.gapMs)) : 300
    let placed = false
    for (let i = 0; i < frames.length; i++) {
        placed = await setReaction(conn, m, frames[i])
        if (i < frames.length - 1 && gapMs) {
            await new Promise(resolve => setTimeout(resolve, gapMs))
        }
    }
    return placed
}

/** The `.menu` reaction run, in order. The last frame is the resting state. */
const MENU_REACTIONS = ['🫵🏼', '💔', '🥱', '💀', '🌚', '💯', '✅']

module.exports = {
    setReaction,
    clearReaction,
    withReaction,
    reactSequence,
    MENU_REACTIONS,
    START,
    DONE,
    FAIL
}
