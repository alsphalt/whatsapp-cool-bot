'use strict'

/*
 * DARKNOTE AI — centralized settings and secrets.
 * ---------------------------------------------------------------------------
 * RECONSTRUCTED FILE. The original ai/config.js was never committed to the
 * upstream repository: `.gitignore` contains a bare `config.js` pattern, which
 * matches at ANY directory depth, so this file was silently excluded from
 * version control alongside the root-level secret config it was meant for.
 *
 * It is required (transitively, at load time) by nine modules, so without it the
 * whole bot throws MODULE_NOT_FOUND before the pairing panel can start:
 *   ai/index.js:27, ai/chatbot.js:27, ai/autohuman.js:29, ai/intent.js:55,
 *   ai/presence.js:19, ai/modules/index.js:26, lib/image-edit.js:46,
 *   lib/telegram.js:49, tests/timing.test.js:13
 *
 * The exported surface below is derived from its actual call sites:
 *   getAiSettings()        ~40 call sites across ai/ and BIGBRO.js
 *   writeAiSetting(k, v)   .aiset / .chatbot / .autohuman / online-cycle writes
 *   readConfigFile()       ai/index.js:67
 *   invalidateConfigCache()ai/index.js:75
 *   ROOT                   ai/index.js:71
 *   loadEnvOnce()          lib/image-edit.js:117, lib/telegram.js:112
 *
 * Shape: config.json -> "ai" is the persisted store and is the source of truth.
 * Settings served to the AI layer are that block, plus the derived keys the
 * call sites read but that were never persisted (the *Ms delay windows, the
 * prompt budget, the per-minute rate aliases, the api key and the status flags).
 *
 * Secrets resolve environment-first (.env or process.env), then config.json.
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const CONFIG_PATH = path.join(ROOT, 'config.json')
const ENV_PATH = path.join(ROOT, '.env')

/* ------------------------------- .env loader ------------------------------ */

let envLoaded = false

function loadEnvOnce() {
    if (envLoaded) return
    envLoaded = true
    try {
        if (!fs.existsSync(ENV_PATH)) return
        const raw = fs.readFileSync(ENV_PATH, 'utf8')
        for (const line of raw.split(/\r?\n/)) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith('#')) continue
            const eq = trimmed.indexOf('=')
            if (eq === -1) continue
            const key = trimmed.slice(0, eq).trim()
            let value = trimmed.slice(eq + 1).trim()
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1)
            }
            if (key && !(key in process.env)) process.env[key] = value
        }
    } catch (error) {
        console.error('[AI] .env could not be read:', error?.message || error)
    }
}

loadEnvOnce()

/* ------------------------------ config access ----------------------------- */

let cache = null
let cacheStamp = -1

/** Read config.json, cached against mtime + size so edits are picked up live. */
function readConfigFile() {
    try {
        const stat = fs.statSync(CONFIG_PATH)
        const stamp = stat.mtimeMs + stat.size
        if (cache && stamp === cacheStamp) return cache
        cache = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {}
        cacheStamp = stamp
        return cache
    } catch (error) {
        console.error('[AI] config.json unreadable:', error?.message || error)
        return cache || {}
    }
}

/** Force the next readConfigFile() to hit disk. */
function invalidateConfigCache() {
    cache = null
    cacheStamp = -1
}

/* -------------------------------- helpers -------------------------------- */

const bool = (value, fallback) => (value === undefined || value === null ? fallback : Boolean(value))

/** Seconds -> milliseconds, tolerating an already-millisecond value. */
const sec = (value, fallback) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.max(0, Math.round(n * 1000))
}

function envFlag(name, fallback) {
    const raw = process.env[name]
    if (raw === undefined || raw === '') return fallback
    return /^(1|true|on|yes)$/i.test(String(raw).trim())
}

function envNum(name, fallback) {
    const raw = process.env[name]
    if (raw === undefined || raw === '') return fallback
    const n = Number(raw)
    return Number.isFinite(n) ? n : fallback
}

/*
 * Env override map. Mirrors the documented overrides in .env.example; anything
 * not set there falls back to config.json -> "ai".
 */
