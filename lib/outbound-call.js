'use strict'

/*
 * OUTBOUND CALLING — ringing a WhatsApp number from the bot.
 *
 * WHAT THIS DOES: sends a real WhatsApp call OFFER, so the number rings with an
 * incoming call from the bot. It is a genuine call offer on the protocol, not a
 * message pretending to be one.
 *
 * WHAT THIS DOES NOT DO: carry audio. This Baileys build has no call media stack
 * (no MLow/SFrame, no relay), so nothing can be heard in either direction. The call
 * rings and is then terminated, which the far end shows as a missed call. A voice
 * conversation is NOT implementable here, and nothing in this file pretends
 * otherwise.
 *
 * WHY IT IS BUILT ON sendNode. The installed build exposes no offerCall (verified:
 * the string appears nowhere in it; makeMessagesRecvSocket returns rejectCall only).
 * It does expose the same primitives its own rejectCall uses - sock.sendNode and the
 * binary node shape - so the offer is assembled exactly like the reject the library
 * itself sends, which is why the far end accepts it.
 */

const crypto = require('crypto')

/** How long a call rings before it is terminated, in ms. */
const DEFAULT_RING_MS = 15 * 1000
const MIN_RING_MS = 3 * 1000
const MAX_RING_MS = 60 * 1000

/** call-id -> { to, timer, terminated } for calls this process started. */
const active = new Map()

/** Can this socket place a call at all? */
function canCall(conn) {
    return Boolean(conn && typeof conn.sendNode === 'function' && conn.user?.id)
}

/** `254712345678` or a jid -> a normalised personal jid. */
function toJid(value) {
    const raw = String(value || '').trim()
    if (!raw) return ''
    if (raw.includes('@')) return raw
    const digits = raw.replace(/\D/g, '')
    return digits ? `${digits}@s.whatsapp.net` : ''
}

/**
 * Ring `jid` once.
 *
 * Resolves as soon as the offer is on the wire, and schedules the terminate so a
 * call is never left ringing on someone's phone. Resolves with the call id so the
 * caller can report it, and so a later terminate can be matched to it.
 */
async function offerCall(conn, jid, options = {}) {
    if (!canCall(conn)) {
        const error = new Error('this socket cannot place calls (no sendNode)')
        error.code = 'NO_CALL_SUPPORT'
        throw error
    }

    const to = toJid(jid)
    if (!to) {
        const error = new Error('a phone number or jid is required')
        error.code = 'BAD_TARGET'
        throw error
    }
    if (to.includes('@g.us')) {
        // Group calls need a group-call node this build has no API for.
        const error = new Error('group calls are not supported by this build')
        error.code = 'GROUP_UNSUPPORTED'
        throw error
    }
    if (active.has(to)) {
        const error = new Error('a call to that number is already ringing')
        error.code = 'ALREADY_RINGING'
        error.callId = active.get(to).callId
        throw error
    }

    const me = conn.user.id
    const callId = crypto.randomUUID().toUpperCase()

    /*
     * The offer node, mirroring what the library's own call handler expects to
     * parse on the way in: a <call> wrapper carrying one <offer> with call-id and
     * call-creator, plus the audio/net capability children.
     */
    const stanza = {
        tag: 'call',
        attrs: { from: me, to },
        content: [{
            tag: 'offer',
            attrs: { 'call-id': callId, 'call-creator': me, caller_pn: me },
            content: [
                { tag: 'audio', attrs: { enc: 'opus', rate: '16000' } },
                { tag: 'net', attrs: { medium: '3' } }
            ]
        }]
    }

    const ringMs = Math.min(MAX_RING_MS, Math.max(MIN_RING_MS, Number(options.ringMs) || DEFAULT_RING_MS))
    const entry = { callId, to, terminated: false, timer: null }
    active.set(to, entry)
    entry.timer = setTimeout(() => {
        terminateCall(conn, to, callId, 'timeout').catch(() => { })
    }, ringMs)
    if (entry.timer.unref) entry.timer.unref()

    try {
        await conn.sendNode(stanza)
    } catch (error) {
        clearTimeout(entry.timer)
        active.delete(to)
        throw error
    }

    return { callId, to, ringMs }
}

/**
 * End a call this process started. Safe to call twice, and safe to call for a call
 * that has already gone.
 */
async function terminateCall(conn, jid, callId, reason = 'timeout') {
    const to = toJid(jid)
    const entry = active.get(to)
    /*
     * Nothing tracked means there is nothing of OURS left to end: either the timer
     * already ended it, or this process never started a call to that number. Sending
     * a terminate anyway would put a stray frame on the wire for a call that is
     * already over, so this returns false instead - which is what makes calling it
     * twice harmless.
     */
    if (!entry || entry.terminated) return false
    const id = entry.callId || callId
    if (!id) return false
    entry.terminated = true
    if (entry.timer) clearTimeout(entry.timer)
    active.delete(to)
    if (!canCall(conn)) return false

    await conn.sendNode({
        tag: 'call',
        attrs: { from: conn.user.id, to },
        content: [{
            // 'timeout' is what a missed call reports, which is what this is: it rang
            // and nobody could be heard on it.
            tag: 'terminate',
            attrs: { 'call-id': id, 'call-creator': conn.user.id, reason }
        }]
    })
    return true
}

/** What is ringing right now (diagnostics, and used by the checks). */
function ringing() {
    return [...active.values()].map(({ callId, to }) => ({ callId, to }))
}

/** Drop the bookkeeping for a socket that is going away. */
function forget(conn) {
    for (const entry of active.values()) if (entry.timer) clearTimeout(entry.timer)
    active.clear()
}

module.exports = {
    offerCall,
    terminateCall,
    canCall,
    toJid,
    ringing,
    forget,
    DEFAULT_RING_MS,
    MIN_RING_MS,
    MAX_RING_MS
}
