'use strict'

/*
 * DARKNOTE LEVEL 2 — the phone's behaviour.
 *
 * Rules this file follows, because the project asks for them explicitly:
 *   - the passcode is NEVER checked here; the server decides, and until it says
 *     yes the phone stays on the lock screen;
 *   - nothing reports success that did not happen: every button that performs an
 *     action shows the server's real answer, including its errors;
 *   - the battery is only ever REAL or clearly SIMULATED, never real-looking;
 *   - navigation is a real stack, so Back goes to the previous screen and the
 *     browser's own Back button does the same thing.
 */

const SIMULATED_BATTERY = { level: 76, charging: false }

/* --------------------------------- the API -------------------------------- */

const api = {
    async call(path, { method = 'GET', body } = {}) {
        let response
        try {
            response = await fetch(path, {
                method,
                // The session cookie the server sets is HttpOnly; sending it back
                // is the whole of the client's authentication.
                credentials: 'same-origin',
                headers: body ? { 'content-type': 'application/json' } : undefined,
                body: body ? JSON.stringify(body) : undefined
            })
        } catch {
            throw new Error('The server is unreachable. Check that the interface is running.')
        }
        let payload = {}
        try { payload = await response.json() } catch { /* non-JSON error page */ }
        if (!response.ok || payload.ok === false) {
            const error = new Error(payload.message || payload.error || `Request failed (${response.status})`)
            error.code = payload.error || String(response.status)
            error.status = response.status
            error.payload = payload
            throw error
        }
        return payload
    },
    health: () => api.call('/api/health'),
    state: () => api.call('/api/state'),
    unlock: (passcode) => api.call('/api/unlock', { method: 'POST', body: { passcode } }),
    setMode: (mode, by) => api.call('/api/mode', { method: 'POST', body: { mode, by } })
}

/* ------------------------------- small helpers ----------------------------- */

const $ = (id) => document.getElementById(id)

/*
 * Build elements from markup.
 *
 * A single root element is returned as-is. MARKUP WITH SEVERAL ROOTS IS WRAPPED
 * rather than trimmed to the first one: `firstElementChild` silently discarded
 * everything after the first element, so an app whose markup was three panels
 * rendered only the first and then threw when it looked for a button that had been
 * dropped. Wrapping keeps every node the caller wrote.
 */
const el = (html) => {
    const template = document.createElement('template')
    template.innerHTML = html.trim()
    const roots = [...template.content.children]
    if (roots.length === 1) return roots[0]
    const wrapper = document.createElement('div')
    wrapper.className = 'stack'
    wrapper.append(...template.content.children)
    return wrapper
}

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/* --------------------------------- the clock ------------------------------- */

function startClock() {
    const time = $('sb-clock')
    const lockTime = $('lock-clock')
    const lockDate = $('lock-date')
    const tick = () => {
        const now = new Date()
        const hh = String(now.getHours()).padStart(2, '0')
        const mm = String(now.getMinutes()).padStart(2, '0')
        time.textContent = `${hh}:${mm}`
        lockTime.textContent = `${hh}:${mm}`
        lockDate.textContent = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
    }
    tick()
    setInterval(tick, 1000)
}

/* -------------------------------- the battery ------------------------------ */

/*
 * The real level when the browser exposes it (Chrome/Android), otherwise a
 * configured value that is REPORTED AS SIMULATED - in the Settings app and in the
 * title attribute - so a made-up number is never mistaken for the device's own.
 */
async function startBattery() {
    const icon = $('sb-battery-icon')
    const text = $('sb-battery-text')

    const paint = ({ level, charging, real }) => {
        text.textContent = `${level}%`
        icon.textContent = charging ? '⚡' : (level <= 20 ? '▱' : '▰')
        icon.style.color = level <= 20 ? '#ff8080' : '#17b24a'
        const marker = real ? 'device battery' : 'simulated level'
        text.title = marker
        icon.title = marker
        window.__darknoteBattery = { level, charging, real }
    }

    if (navigator.getBattery) {
        try {
            const battery = await navigator.getBattery()
            const update = () => paint({ level: Math.round(battery.level * 100), charging: battery.charging, real: true })
            battery.addEventListener('levelchange', update)
            battery.addEventListener('chargingchange', update)
            update()
            return
        } catch { /* fall through to the simulated, clearly-labelled value */ }
    }
    paint({ ...SIMULATED_BATTERY, real: false })
}

/* ------------------------------- the registry ------------------------------ */

const apps = (window.DarknoteApps = window.DarknoteApps || {
    list: [],
    register(app) { this.list.push(app); return app },
    get(id) { return this.list.find(a => a.id === id) || null }
})

