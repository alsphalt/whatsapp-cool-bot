'use strict'

/*
 * DARKNOTE ASSISTANT — command the bot in plain language.
 * =====================================================
 * "darknote bring me the menu", "darknote take the profile pic of this person",
 * "darknote turn on antilink", "darknote send this to my dm".
 *
 * THE RULES THIS OBEYS
 *
 * 1. OWNER ONLY. It runs only for the number the bot is paired to (and added
 *    owners), because talking your way into `.kick` would otherwise be a
 *    privilege bypass.
 * 2. INDEPENDENT OF `.chatbot` / `.ai on`. This path is checked BEFORE the
 *    conversational layers, so the owner can run a real command by talking to
 *    the bot whether or not the chatbot is enabled.
 * 3. IT NEVER INVENTS COMMANDS. A resolution is only accepted if the name exists
 *    in the dispatcher's own registry, and it is executed by re-entering the
 *    dispatcher through the project's existing synthetic-command hook
 *    (`m.__darknoteSyntheticCommand`). Every permission check, confirmation gate
 *    and reply therefore behaves exactly as if the command had been typed.
 * 4. IT NEVER HIJACKS A CONVERSATION. A message must be ADDRESSED to the bot
 *    ("darknote …", "hey bot …"), or in a DM be an exact command name. Anything
 *    else returns `handled: false` and falls through to normal AI chat.
 *
 * Resolution order: exact command name -> phrase table -> fuzzy command match ->
 * optional LLM pick (only when an AI provider is configured and reachable).
 */

const { getRegisteredCommands } = require('./command-system.js')

/**
 * The registry hands back a Set (built by scanning the dispatcher for case
 * labels). Normalise it, so this module does not care about the shape.
 */
function registeredNames() {
    try {
        const raw = getRegisteredCommands()
        if (!raw) return []
        if (Array.isArray(raw)) return raw.map(String)
        if (raw instanceof Set) return [...raw].map(String)
        if (raw instanceof Map) return [...raw.keys()].map(String)
        return Object.keys(raw).map(String)
    } catch (error) {
        console.error('[ASSISTANT] command registry unavailable:', error && error.message ? error.message : error)
        return []
    }
}

/** How the owner addresses the bot. Also used to detect "this is an order". */
const ADDRESS = /^(?:(?:hey|hi|ok|okay|please|oi|ela)\s+)*(?:dark\s*note|darknote|dn|bot)\b[\s,:!?.-]*/i

/** Toggle words, used by the phrase table. */
const ON = /\b(on|enable|turn\s+on|activate|start|kuwasha)\b/i
const OFF = /\b(off|disable|turn\s+off|deactivate|stop|zima)\b/i

/**
 * Phrase table: natural language -> an EXISTING command.
 * `build` receives the raw text and returns { command, args }.
 */
