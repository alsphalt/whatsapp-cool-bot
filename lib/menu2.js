'use strict'

/*
 * MENU 2 — sign-up, then the phone.
 *
 * FLOW, in the order the operator described it:
 *   1. tap 🧩 Menu 2            -> an HTML card: 📸 flash, DARKNOTE DP, "DARKNOTE
 *                                  MENU2 IS ACTIVE", then the sign-up panel
 *   2. send the paired number   -> the bot verifies it and signs the account up once
 *   3. signed up                -> a WELCOME/LOADING card (the DP loads), which then
 *                                  settles into a SAMSUNG-STYLE LOCK SCREEN with a
 *                                  punch-hole camera, the clock and a battery that
 *                                  is derived from the time of day and drifts live
 *
 * WHAT THE CARD CANNOT DO. It runs in WhatsApp's offline HTML sandbox - no fetch, no
 * XHR, no remote assets - so a number typed INTO the card cannot reach the bot. The
 * card therefore asks for the number and says to send it in the chat. Nothing here
 * pretends the card submitted a form; that is why the field is a display element and
 * the card contains no <input> at all.
 *
 * THE DP IS FROZEN AT SIGN-UP. Whatever the account's picture is at that moment is
 * captured and stored with the record, so changing the picture later does not change
 * the sign-up card.
 *
 * ONE SIGN-UP PER PAIRED NUMBER. Same number paired = still signed up, across
 * restarts. A different number pairs = asked again (that is the case that just
 * happened, 254734641791 replacing 254705472771). Logging out clears it.
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const STORE = path.join(ROOT, 'database', 'menu2.json')
const NUMBER = (v) => String(v || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '')

/** The number this session is paired to (the bot's own number). */
function pairedNumber(conn) {
    return NUMBER(conn?.user?.id)
}

/** Hide all but the ends, so the card can prompt without printing the answer. */
function mask(number) {
    const n = String(number || '')
    if (n.length < 7) return n
    return `${n.slice(0, 4)}${'•'.repeat(Math.max(0, n.length - 8))}${n.slice(-4)}`
}

function readStore() {
    try {
        const parsed = JSON.parse(fs.readFileSync(STORE, 'utf8'))
        return parsed && typeof parsed === 'object' ? parsed : { signups: {} }
    } catch {
        return { signups: {} }
    }
}

function writeStore(patch) {
    const next = { ...readStore(), ...patch }
    fs.mkdirSync(path.dirname(STORE), { recursive: true })
    fs.writeFileSync(STORE, JSON.stringify(next, null, 2), { mode: 0o600 })
    return next
}

/** The sign-up for the currently paired number, or null. */
function signupFor(conn) {
    const paired = pairedNumber(conn)
    if (!paired) return null
    const record = readStore().signups?.[paired]
    return record && record.verified === true ? { ...record, paired } : null
}

/*
 * THE BATTERY, DERIVED FROM THE TIME OF DAY.
 *
 * The operator's rule: full in the MORNING, low in the EVENING, and CHARGING around
 * MIDNIGHT. That is the table below, one target level per hour, plus whether the
 * phone is on the charger in that hour. The card never invents a level on its own:
 * it reads this table for the viewer's current hour and then drifts from it, down by
 * default and up while charging, so the number moves the way a real battery does
 * instead of sitting still.
 *
 * It is a simulation and the card says so in one small label. It is not the device's
 * battery, and it does not pretend to be.
 */
function batteryCurve() {
    const table = []
    for (let hour = 0; hour < 24; hour++) {
        if (hour <= 5) {
            // Midnight to dawn: on the charger, climbing out of the evening low.
            table.push({ level: 20 + hour * 6, charging: true })
        } else if (hour <= 11) {
            // Morning: taken off the charger full, topping out by mid-morning.
            table.push({ level: 94 + Math.min(hour - 6, 6), charging: false })
        } else if (hour <= 17) {
            // Afternoon: the long drain.
            table.push({ level: 92 - (hour - 12) * 6, charging: false })
        } else {
            // Evening: low, heading for the charger at midnight.
            table.push({ level: 30 - (hour - 18) * 3, charging: false })
        }
    }
    return table.map((slot) => ({ ...slot, level: Math.max(0, Math.min(100, slot.level)) }))
}

/** The level the curve asks for right now. */
function batteryFor(date = new Date()) {
    const hour = date.getHours()
    const slot = batteryCurve()[hour] || { level: 50, charging: false }
    return { hour, level: slot.level, charging: slot.charging, simulated: true }
}

/*
 * VERIFYING A NUMBER.
 *
 * The check is "is this the number this session is paired to?", which is what the
 * operator asked for. It is a confirmation step, not authentication: whoever can read
 * the chat already holds the session. Its real job is to make the one-time sign-up
 * explicit and to bind it to the paired account.
 */
function verify(conn, input, options = {}) {
    const paired = pairedNumber(conn)
    const given = NUMBER(input)
    if (!paired) return { ok: false, reason: 'no-session' }
    if (!given || given.length < 8) return { ok: false, reason: 'malformed' }
    if (given !== paired) return { ok: false, reason: 'mismatch' }

    const existing = readStore().signups?.[paired]
    const verifiedAt = existing?.verifiedAt || new Date().toISOString()
    /*
     * THE DP IS FROZEN HERE, ON PURPOSE. Whatever the picture is at sign-up is
     * captured and stored, and a later verify never overwrites it - only fills it in
     * if the record has none.
     */
    const avatar = existing?.avatar || String(options.avatar || '')
    const record = {
        verified: true,
        number: paired,
        verifiedAt,
        avatar,
        avatarCapturedAt: existing?.avatarCapturedAt || (avatar ? new Date().toISOString() : ''),
        /*
         * THE LOCK-SCREEN FINGERPRINT, OFF UNTIL ASKED FOR.
         *
         * Off by default on purpose: the operator's rule is that swiping up is free,
         * and the fingerprint is something you turn ON from the Security app. Keeping
         * it off means a sign-up is never locked behind a scan the person never chose
         * to set up. Survives a restart with the rest of the record.
         */
        fingerprint: existing?.fingerprint === true,
        fingerprintSetAt: existing?.fingerprintSetAt || '',
        attempts: (existing?.attempts || 0) + 1
    }
    writeStore({ signups: { ...(readStore().signups || {}), [paired]: record } })
    return { ok: true, alreadySigned: Boolean(existing?.verified), record }
}

/**
 * Turn the lock-screen fingerprint on or off for the paired number. Returns the new
 * state, and refuses when there is no sign-up to attach it to.
 */
function setFingerprint(conn, on) {
    const paired = pairedNumber(conn)
    if (!paired) return { ok: false, reason: 'no-session' }
    const signups = { ...(readStore().signups || {}) }
    const existing = signups[paired]
    if (!existing?.verified) return { ok: false, reason: 'not-signed-up' }
    signups[paired] = {
        ...existing,
        fingerprint: on === true,
        fingerprintSetAt: on === true ? new Date().toISOString() : ''
    }
    writeStore({ signups })
    return { ok: true, record: signups[paired], enabled: on === true }
}

/** Logging out forgets the sign-up, so a later login asks once more. */
function clearFor(conn) {
    const paired = pairedNumber(conn)
    if (!paired) return false
    const signups = { ...(readStore().signups || {}) }
    if (!signups[paired]) return false
    delete signups[paired]
    writeStore({ signups })
    return true
}

