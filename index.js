/*
 * DARKNOTE LICENSE
 * Free to use and modify.
 * Please keep this credit notice in redistributed versions.
 * © DARKNOTE
 */
const fs = require('fs')
const path = require('path')
const { default: makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, DisconnectReason, Browsers, jidNormalizedUser } = require('mzazibaileys')
const pino = require('pino')
const logger = pino({ level: 'silent' })
const { Boom } = require('@hapi/boom')
const readline = require('readline')
const { smsg, makeWASocket: makeWASocketSimple, bind, wipeAuthFolder, isAuthRegistered } = require('./lib/msg.js')
const config = require('./config.json')
const terminal = require('./lib/terminal.js')

// Panel-only presentation: coloured logs + compact BIGBRO header.
terminal.install()
terminal.banner()
const { lookupStickerCommand } = require('./lib/sticker-commands.js')
const { captureMessage, handleIncomingProtocolDeletion, bindDeleteEvents } = require('./lib/antidelete.js')
// The single anti-feature security engine. One engine, one participant listener.
const security = require('./lib/security.js')

let handleMessage = require('./BIGBRO.js')
const groupFeatures = require('./lib/group-features.js')

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
})

const question = (text) => new Promise((resolve) => rl.question(text, resolve))

/*
 * RUNTIME ALIVE owns the socket lifecycle: one socket, one reconnect timer with
 * backoff, honest connection state, crash guards. See lib/runtime.js.
 */
const runtimeMonitor = require('./lib/runtime.js')
let telegram = null
try {
    telegram = require('./lib/telegram.js')
} catch (error) {
    console.error('[TELEGRAM] controller could not be loaded:', error?.message || error)
}

const telegramPairing = require('./lib/telegram-pairing.js')
const sessionStore = require('./lib/session.js')
const sessionRegistry = require('./lib/sessions.js')
const { createBotInstance } = require('./lib/bot-instance.js')

runtimeMonitor.installGuards()
runtimeMonitor.startMonitor()

/*
 * WHO OWNS PAIRING.
 *
 * 'console'  - the original blocking prompt on stdin (default, unchanged).
 * 'telegram' - the Telegram controller drives it; the console prompt is skipped
 *              so startup is never blocked waiting on input nobody can see.
 */
let pairingOwner = 'console'
let currentMainConn = null
const PAIR_CASE_CODES = ['DARKNOTE', 'DARKNT23', 'BIGBRO56', 'DEADNOTE', 'UNSENBRO']

/*
 * PAIRING WINDOW.
 *
 * Pairing requests are time-sensitive. Baileys/levvleys expects the request
 * after the socket enters its `connecting` phase; waiting for raw WebSocket OPEN
 * is too late and can produce a close-before-pairing failure.
 */
const PAIRING_WINDOW_MS = 20000
const PAIRING_REQUEST_TIMEOUT_MS = 12000
/*
 * How many times a pairing socket may re-open itself while it waits for the
 * phone to enter the code. WhatsApp closes the transport as soon as it has
 * answered companion_hello and then only delivers the approving
 * `companion_finish` node on a NEW socket, so one bounded keep-alive is what
 * makes the code redeemable at all. See createPairingSocket().
 */
const PAIRING_RESUME_MAX_ATTEMPTS = 600

/** Safely tear down a socket without triggering the "closed before established" crash. */
async function safeRetireSocket(conn, reason = 'retired') {
    if (!conn) return
    try { conn.__darknoteRetired = true } catch { }
    try { runtimeMonitor.unregister(conn) } catch { }
    try { conn.ev?.removeAllListeners?.('connection.update') } catch { }

    const wsState = conn.ws?.readyState

    // readyState: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
    if (wsState === 0 || (wsState === undefined && conn.ws?.isOpen === false)) {
        // Handshake never finished. end() throws inside Baileys' async stack.
        try { conn.ws?.terminate?.() } catch { }
        try { conn.ws?.close?.() } catch { }
    } else if (wsState === 1 || conn.ws?.isOpen === true) {
        try { await conn.end?.(new Error(reason)) } catch { }
    }

    await new Promise(resolve => setTimeout(resolve, 250))
}

function socketIsOpen(conn) {
    if (!conn) return false
    return conn.ws?.isOpen === true || conn.ws?.readyState === 1
}

/**
 * levvleys exposes waitForSocketOpen on some builds, while older builds only
 * expose the underlying ws. Pairing needs the transport to be writable before
 * requestPairingCode() sends its companion_hello node. This is NOT an
 * artificial sleep: it resolves immediately on the real `open` event.
 */
async function waitForPairingTransport(conn, timeoutMs = 12000) {
    if (socketIsOpen(conn)) return

    if (typeof conn.waitForSocketOpen === 'function') {
        await Promise.race([
            conn.waitForSocketOpen(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('WhatsApp transport did not open in time')), timeoutMs))
        ])
        if (!socketIsOpen(conn) && conn.ws?.readyState !== undefined) {
            throw new Error('WhatsApp transport closed before pairing request could be sent')
        }
        return
    }

    await new Promise((resolve, reject) => {
        let timer
        const ws = conn.ws
        const cleanup = () => {
            clearTimeout(timer)
            try { ws?.off?.('open', onOpen) } catch {}
            try { ws?.off?.('error', onError) } catch {}
            try { ws?.off?.('close', onClose) } catch {}
            try { conn.ev?.off?.('connection.update', onUpdate) } catch {}
        }
        const finish = (error) => {
            cleanup()
            error ? reject(error) : resolve()
        }
        const onOpen = () => finish()
        const onError = (error) => finish(error instanceof Error ? error : new Error('WhatsApp transport error'))
        const onClose = () => finish(new Error('WhatsApp transport closed before pairing request could be sent'))
        const onUpdate = (update = {}) => {
            if (update.connection === 'close') onClose()
        }
        if (socketIsOpen(conn)) return finish()
        ws?.on?.('open', onOpen)
        ws?.on?.('error', onError)
        ws?.on?.('close', onClose)
        conn.ev?.on?.('connection.update', onUpdate)
        timer = setTimeout(() => finish(new Error('WhatsApp transport did not open in time')), timeoutMs)
    })
}

/**
 * Ask WhatsApp for a pairing code.
 *
 * IMPORTANT: Baileys/levvleys pairing must be requested after the socket has
 * entered the `connecting` phase (or emitted a QR/connecting update), but we
 * must NOT wait for the raw WebSocket to become OPEN. Waiting for ws.readyState
 * was the source of the "pairing socket closed before it opened" failure.
 */
async function requestCode(conn, phone, sessionId = 'main', customCode = '') {
    if (!conn || typeof conn.requestPairingCode !== 'function') {
        throw new Error('this socket cannot request a pairing code')
    }

    const digits = telegramPairing.digitsOnly(phone)
    if (!telegramPairing.validPhone(digits)) {
        throw new Error('invalid phone number')
    }

    if (conn.__darknoteRetired) throw new Error('pairing socket was retired')
    if (runtimeMonitor.currentSocket(sessionId) !== conn) {
        throw new Error('pairing socket was replaced')
    }

    const configuredPairingCode = String(customCode || config.pairingCode || '')
        .replace(/[^A-Za-z0-9]/g, '')
        .toUpperCase()

    // No artificial sleep and no raw-WebSocket OPEN polling. The dedicated
    // Telegram pairing engine waits for Baileys' actual connecting/QR event,
    // then immediately calls requestPairingCode on this exact session socket.
    const code = await telegramPairing.requestPairingCode(
        conn,
        digits,
        configuredPairingCode,
        {
            /*
             * The ready gate waits for a QR event, and WhatsApp rotates QR refs
             * only about every 20s - so a 20s window could expire between two
             * refs and throw the request away. That is the multi-number `!pair`
             * path, which has no pre-armed __darknotePairingReady promise, so it
             * needs room for at least one ref. Still bounded, and the first
             * number is unaffected (its promise resolves on the first QR event).
             */
            timeoutMs: Math.max(PAIRING_WINDOW_MS, 60000),
            requestTimeoutMs: PAIRING_REQUEST_TIMEOUT_MS
        }
    )

    if (conn.__darknoteRetired) throw new Error('pairing socket was retired')
    if (runtimeMonitor.currentSocket(sessionId) !== conn) {
        throw new Error('pairing socket was replaced')
    }
    if (!code || typeof code !== 'string') {
        throw new Error('WhatsApp returned an empty pairing code')
    }
    return code
}