function applyEnvOverrides(settings) {
    settings.chatbotEnabled = envFlag('AI_CHATBOT_ENABLED', settings.chatbotEnabled)
    settings.dmEnabled = envFlag('AI_DM_ENABLED', settings.dmEnabled)
    settings.groupEnabled = envFlag('AI_GROUP_ENABLED', settings.groupEnabled)
    settings.typingEnabled = envFlag('AI_TYPING_ENABLED', settings.typingEnabled)
    settings.memoryEnabled = envFlag('AI_MEMORY_ENABLED', settings.memoryEnabled)
    settings.responseTimingEnabled = envFlag('AI_RESPONSE_TIMING_ENABLED', settings.responseTimingEnabled)
    settings.reactionsEnabled = envFlag('AI_REACTIONS_ENABLED', settings.reactionsEnabled)

    const dmDelayMs = envNum('AI_DM_DELAY', null)
    if (dmDelayMs !== null) settings.dmDelayMs = sec(dmDelayMs, settings.dmDelayMs)

    const shortDelayMs = envNum('AI_SHORT_DELAY', null)
    if (shortDelayMs !== null) settings.shortDelayMs = sec(shortDelayMs, settings.shortDelayMs)

    const longMinMs = envNum('AI_LONG_DELAY_MIN', null)
    if (longMinMs !== null) settings.longDelayMinMs = sec(longMinMs, settings.longDelayMinMs)

    const longMaxMs = envNum('AI_LONG_DELAY_MAX', null)
    if (longMaxMs !== null) settings.longDelayMaxMs = sec(longMaxMs, settings.longDelayMaxMs)

    const groupMinMs = envNum('AI_GROUP_DELAY_MIN', null)
    if (groupMinMs !== null) settings.groupDelayMinMs = sec(groupMinMs, settings.groupDelayMinMs)

    const groupMaxMs = envNum('AI_GROUP_DELAY_MAX', null)
    if (groupMaxMs !== null) settings.groupDelayMaxMs = sec(groupMaxMs, settings.groupDelayMaxMs)

    settings.userPerMinute = envNum('AI_RATE_USER_PER_MIN', settings.userPerMinute)
    settings.groupPerMinute = envNum('AI_RATE_GROUP_PER_MIN', settings.groupPerMinute)
    settings.timeoutMs = envNum('AI_TIMEOUT_MS', settings.timeoutMs)
    settings.retries = envNum('AI_RETRIES', settings.retries)

    return settings
}

/**
 * The full settings object the AI layer consumes.
 * Re-read from config.json on every call (mtime-cached), so a `.aiset` write is
 * visible immediately with no restart.
 */
