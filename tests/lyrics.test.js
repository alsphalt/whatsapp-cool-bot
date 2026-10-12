'use strict'

const assert = require('assert')
const lyrics = require('../lib/lyrics.js')

async function run() {
    // 1-5: command/request parsing and response handling without touching the network.
    assert.strictEqual(lyrics.parseResponse({ status: true, result: { title: 'Hope', artist: 'XXXTENTACION', lyrics: 'sample' } }).ok, true)
    assert.strictEqual(lyrics.parseResponse({ status: true, result: {} }).code, 'NOT_FOUND')

    // URL encoding must be delegated to URL/searchParams, never string concatenation.
    const url = new URL(lyrics.endpointFor('Hope by XXXTENTACION'))
    assert.strictEqual(url.searchParams.get('q'), 'Hope by XXXTENTACION')
    assert.ok(url.searchParams.get('apikey'))

    // 6-7: isolated provider failure modes.
    const originalFetch = global.fetch
    try {
        global.fetch = async () => new Promise((_, reject) => {
            const e = new Error('timeout')
            e.name = 'AbortError'
            reject(e)
        })
        assert.strictEqual((await lyrics.geniusLyricsSearch('Hope', { timeoutMs: 1000 })).code, 'PROVIDER_TIMEOUT')

        global.fetch = async () => ({
            ok: true,
            status: 200,
            json: async () => ({ status: false, error: 'INVALID_API_KEY' })
        })
        assert.strictEqual((await lyrics.geniusLyricsSearch('Hope')).code, 'INVALID_API_KEY')
    } finally {
        global.fetch = originalFetch
    }

    console.log('lyrics tests: PASS')
}

run().catch(error => {
    console.error('lyrics tests: FAIL', error)
    process.exitCode = 1
})
