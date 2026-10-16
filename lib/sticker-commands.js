'use strict'

/* Persistent sticker -> command trigger layer. Fingerprints use WhatsApp's
 * own fileSha256 when present and fall back to a SHA-256 of the actual media.
 */
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { downloadContentFromMessage } = require('mzazibaileys')
const config = require('../config.json')
const { normalizeName, isRegisteredOrAlias, resolveCommand, saveConfig } = require('./command-system.js')

function unwrapSticker(value) {
    let current = value
    for (let i = 0; i < 5 && current; i++) {
        if (current.stickerMessage) return current.stickerMessage
        if (current.ephemeralMessage?.message) { current = current.ephemeralMessage.message; continue }
        if (current.viewOnceMessageV2?.message) { current = current.viewOnceMessageV2.message; continue }
        if (current.viewOnceMessage?.message) { current = current.viewOnceMessage.message; continue }
        break
    }
    return null
}

function getStickerMessage(m) {
    if (!m) return null
    if (m.mtype === 'stickerMessage') return m.msg || m.message?.stickerMessage || null
    if (m.message?.stickerMessage) return m.message.stickerMessage
    if (m.quoted?.mtype === 'stickerMessage') return m.quoted.msg || m.quoted.message?.stickerMessage || m.quoted
    return unwrapSticker(m.quoted?.message || m.quoted) || unwrapSticker(m.message)
}

async function downloadSticker(sticker) {
    const stream = await downloadContentFromMessage(sticker, 'sticker')
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    const buffer = Buffer.concat(chunks)
    if (!buffer.length) throw new Error('Sticker media is empty')
    return buffer
}

async function fingerprintSticker(sticker) {
    const ownHash = sticker?.fileSha256
    if (ownHash) {
        const raw = Buffer.isBuffer(ownHash) ? ownHash : Buffer.from(ownHash)
        if (raw.length) return `wa:${raw.toString('base64')}`
    }
    const data = await downloadSticker(sticker)
    return `sha256:${crypto.createHash('sha256').update(data).digest('hex')}`
}

function sessionKey(conn) {
    // Strip the device suffix (:10) before removing separators - it changes on
    // every re-link, which used to orphan the stored sticker triggers.
    const id = String(conn?.user?.id || '').split('@')[0].split(':')[0].replace(/\D/g, '')
    return id || 'unpaired'
}

/*
 * THE TRIGGER MAP LIVES IN ITS OWN FILE, NOT IN config.json.
 *
 * It used to be written into config.json through saveConfig(), and that lost triggers. Several
 * modules - protected-antilink, protected-anticall, security, telegram, sessions - each keep
 * their OWN parsed snapshot of config.json and write the whole object back, so a write from any
 * of them silently dropped whatever another module had added since the snapshot was taken.
 *
 * That is exactly what happened here: `.stckcmd pp` answered "✅ Sticker command set", and by
 * the time the sticker was sent again the trigger was gone - every session's map on disk was
 * empty. One owner, one file, and no shared object left to clobber.
 */
const STORE_PATH = path.join(__dirname, '..', 'database', 'sticker-commands.json')

function readStore() {
    try {
        const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))
        return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    } catch {
        return {}
    }
}

function writeStore(store) {
    try {
        fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true })
        const tmp = `${STORE_PATH}.tmp`
        fs.writeFileSync(tmp, JSON.stringify(store, null, 2))
        fs.renameSync(tmp, STORE_PATH)
        return true
    } catch (error) {
        console.error('[STICKER CMD] could not save the trigger map:', error?.message || error)
        return false
    }
}

/** The trigger map for this session, carrying over anything still parked in config.json. */
function loadMap(conn) {
    const key = sessionKey(conn)
    const store = readStore()

    const legacy = config.stickerCommands?.[key]
    if (legacy && typeof legacy === 'object' && !Array.isArray(legacy) && Object.keys(legacy).length) {
        store[key] = { ...legacy, ...(store[key] || {}) }
        writeStore(store)
        delete config.stickerCommands[key]
        saveConfig()
    }

    if (!store[key] || typeof store[key] !== 'object' || Array.isArray(store[key])) store[key] = {}
    return store[key]
}

/**
 * Every fingerprint that identifies this sticker.
 *
 * Both are stored, because either one alone misses. WhatsApp's fileSha256 is free - it is
 * already on the message - but it is per UPLOAD, so the same sticker relayed again can carry a
 * different one. The media hash is stable across re-uploads but costs a download. Storing both
 * means the cheap one is tried first and the expensive one still catches the miss.
 */
async function fingerprintAliases(sticker) {
    const aliases = []
    const ownHash = sticker?.fileSha256
    if (ownHash) {
        const raw = Buffer.isBuffer(ownHash) ? ownHash : Buffer.from(ownHash)
        if (raw.length) aliases.push(`wa:${raw.toString('base64')}`)
    }
    const data = await downloadSticker(sticker)
    aliases.push(`sha256:${crypto.createHash('sha256').update(data).digest('hex')}`)
    return aliases
}

async function setStickerCommand(sticker, command, conn) {
    const name = normalizeName(command)
    if (!name) return { ok: false, message: '❌ Provide a command after .stckcmd.' }
    if (!isRegisteredOrAlias(name, conn)) return { ok: false, message: `❌ The command *${name}* is not registered in DARKNOTE.` }
    const aliases = await fingerprintAliases(sticker)
    if (!aliases.length) return { ok: false, message: '❌ Could not read that sticker.' }

    const key = sessionKey(conn)
    const store = readStore()
    const map = { ...(store[key] || {}) }
    for (const alias of aliases) map[alias] = name
    store[key] = map

    if (!writeStore(store)) return { ok: false, message: '❌ Could not save that sticker command.' }
    return { ok: true, command: name, fingerprint: aliases[0], aliases }
}

async function lookupStickerCommand(m, conn) {
    const sticker = getStickerMessage(m)
    if (!sticker) return null
    try {
        const map = loadMap(conn)

        // Cheap path first: the hash WhatsApp already put on the message.
        const ownHash = sticker?.fileSha256
        if (ownHash) {
            const raw = Buffer.isBuffer(ownHash) ? ownHash : Buffer.from(ownHash)
            if (raw.length) {
                const fingerprint = `wa:${raw.toString('base64')}`
                const hit = normalizeName(map[fingerprint])
                if (hit) return resolveTrigger(hit, conn, fingerprint)
            }
        }

        // Then the media itself, which is what catches a re-uploaded copy.
        const data = await downloadSticker(sticker)
        const fingerprint = `sha256:${crypto.createHash('sha256').update(data).digest('hex')}`
        const hit = normalizeName(map[fingerprint])
        if (!hit) return null
        return resolveTrigger(hit, conn, fingerprint)
    } catch (error) {
        console.error('[STICKER CMD] fingerprint failed:', error?.stack || error)
        return null
    }
}

function resolveTrigger(command, conn, fingerprint) {
    const resolved = resolveCommand(command, conn)
    if (!resolved) return null
    return { command: resolved, fingerprint }
}

module.exports = { getStickerMessage, fingerprintSticker, setStickerCommand, lookupStickerCommand }
