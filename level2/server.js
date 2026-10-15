'use strict'

/*
 * DARKNOTE LEVEL 2 — the server behind the phone interface.
 *
 * WHY A SERVER AT ALL. The HTML cards the bot sends inside WhatsApp run in an
 * offline sandbox: no fetch, no XHR, no remote assets. An interface that has to
 * SHOW THE REAL RESULT of a bot action therefore cannot be such a card - it has to
 * be a real page served over HTTP, with the bot's code on the other end of it.
 *
 * NO NEW DEPENDENCIES. Node's built-in `http` and `crypto` do all of it: scrypt
 * for the passcode, HMAC-SHA256 for session tokens, a small static file handler.
 * package.json is untouched, and nothing here is loaded until index.js calls
 * start() - so this file existing cannot affect the bot that is running now.
 *
 *   node level2/server.js set-passcode <value>   store a passcode (hashed)
 *   node level2/server.js status                 what is configured
 *   node level2/server.js [--port 8787]          run standalone (no bot attached)
 *
 * SECRETS. database/level2.json is git-ignored and written 0600. The passcode is
 * stored ONLY as a scrypt hash with a random salt. The browser never receives the
 * passcode, the hash, or the signing secret - only a short-lived signed token.
 */

const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const ROOT = path.join(__dirname, '..')
const PUBLIC_DIR = path.join(__dirname, 'public')
/*
 * DARKNOTE_L2_STORE exists so tests can point at a scratch file. Without it, any
 * check that touches the store would write a passcode into the real project state.
 */
const STORE = process.env.DARKNOTE_L2_STORE || path.join(ROOT, 'database', 'level2.json')

const DEFAULT_PORT = 8787
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000   // a day in the phone
const UNLOCK_WINDOW_MS = 5 * 60 * 1000
const UNLOCK_MAX_ATTEMPTS = 5

/* ------------------------------- the store -------------------------------- */

/*
 * Everything mutable lives in one git-ignored file. Read fresh on every request
 * rather than cached: switching modes from two places (the phone and a WhatsApp
 * command) must never disagree, and the cost of a small file read is nothing.
 */
function readStore() {
    try {
        const raw = JSON.parse(fs.readFileSync(STORE, 'utf8'))
        return raw && typeof raw === 'object' ? raw : {}
    } catch {
        return {}
    }
}

