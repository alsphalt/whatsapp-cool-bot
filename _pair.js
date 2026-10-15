#!/usr/bin/env node
'use strict'
/*
 * Standalone pairing helper for the DARKNOTE bot.
 *
 *   node _pair.js <countrycode+number>
 *
 * Prints an 8-character pairing code, then waits for the link to complete.
 * Credentials land in ./auth/ — the same directory index.js uses, so once this
 * finishes you can just `npm start`.
 *
 * Note: requestPairingCode() can only be sent once the server has delivered the
 * pair-device stanza, which this fork surfaces as the `qr` connection event.
 * Calling it any earlier fails with "Connection Closed". The project's own
 * lib/telegram-pairing.js already waits for that event AND for the raw
 * transport to be writable, so this script asks through it rather than
 * re-implementing the gate.
 *
 * IMPORTANT — ./auth/ BELONGS TO THE RUNNING BOT. This script refuses to touch
 * a folder that holds a linked session (exit 3). To pair a DIFFERENT number,
 * stop the bot and move ./auth/ aside first, otherwise the live session and this
 * pairing fight over the same credentials.
 *
 *   PAIR_AUTH_DIR=/tmp/scratch   use a different folder (safe dry runs)
 *   PAIR_WAIT_MS=60000           how long to wait for the code to be entered
 *   PAIR_DEBUG=1                 show the fork's own logs
 */
const path = require('path')
const pino = require('pino')

/*
 * The bot runs on the MZAZI fork — `mzazibaileys` — which is what index.js and
 * every lib/ module require. `@whiskeysockets/baileys` is NOT installed in this
 * project, so requiring it (as the original snippet did) fails at load.
 */
const {
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    fetchLatestWaWebVersion,
    makeCacheableSignalKeyStore
} = require('mzazibaileys')

// The project's own socket wrapper: exactly the options index.js pairs with
// (timeouts, keep-alive, retry cache, getMessage store).
const { makeWASocket, isAuthRegistered, wipeAuthFolder } = require('./lib/msg.js')
// The project's tested pairing-request path (pair-device gate + transport gate).
const { requestPairingCode } = require('./lib/telegram-pairing.js')

// This fork hardcodes a WA Web revision that the server can reject with a
// <failure> stanza. Negotiate the live revision instead, and fall back to the
// revision this bot is known to run on if the lookup fails.
const FALLBACK_VERSION = [2, 3000, 1049416828]
let waVersion = null

const raw = process.argv[2] || ''
const number = String(raw).replace(/\D/g, '')
const AUTH_DIR = process.env.PAIR_AUTH_DIR
    ? path.resolve(process.env.PAIR_AUTH_DIR)
    : path.join(__dirname, 'auth')
const WAIT_MS = Number(process.env.PAIR_WAIT_MS || 180000)
const MAX_SOCKETS = 3

// The bot already stores its custom pairing code here; fall back to the same
// literal when the file has none. An 8-character code is used as-is, anything
// else lets the fork generate one (see lib/telegram-pairing.js).
let customCode = 'DARKNOTE'
try {
    const stored = require('./config.json').pairingCode
    if (stored) customCode = String(stored)
} catch { /* config.json unreadable: keep the default */ }

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

let finished = false
let authState = null
let saveCreds = null
let sockets = 0
let newLoginSeen = false

const finish = (code, msg) => {
    if (finished) return
    finished = true
    log(msg)
    try { saveCreds && saveCreds() } catch {}
    setTimeout(() => process.exit(code), 1200)
}

async function requestCode(conn, attempt) {
    try {
        const code = await requestPairingCode(conn, number, customCode)
        const pretty = String(code).match(/.{1,4}/g).join('-')
        log(`PAIRING_CODE=${pretty}`)
        log('Enter it on WhatsApp: Settings > Linked devices > Link a device > "Link with phone number instead"')
        log(`Waiting up to ${Math.round(WAIT_MS / 1000)}s for the link to complete...`)
    } catch (err) {
        log(`pair code request failed (attempt ${attempt}): ${err?.message || err}`)
        if (attempt >= MAX_SOCKETS) return finish(1, 'PAIRING_FAILED: could not obtain a pairing code')
        setTimeout(() => start(attempt + 1), 3000)
    }
}