/*
 * ============================================================================
 * PAIRING SOCKET FACTORY
 * ============================================================================
 *
 * Creates a dedicated, single-purpose socket for ONE pairing request.
 *
 * Why this exists: the long-lived `auth/` socket is created at boot and lives
 * for hours. By the time a Telegram user types `/pair`, that socket has long
 * left WhatsApp's pairing window and `requestPairingCode` fails silently.
 *
 * So we do what the console flow has always done: open a fresh socket, ask for
 * the code immediately, and let it become the live socket after pairing.
 *
 * Pairing sockets are exempt from auto-reconnect. If they close (status 515 is
 * normal for unregistered sessions), the user hits /pair again and gets a new
 * one — they are never silently respawned.
 */
async function createPairingSocket(authDir, sessionId = 'main', options = {}) {
    // Retire any existing unregistered socket on this session folder — safely.
    const existing = runtimeMonitor.currentSocket(sessionId)
    if (existing && !existing.__darknoteRetired) {
        await safeRetireSocket(existing, 'replaced for pairing')
    }

    /*
     * Wipe any half-written auth folder before building a pairing socket.
     *
     * A partial creds.json from a previous failed /pair makes WhatsApp refuse
     * the handshake: Baileys opens the WebSocket, receives a stream:error, and
     * closes it before `requestPairingCode` can be sent. That produces the
     * "pairing socket did not open in time" timeout.
     *
     * Only safe because pairing sockets are ALWAYS created for unregistered
     * sessions — never for a live one. `isAuthRegistered` verifies that first.
     */
    if (options.keepAuth) {
        // Keep-alive path. auth/ now holds the half-finished pairing state
        // (creds.json with `me` + `pairingCode` while registered === false).
        // Wiping it here would discard the pairing that is already in flight.
        console.log('[PAIR] re-opening the pairing socket without clearing auth')
    } else if (!isAuthRegistered(authDir)) {
        wipeAuthFolder(authDir)
    } else {
        console.log('[PAIR] auth folder already holds a registered session — not wiping')
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir)

    const conn = makeWASocketSimple({
        logger,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        auth: {
            creds: state.creds,
            keys: typeof makeCacheableSignalKeyStore === 'function'
                ? makeCacheableSignalKeyStore(state.keys, logger)
                : state.keys
        },
        syncFullHistory: false,
        fireInitQueries: true,
        // WhatsApp drops sessions that never mark themselves online, which is
        // fatal for a pairing socket that must stay reachable while the phone
        // enters the code. Listed in the Baileys pairing checklist.
        markOnlineOnConnect: true,
        keepAliveIntervalMs: 20000,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        enableRecentMessageCache: true
    })

    conn.__darknoteCreatedAt = Date.now()
    conn.__darknoteConnectionState = 'connecting'
    conn.__darknoteConnectingSeen = false
    conn.__darknoteSessionId = sessionId
    conn.__darknoteRetired = false
    // Pairing sockets are short-lived and MUST NOT be auto-reconnected.
    conn.__darknotePairingSocket = true

    /*
     * Gate pairing on the QR event, exactly like the official Baileys example:
     *
     *     if (qr && !sock.authState.creds.registered) await sock.requestPairingCode(number)
     *
     * `qr` arrives only after the WebSocket is open and the Noise handshake has
     * completed. Gating on `connecting` (emitted from process.nextTick at socket
     * creation, before the handshake) makes WhatsApp tear the stream down the
     * moment companion_hello is sent - the "Connection Terminated" close that
     * appeared one second after every code was issued.
     */
    conn.__darknotePairingReady = new Promise((resolve, reject) => {
        let settled = false
        const cleanup = () => {
            try { conn.ev?.off?.('connection.update', onUpdate) } catch { }
            try { conn.ev?.removeListener?.('connection.update', onUpdate) } catch { }
        }
        const onUpdate = (update = {}) => {
            if (settled) return
            if (update.qr) {
                settled = true
                conn.__darknoteConnectionState = 'qr'
                cleanup()
                resolve()
            } else if (update.connection === 'close') {
                settled = true
                cleanup()
                reject(new Error('pairing socket closed before pairing started'))
            }
        }
        conn.ev?.on?.('connection.update', onUpdate)
        // Do not add a timer here: pairing starts as soon as Baileys emits the
        // QR event. requestCode() has its own safety timeout.
    })
    // An abandoned pairing must not surface as an unhandled rejection - the
    // runtime guards treat that as FATAL and restart the whole panel, which is
    // how an unpaired socket took the bot down.
    conn.__darknotePairingReady.catch(() => { })

    runtimeMonitor.register(conn, sessionId)
    // Fast-login optimization: keep the pairing socket lightweight until
    // WhatsApp finishes the authentication handshake.
    conn.__darknoteHandlersBound = false

    if (!conn.__darknoteSecurityBound && conn.ev?.on) {
        conn.__darknoteSecurityBound = true
        conn.ev.on('group-participants.update', async (update) => {
            try {
                const results = await security.handleParticipants(conn, update, {
                    selfIds: [conn.user?.id, conn.user?.lid].filter(Boolean)
                })
                for (const result of results || []) {
                    console.log(`[SECURITY] ${result.feature} -> ${result.performed.join('+')} (strike ${result.strike})${result.restored === false ? ' restore refused' : result.restored ? ' restored' : ''}`)
                }
            } catch (error) {
                console.error('[SECURITY] participant handling failed:', error?.stack || error)
            }
        })
    }

    conn.ev.on('creds.update', saveCreds)

    conn.ev.on('connection.update', (update) => {
        const { connection } = update
        if (connection === 'open') {
            conn.__darknoteConnectionState = 'open'
            // The pairing socket is now the live DARKNOTE session.
            conn.__darknotePairingSocket = false
            // Linked: the code no longer needs refreshing.
            stopPairingRefresh()
            if (!conn.__darknoteHandlersBound) {
                conn.__darknoteHandlersBound = true
                bind(conn)
                bindDeleteEvents(conn)
            }
            // Only mark the runtime open once the socket is actually registered.
            // An unregistered socket that reports "open" mid-pairing would
            // confuse the runtime's reconnect decisions.
            try {
                const creds = conn.authState?.creds
                if (creds?.me?.id) runtimeMonitor.markOpen?.()
            } catch { }
        } else if (connection === 'close') {
            conn.__darknoteConnectionState = 'closed'
            /*
             * PAIRING WINDOW KEEP-ALIVE.
             *
             * WhatsApp answers companion_hello by closing the transport
             * (statusCode 428) and only pushes the approving
             * `link_code_companion_reg / companion_finish` node - the node that
             * actually completes the link - on a NEW socket. Nothing else in the
             * bot reconnects an unregistered socket, so without this the pair
             * window would be dead the instant the code was printed.
             *
             * Deliberately bounded: the code is never re-requested, auth/ is
             * never wiped, and the retries stop after
             * PAIRING_RESUME_MAX_ATTEMPTS. `creds.me` is already set by
             * requestPairingCode(), so each re-opened socket performs a LOGIN
             * for the pending device - which is exactly what lets WhatsApp
             * deliver companion_finish.
             */
            if (conn.__darknoteRetired) return

            /*
             * PAIRED - LOG IN NOW.
             *
             * WhatsApp answers pair-success with stream:error 515 ("Stream
             * Errored (restart required)"). That is NOT a failure: the client is
             * expected to reconnect immediately using the credentials that were
             * just written to auth/. Leaving this to the next manual restart is
             * why the bot sat idle on a perfectly valid session and "took
             * forever to log in".
             */
            if (sessionId === 'main' && isAuthRegistered(authDir)) {
                conn.__darknoteRetired = true
                try { runtimeMonitor.unregister(conn) } catch { }
                console.log('[PAIR] link accepted; logging in with the new credentials')
                setTimeout(() => {
                    connectToWhatsApp().catch((error) => console.error('[PAIR] post-pair connect failed:', error?.message || error))
                }, 0)
                return
            }
            if (isAuthRegistered(authDir)) return

            /*
             * WHATSAPP ENDED THIS OPPORTUNITY.
             *
             * After a fixed number of QR refs (roughly two minutes) the server
             * closes the socket with "QR refs attempts ended" - that pairing
             * window is over no matter how recently the code was re-armed.
             * Re-opening the same socket is pointless: creds.me is set, so the
             * new connection performs a LOGIN for a still-unregistered device
             * and is refused ("Connection Failure"). So start a completely fresh
             * pairing socket instead - the wipe gives a new noise key, WhatsApp
             * issues a fresh set of QR refs, and the same code is re-armed on it.
             * That is what keeps a valid window available continuously rather
             * than for a single two-minute shot.
             */
            const closeReason = String(update?.lastDisconnect?.error?.message || '')
            if (/QR refs|attempts ended/i.test(closeReason) && pendingPairPhone) {
                console.log('[PAIR] WhatsApp ended this pairing window (QR refs exhausted) - opening a fresh one')
                createPairingSocket(authDir, sessionId)
                    .then((fresh) => requestCode(fresh, pendingPairPhone, sessionId)
                        .then((code) => {
                            console.log(`[PAIR] fresh window armed for +${pendingPairPhone} (code ${code})`)
                            startPairingRefresh(pendingPairPhone, sessionId, authDir)
                        })
                        .catch((error) => console.log(`[PAIR] fresh window could not be armed: ${error?.message || String(error)}`)))
                    .catch((error) => console.error('[PAIR] fresh window failed:', error?.message || String(error)))
                return
            }

            const attempt = Number(conn.__darknoteResumeAttempts || 0) + 1
            if (attempt > PAIRING_RESUME_MAX_ATTEMPTS) {
                console.log('[PAIR] pairing window expired; ask the panel for a new code.')
                return
            }
            // Per the Baileys pairing checklist, the reconnect after the
            // server's 428/515 must be immediate - a growing delay is what makes
            // the session look stale. 500ms is only there to avoid a tight loop.
            const delay = 500
            console.log(`[PAIR] transport closed while waiting for the phone; re-opening (${attempt}/${PAIRING_RESUME_MAX_ATTEMPTS}) in ${Math.round(delay / 1000)}s`)
            setTimeout(() => {
                if (conn.__darknoteRetired) return
                createPairingSocket(authDir, sessionId, { keepAuth: true })
                    .then((resumed) => { resumed.__darknoteResumeAttempts = attempt })
                    .catch((error) => console.error('[PAIR] re-open failed:', error?.message || String(error)))
            }, delay)
        } else if (connection === 'connecting') {
            conn.__darknoteConnectionState = 'connecting'
            conn.__darknoteConnectingSeen = true
        }
    })

    conn.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            let m = chatUpdate.messages[0]
            if (!m.message) return
            runtimeMonitor.noteActivity?.()
            if (m.key?.remoteJid === 'status@broadcast') {
                try { handleMessage.enqueueStatusAutomation(conn, m) } catch (error) {
                    console.error('❌ Status automation enqueue error:', error?.message || error)
                }
                return
            }
            try { await handleIncomingProtocolDeletion(conn, m) } catch (error) {
                console.error('❌ Antidelete revoke detection error:', error?.message || error)
            }
            try { await captureMessage(conn, m) } catch (error) {
                console.error('❌ Antidelete retention error:', error?.message || error)
            }
            let processedMsg
            try { processedMsg = await smsg(conn, m) } catch (err) {
                console.error('❌ smsg error:', err.message)
                return
            }
            if (!processedMsg) return
            processedMsg.__darknoteConn = conn
            if (config.autoread) {
                try { await conn.readMessages([m.key]) } catch (error) {
                    console.error('❌ Autoread failed:', error?.message || error)
                }
            }
            try { handleMessage.recordGroupActivity(processedMsg) } catch (error) {
                console.error('❌ Group activity tracking error:', error?.message || error)
            }
            try {
                const { handleAntiLink } = require('./lib/protected-antilink.js')
                if (await handleAntiLink(conn, processedMsg)) return
            } catch (error) {
                console.error('❌ AntiLink integration error:', error?.stack || error)
            }
            if (typeof handleMessage.handleAutomaticViewOnce === 'function') {
                await handleMessage.handleAutomaticViewOnce(conn, m)
            }
            if (!processedMsg.fromMe && processedMsg.mtype === 'stickerMessage') {
                const explicit = String(processedMsg.text || '').trim()
                const hasExplicitCommand = explicit.startsWith(config.prefix || '.')
                if (!hasExplicitCommand) {
                    const trigger = await lookupStickerCommand(processedMsg, conn)
                    if (trigger?.command) {
                        processedMsg.__darknoteSyntheticCommand = `${config.prefix || '.'}${trigger.command}`
                        await handleMessage(conn, processedMsg)
                        return
                    }
                }
            }
            const presence = config.autorecoding ? 'recording' : (config.autotyping ? 'composing' : '')
            if (presence) {
                try { await conn.sendPresenceUpdate(presence, processedMsg.chat) } catch (error) {
                    console.error('❌ Presence update failed:', error?.message || error)
                }
            }
            await handleMessage(conn, processedMsg)
            if (presence) {
                try { await conn.sendPresenceUpdate('paused', processedMsg.chat) } catch (error) {
                    console.error('❌ Presence reset failed:', error?.message || error)
                }
            }
        } catch (err) {
            console.error('❌ messages.upsert error:', err)
        }
    })

    return conn
}