function writeStore(patch) {
    const next = { ...readStore(), ...patch }
    fs.mkdirSync(path.dirname(STORE), { recursive: true })
    const tmp = `${STORE}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, STORE)
    return next
}

/** The HMAC key for session tokens. Created on first use, never leaves the disk. */
function serverSecret() {
    const store = readStore()
    if (store.secret && String(store.secret).length >= 32) return String(store.secret)
    const secret = crypto.randomBytes(32).toString('hex')
    writeStore({ secret })
    return secret
}

/* ------------------------------- the passcode ------------------------------ */

function hashPasscode(passcode, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.scryptSync(String(passcode), salt, 64).toString('hex')
    return { salt, hash }
}

/** Constant-time check against the stored scrypt hash. */
function verifyPasscode(passcode) {
    const stored = readStore().passcode
    if (!stored?.salt || !stored?.hash) return false
    const candidate = hashPasscode(passcode, stored.salt).hash
    const a = Buffer.from(candidate, 'hex')
    const b = Buffer.from(String(stored.hash), 'hex')
    if (a.length !== b.length) return false
    return crypto.timingSafeEqual(a, b)
}

function isConfigured() {
    const stored = readStore().passcode
    return Boolean(stored?.salt && stored?.hash)
}

/* -------------------------------- the tokens ------------------------------- */

/*
 * A token is `payload.signature`. The payload carries an expiry and a random id,
 * so it cannot be forged without the server secret and cannot be replayed after it
 * expires. Deliberately NOT a JWT library: one HMAC is all this needs.
 */
function issueToken(ttlMs = TOKEN_TTL_MS, scope = 'unlocked') {
    const payload = Buffer.from(JSON.stringify({
        jti: crypto.randomBytes(12).toString('hex'),
        exp: Date.now() + Math.max(1000, Number(ttlMs) || TOKEN_TTL_MS),
        /*
         * SCOPE IS THE POINT.
         *
         * 'entry'    - what the link from WhatsApp grants: this browser may reach
         *              the lock screen. It cannot read state or do anything else.
         * 'unlocked' - granted ONLY by the correct passcode, and required by every
         *              protected call.
         *
         * Without this split the link alone opened the phone: the browser test
         * caught a valid session cookie being treated as "already unlocked".
         */
        scope
    })).toString('base64url')
    const signature = crypto.createHmac('sha256', serverSecret()).update(payload).digest('base64url')
    return { token: `${payload}.${signature}`, expiresIn: Math.max(1000, Number(ttlMs) || TOKEN_TTL_MS) }
}

function verifyToken(token) {
    const [payload, signature] = String(token || '').split('.')
    if (!payload || !signature) return null
    const expected = crypto.createHmac('sha256', serverSecret()).update(payload).digest('base64url')
    const a = Buffer.from(signature)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
    try {
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
        if (!claims?.exp || claims.exp < Date.now()) return null
        return claims
    } catch {
        return null
    }
}

/* --------------------------------- helpers -------------------------------- */

const json = (res, status, body, extraHeaders = {}) => {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        ...extraHeaders
    })
    res.end(payload)
}

function readBody(req, limit = 8 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0
        const chunks = []
        req.on('data', (chunk) => {
            size += chunk.length
            if (size > limit) { reject(new Error('payload too large')); req.destroy(); return }
            chunks.push(chunk)
        })
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8')
            if (!raw) return resolve({})
            try { resolve(JSON.parse(raw)) } catch { reject(new Error('body must be JSON')) }
        })
        req.on('error', reject)
    })
}

const bearer = (req) => {
    const header = String(req.headers.authorization || '')
    return header.startsWith('Bearer ') ? header.slice(7) : ''
}

/*
 * The session token arrives either as a Bearer header or as the HttpOnly cookie the
 * unlock flow sets. The cookie is the normal path: it is unreadable from JavaScript,
 * so the page cannot leak it, and the browser sends it back by itself.
 */
const sessionTokenOf = (req) => {
    const header = bearer(req)
    if (header) return header
    const cookies = String(req.headers.cookie || '')
    const match = cookies.match(/(?:^|;\s*)darknote_l2=([^;]+)/)
    return match ? decodeURIComponent(match[1]) : ''
}

const sessionCookie = (token, expiresIn) =>
    `darknote_l2=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(expiresIn / 1000)}`

/* --------------------------- real state, not a story ---------------------- */

/*
 * Everything reported here is read from the running process or from disk. When the
 * bot is not attached (standalone server), it says so instead of inventing a
 * connection state - the interface must never show a success that did not happen.
 */
function buildState(conn, meta = {}) {
    const store = readStore()
    const attached = Boolean(conn)
    let bot = 'not-attached'
    if (attached) {
        const state = conn.__darknoteConnectionState
        bot = state === 'open' ? 'connected' : (state || 'unknown')
    }
    return {
        mode: store.mode === 'level2' ? 'level2' : 'original',
        modeChangedAt: store.modeChangedAt || null,
        modeChangedBy: store.modeChangedBy || null,
        bot,
        botNumber: attached ? String(conn.user?.id || '').split(':')[0].split('@')[0] || null : null,
        uptimeSeconds: Math.round(process.uptime()),
        server: { startedAt: meta.startedAt || null, port: meta.port || null },
        interface: { name: 'DARKNOTE LEVEL 2', version: '0.1.0-stage1' },
        configured: isConfigured(),
        now: new Date().toISOString()
    }
}

/* ---------------------------------- routes -------------------------------- */

function createUnlockThrottle() {
    const attempts = new Map()   // ip -> { count, firstAt, blockedUntil }
    return {
        check(ip) {
            const entry = attempts.get(ip)
            if (!entry) return { ok: true }
            if (entry.blockedUntil && Date.now() < entry.blockedUntil) {
                return { ok: false, retryAfterMs: entry.blockedUntil - Date.now() }
            }
            return { ok: true }
        },
        fail(ip) {
            const entry = attempts.get(ip) || { count: 0, firstAt: Date.now(), blockedUntil: 0 }
            if (Date.now() - entry.firstAt > UNLOCK_WINDOW_MS) { entry.count = 0; entry.firstAt = Date.now() }
            entry.count += 1
            // Lockout grows with persistence: 30s, 60s, 120s ...
            if (entry.count >= UNLOCK_MAX_ATTEMPTS) {
                const over = entry.count - UNLOCK_MAX_ATTEMPTS
                entry.blockedUntil = Date.now() + Math.min(30 * 60 * 1000, 30000 * Math.pow(2, over))
            }
            attempts.set(ip, entry)
            return entry
        },
        pass(ip) { attempts.delete(ip) }
    }
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.webmanifest': 'application/manifest+json'
}

function serveStatic(res, urlPath) {
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
    const target = path.join(PUBLIC_DIR, rel)
    // Path traversal guard: the resolved file must stay inside public/.
    if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== path.join(PUBLIC_DIR, 'index.html')) {
        json(res, 403, { ok: false, error: 'forbidden' })
        return
    }
    fs.readFile(target, (error, buffer) => {
        if (error) { json(res, 404, { ok: false, error: 'not found' }); return }
        res.writeHead(200, {
            'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
            'cache-control': 'no-cache'
        })
        res.end(buffer)
    })
}

/**
 * Build the request handler. Exported so a future stage can mount the same routes
 * somewhere else without duplicating them.
 */
function createHandler({ getConn = () => null, meta = {} } = {}) {
    const throttle = createUnlockThrottle()

    return async function handle(req, res) {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
        const route = url.pathname
        const ip = String(req.socket?.remoteAddress || 'unknown')

        try {
            /* --- public: enough for the lock screen to behave correctly --- */
            if (route === '/api/health' && req.method === 'GET') {
                return json(res, 200, { ok: true, configured: isConfigured(), service: 'darknote-level2' })
            }

            if (route === '/api/unlock' && req.method === 'POST') {
                if (!isConfigured()) {
                    return json(res, 409, {
                        ok: false,
                        error: 'no-passcode',
                        message: 'No passcode is set on the server. Set one with: node level2/server.js set-passcode <value>'
                    })
                }
                const gate = throttle.check(ip)
                if (!gate.ok) {
                    return json(res, 429, { ok: false, error: 'too-many-attempts', retryAfterMs: gate.retryAfterMs })
                }
                const body = await readBody(req)
                if (!verifyPasscode(body.passcode)) {
                    const entry = throttle.fail(ip)
                    return json(res, 401, {
                        ok: false,
                        error: 'wrong-passcode',
                        attempts: entry.count
                    })
                }
                throttle.pass(ip)
                const { token, expiresIn } = issueToken()
                return json(res, 200, { ok: true, token, expiresIn, state: buildState(getConn(), meta) },
                    { 'set-cookie': sessionCookie(token, expiresIn) })
            }

            /*
             * THE ENTRY LINK the "performance" command will send.
             *
             * Single use, minutes long, and it only marks THIS BROWSER as allowed to
             * reach the unlock screen - the passcode is still required afterwards, so
             * a link that leaks in a chat is not by itself access to the phone.
             */
            if (route === '/login' && req.method === 'GET') {
                const link = String(url.searchParams.get('token') || '')
                const store = readStore()
                const entry = (store.loginLinks || {})[link]
                if (!link || !entry || entry.usedAt || Number(entry.expiresAt || 0) < Date.now()) {
                    res.writeHead(410, { 'content-type': 'text/html; charset=utf-8' })
                    return res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><body style="background:#0a0a0c;color:#f2f2f5;font-family:system-ui;padding:32px"><h2 style="color:#ff2d2d;margin:0 0 10px">Link expired</h2><p style="color:#9b9ba8">This entry link has already been used or has timed out. Send <code>performance</code> again to get a fresh one.</p></body>')
                }
                // Consume it immediately: a link is good for exactly one visit.
                writeStore({ loginLinks: { ...(store.loginLinks || {}), [link]: { ...entry, usedAt: new Date().toISOString() } } })
                // ENTRY scope: this link gets you to the lock screen, not past it.
                const { token, expiresIn } = issueToken(30 * 60 * 1000, 'entry')
                res.writeHead(302, { location: '/', 'set-cookie': sessionCookie(token, expiresIn) })
                return res.end()
            }

            /*
             * THE SHELL IS PUBLIC, THE DATA IS NOT.
             *
             * The page has to load BEFORE anyone can type a passcode, so serving it
             * cannot require a session - and there is nothing secret in it: the HTML,
             * CSS and JavaScript contain no passcode, no token and no bot data. What is
             * protected is everything that reads or changes something: /api/state and
             * /api/mode below both refuse without a valid session, so bypassing the lock
             * screen gets a page that can do nothing at all.
             */
            if (!route.startsWith('/api/') && req.method === 'GET') return serveStatic(res, route)

            /* --- everything below needs a VALID PASSCODE session, not just a link --- */
            const claims = verifyToken(sessionTokenOf(req))
            if (!claims) return json(res, 401, { ok: false, error: 'unauthorised' })
            if (claims.scope !== 'unlocked') {
                return json(res, 403, {
                    ok: false,
                    error: 'locked',
                    message: 'This session reached the lock screen but has not passed the passcode yet.'
                })
            }

            if (route === '/api/state' && req.method === 'GET') {
                return json(res, 200, { ok: true, state: buildState(getConn(), meta) })
            }

            /*
             * THE REAL MODE SWITCH. It writes the mode the router reads, and answers
             * with the state as it is AFTER the write - so a reply claiming success
             * is always backed by what is on disk.
             */
            if (route === '/api/mode' && req.method === 'POST') {
                const body = await readBody(req)
                const wanted = String(body.mode || '').toLowerCase()
                if (!['original', 'level2'].includes(wanted)) {
                    return json(res, 400, { ok: false, error: 'invalid-mode', allowed: ['original', 'level2'] })
                }
                writeStore({
                    mode: wanted,
                    modeChangedAt: new Date().toISOString(),
                    modeChangedBy: String(body.by || 'level2-interface')
                })
                console.log(`[LEVEL2] mode switched to ${wanted} by the interface`)
                return json(res, 200, { ok: true, state: buildState(getConn(), meta) })
            }

            return json(res, 405, { ok: false, error: 'method not allowed' })
        } catch (error) {
            console.error('[LEVEL2] request failed:', error?.message || error)
            return json(res, 500, { ok: false, error: 'server-error' })
        }
    }
}

/**
 * Start the interface server. Called by index.js (Stage 2) or directly for a
 * standalone preview. Never throws at the caller: a failure to bind a port must
 * not be able to stop the WhatsApp bot from running.
 */
function start(connOrOptions = {}, maybeOptions = {}) {
    const looksLikeConn = typeof connOrOptions?.sendMessage === 'function' || connOrOptions?.ev || connOrOptions?.user
    const conn = looksLikeConn ? connOrOptions : null
    const options = looksLikeConn ? maybeOptions : (connOrOptions || {})

    const port = Number(options.port || process.env.DARKNOTE_L2_PORT || DEFAULT_PORT)
    const host = String(options.host || process.env.DARKNOTE_L2_HOST || '0.0.0.0')
    const meta = { startedAt: new Date().toISOString(), port }

    const server = http.createServer(createHandler({ getConn: () => conn, meta }))
    server.on('error', (error) => {
        console.error(`[LEVEL2] server could not start on ${host}:${port} —`, error?.message || error)
    })
    server.listen(port, host, () => {
        console.log(`[LEVEL2] interface listening on http://${host}:${port} (passcode ${isConfigured() ? 'set' : 'NOT SET — locked until one is set'})`)
    })
    return server
}

