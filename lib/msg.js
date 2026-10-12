/*
 * DARKNOTE L2 LICENSE
 * Free to use and modify.
 * Please keep this credit notice in redistributed versions.
 * © DARKNOTE L2 • Bigbrother
 */
const path = require('path')
const fs = require('fs')
const { fileTypeFromBuffer } = require('file-type')
const {
    default: _makeWaSocket,
    proto,
    downloadContentFromMessage,
    jidDecode,
    areJidsSameUser
} = require('mzazibaileys')

// Keep a small per-process copy of recently sent message bodies so Baileys can
// answer WhatsApp retry requests instead of leaving recipients on "Waiting for
// this message". This uses the existing socket wrapper; no second listener or
// connection is created.
const sentMessageStore = new Map()
const SENT_MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000

class RetryCounterCache {
    constructor() { this.map = new Map() }
    get(key) { return this.map.get(String(key)) }
    set(key, value, ttlMs) {
        const k = String(key)
        this.map.set(k, value)
        if (ttlMs) {
            const timer = setTimeout(() => { if (this.map.get(k) === value) this.map.delete(k) }, ttlMs)
            if (typeof timer.unref === 'function') timer.unref()
        }
        return this
    }
    del(key) { return this.map.delete(String(key)) }
    delete(key) { return this.map.delete(String(key)) }
    flushAll() { this.map.clear() }
}

function messageStoreKey(key) {
    return `${String(key?.remoteJid || '')}:${String(key?.id || '')}`
}

function rememberSentMessage(message) {
    const key = messageStoreKey(message?.key)
    if (!key || key === ':') return
    sentMessageStore.set(key, message.message)
    const timer = setTimeout(() => sentMessageStore.delete(key), SENT_MESSAGE_TTL_MS)
    if (typeof timer.unref === 'function') timer.unref()
}

/*
 * Wipe the auth folder safely.
 *
 * A half-written auth folder (from a previous failed /pair) makes WhatsApp
 * refuse the handshake: Baileys opens the WebSocket, receives a stream:error,
 * and closes it before `requestPairingCode` can be sent. That produces the
 * "did not open in time" timeout seen in the panel.
 *
 * Pairing sockets are only ever created for UNREGISTERED sessions, so it is
 * always safe to call this before building one.
 */
function wipeAuthFolder(authDir) {
    try {
        if (!fs.existsSync(authDir)) return { ok: true, alreadyEmpty: true }
        fs.rmSync(authDir, { recursive: true, force: true })
        console.log(`[PAIR] cleared stale auth folder at ${authDir}`)
        return { ok: true }
    } catch (error) {
        console.error('[PAIR] could not clear auth folder:', error?.message || error)
        return { ok: false, error: error?.message || String(error) }
    }
}

/*
 * Return true when the auth folder holds a genuinely paired session.
 *
 * Uses the explicit `registered` flag. `requestPairingCode()` may populate
 * `me` before the phone completes linking, so `me.id` alone is NOT proof that
 * the session is fully registered.
 */
function isAuthRegistered(authDir) {
    try {
        const credsPath = path.join(authDir, 'creds.json')
        if (!fs.existsSync(credsPath)) return false
        const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'))
        return creds?.registered === true
    } catch {
        return false
    }
}

/*
 * Mark every outgoing message as forwarded.
 *
 * WhatsApp draws the "Forwarded" banner when a message carries
 * `contextInfo.isForwarded = true` and `forwardingScore >= 1`. We merge that
 * into every send here, in ONE place, so no command in BIGBRO.js has to know
 * about it.
 *
 * Notes:
 *  - `forwardingScore` of 1 shows "Forwarded".
 *  - 5 or more shows "Forwarded many times". We use 1 so it looks like a
 *    normal single forward, not a chain letter.
 *  - We do NOT set this on reactions, presence, or protocol messages: those
 *    have their own payload shapes and adding contextInfo would corrupt them.
 *  - If a caller already supplied contextInfo, we merge into it rather than
 *    overwrite it, so quoted replies keep working.
 */
const FORWARD_MARK = { isForwarded: true, forwardingScore: 1 }

function withForwardMark(content) {
    if (!content || typeof content !== 'object') return content

    // Skip non-message payloads that would break if we inject contextInfo.
    const skipKeys = new Set(['react', 'presence', 'protocolMessage', 'poll', 'pollUpdate', 'delete'])
    const firstKey = Object.keys(content)[0]
    if (skipKeys.has(firstKey)) return content

    // Baileys accepts contextInfo at the top level of the message content
    // (alongside `text`, `image`, `video`, etc.). Merge into any existing one.
    const existing = content.contextInfo || {}
    return {
        ...content,
        contextInfo: {
            ...existing,
            isForwarded: true,
            forwardingScore: existing.forwardingScore && existing.forwardingScore >= 1
                ? existing.forwardingScore
                : 1
        }
    }
}

