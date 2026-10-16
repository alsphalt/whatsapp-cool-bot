'use strict'

/*
 * CALCULATOR — the phone's own calculator.
 *
 * WHY THIS IS NOT `eval`, AND NOT FLOAT MATH.
 *
 * The phone is a browser, so the obvious implementation is `eval(input)` on a string.
 * That is both unsafe and WRONG for the thing this app is asked to do: JavaScript
 * numbers are binary doubles, so they cannot represent 0.1. `0.1 + 0.2` prints
 * 0.30000000000000004, `1.005 * 100` prints 100.49999999999999, and anything past
 * ~2^53 silently loses its low digits. A calculator that is "working well" and gives a
 * "correct answer" cannot be built on those.
 *
 * So the arithmetic is EXACT DECIMAL ON BigInt: a value is stored as
 * sign * digits / 10^scale with `digits` an arbitrary-precision BigInt. Addition,
 * subtraction and multiplication are then exact for any size of number, with no
 * rounding and no drift. Division is exact when it terminates and otherwise rounded
 * HALF UP to CALC_DIV_PRECISION significant digits - and the result is flagged
 * approximate, so the screen shows "≈" rather than passing a rounded number off as an
 * exact one.
 *
 * BigInt also means "large calculation" is a real capability, not a label: 2^1000,
 * 50!, or 12345678901234567890 * 98765432109876543210 all come out to the digit. There
 * is a deliberate ceiling on results (CALC_MAX_DIGITS) and on power exponents, so a
 * typo like 9^99999999 says so instead of hanging the phone.
 *
 * The expression parser is a real recursive-descent parser with the normal precedence
 * rules (( ) > ^ > * / % > + -), unary +/-. It is NOT left-to-right: this is why
 * 2 + 3 × 4 is 14 and not 20.
 */

