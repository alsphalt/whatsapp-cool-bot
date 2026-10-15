'use strict'

/*
 * DARKNOTE — TELEGRAM PAIRING ENGINE
 * ----------------------------------
 * Keeps Telegram /pair timing separate from the Telegram UI and the WhatsApp
 * session registry. One call owns one socket/session; there is no global
 * pairing socket shared between Telegram users.
 */

const DEFAULT_TIMEOUT_MS = 15000

function digitsOnly(value) {
    return String(value || '').replace(/\D/g, '')
}

function validPhone(value) {
    return /^\d{8,15}$/.test(digitsOnly(value))
}

function socketState(conn) {
    return conn?.__darknoteConnectionState || ''
}

/**
 * Wait for the QR event before asking for a pairing code.
 *
 * This is the gate the official Baileys example uses:
 *
 *     if (qr && !sock.authState.creds.registered) {
 *         const code = await sock.requestPairingCode(phoneNumber)
 *     }
 *
 * The `qr` event is only emitted AFTER the WebSocket is open and the Noise
 * handshake with WhatsApp has completed. The `connecting` event, by contrast,
 * is emitted from process.nextTick() at socket creation - before the handshake -
 * and sending the companion_hello iq at that point makes WhatsApp terminate the
 * stream immediately, which is the "Connection Terminated" close seen right
 * after the code was issued. Waiting for `connecting` is therefore wrong even
 * though the request "succeeds" locally.
 */
function waitUntilPairingReady(conn, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!conn) return Promise.reject(new Error('WhatsApp socket is unavailable'))
    if (conn.__darknotePairingReady) return conn.__darknotePairingReady
    if (socketState(conn) === 'qr') return Promise.resolve()

    return new Promise((resolve, reject) => {
        let timer
        const cleanup = () => {
            clearTimeout(timer)
            try { conn.ev?.off?.('connection.update', onUpdate) } catch {}
            try { conn.ev?.removeListener?.('connection.update', onUpdate) } catch {}
        }
        const onUpdate = (update = {}) => {
            if (update.qr) {
                cleanup()
                resolve()
            } else if (update.connection === 'close') {
                cleanup()
                reject(new Error('WhatsApp socket closed before pairing started'))
            }
        }
        conn.ev?.on?.('connection.update', onUpdate)
        timer = setTimeout(() => {
            cleanup()
            reject(new Error('WhatsApp socket did not enter pairing state in time'))
        }, timeoutMs)
        /*
         * This promise is only ever awaited from inside a requestCode() call that
         * handles its rejection. It is NOT the raw __darknotePairingReady of a
         * pairing socket - bot-instance.js and createPairingSocket() both attach
         * their own no-op catch to that one, because a rejection nobody observes
         * reaches the process-level fatal guard and restarts DARKNOTE mid-pair.
         */
    })
}

/**
 * Wait for the raw transport to actually be WRITABLE.
 *
 * The ready gate above only waits for the `connecting` event, and the installed
 * fork emits that event from process.nextTick() at socket creation - BEFORE the
 * WebSocket opens. requestPairingCode() sends an iq node through that raw
 * socket, and Baileys throws Boom('Connection Closed') whenever `ws.isOpen` is
 * false, so calling the request straight after `connecting` fails every time.
 * This is a real event wait (the fork's own waitForSocketOpen(), or the raw
 * `open` event), not an artificial sleep.
 */
function waitForTransport(conn, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!conn) return Promise.reject(new Error('WhatsApp socket is unavailable'))
    if (conn.ws?.isOpen === true || conn.ws?.readyState === 1) return Promise.resolve()

    const open = typeof conn.waitForSocketOpen === 'function'
        ? conn.waitForSocketOpen()
        : new Promise((resolve, reject) => {
            const ws = conn.ws
            if (!ws) return reject(new Error('WhatsApp transport is unavailable'))
            const cleanup = () => {
                try { ws.off?.('open', onOpen) } catch { }
                try { ws.off?.('close', onFail) } catch { }
                try { ws.off?.('error', onFail) } catch { }
            }
            const onOpen = () => { cleanup(); resolve() }
            const onFail = (error) => {
                cleanup()
                reject(error instanceof Error ? error : new Error('WhatsApp transport closed before the pairing request could be sent'))
            }
            ws.on?.('open', onOpen)
            ws.on?.('close', onFail)
            ws.on?.('error', onFail)
        })

    let timer
    return Promise.race([
        open,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('WhatsApp transport did not open in time for pairing')), timeoutMs)
        })
    ]).finally(() => clearTimeout(timer))
}

/**
 * Ask the exact socket assigned to this Telegram pairing for one code.
 * No arbitrary sleep and no raw-WebSocket polling are used.
 */
async function requestPairingCode(conn, phone, customCode, options = {}) {
    const number = digitsOnly(phone)
    if (!validPhone(number)) throw new Error('invalid phone number')
    if (!conn || typeof conn.requestPairingCode !== 'function') {
        throw new Error('WhatsApp pairing is not available on this socket')
    }
    if (conn.__darknoteRetired) throw new Error('pairing socket was retired')

    await waitUntilPairingReady(conn, options.timeoutMs || DEFAULT_TIMEOUT_MS)

    if (conn.__darknoteRetired) throw new Error('pairing socket was retired')

    // The `connecting` gate is not enough on its own: the transport must be open
    // before requestPairingCode() can send its companion_hello node.
    await waitForTransport(conn, options.transportTimeoutMs || DEFAULT_TIMEOUT_MS)

    if (conn.__darknoteRetired) throw new Error('pairing socket was retired')

    const pairKey = String(customCode || '')
        .replace(/[^A-Za-z0-9]/g, '')
        .toUpperCase()

    /*
     * With no configured code we must pass an explicit EMPTY string, not omit
     * the argument: the fork declares `requestPairingCode(phone, pairKey =
     * "LEVICODE")`, so omitting it silently hands out the literal "LEVICODE"
     * instead of a generated code. An empty string is falsy and makes the fork
     * generate its own Crockford-safe 8-character code - the same alphabet
     * WhatsApp's own "Link with phone number" screen uses.
     */
    const request = pairKey.length === 8
        ? conn.requestPairingCode(number, pairKey)
        : conn.requestPairingCode(number, '')

    /*
     * THE REQUEST MUST NEVER BE AN UNHANDLED REJECTION.
     *
     * The race below is allowed to settle on its own timeout while the WhatsApp
     * request is still in flight. When that request then rejects - a restart
     * during pairing, a closed transport, `Connection Closed` - nothing is
     * listening any more, Node reports an unhandled promise rejection, and this
     * project's runtime guards treat that as FATAL: they call fatal() and
     * process.exit(1). That is the whole reason `.pair` used to take the bot
     * down instead of just failing.
     *
     * Attaching a no-op catch marks the rejection as observed. Promise.race
     * subscribes to this same promise, so its own behaviour is unchanged - a
     * rejection that arrives BEFORE the timeout still rejects the race.
     */
    if (request && typeof request.catch === 'function') request.catch(() => { })

    const timeoutMs = Number(options.requestTimeoutMs || 12000)
    let timer
    try {
        return await Promise.race([
            request,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('WhatsApp pairing-code request timed out')), timeoutMs)
            })
        ])
    } finally {
        clearTimeout(timer)
    }
}

module.exports = {
    digitsOnly,
    validPhone,
    waitUntilPairingReady,
    waitForTransport,
    requestPairingCode
}