/**
 * Mint a single-use entry link. The WhatsApp `performance` command calls this in
 * Stage 3; the CLI calls it now. The token is random, expires, and is consumed on
 * first use - and the passcode is still required after it.
 */
function createLoginLink({ baseUrl = '', ttlMs = 10 * 60 * 1000 } = {}) {
    const token = crypto.randomBytes(24).toString('base64url')
    const store = readStore()
    const links = { ...(store.loginLinks || {}) }
    // Housekeeping: drop anything expired so the file cannot grow forever.
    for (const [key, value] of Object.entries(links)) {
        if (Number(value?.expiresAt || 0) < Date.now()) delete links[key]
    }
    links[token] = { createdAt: new Date().toISOString(), expiresAt: Date.now() + ttlMs, usedAt: null }
    writeStore({ loginLinks: links })
    return { token, url: `${baseUrl.replace(/\/+$/, '')}/login?token=${token}`, expiresIn: ttlMs }
}

module.exports = { start, createHandler, createLoginLink, issueToken, verifyToken, hashPasscode, verifyPasscode, isConfigured, readStore, writeStore, STORE, TOKEN_TTL_MS }

/* ------------------------------- command line ----------------------------- */

if (require.main === module) {
    const args = process.argv.slice(2)
    const command = args[0]

    if (command === 'set-passcode') {
        const value = args[1]
        if (!value || String(value).length < 4) {
            console.error('usage: node level2/server.js set-passcode <at least 4 characters>')
            process.exit(2)
        }
        writeStore({ passcode: hashPasscode(value), passcodeSetAt: new Date().toISOString() })
        console.log(`✅ passcode stored as a scrypt hash in ${path.relative(ROOT, STORE)} (the value itself is not saved anywhere)`)
        process.exit(0)
    }

    if (command === 'status') {
        const store = readStore()
        console.log(JSON.stringify({
            store: path.relative(ROOT, STORE),
            passcodeSet: isConfigured(),
            passcodeSetAt: store.passcodeSetAt || null,
            mode: store.mode || 'original',
            secretPresent: Boolean(store.secret)
        }, null, 2))
        process.exit(0)
    }

    const portFlag = args.indexOf('--port')
    const port = portFlag !== -1 ? Number(args[portFlag + 1]) : undefined
    start({ port })
}