/**
 * Reuse an in-window unregistered socket, otherwise build a fresh one.
 */
async function getFreshPairingSocket(sessionId = 'main', authDir = 'auth') {
    const existing = runtimeMonitor.currentSocket(sessionId)
    // Only ever reuse a real PAIRING socket. The boot socket is not one: it has
    // no __darknotePairingReady promise, so the QR gate falls back to waiting on
    // a live event, and since the server rotates QR refs only every ~20s that
    // wait expired before a ref arrived ("WhatsApp socket did not enter pairing
    // state in time") and the whole request was thrown away.
    if (existing && !existing.__darknoteRetired && existing.__darknotePairingSocket) {
        const age = Date.now() - (existing.__darknoteCreatedAt || 0)
        const state = existing.__darknoteConnectionState
        if (age < PAIRING_WINDOW_MS && state !== 'open' && state !== 'closed') {
            return existing
        }
    }
    return createPairingSocket(authDir, sessionId)
}

/*
 * Secondary instances created via Telegram.
 */
const secondaryInstances = new Map()

/*
 * Bounded re-arm budget per secondary session. WhatsApp drops a pairing socket
 * right after companion_hello and only delivers the approval on a new socket, so
 * each additional number needs its window kept alive (see onClose below).
 */
const SECONDARY_PAIRING_RESUME_MAX = 20
const secondaryPairingResume = new Map()
const pendingTelegramPairs = new Map()
const mainPairInFlight = new Set()
const secondaryPairInFlight = new Set()

