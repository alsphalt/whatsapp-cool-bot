'use strict'

/*
 * RUNTIME MODEL — the pure half.
 *
 * Everything here is a pure function of (local hour, temperature): no DOM, no
 * network, no clock of its own. That is deliberate, because it is the only way
 * the scene can be tested at all — the picture is asserted from these values, and
 * `lib/runtime-screen.js` draws whatever this returns.
 *
 * Split out of runtime-card.js so the view can be redesigned without touching
 * the rules, and so the rules cannot quietly start depending on the view.
 */

const weather = require('./weather.js')

const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/* ------------------------------- the clock ------------------------------- */

/*
 * Six phases, matching what the operator asked for by name: the sun comes up in
 * the morning, the top person works in the afternoon, runs in the evening, is
 * bored and stumbling at night, and crawls after midnight.
 */
const PHASES = [
    { key: 'midnight', from: 22, to: 5, label: 'MIDNIGHT', sky: 'Midnight — everyone is asleep' },
    { key: 'dawn', from: 5, to: 7, label: 'DAWN', sky: 'The sun is coming up' },
    { key: 'morning', from: 7, to: 12, label: 'MORNING', sky: 'Morning sun, climbing' },
    { key: 'afternoon', from: 12, to: 17, label: 'AFTERNOON', sky: 'High sun, hot and busy' },
    { key: 'evening', from: 17, to: 20, label: 'EVENING', sky: 'The sun is going down' },
    { key: 'night', from: 20, to: 22, label: 'NIGHT', sky: 'Moon up, clouds drifting' }
]

/** Local hour (0-23.99) of a Date inside a zone, read from Intl. */
function localHourIn(timeZone, when = new Date()) {
    try {
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
        }).formatToParts(when)
        const get = (type) => Number(parts.find(part => part.type === type)?.value || 0)
        // Intl renders midnight as "24" in some ICU builds; 24 must fold to 0 or
        // the whole night phase would be shifted by a day.
        const hour = get('hour') % 24
        return hour + get('minute') / 60 + get('second') / 3600
    } catch {
        return null
    }
}

/** Which phase a local hour falls in. */
function phaseFor(hourFloat) {
    const hour = ((Number(hourFloat) || 0) % 24 + 24) % 24
    return PHASES.find(p => (p.from < p.to
        ? hour >= p.from && hour < p.to
        : hour >= p.from || hour < p.to)) || PHASES[0]
}

/** The hour the next phase begins. */
function nextPhaseAt(hourFloat) {
    return phaseFor(hourFloat).to
}

/* ------------------------------ the sky ------------------------------- */

/*
 * Sun up between 06:00 and 18:00, moon between 18:00 and 06:00, both on the same
 * arc: `xPct` sweeps left to right, `altitude` is 0 at the horizon and 1 at the
 * top. `yPct` is the arc for a short stage; screens map it through screenPos().
 */
function celestial(hourFloat) {
    const hour = ((Number(hourFloat) || 0) % 24 + 24) % 24
    const isSun = hour >= 6 && hour < 18
    const progress = isSun ? (hour - 6) / 12 : (((hour < 6 ? hour + 24 : hour) - 18) / 12)
    const p = Math.min(Math.max(progress, 0), 1)
    const altitude = Math.sin(Math.PI * p)
    return {
        body: isSun ? 'sun' : 'moon',
        progress: Number(p.toFixed(4)),
        xPct: Number((6 + p * 88).toFixed(2)),
        yPct: Number((80 - altitude * 62).toFixed(2)),
        altitude: Number(altitude.toFixed(4)),
        rising: p < 0.5
    }
}

/*
 * Where the body actually sits on a full-height phone screen, as a percentage.
 * The band is the part of the display that is left visible between the lock
 * clock and the widget cards, so the sun never hides behind the clock at noon.
 */
const SKY_TOP_PCT = 33
const SKY_HORIZON_PCT = 70
const SKY_LEFT_PCT = 8
const SKY_RIGHT_PCT = 92

function screenPos(sky) {
    const span = SKY_RIGHT_PCT - SKY_LEFT_PCT
    return {
        left: Number((SKY_LEFT_PCT + ((sky.xPct - 6) / 88) * span).toFixed(2)),
        top: Number((SKY_HORIZON_PCT - sky.altitude * (SKY_HORIZON_PCT - SKY_TOP_PCT)).toFixed(2))
    }
}

/* ------------------------------ the people ------------------------------ */

/*
 * The top person's day, in the operator's own order: wake and drink tea, walk to
 * work, work, walk back, cook, sleep.
 */
