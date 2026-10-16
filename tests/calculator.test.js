'use strict'

/*
 * The phone calculator's arithmetic.
 *
 * The engine lives in level2/public/apps/calculator.js, which is a browser file wrapped
 * in an IIFE — it never exports anything to Node. The region marked
 * `/* --- engine:start --- *\/` ... `/* --- engine:end --- *\/` is pure arithmetic with
 * no DOM contact, so it is sliced out and evaluated here. That slice is the point of the
 * markers: the app is testable without a headless browser, and this suite cannot drift
 * out of sync with the file it tests (a missing marker fails the first assertion).
 *
 * The reason this suite exists at all is the failure the app was written to avoid:
 * doubles cannot represent 0.1, so the natural browser implementation prints
 * 0.30000000000000004 for 0.1 + 0.2 and loses digits past 2^53. Every exactness claim
 * below is asserted against the answer a human would write down.
 */

const fs = require('fs')
const path = require('path')

const APP = path.join(__dirname, '..', 'level2', 'public', 'apps', 'calculator.js')
const START = '/* --- engine:start --- */'
const END = '/* --- engine:end --- */'

function loadEngine() {
    const source = fs.readFileSync(APP, 'utf8')
    const from = source.indexOf(START)
    const to = source.indexOf(END)
    if (from === -1 || to === -1 || to <= from) {
        throw new Error('the engine markers are missing from calculator.js')
    }
    const slice = source.slice(from + START.length, to)
    // eslint-disable-next-line no-new-func -- the slice is repo source, not user input
    return new Function(`${slice}; return { evaluate, toPlainString, fromString, div, pow, mul, add };`)()
}

