'use strict'

/*
 * DARKNOTE — BOT INSTANCE FACTORY
 * -------------------------------
 * Everything that has to happen per WhatsApp socket, in one place, so the bot
 * can run MANY sessions without the setup logic being copied (and drifting).
 *
 *   index.js        starts the primary session ("main" -> auth/)
 *   session-runner  starts every session paired from Telegram
 *
 * Both call createBotInstance(), so a session paired from Telegram gets exactly
 * the same command system, antidelete, anti-feature and AI handlers as the
 * original one.
 *
 * ISOLATION RULES
 *
 *   - One messages.upsert listener and one connection.update listener PER SOCKET,
 *     registered once here and never again. Reconnecting builds a new socket with
 *     a new set of listeners; the old socket is closed and its listeners die with
 *     it. That is what keeps a reconnect from producing duplicate replies.
 *
 *   - Runtime state, reconnect timers, presence intervals and connection flags
 *     are all keyed by session id, so one session can never mark another idle.
 *
 *   - BIGBRO's dispatcher already takes `conn` as an argument, so commands and
 *     AI replies are naturally scoped to the socket that received the message.
 */

const { Boom } = require('@hapi/boom')
const { useMultiFileAuthState, makeCacheableSignalKeyStore, Browsers } = require('mzazibaileys')
const pino = require('pino')
const logger = pino({ level: 'silent' })

// Same modules index.js has always used - the factory exists so multi-session
// setup cannot drift from the original single-session setup.
const { smsg, makeWASocket: makeWASocketSimple, bind } = require('./msg.js')
const { lookupStickerCommand } = require('./sticker-commands.js')
const runtimeMonitor = require('./runtime.js')
const config = require('../config.json')
const handleMessage = require('../BIGBRO.js')
const { bindDeleteEvents, captureMessage, handleIncomingProtocolDeletion } = require('./antidelete.js')

const PRESENCE_INTERVAL_MS = 20 * 1000

/**
 * Create and fully wire one bot instance.
 *
 * @param {object} options
 *   sessionId      stable id used for all runtime state ('main', 's2', ...)
 *   authDir        the multi-file auth auth directory for this session
 *   requestCode    (conn, phone, code) => Promise<code>   the pairing-code requester
 *   pairingOwner   () => 'telegram' | 'console'
 *   consolePairing true to allow the interactive stdin prompt (main session only)
 *   primary        true only for the main session
 *   pairPhone      when set on an UNREGISTERED session, this factory drives the
 *                  Baileys pairing itself (see PAIRING DRIVE below)
 *   pairCode       the 8-character code WhatsApp should issue, when pinning one
 *   onOpen/onClose optional hooks
 */
