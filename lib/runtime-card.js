'use strict'

/*
 * DARKNOTE RUNTIME CARD — the orchestrator.
 *
 * Three layers, deliberately separated:
 *
 *   lib/runtime-model.js   the rules: what phase an hour is, where the sun sits,
 *                          what the two people are doing. Pure, no DOM, no clock.
 *   lib/runtime-screen.js  the picture: renders the model as a handset screen.
 *   lib/runtime-card.js    this file: gathers the real inputs (the paired number's
 *                          timezone, the live weather) and delivers the screen.
 *
 * Time comes from the NUMBER, not the server. lib/number-tz.js turns the paired
 * number into a country and an IANA zone, and the hour is then read from Intl for
 * that zone — the container runs on UTC, so it would otherwise always draw the
 * wrong sky.
 *
 * Weather failure is shown, not hidden: if Open-Meteo is unreachable the scene
 * still renders from the clock and the card says the reading is unavailable. It
 * never invents a temperature.
 */

const numberTz = require('./number-tz.js')
const weather = require('./weather.js')
const model = require('./runtime-model.js')
const screen = require('./runtime-screen.js')
const phone = require('./phone-frame.js')

const {
    PHASES, TOP_ROUTINE, BOTTOM_PACE,
    escapeHtml, localHourIn, phaseFor, nextPhaseAt, celestial, screenPos,
    outfitFor, effectsFor, scatter
} = model

/* ------------------------------ the snapshot ----------------------------- */

/**
 * Everything the screen needs, gathered once per `.runtime`.
 *
 * `number` is the PAIRED number (the bot's own), because the operator asked for
 * "real world time from where the paired number is". A place name can override
 * the country's main city when they want their actual town.
 */
async function snapshot({ number = '', place = '', when = new Date(), fallbackZone = '' } = {}) {
    const geo = numberTz.resolve(number, { fallbackZone, fallbackCity: '', fallbackCountry: '' })
    const zone = geo.zone
    const hour = localHourIn(zone, when)
    const safeHour = hour === null ? 0 : hour
    const phase = phaseFor(safeHour)

    const data = {
        ok: true,
        zone,
        zoneReason: geo.reason,
        zoneConfidence: geo.confidence,
        zoneSource: geo.source,
        callingCode: geo.callingCode,
        country: geo.country,
        countryCode: geo.cc,
        city: geo.city,
        place: geo.city,
        requestedPlace: String(place || '').trim(),
        hour: Number(safeHour.toFixed(4)),
        offsetSeconds: 0,
        offset: weather.offsetFor(zone, when) || '+00:00',
        localTime: weather.localTimeIn(zone, when),
        phase,
        sky: celestial(safeHour),
        routine: TOP_ROUTINE[phase.key] || TOP_ROUTINE.morning,
        pace: BOTTOM_PACE[phase.key] || BOTTOM_PACE.morning,
        outfit: outfitFor(null, phase.key),
        weather: null,
        weatherError: '',
        place_: null,
        capturedAt: when.toISOString()
    }

    // The page needs the raw offset to keep ticking on its own.
    const match = String(data.offset).match(/^([+-])(\d{2}):(\d{2})$/)
    data.offsetSeconds = match
        ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 3600 + Number(match[3]) * 60)
        : 0

    const lookupPlace = data.requestedPlace || geo.city
    if (lookupPlace) {
        try {
            const found = await weather.geocodePlace(lookupPlace)
            if (!found.ok) {
                data.weatherError = found.reason || 'the place could not be found'
            } else {
                const top = found.places[0]
                const described = weather.describePlace(top)
                data.place_ = described
                data.place = described.name
                // A place the operator named can sit in another zone; trust it.
                if (data.requestedPlace && weather.isTimeZone(described.timeZone) && described.timeZone !== zone) {
                    data.zone = described.timeZone
                    const h2 = localHourIn(described.timeZone, when)
                    if (h2 !== null) data.hour = Number(h2.toFixed(4))
                    data.phase = phaseFor(data.hour)
                    data.sky = celestial(data.hour)
                    data.routine = TOP_ROUTINE[data.phase.key] || data.routine
                    data.pace = BOTTOM_PACE[data.phase.key] || data.pace
                    data.offset = weather.offsetFor(described.timeZone, when) || data.offset
                    data.localTime = weather.localTimeIn(described.timeZone, when)
                    const m2 = String(data.offset).match(/^([+-])(\d{2}):(\d{2})$/)
                    data.offsetSeconds = m2
                        ? (m2[1] === '-' ? -1 : 1) * (Number(m2[2]) * 3600 + Number(m2[3]) * 60)
                        : data.offsetSeconds
                }
                const current = await weather.currentWeather(described.latitude, described.longitude)
                if (!current.ok) {
                    data.weatherError = current.reason || 'the forecast service did not answer'
                } else {
                    data.weather = {
                        temp: Number(current.current.temperature_2m),
                        feels: Number(current.current.apparent_temperature),
                        humidity: Number(current.current.relative_humidity_2m),
                        wind: Number(current.current.wind_speed_10m),
                        precipitation: Number(current.current.precipitation),
                        code: Number(current.current.weather_code),
                        text: weather.describeWeatherCode(current.current.weather_code),
                        observed: current.current.time
                    }
                }
            }
        } catch (error) {
            data.weatherError = error?.message || 'the weather lookup failed'
        }
    } else {
        data.weatherError = 'no city could be derived for this number'
    }

    data.outfit = outfitFor(data.weather ? data.weather.temp : null, data.phase.key)
    data.effects = effectsFor(data.weather)
    data.nextPhase = nextPhaseAt(data.hour)
    return data
}