function sessionNumberFromState(state) {
    return String(state?.creds?.me?.id || '').split('@')[0].split(':')[0].replace(/\D/g, '')
}

function getBaileysVersion() {
    try { return String(require('mzazibaileys/package.json').version || 'unknown') }
    catch { return 'unknown' }
}

async function startSecondarySession(record) {
    const id = String(record?.id || '')
    if (!id || id === sessionRegistry.PRIMARY_ID) throw new Error('invalid secondary session id')
    const existing = secondaryInstances.get(id)
    if (existing) return existing

    const authDir = sessionRegistry.sessionDir(id)
    let instance
    const onOpen = () => {
        const livePhone = sessionNumberFromState(instance?.state) || record.phone
        sessionRegistry.update(id, {
            pairedAt: record.pairedAt || Date.now(),
            lastConnectedAt: Date.now(),
            lastError: '',
            state: 'CONNECTED',
            phone: livePhone,
            baileys: getBaileysVersion(),
            platform: 'DARKNOTE'
        })
        // Registered and live: this number no longer needs its window re-armed.
        secondaryPairingResume.delete(id)
        console.log(`[${id}] session is live; no panel restart required`)

        const telegramUserId = String(record.telegramUserId || '')
        if (telegramUserId && config.telegram?.enabled !== false && telegram?.sendMessage) {
            telegram.sendMessage(telegramUserId, [
                '✅ *WHATSAPP LOGIN SUCCESSFUL*',
                '',
                `Your WhatsApp number +${livePhone} has successfully connected to DARKNOTE.`,
                `Session: ${id}`,
                '',
                '🤖 Your bot is now active and running automatically.'
            ]).catch(error => console.error(`[${id}] Telegram success notification failed:`, error?.message || error))
        }
    }
    const onClose = async (reason) => {
        secondaryInstances.delete(id)
        if (reason === 'pairing-closed') {
            /*
             * KEEP THIS NUMBER'S PAIRING WINDOW ALIVE.
             *
             * WhatsApp closes a pairing socket almost immediately after
             * companion_hello (status 428) and only delivers the approving
             * pair-success on a NEW socket. Marking the session DISCONNECTED here
             * and waiting for another /pair request is what made a SECOND number
             * practically unpairable.
             *
             * So re-open the SAME session - createBotInstance never wipes authDir,
             * so the pending `me` + pairingCode survive - and re-arm the code on
             * the fresh socket. Bounded, and it stops as soon as the session
             * registers. The first number is unaffected: it lives in `auth/` and
             * has its own keep-alive in createPairingSocket().
             */
            const attempts = Number(secondaryPairingResume.get(id) || 0) + 1
            const current = sessionRegistry.get(id) || record
            const phone = String(current?.phone || '').replace(/\D/g, '')
            let registered = false
            try { registered = isAuthRegistered(sessionRegistry.sessionDir(id)) } catch { }

            if (registered) {
                secondaryPairingResume.delete(id)
                return
            }

            if (phone && attempts <= SECONDARY_PAIRING_RESUME_MAX) {
                secondaryPairingResume.set(id, attempts)
                console.log(`[${id}] pairing socket closed; re-arming this number's window (${attempts}/${SECONDARY_PAIRING_RESUME_MAX})`)
                setTimeout(() => {
                    startSecondarySession(sessionRegistry.get(id) || current)
                        .then((fresh) => requestCode(fresh.conn, phone, id, pickPairCaseCode())
                            .then((code) => console.log(`[${id}] pairing window re-armed for +${phone} (code ${code})`))
                            .catch((error) => console.log(`[${id}] pairing re-arm failed: ${error?.message || String(error)}`)))
                        .catch((error) => console.log(`[${id}] pairing re-open failed: ${error?.message || String(error)}`))
                }, 1500)
                return
            }

            sessionRegistry.update(id, { state: 'DISCONNECTED', lastError: 'Pairing socket closed; send /pair to try again.' })
            return
        }
        if (reason === 'logged-out') {
            sessionRegistry.update(id, { state: 'AUTH_REQUIRED', lastError: 'WhatsApp logged out this session' })
            return
        }
        try {
            await startSecondarySession(sessionRegistry.get(id) || record)
        } catch (error) {
            const message = error?.message || String(error)
            sessionRegistry.update(id, { state: 'DISCONNECTED', lastError: message })
            runtimeMonitor.noteError(error, id)
            const retry = runtimeMonitor.scheduleReconnect(() => startSecondarySession(sessionRegistry.get(id) || record), id)
            console.error(`[${id}] rebuild failed: ${message}; retrying in ${retry ? Math.round(retry / 1000) + 's' : 'n/a'}`)
        }
    }

    instance = await createBotInstance({
        sessionId: id,
        authDir,
        requestCode: (conn, phone) => requestCode(conn, phone, id),
        pairingOwner: () => 'telegram',
        consolePairing: false,
        primary: false,
        onOpen,
        onClose
    })
    secondaryInstances.set(id, instance)
    const registered = instance.isRegistered()
    sessionRegistry.update(id, {
        state: registered ? 'CONNECTED' : 'CONNECTING',
        phone: sessionNumberFromState(instance.state) || record.phone,
        pairedAt: registered ? (record.pairedAt || Date.now()) : (record.pairedAt || 0),
        baileys: getBaileysVersion(),
        platform: 'DARKNOTE'
    })
    return instance
}

/**
 * Pair a number for Telegram.
 *
 * Creates its OWN fresh socket and asks for the code immediately.
 */
