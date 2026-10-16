'use strict'

/*
 * GOOGLE SEARCH via the MZAZI endpoint.
 *
 *   https://www.mzazi.shop/api/search/google?q=…&start=…&hl=…&safe=…&apikey=…
 *
 * THE KEY IS NOT IN HERE. It is read from config.json (`googleApiKey`) or the
 * MZAZI_API_KEY environment variable, so it can be rotated or revoked without editing
 * code - and so it never lands in a git history by accident. The endpoint answers 401
 * and {"status":false,"error":"INVALID_API_KEY"} for anything else, which is what the
 * placeholder mzazi_xxxxxxxxx produced when it was tried.
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const ENDPOINT = 'https://www.mzazi.shop/api/search/google'

function apiKey() {
    const fromEnv = String(process.env.MZAZI_API_KEY || '').trim()
    if (fromEnv) return fromEnv
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
        return String(cfg.googleApiKey || cfg.mzaziApiKey || cfg.searchApiKey || '').trim()
    } catch {
        return ''
    }
}

function hasKey() {
    return apiKey().length > 0
}

/**
 * The provider's success shape is not documented to us - we only ever saw its error
 * shape - so the parser accepts every common container rather than guessing one.
 */
function extractResults(json) {
    const pools = [
        json?.data?.results, json?.data?.items, json?.results, json?.items,
        json?.organic_results, json?.data, json?.result
    ]
    for (const pool of pools) {
        if (Array.isArray(pool)) {
            return pool.map(entry => ({
                title: String(entry?.title || entry?.name || entry?.heading || '').trim(),
                link: String(entry?.link || entry?.url || entry?.href || '').trim(),
                snippet: String(entry?.snippet || entry?.description || entry?.desc || entry?.text || '').trim()
            })).filter(entry => entry.title || entry.link)
        }
    }
    return []
}

async function search(query, { start = 0, hl = 'en', safe = 'active' } = {}) {
    const q = String(query || '').trim()
    if (!q) return { ok: false, reason: 'no-query' }

    const key = apiKey()
    if (!key) return { ok: false, reason: 'no-key' }

    const url = `${ENDPOINT}?q=${encodeURIComponent(q)}&start=${Number(start) || 0}`
        + `&hl=${encodeURIComponent(hl)}&safe=${encodeURIComponent(safe)}&apikey=${encodeURIComponent(key)}`

    try {
        const res = await fetch(url, { headers: { accept: 'application/json' } })
        const text = await res.text()

        let json = null
        try { json = JSON.parse(text) } catch { /* a non-JSON body is handled below */ }

        if (!json) return { ok: false, reason: 'http', status: res.status, body: text.slice(0, 200) }
        if (json.status === false) {
            return {
                ok: false,
                reason: json.error === 'INVALID_API_KEY' ? 'bad-key' : 'api',
                error: String(json.error || ''),
                message: String(json.message || '')
            }
        }
        if (!res.ok) return { ok: false, reason: 'http', status: res.status }

        return { ok: true, results: extractResults(json), raw: json, url }
    } catch (error) {
        return { ok: false, reason: 'network', message: error?.message || String(error) }
    }
}

module.exports = { search, hasKey, apiKey, extractResults, ENDPOINT }