module.exports = function calculatorSuite(h) {
    const { section, ok, eq } = h
    let engine

    section('calculator -- the app file is loadable')
    try {
        engine = loadEngine()
        ok('the marked engine region is present and evaluates', true)
    } catch (error) {
        ok('the marked engine region is present and evaluates', false, error.message)
        return
    }
    const run = (expression) => engine.evaluate(expression)
    const text = (expression) => {
        const result = run(expression)
        return result.ok ? result.text : `ERROR: ${result.error}`
    }

    section('calculator -- exact decimals (the reason it is not float math)')
    eq('0.1 + 0.2 is 0.3, not 0.30000000000000004', text('0.1+0.2'), '0.3')
    eq('1.005 * 100 is 100.5, not 100.49999999999999', text('1.005*100'), '100.5')
    eq('0.1 * 3 is 0.3', text('0.1*3'), '0.3')
    eq('0.3 - 0.1 is 0.2', text('0.3-0.1'), '0.2')
    eq('1.1 + 2.2 is 3.3', text('1.1+2.2'), '3.3')
    ok('the same sum in float math is visibly wrong',
        String(0.1 + 0.2) !== '0.3',
        `float gives ${0.1 + 0.2}`)

    section('calculator -- precedence and brackets, not left to right')
    eq('2 + 3 * 4 is 14', text('2+3*4'), '14')
    eq('(2 + 3) * 4 is 20', text('(2+3)*4'), '20')
    eq('2 + 3 * 4 - 6 / 2 is 11', text('2+3*4-6/2'), '11')
    eq('nested brackets resolve inside out', text('((1+2)*(3+4))/3'), '7')
    eq('unary minus binds looser than the power', text('-2^2'), '-4')
    eq('a negative in brackets keeps the power positive', text('(-2)^2'), '4')

    section('calculator -- division: exact when it terminates')
    eq('1 / 8 is 0.125', text('1/8'), '0.125')
    eq('10 / 4 is 2.5', text('10/4'), '2.5')
    eq('100 / 5 is 20', text('100/5'), '20')
    ok('1 / 8 is reported exact', run('1/8').approximate !== true)
    ok('10 / 4 is reported exact', run('10/4').approximate !== true)

    section('calculator -- division: rounded, and it says so')
    const third = run('1/3')
    ok('1 / 3 succeeds', third.ok === true)
    ok('1 / 3 is flagged approximate rather than passed off as exact', third.approximate === true)
    // At least CALC_DIV_PRECISION (30) significant digits are kept; the engine carries
    // two digits of slack for the half-up rounding, so it lands on 32 here.
    const thirdDigits = third.text.replace(/^0\./, '').replace(/[^\d]/g, '')
    ok('1 / 3 keeps at least 30 significant digits', thirdDigits.length >= 30, `${thirdDigits.length} digits`)
    ok('1 / 3 is all threes', /^3+$/.test(thirdDigits), thirdDigits.slice(0, 12))
    ok('1 / 3 starts 0.333333333333333333333333333333', third.text.startsWith('0.333333333333333333333333333333'))
    ok('2 / 3 is also approximate', run('2/3').approximate === true)

    section('calculator -- powers')
    eq('2 ^ 10 is 1,024', text('2^10'), '1,024')
    eq('2 ^ -3 is 0.125 (a negative exponent takes the reciprocal)', text('2^-3'), '0.125')
    eq('(-2) ^ 3 is -8', text('(-2)^3'), '-8')
    eq('(-2) ^ 2 is 4', text('(-2)^2'), '4')
    eq('anything ^ 0 is 1', text('5^0'), '1')
    eq('0.5 ^ 2 is 0.25', text('0.5^2'), '0.25')

    section('calculator -- large calculations hold')
    const big = run('2^1000')
    ok('2 ^ 1000 succeeds', big.ok === true, big.ok ? '' : big.error)
    eq('2 ^ 1000 has 302 digits', big.text.replace(/,/g, '').length, 302)
    ok('2 ^ 1000 starts 10715086071862673209',
        big.text.replace(/,/g, '').startsWith('10715086071862673209'))
    ok('2 ^ 1000 is exact, not approximate', big.approximate !== true)
    eq('a 40-digit product is exact to the last digit',
        text('12345678901234567890*98765432109876543210'),
        '1,219,326,311,370,217,952,237,463,801,111,263,526,900')
    eq('adding 1 to 20 nines carries correctly',
        text('99999999999999999999+1'),
        '100,000,000,000,000,000,000')
    eq('integers beyond 2^53 keep their low digits',
        text('9007199254740993+0'),
        '9,007,199,254,740,993')

    section('calculator -- remainder')
    eq('10 % 3 is 1', text('10%3'), '1')
    eq('10.5 % 3 is 1.5', text('10.5%3'), '1.5')

    section('calculator -- grouping is cosmetic only')
    eq('seven digits are grouped in threes', text('1234567'), '1,234,567')
    eq('the fraction is never grouped', text('1234.5678'), '1,234.5678')

    section('calculator -- bad input is refused with a reason')
    const expectError = (name, expression, fragment) => {
        const result = run(expression)
        ok(name, result.ok === false && String(result.error).toLowerCase().includes(fragment),
            result.ok ? `it returned ${result.text}` : result.error)
    }
    expectError('dividing by zero is refused', '1/0', 'divide by zero')
    expectError('an unclosed bracket is refused', '(2+3', 'bracket')
    expectError('letters are refused', 'abc', 'understands')
    expectError('a fractional exponent is refused', '2^0.5', 'whole number exponent')
    // Two separate ceilings: the exponent itself, and the digit count the answer would need.
    expectError('an absurd exponent is refused rather than hanging', '9^99999', 'too large')
    expectError('a power with an answer past the digit ceiling is refused', '9^5000', 'longer than')
    expectError('a dangling operator is refused', '2+', 'ends too early')
    expectError('an empty expression is refused', '', 'nothing to calculate')
    expectError('a stray closing bracket is refused', '2+3)', 'unexpected')
    expectError('a repeated operator is refused', '2**3', 'unexpected')

    section('calculator -- symbols the keypad sends')
    eq('x is accepted as multiply', text('6x7'), '42')
    eq('the times sign is accepted', text('6\u00d77'), '42')
    eq('the division sign is accepted', text('84\u00f74'), '21')
    eq('spaces and separators are ignored', text('1 234 + 1'), '1,235')
}