async function pairSession(phone, telegramUserId) {
    const digits = String(phone || '').replace(/\D/g, '')
    if (!/^\d{8,15}$/.test(digits)) return { ok: false, reason: 'invalid-number' }

    const owner = String(telegramUserId || '')
    const pairLock = `${owner}:${digits}`
    if (secondaryPairInFlight.has(pairLock) || mainPairInFlight.has('main')) {
        // A different number can still pair in its own isolated session; only
        // reject this exact owner/number race rather than blocking everyone.
        if (secondaryPairInFlight.has(pairLock)) return { ok: false, reason: 'request-in-progress' }
    }

    // MAIN SESSION: only use it when it is genuinely unregistered. Never tear
    // down an existing live main connection just because another number wants
    // to pair.
    if (!sessionStore.isRegistered() && !mainPairInFlight.has('main')) {
        mainPairInFlight.add('main')
        try {
            const conn = await getFreshPairingSocket('main', 'auth')
            const code = await requestCode(conn, digits, 'main')
            pendingTelegramPairs.set('main', { telegramUserId: owner, phone: digits })
            console.log(`[SESSION main] DARKNOTE pairing code issued for +${digits}`)
            return { ok: true, code: String(code || ''), sessionId: 'main', replaced: false }
        } catch (error) {
            console.error('[SESSION main] pairing failed:', error?.stack || error)
            return { ok: false, reason: 'request-failed', detail: error?.message || String(error) }
        } finally {
            mainPairInFlight.delete('main')
        }
    }

    // If this number is already registered in DARKNOTE, do not create a second
    // auth directory. If its process socket is missing, rebuild that SAME
    // session immediately; this does not touch any other user's session.
    const existing = sessionRegistry.findByPhone(digits)
    if (existing) {
        const live = secondaryInstances.get(String(existing.id))
        if (live && live.conn && live.conn.__darknoteConnectionState === 'open') {
            return { ok: false, reason: 'already-paired', sessionId: existing.id, active: true }
        }
        if (String(existing.id) === sessionRegistry.PRIMARY_ID) {
            if (sessionStore.isRegistered()) {
                const main = runtimeMonitor.currentSocket('main')
                if (!main || main.__darknoteConnectionState !== 'open') {
                    // Primary reconnection is handled by the normal boot/runtime
                    // path; do not destroy or replace another active session.
                    connectToWhatsApp().catch(error => console.error('[main] recovery failed:', error?.message || error))
                }
                return { ok: false, reason: 'already-paired', sessionId: 'main', active: false }
            }
        }
        if (existing.id !== sessionRegistry.PRIMARY_ID) {
            try {
                await startSecondarySession(existing)
                const recovered = secondaryInstances.get(String(existing.id))
                if (recovered?.conn?.__darknoteConnectionState === 'open' || recovered?.isRegistered?.()) {
                    return { ok: false, reason: 'already-paired', sessionId: existing.id, active: true, recovered: true }
                }
            } catch (error) {
                sessionRegistry.update(existing.id, { state: 'DISCONNECTED', lastError: error?.message || String(error) })
            }
        }
        // A registered session never needs a new pairing code. The recovery
        // path above is enough and avoids invalidating an existing device link.
        if (existing.pairedAt || existing.state === 'CONNECTED' || existing.state === 'AUTH_REQUIRED') {
            return { ok: false, reason: 'already-paired', sessionId: existing.id, active: false }
        }
    }

    // Also inspect the actual auth folders so a stale/missing registry cannot
    // cause DARKNOTE to create a duplicate WhatsApp device for the same number.
    const discovered = typeof sessionRegistry.findRegisteredOnDisk === 'function'
        ? sessionRegistry.findRegisteredOnDisk(digits)
        : null
    if (discovered) {
        return { ok: false, reason: 'already-paired', sessionId: discovered.id, active: false, discovered: true }
    }

    if (secondaryPairInFlight.has(pairLock)) return { ok: false, reason: 'request-in-progress' }
    secondaryPairInFlight.add(pairLock)
    try {
        const primaryNumber = sessionStore.info()?.number
        if (primaryNumber && primaryNumber === digits) {
            return { ok: false, reason: 'already-paired', sessionId: 'main', active: true }
        }
        const allowed = sessionRegistry.canPair(owner)
        if (!allowed.ok) return { ok: false, reason: allowed.code, limit: allowed.limit }

        const created = sessionRegistry.create(owner, digits, `+${digits}`)
        if (!created.ok) return { ok: false, reason: 'create-failed', detail: created.error }
        const record = created.record
        let instance
        try {
            instance = await startSecondarySession(record)
            const code = await requestCode(instance.conn, digits, record.id)
            sessionRegistry.update(record.id, { state: 'PAIRING', phone: digits, pairingStartedAt: Date.now(), baileys: getBaileysVersion() })
            console.log(`[${record.id}] DARKNOTE pairing code issued for +${digits}`)
            return { ok: true, code: String(code || ''), sessionId: record.id, replaced: false }
        } catch (error) {
            secondaryInstances.delete(record.id)
            try { instance?.stop?.() } catch { }
            sessionRegistry.remove(record.id)
            throw error
        }
    } catch (error) {
        console.error('[SESSION] pairing failed:', error?.stack || error)
        return { ok: false, reason: 'request-failed', detail: error?.message || String(error) }
    } finally {
        secondaryPairInFlight.delete(pairLock)
    }
}

/*
 * ---------------------------------------------------------------------------
 * LOCAL PANEL / WHATSAPP PAIRING
 * ---------------------------------------------------------------------------
 * Telegram remains configured but does not own pairing. The local panel and
 * the WhatsApp !pair command use the same existing session/socket machinery.
 */
function pickPairCaseCode() {
    return PAIR_CASE_CODES[Math.floor(Math.random() * PAIR_CASE_CODES.length)]
}

function totalRegisteredSessions() {
    const secondary = sessionRegistry.all().filter(record => record?.id !== sessionRegistry.PRIMARY_ID && record?.state !== 'DISCONNECTED').length
    return secondary + (sessionStore.isRegistered() ? 1 : 0)
}

/*
 * ============================================================================
 * PAIRING CODE AUTO-REFRESH
 * ============================================================================
 * A WhatsApp link code is only valid for about a minute. A human needs most of
 * that minute just to walk to the phone and reach
 * Settings -> Linked devices -> Link with phone number, so a code requested
 * once is almost always stale by the time it is typed - which is exactly the
 * "Couldn't link device" failure seen on the console.
 *
 * This re-arms the request on a timer so a freshly issued code always exists.
 * The code STRING never changes (config.pairingCode is fixed), so the owner can
 * type it whenever they get to the phone. Each re-arm re-sends companion_hello
 * over a socket that is already open and never wipes auth/.
 */
let pairingRefreshTimer = null
let pairingRefreshCount = 0
// The number currently being paired against, so a window that WhatsApp ends can
// be replaced with a fresh one without asking the owner to retype it.
let pendingPairPhone = ''
/*
 * How long the pairing code is kept valid, and how often it is re-armed.
 *
 * WhatsApp only honours a link code for about a minute, so a single request can
 * never last 3 minutes. Instead the request is re-armed every 50s - comfortably
 * inside that ~60s lifetime - and the window is held open for 3 minutes total,
 * which is the maximum. After that the owner runs the panel again for a new one.
 */
const PAIRING_CODE_WINDOW_MS = 3 * 60 * 1000
const PAIRING_REFRESH_MS = 50000

function stopPairingRefresh() {
    if (pairingRefreshTimer) {
        clearInterval(pairingRefreshTimer)
        pairingRefreshTimer = null
    }
}

function startPairingRefresh(phone, sessionId = 'main', authDir = 'auth') {
    stopPairingRefresh()
    pairingRefreshCount = 0
    pendingPairPhone = String(phone || '')
    const windowOpenedAt = Date.now()
    console.log(`[PAIR] code held valid for ${Math.round(PAIRING_CODE_WINDOW_MS / 60000)} min (re-armed every ${Math.round(PAIRING_REFRESH_MS / 1000)}s)`)
    pairingRefreshTimer = setInterval(async () => {
        if (isAuthRegistered(authDir)) { stopPairingRefresh(); return }
        if (Date.now() - windowOpenedAt > PAIRING_CODE_WINDOW_MS) {
            stopPairingRefresh()
            console.log('[PAIR] 3-minute pairing window elapsed; run the panel again for a new code.')
            return
        }
        pairingRefreshCount++
        try {
            /*
             * Refresh on the CURRENT socket. Creating a new one would retire the
             * live pairing socket - and that socket is exactly where WhatsApp
             * delivers the approval, so replacing it would throw the pairing away.
             */
            const conn = runtimeMonitor.currentSocket(sessionId)
            if (!conn || conn.__darknoteRetired) return
            if (conn.__darknoteConnectionState === 'closed') return
            const code = await requestCode(conn, phone, sessionId)
            console.log(`[PAIR] pairing window refreshed for +${phone} (code ${code}, valid ~60s)`)
        } catch (error) {
            console.log(`[PAIR] refresh skipped: ${error?.message || String(error)}`)
        }
    }, PAIRING_REFRESH_MS)
    pairingRefreshTimer.unref?.()
}