function buildHomeGrid() {
    const grid = $('app-grid')
    grid.innerHTML = ''
    for (const app of apps.list) {
        const tile = el(`
            <button class="app-tile${app.disabled ? ' is-disabled' : ''}" type="button" ${app.disabled ? 'disabled' : ''}>
                <span class="app-icon ${app.iconClass || ''}">${app.icon || ''}</span>
                <span class="app-label">${escape(app.label)}</span>
            </button>`)
        tile.addEventListener('click', () => openApp(app.id))
        grid.appendChild(tile)
    }
}

/* ------------------------------ navigation -------------------------------- */

const nav = {
    stack: [],
    /*
     * Back is a real step through a stack, and each step mirrors into the browser's
     * own history. That is what makes the hardware/browser Back button do the same
     * thing as the on-screen one instead of leaving the phone.
     */
    push(view, { silent = false } = {}) {
        this.stack.push(view)
        if (!silent) history.pushState({ darknoteView: view }, '', `#${view}`)
        this.render()
    },
    back() {
        if (this.stack.length <= 1) { this.home(); return }
        this.stack.pop()
        this.render()
    },
    home() {
        this.stack = ['home']
        this.render()
    },
    current() { return this.stack[this.stack.length - 1] || 'home' },
    render() {
        const view = this.current()
        const onHome = view === 'home'
        $('home').classList.toggle('is-visible', onHome)
        $('app-host').classList.toggle('is-visible', !onHome)
        $('navbar').hidden = onHome
        if (onHome) return

        /*
         * A view is either an app id ('settings') or a game inside the console
         * ('game:tictactoe'). Both render into the same host and sit on the same
         * navigation stack, which is why Back works identically in a game.
         */
        const isGame = view.startsWith('game:')
        const app = isGame ? (window.DarknoteGames?.list.find(g => g.id === view.slice(5)) || null) : apps.get(view)
        $('app-title').textContent = app ? app.label.toUpperCase() : view.toUpperCase()
        const body = $('app-body')
        body.innerHTML = ''
        if (app?.render) {
            /*
             * An app that throws must not leave a blank screen: that is
             * indistinguishable from "the phone is broken" and says nothing about
             * what went wrong. The failure is shown where the app would have been.
             */
            try {
                app.render(body, context)
            } catch (error) {
                console.error(`[L2] app "${view}" failed to render:`, error)
                body.innerHTML = ''
                body.appendChild(el(`
                    <div class="panel">
                        <h3>APP ERROR</h3>
                        <div class="result is-bad">${escape(error?.message || error)}</div>
                        <div class="note">${escape(String(error?.stack || '').split('\n')[1] || '')}</div>
                    </div>`))
            }
        } else {
            body.appendChild(el('<div class="panel"><h3>NOT INSTALLED</h3><div class="note">This app is not registered.</div></div>'))
        }
        $('app-host').classList.remove('is-opening')
        void $('app-host').offsetWidth      // restart the animation
        $('app-host').classList.add('is-opening')
    }
}

async function openApp(id) {
    const app = apps.get(id)
    if (!app || app.disabled) return
    /*
     * READ THE STATE, THEN OPEN.
     *
     * Apps display live bot state, and that state changes outside this screen - the
     * mode can be switched by a WhatsApp command, the bot can drop its connection.
     * Opening an app without re-reading showed a stale picture (Swap still believed
     * the phone was in Level 2 after the mode had already changed, and disabled its
     * own button). One request per app open keeps it current without any polling or
     * background loop; if the server is unreachable the app still opens, using the
     * last state it had, and says so where it matters.
     */
    try {
        await context.refreshState()
    } catch { /* keep the previous state rather than blocking the screen */ }
    nav.push(id)
}

/* --------------------------------- context -------------------------------- */

/* What an app receives. Everything an app can do to the bot goes through here, so
   the set of possible actions stays in one place as apps are added. */
const context = {
    api,
    nav,
    el,
    escape,
    state: null,
    async refreshState() {
        const { state } = await api.state()
        context.state = state
        paintState(state)
        return state
    },
    paintState
}

function paintState(state) {
    if (!state) return
    const mode = $('chip-mode')
    const bot = $('chip-bot')
    const isL2 = state.mode === 'level2'
    mode.textContent = `mode: ${isL2 ? 'LEVEL 2' : 'ORIGINAL DARKNOTE'}`
    mode.className = `chip ${isL2 ? 'is-good' : ''}`
    bot.textContent = `bot: ${state.bot}`
    bot.className = `chip ${state.bot === 'connected' ? 'is-good' : 'is-warn'}`
    const foot = $('home-foot')
    if (foot && state.interface) foot.textContent = `${state.interface.name} · ${state.interface.version}`
}

