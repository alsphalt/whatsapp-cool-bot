'use strict'

/*
 * DARKNOTE — local secret configuration.
 * ---------------------------------------------------------------------------
 * RECONSTRUCTED FILE. The original api.js was never committed to the upstream
 * repository: `.gitignore` ends with a bare `api.js` pattern, which matches at
 * ANY directory depth, so this file was silently excluded from version control.
 * It is referenced by lib/lyrics.js (top-level require) and lib/image-edit.js.
 *
 * The exported surface below is derived from its actual consumers:
 *   lib/lyrics.js:33      api.GENIUS_LYRICS_API_KEY
 *   lib/lyrics.js:37      api.BASE_URL
 *   lib/image-edit.js:122 api.MZAZI_API_KEY_IMAGE || api.MZAZI_API_KEY
 *
 * Values are read from the environment first (see .env.example), so no secret
 * is ever committed here. Keep real keys in .env, never in this file.
 */

const path = require('path')
const fs = require('fs')

/*
 * Minimal .env loader. The project does not depend on dotenv, and several
 * modules need the environment populated before they read a key, so this file
 * loads it once on require. Existing process env always wins.
 */
function loadEnvOnce() {
    const envPath = path.join(__dirname, '.env')
    if (!fs.existsSync(envPath)) return
    let raw = ''
    try {
        raw = fs.readFileSync(envPath, 'utf8')
    } catch {
        return
    }
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq === -1) continue
        const key = trimmed.slice(0, eq).trim()
        let value = trimmed.slice(eq + 1).trim()
        // Strip one layer of matching quotes, if present.
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1)
        }
        if (key && !(key in process.env)) process.env[key] = value
    }
}

loadEnvOnce()

const env = (name, fallback = '') => String(process.env[name] || fallback).trim()

module.exports = {
    /** Base URL of the Mzazi gateway used by lyrics, AI and image edit. */
    BASE_URL: env('MZAZI_BASE_URL', 'https://www.mzazi.shop').replace(/\/+$/, ''),

    /** Shared Mzazi gateway key. Also resolvable via ai/config.js. */
    MZAZI_API_KEY: env('MZAZI_API_KEY'),

    /** Dedicated image-generation / re-edit key. Falls back to the shared key. */
    MZAZI_API_KEY_IMAGE: env('MZAZI_API_KEY_IMAGE') || env('MZAZI_API_KEY'),

    /** Dedicated Mzazi Genius lyrics key, used only by /api/lyrics/genius. */
    GENIUS_LYRICS_API_KEY: env('GENIUS_LYRICS_API_KEY'),

    /** Exposed so other modules can reuse the same one-time .env load. */
    loadEnvOnce
}