;(function () {
    /* --- engine:start --- */

    const CALC_MAX_DIGITS = 4000      // refuse to build a result bigger than this
    const CALC_DIV_PRECISION = 30     // significant digits kept when a division is inexact

    /* A number is { sign: 1 | -1, digits: BigInt >= 0n, scale: number >= 0 }
       and means sign * digits / 10^scale. */
    function make(sign, digits, scale) {
        if (digits < 0n) { sign = -sign; digits = -digits }
        // Strip trailing zeros so equal values are structurally equal (1.50 -> 1.5).
        while (scale > 0 && digits % 10n === 0n) { digits /= 10n; scale-- }
        if (digits === 0n) return { sign: 1, digits: 0n, scale: 0 }
        return { sign, digits, scale }
    }

    const ZERO = make(1, 0n, 0)
    const isZero = (n) => n.digits === 0n
    const neg = (n) => (isZero(n) ? n : { sign: -n.sign, digits: n.digits, scale: n.scale })

    function pow10(k) {
        return 10n ** BigInt(k)
    }

    function guardSize(digits) {
        if (String(digits).length > CALC_MAX_DIGITS) {
            throw new Error(`That answer is longer than ${CALC_MAX_DIGITS} digits`)
        }
    }

    function alignTo(a, b) {
        const scale = Math.max(a.scale, b.scale)
        return [a.digits * pow10(scale - a.scale), b.digits * pow10(scale - b.scale), scale]
    }

    function add(a, b) {
        const [da, db, scale] = alignTo(a, b)
        const total = BigInt(a.sign) * da + BigInt(b.sign) * db
        guardSize(total < 0n ? -total : total)
        return make(total < 0n ? -1 : 1, total < 0n ? -total : total, scale)
    }

    const sub = (a, b) => add(a, neg(b))

    function mul(a, b) {
        const digits = a.digits * b.digits
        guardSize(digits)
        return make(a.sign * b.sign, digits, a.scale + b.scale)
    }

    /*
     * Division. Exact when the decimal expansion terminates (1/8 = 0.125); otherwise
     * rounded half up at CALC_DIV_PRECISION significant digits and returned with
     * `exact: false` so the caller can mark the result approximate.
     */
    function div(a, b) {
        if (isZero(b)) throw new Error('Cannot divide by zero')
        if (isZero(a)) return { value: ZERO, exact: true }
        // a/b = (A * 10^sb) / (B * 10^sa)
        const N = a.digits * pow10(b.scale)
        const D = b.digits * pow10(a.scale)
        let shift = CALC_DIV_PRECISION + String(D).length - String(N).length + 2
        if (shift < 0) shift = 0
        const scaled = N * pow10(shift)
        let q = scaled / D
        const remainder = scaled % D
        const exact = remainder === 0n
        if (!exact && remainder * 2n >= D) q += 1n          // half up
        guardSize(q)
        return { value: make(a.sign * b.sign, q, shift), exact }
    }

    /* Remainder, taking the sign of the dividend — the same rule as JavaScript's %. */
    function mod(a, b) {
        if (isZero(b)) throw new Error('Cannot take a remainder by zero')
        const [da, db, scale] = alignTo(a, b)
        const r = da - (da / db) * db
        return { value: make(a.sign, r, scale), exact: true }
    }

    /*
     * Power. The exponent must be a whole number: a fractional exponent needs roots,
     * which are almost always irrational, and printing a rounded root as though it were
     * the answer is the sort of quiet wrongness this app is built to avoid. A negative
     * exponent is allowed and goes through the exact/rounded division above.
     */
    function pow(a, b) {
        if (b.scale !== 0) throw new Error('^ needs a whole number exponent')
        const e = Number(b.digits)
        if (b.digits > 10000n || !Number.isSafeInteger(e)) throw new Error('^ exponent is too large (max 10000)')
        if (e === 0) return { value: make(1, 1n, 0), exact: true }
        if (String(a.digits).length * e > CALC_MAX_DIGITS) {
            throw new Error(`That power is longer than ${CALC_MAX_DIGITS} digits`)
        }
        let result = 1n
        let base = a.digits
        let k = e
        while (k > 0) {
            if (k & 1) result *= base
            k >>= 1
            if (k > 0) base *= base
        }
        guardSize(result)
        /*
         * The sign comes from the BASE and whether the exponent is ODD - (-2)^3 is -8,
         * (-2)^2 is 4. It must NOT come from the sign of the exponent: 2^-3 is +0.125,
         * and reading the exponent's sign here produced -0.125.
         */
        const resultSign = a.sign < 0 && e % 2 === 1 ? -1 : 1
        const magnitude = make(resultSign, result, a.scale * e)
        if (b.sign >= 0) return { value: magnitude, exact: true }
        const inverted = div(make(1, 1n, 0), magnitude)
        return { value: inverted.value, exact: inverted.exact }
    }

    function fromString(raw) {
        const text = String(raw).trim()
        if (!/^\d*\.?\d*$/.test(text) || text === '' || text === '.') {
            throw new Error(`"${raw}" is not a number`)
        }
        const [whole = '', fraction = ''] = text.split('.')
        return make(1, BigInt((whole || '0') + fraction), fraction.length)
    }

    /* digits + scale -> plain decimal text, no grouping, no exponent. */
    function toPlainString(n) {
        const digits = String(n.digits)
        const sign = n.sign < 0 && n.digits !== 0n ? '-' : ''
        if (n.scale === 0) return sign + digits
        const padded = digits.padStart(n.scale + 1, '0')
        const cut = padded.length - n.scale
        return sign + padded.slice(0, cut) + '.' + padded.slice(cut)
    }

    /* Thousands separators for the DIGITS only — never inside the fraction, and the
       fraction is never truncated: a 300-digit answer stays readable rather than being
       rounded into something that is not the answer. */
    function group(text) {
        const [whole, fraction] = text.split('.')
        const sign = whole.startsWith('-') ? '-' : ''
        const body = sign ? whole.slice(1) : whole
        const grouped = body.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
        return sign + grouped + (fraction === undefined ? '' : '.' + fraction)
    }

    const ALIASES = { '×': '*', '÷': '/', '−': '-', '–': '-', 'x': '*', 'X': '*', '·': '*' }

    function tokenize(input) {
        const text = String(input).replace(/[\s,_]/g, '')
        const tokens = []
        let i = 0
        while (i < text.length) {
            const ch = text[i]
            if (/[0-9.]/.test(ch)) {
                const start = i
                while (i < text.length && /[0-9.]/.test(text[i])) i++
                tokens.push({ type: 'number', value: text.slice(start, i) })
                continue
            }
            const mapped = ALIASES[ch] || ch
            if ('+-*/%^()'.includes(mapped) && mapped.length === 1) {
                tokens.push({ type: 'op', value: mapped })
                i++
                continue
            }
            throw new Error(`"${ch}" is not something this calculator understands`)
        }
        return tokens
    }

    /*
     * evaluate(input) -> { ok: true, text, approximate } | { ok: false, error }
     *
     * `text` is the grouped, plain-decimal answer. `approximate` is true only when a
     * division or a negative power had to be rounded.
     */
    function evaluate(input) {
        let tokens
        try {
            tokens = tokenize(input)
        } catch (error) {
            return { ok: false, error: error.message }
        }
        if (!tokens.length) return { ok: false, error: 'Nothing to calculate' }

        let pos = 0
        let approximate = false
        const peek = () => tokens[pos]
        const takeOp = (allowed) => {
            const token = peek()
            if (token && token.type === 'op' && allowed.includes(token.value)) { pos++; return token.value }
            return null
        }

        function parseExpression() {
            let left = parseTerm()
            for (;;) {
                const op = takeOp(['+', '-'])
                if (!op) return left
                left = op === '+' ? add(left, parseTerm()) : sub(left, parseTerm())
            }
        }

        function parseTerm() {
            let left = parseUnary()
            for (;;) {
                const op = takeOp(['*', '/', '%'])
                if (!op) return left
                const right = parseUnary()
                if (op === '*') left = mul(left, right)
                else if (op === '%') left = mod(left, right).value
                else {
                    const result = div(left, right)
                    left = result.value
                    if (!result.exact) approximate = true
                }
            }
        }

        /* Unary +/- binds looser than ^, so -2^2 is -(2^2) = -4, as in maths. */
        function parseUnary() {
            const op = takeOp(['+', '-'])
            if (op === '-') return neg(parseUnary())
            if (op === '+') return parseUnary()
            return parsePower()
        }

        function parsePower() {
            const base = parsePrimary()
            if (takeOp(['^'])) {
                const result = pow(base, parseUnary())
                if (!result.exact) approximate = true
                return result.value
            }
            return base
        }

        function parsePrimary() {
            const token = peek()
            if (!token) throw new Error('The expression ends too early')
            if (token.type === 'number') { pos++; return fromString(token.value) }
            if (token.value === '(') {
                pos++
                const value = parseExpression()
                if (!takeOp([')'])) throw new Error('A bracket was never closed')
                return value
            }
            throw new Error(`Unexpected "${token.value}"`)
        }

        try {
            const value = parseExpression()
            if (pos < tokens.length) throw new Error(`Unexpected "${tokens[pos].value}"`)
            return { ok: true, text: group(toPlainString(value)), approximate }
        } catch (error) {
            return { ok: false, error: error.message }
        }
    }

    /* --- engine:end --- */

    /*
     * Everything above is pure arithmetic with no DOM contact, which is what makes it
     * testable: tests/calculator.calc.test.js slices the marked region out and runs it
     * in Node against known-good answers.
     *
     * Everything below is the screen.
     */

    const KEYS = [
        { label: 'C', value: 'clear', kind: 'warn' },
        { label: '⌫', value: 'del', kind: 'quiet' },
        { label: '(', value: '(' },
        { label: ')', value: ')' },
        { label: '7', value: '7' }, { label: '8', value: '8' }, { label: '9', value: '9' },
        { label: '÷', value: '/', kind: 'op' },
        { label: '4', value: '4' }, { label: '5', value: '5' }, { label: '6', value: '6' },
        { label: '×', value: '*', kind: 'op' },
        { label: '1', value: '1' }, { label: '2', value: '2' }, { label: '3', value: '3' },
        { label: '−', value: '-', kind: 'op' },
        { label: '±', value: 'negate', kind: 'quiet' },
        { label: '0', value: '0' },
        { label: '.', value: '.' },
        { label: '+', value: '+', kind: 'op' },
        { label: '%', value: '%', kind: 'op' },
        { label: '^', value: '^', kind: 'op' },
        { label: 'ANS', value: 'ans', kind: 'quiet' },
        { label: '=', value: 'equals', kind: 'equals' }
    ]

    /* Kept in the module, so leaving the app and coming back does not wipe a long
       calculation the way a per-render reset would. */
    const memory = { input: '', answer: '', history: [] }

    function isComplete(input) {
        // Only preview when the expression looks finished, so typing "12+" does not
        // flash an error at the user mid-keystroke.
        return /[\d)]$/.test(input.trim())
    }

    function negateTrailingNumber(input) {
        const match = input.match(/(\d*\.?\d+)$/)
        if (!match) return input
        const start = input.length - match[0].length
        const before = input.slice(0, start)
        const last = before[before.length - 1]
        // (-5) -> 5 ; 5 at the start or after an operator -> -5
        if (last === '-' && /[+\-*/%(^]$/.test(before.slice(0, -1)) || last === '-' && before.length === 1) {
            return before.slice(0, -1) + match[0]
        }
        if (/[+\-*/%(^]$/.test(last) || last === undefined) {
            return before + '-' + match[0]
        }
        return before + '-' + match[0]
    }

    window.DarknoteApps.register({
        id: 'calculator',
        label: 'Calculator',
        icon: '<span>🧮</span>',
        iconClass: 'icon-calculator',

        render(root, ctx) {
            root.appendChild(ctx.el(`
                <div class="calc">
                    <div class="calc-screen">
                        <div class="calc-expr" data-calc-expr aria-live="polite">${ctx.escape(memory.input || '0')}</div>
                        <div class="calc-preview" data-calc-preview></div>
                    </div>
                    <div class="calc-history" data-calc-history></div>
                    <div class="calc-pad" data-calc-pad></div>
                    <div class="note">
                        Exact decimal maths on whole-number digits, so long calculations do not
                        drift. <b>%</b> is a remainder, <b>^</b> takes whole-number exponents
                        only, and a result shown with <b>≈</b> is rounded to 30 significant
                        digits.
                    </div>
                </div>
            `))

            const exprEl = root.querySelector('[data-calc-expr]')
            const previewEl = root.querySelector('[data-calc-preview]')
            const historyEl = root.querySelector('[data-calc-history]')
            const padEl = root.querySelector('[data-calc-pad]')

            function paintPreview() {
                const input = memory.input
                if (!input) { previewEl.textContent = ''; previewEl.className = 'calc-preview'; return }
                if (!isComplete(input)) { previewEl.textContent = ''; previewEl.className = 'calc-preview'; return }
                const result = evaluate(input)
                if (result.ok) {
                    previewEl.textContent = `${result.approximate ? '≈ ' : '= '}${result.text}`
                    previewEl.className = 'calc-preview is-ok'
                } else {
                    previewEl.textContent = ''
                    previewEl.className = 'calc-preview'
                }
            }

            function paintHistory() {
                historyEl.innerHTML = ''
                if (!memory.history.length) { historyEl.classList.remove('has-items'); return }
                historyEl.classList.add('has-items')
                for (const entry of memory.history) {
                    const row = ctx.el(`<button class="calc-history-row" type="button">
                        <span class="calc-history-expr">${ctx.escape(entry.expression)}</span>
                        <span class="calc-history-value">${ctx.escape(entry.result)}</span>
                    </button>`)
                    row.addEventListener('click', () => {
                        memory.input = entry.result.replace(/,/g, '')
                        paint()
                    })
                    historyEl.appendChild(row)
                }
            }

            function paint() {
                exprEl.textContent = memory.input || '0'
                exprEl.scrollLeft = exprEl.scrollWidth      // huge answers: show the end
                paintPreview()
                paintHistory()
            }

            function commit() {
                const input = memory.input.trim()
                if (!input) return
                const result = evaluate(input)
                if (!result.ok) {
                    previewEl.textContent = result.error
                    previewEl.className = 'calc-preview is-bad'
                    return
                }
                const text = (result.approximate ? '≈ ' : '') + result.text
                memory.history.unshift({ expression: input, result: text })
                memory.history = memory.history.slice(0, 6)
                memory.answer = result.text.replace(/,/g, '')
                memory.input = memory.answer
                paint()
            }

            function press(value) {
                switch (value) {
                    case 'clear': memory.input = ''; break
                    case 'del': memory.input = memory.input.slice(0, -1); break
                    case 'equals': commit(); return
                    case 'ans': memory.input += memory.answer || ''; break
                    case 'negate': memory.input = negateTrailingNumber(memory.input); break
                    default: memory.input += value
                }
                paint()
            }

            for (const key of KEYS) {
                const button = ctx.el(`<button class="calc-key${key.kind ? ` is-${key.kind}` : ''}" type="button">${key.label}</button>`)
                button.addEventListener('click', () => press(key.value))
                padEl.appendChild(button)
            }

            root.querySelector('[data-calc-pad]').addEventListener('keydown', (event) => {
                if (event.key === 'Enter') { event.preventDefault(); commit() }
            })

            paint()
        }
    })
})()