async function start(attempt = 1) {
    if (finished) return
    sockets++
    log(`opening socket ${attempt}/${MAX_SOCKETS}`)

    const conn = makeWASocket({
        logger: pino({ level: process.env.PAIR_DEBUG ? 'warn' : 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        version: waVersion,
        auth: {
            creds: authState.creds,
            keys: typeof makeCacheableSignalKeyStore === 'function'
                ? makeCacheableSignalKeyStore(authState.keys, pino({ level: 'silent' }))
                : authState.keys
        },
        syncFullHistory: false,
        fireInitQueries: true,
        // WhatsApp drops sessions that never mark themselves online, which is
        // fatal for a pairing socket that must stay reachable while the phone
        // enters the code.
        markOnlineOnConnect: true
    })

    /*
     * The pairing helpers read these flags. They are set here exactly as
     * index.js sets them on its own pairing socket, so the shared gates behave
     * the same way in both places.
     */
    conn.__darknoteCreatedAt = Date.now()
    conn.__darknoteConnectionState = 'connecting'
    conn.__darknoteRetired = false
    conn.__darknotePairingSocket = true

    conn.ev.on('creds.update', saveCreds)

    let requested = false
    const onUpdate = async (u) => {
        /*
         * Track the socket state in the form the shared pairing helpers read it.
         * A `qr` update carries `connection: null`, so mapping `u.connection`
         * alone never records 'qr' - and waitUntilPairingReady() then waits for a
         * SECOND qr event that never comes, timing out 15s later with "socket did
         * not enter pairing state in time". index.js sets the same three states
         * in its own handler; this mirrors it.
         */
        if (u.qr) conn.__darknoteConnectionState = 'qr'
        else if (u.connection === 'connecting') conn.__darknoteConnectionState = 'connecting'
        else if (u.connection === 'open') conn.__darknoteConnectionState = 'open'
        else if (u.connection === 'close') conn.__darknoteConnectionState = 'closed'

        // Server is ready for a pairing request at this point
        if (u.qr && !requested && !finished) {
            requested = true
            await requestCode(conn, attempt)
        }
        if (u.isNewLogin) {
            newLoginSeen = true
            log('PAIR_SUCCESS received from server')
        }
        if (u.connection === 'open') {
            log('connection open')
            if (newLoginSeen) return finish(0, 'PAIRED_OK')
        }
        if (u.connection === 'close') {
            conn.__darknoteRetired = true
            const status = u.lastDisconnect?.error?.output?.statusCode
            const data = u.lastDisconnect?.error?.data
            log(`connection closed (status ${status})${data ? ` data=${JSON.stringify(data)}` : ''}`)
            if (status === DisconnectReason.loggedOut) {
                return finish(1, 'PAIRING_FAILED: logged out — code rejected, expired, or the number is already linked')
            }
            if (status === 401) {
                return finish(1, 'PAIRING_FAILED: code rejected or expired')
            }
            // restartRequired (515) is normal right after a successful pair,
            // and 500/428 are transient — hop to a fresh socket.
            if (attempt >= MAX_SOCKETS) return finish(1, `PAIRING_FAILED: socket kept closing (last status ${status})`)
            setTimeout(() => start(attempt + 1), 3000)
        }
    }
    conn.ev.on('connection.update', onUpdate)
}

;(async () => {
    if (!number) {
        log('FATAL: no phone number given. Usage: node _pair.js 2547xxxxxxxx')
        process.exit(2)
    }
    log(`pairing number: +${number}`)
    log(`auth dir: ${AUTH_DIR}`)

    /*
     * Never touch a folder that holds a linked session. Pairing into it would
     * replace the credentials the running bot is using.
     */
    if (isAuthRegistered(AUTH_DIR)) {
        log('ALREADY_REGISTERED: auth/ already holds a linked session.')
        log('Delete the auth/ folder first if you want to pair a different number.')
        log('Stop the bot before doing that — it uses the same folder.')
        process.exit(3)
    }

    /*
     * A half-written creds.json from an earlier failed attempt makes WhatsApp
     * refuse the handshake (stream:error, then the socket closes before
     * requestPairingCode can be sent), which shows up as a pairing timeout.
     * index.js clears it in the same situation; only reached when the folder is
     * NOT a registered session, checked above.
     */
    wipeAuthFolder(AUTH_DIR)

    const state = await useMultiFileAuthState(AUTH_DIR)
    authState = state.state
    saveCreds = state.saveCreds

    try {
        const v = await fetchLatestWaWebVersion({})
        waVersion = v?.version || FALLBACK_VERSION
    } catch {
        waVersion = FALLBACK_VERSION
    }
    log(`WA Web version: ${JSON.stringify(waVersion)}`)
    log(`pairing code: ${customCode}`)

    await start(1)
    setTimeout(() => finish(1, 'PAIRING_TIMEOUT: nobody entered the code in time'), WAIT_MS)
})()

module.exports = { number, AUTH_DIR, requestCode, start }