const PHRASES = [
    { re: /\b(all\s*menu|full\s*menu|list\s+all\s+commands)\b/i, build: () => ({ command: 'allmenu', args: '' }) },
    { re: /\b(menu|menus|commands|help)\b/i, build: () => ({ command: 'menu', args: '' }) },

    { re: /\b(profile\s*(pic|picture|photo)|avatar|display\s*pic|\bpp\b|\bdp\b)\b/i, build: () => ({ command: 'getpp', args: '' }) },

    { re: /\banti\s*link\b/i, build: t => ({ command: 'antilink', args: toggle(t, '') }) },
    { re: /\banti\s*delete\b/i, build: t => ({ command: 'antidelete1', args: toggle(t, '') }) },
    { re: /\banti\s*all\b/i, build: t => ({ command: 'antiall', args: toggle(t, '') }) },
    { re: /\banti\s*(demote|kick|sticker|media|add|promote|view\s*once|mention\s*status|call)\b/i, build: t => ({ command: `anti${t.match(/anti\s*(demote|kick|sticker|media|add|promote|view\s*once|mention\s*status|call)/i)[1].replace(/\s+/g, '').toLowerCase()}`, args: toggle(t, '') }) },

    { re: /\b(group\s*)?admins?\b/i, build: () => ({ command: 'groupadmins', args: '' }) },
    { re: /\b(who('s| is)\s+online|online\s+(list|members|people))\b/i, build: () => ({ command: 'listonline', args: '' }) },
    { re: /\b(tag|mention|ping)\s+(all|everyone|everybody)\b/i, build: () => ({ command: 'tagall', args: '' }) },
    { re: /\bhide\s*tag\b/i, build: () => ({ command: 'hidetag', args: '' }) },
    { re: /\bgroup\s*(id|jid)\b/i, build: () => ({ command: 'groupjid', args: '' }) },
    { re: /\b(kick|remove|fukuza)\b/i, build: () => ({ command: 'kick', args: '' }) },
    { re: /\b(promote|make\s+(him|her|them|this\s+person)\s+admin)\b/i, build: () => ({ command: 'promote', args: '' }) },
    { re: /\b(demote|remove\s+admin)\b/i, build: () => ({ command: 'demote', args: '' }) },

    // "send this to my dm" — view-once / replied media forwarded to the owner.
    { re: /\b(send|save|forward|keep|copy)\b[\s\S]*\b(dm|inbox|my\s+(chat|number|inbox|dm)|myself|saved\s*messages|private)\b/i, build: () => ({ command: 'vv2', args: '' }) },
    { re: /\b(save|keep|download|grab)\b[\s\S]*\bstatus\b/i, build: () => ({ command: 'ss', args: '' }) },
    { re: /\b(repost|send)\b[\s\S]*\bstatus\b/i, build: () => ({ command: 'gpstatus', args: '' }) },

    { re: /\b(ping|latency|speed|server\s*(status|info)|system\s*(status|info))\b/i, build: () => ({ command: 'ping', args: '' }) },
    { re: /\blyrics?\b/i, build: t => ({ command: 'lyrics', args: afterKeyword(t, 'lyrics') }) },
    { re: /\bshazam\b|\bwhat\s+(song|music)\s+is\s+this\b/i, build: () => ({ command: 'shazam', args: '' }) },
    // "play X" must reach the SONG search. Without this it fuzzy-matched
    // `shazam_play`, which is a card button, not a user command.
    { re: /\b(play|piga)\b/i, build: t => ({ command: 'song', args: afterKeyword(t, '(play|piga)') }) },
    { re: /\b(song|music)\b/i, build: t => ({ command: 'song', args: afterKeyword(t, '(song|music)') }) },
    { re: /\b(video|clip)\b/i, build: t => ({ command: 'ytvideo', args: afterKeyword(t, '(video|clip)') }) },
    { re: /\bweather\b/i, build: t => ({ command: 'weather', args: afterKeyword(t, 'weather') }) },
    { re: /\bwhat\s+time\b|\btime\s+in\b/i, build: t => ({ command: 'time', args: afterKeyword(t, '(time)') }) },
    { re: /\b(sticker|stika)\b/i, build: () => ({ command: 'sticker', args: '' }) },
    { re: /\b(edit|change|badilisha)\b[\s\S]*\b(photo|picture|image|background|sticker)\b/i, build: t => ({ command: 'edit', args: afterKeyword(t, '(edit|change|badilisha)') }) },

    { re: /\bauto\s*human\b/i, build: t => ({ command: 'autohuman', args: toggle(t, '') }) },
    { re: /\b(public|self)\s*mode\b/i, build: t => ({ command: /\bself\b/i.test(t) ? 'self' : 'public', args: '' }) }
]

function toggle(text, fallback) {
    if (ON.test(text)) return 'on'
    if (OFF.test(text)) return 'off'
    return fallback
}

/** Everything after a keyword, used to pass a search query through. */
function afterKeyword(text, keywordPattern) {
    const re = new RegExp(keywordPattern, 'gi')
    const stripped = String(text).replace(ADDRESS, ' ')
    const match = re.exec(stripped)
    if (!match) return ''
    return stripped.slice(match.index + match[0].length)
        .replace(/^[\s:,-]*(?:for|of|by|me|please|tafadhali)?[\s:,-]*/i, '')
        .trim()
}

const normalise = (text) => String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/**
 * Last resort for names the phrase table does not know: match the owner's words
 * against the real command names (so "list online" finds `listonline`).
 */
function fuzzyCommand(text, commands) {
    const words = normalise(text).split(' ').filter(Boolean)
    if (!words.length) return ''

    /*
     * Only real user commands are candidates. Card/button ids are commands in
     * the registry too, and matching them is wrong: "play last last" used to
     * pick `shazam_play` (a button) instead of `song`.
     */
    const selectable = commands.filter(name => !name.includes('_') && !/^antidelete[0-9]$/.test(name))

    let best = ''
    let bestScore = 0
    for (const command of selectable) {
        const name = normalise(command)
        if (!name) continue
        if (name === words.join(' ')) return command
        if (words.includes(name)) return command
        // "list online" vs "listonline": compare the squeezed forms too.
        if (name === words.join('')) return command

        let score = 0
        for (const word of words) {
            if (word.length < 3) continue
            if (name.includes(word)) score += word.length
        }
        if (score > bestScore) { bestScore = score; best = command }
    }
    return bestScore >= 4 ? best : ''
}

/**
 * Optional LLM pick, used only when the deterministic layers found nothing.
 * Never fatal: a missing key or an offline provider simply returns ''.
 */
async function llmCommand(text, commands) {
    try {
        const config = require('../ai/config.js')
        const router = require('../ai/router.js')
        const settings = config.getAiSettings()
        const prompt = [
            'You map a WhatsApp bot owner\'s request onto ONE existing command.',
            `Available commands: ${commands.join(', ')}.`,
            'Answer with STRICT JSON only: {"command":"<name>","args":"<arguments or empty>"}.',
            'If nothing matches, answer {"command":"","args":""}.',
            `Request: ${String(text).slice(0, 400)}`
        ].join('\n')

        const answer = await router.ask(prompt, settings, { objective: 'classify', originalMessage: text })
        if (!answer || answer.ok === false) return null
        const raw = String(answer.text || answer.answer || '').match(/\{[\s\S]*\}/)
        if (!raw) return null
        const parsed = JSON.parse(raw[0])
        const command = String(parsed.command || '').trim()
        return commands.includes(command) ? { command, args: String(parsed.args || '').trim() } : null
    } catch (error) {
        console.error('[ASSISTANT] LLM pick unavailable:', error && error.message ? error.message : error)
        return null
    }
}

/**
 * Work out which existing command the owner is asking for.
 * Returns { command, args, how } or null.
 */
async function resolve(text, options = {}) {
    const commands = Array.isArray(options.commands) && options.commands.length
        ? options.commands
        : registeredNames()
    if (!commands.length) return null
    const body = String(text || '').replace(ADDRESS, ' ').trim()
    if (!body) return null

    /*
     * 1. PHRASE TABLE FIRST.
     *
     * Natural language is the whole point here, and it carries the right
     * arguments. Matching the bare command name first got this wrong: "kick this
     * person" became `kickthis person` (the first word won, the rest became
     * arguments) and "save this status" became `save` instead of `ss`.
     */
    for (const phrase of PHRASES) {
        if (!phrase.re.test(body)) continue
        let built
        try { built = phrase.build(body) } catch { continue }
        if (built && commands.includes(built.command)) {
            return { command: built.command, args: built.args || '', how: 'phrase' }
        }
    }

    // 2. The words ARE the command ("darknote listonline", "darknote antilink on").
    const first = normalise(body).split(' ')[0]
    if (first && commands.includes(first)) {
        return { command: first, args: body.split(/\s+/).slice(1).join(' ').trim(), how: 'exact' }
    }

    // 3. Fuzzy match on the real command names.
    const fuzzy = fuzzyCommand(body, commands)
    if (fuzzy) return { command: fuzzy, args: '', how: 'fuzzy' }

    // 4. Optional model pick.
    if (options.allowLlm !== false) {
        const picked = await llmCommand(body, commands)
        if (picked) return { ...picked, how: 'llm' }
    }
    return null
}

/** True when the message is addressed to the bot. */
function isAddressed(text) {
    return ADDRESS.test(String(text || '').trim())
}

/**
 * Main entry point, called from the dispatcher BEFORE the conversational layers.
 *
 * options:
 *   isOwner   - required; the assistant refuses to act for anyone else
 *   dispatch  - async (syntheticCommandText) => void, re-enters the dispatcher
 *   react     - optional async (emoji) => void
 *   isDirect  - true when the message is a DM (allows a bare command name)
 *
 * Returns { handled: boolean, ... }. `handled: false` means "not an order" and
 * lets the caller continue with normal AI conversation.
 */
async function maybeHandle(conn, m, options = {}) {
    if (!options.isOwner) return { handled: false, reason: 'not-owner' }
    if (typeof options.dispatch !== 'function') return { handled: false, reason: 'no-dispatch' }

    const text = String(m && (m.text || m.body || m.caption) || '').trim()
    if (!text) return { handled: false, reason: 'no-text' }

    const addressed = isAddressed(text)
    if (!addressed && !options.isDirect) return { handled: false, reason: 'not-addressed' }

    const commands = getRegisteredCommands()
    const resolved = await resolve(text, { commands })
    if (!resolved) {
        if (addressed) {
            // Addressed but nothing matched: say so rather than silently ignoring.
            if (typeof options.react === 'function') await options.react('❓')
        }
        return { handled: false, reason: 'no-command' }
    }

    const prefix = String(options.prefix || '.')
    const synthetic = `${prefix}${resolved.command}${resolved.args ? ' ' + resolved.args : ''}`

    try {
        console.log(`[ASSISTANT] "${text.slice(0, 80)}" -> ${synthetic} (${resolved.how})`)
        if (typeof options.react === 'function') await options.react('⏳')
        await options.dispatch(synthetic)
        if (typeof options.react === 'function') await options.react('✅')
        return { handled: true, ...resolved, synthetic }
    } catch (error) {
        console.error('[ASSISTANT] dispatch failed:', error && error.stack ? error.stack : error)
        if (typeof options.react === 'function') await options.react('❌')
        return { handled: true, ...resolved, synthetic, error: String(error && error.message || error) }
    }
}

module.exports = {
    maybeHandle,
    resolve,
    isAddressed,
    fuzzyCommand,
    afterKeyword,
    ADDRESS,
    PHRASES
}