function makeWASocket(connectionOptions, options = {}) {
    const retryCache = new RetryCounterCache()
    const existingGetMessage = connectionOptions?.getMessage

    /*
     * Preserve ALL caller options. The previous version spread `connectionOptions`
     * into the socket, which is correct — but we now also explicitly keep the
     * fields that matter for the WebSocket handshake (`browser`, `auth`,
     * `logger`, timeouts, `agent`) so nothing silently drops them if a caller
     * passes extra options in the second argument.
     */
    const socketOptions = {
        ...connectionOptions,
        ...options,
        browser: connectionOptions?.browser || options?.browser,
        auth: connectionOptions?.auth || options?.auth,
        logger: connectionOptions?.logger || options?.logger,
        connectTimeoutMs: connectionOptions?.connectTimeoutMs ?? options?.connectTimeoutMs ?? 60000,
        defaultQueryTimeoutMs: connectionOptions?.defaultQueryTimeoutMs ?? options?.defaultQueryTimeoutMs ?? 60000,
        keepAliveIntervalMs: connectionOptions?.keepAliveIntervalMs ?? options?.keepAliveIntervalMs ?? 20000,
        msgRetryCounterCache: connectionOptions?.msgRetryCounterCache || retryCache,
        getMessage: async (key) => {
            const stored = sentMessageStore.get(messageStoreKey(key))
            if (stored) return stored
            if (typeof existingGetMessage === 'function') {
                try { return await existingGetMessage(key) } catch { }
            }
            return undefined
        }
    }

    let conn
    try {
        conn = _makeWaSocket(socketOptions)
    } catch (error) {
        console.error('[SOCKET] Baileys makeWASocket threw:', error?.stack || error)
        throw error
    }

    /*
     * Diagnostic: log the WebSocket state right after creation so a stuck
     * handshake is visible in the panel instead of silently timing out.
     */
    try {
        console.log('[SOCKET] created; ws readyState =', conn.ws?.readyState, 'url =', conn.ws?.url || 'undefined')
        if (typeof conn.ev?.on === 'function') {
            conn.ev.on('connection.update', (update) => {
                console.log('[SOCKET] connection.update:', JSON.stringify({
                    connection: update.connection || null,
                    hasQr: Boolean(update.qr),
                    lastDisconnect: update.lastDisconnect?.error?.message || null
                }))
            })
        }
    } catch { }

    /*
     * Wrap sendMessage so that every outgoing message carries the "Forwarded"
     * banner. Applied here, once, so nothing in BIGBRO.js or any helper needs
     * to know about it.
     *
     * Reactions, presence updates, protocol messages, polls and deletes are
     * excluded by `withForwardMark` — they have different payload shapes.
     */
    const originalSendMessage = typeof conn.sendMessage === 'function' ? conn.sendMessage.bind(conn) : null
    if (originalSendMessage) {
        conn.sendMessage = async (jid, content, options = {}) => {
            const markedContent = withForwardMark(content)
            const sent = await originalSendMessage(jid, markedContent, options)
            try { rememberSentMessage(sent) } catch { }
            return sent
        }
    }

    conn.decodeJid = (jid) => {
        if (!jid) return jid
        if (/:\d+@/gi.test(jid)) {
            const decode = jidDecode(jid) || {}
            return (decode.user && decode.server && decode.user + '@' + decode.server) || jid
        } else return jid
    }

    conn.reply = (jid, text, m, options) => {
        return conn.sendMessage(jid, { text: text }, { quoted: m, ...options })
    }

    conn.getFile = async (PATH, saveToFile = false) => {
        let res, filename
        const data = Buffer.isBuffer(PATH)
            ? PATH
            : PATH instanceof ArrayBuffer
                ? Buffer.from(PATH)
                : /^data:.*?\/.*?;base64,/i.test(PATH)
                    ? Buffer.from(PATH.split`,`[1], 'base64')
                    : /^https?:\/\//.test(PATH)
                        ? (res = await fetch(PATH), Buffer.from(await res.arrayBuffer()))
                        : fs.existsSync(PATH)
                            ? (filename = PATH, fs.readFileSync(PATH))
                            : typeof PATH === 'string'
                                ? Buffer.from(PATH)
                                : Buffer.alloc(0)
        if (!Buffer.isBuffer(data)) throw new TypeError('Result is not a buffer')
        const type = await fileTypeFromBuffer(data) || { mime: 'application/octet-stream', ext: '.bin' }
        if (data && saveToFile && !filename) {
            const tmpDir = path.join(__dirname, '..', 'tmp')
            if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir)
            filename = path.join(tmpDir, `${Date.now()}.${type.ext}`)
            fs.writeFileSync(filename, data)
        }
        return {
            res,
            filename,
            ...type,
            data,
            deleteFile() {
                return filename && fs.unlinkSync(filename)
            }
        }
    }

    conn.sendFile = async (jid, path, filename = '', caption = '', quoted, ptt = false, options = {}) => {
        let type = await conn.getFile(path, true)
        let { res, data: file, filename: pathFile } = type
        if (res?.status !== 200 || file.length <= 65536) {
            try { throw { json: JSON.parse(file.toString()) } }
            catch (e) { if (e.json) throw e.json }
        }
        const fileSize = fs.statSync(pathFile).size / 1024 / 1024
        if (fileSize >= 100) throw new Error('File size is too big!')
        let opt = {}
        if (quoted) opt.quoted = quoted
        if (!type) options.asDocument = true
        let mtype = '', mimetype = options.mimetype || type.mime
        if (/webp/.test(type.mime) || (/image/.test(type.mime) && options.asSticker)) mtype = 'sticker'
        else if (/image/.test(type.mime) || (/webp/.test(type.mime) && options.asImage)) mtype = 'image'
        else if (/video/.test(type.mime)) mtype = 'video'
        else if (/audio/.test(type.mime)) mtype = 'audio'
        else mtype = 'document'
        if (options.asDocument) mtype = 'document'

        let message = {
            ...options,
            caption,
            ptt,
            [mtype]: { url: pathFile },
            mimetype,
            fileName: filename || pathFile.split('/').pop()
        }
        let m
        try {
            m = await conn.sendMessage(jid, message, { ...opt, ...options })
        } catch (e) {
            m = null
        } finally {
            if (!m) m = await conn.sendMessage(jid, { ...message, [mtype]: file }, { ...opt, ...options })
            return m
        }
    }

    conn.downloadM = async (m, type, saveToFile) => {
        let M = m.msg || m
        let mtype = M.mtype ? M.mtype.replace(/Message/i, '') : type
        let message = M.message ? M.message[mtype] : M
        let stream = await downloadContentFromMessage(message, mtype)
        let buffer = Buffer.from([])
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk])
        }
        if (saveToFile) {
            let ran = Math.floor(Math.random() * 100000)
            let ext = message.mimetype.split('/')[1]
            const tmpDir = path.join(__dirname, '..', 'tmp')
            if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })
            let filename = path.join(tmpDir, `${ran}.${ext}`)
            fs.writeFileSync(filename, buffer)
            return filename
        }
        return buffer
    }

    conn.lidToJidMap = new Map()

    conn.resolveLidEnhanced = async (lid) => {
        if (!lid.endsWith('@lid')) return lid

        if (conn.lidToJidMap.has(lid)) {
            return conn.lidToJidMap.get(lid)
        }

        const lidNumber = lid.split('@')[0]

        for (let [storedLid, jid] of conn.lidToJidMap) {
            if (storedLid.split('@')[0] === lidNumber) {
                return jid
            }
        }

        for (let contact of Object.values(conn.contacts)) {
            if (contact.lid === lid && contact.id) {
                conn.lidToJidMap.set(lid, contact.id)
                return contact.id
            }
        }

        for (const chatId of Object.keys(conn.chats)) {
            if (chatId.endsWith('@g.us')) {
                const chat = conn.chats[chatId]
                if (chat.metadata && chat.metadata.participants) {
                    const participant = chat.metadata.participants.find(p => {
                        return p.lid === lid ||
                            (p.lid && p.lid.split('@')[0] === lidNumber) ||
                            (p.id && p.id.endsWith('@lid') && p.id.split('@')[0] === lidNumber)
                    })

                    if (participant && participant.id && !participant.id.endsWith('@lid')) {
                        conn.lidToJidMap.set(lid, participant.id)
                        return participant.id
                    }
                }
            }
        }

        // LID resolution must never force a presence request. Presence is a
        // connection-lifecycle concern handled by index.js after the socket
        // is open; attempting it here caused 'Connection Closed' races during
        // startup/reconnect.
        return lid
    }

    conn.Pairing = "DARKNOTE"

    conn.debugLidMappings = () => { }

    return conn
}