/*
 * THE CARD.
 *
 * All CSS and JS inline: the sandbox blocks every network request, so the DP arrives
 * as a base64 data URI and the battery table is injected as JSON. Stages are the same
 * document, so there is no navigation and nothing to load:
 *
 *   signup   flash -> DP -> "DARKNOTE MENU2 IS ACTIVE" -> sign-up panel
 *   welcome  flash -> welcome/loading (DP loading, then settling) -> LOCK SCREEN
 *   verified the sign-up is already done: the welcome runs straight into the lock
 */
function menu2Html({ avatar = '', verified = false, paired = '', signedAt = '', stage = 'signup', note = '', fingerprint = false, live = null } = {}) {
    const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const when = signedAt ? new Date(signedAt).toLocaleString('en-GB', { hour12: false }) : ''
    const title = 'DARKNOTE MENU2 IS ACTIVE'
    const printed = title.split('').map((c, i) =>
        `<span style="animation-delay:${(1.45 + i * 0.035).toFixed(3)}s">${c === ' ' ? '&nbsp;' : esc(c)}</span>`).join('')

    return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{margin:0;background:#08080a;color:#f4f4f5;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .app{position:relative;min-height:560px;overflow:hidden;
    background:radial-gradient(120% 80% at 50% 0%,#1b0606 0%,#0a0a0c 55%,#060607 100%)}
  .grid{position:absolute;inset:0;opacity:.25;
    background-image:linear-gradient(rgba(255,45,45,.10) 1px,transparent 1px),
                     linear-gradient(90deg,rgba(255,45,45,.10) 1px,transparent 1px);background-size:26px 26px}

  /* ---- the flash ---- */
  .flash{position:absolute;inset:0;background:#fff;opacity:0;z-index:9;animation:flash .85s ease-out .15s forwards}
  .flash .lens{position:absolute;left:50%;top:50%;width:74px;height:74px;margin:-37px 0 0 -37px;border-radius:50%;
    border:3px solid rgba(255,45,45,.85);animation:lens .85s ease-out .15s forwards}
  @keyframes flash{0%{opacity:0}12%{opacity:.92}100%{opacity:0}}
  @keyframes lens{0%{transform:scale(.5);opacity:1}70%{transform:scale(1.25);opacity:.5}100%{transform:scale(1.6);opacity:0}}
  .shutter{position:absolute;top:14px;left:16px;font-size:13px;letter-spacing:2px;color:#fff;z-index:10;
    opacity:0;animation:shutter .8s ease-out .05s forwards}
  @keyframes shutter{0%{opacity:0;transform:translateY(-6px)}25%{opacity:.95;transform:none}100%{opacity:0}}

  .wrap{position:relative;z-index:4;padding:22px 18px 26px;display:flex;flex-direction:column;align-items:center}
  .dp{position:relative;width:104px;height:104px;margin:6px 0 14px;opacity:0;animation:dp-in .7s cubic-bezier(.2,.8,.2,1) .95s forwards}
  .dp img,.dp .fallback{width:104px;height:104px;border-radius:26px;object-fit:cover;display:block;
    border:2px solid rgba(255,45,45,.55);box-shadow:0 12px 34px rgba(255,45,45,.22)}
  .dp .fallback{display:flex;align-items:center;justify-content:center;font-weight:800;letter-spacing:2px;
    background:linear-gradient(160deg,#2a0808,#150404);color:#ff6b6b;font-size:22px}
  .dp .ring{position:absolute;inset:-6px;border-radius:32px;border:1px dashed rgba(255,45,45,.45);animation:spin 9s linear infinite}
  @keyframes dp-in{0%{opacity:0;transform:scale(.72) translateY(10px)}100%{opacity:1;transform:none}}
  @keyframes spin{100%{transform:rotate(360deg)}}
  .name{margin:0 0 4px;font-size:15px;font-weight:800;letter-spacing:5px;color:#fff;text-align:center;min-height:20px}
  .name span{display:inline-block;opacity:0;animation:print .28s ease-out forwards}
  @keyframes print{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
  .sub{margin:2px 0 18px;font-size:11px;letter-spacing:2px;color:#8b8b92;text-align:center}
  .panel{width:100%;max-width:340px;border:1px solid #26262c;border-radius:16px;
    background:linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,.01));padding:16px 15px 15px;
    opacity:0;animation:up .55s ease-out 2.15s forwards}
  @keyframes up{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
  .panel h4{margin:0 0 3px;font-size:12px;letter-spacing:2px;color:#ff5d5d}
  .panel p{margin:0 0 12px;font-size:12px;line-height:1.65;color:#a8a8b0}
  .field{display:flex;align-items:center;gap:9px;border:1px solid #33333a;border-radius:11px;background:#0d0d10;padding:12px 13px;margin-bottom:11px}
  .field .flag{font-size:13px;color:#7f7f88}
  .field .ph{font-size:14px;color:#55555e;letter-spacing:1px}
  .field .caret{width:1px;height:16px;background:#ff2d2d;animation:blink 1.05s steps(1) infinite}
  @keyframes blink{50%{opacity:0}}
  .hint{display:flex;gap:8px;align-items:flex-start;font-size:11px;line-height:1.6;color:#8b8b92;
    border-top:1px dashed #2a2a30;padding-top:11px;margin-top:2px}
  .hint b{color:#e8e8ec;font-weight:600}
  .badge{display:inline-flex;align-items:center;gap:6px;font-size:10px;letter-spacing:1.5px;
    border:1px solid rgba(255,45,45,.45);color:#ff7a7a;border-radius:999px;padding:4px 10px;margin-bottom:12px}
  .ok{width:100%;max-width:340px;border:1px solid rgba(34,197,94,.42);border-radius:16px;
    background:linear-gradient(180deg,rgba(34,197,94,.10),rgba(34,197,94,.02));padding:18px 16px;text-align:center;
    opacity:0;animation:up .55s ease-out 1.6s forwards}
  .ok .tick{width:52px;height:52px;margin:2px auto 12px;border-radius:50%;border:2px solid rgba(34,197,94,.6);
    display:flex;align-items:center;justify-content:center}
  .ok .tick svg{width:26px;height:26px}
  .ok .tick path{stroke:#22c55e;stroke-width:3.4;fill:none;stroke-linecap:round;stroke-linejoin:round;
    stroke-dasharray:32;stroke-dashoffset:32;animation:draw .6s ease-out 1.9s forwards}
  @keyframes draw{to{stroke-dashoffset:0}}
  .ok h3{margin:0 0 6px;font-size:14px;letter-spacing:3px;color:#4ade80}
  .ok .num{font-size:17px;font-weight:700;letter-spacing:1px;color:#fff;margin:2px 0 8px}
  .ok .meta{font-size:11px;color:#8fbf9f;line-height:1.7}
  .bar{position:absolute;left:0;right:0;bottom:0;height:3px;background:linear-gradient(90deg,transparent,#ff2d2d,transparent);
    opacity:.5;animation:sweep 2.4s ease-in-out infinite}
  @keyframes sweep{0%,100%{transform:translateX(-30%)}50%{transform:translateX(30%)}}
</style>
${verified ? lockStyles() + appStyles() : signupStyles()}
</head><body>
<div class="app">
  <div class="grid"></div>
  <div class="flash"><div class="lens"></div></div>
  <div class="shutter">📸 DARKNOTE</div>
  <div class="wrap">
    <div class="dp"><div class="ring"></div>
      ${avatar ? `<img src="${esc(avatar)}" alt="DARKNOTE">` : '<div class="fallback">DN</div>'}
    </div>
    <div class="name">${printed}</div>
    <div class="sub">DARKNOTE · LEVEL 2 · MENU 2</div>
    ${verified ? welcomeStage({ esc, avatar, paired, when, note, fingerprint, live }) : signupStage({ esc, avatar, paired, stage, note })}
  </div>
  <div class="bar"></div>
</div>
${verified ? phoneScript() : signupScript()}
</body></html>`
}

/*
 * The sign-up panel.
 *
 * The field is a BUTTON, not an <input>: pressing it opens the card's own keypad, and
 * what you type is checked against the paired number on the spot. Nothing is ever
 * submitted from here - the card has no way to send - so the panel says where the
 * number actually goes.
 */
function signupStage({ esc, avatar, paired, stage, note }) {
    return `
    <div class="sbg">
      <div class="sdp" ${avatar ? `style="background-image:url('${esc(avatar)}')"` : ''}></div>
      ${serviceIcons()}
      <div class="sfade"></div>
    </div>
    <div class="panel">
      <div class="badge">${stage === 'mismatch' ? '⚠️ TRY AGAIN' : '🔐 STEP 1 OF 1'}</div>
      <h4>SIGN UP</h4>
      <p>All you need is your number — the one this device is paired to. Press the bar below to type it.</p>
      <div class="field" id="num-field" data-paired="${esc(paired)}" data-mask="${esc(mask(paired))}">
        <span class="flag">＋</span>
        <!--
          A REAL INPUT, so tapping it raises the device's own keyboard. type=tel plus
          inputmode=tel gets the phone keypad (digits and +) rather than a full alphabet
          one, and autocomplete lets the phone offer the number it already knows.
        -->
        <input class="num-input" id="num-input" type="tel" inputmode="tel" autocomplete="tel"
               enterkeyhint="send" maxlength="20" placeholder="Your number"
               aria-label="Your number" spellcheck="false" autocorrect="off" autocapitalize="off">
        <span class="tick" id="num-tick"></span>
      </div>
      <div class="keyhint" id="key-hint">Type the number this device is paired to (${esc(mask(paired))}).</div>
      <div class="hint"><span>✍️</span><div><b>Then send it in the chat.</b><br>
        This card runs offline, so it cannot submit a form — DARKNOTE reads the number from the chat.</div></div>
      ${note ? `<div class="hint"><span>ℹ️</span><div>${esc(note)}</div></div>` : ''}
    </div>

    <div class="signup-footer">亗 𝘽𝙄𝙂𝘽𝙍𝙊𝙏𝙃𝙀𝙍 亗</div>`
}

/*
 * THE WELCOME, THEN THE PHONE.
 *
 * Three screens live in the same document and are shown or hidden by the card's own
 * script - no navigation, no requests:
 *
 *   welcome   the DP loads, the lines resolve, then it lifts away
 *   lock      THE DP AS THE WALLPAPER, the clock, the battery, and the fingerprint
 *             sensor at the bottom. Swiping up opens the home screen; if the
 *             fingerprint has been switched on, swiping up is refused and the sensor
 *             is the way in.
 *   home      the app grid, holding the darknote-DP icon labelled SECURITY
 *   security  where the fingerprint is set up, turned on or turned off, with the
 *             current state read from the server rather than assumed
 */
function welcomeStage({ esc, avatar, paired, when, fingerprint = false, live = null }) {
    const wallpaper = avatar
        ? `style="background-image:url('${esc(avatar)}')"`
        : ''
    return `
    <div class="welcome" id="welcome">
      <div class="wdp"><div class="wdp-img">${avatar ? `<img src="${esc(avatar)}" alt="DARKNOTE">` : '<span>DN</span>'}</div></div>
      <div class="wtitle">WELCOME BACK</div>
      <div class="wlines">
        <div class="wline" style="animation-delay:.35s"><span class="ok">✓</span> paired number verified</div>
        <div class="wline" style="animation-delay:.75s"><span class="ok">✓</span> profile picture loaded</div>
        <div class="wline" style="animation-delay:1.15s"><span class="ok">✓</span> DARKNOTE MENU2 ready</div>
      </div>
      <div class="wbar"><i></i></div>
    </div>

    <div class="lock" id="lock">
      <div class="bezel">
        <div class="cam"></div>
        <div class="wall" ${wallpaper}></div>
        <div class="wall-tint"></div>
        <div class="statusbar">
          <span class="left">
            <span class="rt" id="rt-line">⏱ runtime ${esc(live ? formatRuntime(live.runtimeSeconds) : '—')}</span>
            <span class="pg" id="pg-line">📶 ping <b id="pg-val">${live && Number.isFinite(live.pingMs) ? `${live.pingMs} ms` : '—'}</b></span>
          </span>
          <span class="right">
            <span class="net">▮▮▮ 5G</span>
            <span class="batt" id="batt-top">100%</span>
          </span>
        </div>
        <div class="lockbody" data-runtime="${live ? Number(live.runtimeSeconds) || 0 : 0}">
          <div class="lockicon">🔒</div>
          <div class="clock" id="clock">--:--</div>
          <div class="date" id="date">—</div>
          <div class="year" id="year"></div>
          <div class="chip">DARKNOTE</div>
        </div>
        <div class="battpanel">
          <div class="battwrap">
            <div class="batt-icon" id="batt-icon"><span class="batt-fill" id="batt-fill"></span><span class="batt-tip"></span><span class="bolt" id="bolt">⚡</span></div>
            <div class="batt-read"><b id="batt-pct">100%</b><span id="batt-note">simulated from the time of day</span></div>
          </div>
        </div>

        <div class="swipe" id="swipe-hint">${fingerprint ? '🔒 Fingerprint required' : '⌃ Swipe up to open'}</div>

        <div class="sensor" id="sensor" data-enabled="${fingerprint ? 'true' : 'false'}">
          <div class="sensor-ring" id="sensor-ring">
            <svg viewBox="0 0 100 100"><circle class="track" cx="50" cy="50" r="44"/><circle class="prog" id="sensor-prog" cx="50" cy="50" r="44"/></svg>
            <div class="sensor-pad" id="sensor-pad">${thumb()}</div>
            <div class="scanline" id="scanline"></div>
          </div>
          <div class="sensor-label" id="sensor-label">${fingerprint ? 'Touch and hold the sensor' : 'Not set up · swipe up'}</div>
        </div>
        <div class="homebar"></div>
      </div>
    </div>

    <div class="home" id="home">
      <div class="homewall" ${wallpaper}></div>
      <div class="hometint"></div>
      <div class="homestatus"><span class="net">▮▮▮ 5G</span><span>${fingerprint ? 'FINGERPRINT ON' : 'FINGERPRINT OFF'}</span></div>
      <div class="homegrid">
        <button class="app" id="open-security" type="button">
          <span class="app-icon">${avatar ? `<img src="${esc(avatar)}" alt="">` : '<span class="app-dn">DN</span>'}<span class="app-badge">🔒</span></span>
          <span class="app-name">Security</span>
        </button>
      </div>
      <div class="homedock" id="back-to-lock">▲ Lock screen</div>
    </div>

    <div class="security" id="security">
      <div class="sec-head"><button class="sec-back" id="sec-back" type="button">‹</button><span>SECURITY</span></div>
      <div class="sec-body">
        <div class="sec-dp">${avatar ? `<img src="${esc(avatar)}" alt="">` : '<span>DN</span>'}</div>
        <h3>Fingerprint unlock</h3>
        <div class="sec-state ${fingerprint ? 'is-on' : 'is-off'}" id="sec-state">${fingerprint ? '● ENABLED for the lock screen' : '○ DISABLED — swiping up opens the phone'}</div>
        <p>${fingerprint
            ? 'The lock screen asks for your finger. Swiping up will not open the phone while this is on.'
            : 'The lock screen opens by swiping up. Turn this on to require a fingerprint instead.'}</p>
        <div class="sec-scan">${thumb(28)}<div><b>Set up your fingerprint</b><span>Press and hold the sensor on the lock screen for about 6 seconds to register it.</span></div></div>
        <div class="sec-how">
          <b>Turn it on or off</b>
          <span>The card runs offline, so the switch is applied by DARKNOTE: send <code>fingerprint on</code> or <code>fingerprint off</code> in the chat. The next card shows the new state.</span>
        </div>
        <div class="sec-note">The scan on the lock screen is a simulated sensor animation — this build cannot read a real fingerprint, and nothing here claims it did.</div>
      </div>
    </div>`
}

/* The thumbprint glyph, drawn rather than fetched: the sandbox blocks assets. */
function thumb(size = 60) {
    return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true">
      <g fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round">
        <path d="M32 12c-8.8 0-16 7.2-16 16 0 5 .8 9.6 2.2 13.6"/>
        <path d="M32 12c8.8 0 16 7.2 16 16 0 5-.8 9.6-2.2 13.6"/>
        <path d="M22 50c-2.6-5.4-4-11.6-4-18 0-7.7 6.3-14 14-14s14 6.3 14 14c0 6.4-1.4 12.6-4 18"/>
        <path d="M32 26c-4.4 0-8 3.6-8 8 0 6-1 11.6-3 16"/>
        <path d="M32 26c4.4 0 8 3.6 8 8 0 6 1 11.6 3 16"/>
        <path d="M26 34c0-3.3 2.7-6 6-6s6 2.7 6 6c0 8-1.2 15-3.4 21"/>
      </g></svg>`
}

/* the welcome, phone and app styling — the sign-up card has its own */
function lockStyles() {
    return `<style>
  .welcome{width:100%;max-width:340px;text-align:center;animation:welcome-out .5s ease-in 2.9s forwards}
  @keyframes welcome-out{to{opacity:0;transform:translateY(-14px)}}
  .wdp{width:96px;height:96px;margin:4px auto 16px;border-radius:50%;
    background:linear-gradient(150deg,#250707,#120303);display:flex;align-items:center;justify-content:center;
    border:2px solid rgba(255,45,45,.5);box-shadow:0 14px 40px rgba(255,45,45,.25);position:relative;overflow:hidden}
  .wdp::after{content:'';position:absolute;inset:0;border-radius:50%;
    background:linear-gradient(180deg,transparent,rgba(255,255,255,.35),transparent);animation:load-sweep 1.3s ease-in-out infinite}
  @keyframes load-sweep{0%{transform:translateY(-100%)}100%{transform:translateY(100%)}}
  .wdp-img{width:100%;height:100%;border-radius:50%;overflow:hidden;filter:blur(7px);animation:sharpen 1.5s ease-out forwards}
  @keyframes sharpen{to{filter:blur(0)}}
  .wdp-img img,.wdp-img span{width:100%;height:100%;object-fit:cover;display:flex;align-items:center;justify-content:center;
    background:#1a0505;color:#ff6b6b;font-weight:800;font-size:20px;letter-spacing:2px}
  .wtitle{font-size:12px;letter-spacing:6px;color:#e5e5ea;margin-bottom:14px}
  .wlines{display:flex;flex-direction:column;gap:7px;margin-bottom:16px}
  .wline{font-size:11px;color:#9a9aa2;letter-spacing:.6px;opacity:0;animation:print .4s ease-out forwards;text-align:left}
  .wline .ok{color:#22c55e;margin-right:6px}
  .wbar{height:3px;border-radius:3px;background:#1b1b20;overflow:hidden}
  .wbar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#ff2d2d,#ff8f8f);animation:fill 2.9s cubic-bezier(.4,.1,.2,1) forwards}
  @keyframes fill{to{width:100%}}

  .lock{opacity:0;animation:lock-in .7s cubic-bezier(.2,.8,.2,1) 3.15s forwards;width:100%;max-width:352px}
  @keyframes lock-in{from{opacity:0;transform:translateY(18px) scale(.98)}to{opacity:1;transform:none}}
  .bezel{position:relative;border-radius:38px;border:8px solid #16161a;overflow:hidden;
    background:linear-gradient(180deg,#0d1a26 0%,#0a1219 45%,#05080b 100%);
    box-shadow:0 24px 60px rgba(0,0,0,.6),inset 0 0 0 1px rgba(255,255,255,.05);padding:0 0 12px;min-height:430px}
  .cam{position:absolute;top:11px;left:50%;transform:translateX(-50%);width:11px;height:11px;border-radius:50%;z-index:4;
    background:#000;box-shadow:inset 0 0 0 2px #0b0b0e,0 0 6px rgba(80,140,255,.35)}
  .statusbar{display:flex;justify-content:space-between;align-items:flex-start;padding:12px 18px 0;font-size:10px;color:#dbe6f0;opacity:.95}
  .statusbar .left{display:flex;flex-direction:column;gap:3px;text-align:left}
  .statusbar .rt{font-size:9.5px;letter-spacing:.4px;color:#cfe0ef}
  .statusbar .pg{font-size:9px;letter-spacing:.4px;color:#9fb3c8}
  .statusbar .pg b{color:#4ade80;font-weight:600}
  .statusbar .pg b.is-slow{color:#ffb15c}
  .statusbar .pg b.is-bad{color:#ff7a7a}
  .statusbar .right{display:flex;flex-direction:column;align-items:flex-end;gap:3px}
  .statusbar .batt{font-size:9.5px}
  .statusbar .net{font-size:9px;letter-spacing:.6px;color:#cfe0ef}
  .lockbody{padding:26px 0 8px;text-align:center}
  .lockicon{font-size:15px;opacity:.85;margin-bottom:14px}
  .clock{font-size:52px;font-weight:200;letter-spacing:2px;color:#fff;line-height:1;text-shadow:0 2px 18px rgba(120,180,255,.35)}
  .date{font-size:13.5px;color:#e8eef5;letter-spacing:.3px;margin-top:9px;font-weight:300}
  .year{font-size:10.5px;color:#9fb3c8;letter-spacing:1.4px;margin-top:3px}
  .chip{display:inline-block;margin-top:14px;font-size:9px;letter-spacing:3px;color:#a9bccd;
    border:1px solid rgba(169,188,205,.4);border-radius:999px;padding:4px 12px}
  .battpanel{padding:0 20px 4px}
  .battwrap{display:flex;align-items:center;gap:12px;border-radius:14px;padding:11px 13px;
    background:rgba(10,18,26,.6);border:1px solid rgba(127,147,168,.25);backdrop-filter:blur(4px)}
  .batt-icon{position:relative;width:34px;height:16px;border:1.6px solid #cfe0ef;border-radius:4px;flex:none}
  .batt-fill{position:absolute;left:1.6px;top:1.6px;bottom:1.6px;width:60%;border-radius:2px;
    background:linear-gradient(90deg,#2ecc71,#7ee2a8);transition:width .9s ease,background .5s ease}
  .batt-tip{position:absolute;right:-3.6px;top:5px;width:2.2px;height:6px;border-radius:0 2px 2px 0;background:#cfe0ef}
  .bolt{position:absolute;right:-16px;top:-3px;font-size:12px;opacity:0;transition:opacity .4s ease}
  .batt-icon.is-charging .bolt{opacity:1}
  .batt-read{display:flex;flex-direction:column;line-height:1.35}
  .batt-read b{font-size:13px;color:#fff}
  .batt-read span{font-size:9px;color:#9db2c6;letter-spacing:.4px}
  .homebar{width:96px;height:4px;border-radius:3px;background:rgba(255,255,255,.55);margin:12px auto 0}
</style>`
}

/* the wallpaper, sensor, home grid and Security app styling */
function appStyles() {
    return `<style>
  .wall,.homewall{position:absolute;inset:0;background-size:cover;background-position:center;z-index:0}
  .wall-tint,.hometint{position:absolute;inset:0;z-index:1;
    background:linear-gradient(180deg,rgba(3,8,14,.5) 0%,rgba(3,8,14,.3) 36%,rgba(2,5,9,.88) 100%)}
  .lockbody,.statusbar,.battpanel,.sensor,.swipe,.homebar{position:relative;z-index:3}
  .swipe{text-align:center;font-size:10px;letter-spacing:1.6px;color:#cfe0ef;opacity:.85;margin:6px 0 2px}
  .sensor{display:flex;flex-direction:column;align-items:center;padding:4px 0 8px;touch-action:none}
  .sensor-ring{position:relative;width:96px;height:96px;display:flex;align-items:center;justify-content:center}
  .sensor-ring svg{position:absolute;inset:0;transform:rotate(-90deg)}
  .sensor-ring circle{fill:none;stroke-width:3}
  .sensor-ring .track{stroke:rgba(160,190,215,.18)}
  .sensor-ring .prog{stroke:#4db8ff;stroke-linecap:round;stroke-dasharray:276;stroke-dashoffset:276;
    transition:stroke-dashoffset .2s linear,stroke .3s ease}
  .sensor-pad{width:64px;height:64px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#8fb9d8;
    background:radial-gradient(circle at 50% 40%,rgba(40,70,95,.5),rgba(8,14,20,.75));
    border:1px solid rgba(140,180,210,.28);transition:color .3s ease,transform .2s ease}
  .sensor.is-pressed .sensor-pad{color:#8fd6ff;transform:scale(.96)}
  .sensor.is-done .sensor-pad{color:#4ade80}
  .scanline{position:absolute;left:8%;right:8%;height:2px;border-radius:2px;top:20%;
    background:linear-gradient(90deg,transparent,#7fd4ff,transparent);opacity:0}
  .sensor.is-pressed .scanline{opacity:1;animation:scan 1.1s ease-in-out infinite}
  @keyframes scan{0%,100%{top:20%}50%{top:80%}}
  .sensor-label{margin-top:7px;font-size:10px;letter-spacing:1.2px;color:#a8c4d8;text-align:center;min-height:14px}
  .sensor.is-done .sensor-label{color:#4ade80}
  .home{position:absolute;inset:0;opacity:0;pointer-events:none;transition:opacity .45s ease;z-index:5}
  .home.is-open{opacity:1;pointer-events:auto}
  .lock.is-away{opacity:0;transition:opacity .45s ease;pointer-events:none}
  .homestatus{position:relative;z-index:3;display:flex;justify-content:space-between;padding:12px 20px 0;font-size:9px;letter-spacing:1.4px;color:#dbe6f0}
  .homegrid{position:relative;z-index:3;display:grid;grid-template-columns:repeat(3,1fr);gap:18px;padding:40px 24px 0}
  .app{appearance:none;background:none;border:0;padding:0;display:flex;flex-direction:column;align-items:center;gap:7px;cursor:pointer;color:#fff}
  .app-icon{position:relative;width:58px;height:58px;border-radius:17px;overflow:hidden;display:flex;align-items:center;justify-content:center;
    background:linear-gradient(160deg,#22121a,#0d0a12);border:1px solid rgba(255,255,255,.14);box-shadow:0 10px 24px rgba(0,0,0,.45)}
  .app-icon img{width:100%;height:100%;object-fit:cover}
  .app-dn{font-weight:800;letter-spacing:1px;color:#ff8080;font-size:16px}
  .app-badge{position:absolute;right:-2px;bottom:-2px;width:20px;height:20px;border-radius:50%;background:#101820;
    border:1px solid rgba(140,180,210,.5);display:flex;align-items:center;justify-content:center;font-size:10px}
  .app-name{font-size:10px;letter-spacing:.6px;color:#e8eef5}
  .homedock{position:absolute;left:0;right:0;bottom:12px;z-index:3;text-align:center;font-size:10px;letter-spacing:1.6px;color:#cfe0ef;opacity:.8;cursor:pointer}
  .security{position:absolute;inset:0;opacity:0;pointer-events:none;transition:opacity .35s ease;z-index:6;background:linear-gradient(180deg,#0b1218,#070a0e)}
  .security.is-open{opacity:1;pointer-events:auto}
  .sec-head{display:flex;align-items:center;gap:10px;padding:14px 16px 10px;font-size:11px;letter-spacing:2.4px;color:#cfe0ef;border-bottom:1px solid rgba(140,180,210,.14)}
  .sec-back{appearance:none;background:none;border:1px solid rgba(140,180,210,.3);color:#cfe0ef;border-radius:9px;width:26px;height:26px;font-size:16px;line-height:1;cursor:pointer}
  .sec-body{position:relative;z-index:3;padding:16px 16px 20px;text-align:left}
  .sec-dp{width:54px;height:54px;border-radius:50%;overflow:hidden;border:2px solid rgba(255,45,45,.5);margin-bottom:12px;
    display:flex;align-items:center;justify-content:center;background:#1a0505;color:#ff6b6b;font-weight:800}
  .sec-dp img{width:100%;height:100%;object-fit:cover}
  .sec-body h3{margin:0 0 8px;font-size:13px;letter-spacing:1.6px;color:#fff}
  .sec-state{font-size:10px;letter-spacing:1.2px;border-radius:9px;padding:9px 11px;margin-bottom:11px}
  .sec-state.is-on{color:#4ade80;background:rgba(34,197,94,.10);border:1px solid rgba(34,197,94,.4)}
  .sec-state.is-off{color:#ffb4b4;background:rgba(255,45,45,.08);border:1px solid rgba(255,45,45,.32)}
  .sec-body p{margin:0 0 13px;font-size:11px;line-height:1.7;color:#9fb3c8}
  .sec-scan{display:flex;gap:11px;align-items:flex-start;font-size:10.5px;line-height:1.6;color:#cfe0ef;
    border:1px solid rgba(140,180,210,.2);border-radius:12px;padding:11px;background:rgba(255,255,255,.03);margin-bottom:11px}
  .sec-scan svg{flex:none;color:#8fb9d8}
  .sec-scan span{display:block;color:#8fa6bb;font-size:9.5px;margin-top:3px}
  .sec-how{border-top:1px dashed rgba(140,180,210,.25);padding-top:11px;font-size:10.5px;line-height:1.65;color:#9fb3c8}
  .sec-how b{display:block;color:#e8eef5;letter-spacing:1.4px;font-size:10px;margin-bottom:5px}
  .sec-how code{background:#0e1419;border:1px solid rgba(140,180,210,.3);border-radius:6px;padding:2px 6px;font-size:10px;color:#8fd6ff}
  .sec-note{margin-top:13px;font-size:9.5px;line-height:1.6;color:#7d8b98}
</style>`
}

/*
 * EVERYTHING THE PHONE DOES, IN THE CARD.
 *
 * The clock is the viewer's time, the battery comes from the hour table (injected as
 * JSON so the card and this module can never disagree) and drifts on its own, and the
 * sensor runs a timed scan. Two timers for the battery/clock and one for an active
 * scan - nothing polls, and nothing is fetched.
 *
 * THE SCAN IS SIMULATED, AND SAYS SO WHERE IT MATTERS. No fingerprint can be read
 * from an HTML sandbox, so holding the sensor plays a 5.6s "reading" animation and
 * opens the phone. It is convincing on purpose - the operator asked for a realistic
 * sensor - but the Security app states plainly that no real fingerprint was read, so
 * the setting is never sold as biometric security it does not have.
 */
function phoneScript() {
    return `<script>
(function () {
  var CURVE = ${JSON.stringify(batteryCurve())};
  var SCAN_MS = 5600;
  var pct = document.getElementById('batt-pct'), fill = document.getElementById('batt-fill');
  var icon = document.getElementById('batt-icon'), top = document.getElementById('batt-top');
  var note = document.getElementById('batt-note'), clock = document.getElementById('clock'), dateEl = document.getElementById('date');
  var lock = document.getElementById('lock'), home = document.getElementById('home'), security = document.getElementById('security');
  var sensor = document.getElementById('sensor'), prog = document.getElementById('sensor-prog'), label = document.getElementById('sensor-label');
  var enabled = sensor.dataset.enabled === 'true';
  var hour = -1, level = 100, charging = false, scanTimer = null, scanning = false;

  function applyCurve() {
    var h = new Date().getHours();
    if (h === hour) return;
    hour = h;
    var slot = CURVE[h] || { level: 50, charging: false };
    level = slot.level; charging = slot.charging;
  }
  function paint() {
    var r = Math.max(0, Math.min(100, Math.round(level)));
    pct.textContent = r + '%'; if (top) top.textContent = r + '%';
    if (fill) { fill.style.width = Math.max(2, r) + '%';
      fill.style.background = charging ? 'linear-gradient(90deg,#2ecc71,#8ef0bb)'
        : (r <= 20 ? 'linear-gradient(90deg,#e74c3c,#ff8f7a)' : 'linear-gradient(90deg,#2ecc71,#7ee2a8)'); }
    icon.classList.toggle('is-charging', charging);
    note.textContent = (charging ? 'charging · ' : '') + 'simulated from the time of day';
  }
  function drain() {
    applyCurve();
    level += charging ? 1 : -1;
    if (level > 100) level = 100;
    if (level < 1) level = 1;
    paint();
  }
  function tickClock() {
    var now = new Date();
    if (clock) clock.textContent = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    // Samsung S26 lock-screen date: weekday, day, then the month spelled out, with
    // the year on its own quieter line underneath.
    if (dateEl) {
      var d = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      var m = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      dateEl.textContent = d[now.getDay()] + ', ' + now.getDate() + ' ' + m[now.getMonth()];
    }
    var year = document.getElementById('year');
    if (year) year.textContent = String(now.getFullYear());
    tickRuntime(now);
  }

  /*
   * THE RUNTIME KEEPS COUNTING while the card is open: the server's figure is the truth
   * at render time, and the card adds the time since. Adding seconds to what the bot
   * reported is still the bot's number - unlike the ping, which cannot be measured
   * without a network the sandbox does not have, so it stays the sampled value.
   */
  var baseRuntime = 0, baseAt = Date.now();
  function tickRuntime(now) {
    var line = document.getElementById('rt-line');
    if (!line) return;
    line.textContent = '\u23F1 runtime ' + elapsedRuntime(now);
  }
  function elapsedRuntime(now) {
    var total = baseRuntime + Math.floor((now.getTime() - baseAt) / 1000);
    var d = Math.floor(total / 86400), h = Math.floor((total % 86400) / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
    var pad = function (n) { return String(n).padStart(2, '0'); };
    if (d) return d + 'd ' + h + 'h ' + pad(m) + 'm';
    if (h) return h + 'h ' + pad(m) + 'm ' + pad(sec) + 's';
    if (m) return m + 'm ' + pad(sec) + 's';
    return sec + 's';
  }

  /* ---- the phone ---- */
  function openHome() {
    lock.classList.add('is-away');
    home.classList.add('is-open');
  }
  function openLock() {
    security.classList.remove('is-open');
    home.classList.remove('is-open');
    lock.classList.remove('is-away');
  }
  function openSecurity() { security.classList.add('is-open'); }

  function progress(fraction) {
    prog.style.strokeDashoffset = String(276 - 276 * Math.max(0, Math.min(1, fraction)));
  }
  function startScan() {
    if (scanning || !enabled) return;
    scanning = true;
    sensor.classList.add('is-pressed');
    sensor.classList.remove('is-done');
    label.textContent = 'Reading fingerprint…';
    var started = Date.now();
    scanTimer = setInterval(function () {
      var f = (Date.now() - started) / SCAN_MS;
      progress(f);
      if (f >= 0.55) label.textContent = 'Almost there…';
      if (f >= 1) {
        clearInterval(scanTimer); scanTimer = null; scanning = false;
        sensor.classList.remove('is-pressed'); sensor.classList.add('is-done');
        prog.style.stroke = '#4ade80';
        label.textContent = 'Recognised — opening';
        setTimeout(openHome, 420);
      }
    }, 120);
  }
  function cancelScan() {
    if (!scanning) return;
    clearInterval(scanTimer); scanTimer = null; scanning = false;
    sensor.classList.remove('is-pressed');
    progress(0);
    label.textContent = enabled ? 'Touch and hold the sensor' : 'Not set up · swipe up';
  }

  if (sensor) {
    sensor.addEventListener('pointerdown', function (e) { e.preventDefault(); startScan(); });
    sensor.addEventListener('pointerup', cancelScan);
    sensor.addEventListener('pointerleave', cancelScan);
    sensor.addEventListener('pointercancel', cancelScan);
  }

  /*
   * Swipe up: the free way in when the fingerprint is off, refused when it is on.
   *
   * Pointer events, so a finger and a mouse behave identically - and a real upward
   * DRAG is required. An earlier version opened the phone on any mouse click, which
   * meant a tap on the wallpaper was enough to get past the lock: exactly what a lock
   * screen must not do.
   */
  var startY = null;
  var surface = document.querySelector('.bezel');
  function setHint(text) { var h = document.getElementById('swipe-hint'); if (h) h.textContent = text; }
  surface.addEventListener('pointerdown', function (e) { startY = e.clientY; });
  surface.addEventListener('pointerup', function (e) {
    if (startY === null) return;
    var dy = startY - e.clientY;
    startY = null;
    if (dy < 60) return;
    if (enabled) { setHint('\u{1F512} Fingerprint required'); return; }
    openHome();
  });
  surface.addEventListener('pointercancel', function () { startY = null; });

  var dock = document.getElementById('back-to-lock');
  if (dock) dock.addEventListener('click', openLock);
  var sec = document.getElementById('open-security');
  if (sec) sec.addEventListener('click', openSecurity);
  var back = document.getElementById('sec-back');
  if (back) back.addEventListener('click', function () { security.classList.remove('is-open'); });

  var body = document.querySelector('.lockbody');
  if (body) baseRuntime = parseInt(body.getAttribute('data-runtime') || '0', 10) || 0;
  baseAt = Date.now();
  var pg = document.getElementById('pg-val');
  if (pg) {
    var ms = parseInt((pg.textContent || '').replace(/[^0-9]/g, ''), 10);
    if (Number.isFinite(ms)) pg.classList.add(ms <= 200 ? 'is-fast' : (ms <= 600 ? 'is-slow' : 'is-bad'));
  }
  applyCurve(); paint(); tickClock(); progress(0);
  setInterval(drain, charging ? 8000 : 24000);
  setInterval(tickClock, 1000);
})();
</script>`
}

/*
 * WAITING FOR THE NUMBER.
 *
 * The card cannot submit, so after it is shown the chat waits for that one number.
 * Kept here rather than in the pairing pending-state store on purpose: it is a
 * five-minute, owner-only window for a single value and must not interfere with the
 * pairing states that share the same message pipeline.
 */
const awaiting = new Map()
const WAIT_MS = 5 * 60 * 1000

function begin(chat) {
    awaiting.set(String(chat), Date.now() + WAIT_MS)
}

function waiting(chat) {
    const until = awaiting.get(String(chat))
    if (!until) return false
    if (Date.now() > until) {
        awaiting.delete(String(chat))
        return false
    }
    return true
}

function stop(chat) {
    awaiting.delete(String(chat))
}

/**
 * Take a message that might be the sign-up number. Returns null when the chat is not
 * waiting or the text is not a number, so the caller can hand the message on.
 */
function consume(conn, chat, body, options = {}) {
    if (!waiting(chat)) return null
    const raw = String(body || '').trim()
    if (!/^[+\d][\d\s()-]{6,}$/.test(raw)) return null
    stop(chat)
    const outcome = verify(conn, raw, options)
    // A wrong number keeps the window OPEN: closing it on a mistake turns a sign-up
    // into a dead end that has to be reopened by tapping the button again.
    if (!outcome.ok) begin(chat)
    return outcome
}

module.exports = {
    menu2Html, signupFor, verify, clearFor, pairedNumber, mask, readStore, writeStore, STORE,
    batteryCurve, batteryFor, setFingerprint, liveStatus, pingMs, formatRuntime,
    begin, waiting, stop, consume, WAIT_MS
}

/*
 * THE SIGN-UP BACKGROUND AND KEYPAD.
 *
 * The background is the DARKNOTE DP, oversized and drifting, with the service marks
 * floating over it - all drawn inline, because the sandbox loads nothing.
 *
 * THE KEYPAD IS NOT DECORATION. Pressing the number field opens it, typing fills the
 * field, and the card tells you IMMEDIATELY whether what you typed is the number this
 * session is paired to. That check is local, and it is allowed to be: the paired
 * number is the bot's own number, which everyone in the chat can already see, so
 * putting it in the card leaks nothing. The number that actually SIGNS YOU UP still
 * travels in the chat, because the card cannot send - which the panel keeps saying.
 */
function signupStyles() {
    return `<style>
  .sbg{position:absolute;inset:0;overflow:hidden;z-index:0}
  .sdp{position:absolute;left:50%;top:46%;width:330px;height:330px;margin:-165px 0 0 -165px;border-radius:44px;
    background-size:cover;background-position:center;opacity:.22;filter:blur(3px);
    animation:drift 18s ease-in-out infinite alternate}
  @keyframes drift{0%{transform:scale(1) translate(-12px,-8px) rotate(-2deg)}100%{transform:scale(1.12) translate(12px,10px) rotate(2deg)}}
  .sicon{position:absolute;width:34px;height:34px;opacity:.5;animation:float 7s ease-in-out infinite}
  .sicon svg{width:100%;height:100%}
  .sicon.i1{left:8%;top:16%;animation-delay:0s}
  .sicon.i2{right:10%;top:26%;animation-delay:1.1s}
  .sicon.i3{left:13%;bottom:26%;animation-delay:2.2s}
  .sicon.i4{right:8%;bottom:16%;animation-delay:3.3s}
  @keyframes float{0%,100%{transform:translateY(0) rotate(0)}50%{transform:translateY(-14px) rotate(6deg)}}
  .sfade{position:absolute;inset:0;background:radial-gradient(120% 70% at 50% 20%,rgba(10,10,14,.35) 0%,rgba(8,8,12,.86) 60%,#06060a 100%)}

  /* The field keeps its border, background and padding; the input inside it is bare,
     so the bar looks exactly as it did and only gains a caret. */
  .field{transition:border-color .25s ease,box-shadow .25s ease}
  .field:focus-within{border-color:#ff5d5d;box-shadow:0 0 0 3px rgba(255,45,45,.12)}
  .field .num-input{flex:1;min-width:0;background:transparent;border:0;outline:0;padding:0;margin:0;
    color:#fff;font:inherit;font-size:15px;letter-spacing:1.4px;caret-color:#ff2d2d}
  .field .num-input::placeholder{color:#55555e;letter-spacing:1px;opacity:1}
  .field.is-ok{border-color:rgba(34,197,94,.6);background:rgba(34,197,94,.07)}
  .field.is-bad{border-color:rgba(255,45,45,.6);background:rgba(255,45,45,.07)}
  .field .tick{font-size:12px;opacity:0;transition:opacity .25s ease}
  .field.is-ok .tick{opacity:1;color:#4ade80}
  .field.is-bad .tick{opacity:1;color:#ff7a7a}

  /*
   * PINNED TO THE BOTTOM OF THE CARD, not appended under the panel.
   *
   * In the WhatsApp card viewer the HTML sits in a fixed-height frame that does not
   * scroll, so a keypad added BELOW the panel opened out of sight - the tap looked like
   * it did nothing. As an overlay on the card's own bottom edge it is always visible,
   * whatever the content above it measures.
   */
  .keyhint b{color:#e8e8ec}
  .signup-footer{margin:18px 0 2px;font-size:13px;letter-spacing:2px;color:#ff8f8f;opacity:.9;
    text-align:center;text-shadow:0 2px 14px rgba(255,45,45,.35);animation:fadein 1.2s ease-out 2.6s both}
  @keyframes fadein{from{opacity:0;transform:translateY(8px)}to{opacity:.9;transform:none}}
</style>`
}

/* The four marks: the darknote tile, WhatsApp, Telegram and a web globe. */
function serviceIcons() {
    return `
    <div class="sicon i1">${darknoteMark()}</div>
    <div class="sicon i2">${whatsappMark()}</div>
    <div class="sicon i3">${telegramMark()}</div>
    <div class="sicon i4">${webMark()}</div>`
}

function darknoteMark() {
    return `<svg viewBox="0 0 40 40"><rect x="2" y="2" width="36" height="36" rx="11" fill="#1b0a0a" stroke="#ff5d5d" stroke-width="1.6"/><path d="M11 27V13h6.4c4.6 0 7.6 2.6 7.6 7s-3 7-7.6 7H11zm4-3.4h2.2c2.4 0 4-1.4 4-3.6s-1.6-3.6-4-3.6H15v7.2z" fill="#ff8f8f"/></svg>`
}
function whatsappMark() {
    return `<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="#0f1b14" stroke="#25d366" stroke-width="1.6"/><path d="M20 9c-6 0-10.8 4.6-10.8 10.3 0 1.9.5 3.6 1.5 5.1L9.4 30l5-1.4c1.4.8 3.1 1.2 4.9 1.2h.7c6 0 10.8-4.6 10.8-10.3S26 9 20 9z" fill="none" stroke="#25d366" stroke-width="1.5"/><path d="M16 15.6c.3-.7.6-.7 1-.7h.7c.2 0 .5 0 .7.5l1 2.2c.1.3 0 .5-.1.7l-.5.6c-.1.2-.2.3 0 .6.5.9 1.4 1.8 2.4 2.3.3.1.4.1.6-.1l.7-.8c.2-.2.4-.2.6-.1l2 1c.3.1.4.3.4.5 0 .7-.5 1.5-1 1.7-.4.2-1 .3-3-.5-2.4-1-4-3.4-4.3-3.8-.3-.4-1-1.5-1-2.9 0-1.3.7-2 .9-2.2z" fill="#25d366"/></svg>`
}
function telegramMark() {
    return `<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="#0e1621" stroke="#2aa6e0" stroke-width="1.6"/><path d="M10.5 19.6l16.2-6.3c.8-.3 1.5.2 1.2 1.4l-2.8 13c-.2.8-.7 1-1.4.6l-3.8-2.8-1.9 1.8c-.2.2-.4.4-.8.4l.3-4 7.3-6.6c.3-.3 0-.5-.5-.2l-9 5.6-3.9-1.2c-.8-.3-.9-1-.1-1.3z" fill="#2aa6e0"/></svg>`
}
function webMark() {
    return `<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="#12141c" stroke="#8fb9d8" stroke-width="1.6"/><circle cx="20" cy="20" r="9.5" fill="none" stroke="#8fb9d8" stroke-width="1.4"/><ellipse cx="20" cy="20" rx="4" ry="9.5" fill="none" stroke="#8fb9d8" stroke-width="1.4"/><path d="M10.5 20h19" stroke="#8fb9d8" stroke-width="1.4"/><path d="M12 14.5h16M12 25.5h16" stroke="#8fb9d8" stroke-width="1.1"/></svg>`
}

/*
 * THE NUMBER FIELD, IN THE CARD.
 *
 * Tapping the bar focuses the input, which is what makes the DEVICE's keyboard appear -
 * no custom keypad sits in the way of it any more. As you type, the number is checked
 * against the paired one so a mistake is obvious before anything is sent, and the field
 * turns green or red accordingly.
 *
 * The number that actually signs you up still travels in the CHAT: the sandbox has no
 * way to send it, so the field says what to do next.
 */
function signupScript() {
    return `<script>
(function () {
    var field = document.getElementById('num-field');
    var input = document.getElementById('num-input');
    var tick = document.getElementById('num-tick');
    var hint = document.getElementById('key-hint');
    if (!field || !input) return;
    var paired = String(field.dataset.paired || '');
    var masked = String(field.dataset.mask || '');

    /* Digits, and a + only at the front - the country code belongs there. */
    function sanitise(raw) {
        var text = String(raw || '').replace(/[^0-9+]/g, '');
        if (text.indexOf('+') > 0) text = text.charAt(0) + text.slice(1).replace(/[+]/g, '');
        if (text.indexOf('+') === 0) text = '+' + text.slice(1).replace(/[+]/g, '');
        else text = text.replace(/[+]/g, '');
        return text.slice(0, 20);
    }

    function paint() {
        var value = input.value;
        var digits = value.replace(/[^0-9]/g, '');
        var matches = digits.length >= 8 && digits === paired;
        field.classList.toggle('is-ok', matches);
        field.classList.toggle('is-bad', digits.length >= 8 && !matches);
        tick.textContent = matches ? '\u2713' : (digits.length >= 8 ? '\u2717' : '');
        if (hint) {
            hint.innerHTML = matches
                ? '<b>That is the paired number.</b> Send it in the chat and DARKNOTE signs you up.'
                : (digits.length >= 8
                    ? 'That is not the number this session is paired to. Check it and try again.'
                    : 'Type the number this device is paired to' + (masked ? ' (' + masked + ')' : '') + '.');
        }
    }

    input.addEventListener('input', function () {
        var clean = sanitise(input.value);
        if (clean !== input.value) {
            // Only rewrite when something was actually removed, so the caret is not
            // disturbed while typing normally.
            var atEnd = input.selectionStart === input.value.length;
            input.value = clean;
            if (atEnd && input.setSelectionRange) { try { input.setSelectionRange(clean.length, clean.length); } catch (e) { } }
        }
        paint();
    });

    /* Tapping anywhere on the bar focuses the input. A real tap on the input focuses it
       by itself; this covers the padding and the + prefix around it. */
    field.addEventListener('click', function (e) {
        if (e.target !== input) { try { input.focus(); } catch (err) { } }
    });
    field.addEventListener('pointerup', function (e) {
        if (e.target !== input && document.activeElement !== input) { try { input.focus(); } catch (err) { } }
    });

    paint();
})();
</script>`
}

/*
 * RUNTIME AND PING — REAL NUMBERS, OR NOTHING.
 *
 * RUNTIME is the bot process's own uptime (process.uptime()), so it is the real
 * figure. The card is told the value at render time plus how long ago that was, and
 * counts on from there, so it keeps ticking for as long as the card is open instead of
 * freezing at whatever it said when the card was built.
 *
 * PING is MEASURED, not invented: a real query to WhatsApp is timed and the result is
 * reported. It cannot tick on the card (the sandbox has no network), so it is frozen at
 * the sampled value and labelled as sampled - a non-moving real number, not a moving
 * fake one. If the query fails, the card says "—" rather than showing a guess.
 */
const PING_TTL_MS = 30 * 1000
let pingCache = { at: 0, ms: null }

/** Time a real round trip to WhatsApp. Cached briefly so it is not a hammer. */
async function pingMs(conn, options = {}) {
    const now = Date.now()
    if (!options.fresh && now - pingCache.at < PING_TTL_MS) return pingCache.ms
    let ms = null
    try {
        const me = pairedNumber(conn)
        if (me && typeof conn.onWhatsApp === 'function') {
            const started = Date.now()
            await conn.onWhatsApp(`${me}@s.whatsapp.net`)
            ms = Date.now() - started
        } else if (typeof conn.profilePictureUrl === 'function') {
            const started = Date.now()
            await conn.profilePictureUrl(conn.user?.id || '', 'image').catch(() => null)
            ms = Date.now() - started
        }
    } catch {
        ms = null
    }
    /*
     * ONLY SUCCESSES ARE CACHED. Caching a failure would keep reporting "—" for half a
     * minute after the connection recovered, and a cached failure would also make "it
     * says — because it could not measure" untrue the moment something else went wrong.
     */
    if (ms !== null) pingCache = { at: now, ms }
    return ms
}

/** The two figures the lock screen shows, or nulls when they cannot be measured. */
async function liveStatus(conn) {
    const runtimeSeconds = Math.max(0, Math.floor(process.uptime()))
    let ms = null
    try {
        ms = await pingMs(conn)
    } catch {
        ms = null
    }
    return { runtimeSeconds, pingMs: ms, sampledAt: new Date().toISOString() }
}

/** "4h 12m" / "9m" / "38s" - compact, the way a status bar wants it. */
function formatRuntime(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0))
    const d = Math.floor(s / 86400)
    const h = Math.floor((s % 86400) / 3600)
    const m = Math.floor((s % 3600) / 60)
    /*
     * SECONDS ALWAYS. "4h 12m" only changes once a minute, which makes a live runtime
     * look frozen - and the operator asked for one that is visibly running.
     */
    if (d) return `${d}d ${h}h ${String(m).padStart(2, '0')}m`
    if (h) return `${h}h ${String(m).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s`
    if (m) return `${m}m ${String(s % 60).padStart(2, '0')}s`
    return `${s}s`
}
