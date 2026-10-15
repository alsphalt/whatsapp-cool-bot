'use strict'

/*
 * A cached, SELF-THROTTLING `conn.groupMetadata`.
 *
 * WHY THIS EXISTS. WhatsApp rate-limits a session's queries, and group metadata
 * is the query this bot asks for most. When it gets throttled the failure feeds
 * itself: every message asks again, every ask fails with `rate-overlimit`, and
 * the session stays throttled - which also delays the SENDS, so the bot looks
 * dead while it is in fact being punished for asking too often. Measured on this
 * deployment: ~3 failed lookups per second, one per message in a busy group.
 *
 * What it changes, for every caller at once:
 *
 *   TTL CACHE      A group's metadata is cached for `ttlMs`. Subjects and member
 *                  lists do not change second to second, and the fresh copy
 *                  arrives anyway through the `group-participants.update` and
 *                  `chats.set` events, which write straight into conn.chats.
 *   DEDUPE         Concurrent lookups for the same group share ONE request. A
 *                  burst of messages no longer means a burst of queries.
 *   BACKOFF        On `rate-overlimit` all lookups pause for a growing window
 *                  (15s doubling to 5 minutes). While paused, a caller gets the
 *                  cached copy - even a slightly stale one, which is far better
 *                  than a burst of failing requests - or a tagged error WITHOUT
 *                  a network call when nothing is cached.
 *   QUIET LOGS     One line per event instead of a stack trace per message.
 *
 * It is installed by wrapping the socket once, so callers - including the
 * protected modules whose internals are not editable - keep calling
 * `conn.groupMetadata(chat)` exactly as before.
 */

const INSTALLED = Symbol.for('darknote.groupMetadataCache')

/* WhatsApp's wording for "you are asking too often" (and the HTTP-shaped ones). */
const THROTTLED = /rate[-_ ]?over[-_ ]?limit|too many requests|\b429\b|\bflood\b/i

function installGroupMetadataCache(conn, options = {}) {
    if (!conn || typeof conn.groupMetadata !== 'function') return conn
    if (conn[INSTALLED]) return conn

    const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : 5 * 60 * 1000
    const baseCooldownMs = Number(options.baseCooldownMs) > 0 ? Number(options.baseCooldownMs) : 15 * 1000
    const maxCooldownMs = Number(options.maxCooldownMs) > 0 ? Number(options.maxCooldownMs) : 5 * 60 * 1000
    const maxEntries = Number(options.maxEntries) > 0 ? Number(options.maxEntries) : 500

    const original = conn.groupMetadata.bind(conn)
    const cache = new Map()      // chat -> { value, at }
    const inflight = new Map()   // chat -> promise, so a burst makes ONE request

    let cooldownUntil = 0
    let cooldownMs = 0
    let servedWhileCooling = 0
    let lastNoticeAt = 0

    const remember = (chat, value) => {
        cache.set(chat, { value, at: Date.now() })
        // A long-lived bot sits in a lot of groups; keep the map bounded.
        while (cache.size > maxEntries) cache.delete(cache.keys().next().value)
        return value
    }

    const isThrottled = (error) => THROTTLED.test(String(error?.message || error || ''))

    const throttledError = (chat) => {
        const error = new Error(`groupMetadata(${chat}) skipped: WhatsApp is rate-limiting this session`)
        error.code = 'GROUP_METADATA_THROTTLED'
        return error
    }

    conn.groupMetadata = async function groupMetadataCached(chat, ...rest) {
        const key = String(chat || '')
        const hit = cache.get(key)
        if (hit && Date.now() - hit.at < ttlMs) return hit.value

        const now = Date.now()
        if (now < cooldownUntil) {
            servedWhileCooling++
            if (now - lastNoticeAt > 10000) {
                lastNoticeAt = now
                console.warn(`[GROUP-METADATA] still throttled: ${Math.ceil((cooldownUntil - now) / 1000)}s to go, ${servedWhileCooling} lookups served from cache`)
            }
            if (hit) return hit.value
            throw throttledError(key)
        }

        if (inflight.has(key)) return inflight.get(key)

        const pending = (async () => {
            try {
                const value = await original(chat, ...rest)
                if (cooldownMs) {
                    console.log(`[GROUP-METADATA] WhatsApp is answering again - backoff cleared after the ${Math.round(cooldownMs / 1000)}s pause`)
                    cooldownMs = 0
                }
                cooldownUntil = 0
                return remember(key, value)
            } catch (error) {
                if (isThrottled(error)) {
                    cooldownMs = Math.min(maxCooldownMs, Math.max(baseCooldownMs, cooldownMs * 2))
                    cooldownUntil = Date.now() + cooldownMs
                    console.warn(`[GROUP-METADATA] rate-overlimit: pausing metadata lookups for ${Math.round(cooldownMs / 1000)}s (${cache.size} groups cached)`)
                    if (hit) return hit.value
                    throw throttledError(key)
                }
                throw error
            } finally {
                inflight.delete(key)
            }
        })()

        inflight.set(key, pending)
        return pending
    }

    conn[INSTALLED] = true
    /*
     * One line at install time. Without it there is no way to tell a socket
     * that is protected by the cache from one that is quietly asking WhatsApp
     * for the same group on every message - which is exactly how the bug this
     * replaces stayed invisible.
     */
    console.log(`[GROUP-METADATA] cache active (ttl ${Math.round(ttlMs / 1000)}s, backoff ${Math.round(baseCooldownMs / 1000)}s-${Math.round(maxCooldownMs / 1000)}s)`)
    return conn
}

module.exports = { installGroupMetadataCache }