async function createBotInstance(options) {
    const {
        sessionId,
        authDir,
        requestCode,
        pairingOwner = () => 'console',
        consolePairing = false,
        primary = false,
        pairPhone = '',
        pairCode = '',
        onOpen,
        onClose
    } = options

    if (!sessionId) throw new Error('createBotInstance requires a sessionId')
    if (!authDir) throw new Error('createBotInstance requires an authDir')

    runtimeMonitor.markConnecting('opening socket', sessionId)
    const { state, saveCreds } = await useMultiFileAuthState(authDir)

    const conn = makeWASocketSimple({
        logger,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        auth: { creds: state.creds, keys: typeof makeCacheableSignalKeyStore === 'function' ? makeCacheableSignalKeyStore(state.keys, logger) : state.keys },
        syncFullHistory: false,
        fireInitQueries: true,
        /*
         * A PAIRING SOCKET MUST MARK ITSELF ONLINE; a registered one must not.
         *
         * WhatsApp drops sessions that never mark themselves online, which is
         * fatal for a socket that has to stay reachable while the owner walks to
         * their phone and types the code - index.js's createPairingSocket() sets
         * this to true for exactly that reason, and says so in its own comment.
         * This factory is the OTHER pairing entry point (the `.pair <number>`
         * path) and used to hard-code `false`, so its socket was dropped almost
         * immediately and the code expired before anyone could type it.
         */
        markOnlineOnConnect: state.creds.registered !== true,
        keepAliveIntervalMs: 20000,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        enableRecentMessageCache: true
    })

    // Per-socket connection flag. Helpers read `conn.__darknoteConnectionState`,
    // so it must live on the socket rather than in a module variable - otherwise
    // one session's close would tell every other session it was offline.
    conn.__darknoteSessionId = sessionId
    conn.__darknoteConnectionState = 'connecting'
    conn.__darknoteConnectingSeen = false
    conn.__darknotePairingSocket = state.creds.registered !== true

    if (conn.__darknotePairingSocket) {
        /*
         * GATE PAIRING ON THE QR EVENT, NOT ON `connecting`.
         *
         * This used to resolve on `connecting` OR `qr`. `connecting` is emitted
         * from process.nextTick() at socket creation - BEFORE the Noise handshake
         * has completed - so requestPairingCode() fired too early, WhatsApp tore
         * the stream down the moment companion_hello arrived, and the socket
         * closed before registration. lib/telegram-pairing.js documents the same
         * trap at length, and index.js's createPairingSocket() already gates on
         * `qr` alone. This gate now matches them.
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
                    cleanup()
                    resolve()
                } else if (update.connection === 'close') {
                    settled = true
                    cleanup()
                    reject(new Error('pairing socket closed before pairing started'))
                }
            }
            conn.ev?.on?.('connection.update', onUpdate)
            // No artificial readiness delay. requestCode() waits on this promise
            // and starts as soon as Baileys has completed the handshake.
        })
        /*
         * AN ABANDONED PAIRING MUST NOT KILL THE PROCESS.
         *
         * runtime.js installGuards() treats an unhandled promise rejection as
         * FATAL - it calls fatal() and process.exit(1). When a pairing socket
         * closed before the QR ever arrived, nothing had awaited this promise
         * yet, the rejection was reported as unhandled, and DARKNOTE restarted
         * itself in the middle of pairing. createPairingSocket() already guards
         * its own copy of this promise for exactly this reason; this is the same
         * guard on this factory's copy.
         */
        conn.__darknotePairingReady.catch(() => { })
    }

    // Claim THIS session's slot only. Another session's socket is untouched.
    runtimeMonitor.register(conn, sessionId)

    /*
     * ─────────────────────────── PAIRING DRIVE ───────────────────────────
     *
     * THE FACTORY ASKS FOR THE CODE ITSELF.
     *
     * Before this, createBotInstance only created the socket and logged "not
     * paired - waiting for a Telegram /pair request"; every caller then had to
     * remember to call requestCode() itself once the factory returned. That is
     * where `.pair <number>` broke: index.js DID call requestCode() afterwards,
     * but the request raced the caller's own bookkeeping and, more importantly,
     * a failure at any point in between was an unhandled rejection that took the
     * bot down instead of being reported.
     *
     * So when the caller names the number it wants paired (pairPhone), the
     * request happens HERE, immediately after the slot is registered, and the
     * outcome is published on `conn.__darknotePairing` as a promise that NEVER
     * rejects - it resolves `{ ok: true, code }` or `{ ok: false, reason, detail }`
     * and the caller just awaits awaitPairingCode(). One owner, one code, no
     * race, and no path from a failed pairing to a process restart.
     */
    if (conn.__darknotePairingSocket && String(pairPhone || '').replace(/\D/g, '')) {
        const digits = String(pairPhone).replace(/\D/g, '')
        conn.__darknotePairing = (async () => {
            try {
                if (typeof requestCode !== 'function') {
                    throw new Error('no pairing-code requester is configured for this session')
                }
                const code = await requestCode(conn, digits, pairCode)
                if (!code || typeof code !== 'string') throw new Error('WhatsApp returned an empty pairing code')
                console.log(`[${sessionId}] 🔐 pairing code issued for +${digits}`)
                return { ok: true, code: String(code), sessionId, phone: digits }
            } catch (error) {
                const detail = error?.message || String(error)
                console.log(`[${sessionId}] pairing code request failed for +${digits}: ${detail}`)
                return { ok: false, reason: 'request-failed', detail, sessionId, phone: digits }
            }
        })()
    }

    // Fast-login optimization: pairing sockets stay lightweight until WhatsApp
    // completes authentication. Registered sockets keep the normal eager bind.
    conn.__darknoteHandlersBound = false
    if (!conn.__darknotePairingSocket) {
        conn.__darknoteHandlersBound = true
        bind(conn)
        bindDeleteEvents(conn)
    }

    /* ---------------------------- presence ---------------------------- */

    let presenceTimer = null
    const startPresenceUpdates = () => {
        if (presenceTimer) return
        presenceTimer = setInterval(async () => {
            try {
                if (conn.__darknoteConnectionState === 'open' && typeof conn.sendPresenceUpdate === 'function') {
                    await conn.sendPresenceUpdate('available')
                }
            } catch { /* presence is cosmetic; never fatal */ }
        }, PRESENCE_INTERVAL_MS)
        if (typeof presenceTimer.unref === 'function') presenceTimer.unref()
    }
    const stopPresenceUpdates = () => {
        if (!presenceTimer) return
        clearInterval(presenceTimer)
        presenceTimer = null
    }

    /* -------------------------- connection ---------------------------- */

    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update

        if (connection === 'close') {
            conn.__darknoteConnectionState = 'closed'
            stopPresenceUpdates()
            /*
             * Only the current socket is allowed to mutate runtime state. A
             * stale close from a replaced socket must not schedule a reconnect
             * for the live replacement.
             */
            if (runtimeMonitor.currentSocket(sessionId) !== conn) {
                return
            }
            runtimeMonitor.unregister(sessionId)

            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
            const reason = lastDisconnect?.error?.message || `status ${statusCode ?? 'unknown'}`

            // Once the phone has completed pairing, this socket becomes a
            // normal long-lived DARKNOTE session. Do not classify a later drop
            // as an abandoned pairing just because the socket was originally
            // created for pairing.
            const abandonedPairing = conn.__darknotePairingSocket && !state.creds.registered

            /*
             * An abandoned pairing is NOT a logged-out session.
             *
             * WhatsApp answers companion_hello with a close, and a pairing socket
             * that is never completed closes with 401/428 as a matter of course.
             * markClosed() reads 401 as "logged out" and flags the session
             * AUTH_REQUIRED, which (a) reported a socket that was never expected
             * to authenticate as needing re-authentication, and (b) set the
             * sticky authRequired flag that suppresses every future reconnect on
             * that session slot. Pass the pairing flag so the close is recorded
             * without either side effect.
             */
            runtimeMonitor.markClosed(statusCode, reason, sessionId, { pairing: abandonedPairing })
            runtimeMonitor.noteError(lastDisconnect?.error || reason, sessionId)

            if (abandonedPairing) {
                console.log(`[${sessionId}] pairing socket closed before registration; waiting for a new /pair request.`)
                if (typeof onClose === 'function') onClose(statusCode === 401 ? 'logged-out' : 'pairing-closed')
                return
            }

            if (runtimeMonitor.isRecoverable(statusCode, sessionId)) {
                // One timer per session, exponential backoff, never sooner than 2s.
                const delay = runtimeMonitor.scheduleReconnect(() => {
                    if (typeof onClose === 'function') onClose('reconnect')
                }, sessionId)
                console.log(`[${sessionId}] connection closed (${reason}). Reconnecting in ${delay ? Math.round(delay / 1000) + 's' : 'n/a'}.`)
            } else {
                console.log(`[${sessionId}] 🔒 logged out. Automatic reconnect is disabled until it is paired again.`)
                if (typeof onClose === 'function') onClose('logged-out')
            }
            return
        }

        if (connection === 'connecting') {
            conn.__darknoteConnectionState = 'connecting'
            conn.__darknoteConnectingSeen = true
            return
        }

        if (connection === 'open') {
            conn.__darknoteConnectionState = 'open'
            // Pairing has completed; this is now a normal registered session.
            conn.__darknotePairingSocket = false
            if (!conn.__darknoteHandlersBound) {
                conn.__darknoteHandlersBound = true
                bind(conn)
                bindDeleteEvents(conn)
            }
            runtimeMonitor.markOpen(sessionId)
            runtimeMonitor.cancelReconnect(sessionId)
            startPresenceUpdates()
            console.log(`[${sessionId}] ✅ connected to WhatsApp`)

            /*
             * Scheduler restore and presence cycling are GLOBAL modules holding a
             * single pending-task set and a single interval, so they run for the
             * primary session only. Running them per session would duplicate
             * scheduled group actions. Documented as a limitation.
             */
            if (primary) {
                try {
                    const aiService = require('../ai/index.js')
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
            }

            if (typeof onOpen === 'function') onOpen()
        }
    })

    /* --------------------------- pairing ------------------------------ */

    if (state.creds.registered !== true) {
        if (conn.__darknotePairing) {
            /*
             * Nothing to wait for: the PAIRING DRIVE above is already asking
             * WhatsApp for this number's code, and its result is on
             * conn.__darknotePairing. Saying "waiting for a /pair request" here -
             * as this branch used to - was actively misleading in the log while
             * a real pairing was in flight.
             */
            console.log(`[${sessionId}] pairing in progress for +${String(pairPhone).replace(/\D/g, '')}; code requested from WhatsApp`)
        } else if (pairingOwner() === 'telegram') {
            console.log(`[${sessionId}] not paired — waiting for a Telegram /pair request`)
        } else if (consolePairing) {
            // The original interactive flow, for the primary session when no
            // Telegram controller is available.
            const question = require('readline').createInterface({ input: process.stdin, output: process.stdout })
            const ask = prompt => new Promise(resolve => question.question(prompt, resolve))
            console.log('\n🔗 DARKNOTE L2 WhatsApp Linking')
            console.log('Enter the WhatsApp number that you want to link to this bot.')
            console.log('Use international format without + or spaces. Example: 2547XXXXXXXX')
            let phoneNumber = ''
            while (!phoneNumber) {
                const entered = await ask('📱 WhatsApp number: ')
                phoneNumber = String(entered || '').replace(/\D/g, '')
                if (!/^\d{8,15}$/.test(phoneNumber)) {
                    console.log('❌ Invalid number. Enter 8–15 digits in international format.')
                    phoneNumber = ''
                }
            }
            try {
                const code = await requestCode(conn, phoneNumber)
                console.log('\n════════════════════════════════════')
                console.log(`🔐 DARKNOTE PAIRING CODE: ${code}`)
                console.log('Open WhatsApp → Linked Devices → Link a device → Link with phone number.')
                console.log('════════════════════════════════════\n')
            } catch (error) {
                console.error('❌ Failed to request the WhatsApp pairing code:', error)
                runtimeMonitor.fatal('WhatsApp pairing code could not be requested', error)
                throw error
            } finally {
                question.close()
            }
        } else {
            console.log(`[${sessionId}] not paired — waiting for a pairing request`)
        }
    }

    /* ------------------------- message pipeline ------------------------ */

    /*
     * The ONE messages.upsert listener for this socket. Every message-derived
     * feature hangs off it - there is no second listener anywhere in the project.
     */
    conn.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            let m = chatUpdate.messages[0]
            if (!m.message) return
            runtimeMonitor.noteActivity(sessionId)

            if (m.key?.remoteJid === 'status@broadcast') {
                // Status automation stays inside this listener; its action queue
                // enforces the 10-second human-like interval.
                try { handleMessage.enqueueStatusAutomation(conn, m) } catch (error) {
                    console.error('❌ Status automation enqueue error:', error?.message || error)
                }
                return
            }

            // Revoke packets that arrive as protocolMessage through upsert, so
            // antidelete stays compatible without another listener.
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
                const { handleAntiLink } = require('./protected-antilink.js')
                if (await handleAntiLink(conn, processedMsg)) return
            } catch (error) {
                console.error('❌ AntiLink integration error:', error?.stack || error)
            }

            if (typeof handleMessage.handleAutomaticViewOnce === 'function') {
                await handleMessage.handleAutomaticViewOnce(conn, m)
            }

            // Sticker triggers use the same central dispatcher. An explicit
            // caption command always wins, so nothing executes twice.
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

    /** Tear this instance down without touching any other session. */
    const stop = () => {
        stopPresenceUpdates()
        runtimeMonitor.cancelReconnect(sessionId)
        try {
            if (runtimeMonitor.currentSocket(sessionId) === conn) runtimeMonitor.unregister(sessionId)
            if (typeof conn.end === 'function') conn.end(new Error('instance stopped'))
            else if (typeof conn.ws?.close === 'function') conn.ws.close()
        } catch (error) {
            console.error(`[${sessionId}] stop failed:`, error?.message || error)
        }
    }

    /**
     * The pairing code WhatsApp issued for this session, if this factory was
     * asked to pair one (see PAIRING DRIVE above).
     *
     * Resolves `null` when the caller did not name a number - a plain
     * createBotInstance() call has nothing to pair and the caller may still drive
     * requestCode() itself, which is what the re-arm paths do.
     *
     * NEVER rejects and never hangs indefinitely: the drive above is a
     * try/catch-wrapped promise that always settles, and requestCode() has its
     * own bounded timeouts. So awaiting this is always safe.
     */
    const awaitPairingCode = async () => (conn.__darknotePairing ? await conn.__darknotePairing : null)

    return {
        conn,
        state,
        stop,
        sessionId,
        awaitPairingCode,
        isRegistered: () => state.creds.registered === true
    }
}

module.exports = { createBotInstance }
