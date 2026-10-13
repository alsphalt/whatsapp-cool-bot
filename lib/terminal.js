'use strict'

/*
 * DARKNOTE PANEL TERMINAL
 * ------------------------
 * Presentation-only terminal layer. It does not change bot behaviour or
 * WhatsApp/Telegram logic. It colours existing console output and prints a
 * compact BIGBRO header that adapts to the panel terminal width.
 */

const ansi = {
    reset: '\x1b[0m',
    gray: '\x1b[90m',
    white: '\x1b[37m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    bold: '\x1b[1m'
}

const paint = (colour, text, bold = false) => `${bold ? ansi.bold : ''}${ansi[colour] || ''}${text}${ansi.reset}`

const original = {
    log: console.log.bind(console),
    info: (console.info || console.log).bind(console),
    warn: (console.warn || console.log).bind(console),
    error: (console.error || console.log).bind(console)
}

const enabled = process.stdout.isTTY !== false || process.env.FORCE_COLOR

function width() {
    const value = Number(process.stdout.columns) || 80
    return Math.max(48, Math.min(value, 120))
}

function stamp() {
    return new Date().toLocaleTimeString([], { hour12: false })
}

function classify(text, level) {
    const value = String(text || '')
    if (level === 'error' || /\b(error|failed|failure|fatal|exception|crash|refused)\b|❌/i.test(value)) return value => paint('red', value)
    if (level === 'warn' || /\b(warn|warning|retry|reconnect|attention)\b|⚠️/i.test(value)) return value => paint('yellow', value)
    if (/\b(connected|online|success|ready|active|passed|complete|started)\b|✅|🟢/i.test(value)) return value => paint('green', value)
    if (/\b(telegram|pair|pairing)\b|🔗|🔐/i.test(value)) return value => paint('cyan', value)
    if (/\b(runtime|session|socket|whatsapp)\b/i.test(value)) return value => paint('blue', value)
    return value => paint('white', value)
}

/*
 * Render ONE logged argument for the panel.
 *
 * An Error keeps `message` and `stack` as NON-ENUMERABLE properties, so a bare
 * JSON.stringify() reduces every logged error to `{}` - the real cause is thrown
 * away and the console appears to report nothing at all. (`song search error: {}`
 * was exactly this.) Errors are therefore rendered from their stack, and an
 * Error-shaped object with no enumerable keys falls back to name + message
 * rather than collapsing to `{}`.
 */
function renderValue(value) {
    if (typeof value === 'string') return value
    if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`
    if (typeof value === 'object' && value !== null) {
        let keys = []
        try { keys = Object.keys(value) } catch { keys = [] }
        if (keys.length) {
            try { return JSON.stringify(value) } catch { return String(value) }
        }
        const name = typeof value.name === 'string' ? value.name : ''
        const message = typeof value.message === 'string' ? value.message : ''
        if (message) return `${name || 'Error'}: ${message}`
        const stack = typeof value.stack === 'string' ? value.stack : ''
        if (stack) return stack
        return '{}'
    }
    try { return JSON.stringify(value) } catch { return String(value) }
}

function render(level, args) {
    if (!enabled) return args

    const text = args.map(renderValue).join(' ')

    const colour = classify(text, level)
    const prefix = paint('gray', `[${stamp()}]`) + ' ' + colour(level.toUpperCase().padEnd(5))

    // Keep multi-line output readable: colour each existing line without
    // changing its content or adding extra lines.
    return text.split('\n').map((line, index) => {
        if (!line) return ''
        if (index === 0) return `${prefix} ${colour(line)}`
        return `         ${colour(line)}`
    }).join('\n')
}

function install() {
    if (console.__darknoteTerminalInstalled) return false
    console.__darknoteTerminalInstalled = true

    console.log = (...args) => original.log(render('info', args))
    console.info = (...args) => original.info(render('info', args))
    console.warn = (...args) => original.warn(render('warn', args))
    console.error = (...args) => original.error(render('error', args))

    return true
}

/* A medium BIGBRO wordmark, framed to the full panel width. */
function banner() {
    const w = width()
    const name = 'DARKNOTE'
    const inner = Math.max(10, w - 2)
    const line = '═'.repeat(inner)
    const gap = Math.max(0, Math.floor((inner - name.length) / 2))
    const centered = ' '.repeat(gap) + paint('blue', name, true) + ' '.repeat(Math.max(0, inner - gap - name.length))

    const art = [
        '██████╗ ██╗ ██████╗ ██████╗ ██████╗  ██████╗ ',
        '██╔══██╗██║██╔════╝ ██╔══██╗██╔══██╗██╔═══██╗',
        '██████╔╝██║██║  ███╗██████╔╝██████╔╝██║   ██║',
        '██╔══██╗██║██║   ██║██╔══██╗██╔══██╗██║   ██║',
        '██████╔╝██║╚██████╔╝██████╔╝██████╔╝╚██████╔╝',
        '╚═════╝ ╚═╝ ╚═════╝ ╚═════╝ ╚═════╝  ╚═════╝ '
    ]

    // If the terminal is narrow, use the single-line wordmark. Otherwise the
    // medium 6-row logo fits comfortably without becoming an oversized banner.
    const maxArt = Math.max(...art.map(line => line.length))
    const useArt = w >= maxArt + 8

    original.log('')
    original.log(paint('blue', '╔' + line + '╗'))
    if (useArt) {
        for (const row of art) {
            const left = Math.max(0, Math.floor((inner - row.length) / 2))
            const right = Math.max(0, inner - left - row.length)
            original.log(paint('blue', '║') + ' '.repeat(left) + paint('blue', row, true) + ' '.repeat(right) + paint('blue', '║'))
        }
    } else {
        original.log(paint('blue', '║') + centered + paint('blue', '║'))
    }
    original.log(paint('blue', '╚' + line + '╝'))
    original.log('')
}

module.exports = { install, banner }