async function pairFromPanel(phone) {
    const digits = String(phone || '').replace(/\D/g, '')
    if (!/^\d{8,15}$/.test(digits)) return { ok: false, reason: 'invalid-number' }

    const existing = sessionRegistry.findByPhone(digits) || sessionRegistry.findRegisteredOnDisk(digits)
    if (existing) {
        const id = String(existing.id || 'main')
        if (id === 'main') {
            const live = runtimeMonitor.currentSocket('main')
            if (!live || live.__darknoteConnectionState !== 'open') {
                connectToWhatsApp().catch(error => console.error('[PANEL] main recovery failed:', error?.message || error))
            }
        } else if (!secondaryInstances.has(id)) {
            try { await startSecondarySession(sessionRegistry.get(id) || existing) } catch (error) {
                return { ok: false, reason: 'reconnect-failed', detail: error?.message || String(error) }
            }
        }
        return { ok: false, reason: 'already-paired', sessionId: id }
    }

    if (totalRegisteredSessions() >= 25) return { ok: false, reason: 'limit', limit: 25 }

    // The original auth/ session is used only when it is genuinely unregistered.
    if (!sessionStore.isRegistered()) {
        try {
            const conn = await getFreshPairingSocket('main', 'auth')
            currentMainConn = conn
            const code = await requestCode(conn, digits, 'main')
            pendingTelegramPairs.set('main', { telegramUserId: 'panel', phone: digits })
            console.log(`[PANEL] DARKNOTE pairing code issued for +${digits}`)
            // Keep this code valid while the owner walks to the phone.
            startPairingRefresh(digits, 'main', 'auth')
            return { ok: true, code: String(code), sessionId: 'main' }
        } catch (error) {
            return { ok: false, reason: 'request-failed', detail: error?.message || String(error) }
        }
    }

    const created = sessionRegistry.create('panel', digits, `+${digits}`)
    if (!created.ok) return { ok: false, reason: 'create-failed', detail: created.error }
    const record = created.record
    let instance
    try {
        instance = await startSecondarySession(record)
        const code = await requestCode(instance.conn, digits, record.id)
        sessionRegistry.update(record.id, {
            state: 'PAIRING',
            phone: digits,
            pairingStartedAt: Date.now(),
            baileys: getBaileysVersion(),
            platform: 'DARKNOTE'
        })
        console.log(`[PANEL] ${record.id} pairing code issued for +${digits}`)
        return { ok: true, code: String(code), sessionId: record.id }
    } catch (error) {
        secondaryInstances.delete(record.id)
        try { instance?.stop?.() } catch {}
        sessionRegistry.remove(record.id)
        return { ok: false, reason: 'request-failed', detail: error?.message || String(error) }
    }
}

async function pairFromWhatsApp(phone, ownerKey = 'whatsapp-owner') {
    const digits = String(phone || '').replace(/\D/g, '')
    if (!/^\d{8,15}$/.test(digits)) return { ok: false, reason: 'invalid-number' }

    const existing = sessionRegistry.findByPhone(digits) || sessionRegistry.findRegisteredOnDisk(digits)
    if (existing) {
        const id = String(existing.id || 'main')
        if (id !== 'main' && !secondaryInstances.has(id)) {
            try { await startSecondarySession(sessionRegistry.get(id) || existing) } catch (error) {
                return { ok: false, reason: 'reconnect-failed', detail: error?.message || String(error) }
            }
        } else if (id === 'main') {
            const live = runtimeMonitor.currentSocket('main')
            if (!live || live.__darknoteConnectionState !== 'open') connectToWhatsApp().catch(error => console.error('[PAIR] main recovery failed:', error?.message || error))
        }
        return { ok: false, reason: 'already-paired', sessionId: id }
    }

    if (totalRegisteredSessions() >= 25) return { ok: false, reason: 'limit', limit: 25 }

    if (!sessionStore.isRegistered()) {
        try {
            const conn = await getFreshPairingSocket('main', 'auth')
            currentMainConn = conn
            const code = await requestCode(conn, digits, 'main', pickPairCaseCode())
            return { ok: true, code: String(code), sessionId: 'main' }
        } catch (error) {
            return { ok: false, reason: 'request-failed', detail: error?.message || String(error) }
        }
    }

    const created = sessionRegistry.create(ownerKey, digits, `+${digits}`)
    if (!created.ok) return { ok: false, reason: 'create-failed', detail: created.error }
    const record = created.record
    let instance
    try {
        instance = await startSecondarySession(record)
        const code = await requestCode(instance.conn, digits, record.id, pickPairCaseCode())
        sessionRegistry.update(record.id, {
            state: 'PAIRING',
            phone: digits,
            pairingStartedAt: Date.now(),
            baileys: getBaileysVersion(),
            platform: 'DARKNOTE'
        })
        return { ok: true, code: String(code), sessionId: record.id }
    } catch (error) {
        secondaryInstances.delete(record.id)
        try { instance?.stop?.() } catch {}
        sessionRegistry.remove(record.id)
        return { ok: false, reason: 'request-failed', detail: error?.message || String(error) }
    }
}

global.darknotePanelPair = pairFromPanel
global.darknoteWhatsAppPair = pairFromWhatsApp

global.darknotePairingCodes = () => [...PAIR_CASE_CODES]

async function runPairingPanel() {
    if (!process.stdin || process.stdin.destroyed) return
    console.log('\n╭──────────────────────────────╮')
    console.log('│       DARKNOTE PAIR PANEL     │')
    console.log('├──────────────────────────────┤')
    console.log('│ 1. Individual pairing         │')
    console.log('│ 2. Pair up to 3 devices       │')
    console.log('│ 0. Exit pairing panel         │')
    console.log('╰──────────────────────────────╯')

    const askPanel = prompt => question(prompt)
    const choose = async () => {
        const choice = String(await askPanel('\nSelect option: ')).trim()
        if (choice === '0') return
        if (choice !== '1' && choice !== '2') {
            console.log('❌ Choose 1, 2 or 0.')
            return choose()
        }

        const maximum = choice === '2' ? 3 : 1
        for (let i = 0; i < maximum; i++) {
            const raw = String(await askPanel(`📱 WhatsApp number ${i + 1}/${maximum}: `)).trim()
            const digits = raw.replace(/\D/g, '')
            if (!/^\d{8,15}$/.test(digits)) {
                console.log('❌ Invalid number. Use international digits, e.g. 2547XXXXXXXX.')
                i--
                continue
            }
            console.log(`⏳ Preparing pairing for +${digits}...`)
            const result = await pairFromPanel(digits)
            if (!result.ok) {
                const message = result.reason === 'already-paired'
                    ? `That number is already linked to DARKNOTE (${result.sessionId || 'main'}).`
                    : result.reason === 'limit'
                        ? 'DARKNOTE has reached the 25-device pairing limit.'
                        : result.detail || 'The pairing request could not be completed.'
                console.log(`❌ ${message}`)
                continue
            }
            console.log('\n╭──────────────────────────────╮')
            console.log('│ 🔐 DARKNOTE PAIRING CODE      │')
            console.log(`│ Number : +${digits}`)
            console.log(`│ Code   : ${result.code}`)
            console.log(`│ Session: ${result.sessionId}`)
            console.log('│ Enter the code on WhatsApp → Linked Devices →')
            console.log('│ Link a device → Link with phone number.')
            console.log('╰──────────────────────────────╯\n')
        }
        return choose()
    }
    return choose()
}