const TOP_ROUTINE = {
    midnight: { pose: 'sleep', text: 'asleep — it is the middle of the night' },
    dawn: { pose: 'wake', text: 'waking up and stretching' },
    morning: { pose: 'tea', text: 'drinking tea before leaving' },
    afternoon: { pose: 'work', text: 'at work — this is the long shift' },
    evening: { pose: 'commute', text: 'walking back home' },
    night: { pose: 'cook', text: 'cooking supper, then sleep' }
}

/*
 * The bottom person's pace: slow in the morning, "jorking" in the afternoon,
 * running in the evening, bored and stumbling at night, crawling after midnight.
 */
const BOTTOM_PACE = {
    midnight: { pace: 'crawl', speed: 3.4, text: 'crawling — too tired to stand up' },
    dawn: { pace: 'slow', speed: 2.8, text: 'walking slowly, still sleepy' },
    morning: { pace: 'walk', speed: 2.0, text: 'walking, warming up' },
    afternoon: { pace: 'jog', speed: 1.15, text: 'jorking — working and jogging at once' },
    evening: { pace: 'run', speed: 0.6, text: 'running, the day is ending' },
    night: { pace: 'bored', speed: 3.0, text: 'bored, and starting to fall over' }
}

/*
 * Clothes follow the clock first and the temperature second: at night the person
 * is in night clothes whatever the weather, otherwise cold means a coat and hot
 * means a t-shirt.
 */
function outfitFor(tempC, phaseKey) {
    if (phaseKey === 'midnight' || phaseKey === 'night') {
        return { key: 'night', label: 'night clothes (pyjamas)' }
    }
    // Number(null) and Number('') are both 0, which would sail through a plain
    // isFinite() check and report "jacket, 0°C" for a weather lookup that never
    // returned anything. Absent has to stay absent.
    const temp = (tempC === null || tempC === undefined || tempC === '') ? NaN : Number(tempC)
    if (!Number.isFinite(temp)) return { key: 'day', label: 'normal clothes (weather unknown)' }
    if (temp <= 15) return { key: 'warm', label: `warm clothes (jacket, ${temp}°C)` }
    if (temp >= 27) return { key: 'sunny', label: `sunny clothes (t-shirt, ${temp}°C)` }
    return { key: 'day', label: `normal clothes (${temp}°C)` }
}

/** Sky FX from the weather reading. */
function effectsFor(current) {
    if (!current) return { key: 'unknown', rain: 0, clouds: 2, glyph: 'cloud', label: 'weather unavailable' }
    // Accept both names: the raw Open-Meteo field is `weather_code`, while the
    // snapshot normalises it to `code`. Reading only one of them silently made
    // every sky "Unknown".
    const code = Number(current.code ?? current.weather_code)
    const rain = Number(current.precipitation) > 0 || (code >= 51 && code <= 82) || code >= 95
    const clouds = rain ? 5 : (code >= 2 && code <= 48 ? 4 : 1)
    const snow = [71, 73, 75, 77, 85, 86].includes(code)
    return {
        key: rain ? (snow ? 'snow' : 'rain') : (clouds > 2 ? 'cloudy' : 'clear'),
        rain: rain ? 1 : 0,
        clouds,
        glyph: snow ? 'snow' : (rain ? 'rain' : (clouds > 2 ? 'cloud' : 'sun')),
        label: weather.describeWeatherCode(code)
    }
}

/* --------------------------- deterministic scatter --------------------------- */

/*
 * Stars, clouds and rain are placed from a seeded generator rather than
 * Math.random(), so the same minute always renders the same picture. A card that
 * reshuffles on every run cannot be compared between two screenshots, and cannot
 * be tested at all.
 */
function scatter(seed, count, spreadX, spreadY) {
    let state = seed >>> 0
    const next = () => {
        state = (state * 1664525 + 1013904223) >>> 0
        return state / 4294967296
    }
    return Array.from({ length: count }, () => ({
        x: Number((next() * spreadX).toFixed(2)),
        y: Number((next() * spreadY).toFixed(2)),
        d: Number((next() * 4).toFixed(2)),
        s: Number((0.7 + next() * 0.9).toFixed(2))
    }))
}

module.exports = {
    PHASES,
    TOP_ROUTINE,
    BOTTOM_PACE,
    SKY_TOP_PCT,
    SKY_HORIZON_PCT,
    escapeHtml,
    localHourIn,
    phaseFor,
    nextPhaseAt,
    celestial,
    screenPos,
    outfitFor,
    effectsFor,
    scatter
}