/* ------------------------------- lock screen ------------------------------ */

let pin = ''
let unlocking = false

function paintPin() {
    const dots = $('pin-display').children
    for (let i = 0; i < dots.length; i++) dots[i].classList.toggle('is-filled', i < pin.length)
}

function setLockMessage(text, kind = '') {
    const box = $('lock-message')
    box.textContent = text
    box.className = `lock-message${kind ? ` is-${kind}` : ''}`
}

function buildKeypad() {
    const pad = $('keypad')
    pad.innerHTML = ''
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'del']
    for (const key of keys) {
        const label = key === 'clear' ? 'CLR' : (key === 'del' ? '⌫' : key)
        const button = el(`<button type="button" class="${key === 'clear' || key === 'del' ? 'is-quiet' : ''}">${label}</button>`)
        button.addEventListener('click', () => pressKey(key))
        pad.appendChild(button)
    }
}

function pressKey(key) {
    if (unlocking) return
    if (key === 'del') { pin = pin.slice(0, -1); paintPin(); return }
    if (key === 'clear') { pin = ''; paintPin(); setLockMessage('Enter the passcode to open the phone.'); return }
    if (pin.length >= 6) return
    pin += key
    paintPin()
    if (pin.length === 6) submitPin()
}

async function submitPin() {
    unlocking = true
    setLockMessage('Checking with the server…')
    try {
        const result = await api.unlock(pin)
        setLockMessage('Passcode accepted.', 'ok')
        context.state = result.state
        unlockPhone()
    } catch (error) {
        pin = ''
        paintPin()
        const dots = $('pin-display')
        dots.classList.add('is-wrong')
        setTimeout(() => dots.classList.remove('is-wrong'), 340)
        if (error.code === 'wrong-passcode') {
            setLockMessage(`Wrong passcode${error.payload?.attempts ? ` (attempt ${error.payload.attempts})` : ''}.`, 'error')
        } else if (error.code === 'too-many-attempts') {
            const seconds = Math.ceil((error.payload?.retryAfterMs || 0) / 1000)
            setLockMessage(`Too many attempts. Try again in ${seconds}s.`, 'error')
        } else if (error.code === 'no-passcode') {
            setLockMessage('No passcode is set on the server. Run: node level2/server.js set-passcode <value>', 'error')
        } else {
            setLockMessage(error.message, 'error')
        }
    } finally {
        unlocking = false
    }
}

function unlockPhone() {
    pin = ''
    paintPin()
    $('lock').classList.remove('is-visible')
    nav.home()
    context.refreshState().catch(() => {})
}

async function checkServer() {
    const line = $('lock-server')
    try {
        const health = await api.health()
        if (!health.configured) {
            line.textContent = 'server reachable · no passcode set'
            line.classList.add('is-offline')
            setLockMessage('The server has no passcode configured, so the phone cannot be opened yet.', 'error')
            return
        }
        line.textContent = 'server reachable · passcode required'
        line.classList.remove('is-offline')
        // A cookie from an earlier visit may still be valid.
        try {
            const { state } = await api.state()
            context.state = state
            setLockMessage('Session restored.', 'ok')
            unlockPhone()
        } catch { /* no valid session: stay locked, as expected */ }
    } catch (error) {
        line.textContent = 'server unreachable · the phone stays locked'
        line.classList.add('is-offline')
        setLockMessage(error.message, 'error')
    }
}

/* --------------------------------- startup -------------------------------- */

function bindChrome() {
    $('app-back').addEventListener('click', () => nav.back())
    $('app-home').addEventListener('click', () => nav.home())
    for (const button of document.querySelectorAll('[data-nav]')) {
        button.addEventListener('click', () => {
            const action = button.dataset.nav
            if (action === 'back') nav.back()
            else nav.home()
        })
    }
    window.addEventListener('popstate', () => {
        // The browser moved through its own history: follow it without pushing another entry.
        if (nav.stack.length > 1) { nav.stack.pop(); nav.render() } else { nav.home() }
    })
}

function boot() {
    startClock()
    startBattery()
    buildKeypad()
    buildHomeGrid()
    bindChrome()
    paintPin()
    const hash = location.hash.replace('#', '')
    if (hash && apps.get(hash)) nav.stack = ['home']   // deep links land on home + app
    checkServer()
}

document.addEventListener('DOMContentLoaded', boot)