/*
 * What the Telegram controller is allowed to do with the session.
 */
const botApi = {
    sessionInfo: () => sessionStore.info(),
    isRegistered: () => sessionStore.isRegistered(),
    describe: () => sessionStore.describe(),
    pair: (phone, telegramUserId) => pairSession(phone, telegramUserId),
    sessions: telegramUserId => sessionRegistry.forUser(telegramUserId),
    allSessions: () => sessionRegistry.all(),
    removeSessionById: async (id) => {
        const key = String(id || '')
        const instance = secondaryInstances.get(key)
        if (instance) {
            secondaryInstances.delete(key)
            try { instance.stop() } catch { }
        }
        return sessionRegistry.remove(key)
    },
    removeSession: () => sessionStore.reset(),
    connectionState: () => runtimeMonitor.telegramState(),
    baileysVersion: () => getBaileysVersion(),
    setPairingOwner: owner => { pairingOwner = owner === 'telegram' ? 'telegram' : 'console' },
    pairingOwner: () => pairingOwner
}

/** Start the Telegram controller, letting it own pairing when it comes online. */
async function startTelegram() {
    if (config.telegram?.enabled === false) {
        console.log('[TELEGRAM] controller disabled; token retained in configuration.')
        return
    }
    if (!telegram) return
    try {
        const result = await telegram.start({ bot: botApi })
        if (result?.ok) {
            const changed = botApi.pairingOwner() !== 'telegram'
            botApi.setPairingOwner('telegram')
            if (changed) console.log('[SESSION] pairing is now handled from Telegram (/pair)')
        } else {
            console.log(`[SESSION] Telegram unavailable (${result?.reason || 'unknown'}); console pairing stays active`)
        }
    } catch (error) {
        console.error('[TELEGRAM] start failed:', error?.message || error)
    }
}

/*
 * Guards against two concurrent connect attempts.
 */
let connectInFlight = false

function reload(file) {
    const filePath = path.resolve(file)

    fs.watchFile(filePath, () => {
        fs.unwatchFile(filePath)
        console.log(`Reloaded: ${file}`)

        delete require.cache[require.resolve(file)]

        try {
            if (file.includes('BIGBRO.js')) {
                handleMessage = require('./BIGBRO.js')
            } else if (file.includes('msg.js')) {
                delete require.cache[require.resolve('./lib/msg.js')]
                const msg = require('./lib/msg.js')
                global.smsg = msg.smsg
                global.bind = msg.bind
            }

            reload(file)
        } catch (err) {
            console.log(`❌ Error reload ${file}:`, err)
        }
    })
}

reload('./BIGBRO.js')
reload('./lib/msg.js')

async function connectToWhatsApp() {
    if (connectInFlight) {
        console.log('[RUNTIME] a connect is already in progress; duplicate ignored')
        return
    }
    connectInFlight = true
    try {
        await startSocket()
    } finally {
        connectInFlight = false
    }
}