/* ------------------------------ the delivery ------------------------------ */

const runtimeHtml = (data, skin = 'ios') => screen.buildSceneHtml(data, skin)

/**
 * HH:MM in a number's zone, for the status bar of the handset shell.
 *
 * The cards are drawn as phones, so the small clock in the corner has to be the
 * OWNER's time, not the container's — otherwise the shell contradicts the scene
 * underneath it.
 */
function statusClock(number, when = new Date()) {
    try {
        const zone = numberTz.resolve(number).zone
        const local = weather.localTimeIn(zone, when)
        return local ? local.time.slice(0, 5) : ''
    } catch {
        return ''
    }
}

/**
 * Deliver the runtime screen.
 *
 * One screen per skin, so `runtimeSkin:'both'` sends the iPhone frame and the
 * Galaxy frame. Never throws on the first failure: a skin that cannot be
 * delivered is reported in `delivered` rather than aborting the other one, and
 * the caller keeps its own text fallback.
 */
async function sendRuntimeCard(conn, chat, data, { mode, quoted, skins } = {}) {
    const pairCard = require('./pair-card.js')
    const wanted = skins || phone.resolveSkins(data.skin)
    const caption = (skin) => [
        '🕒 *DARKNOTE RUNTIME*',
        '',
        `${data.phase.label} in ${data.place || data.country || data.zone} — ${(data.localTime ? data.localTime.time : '').slice(0, 5)}`,
        data.weather ? `${Math.round(data.weather.temp)}°C · ${data.weather.text}` : 'weather unavailable',
        '',
        `Live scene on a ${phone.SKINS[skin] ? phone.SKINS[skin].label : skin} display. It keeps ticking after it is sent.`
    ].join('\n')

    const delivered = []
    const htmls = {}
    for (const skin of wanted) {
        const html = screen.buildSceneHtml(data, skin)
        htmls[skin] = html
        const result = await pairCard.sendHtmlCard(conn, chat, html, {
            mode: mode || pairCard.DEFAULT_DELIVERY,
            stage: 'runtime',
            fileName: `darknote-runtime-${skin}-${data.phase.key}.html`,
            caption: caption(skin),
            quoted
        })
        for (const path of result.delivered) delivered.push(`${skin}:${path}`)
    }
    return { delivered, htmls }
}

module.exports = {
    /* model, re-exported so existing callers and tests keep one entry point */
    PHASES,
    TOP_ROUTINE,
    BOTTOM_PACE,
    escapeHtml,
    localHourIn,
    phaseFor,
    nextPhaseAt,
    celestial,
    screenPos,
    outfitFor,
    effectsFor,
    scatter,
    /* view */
    buildSceneHtml: screen.buildSceneHtml,
    buildStyles: screen.buildStyles,
    buildPageScript: screen.buildPageScript,
    figureSvg: screen.figureSvg,
    wxGlyph: screen.wxGlyph,
    /* orchestration */
    snapshot,
    statusClock,
    runtimeHtml,
    sendRuntimeCard
}