function getAiSettings() {
    const file = readConfigFile()
    const raw = (file.ai && typeof file.ai === 'object') ? file.ai : {}
    const status = (file.statusAutomation && typeof file.statusAutomation === 'object') ? file.statusAutomation : {}

    const provider = String(raw.provider || 'gpt-5.3-chat')

    const settings = {
        /* --- identity / transport --- */
        provider,
        model: String(raw.model || provider),
        baseUrl: String(raw.baseUrl || 'https://www.mzazi.shop').replace(/\/+$/, ''),
        endpoint: String(raw.endpoint || 'https://www.mzazi.shop/api/ai/gpt-5'),
        apiKey: String(process.env.MZAZI_API_KEY || process.env.AI_API_KEY || raw.apikey || '').trim(),
        providers: Array.isArray(raw.providers) ? raw.providers : [],
        disabledProviders: Array.isArray(raw.disabledProviders) ? raw.disabledProviders : [],

        /* --- master + dimension toggles --- */
        chatbotEnabled: bool(raw.chatbotEnabled, false),
        dmEnabled: bool(raw.dmEnabled, true),
        groupEnabled: bool(raw.groupEnabled, true),
        typingEnabled: bool(raw.typingEnabled, true),
        memoryEnabled: bool(raw.memoryEnabled, true),
        responseTimingEnabled: bool(raw.responseTimingEnabled, true),
        languageEnabled: bool(raw.languageEnabled, true),
        replyContextEnabled: bool(raw.replyContextEnabled, true),
        combineEnabled: bool(raw.combineEnabled, true),
        emojiEnabled: bool(raw.emojiEnabled, true),
        nameEnabled: bool(raw.nameEnabled, true),
        reactionsEnabled: bool(raw.reactionsEnabled, false),
        firstTurnDelay: bool(raw.firstTurnDelay, true),

        /* --- human-likeness / safety --- */
        shortAckReaction: bool(raw.shortAckReaction, true),
        shortAckSilence: bool(raw.shortAckSilence, true),
        abuseSafetyEnabled: bool(raw.abuseSafetyEnabled, true),
        onlineCycleEnabled: bool(raw.onlineCycleEnabled, false),
        onlineCycleMs: Number(raw.onlineCycleMs) || 0,

        /* --- budgets --- */
        maxMessageChars: envNum('AI_MAX_MESSAGE_CHARS', Number(raw.maxMessageChars) || 4000),
        maxContextTurns: Number(raw.maxContextTurns) || 6,
        maxReplyChars: Number(raw.maxReplyChars) || 3500,
        longPromptBudget: Number(raw.longPromptBudget) || 880,
        promptBudget: Number(raw.promptBudget) || Number(raw.longPromptBudget) || 880,
        repeatSimilarityThreshold: Number(raw.repeatSimilarityThreshold) || 0.72,
        summaryMaxChars: Number(raw.summaryMaxChars) || 120,
        maxFallbacks: Number(raw.maxFallbacks) || 2,
        maxAttempts: Number(raw.maxAttempts) || 3,

        /* --- health / rate limits --- */
        healthFailureThreshold: Number(raw.healthFailureThreshold) || 3,
        healthBaseCooldownMs: Number(raw.healthBaseCooldownMs) || 60000,
        healthMaxCooldownMs: Number(raw.healthMaxCooldownMs) || 900000,
        rateUserPerMinute: Number(raw.rateUserPerMinute) || 6,
        rateGroupPerMinute: Number(raw.rateGroupPerMinute) || 12,
        userPerMinute: Number(raw.userPerMinute) || Number(raw.rateUserPerMinute) || 6,
        groupPerMinute: Number(raw.groupPerMinute) || Number(raw.rateGroupPerMinute) || 12,
        batchWindowMs: Number(raw.batchWindowMs) || 2500,
        timeoutMs: envNum('AI_TIMEOUT_MS', Number(raw.timeoutMs) || 60000),
        retries: envNum('AI_RETRIES', Number(raw.retries) || 2),

        /* --- memory / sessions --- */
        maxSessions: Number(raw.maxSessions) || 800,
        sessionTtlDays: Number(raw.sessionTtlDays) || 30,
        longSilenceMs: Number(raw.longSilenceMs) || (Number(raw.longSilenceMinutes) || 90) * 60000,
        followUpMaxPerSilence: Number(raw.followUpMaxPerSilence) || 0,

        /* --- reply delay presets (seconds in config.json -> ms here) --- */
        replyDelayMode: String(raw.replyDelayMode || 'short'),
        replyDelayShortMinMs: sec(raw.replyDelayShortMin, 5000),
        replyDelayShortMaxMs: sec(raw.replyDelayShortMax, 5000),
        replyDelayLongMinMs: sec(raw.replyDelayLongMin, 15000),
        replyDelayLongMaxMs: sec(raw.replyDelayLongMax, 20000),

        /* --- chatbot delay presets (seconds in config.json -> ms here) --- */
        chatbotDelayMode: String(raw.chatbotDelayMode || 'short'),
        chatbotDelayShortMs: sec(raw.chatbotDelayShort, 270000),
        chatbotDelayLongMs: sec(raw.chatbotDelayLong, 630000),

        /* --- owner reply delays --- */
        ownerShortDelayMs: sec(raw.ownerShortDelay, 5000),
        ownerNormalDelayMinMs: sec(raw.ownerNormalDelayMin, 5000),
        ownerNormalDelayMaxMs: sec(raw.ownerNormalDelayMax, 5000),
        ownerLongDelayMinMs: sec(raw.ownerLongDelayMin, 5000),
        ownerLongDelayMaxMs: sec(raw.ownerLongDelayMax, 5000),

        /* --- generic + group delays --- */
        dmDelayMs: sec(raw.dmDelay, 15000),
        shortDelayMs: sec(raw.shortDelay, 4000),
        normalDelayMinMs: sec(raw.normalDelayMin, 4000),
        normalDelayMaxMs: sec(raw.normalDelayMax, 8000),
        longDelayMinMs: sec(raw.longDelayMin, 13000),
        longDelayMaxMs: sec(raw.longDelayMax, 20000),
        groupDelayMinMs: sec(raw.groupDelayMin, 15000),
        groupDelayMaxMs: sec(raw.groupDelayMax, 17000),

        /* --- optional modules --- */
        modules: (raw.modules && typeof raw.modules === 'object') ? raw.modules : {},

        /* --- autohuman --- */
        autohumanEnabled: bool(raw.autohumanEnabled, true),
        autohumanAnalyseMs: Number(raw.autohumanAnalyseMs) || 1500,
        autohumanGenerateMs: Number(raw.autohumanGenerateMs) || 2000,
        autohumanPreSendMs: Number(raw.autohumanPreSendMs) || 1500,
        autohumanContextMessages: Number(raw.autohumanContextMessages) || 6,
        autohumanReadReceipt: bool(raw.autohumanReadReceipt, false),

        /* --- status flags: the SAME three flags .avs/.als/.ars write --- */
        statusView: bool(status.avs?.enabled, false),
        statusLike: bool(status.als?.enabled, false),
        statusReact: bool(status.ars?.enabled, false)
    }

    return applyEnvOverrides(settings)
}

/**
 * Persist one key into config.json -> "ai".
 * The write is atomic (tmp + rename) and invalidates the cache so the change is
 * live on the next read, with no restart.
 */
function writeAiSetting(key, value) {
    if (!key) return false
    try {
        const file = readConfigFile()
        if (!file.ai || typeof file.ai !== 'object') file.ai = {}
        file.ai[String(key)] = value
        const tmp = `${CONFIG_PATH}.tmp`
        fs.writeFileSync(tmp, JSON.stringify(file, null, 2))
        fs.renameSync(tmp, CONFIG_PATH)
        invalidateConfigCache()
        return true
    } catch (error) {
        console.error('[AI] could not write setting', key, '-', error?.message || error)
        return false
    }
}

module.exports = {
    ROOT,
    CONFIG_PATH,
    loadEnvOnce,
    readConfigFile,
    invalidateConfigCache,
    getAiSettings,
    writeAiSetting
}