async function startSocket() {
    runtimeMonitor.markConnecting('opening socket')

    /*
     * A Telegram /pair may already be in flight. If so, leave the pairing
     * socket alone — the boot path must not race it.
     */
    const existingPairing = runtimeMonitor.currentSocket('main')
    if (existingPairing && existingPairing.__darknotePairingSocket && !existingPairing.__darknoteRetired) {
        console.log('[RUNTIME] pairing socket already live; skipping boot connect')
        return
    }

    /*
     * Peek at creds BEFORE creating the socket.
     *
     * If Telegram owns pairing and this session is unregistered, we must NOT
     * build the boot socket at all. Creating one and then closing it during
     * its initial handshake throws "WebSocket was closed before the connection
     * was established" from inside Baileys' async stack — uncatchable, and it
     * crashes the panel. Telegram's /pair handler builds its own fresh socket
     * on demand, so a boot socket here is pure liability.
     */
    let preRegistered = false
    try {
        const credsPath = path.join('auth', 'creds.json')
        if (fs.existsSync(credsPath)) {
            const raw = JSON.parse(fs.readFileSync(credsPath, 'utf8'))
            preRegistered = raw?.registered === true
        }
    } catch { }

    if (!preRegistered && pairingOwner === 'telegram') {
        console.log('[SESSION] not paired — Telegram /pair will open a fresh pairing socket')
        return
    }

    const { state, saveCreds } = await useMultiFileAuthState('auth')

    const conn = makeWASocketSimple({
        logger,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        auth: {
            creds: state.creds,
            keys: typeof makeCacheableSignalKeyStore === 'function'
                ? makeCacheableSignalKeyStore(state.keys, logger)
                : state.keys
        },
        syncFullHistory: false,
        fireInitQueries: true,
        markOnlineOnConnect: false,
        keepAliveIntervalMs: 20000,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        enableRecentMessageCache: true
    })

    conn.__darknoteCreatedAt = Date.now()
    conn.__darknoteRetired = false
    conn.__darknoteSessionId = 'main'

    runtimeMonitor.register(conn, 'main')
    currentMainConn = conn

    bind(conn)
    bindDeleteEvents(conn)

    if (!conn.__darknoteSecurityBound && conn.ev?.on) {
        conn.__darknoteSecurityBound = true
        conn.ev.on('group-participants.update', async (update) => {
            try {
                const results = await security.handleParticipants(conn, update, {
                    selfIds: [conn.user?.id, conn.user?.lid].filter(Boolean)
                })
                for (const result of results || []) {
                    console.log(`[SECURITY] ${result.feature} -> ${result.performed.join('+')} (strike ${result.strike})${result.restored === false ? ' restore refused' : result.restored ? ' restored' : ''}`)
                }
            } catch (error) {
                console.error('[SECURITY] participant handling failed:', error?.stack || error)
            }
        })
    }

    conn.__darknoteConnectionState = 'connecting'

    let connectionState = 'connecting'
    const socketReady = () => {
        if (connectionState !== 'open' || conn.__darknoteConnectionState !== 'open') return false
        const readyState = conn.ws?.readyState
        return readyState === undefined || readyState === 1
    }
    const setDarknoteOnline = async () => {
        if (!socketReady()) return false
        try {
            await conn.sendPresenceUpdate('available')
            return true
        } catch (error) {
            const message = String(error?.message || error || '')
            if (!socketReady() || /connection\s+closed|socket\s+closed/i.test(message)) return false
            console.error('❌ Presence update failed:', message)
            return false
        }
    }
    const startPresenceUpdates = () => {
        if (conn.__darknotePresenceInterval) return
        void setDarknoteOnline()
        conn.__darknotePresenceInterval = setInterval(() => { void setDarknoteOnline() }, 20000)
    }
    const stopPresenceUpdates = () => {
        if (conn.__darknotePresenceInterval) {
            clearInterval(conn.__darknotePresenceInterval)
            conn.__darknotePresenceInterval = null
        }
    }

    conn.ev.on('presence.update', (update) => {
        try { groupFeatures.cachePresence(conn, update) } catch (error) { console.error('❌ Presence cache error:', error?.message || error) }
    })

    conn.ev.on('call', async (calls) => {
        if (!config.anticall || !Array.isArray(calls)) return
        for (const call of calls) {
            try {
                if (call?.status === 'offer' && call?.id && call?.from) {
                    await conn.rejectCall(call.id, call.from)
                    console.log(`📵 DARKNOTE rejected incoming call from ${call.from}`)
                }
            } catch (error) {
                console.error('❌ AntiCall error:', error?.stack || error)
            }
        }
    })

    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update

        if (connection === 'close') {
            connectionState = 'closed'
            conn.__darknoteConnectionState = 'closed'
            stopPresenceUpdates()

            if (conn.__darknoteRetired) {
                console.log('Old socket retired for re-pairing; no reconnect scheduled.')
                mainPairInFlight.delete('main')
                pendingTelegramPairs.delete('main')
                return
            }
            // A late close from an old socket must NEVER change the state or
            // reconnect timer of the replacement socket.
            if (runtimeMonitor.currentSocket() !== conn) {
                console.log('Old socket closed after replacement; ignoring stale close event.')
                return
            }
            runtimeMonitor.unregister(conn)
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
            const reason = lastDisconnect?.error?.message || `status ${statusCode ?? 'unknown'}`
            runtimeMonitor.markClosed(statusCode, reason)
            runtimeMonitor.noteError(lastDisconnect?.error || reason)

            if (!state.creds.registered) {
                mainPairInFlight.delete('main')
                pendingTelegramPairs.delete('main')
                console.log('Unregistered session closed; waiting for a new pair request.')
                return
            }

            if (runtimeMonitor.isRecoverable(statusCode)) {
                const delay = runtimeMonitor.scheduleReconnect(() =>
                    connectToWhatsApp().catch((error) => console.error('❌ Reconnect failed:', error?.message || error))
                )
                console.log(`Connection closed (${reason}). Reconnecting in ${delay ? Math.round(delay / 1000) + 's' : 'n/a'}.`)
            } else {
                console.log('🔒 Logged out. Automatic reconnect is disabled until the session is paired again.')
            }
        } else if (connection === 'open') {
            connectionState = 'open'
            conn.__darknoteConnectionState = 'open'
            console.log('✅ Connected to WhatsApp')

            const pendingMain = pendingTelegramPairs.get('main')
            if (pendingMain) {
                pendingTelegramPairs.delete('main')
                mainPairInFlight.delete('main')
                if (telegram?.sendMessage) {
                    const livePhone = sessionNumberFromState(state) || pendingMain.phone
                    telegram.sendMessage(pendingMain.telegramUserId, [
                        '✅ *WHATSAPP LOGIN SUCCESSFUL*',
                        '',
                        `Your WhatsApp number +${livePhone} has successfully connected to DARKNOTE.`,
                        'Session: main',
                        '',
                        '🤖 Your bot is now active and running automatically.'
                    ]).catch(error => console.error('[SESSION main] Telegram success notification failed:', error?.message || error))
                }
            }

            runtimeMonitor.markOpen()
            runtimeMonitor.cancelReconnect()
            startPresenceUpdates()

            try {
                const aiService = require('./ai/index.js')
                aiService.scheduler.restore((task) => {
                    if (String(task.id).startsWith('grouptoggle:')) {
                        aiService.grouptimer.restore(conn, [task]).catch(error => {
                            console.error('[SCHEDULER] group restore failed:', error?.message || error)
                        })
                    }
                })
                aiService.presence.resume(conn)
            } catch (error) {
                console.error('❌ Could not restore AI schedules:', error?.message || error)
            }

            startTelegram()
        }
    })

    /*
     * LOCAL PANEL PAIRING. Telegram is intentionally disabled, so the
     * unregistered socket stays alive and the terminal panel owns the prompt.
     * No existing WhatsApp menu/command styling is changed.
     */
    if (!state.creds.registered) {
        currentMainConn = conn
        console.log('\n📱 WhatsApp is not linked yet. Use the DARKNOTE Pair Panel to pair it.')
    }

    conn.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            let m = chatUpdate.messages[0]
            if (!m.message) return
            runtimeMonitor.noteActivity()
            if (m.key?.remoteJid === 'status@broadcast') {
                try { handleMessage.enqueueStatusAutomation(conn, m) } catch (error) {
                    console.error('❌ Status automation enqueue error:', error?.message || error)
                }
                return
            }

            try {
                await handleIncomingProtocolDeletion(conn, m)
            } catch (error) {
                console.error('❌ Antidelete revoke detection error:', error?.message || error)
            }

            try { await captureMessage(conn, m) } catch (error) {
                console.error('❌ Antidelete retention error:', error?.message || error)
            }

            let processedMsg
            try {
                processedMsg = await smsg(conn, m)
            } catch (err) {
                console.error('❌ smsg error:', err.message)
                return
            }

            if (!processedMsg) return
            processedMsg.__darknoteConn = conn

            if (config.autoread) {
                try { await conn.readMessages([m.key]) } catch (error) {
                    console.error('❌ Autoread failed:', error?.message || error)
                }
            }

            try { handleMessage.recordGroupActivity(processedMsg) } catch (error) {
                console.error('❌ Group activity tracking error:', error?.message || error)
            }

            try {
                const { handleAntiLink } = require('./lib/protected-antilink.js')
                if (await handleAntiLink(conn, processedMsg)) return
            } catch (error) {
                console.error('❌ AntiLink integration error:', error?.stack || error)
            }

            if (typeof handleMessage.handleAutomaticViewOnce === 'function') {
                await handleMessage.handleAutomaticViewOnce(conn, m)
            }

            if (!processedMsg.fromMe && processedMsg.mtype === 'stickerMessage') {
                const explicit = String(processedMsg.text || '').trim()
                const hasExplicitCommand = explicit.startsWith(config.prefix || '.')
                if (!hasExplicitCommand) {
                    const trigger = await lookupStickerCommand(processedMsg, conn)
                    if (trigger?.command) {
                        processedMsg.__darknoteSyntheticCommand = `${config.prefix || '.'}${trigger.command}`
                        await handleMessage(conn, processedMsg)
                        return
                    }
                }
            }

            const presence = config.autorecoding ? 'recording' : (config.autotyping ? 'composing' : '')
            if (presence) {
                try { await conn.sendPresenceUpdate(presence, processedMsg.chat) } catch (error) {
                    console.error('❌ Presence update failed:', error?.message || error)
                }
            }

            await handleMessage(conn, processedMsg)

            if (presence) {
                try { await conn.sendPresenceUpdate('paused', processedMsg.chat) } catch (error) {
                    console.error('❌ Presence reset failed:', error?.message || error)
                }
            }
        } catch (err) {
            console.error('❌ messages.upsert error:', err)
        }
    })

    conn.ev.on('creds.update', saveCreds)
}

/*
 * BOOT ORDER MATTERS.
 *
 * Telegram is started FIRST so it can claim pairing before the socket reaches
 * its pairing branch. If Telegram fails, pairingOwner stays 'console' and the
 * console flow runs unchanged.
 */
 ; (async () => {
    await startTelegram()
    connectToWhatsApp().catch(error => {
        console.error('❌ Initial connect failed:', error?.message || error)
    })

    // Keep the existing panel terminal and add pairing controls without
    // changing the bot's WhatsApp command/menu style.
    if (config.telegram?.enabled === false) {
        setTimeout(() => { runPairingPanel().catch(error => console.error('[PANEL] pairing panel stopped:', error?.message || error)) }, 250)
    }

    try {
        for (const record of sessionRegistry.all()) {
            if (!record || record.id === sessionRegistry.PRIMARY_ID) continue
            startSecondarySession(record).catch(error => {
                sessionRegistry.update(record.id, { state: 'DISCONNECTED', lastError: error?.message || String(error) })
                console.error(`[${record.id}] startup failed:`, error?.message || error)
            })
        }
    } catch (error) {
        console.error('[SESSIONS] could not restore Telegram sessions:', error?.message || error)
    }
})()