async function smsg(conn, m) {
    if (!m) return m
    if (m.key) {
        m.id = m.key.id
        m.isBaileys = m.id.startsWith('BAE5') && m.id.length === 16
        m.chat = m.key.remoteJid
        m.fromMe = m.key.fromMe
        m.isGroup = String(m.chat || '').endsWith('@g.us')
        m.sender = conn.decodeJid((m.fromMe && conn.user?.id) || m.participant || m.key.participant || m.chat || '')

        if (m.sender.endsWith('@lid')) {
            const originalSender = m.sender
            if (m.isGroup) {
                let meta = conn.chats[m.chat]?.metadata || await conn.groupMetadata(m.chat).catch(() => null)
                const p = meta?.participants?.find(u => u.lid === m.sender)
                if (p) {
                    m.sender = p.id
                    conn.lidToJidMap.set(originalSender, p.id)
                }
            } else {
                m.sender = await conn.resolveLidEnhanced(m.sender)
                if (m.sender !== originalSender) {
                    conn.lidToJidMap.set(originalSender, m.sender)
                }
            }
        }

        if (m.chat.endsWith('@lid') && !m.isGroup) {
            const originalChat = m.chat
            m.chat = await conn.resolveLidEnhanced(m.chat)
            if (m.chat !== originalChat) {
                conn.lidToJidMap.set(originalChat, m.chat)
            }
        }
    }
    if (m.message) {
        m.mtype = Object.keys(m.message)[0]
        m.msg = m.message[m.mtype]
        if (m.mtype === 'viewOnceMessageV2') {
            m.msg = m.message.viewOnceMessageV2.message
            m.mtype = Object.keys(m.msg)[0]
            m.msg = m.msg[m.mtype]
        }
        let text = m.msg.text || m.msg.caption || m.message.conversation || m.msg.contentText || m.msg.selectedDisplayText || m.msg.title || ''
        m.text = typeof m.msg === 'string' ? m.msg : text
        m.download = (saveToFile = false) => conn.downloadM(m, m.mtype.replace(/Message/i, ''), saveToFile)

        let quoted = m.quoted = m.msg.contextInfo ? m.msg.contextInfo.quotedMessage : null
        if (m.quoted) {
            let type = Object.keys(m.quoted)[0]
            let quotedMsg = m.quoted[type]
            if (!quotedMsg) {
                m.quoted = null
            } else {
                m.quoted = quotedMsg
                if (typeof m.quoted === 'string') m.quoted = { text: m.quoted }
                m.quoted.mtype = type
                m.quoted.id = m.msg.contextInfo.stanzaId
                m.quoted.chat = m.msg.contextInfo.remoteJid || m.chat
                m.quoted.sender = conn.decodeJid(m.msg.contextInfo.participant)

                if (m.quoted.sender && m.quoted.sender.endsWith('@lid')) {
                    const originalQuotedSender = m.quoted.sender
                    if (m.isGroup) {
                        let meta = conn.chats[m.chat]?.metadata || await conn.groupMetadata(m.chat).catch(() => null)
                        const p = meta?.participants?.find(u => u.lid === m.quoted.sender)
                        if (p) {
                            m.quoted.sender = p.id
                            conn.lidToJidMap.set(originalQuotedSender, p.id)
                        }
                    } else {
                        m.quoted.sender = await conn.resolveLidEnhanced(m.quoted.sender)
                        if (m.quoted.sender !== originalQuotedSender) {
                            conn.lidToJidMap.set(originalQuotedSender, m.quoted.sender)
                        }
                    }
                }

                if (m.quoted.chat && m.quoted.chat.endsWith('@lid') && !m.isGroup) {
                    const originalQuotedChat = m.quoted.chat
                    m.quoted.chat = await conn.resolveLidEnhanced(m.quoted.chat)
                    if (m.quoted.chat !== originalQuotedChat) {
                        conn.lidToJidMap.set(originalQuotedChat, m.quoted.chat)
                    }
                }

                m.quoted.fromMe = areJidsSameUser(m.quoted.sender, conn.decodeJid(conn.user.id))
                m.quoted.text = m.quoted.text || m.quoted.caption || ''
                m.quoted.bigboreply = (text, chatId, options) => conn.reply(chatId ? chatId : m.chat, text, m.quoted, options)
                m.quoted.download = (saveToFile = false) => conn.downloadM(m.quoted, m.quoted.mtype.replace(/Message/i, ''), saveToFile)

                /*
                 * VIEW-ONCE UNWRAP (quoted replies).
                 *
                 * When you reply to a view-once, the first key of the quoted
                 * message is the WRAPPER, so m.quoted.mtype stayed
                 * "viewOnceMessageV2" and m.quoted.mtype.replace(/Message/i, '')
                 * produced the meaningless type "viewOnceV2". Consequences:
                 *   - media detection rejected it (not audioMessage/videoMessage)
                 *   - downloadM() looked for content under the wrong key and
                 *     could not resolve the stream
                 * Neither .shazam nor any other media command could touch a
                 * view-once the user replied to. Unwrap to the real media type
                 * and point `msg` at the inner content, exactly like the
                 * main-message branch above does.
                 */
                if (/^viewOnceMessage/i.test(String(m.quoted.mtype))) {
                    const inner = m.quoted.message || (m.quoted[m.quoted.mtype] && m.quoted[m.quoted.mtype].message) || null
                    const innerType = inner ? Object.keys(inner)[0] : null
                    if (innerType) {
                        m.quoted.mtype = innerType
                        m.quoted.msg = inner[innerType]
                        m.quoted.viewOnce = true
                    }
                }
            }
        }
    }
    m.bigboreply = (text, chatId, options) => conn.reply(chatId ? chatId : m.chat, text, m, options)
    return m
}

function bind(conn) {
    if (!conn.chats) conn.chats = {}
    if (!conn.contacts) conn.contacts = {}

    function updateNameToDb(contacts) {
        if (!contacts) return
        try {
            contacts = contacts.contacts || contacts
            for (const contact of contacts) {
                const id = conn.decodeJid(contact.id)
                if (!id || id === 'status@broadcast') continue

                let chats = conn.chats[id]
                if (!chats) chats = conn.chats[id] = { ...contact, id }
                conn.chats[id] = {
                    ...chats,
                    ...contact,
                    ...(id.endsWith('@g.us') ?
                        { subject: contact.subject || contact.name || chats.subject || '' } :
                        { name: contact.notify || contact.name || chats.name || chats.notify || '' })
                }

                conn.contacts[id] = {
                    ...conn.contacts[id],
                    ...contact
                }

                if (contact.lid && contact.id) {
                    conn.lidToJidMap.set(contact.lid, contact.id)
                    const lidNumber = contact.lid.split('@')[0]
                    for (let [storedLid, jid] of conn.lidToJidMap) {
                        if (storedLid.split('@')[0] === lidNumber && storedLid !== contact.lid) {
                            conn.lidToJidMap.set(contact.lid, jid)
                        }
                    }
                }
            }
        } catch (e) { }
    }

    conn.ev.on('contacts.upsert', updateNameToDb)
    conn.ev.on('contacts.update', updateNameToDb)
    conn.ev.on('contacts.set', updateNameToDb)
    conn.ev.on('groups.update', updateNameToDb)

    conn.ev.on('messages.reaction', (reactions) => {
        try {
            for (const reaction of reactions) {
                if (reaction.key?.participant) {
                    const jid = conn.decodeJid(reaction.key.participant)
                    if (jid && !conn.contacts[jid]) {
                        conn.contacts[jid] = { id: jid }
                    }
                }
            }
        } catch (e) { }
    })

    conn.ev.on('chats.set', async ({ chats }) => {
        try {
            for (let { id, name, readOnly } of chats) {
                id = conn.decodeJid(id)
                if (!id || id === 'status@broadcast') continue
                const isGroup = id.endsWith('@g.us')
                let localChats = conn.chats[id]
                if (!localChats) localChats = conn.chats[id] = { id }
                localChats.isChats = !readOnly
                if (name) localChats[isGroup ? 'subject' : 'name'] = name
                if (isGroup) {
                    const metadata = await conn.groupMetadata(id).catch(_ => null)
                    if (name || metadata?.subject) localChats.subject = name || metadata.subject
                    if (!metadata) continue
                    localChats.metadata = metadata
                }
            }
        } catch (e) { }
    })

    conn.ev.on('group-participants.update', async function updateParticipantsToDb({ id, participants, action }) {
        if (!id) return
        id = conn.decodeJid(id)
        if (id === 'status@broadcast') return
        if (!(id in conn.chats)) conn.chats[id] = { id }
        let localChats = conn.chats[id]
        localChats.isChats = true
        const groupMetadata = await conn.groupMetadata(id).catch(_ => null)
        if (!groupMetadata) return
        localChats.subject = groupMetadata.subject
        localChats.metadata = groupMetadata
    })

    if (conn.user) {
        conn.contacts[conn.user.id] = {
            id: conn.user.id,
            name: conn.user.name,
            notify: conn.user.name
        }
    }
}

module.exports = { makeWASocket, smsg, bind, wipeAuthFolder, isAuthRegistered }