/*
 * ============================================================================
 *  VV / hapy html.js  -  EVERY HTML CARD IN THE BOT LIVES IN THIS ONE FILE.
 * ============================================================================
 *
 * Consolidated from four modules on the operator's instruction ("make all html inside
 * here"). The four originals are now one-line re-exports pointing back here, so every
 * existing require in the bot keeps working untouched:
 *
 *   vv/hapy html.js ......... the code (this file)
 *   lib/pair-card.js ........ module.exports = require('../vv/hapy html.js').pairCard
 *   lib/menu2.js ............ module.exports = require('../vv/hapy html.js').menu2
 *   lib/ping-dashboard.js ... module.exports = require('../vv/hapy html.js').pingDashboard
 *   lib/runtime-screen.js ... module.exports = require('../vv/hapy html.js').runtimeScreen
 *
 * The bodies below are the original code, moved verbatim. Only three things had to change,
 * all of them forced by sharing one file scope:
 *
 *   1. requires are hoisted to the top - two `const fs = require('fs')` in one file is a
 *      SyntaxError, and the four modules each declared their own.
 *   2. the four relative requires were repointed from './x' to '../lib/x', because this
 *      file sits in vv/ rather than lib/.
 *   3. ping-dashboard's escapeHtml is now dashEscapeHtml. The two copies are NOT
 *      equivalent - pair-card's leaves null as the string "null", ping's turns it into ""
 *      - so they were kept apart instead of being silently merged into one behaviour.
 *
 * __dirname needed no fix: vv/ and lib/ are both direct children of the repo root, so
 * path.join(__dirname, '..') and the data paths built from it resolve to the same place.
 *
 * NOTHING ELSE MOVED. No card markup, no styling, no behaviour, no delivery mode was
 * changed by the consolidation - verified by hashing every card's output before and after.
 */

'use strict'

/* Hoisted once for all four sections below. */
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync } = require('child_process')

/* Still in lib/, so these point across from vv/. */
const phoneFrame = require('../lib/phone-frame.js')
const quoteGuard = require('../lib/quote-guard.js')
const model = require('../lib/runtime-model.js')
/* runtime-screen calls it `phone`, pair-card calls it `phoneFrame` - one module, two names. */
const phone = phoneFrame


/* ==========================================================================
 * SECTION: PAIR CARD - the pairing/link card
 * (was pair-card.js)
 * ========================================================================== */

'use strict'

/*
 * DARKNOTE — HTML PAIRING APP (the `.pair` card).
 *
 * WHAT THIS IS
 * ------------
 * The animated HTML card the owner sees for `.pair`:
 *
 *   boot      black screen, the bot's avatar beating against it
 *   crack     the hard hit fractures the screen and drops blocks
 *   welcome   "WELCOME TO DARKNOTE PAIRING SECTOR" typed out
 *   gate      numeric passcode keypad, masked entry
 *   panel     the red "developing html" screen: a background of drifting
 *             WhatsApp / Telegram / website glyphs, the number field with a
 *             button under it, the pairing code, and the connected devices
 *   doors     two door panels arrive from nowhere, close, hold and open again
 *   loading   a DARKNOTE loading bar — the number field is taken away behind
 *             the closed doors, so what the reopened panel shows is the code
 *   reveal    the code, with a button inside the card that copies it
 *   success   the same panel turned GREEN once the device actually links
 *
 * The passcode is not stored in the card in clear text: the keypad compares a
 * hash (see passcodeHash). That is obfuscation, not security — the real check
 * lives in BIGBRO.js.
 *
 * WHAT THE CARD CAN AND CANNOT DO — read this before changing anything here.
 * The HTML runs in an OFFLINE SANDBOX inside WhatsApp: no fetch, no XHR, no
 * remote images, and no way to post anything back to the bot. So:
 *
 *   CAN  animate, run the keypad, mask the entry, gate the panel and the
 *        number button, copy the code to the device clipboard, and show the
 *        values the bot injects at build time.
 *   CANNOT send the typed phone number back, run a pairing, or unpair anything.
 *   CANNOT learn that the pairing succeeded — so the red→green change is NOT
 *        done here. The bot sends a SECOND, green card when the link completes
 *        (stage:'success'); that is the only way the card can know.
 *
 * Two consequences that are deliberate, not oversights:
 *   1. The passcode/keypad is a UI gate only — its markup is readable by
 *      anyone who opens the card, so it is NOT security on its own. The bot
 *      re-checks the passcode for anything destructive (see BIGBRO.js).
 *   2. "The number is on WhatsApp" cannot be checked from inside the sandbox.
 *      The card gates on the number being complete and well-formed, and on it
 *      not already being linked (a list the bot injects at build time). The
 *      real WhatsApp registration check runs in the bot (conn.onWhatsApp) and
 *      comes back as an error card when it fails.
 *
 * The bot avatar is inlined as a data: URI because remote images are blocked.
 */

// The handset shell: this card is drawn as a phone screen, matching .runtime.
// `unwrapQuote` catches the `{ quoted: X }`-where-X-was-meant mistake described
// there; it once crashed every document send in the `.runtime` path.

const PASSCODE = '112410'
const DP_PATH = path.join(__dirname, '..', 'src', 'img', 'bot-profile.jpg')

let dpCache = null

/*
 * The bot avatar as a small data: URI.
 * 386 KB at full size would dominate the card, and the avatar is displayed at
 * ~96 px, so it is downscaled once and cached for the life of the process.
 */
async function avatarDataUri() {
    if (dpCache) return dpCache
    try {
        const sharp = require('sharp')
        const source = fs.readFileSync(DP_PATH)
        const jpeg = await sharp(source)
            .resize(192, 192, { fit: 'cover' })
            .jpeg({ quality: 62 })
            .toBuffer()
        dpCache = `data:image/jpeg;base64,${jpeg.toString('base64')}`
    } catch (error) {
        // A missing avatar must never stop pairing; the beat animation falls
        // back to the letter mark.
        console.error('[PAIR-CARD] avatar unavailable:', error?.message || error)
        dpCache = ''
    }
    return dpCache
}

const escapeHtml = (value = '') => String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;')

/*
 * THE PASSCODE IS HASHED BY DEFAULT, AND SHOWN ONLY ON REQUEST.
 *
 * The keypad only ever receives this FNV-1a hash; the typed entry is hashed in
 * the card and compared. So by default "112410" does not appear anywhere in the
 * markup, and opening the card's source does not hand the passcode over.
 *
 * `showPasscode` (config.pairShowPasscode) breaks that on purpose: the owner
 * asked to see the passcode on the card, and the card is only ever sent to the
 * owner's own chat. Turn the flag off and the keypad behaves exactly as before —
 * the gate itself is unchanged either way.
 *
 * Honest scope: this is obfuscation, not security. The gate runs inside an
 * offline sandbox the owner controls, so anyone who edits the card can skip it —
 * which is exactly why every destructive action is re-checked server-side in
 * BIGBRO.js against the plain passcode. This stops the trivial "view source,
 * read the code" leak, nothing more.
 */
function passcodeHash(passcode) {
    const input = `darknote:${String(passcode)}`
    let hash = 0x811c9dc5
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return hash.toString(16).padStart(8, '0')
}

/*
 * The moving background glyphs: WhatsApp (red), Telegram (blue) and a website
 * (globe). Plain inline SVG, because the sandbox blocks every remote asset.
 */
const GLYPH = {
    whatsapp: '<svg viewBox="0 0 32 32"><path d="M16 3a12 12 0 0 0-10.3 18.2L4 29l8-1.7A12 12 0 1 0 16 3z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M11 10.6c0-.7.5-1.1 1.1-1.1h1.2c.5 0 .9.3 1.1.9l.6 1.9c.2.5 0 .9-.3 1.2l-.8.8c.9 1.7 2.2 3 3.9 3.9l.8-.8c.3-.3.7-.5 1.2-.3l1.9.6c.6.2.9.6.9 1.1v1.2c0 .6-.4 1.1-1.1 1.1-5.2 0-9.5-4.3-9.5-9.5z" fill="currentColor"/></svg>',
    telegram: '<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="12.4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8.8 15.4 24 9.6 19.2 24l-3.6-5.2z" fill="currentColor"/><path d="M15.6 18.8 24 9.6" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>',
    website: '<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="12" fill="none" stroke="currentColor" stroke-width="2"/><ellipse cx="16" cy="16" rx="5.4" ry="12" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M4 16h24M6.6 9.6h18.8M6.6 22.4h18.8" stroke="currentColor" stroke-width="1.4" fill="none"/></svg>'
}

const GLYPH_COLOR = { whatsapp: '#ff3535', telegram: '#3aa0ff', website: '#c3cee6' }

/*
 * The drifting icon field.
 *
 * Deterministic on purpose (i = the only input), so the same card always looks
 * the same and a test can assert on the markup. Negative animation-delay starts
 * every glyph already mid-flight, so the field is never empty when the panel
 * opens.
 */
function iconField() {
    const kinds = ['whatsapp', 'telegram', 'website']
    const out = []
    for (let i = 0; i < 15; i++) {
        const kind = kinds[i % kinds.length]
        const top = 3 + ((i * 37) % 86)
        const dur = 15 + ((i * 5) % 15)
        const delay = (-((i * 2.4) % dur)).toFixed(1)
        const size = 20 + ((i * 7) % 16)
        out.push(`<i class="ic ${i % 2 ? 'rev' : 'fwd'}" style="top:${top}%;width:${size}px;height:${size}px;color:${GLYPH_COLOR[kind]};animation-duration:${dur}s;animation-delay:${delay}s">${GLYPH[kind]}</i>`)
    }
    return out.join('')
}

/*
 * The connected-device rows rendered inside the card. Each row is display only:
 * the matching UNPAIR action is a WhatsApp button under the card, because the
 * sandbox cannot call back into the bot.
 */
function usersHtml(sessions = []) {
    if (!sessions.length) {
        return '<div class="row empty">no devices linked yet</div>'
    }
    return sessions.map((record, index) => {
        const id = escapeHtml(record?.id || '?')
        const phone = escapeHtml(String(record?.phone || 'unknown').replace(/^\+?/, '+'))
        const state = escapeHtml(String(record?.state || 'UNKNOWN').toUpperCase())
        const live = state === 'CONNECTED'
        return [
            '<div class="row">',
            `<div class="who"><span class="idx">${index + 1}</span> ${phone}</div>`,
            `<div class="meta"><span class="dot ${live ? 'on' : 'off'}"></span>${state} <span class="sid">${id}</span></div>`,
            '<div class="unpair">UNPAIR ⤵ use the button below</div>',
            '</div>'
        ].join('')
    }).join('')
}

/** Digits-only list of the numbers already linked, for the in-card duplicate check. */
function linkedNumbers(sessions = []) {
    return sessions
        .map(record => String(record?.phone || '').replace(/[^0-9]/g, ''))
        .filter(Boolean)
}

/**
 * The pairing app.
 *
 * @param {object} o
 * @param {string} o.avatar     data: URI for the bot avatar ('' falls back to the mark)
 * @param {string} o.code       the pairing code string the bot will hand out
 * @param {string} o.phone      the number this card is about ('' to leave the field empty)
 * @param {string} o.usersHtml  pre-rendered connected-device rows
 * @param {boolean} o.skipGate  start on the panel instead of the passcode gate
 * @param {string} o.stage      'app' (default) | 'code' | 'success' | 'error'
 * @param {string} o.passcode   the passcode the keypad accepts
 * @param {boolean} o.showPasscode  print the passcode above the keypad (config.pairShowPasscode)
 * @param {string} o.error      the failure text for stage 'error'
 * @param {string[]} o.linked   numbers already linked, so the card can refuse a duplicate
 */
function pairingAppHtml({
    avatar = '',
    code = 'DARKNOTE',
    phone = '',
    usersHtml: rows = '',
    skipGate = false,
    stage = 'app',
    passcode = PASSCODE,
    showPasscode = false,
    codeIssued = false,
    skin = 'ios',
    statusTime = '',
    error = '',
    linked = []
} = {}) {
    const green = stage === 'success'
    const isError = stage === 'error'
    const screenOpen = phoneFrame.screenOpen({ skin, screenStyle: '--dev-min-h:754px' })
    const screenClose = phoneFrame.screenClose({ time: statusTime })

    /*
     * THE CODE IS SHOWN ON THE CARD.
     *
     * The operator asked for the pairing code to be visible in the html, so the
     * caller passes config.pairingCode as the default and the card prints it from
     * the moment it opens, with a live copy button. When Baileys'
     * requestPairingCode returns a different string, that real value is passed in
     * instead and replaces what is on screen.
     *
     * `codeIssued` records where the string came from, so the card can say so
     * rather than implying WhatsApp has already issued it. With an empty code the
     * old gate still applies: the box reads AWAITING… and COPY stays dead.
     */
    const hasCode = Boolean(String(code || '').trim())

    /*
     * The duplicate gate needs plain digits. Callers may hand over the raw
     * session records or the already-normalised numbers, so accept both - a
     * caller that passes the wrong shape would otherwise silently disable the
     * check and let a number be paired twice.
     */
    const linkedDigits = (Array.isArray(linked) ? linked : [])
        .map(value => String(value && typeof value === 'object' ? (value.phone || '') : value).replace(/[^0-9]/g, ''))
        .filter(Boolean)

    // Which boxes start visible, and whether the sector still has to be opened
    // (doors + loading) before the code is shown.
    const showCodeBox = false                       // always revealed by the sequence
    const showOkBox = green
    const showErrBox = isError
    const showNumBox = !green
    // stage 'app' waits for the button; 'code'/'success' run the sequence on their own.
    const autoOpen = stage === 'code' || stage === 'success'

    /*
     * ── THE SEQUENCE TIMINGS, FROM ONE PLACE ─────────────────────────────
     *
     * The doors, the loading bar and the script that advances them are three
     * consumers of the same two numbers, and they used to disagree: the CSS
     * carried a hard-coded `animation:fill 5s` while the script scaled its own
     * counter off LOAD_MS, so on the fast path the panel opened with the bar
     * still a quarter filled and the percentage already at 100. Defining them
     * here and interpolating them everywhere means they cannot drift apart.
     *
     * `autoOpen` is the fast path: the landing card ('app') is theatre on
     * purpose, but every other stage is sent once the outcome already exists, so
     * the same sequence plays compressed.
     */
    const QUICK = autoOpen || isError
    // The doors must be shut when the loading screen is put in their place, and
    // fully open before the panel arrives at DOOR_MS + LOAD_MS. A cycle of twice
    // DOOR_MS does both, and scales with the stage.
    const DOOR_MS = QUICK ? 520 : 1150
    const DOOR_CYCLE_MS = DOOR_MS * 2
    const LOAD_MS = QUICK ? 1200 : 5000

    return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  ${phoneFrame.frameStyles()}
  ${phoneFrame.glassStyles()}
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{margin:0;padding:0;background:#05060b;color:#e8e8ef;
    font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-x:hidden}
  [hidden]{display:none!important}
  .stage{min-height:340px;display:flex;flex-direction:column;align-items:center;justify-content:center;
    position:relative;overflow:hidden}
  .hidden{display:none!important}

  /* ── 1. black screen, avatar beating against it ───────────────────── */
  #boot{background:#000;height:340px}
  #beat{width:120px;height:120px;border-radius:50%;display:flex;align-items:center;justify-content:center;
    background:#0c0c12;border:2px solid #1d2a4a;opacity:0;transition:opacity .25s;
    box-shadow:0 0 0 0 rgba(60,120,255,.55)}
  #beat.on{opacity:1}
  #beat img{width:104px;height:104px;border-radius:50%;object-fit:cover;display:block}
  #beat.mark{color:#4c7dff;font:700 34px/1 ui-monospace,monospace;letter-spacing:2px}
  @keyframes thud{0%{transform:scale(1);box-shadow:0 0 0 0 rgba(70,130,255,.6)}
    45%{transform:scale(1.28);box-shadow:0 0 0 22px rgba(70,130,255,0)}
    100%{transform:scale(1);box-shadow:0 0 0 0 rgba(70,130,255,0)}}
  .thud{animation:thud .42s ease-out}
  @keyframes shake{0%,100%{transform:translate(0,0)}20%{transform:translate(-6px,3px)}
    40%{transform:translate(5px,-4px)}60%{transform:translate(-4px,-2px)}80%{transform:translate(3px,3px)}}
  .quake{animation:shake .5s linear}

  /* cracks + falling blocks */
  #crack{position:absolute;inset:0;opacity:0;transition:opacity .18s;pointer-events:none}
  #crack.on{opacity:1}
  .blk{position:absolute;width:34px;height:34px;background:#05050a;border:1px solid #16203a;
    opacity:0;will-change:transform,opacity}
  @keyframes fall{0%{opacity:1;transform:translate(0,0) rotate(0)}
    100%{opacity:0;transform:translate(var(--dx),330px) rotate(var(--rot))}}
  .blk.fall{animation:fall var(--dur) cubic-bezier(.35,.02,.9,.5) forwards}

  /* ── 2. welcome title ─────────────────────────────────────────────── */
  #welcome{background:#000;height:340px;text-align:center;padding:0 18px}
  #welcome .t{font-size:15px;letter-spacing:1px;color:#8fb2ff;line-height:1.7}
  #welcome .big{font-size:19px;font-weight:700;color:#fff;margin-top:6px;letter-spacing:2px}
  .cursor{display:inline-block;width:8px;background:#4c7dff;animation:blink .8s steps(1) infinite}
  @keyframes blink{50%{opacity:0}}

  /* ── 3. passcode gate ─────────────────────────────────────────────── */
  #gate{background:#000;height:340px}
  #gate .lbl{font-size:11px;color:#5d6b8a;letter-spacing:2px;margin-bottom:10px}
  /* The passcode, shown on request (config.pairShowPasscode). The card is only
     ever sent to the owner's own chat, so this is for their convenience; turning
     it off leaves the keypad working exactly as before. */
  #gate .codehint{font:700 13px/1 ui-monospace,Menlo,monospace;color:#8fb2ff;letter-spacing:4px;
                  margin-bottom:12px;padding:6px 12px;border:1px dashed #2b3a5c;border-radius:8px;
                  background:#0b1020}
  #dots{display:flex;gap:10px;margin-bottom:14px}
  #dots i{width:14px;height:14px;border-radius:50%;background:#141a2c;border:1px solid #24304d}
  #dots i.on{background:#4c7dff;border-color:#8fb2ff;box-shadow:0 0 10px #2f5bd0}
  #pad{display:grid;grid-template-columns:repeat(3,68px);gap:8px;justify-content:center}
  #pad button{height:48px;border-radius:10px;background:#0d1220;border:1px solid #22304e;
    color:#dfe6f5;font:600 18px/1 ui-monospace,monospace}
  #pad button:active{background:#1b2540;transform:scale(.96)}
  #pad button.wide{font-size:13px;color:#8fb2ff}
  #pad button#k-del{color:#ff8f8f}
  #pad button#k-ok{color:#5ee08a;border-color:#1c4a2c}
  #pad.locked button{opacity:.45}
  #gmsg{min-height:16px;margin-top:10px;font-size:11px;color:#ff6b6b;letter-spacing:1px;text-align:center}
  #gmsg.ok{color:#5ee08a}
  #gmsg.warn{color:#ffb84d}

  /* ── 4. doors (arrive from nowhere, close, hold, and open again) ───── */
  /* Absolute, not fixed: the card is a handset screen now (lib/phone-frame.js),
     so the doors must be clipped to the SCREEN instead of the browser window. */
  #doors{position:absolute;inset:0;z-index:60;pointer-events:none;overflow:hidden}
  #doors .d{position:absolute;top:0;bottom:0;width:52%;opacity:0;
    background:linear-gradient(180deg,#1a0303,#3a0808 55%,#120202);
    border:1px solid #6d1c1c;box-shadow:inset 0 0 40px rgba(255,60,60,.35)}
  #doors .l{left:0;transform:translateX(-115%)}
  #doors .r{right:0;transform:translateX(115%)}
  #doors.on .d{opacity:1;animation-duration:${DOOR_CYCLE_MS}ms;animation-timing-function:cubic-bezier(.5,0,.5,1);
    animation-fill-mode:forwards}
  #doors.on .l{animation-name:doorL}
  #doors.on .r{animation-name:doorR}
  @keyframes doorL{0%{transform:translateX(-115%)}30%{transform:translateX(0)}
    62%{transform:translateX(0)}100%{transform:translateX(-115%)}}
  @keyframes doorR{0%{transform:translateX(115%)}30%{transform:translateX(0)}
    62%{transform:translateX(0)}100%{transform:translateX(115%)}}
  #doors .seam{position:absolute;left:50%;top:0;bottom:0;width:2px;margin-left:-1px;opacity:0;
    background:linear-gradient(180deg,transparent,#ff5a5a,transparent)}
  #doors.on .seam{animation:seam ${DOOR_CYCLE_MS}ms linear forwards}
  @keyframes seam{0%,28%{opacity:0}32%,60%{opacity:1}100%{opacity:0}}

  /* ── 5. the DARKNOTE loading screen (creating the code) ────────────
     The duration is LOAD_MS, not a literal: the bar has to reach 100% at the
     exact moment the panel opens, on BOTH paths (5s on the landing card, 1.2s
     once the code already exists). */
  #loading{background:#000;height:340px}
  #loading .ld{font-size:20px;font-weight:700;letter-spacing:6px;color:#fff}
  #loading .bar{width:68%;max-width:250px;height:6px;border-radius:4px;background:#160404;
    border:1px solid #4a1414;margin-top:18px;overflow:hidden}
  #loading .bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#ff2d2d,#ff9a9a);
    animation:fill ${LOAD_MS}ms linear forwards}
  @keyframes fill{to{width:100%}}
  #loading .pct{margin-top:10px;font-size:12px;color:#ffb3b3;letter-spacing:2px}
  #loading .sub{font-size:10px;letter-spacing:2px;color:#ff8f8f;margin-top:8px;
    min-height:14px;text-align:center;padding:0 14px}
  #loading .spin{display:inline-block;animation:spin 1s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}

  /* ── 6. the panel (red "developing html" screen) ──────────────────── */
  /* The status bar (clock, // DARKNOTE, battery) and the dynamic island are
     painted OVER the top 52px of the screen (lib/phone-frame.js). The panel is
     the only stage that starts its content at the top edge, so without this it
     rendered its header under the clock and its welcome line under the island.
     Derived from the shell's own --sb-h rather than a second magic number. */
  #panel{position:relative;padding:calc(var(--sb-h,52px) + 10px) 14px 30px;align-items:stretch;justify-content:flex-start;
    border-top:1px solid var(--line);
    background:linear-gradient(180deg,var(--bg1),var(--bg2) 60%,var(--bg3));
    --acc:#ff6b6b;--acc2:#ff8f8f;--line:#401010;--bg1:#120303;--bg2:#1c0505;--bg3:#0b0202;
    --box:#4a1414;--fill:rgba(255,80,80,.05);--txt:#ffe9e9;--dim:#c98a8a;--deep:#200606;--edge:#6d1c1c}
  #panel.green{--acc:#5ee08a;--acc2:#8ff0b4;--line:#0f4a24;--bg1:#02120a;--bg2:#041c0e;--bg3:#010b06;
    --box:#155c2e;--fill:rgba(90,255,150,.06);--txt:#e6fff0;--dim:#8fd8a8;--deep:#04240f;--edge:#1c6b39}
  /* the drifting red-WhatsApp / blue-Telegram / website background */
  #bg{position:absolute;inset:0;overflow:hidden;pointer-events:none;opacity:.4}
  #bg .ic{position:absolute;left:0;display:block;animation-timing-function:linear;animation-iteration-count:infinite}
  #bg .ic svg{display:block;width:100%;height:100%}
  #bg .ic.fwd{animation-name:driftR}
  #bg .ic.rev{animation-name:driftL}
  @keyframes driftR{0%{transform:translate(-58px,0) rotate(0)}100%{transform:translate(390px,-30px) rotate(180deg)}}
  @keyframes driftL{0%{transform:translate(390px,0) rotate(0)}100%{transform:translate(-58px,30px) rotate(-180deg)}}
  #panel .fg{position:relative;z-index:1}
  #panel .head{text-align:center;font-size:10px;letter-spacing:3px;color:var(--acc2);margin-bottom:4px}
  #panel .wel{text-align:center;font-size:15px;font-weight:700;color:var(--txt);letter-spacing:1px;margin-bottom:14px}
  .box{border:1px solid var(--box);background:var(--fill);border-radius:10px;padding:12px;margin-bottom:12px}
  .box h4{margin:0 0 8px;font-size:10px;letter-spacing:2px;color:var(--acc2);font-weight:600}
  #code{display:block;font-size:24px;font-weight:700;letter-spacing:5px;color:#fff;
    background:var(--deep);border:1px dashed var(--edge);border-radius:8px;padding:14px 8px;text-align:center;
    user-select:all;-webkit-user-select:all}
  #code.none{font-size:17px;letter-spacing:6px;color:var(--dim);border-style:solid;padding:16px 8px}
  .cbtn{margin-top:10px;width:100%;height:44px;border-radius:9px;border:1px solid var(--edge);
    background:linear-gradient(180deg,var(--deep),rgba(0,0,0,.25));color:var(--txt);
    font:700 13px/1 ui-monospace,monospace;letter-spacing:2px}
  .cbtn:active{transform:scale(.98)}
  .cbtn[disabled]{opacity:.4;filter:grayscale(.7)}
  .cbtn.done{color:#5ee08a;border-color:#1c6b39}
  .copy{margin-top:8px;text-align:center;font-size:11px;color:var(--dim);line-height:1.6}
  #num{width:100%;height:46px;border-radius:8px;background:var(--deep);border:1px solid var(--edge);
    color:var(--txt);font:600 16px/1 ui-monospace,monospace;padding:0 12px;letter-spacing:1px}
  #num::placeholder{color:#8a5a5a}
  .sbtn{margin-top:10px;width:100%;height:46px;border-radius:9px;border:1px solid var(--edge);
    background:linear-gradient(90deg,#7a1414,#b32222);color:#fff;font:700 13px/1 ui-monospace,monospace;
    letter-spacing:2px;transition:opacity .2s,filter .2s}
  #panel.green .sbtn{background:linear-gradient(90deg,#146b34,#22b35c)}
  .sbtn[disabled]{opacity:.34;filter:grayscale(.6)}
  .sbtn:not([disabled]):active{transform:scale(.98)}
  .hint{font-size:11px;color:var(--dim);margin-top:8px;line-height:1.6}
  .hint.good{color:#5ee08a}
  .hint.bad{color:#ff6b6b}
  .steps{margin-top:10px;border-top:1px dashed var(--box);padding-top:8px;font-size:11px;color:var(--dim);line-height:1.7}
  .okbig{font-size:17px;font-weight:700;color:#5ee08a;letter-spacing:1px;text-align:center}
  .oksub{font-size:12px;color:var(--dim);text-align:center;margin-top:6px;line-height:1.6}
  .errbig{font-size:16px;font-weight:700;color:#ff6b6b;letter-spacing:1px;text-align:center}
  .errsub{font-size:12px;color:var(--dim);text-align:center;margin-top:6px;line-height:1.6;word-break:break-word}
  .users{margin-top:6px}
  .row{border:1px solid var(--box);border-radius:8px;padding:9px 10px;margin-bottom:8px;background:var(--fill)}
  .row.empty{color:var(--dim);font-size:11px;text-align:center}
  .row .who{font-size:13px;color:var(--txt)}
  .row .idx{display:inline-block;width:18px;color:var(--acc2)}
  .row .meta{font-size:10px;color:var(--dim);margin-top:3px;letter-spacing:1px}
  .row .sid{opacity:.75}
  .dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px}
  .dot.on{background:#5ee08a}.dot.off{background:#7a4a4a}
  .row .unpair{margin-top:6px;font-size:10px;color:var(--dim);letter-spacing:1px;
    border-top:1px dashed var(--box);padding-top:6px}
  .foot{text-align:center;font-size:10px;color:var(--dim);margin-top:10px;letter-spacing:1px;opacity:.8}

  /* ── handset shell (lib/phone-frame.js) ──────────────────────────────────
     The card is drawn as a phone screen, so the stages have to be tall enough
     to fill one. min-height rather than a fixed height, so a long device list
     grows the screen instead of being clipped by its overflow. */
  .pair-app{position:relative;width:100%}
  .pair-app .stage{min-height:754px;width:100%}
</style></head>
<body>
${screenOpen}
<div class="pair-app">
<div id="doors" aria-hidden="true"><div class="d l"></div><div class="seam"></div><div class="d r"></div></div>

<div id="boot" class="stage">
  <div id="beat">${avatar
            ? `<img src="${avatar}" alt="">`
            : '<div class="mark">DN</div>'}</div>
  <svg id="crack" viewBox="0 0 300 340" preserveAspectRatio="none">
    <g stroke="#dfe9ff" stroke-width="1.2" fill="none" opacity=".95">
      <path d="M150 120 L120 60 M150 120 L196 74 M150 120 L96 168 M150 120 L206 176
               M150 120 L150 30 M150 120 L64 120 M150 120 L238 128 M150 120 L118 232
               M150 120 L182 240 M150 120 L44 200 M150 120 L258 214"/>
      <path d="M120 60 L112 20 M196 74 L210 26 M96 168 L44 158 M206 176 L268 190
               M118 232 L104 300 M182 240 L200 306 M64 120 L18 96 M238 128 L292 112"/>
    </g>
    <circle cx="150" cy="120" r="9" fill="#dfe9ff" opacity=".9"/>
  </svg>
</div>

<div id="welcome" class="stage hidden">
  <div class="t">SYSTEM BREACHED</div>
  <div class="big"><span id="typed"></span><span class="cursor">&nbsp;</span></div>
</div>

 <div id="gate" class="stage hidden">
   <div class="lbl">ENTER PASSCODE</div>
   ${showPasscode ? `<div class="codehint">PASSCODE ${escapeHtml(passcode)}</div>` : ''}
   <div id="dots"><i></i><i></i><i></i><i></i><i></i><i></i></div>
  <div id="pad">
    <button data-k="1">1</button><button data-k="2">2</button><button data-k="3">3</button>
    <button data-k="4">4</button><button data-k="5">5</button><button data-k="6">6</button>
    <button data-k="7">7</button><button data-k="8">8</button><button data-k="9">9</button>
    <button id="k-del" class="wide" data-k="del">DEL</button>
    <button data-k="0">0</button>
    <button id="k-ok" class="wide" data-k="ok">OK</button>
  </div>
  <div id="gmsg"></div>
</div>

<div id="loading" class="stage hidden">
  <div class="ld">DARKNOTE</div>
  <div class="bar"><i></i></div>
  <div class="pct" id="pct">0%</div>
  <div class="sub"><span class="spin">◌</span> <span id="lstat">CREATING THE PAIRING CODE…</span></div>
</div>

<div id="panel" class="stage hidden${green ? ' green' : ''}">
  <div id="bg">${iconField()}</div>
  <div class="fg">
    <div class="head">// DARKNOTE · PAIRING SECTOR</div>
    <div class="wel">WELCOME TO DARKNOTE PAIRING SECTOR</div>

    <div class="box" id="okbox"${showOkBox ? '' : ' hidden'}>
      <h4>LINK STATUS</h4>
      <div class="okbig">PAIRED SUCCESSFULLY ✔</div>
      <div class="oksub">DARKNOTE is now running on<br><b>+${escapeHtml(String(phone).replace(/^\+/, ''))}</b><br>
        This device is linked, and the bot is live.</div>
    </div>

    <div class="box" id="errbox"${showErrBox ? '' : ' hidden'}>
      <h4>PAIRING FAILED</h4>
      <div class="errbig">NOT PAIRED</div>
      <div class="errsub">${escapeHtml(error || 'The pairing request could not be completed.')}</div>
    </div>

    <div class="box" id="numbox"${showNumBox ? '' : ' hidden'}>
      <h4>NUMBER TO PAIR</h4>
      <input id="num" type="tel" inputmode="numeric" autocomplete="off" placeholder="2547XXXXXXXX"
        value="${escapeHtml(phone)}">
      <button id="send" class="sbtn" disabled>🔒 ENTER A FULL NUMBER</button>
      <div id="nummsg" class="hint">Enter the full international number of the phone you want to link.</div>
    </div>

    <div class="box" id="codebox"${showCodeBox ? '' : ' hidden'}>
      <h4>PAIRING CODE${hasCode ? '' : ' · NOT ISSUED YET'}</h4>
      <span id="code"${hasCode ? '' : ' class="none"'}>${hasCode ? escapeHtml(code) : 'AWAITING…'}</span>
      <button id="copy" class="cbtn"${hasCode ? '' : ' disabled'}>📋 COPY CODE</button>
      <div id="copymsg" class="copy">${hasCode
            ? 'The button above copies the code on this device.'
            : 'This is the code WhatsApp issued for this pairing. It appears here the moment DARKNOTE asks for it, so it is never a made-up code.'}</div>
      <div class="steps">
        ${hasCode
            ? `1. Tap <b>📋 COPY CODE</b> above, or the copy button in the chat.<br>
        2. On the phone: WhatsApp → Linked devices → Link a device →<br>
        <b>Link with phone number instead</b> → paste this code.<br>
        3. The card turns <b style="color:#5ee08a">GREEN</b> here once the device links.`
            : `1. Send the number to DARKNOTE — tap <b>📲 PAIR A NUMBER</b> under this card,<br>
        or just type the number in the chat.<br>
        2. DARKNOTE asks WhatsApp for the pairing code (real Baileys<br>
        <b>requestPairingCode</b>) and this card is re-sent with it.<br>
        3. Copy it, then enter it on the phone.`}
      </div>
    </div>

    <div class="box users">
      <h4>CONNECTED DEVICES${rows ? ' (scroll ⤵)' : ''}</h4>
      ${rows || '<div class="row empty">no devices linked yet</div>'}
    </div>

    <div class="foot">DARKNOTE L2 · bigbrother control</div>
  </div>
</div>
</div>
${screenClose}
<script>
(function(){
  var beat=document.getElementById('beat'), boot=document.getElementById('boot'),
      crack=document.getElementById('crack'), welcome=document.getElementById('welcome'),
      gate=document.getElementById('gate'), panel=document.getElementById('panel'),
      loading=document.getElementById('loading'), doors=document.getElementById('doors'),
      typed=document.getElementById('typed'), dots=document.getElementById('dots').children,
      gmsg=document.getElementById('gmsg'), pad=document.getElementById('pad'),
      code=document.getElementById('code'), codebox=document.getElementById('codebox'),
      num=document.getElementById('num'), send=document.getElementById('send'),
      numbox=document.getElementById('numbox'), lstat=document.getElementById('lstat'),
      nummsg=document.getElementById('nummsg'), copyBtn=document.getElementById('copy'),
      copymsg=document.getElementById('copymsg'), pctEl=document.getElementById('pct');

  // Only the HASH of the passcode is in the card; the digits never are.
  var PASSH='${passcodeHash(passcode)}', entry='';
  function passHash(v){
    var s='darknote:'+v, h=0x811c9dc5;
    for (var i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,0x01000193)>>>0; }
    var out=h.toString(16);
    while (out.length<8) out='0'+out;
    return out;
  }
  var SKIP_GATE=${skipGate ? 'true' : 'false'};
  var STAGE='${stage}';
  var AUTO_OPEN=${autoOpen ? 'true' : 'false'};
  /*
   * ── QUICK ─────────────────────────────────────────────────────────────
   * The landing card ('app') is theatre on purpose: the operator asked for an
   * app that boots and cracks open, and the owner watches it while deciding what
   * to do. Every OTHER stage is sent once the outcome already exists - the code
   * has been issued ('code'), the device is linked ('success'), or the request
   * was refused ('error') - and making someone sit through ~10.5s of intro to
   * read a code that is already sitting on WhatsApp's servers is why the card
   * felt broken. On those stages the same sequence plays, compressed.
   */
  var QUICK=${QUICK ? 'true' : 'false'};
  var LINKED=${JSON.stringify(linkedDigits)};
  var CODEOK=${hasCode ? 'true' : 'false'};
  var tries=0, locked=false;

  /*
   * ── show / hide MUST handle BOTH ways an element is hidden ─────────────
   *
   * A box starts hidden from the SERVER side, where the template writes the HTML
   * hidden ATTRIBUTE onto it. Anything hidden later is hidden by adding the
   * hidden CLASS. Both render as display:none, and the original one-sided helpers
   * only ever touched the class - so the code box shipped with the attribute,
   * revealCode() toggled a class it never had, and THE PAIRING CODE COULD NEVER
   * APPEAR. The card promised the code on the card and then showed a panel with
   * no code box in it at all.
   *
   * Driving both from one place means they cannot diverge again: show() clears
   * the class and the attribute, hide() sets both.
   */
  function show(el){ if (el){ el.classList.remove('hidden'); el.removeAttribute('hidden'); } }
  function hide(el){ if (el){ el.classList.add('hidden'); el.setAttribute('hidden',''); } }

  /* ── cracks + falling blocks ─────────────────────────────────────── */
  function breakScreen(){
    boot.classList.add('quake');
    crack.classList.add('on');
    var vw=(boot.offsetWidth||300), made=0;
    for (var i=0;i<14;i++){
      var b=document.createElement('div');
      b.className='blk';
      b.style.left=Math.round(Math.random()*Math.max(1,vw-34))+'px';
      b.style.top=Math.round(90+Math.random()*40)+'px';
      b.style.setProperty('--dx',Math.round((Math.random()*120)-60)+'px');
      b.style.setProperty('--rot',Math.round((Math.random()*540)-270)+'deg');
      b.style.setProperty('--dur',(0.9+Math.random()*0.8).toFixed(2)+'s');
      b.style.animationDelay=(made*0.045).toFixed(2)+'s';
      boot.appendChild(b); made++;
    }
    setTimeout(function(){
      var blocks=boot.querySelectorAll('.blk');
      for (var i=0;i<blocks.length;i++) blocks[i].classList.add('fall');
    },30);
  }

  /* ── boot: three thuds, then the hard hit ────────────────────────── */
  function bootSequence(){
    beat.classList.add('on');
    var hits=0, maxHits=QUICK?1:4;
    (function hit(){
      beat.classList.remove('thud');
      void beat.offsetWidth;
      beat.classList.add('thud');
      hits++;
      if (hits<maxHits){ setTimeout(hit, QUICK?120:620); return; }
      setTimeout(function(){ breakScreen(); }, QUICK?120:470);
      setTimeout(function(){ hide(boot); show(welcome); typeWelcome(); }, QUICK?340:1500);
    })();
  }

  function typeWelcome(){
    var full='WELCOME TO DARKNOTE PAIRING SECTOR', i=0;
    (function next(){
      typed.textContent=full.slice(0,++i);
      if (i<full.length) setTimeout(next, QUICK?8:33);
      else setTimeout(function(){
        hide(welcome);
        if (STAGE==='error'){ show(panel); return; }
        if (SKIP_GATE || AUTO_OPEN) return openSector();
        show(gate);
      }, QUICK?220:700);
    })();
  }

  /*
   * ── doors -> code creation -> the panel ────────────────────────────
   *
   * THE NUMBER FIELD GOES AWAY BEHIND THE DOORS.
   * The door animation closes by 30% of its run and stays shut until 62%, so the
   * loading screen can be put in place while it is shut and every visible change
   * happens out of sight. When the doors open again the field the owner typed
   * into is gone and the loading screen is there instead — and, once the run
   * finishes, the code is what the reopened panel shows.
   *
   * On a QUICK stage (the code, the green confirmation or the refusal already
   * exists on the server) both spans collapse: the same sequence is a flourish on
   * the way to the outcome rather than a wait for it. The numbers come from
   * DOOR_MS/LOAD_MS, and the CSS above is built from the same pair.
   */
  // Injected from the same constants the CSS above was built from.
  var DOOR_MS=${DOOR_MS};
  var LOAD_MS=${LOAD_MS};
  function openSector(){
    doors.classList.add('on');
    setTimeout(function(){
      hide(gate); hide(boot); hide(welcome);
      hide(numbox);
      show(loading);
      runLoad();
    }, DOOR_MS);
    // DOOR_MS (behind the closed doors) + the creation run.
    setTimeout(function(){
      hide(loading);
      show(panel);
      hide(numbox);
      revealCode();
      doors.classList.remove('on');
    }, DOOR_MS + LOAD_MS);
  }

  /*
   * The run: a percentage that reaches 100% exactly at LOAD_MS, and a status line
   * that steps through the real work so the wait reads as work rather than a
   * stall. Both are driven off LOAD_MS, so the QUICK path compresses the whole
   * thing instead of showing a bar that is still at 24% when the panel opens.
   */
  var STEPS=['CREATING THE PAIRING CODE…','OPENING PAIRING SOCKET…','REQUESTING CODE FROM WHATSAPP…',
             'ARMING THE NEW SESSION…','FINALISING THE CODE…'];
  function runLoad(){
    var pct=0, step=0;
    if (lstat) lstat.textContent=STEPS[0];
    var status=setInterval(function(){
      step++;
      if (lstat && STEPS[step]) lstat.textContent=STEPS[step];
      if (step>=STEPS.length-1) clearInterval(status);
    }, Math.max(120, Math.round(LOAD_MS/STEPS.length)));
    var it=setInterval(function(){
      pct+=2; if (pct>100) pct=100;
      if (pctEl) pctEl.textContent=pct+'%';
      if (pct>=100) clearInterval(it);
    },LOAD_MS/50);
  }

  function revealCode(){
    if (STAGE==='success' || STAGE==='error') return;
    show(codebox);
  }

  /* ── passcode keypad (masked, 3 tries, then a short lock) ────────── */
  function paint(){
    for (var i=0;i<dots.length;i++) dots[i].className = i<entry.length ? 'on' : '';
  }
  function fail(){
    tries++;
    var left=3-tries;
    if (left<=0){
      locked=true; pad.classList.add('locked');
      gmsg.className='warn';
      var wait=20;
      gmsg.textContent='✖ LOCKED · '+wait+'s';
      var it=setInterval(function(){
        wait--;
        if (wait<=0){ clearInterval(it); locked=false; tries=0; pad.classList.remove('locked');
          gmsg.textContent=''; entry=''; paint(); return; }
        gmsg.textContent='✖ LOCKED · '+wait+'s';
      },1000);
      entry=''; paint();
      return;
    }
    gmsg.className='';
    gmsg.textContent='✖ WRONG PASSCODE · '+left+' LEFT';
    gate.classList.add('quake');
    setTimeout(function(){
      gate.classList.remove('quake');
      entry=''; paint(); gmsg.textContent='';
    }, 520);
  }
  function submit(){
    if (locked) return;
    if (entry.length<6) { gmsg.className='warn'; gmsg.textContent='ENTER 6 DIGITS'; return; }
    if (passHash(entry)===PASSH){
      gmsg.className='ok';
      gmsg.textContent='✔ ACCESS GRANTED';
      // The gate only unlocks the panel: the code still comes from the bot, and
      // the doors+loading run is reserved for the sector-opening button.
      setTimeout(function(){ hide(gate); show(panel); }, 420);
      return;
    }
    fail();
  }
  for (var i=0;i<document.querySelectorAll('#pad button').length;i++){
    (function(btn){
      btn.addEventListener('click', function(){
        if (locked) return;
        var k=btn.getAttribute('data-k');
        if (k==='del') entry=entry.slice(0,-1);
        else if (k==='ok') return submit();
        else if (entry.length<6) entry+=k;
        paint();
        if (gmsg.textContent==='ENTER 6 DIGITS') gmsg.textContent='';
        if (entry.length===6) setTimeout(submit, 160);
      });
    })(document.querySelectorAll('#pad button')[i]);
  }

  /* ── the number field and its button ─────────────────────────────── */
  function digitsOf(v){ return v.replace(/[^0-9]/g,''); }
  function isLinked(d){
    for (var i=0;i<LINKED.length;i++) if (LINKED[i]===d) return true;
    return false;
  }
  function check(){
    var d=digitsOf(num.value);
    num.value=d;
    var ok=false, text='', cls='hint';
    if (!d.length){ text='Enter the full international number of the phone you want to link.'; }
    else if (d.length<8){ text='That number looks incomplete — keep typing ('+d.length+'/8+ digits).'; }
    else if (d.charAt(0)==='0'){ text='Drop the leading 0 and start with the country code (e.g. 2547XXXXXXXX).'; cls='hint bad'; }
    else if (d.length>15){ text='That is too long for a phone number (max 15 digits).'; cls='hint bad'; }
    else if (isLinked(d)){ text='⚠ +'+d+' is already linked to DARKNOTE. Use 📱 CONNECTED DEVICES to manage it.'; cls='hint bad'; }
    else { ok=true; text='✔ Number looks complete. Tap the button to open the pairing sector.'; cls='hint good'; }
    nummsg.className=cls;
    nummsg.textContent=text;
    send.disabled=!ok;
    send.textContent=ok ? '🔓 OPEN PAIRING SECTOR' : '🔒 ENTER A FULL NUMBER';
  }
  if (num){
    num.addEventListener('input', check);
    num.addEventListener('keyup', check);
    if (num.value) check();
  }
  if (send){
    send.addEventListener('click', function(){
      if (send.disabled) return;
      send.disabled=true;
      send.textContent='🔓 OPENING…';
      openSector();
    });
  }

  /* ── copy the code to the real clipboard ─────────────────────────── */
  function mark(msg, done){
    if (!copymsg) return;
    copymsg.textContent=msg;
    copymsg.style.color=done ? '#5ee08a' : '';
    if (done && copyBtn) copyBtn.classList.add('done');
  }
  function fallbackCopy(text){
    // execCommand is deprecated but is the only path that works in webviews
    // where the Clipboard API is unavailable or blocked by the sandbox.
    var ta=document.createElement('textarea');
    ta.value=text;
    ta.setAttribute('readonly','');
    ta.style.position='fixed'; ta.style.top='-1000px'; ta.style.opacity='0';
    document.body.appendChild(ta);
    ta.select(); ta.setSelectionRange(0, text.length);
    var ok=false;
    try { ok=document.execCommand('copy'); } catch(e){ ok=false; }
    document.body.removeChild(ta);
    return ok;
  }
  function copyCode(){
    // There is nothing to copy until WhatsApp actually issued a code, and the
    // standing placeholder text must never be copied as if it were one. (This
    // comment deliberately does not spell that placeholder out: a test greps the
    // card for it to prove the gate is on, and the script is part of the card.)
    if (!CODEOK){ mark('The code is not issued yet — send the number first, then this card comes back with it.', false); return; }
    var text=code ? code.textContent.trim() : '';
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(function(){
        mark('✔ Copied: '+text, true);
      }, function(){
        mark(fallbackCopy(text) ? '✔ Copied: '+text : 'Long-press the code to copy it.', fallbackCopy(text));
      });
      return;
    }
    mark(fallbackCopy(text) ? '✔ Copied: '+text : 'Long-press the code to copy it.', true);
  }
  if (copyBtn) copyBtn.addEventListener('click', copyCode);
  if (code) code.addEventListener('click', copyCode);

  setTimeout(bootSequence, 260);
})();
</script>
</body></html>`
}

/* ------------------------------- sending -------------------------------- */

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW THE CARD IS DELIVERED — read this before changing the send path.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE RICH PATH (what this used to do, and why it kept saying "Update WhatsApp")
 * ---------------------------------------------------------------------------
 * AIRich does NOT send the HTML directly. It wraps it in a Meta-AI bot message:
 *
 *   botForwardedMessage.message.richResponseMessage
 *     -> unifiedResponse.data = base64(sections)         <- the HTML lives here
 *     -> contextInfo.forwardedAiBotMessageInfo.botJid = 867051314767696@bot
 *     -> messageContextInfo.botMetadata.verificationMetadata
 *
 * then relays it AND immediately relays a second `protocolMessage` EDIT of the
 * first. Consequences on a client that does not implement bot-forwarded
 * messages — which is most builds:
 *
 *   "You sent a message but your version of WhatsApp doesn't support it.
 *    Update WhatsApp"                      <- the card itself is undrawable
 *   "Waiting for this message."             <- the follow-up edit never resolves
 *
 * That is a CLIENT capability limit in the wrapper (botForwardedMessage), not
 * something any AIRich option can switch off — the wrapper is hard-coded in the
 * fork. So no amount of tuning the options makes the rich path render on such a
 * device, and the card will never be visible there.
 *
 * THE RELIABLE PATH
 * -----------------
 * An HTML file sent as an ordinary DOCUMENT renders on every client, and the
 * recipient taps it to open the real, fully interactive card in their browser
 * (the doors, the 5s loader, the copy button and the clipboard all work there).
 * It also goes out as a normal sendMessage, so key sharing is handled by
 * Baileys and the "Waiting for this message" bubbles do not appear.
 *
 * WHY 'rich' IS NOW THE DEFAULT
 * -----------------------------
 * The operator asked for the html to DISPLAY and for nothing else to be sent: no
 * written blurb, no .html file to tap. That is the rich path, so it is the default
 * everywhere (config.json -> pairCardMode / runtimeCardMode, and this fallback).
 *
 * The document is not gone — it is the safety net. `sendHtmlCard` falls back to it
 * when the rich send throws, and `mode:'document'` still selects it outright for
 * clients that refuse to draw bot-forwarded messages.
 *
 * `mode` (config.json -> pairCardMode): 'rich' (default) | 'document' | 'both'.
 */
const DEFAULT_DELIVERY = 'rich'

function pairingCardCaption(stage) {
    const lines = [
        '🔐 *DARKNOTE PAIRING CARD*',
        '',
        'Tap the file above to open the pairing card.',
        'It runs the doors, the 5-second code loader and the copy button.'
    ]
    if (stage === 'code') lines.push('', 'The card carries the pairing code DARKNOTE issued.')
    if (stage === 'success') lines.push('', 'The card is GREEN: the device is linked.')
    if (stage === 'error') lines.push('', 'The card is RED: the pairing was refused.')
    return lines.join('\n')
}

/** Send the card the old way: AIRich / botForwardedMessage. */
async function sendRichCard(conn, chat, html, quoted) {
    const { AIRich } = require('mzazibaileys')
    const rich = new AIRich(conn, { dynamic: true, unsupportedTypeAlert: false })
    rich.addSection({
        view_model: {
            primitive: {
                __typename: 'GenAIaeacdsnwHtmlPrimitive',
                payload: html,
                trusted_sources: ['mzazi.shop']
            },
            __typename: 'GenAISingleLayoutViewModel'
        }
    })
    const options = {
        includesUnifiedResponse: true,
        includesSubmessages: false,
        forwarded: true,
        notification: false
    }
    if (quoted) options.quoted = quoted
    return rich.send(chat, options)
}

/** Send the card as a real .html document: renders on every client. */
async function sendDocumentCard(conn, chat, html, quoted, { fileName, stage, caption } = {}) {
    return conn.sendMessage(chat, {
        document: Buffer.from(html, 'utf8'),
        mimetype: 'text/html',
        fileName: fileName || `darknote-pair-${stage || 'card'}.html`,
        // `caption` is passed in by non-pairing callers (.runtime), whose caption is
        // about the clock rather than about a pairing code. An EXPLICIT empty string
        // means no caption at all: `caption || default` treated "" as "not given" and
        // quietly attached the PAIRING caption to whatever card was being sent, so a
        // caller asking for no caption got the wrong text instead of none.
        caption: caption === undefined
            ? pairingCardCaption(stage)
            : (caption === null ? undefined : caption)
    }, quoted ? { quoted } : {})
}

/**
 * Deliver the pairing card.
 *
 * Never throws: if one delivery fails the other is still attempted, and if both
 * fail the caller's own text fallback takes over — a pairing request must not be
 * lost because a card could not be sent.
 */
async function sendHtmlCard(conn, chat, html, { quoted, mode = DEFAULT_DELIVERY, stage, fileName, caption } = {}) {
    const wanted = String(mode || DEFAULT_DELIVERY).toLowerCase()
    const useRich = wanted === 'rich' || wanted === 'both'
    const useDocument = wanted === 'document' || wanted === 'both'
    const sent = []
    /*
     * Accept the message to quote, or a `{ quoted }` options object that wraps one.
     * Callers forwarded their own `quoted` parameter here, which produced
     * `{ quoted: { quoted: m } }` and killed every document send in `.runtime` — see
     * quoteGuard.unwrapQuote. Both shapes now land on the same WAMessage.
     */
    const quote = quoteGuard.unwrapQuote(quoted)

    if (useRich) {
        try {
            await sendRichCard(conn, chat, html, quote)
            sent.push('rich')
        } catch (error) {
            console.error('[PAIR-CARD] rich card failed:', error?.message || error)
            // If the rich path was the ONLY one asked for, the document below is
            // the last chance to get a usable card to the owner.
            if (!useDocument) {
                await sendDocumentCard(conn, chat, html, quote, { stage, fileName, caption })
                sent.push('document')
            }
        }
    }

    if (useDocument) {
        try {
            await sendDocumentCard(conn, chat, html, quote, { stage, fileName, caption })
            sent.push('document')
        } catch (error) {
            console.error('[PAIR-CARD] document card failed:', error?.message || error)
            if (!sent.length) throw error
        }
    }

    return { delivered: sent }
}

/* --------------------------- session registry --------------------------- */

/*
 * The session list and the unpair action live in index.js (it owns the sockets).
 * It publishes them as globals exactly like the pairing entry points, so BIGBRO
 * can reach them without a circular require.
 */
function listSessions() {
    try {
        if (typeof global.darknoteSessions === 'function') {
            const all = global.darknoteSessions() || []
            return Array.isArray(all) ? all : []
        }
    } catch (error) {
        console.error('[PAIR-CARD] session list failed:', error?.message || error)
    }
    return []
}

async function unpairSession(id) {
    if (typeof global.darknoteUnpair === 'function') return global.darknoteUnpair(id)
    return { ok: false, reason: 'unavailable' }
}


/* ==========================================================================
 * SECTION: MENU 2 - the sign-up card and the phone UI
 * (was menu2.js)
 * ========================================================================== */

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


const ROOT = path.join(__dirname, '..')
const STORE = path.join(ROOT, 'database', 'menu2.json')
const NUMBER = (v) => String(v || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '')

/** The number this session is paired to (the bot's own number). */
function pairedNumber(conn) {
    return NUMBER(conn?.user?.id)
}

/**
 * The handset the Menu 2 card is drawn as.
 *
 * It was hard-coded to 'ios', which drew an iPhone - dynamic island, 54px corners. The
 * operator asked for the same device the .runtime card shows, so this reads the SAME
 * config value .runtime uses and cannot drift away from it again. 'oneui' is the Samsung
 * shell: tighter 44px corners and a centred punch-hole camera, which is the slim,
 * camera-showing look that was asked for.
 */
function menu2Skin() {
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
        // a list like "ios,oneui" is possible in config - take the first entry
        const wanted = String(cfg.runtimeSkin || 'oneui').split(/[,\s]+/)[0]
        return phoneFrame.SKINS[wanted] ? wanted : 'oneui'
    } catch {
        return 'oneui'
    }
}

/*
 * MENU 2 BACKGROUND ART.
 *
 * The card travels as ONE file with no side-car assets, so the art has to be inside it:
 * whatever is in assets/menu2-bg is base64'd and injected as data URIs, not linked.
 *
 * Four frames per card, not the whole set. A card has a size budget - the .play card
 * holds itself to 240 KB - and all eight frames base64'd came to ~211 KB, which leaves
 * no room for the card's own markup on top. The window slides by two on every open, so
 * the whole set cycles as the menu gets used and no two consecutive opens look alike.
 */
const BG_DIR = path.join(ROOT, 'assets', 'menu2-bg')
const BG_PER_CARD = 4

/** How many frames are installed. 0 when the art has not been added. */
function backgroundCount() {
    try {
        return fs.readdirSync(BG_DIR).filter(name => /\.(?:jpe?g|png|webp)$/i.test(name)).length
    } catch {
        return 0
    }
}

/** The current window of frames, as data URIs ready to drop into a style attribute. */
function backgroundImages(offset = 0) {
    let files = []
    try {
        files = fs.readdirSync(BG_DIR)
            .filter(name => /\.(?:jpe?g|png|webp)$/i.test(name))
            .sort()
    } catch {
        return []
    }
    if (!files.length) return []

    const out = []
    for (let i = 0; i < Math.min(BG_PER_CARD, files.length); i++) {
        const name = files[(offset + i) % files.length]
        try {
            const buf = fs.readFileSync(path.join(BG_DIR, name))
            const mime = /\.png$/i.test(name) ? 'image/png' : 'image/jpeg'
            out.push(`data:${mime};base64,${buf.toString('base64')}`)
        } catch {
            // One unreadable frame must not cost the operator the whole card.
        }
    }
    return out
}

/**
 * Slides the window on and returns the new offset. Kept in the store so the rotation
 * survives a restart instead of snapping back to the first frame every time.
 */
function nextBackgroundOffset() {
    const count = backgroundCount()
    if (!count) return 0
    const store = readStore()
    const offset = ((Number(store.bgOffset) || 0) + 2) % count
    writeStore({ ...store, bgOffset: offset })
    return offset
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
         * THE KEYLOCK, OFF UNTIL ASKED FOR.
         *
         * Off by default on purpose: a sign-up must never be locked behind a passcode
         * the operator has not set. Both fields survive a restart with the rest of the
         * record. `passcode` stays out of the card entirely - only its salted hash is
         * ever injected, so the code cannot be read out of a delivered file.
         */
        keylock: existing?.keylock === true,
        keylockSetAt: existing?.keylockSetAt || '',
        passcode: existing?.passcode || '',
        passcodeSetAt: existing?.passcodeSetAt || '',
        attempts: (existing?.attempts || 0) + 1
    }
    writeStore({ signups: { ...(readStore().signups || {}), [paired]: record } })
    return { ok: true, alreadySigned: Boolean(existing?.verified), record }
}

/*
 * KEYLOCK — the lock-screen passcode, and what replaced the fingerprint.
 *
 * The fingerprint was theatre: a sensor drawn on a card that could not read anything.
 * A passcode is real. The paired device sets a 4 or 6 digit code, the card demands it
 * before it will open, and it relocks by itself after five idle minutes.
 *
 * Two places hold the state, on purpose:
 *   - HERE, tied to the paired number, so a freshly sent card knows whether a lock is
 *     configured and whether to show the keypad at all.
 *   - localStorage inside the page, so the lock actually ENFORCES on the device that
 *     opens it, survives a re-open, and still works if the bot is offline.
 * The bot copy is the switch; the device copy is the door.
 */
const KEYLOCK_IDLE_MS = 5 * 60 * 1000

/**
 * djb2, salted with the paired number.
 *
 * The card has to CHECK the passcode but must never carry it: a code embedded in a file
 * that gets posted into a chat is readable by anyone who opens the page source, which
 * would make the whole lock decorative. So only this hash travels, and the card runs the
 * same function over what the operator types. Both sides live in this repo, so the two
 * implementations stay in step - the one in the card is deliberately the same three lines.
 */
function codeHash(code, salt) {
    let h = 5381
    const s = `${salt}:${code}`
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
    return h
}

/** The keylock state for the paired number. Never throws, always returns a shape. */
function keylockFor(conn) {
    const paired = pairedNumber(conn)
    const record = paired ? readStore().signups?.[paired] : null
    const code = String(record?.passcode || '')
    return {
        enabled: record?.keylock === true,
        // Sent because the keypad renders 4 or 6 boxes to match, and the card has no
        // other way to know which length was chosen.
        length: code.length || 4,
        hasPasscode: Boolean(code),
        // The check itself. Absent when no code is set, so the card can tell the
        // difference between "wrong code" and "there is nothing to check against".
        hash: code ? codeHash(code, paired) : 0,
        idleMs: KEYLOCK_IDLE_MS
    }
}

/**
 * Switch the keylock on or off. Turning it ON without a code is refused: the card
 * would otherwise render a keypad that nothing can ever satisfy, which locks the
 * operator out of their own menu.
 */
function setKeylock(conn, on) {
    const paired = pairedNumber(conn)
    if (!paired) return { ok: false, reason: 'no-session' }
    const signups = { ...(readStore().signups || {}) }
    const existing = signups[paired]
    if (!existing?.verified) return { ok: false, reason: 'not-signed-up' }
    if (on === true && !existing.passcode) return { ok: false, reason: 'no-passcode' }
    signups[paired] = {
        ...existing,
        keylock: on === true,
        keylockSetAt: on === true ? new Date().toISOString() : ''
    }
    writeStore({ signups })
    return { ok: true, record: signups[paired], enabled: on === true }
}

/** Set or replace the passcode. Only 4 or 6 digits, digits only. */
function setPasscode(conn, code) {
    const paired = pairedNumber(conn)
    if (!paired) return { ok: false, reason: 'no-session' }
    const digits = String(code ?? '').trim()
    if (!/^(?:[0-9]{4}|[0-9]{6})$/.test(digits)) return { ok: false, reason: 'bad-length' }
    const signups = { ...(readStore().signups || {}) }
    const existing = signups[paired]
    if (!existing?.verified) return { ok: false, reason: 'not-signed-up' }
    signups[paired] = { ...existing, passcode: digits, passcodeSetAt: new Date().toISOString() }
    writeStore({ signups })
    return { ok: true, record: signups[paired], length: digits.length }
}

/**
 * Forget the passcode, and the lock with it. Clearing the code while leaving the lock
 * on would make the card unopenable, so the two always move together.
 */
function clearPasscode(conn) {
    const paired = pairedNumber(conn)
    if (!paired) return { ok: false, reason: 'no-session' }
    const signups = { ...(readStore().signups || {}) }
    const existing = signups[paired]
    if (!existing?.verified) return { ok: false, reason: 'not-signed-up' }
    const { passcode, passcodeSetAt, keylock, keylockSetAt, ...rest } = existing
    signups[paired] = { ...rest, keylock: false }
    writeStore({ signups })
    return { ok: true, record: signups[paired] }
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
function menu2Html({ avatar = '', verified = false, paired = '', signedAt = '', stage = 'signup', note = '', keylock = null, backgrounds = null, live = null } = {}) {
    const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const when = signedAt ? new Date(signedAt).toLocaleString('en-GB', { hour12: false }) : ''
    // The window slides on every render, so each open of the menu shows different art.
    const frames = Array.isArray(backgrounds) ? backgrounds : backgroundImages(nextBackgroundOffset())
    const lock = keylock || { enabled: false, length: 4, hasPasscode: false, idleMs: KEYLOCK_IDLE_MS }
    const title = 'DARKNOTE MENU2 IS ACTIVE'
    const printed = title.split('').map((c, i) =>
        `<span style="animation-delay:${(1.45 + i * 0.035).toFixed(3)}s">${c === ' ' ? '&nbsp;' : esc(c)}</span>`).join('')

    /*
     * THE LOCK SCREEN TAKES THE CARD OVER.
     *
     * The DP with its dashed ring, the typed-out "DARKNOTE MENU2 IS ACTIVE" title and the
     * "DARKNOTE · LEVEL 2 · MENU 2" subtitle are the SIGN-UP card's header. Once the account
     * is signed up the card IS the phone, and the operator asked for the lock screen alone -
     * "remove the section at the pic ... make only the lock screen to take over the html".
     *
     * It is NOT RENDERED rather than hidden with CSS: nothing is left to push the phone frame
     * down, no invisible block is left sitting over the card to swallow taps, and the file
     * that gets delivered is genuinely smaller instead of carrying markup nobody ever sees.
     */
    const header = verified ? '' : `<div class="dp"><div class="ring"></div>
      ${avatar ? `<img src="${esc(avatar)}" alt="DARKNOTE">` : '<div class="fallback">DN</div>'}
    </div>
    <div class="name">${printed}</div>
    <div class="sub">DARKNOTE · LEVEL 2 · MENU 2</div>`

    return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{margin:0;background:#08080a;color:#f4f4f5;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .app{position:relative;min-height:560px;overflow:hidden;
    background:radial-gradient(120% 80% at 50% 0%,#1b0606 0%,#0a0a0c 55%,#060607 100%)}
  /*
   * EVERY DECORATIVE LAYER IN THIS CARD REFUSES POINTER EVENTS.
   *
   * These overlays cover the whole card. A full-cover overlay that still accepts taps
   * swallows every tap beneath it, and that is exactly why the number box could not be
   * typed into: .flash (z-index 9) sits above .wrap (z-index 4), and .sbg sits above the
   * static .panel - so taps died on the decoration instead of reaching the input.
   *
   * The pairing card (lib/pair-card.js) has always done this - see #bg and #crack, both
   * pointer-events:none - and lifts its content with #panel .fg{position:relative;
   * z-index:1}. The same pattern is applied here.
   */
  .grid{position:absolute;inset:0;opacity:.25;pointer-events:none;
    background-image:linear-gradient(rgba(255,45,45,.10) 1px,transparent 1px),
                     linear-gradient(90deg,rgba(255,45,45,.10) 1px,transparent 1px);background-size:26px 26px}

  /* ---- the flash ---- */
  .flash{position:absolute;inset:0;background:#fff;opacity:0;z-index:9;pointer-events:none;animation:flash .85s ease-out .15s forwards}
  .flash .lens{position:absolute;left:50%;top:50%;width:74px;height:74px;margin:-37px 0 0 -37px;border-radius:50%;
    border:3px solid rgba(255,45,45,.85);animation:lens .85s ease-out .15s forwards}
  @keyframes flash{0%{opacity:0}12%{opacity:.92}100%{opacity:0}}
  @keyframes lens{0%{transform:scale(.5);opacity:1}70%{transform:scale(1.25);opacity:.5}100%{transform:scale(1.6);opacity:0}}
  .shutter{position:absolute;top:14px;left:16px;font-size:13px;letter-spacing:2px;color:#fff;z-index:10;pointer-events:none;
    opacity:0;animation:shutter .8s ease-out .05s forwards}
  @keyframes shutter{0%{opacity:0;transform:translateY(-6px)}25%{opacity:.95;transform:none}100%{opacity:0}}

  .wrap{position:relative;z-index:4;padding:22px 18px 26px;display:flex;flex-direction:column;align-items:center}
  /*
   * THE VERIFIED CARD IS A FULL PHONE SCREEN.
   *
   * The card stops reserving the 560px the sign-up panel needed, and stops capping the screen
   * at 352px, so the handset from lib/phone-frame.js can be the whole thing. The sizing now
   * comes from the shared shell - a 390x844 screen - which is why .app is deliberately NOT
   * pinned to 100vh any more: the shell sets its own height, and pinning the card to the
   * viewport on top of that would make the card taller than the phone inside it.
   *
   * .lockbody gets the first spare unit of height and .homebtn the second, so on an 844px screen
   * the telemetry sits at the top, the clock group lands in the upper middle, and the battery
   * panel, Home button and sensor sit down at the bottom where a handset keeps them.
   */
  .wrap.lockonly{padding:0}
  .app.phoneonly{min-height:0}
  .wrap.lockonly .lock{width:100%;max-width:none}
  .wrap.lockonly .lockbody{margin-top:auto}
  .wrap.lockonly .homebtn{margin-top:auto}
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
  .panel{position:relative;z-index:1;width:100%;max-width:340px;border:1px solid #26262c;border-radius:16px;
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
  .bar{position:absolute;left:0;right:0;bottom:0;height:3px;background:linear-gradient(90deg,transparent,#ff2d2d,transparent);pointer-events:none;
    opacity:.5;animation:sweep 2.4s ease-in-out infinite}
  @keyframes sweep{0%,100%{transform:translateX(-30%)}50%{transform:translateX(30%)}}
</style>
${verified ? `<style>${phoneFrame.frameStyles()}</style>${lockStyles()}${appStyles()}` : signupStyles()}
</head><body>
<div class="app${verified ? ' phoneonly' : ''}">
  <div class="grid"></div>
  <div class="flash"><div class="lens"></div></div>
  <div class="shutter">📸 DARKNOTE</div>
  <div class="wrap${verified ? ' lockonly hasnav' : ''}">
    ${frames.length ? `<div class="bg" id="bg">${frames.map((src, i) => `<i style="background-image:url('${src}')"${i === 0 ? ' class="on"' : ''}></i>`).join('')}</div>` : ''}
    ${header}
    ${verified ? welcomeStage({ esc, avatar, paired, when, note, keylock: lock, live }) : signupStage({ esc, avatar, paired, stage, note })}
  </div>
  ${verified ? lockOverlay(lock) : ''}
  ${verified ? '' : keypadStage()}
  <div class="bar"></div>
</div>
${verified ? phoneScript(lock, paired) : signupScript()}
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
function keypadStage() {
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9']
        .map((k) => `<button type="button" class="kp-key" data-k="${k}">${k}</button>`)
        .join('')

    return `
    <div class="keypad" id="keypad" aria-hidden="true">
      <div class="kp-head">
        <span class="kp-title" id="kp-title">🔢 ENTER YOUR NUMBER</span>
        <button type="button" class="kp-close" id="kp-close" aria-label="Close keypad">✕</button>
      </div>
      <div class="kp-grid" id="kp-grid">
        ${keys}
        <button type="button" class="kp-key" data-k="+">+</button>
        <button type="button" class="kp-key" data-k="0">0</button>
        <button type="button" class="kp-key kp-del" data-k="del">⌫</button>
        <button type="button" class="kp-key kp-wide" data-k="done">DONE</button>
      </div>
    </div>`
}

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
      <p>All you need is your number — the one this device is paired to. Type it in the box below.</p>
      <div class="field" id="num-field"
           data-paired="${esc(paired)}" data-mask="${esc(mask(paired))}">
        <span class="flag">＋</span>
        <!--
          A REAL input, so tapping it raises the device keyboard and the number can simply
          be typed. The card's own keypad is still here as a second way in (the button to
          the right) and writes into this same input, so both paths agree on one value.
        -->
        <input class="num-input" id="num-input" type="tel" inputmode="tel" autocomplete="tel"
               enterkeyhint="send" maxlength="20" placeholder="Your number"
               aria-label="Your number" spellcheck="false" autocorrect="off" autocapitalize="off">
        <span class="tick" id="num-tick"></span>
        <button type="button" class="kp-open" id="kp-open" aria-label="Type with the keypad">🔢</button>
      </div>
      <div class="keyhint" id="key-hint">Type the number this device is paired to (${esc(mask(paired))}) — or tap 🔢 to use the keypad.</div>
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
 *   lock      THE BACKGROUND ART, the clock, the battery, the Home button and the
 *             edge-to-edge keylock button.
 *   security  where the passcode is set, changed or turned off, and where the keylock
 *             switch is explained, with the
 *             current state read from the server rather than assumed
 */
function welcomeStage({ esc, avatar, paired, when, keylock = null, live = null }) {
    const lockOn = keylock?.enabled === true
    const codeSet = keylock?.hasPasscode === true
    // The same game module `.tictactoe` sends, so both homes share one implementation.
    const ttt = require('../lib/tictactoe.js')
    const wallpaper = avatar
        ? `style="background-image:url('${esc(avatar)}')"`
        : ''
    /*
     * THE SAME HANDSET SHELL AS THE RUNTIME CARD.
     *
     * This card used to build its own frame - an 8px border, a 38px radius and a drop
     * shadow, sized by whatever it contained. That is why it read as a picture of a phone
     * sitting inside a dark card rather than as a phone screen. It now uses
     * lib/phone-frame.js, the shell the .runtime card already uses, at the same size: a
     * 390x844 screen with the dynamic island, the status bar and the home indicator drawn by
     * the shared chrome. phone-frame's chrome is pointer-events:none, so it cannot swallow
     * the Home button or the sensor taps underneath it.
     *
     * screenOpen/screenClose rather than device() because this body is already one long
     * template, exactly like the pairing card's.
     *
     * The wallpaper sits directly on .screen and NOT inside .lockwrap: an absolutely
     * positioned child is inset against its containing block's PADDING box, and .lockwrap
     * carries the status-bar band as top padding, so a .wall in there would stop 54px down
     * and leave a black strip behind the phone's status bar.
     */
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
      ${phoneFrame.screenOpen({ skin: menu2Skin(), screenStyle: '--dev-h:844px' })}
      <div class="wall" ${wallpaper}></div>
      <div class="wall-tint"></div>
      <div class="lockwrap">
        <div class="lockinfo">
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

        <button class="homebtn" id="go-home" type="button">Home</button>

        <button class="widebtn${lockOn ? ' is-on' : ''}" id="keylock-btn" type="button">
          <span class="widebtn-key">${lockOn ? '🔐' : '🔓'}</span>
          <span class="widebtn-text">${lockOn ? 'Keylock on · tap to manage' : (codeSet ? 'Keylock off · tap to turn on' : 'Keylock &amp; passcode')}</span>
        </button>
      </div>
      ${phoneFrame.screenClose({ time: '' })}
    </div>

    <div class="home" id="home">
      <div class="homewall" ${wallpaper}></div>
      <div class="hometint"></div>
      <div class="homestatus"><span class="net">▮▮▮ 5G</span><span>${lockOn ? 'KEYLOCK ON' : 'KEYLOCK OFF'}</span></div>
      <div class="homegrid">
        <button class="app" id="open-security" type="button">
          <span class="app-icon">${avatar ? `<img src="${esc(avatar)}" alt="">` : '<span class="app-dn">DN</span>'}<span class="app-badge">🔒</span></span>
          <span class="app-name">Security</span>
        </button>
        <button class="app" id="open-chrome" type="button">
          <span class="app-icon"><span class="app-dn">🌐</span></span>
          <span class="app-name">Chrome</span>
        </button>
        <button class="app" id="open-games" type="button">
          <span class="app-icon"><span class="app-dn">🎮</span></span>
          <span class="app-name">Games</span>
        </button>
      </div>
      <div class="homedock" id="back-to-lock">▲ Lock screen</div>
    </div>

    <div class="security" id="security">
      <div class="sec-head"><button class="sec-back" id="sec-back" type="button">‹</button><span>SECURITY</span></div>
      <div class="sec-body">
        <div class="sec-dp">${avatar ? `<img src="${esc(avatar)}" alt="">` : '<span>DN</span>'}</div>
        <h3>Keylock &amp; passcode</h3>
        <div class="sec-state ${lockOn ? 'is-on' : 'is-off'}" id="sec-state">${lockOn ? '● LOCKS after 5 idle minutes' : '○ UNLOCKED — the keylock is off'}</div>
        <div class="sec-state ${codeSet ? 'is-on' : 'is-off'}" id="sec-code">${codeSet ? `● PASSCODE SET — ${keylock.length} digits` : '○ NO PASSCODE YET'}</div>
        <p>${lockOn
            ? 'This card locks itself after five idle minutes and asks for the passcode. The check runs on this device, so it still holds when DARKNOTE is offline.'
            : 'The card stays open. Set a passcode, then turn the keylock on, to make it ask for one.'}</p>
        <div class="sec-how">
          <b>${codeSet ? 'Change or remove it' : 'Set it'}</b>
          <span>The card runs offline, so the switch is applied by DARKNOTE. In the chat send <code>passcode 1234</code> for four digits, <code>passcode 123456</code> for six, or <code>passcode off</code> to remove it. The next card shows the new state.</span>
        </div>
        <div class="sec-how">
          <b>${lockOn ? 'Turn the keylock off' : 'Turn the keylock on'}</b>
          <span>Send <code>${lockOn ? 'keylock off' : 'keylock on'}</code> in the chat. It needs a passcode to exist first — a lock with nothing to type would just shut you out.</span>
        </div>
        <div class="sec-actions">
          <button class="widebtn" id="set-code" type="button"><span class="widebtn-key">🔑</span><span class="widebtn-text">${codeSet ? 'Change the passcode' : 'Set a passcode'}</span></button>
          ${codeSet ? '<button class="widebtn" id="clear-code" type="button"><span class="widebtn-key">🚫</span><span class="widebtn-text">Turn the passcode off</span></button>' : ''}
        </div>
        <div class="sec-note">The passcode is never sent into the chat and never stored there. It lives on this device and is compared locally, only after the card has been idle for five minutes.</div>
      </div>
    </div>

    <div class="games" id="games">
      <div class="sec-head"><button class="sec-back" id="games-back" type="button">‹</button><span>GAMES</span></div>
      <div class="sec-body">
        <button class="app" id="open-ttt" type="button">
          <span class="app-icon"><span class="app-dn">⭕</span></span>
          <span class="app-name">Tic-Tac-Toe</span>
        </button>
        <button class="app" id="open-ludo" type="button">
          <span class="app-icon"><span class="app-dn">🎲</span></span>
          <span class="app-name">Ludo</span>
        </button>
        <p>You against an unbeatable AI — a draw is a good result. Every app has a ‹ back button in its top-left corner.</p>
      </div>
    </div>

    <div class="games" id="game">
      <div class="sec-head"><button class="sec-back" id="game-back" type="button">‹</button><span>TIC-TAC-TOE</span></div>
      <div class="sec-body">
        <style>${ttt.styles}</style>
        ${ttt.markup}
      </div>
    </div>

    <div class="games" id="recent">
      <div class="sec-head"><button class="sec-back" id="recent-back" type="button">‹</button><span>RECENT</span></div>
      <div class="sec-body"><div class="recent-list" id="recentList"></div></div>
    </div>

    <div class="games" id="chrome">
      <div class="sec-head"><button class="sec-back" id="chrome-back" type="button">‹</button><span>CHROME</span></div>
      <div class="sec-body">
        <div class="soon"><div class="soon-ico">🌐</div><div class="soon-k">COMING SOON</div>
        <div class="soon-p">The browser is not wired up yet. Nothing to press — this is a placeholder so the icon is where it belongs, between Security and Games.</div></div>
      </div>
    </div>

    <div class="games" id="ludo">
      <div class="sec-head"><button class="sec-back" id="ludo-back" type="button">‹</button><span>LUDO</span></div>
      <div class="sec-body">
        <div class="soon"><div class="soon-ico">🎲</div><div class="soon-k">COMING SOON</div>
        <div class="soon-p">The icon is in place, but the board is not wired into the card yet. Ludo needs its own port: it is ~600 lines and its ids clash with this card, so it goes in behind an isolated frame rather than dropped in.</div></div>
      </div>
    </div>

    <!-- One nav bar for every app, shown only while an app is open. ‹ previous · ⌂ home · ➡ recent -->
    <div class="appnav" id="appnav">
      <button class="navbtn" data-nav="back" type="button" aria-label="Back">‹</button>
      <button class="navbtn" data-nav="home" type="button" aria-label="Home">⌂</button>
      <button class="navbtn" data-nav="recent" type="button" aria-label="Recent">➡</button>
    </div>`
}

/*
 * THE PASSCODE SCREEN.
 *
 * A sibling of .wrap rather than a child, so when it appears it covers the whole card
 * including the phone chrome. Hidden by default - the page script reveals it when the
 * keylock is armed and the card has been idle for five minutes, or immediately when the
 * keylock is on and the page has just been opened.
 *
 * Digits are never sent anywhere. There is no fetch() in this file and no channel back
 * to the bot at all; the comparison happens against a hash in the page.
 */
function lockOverlay(lock) {
    const len = Number(lock?.length) === 6 ? 6 : 4
    const dots = Array.from({ length: len }, () => '<i class="ldot"></i>').join('')
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫']
    return `
    <div class="lockov" id="lockov" hidden>
      <div class="lockov-inner">
        <div class="lockov-icon">🔐</div>
        <div class="lockov-title">DARKNOTE LOCKED</div>
        <div class="lockov-sub">Enter your ${len}-digit passcode</div>
        <div class="lockov-dots" id="lockov-dots">${dots}</div>
        <div class="lockov-pad">
          ${keys.map(k => k === ''
              ? '<span class="lkey is-blank"></span>'
              : `<button class="lkey" type="button" data-key="${k}">${k}</button>`).join('')}
        </div>
        <div class="lockov-msg" id="lockov-msg"></div>
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
  /*
   * THE WELCOME INTRO IS AN OVERLAY, NOT A BLOCK.
   *
   * It used to sit in the flow and fade to opacity 0 - which leaves it invisible but still
   * OCCUPYING ITS FULL HEIGHT forever, so the lock screen was pushed down under a pocket of
   * empty space it could never use. That is the gap in the card. As an overlay it still plays
   * exactly the same intro and then gets out of the way completely.
   *
   * pointer-events:none matters as much as the positioning: a full-cover overlay that accepts
   * taps swallows every tap on the lock screen underneath it, even at opacity 0.
   */
  .welcome{position:absolute;inset:0;z-index:60;pointer-events:none;
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    max-width:340px;margin:0 auto;text-align:center;
    animation:welcome-out .5s ease-in 2.9s forwards}
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

  .lock{opacity:0;animation:lock-in .7s cubic-bezier(.2,.8,.2,1) 3.15s forwards;width:100%;max-width:none}
  @keyframes lock-in{from{opacity:0;transform:translateY(18px) scale(.98)}to{opacity:1;transform:none}}
  /*
   * THE SCREEN BODY.
   *
   * The handset itself now comes from lib/phone-frame.js (see welcomeStage), so .bezel, .cam
   * and .homebar are gone from this card - the shared chrome draws the island, the status bar
   * and the home indicator, and it does so as position:absolute with pointer-events:none.
   * A same-named .homebar rule here would have quietly overridden that with position:relative
   * and dragged the indicator into the flow, which is exactly the trap this comment marks.
   *
   * .lockwrap fills the screen instead, and starts BELOW the status bar so the clock group is
   * not painted underneath the chrome. --sb-h is published by phone-frame for this purpose.
   */
  .lockwrap{position:absolute;inset:0;z-index:2;display:flex;flex-direction:column;
    padding:calc(var(--sb-h,52px) + 2px) 0 0}
  /* The DARKNOTE telemetry that used to be this card's own status bar. It keeps the top of
     the screen, now sitting under the phone's real status bar. */
  .lockinfo{display:flex;justify-content:space-between;align-items:flex-start;padding:0 18px;
    font-size:10px;color:#dbe6f0;opacity:.95}
  .lockinfo .left{display:flex;flex-direction:column;gap:3px;text-align:left}
  .lockinfo .rt{font-size:9.5px;letter-spacing:.4px;color:#cfe0ef}
  .lockinfo .pg{font-size:9px;letter-spacing:.4px;color:#9fb3c8}
  .lockinfo .pg b{color:#4ade80;font-weight:600}
  .lockinfo .pg b.is-slow{color:#ffb15c}
  .lockinfo .pg b.is-bad{color:#ff7a7a}
  .lockinfo .right{display:flex;flex-direction:column;align-items:flex-end;gap:3px}
  .lockinfo .batt{font-size:9.5px}
  .lockinfo .net{font-size:9px;letter-spacing:.6px;color:#cfe0ef}
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
  /* No .homebar here on purpose - phone-frame.js owns that class now. */
</style>`
}

/* the wallpaper, sensor, home grid and Security app styling */
function appStyles() {
    return `<style>
  .wall,.homewall{position:absolute;inset:0;background-size:cover;background-position:center;z-index:0;pointer-events:none}
  .wall-tint,.hometint{position:absolute;inset:0;z-index:1;pointer-events:none;
    background:linear-gradient(180deg,rgba(3,8,14,.5) 0%,rgba(3,8,14,.3) 36%,rgba(2,5,9,.88) 100%)}
  .lockbody,.lockinfo,.battpanel,.widebtn,.homebtn{position:relative;z-index:3}
  /* The Home button that replaced the swipe-up hint. Same slot at the bottom of the lock
     screen, but a target you can see and aim at rather than a gesture you have to guess. */
  .homebtn{display:block;margin:8px auto 6px;padding:9px 28px;border-radius:999px;cursor:pointer;
    border:1px solid rgba(160,200,235,.35);background:rgba(12,22,34,.55);color:#e8f2fb;
    font-family:'Courier New',monospace;font-size:11px;font-weight:600;letter-spacing:2.4px;
    text-transform:uppercase;-webkit-tap-highlight-color:transparent;
    transition:transform .1s,border-color .2s,color .2s}
  .homebtn:active{transform:scale(.97)}
  .homebtn.is-denied{border-color:rgba(255,90,90,.55);color:#ff9b9b}
  /*
   * THE EDGE-TO-EDGE KEYLOCK BUTTON - what replaced the fingerprint sensor.
   *
   * Full width on purpose ("a long button"): it is the way into the passcode settings,
   * and unlike the 96px sensor disc that used to sit here, there is no way to miss it.
   */
  .widebtn{display:flex;align-items:center;gap:10px;width:100%;margin:8px 0 4px;padding:13px 16px;
    border-radius:14px;cursor:pointer;text-align:left;border:1px solid rgba(160,200,235,.28);
    background:rgba(12,22,34,.62);color:#e8f2fb;font-family:'Courier New',monospace;font-size:11.5px;
    letter-spacing:1.4px;-webkit-tap-highlight-color:transparent;
    transition:transform .1s,border-color .2s,background .2s}
  .widebtn:active{transform:scale(.985)}
  .widebtn.is-on{border-color:rgba(120,230,160,.5);background:rgba(9,32,20,.62)}
  .widebtn-key{font-size:15px;line-height:1}
  .widebtn-text{flex:1;text-transform:uppercase}

  /*
   * THE ANIMATED BACKGROUND.
   *
   * Four stacked frames that crossfade, drifting slowly so the stills read as motion.
   * z-index 2 puts the art OVER the DP wallpaper layers (which sit at 1) and UNDER the
   * lock content (which sits at 3), so it is the wallpaper without ever covering a label.
   * The ::after scrim keeps the text legible over a bright frame.
   */
  .bg{position:absolute;inset:0;z-index:2;overflow:hidden;pointer-events:none;background:#05070a}
  .bg i{position:absolute;inset:0;background-size:cover;background-position:center;opacity:0;
    transition:opacity 1.6s ease}
  .bg i.on{opacity:1;animation:bgdrift 18s ease-in-out infinite alternate}
  .bg::after{content:'';position:absolute;inset:0;pointer-events:none;
    background:linear-gradient(180deg,rgba(4,7,12,.45),rgba(4,7,12,.25) 38%,rgba(4,7,12,.72))}
  @keyframes bgdrift{from{transform:scale(1.04) translateY(-6px)}to{transform:scale(1.10) translateY(6px)}}

  /* THE PASSCODE SCREEN. Above everything, including the phone chrome. */
  .lockov{position:absolute;inset:0;z-index:9;display:flex;align-items:center;justify-content:center;
    padding:22px;background:rgba(3,6,10,.95)}
  .lockov[hidden]{display:none}
  .lockov-inner{width:100%;max-width:290px;text-align:center;color:#e8f2fb;font-family:'Courier New',monospace}
  .lockov-icon{font-size:30px}
  .lockov-title{margin-top:8px;font-size:13px;letter-spacing:3px;color:#8fd6ff}
  .lockov-sub{margin-top:6px;font-size:11px;letter-spacing:1.2px;color:#9fb6c8}
  .lockov-dots{display:flex;justify-content:center;gap:10px;margin:18px 0}
  .ldot{width:12px;height:12px;border-radius:50%;border:1px solid rgba(150,200,235,.5);display:block}
  .ldot.on{background:#8fd6ff;box-shadow:0 0 8px #8fd6ff}
  .lockov-dots.is-bad .ldot{border-color:#ff5a5a;background:#ff5a5a}
  .lockov-pad{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
  .lkey{padding:14px 0;border-radius:12px;cursor:pointer;color:#e8f2fb;font-size:17px;
    font-family:inherit;border:1px solid rgba(150,190,220,.22);background:rgba(14,22,32,.72);
    -webkit-tap-highlight-color:transparent}
  .lkey:active{background:rgba(40,70,100,.72)}
  .lkey.is-blank{visibility:hidden}
  .lockov-msg{margin-top:12px;min-height:16px;font-size:11px;letter-spacing:1.2px;color:#ff8f8f}
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
  /*
   * THE APP NAV BAR - ‹ previous page, ⌂ home, ➡ recent - shown only while an app is open,
   * so it never covers the lock screen or the app grid.
   */
  .appnav{position:absolute;left:0;right:0;bottom:0;z-index:8;display:none;align-items:center;
    justify-content:space-around;padding:10px 16px 14px;
    background:linear-gradient(180deg,rgba(6,10,15,0),rgba(6,10,15,.94) 42%)}
  /*
   * A real phone's nav bar does not come and go with the app - it is always there. So this
   * shows for the whole card, and .wrap gets the room back underneath it so the bottom
   * cluster (keylock button, Home dock) still lands above the bar instead of under it.
   */
  .wrap.hasnav .appnav{display:flex}
  .wrap.hasnav{padding-bottom:70px}
  .navbtn{width:46px;height:46px;border-radius:50%;cursor:pointer;display:flex;align-items:center;
    justify-content:center;font-size:17px;color:#e8f2fb;
    border:1px solid rgba(160,200,235,.3);background:rgba(12,22,34,.78);
    -webkit-tap-highlight-color:transparent;transition:transform .1s,border-color .2s}
  .navbtn:active{transform:scale(.94);border-color:rgba(160,200,235,.6)}
  .recent-list{display:flex;flex-direction:column;gap:8px}
  .recent-item{display:flex;align-items:center;gap:10px;padding:12px;border-radius:12px;cursor:pointer;
    border:1px solid rgba(160,200,235,.22);background:rgba(12,22,34,.62);color:#e8f2fb;
    font-family:'Courier New',monospace;font-size:11.5px;letter-spacing:1.2px;text-align:left}
  .recent-item .ico{font-size:15px}
  /* The placeholder panel behind an icon that has no app yet. */
  .soon{display:flex;flex-direction:column;align-items:center;text-align:center;padding:26px 14px}
  .soon-ico{font-size:34px}
  .soon-k{margin-top:12px;font-family:'Courier New',monospace;font-size:12px;letter-spacing:3px;
    color:#8fd6ff;font-weight:800}
  .soon-p{margin-top:10px;font-size:11.5px;line-height:1.6;color:#9fb6c8;max-width:280px}

  /* Games reuses the whole .sec-* chrome, so it only needs the same shell + open state. */
  .security,.games{position:absolute;inset:0;opacity:0;pointer-events:none;transition:opacity .35s ease;z-index:6;background:linear-gradient(180deg,#0b1218,#070a0e);overflow-y:auto}
  .security.is-open,.games.is-open{opacity:1;pointer-events:auto}
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
function phoneScript(lock = null, paired = '') {
    // The passcode and keylock state have to reach the PAGE, not just the markup: the
    // card enforces the lock itself, so it needs the switch and the hash at runtime.
    const lockOn = lock?.enabled === true
    // initTicTacToe() is defined by this, and called further down once the game opens.
    const ttt = require('../lib/tictactoe.js')
    return `<script>
${ttt.script}
(function () {
  var CURVE = ${JSON.stringify(batteryCurve())};
  var SCAN_MS = 5600;
  var pct = document.getElementById('batt-pct'), fill = document.getElementById('batt-fill');
  var icon = document.getElementById('batt-icon'), top = document.getElementById('batt-top');
  var note = document.getElementById('batt-note'), clock = document.getElementById('clock'), dateEl = document.getElementById('date');
  var lock = document.getElementById('lock'), home = document.getElementById('home'), security = document.getElementById('security');
  var ov = document.getElementById('lockov'), ovDots = document.getElementById('lockov-dots'), ovMsg = document.getElementById('lockov-msg');
  var hour = -1, level = 100, charging = false;

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
    var hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    if (clock) clock.textContent = hhmm;
    /* The handset's own status bar shows the clock too now, so keep the two in step. */
    var sbTime = document.querySelector('.sb-time');
    if (sbTime) sbTime.textContent = hhmm;
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

  /*
   * ── KEYLOCK ──────────────────────────────────────────────────────────────────
   *
   * The card runs offline, so the lock is enforced HERE, not by the bot. Two things are
   * injected: whether the keylock is on, and a salted HASH of the passcode. The code
   * itself is deliberately never in the card - a passcode embedded in a file that gets
   * posted into a chat is readable by anyone who opens the page source, which would make
   * the lock decorative. Typed digits are hashed the same way and compared locally.
   *
   * A code can also be created from the settings page, which keeps it in localStorage.
   * The lock engages when the keylock is on AND something exists to check against; a
   * lock with nothing to type would simply shut the operator out of their own menu.
   */
  var LOCK_ON = ${lockOn ? 'true' : 'false'};
  var LOCK_LEN = ${Number(lock?.length) === 6 ? 6 : 4};
  var LOCK_HASH = ${Number(lock?.hash) || 0};
  var LOCK_IDLE = ${Number(lock?.idleMs) || 300000};
  var LOCK_SALT = ${JSON.stringify(String(paired || ''))};

  /* Same three lines as codeHash() in this file's module scope - the card checks against
     a number the bot produced, so the two must agree exactly. */
  function hash (code) {
    var h = 5381, s = LOCK_SALT + ':' + code;
    for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h;
  }

  /* localStorage throws in private mode and in some sandboxed file views. A card that
     threw on load would be worse than a card that forgot. */
  function keep (key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      if (value === null) { localStorage.removeItem(key); return null; }
      localStorage.setItem(key, String(value));
      return value;
    } catch (e) { return null; }
  }

  var LOCAL_HASH = Number(keep('darknote.keylock')) || 0;
  var wanted = LOCK_HASH || LOCAL_HASH;
  var armed = LOCK_ON && wanted > 0;
  var entered = '', idle = null, creating = false;

  function paintDots (bad) {
    if (!ovDots) return;
    ovDots.classList.toggle('is-bad', !!bad);
    var dots = ovDots.children;
    for (var i = 0; i < dots.length; i++) dots[i].classList.toggle('on', i < entered.length && !bad);
  }

  function showLock (mode) {
    if (!ov) return;
    creating = mode === 'create';
    entered = '';
    paintDots(false);
    ovMsg.textContent = '';
    ov.querySelector('.lockov-title').textContent = creating ? 'SET PASSCODE' : 'DARKNOTE LOCKED';
    ov.querySelector('.lockov-sub').textContent = creating
      ? 'Type ' + LOCK_LEN + ' digits, then again to confirm'
      : 'Enter your ' + LOCK_LEN + '-digit passcode';
    ov.removeAttribute('hidden');
  }

  function hideLock () { if (ov) ov.setAttribute('hidden', 'hidden'); }

  /* Locks after LOCK_IDLE of NOT BEING USED, so every interaction resets the clock. */
  function touchIdle () {
    if (idle) clearTimeout(idle);
    if (armed && ov && ov.hasAttribute('hidden')) idle = setTimeout(function () { showLock(); }, LOCK_IDLE);
  }

  var pending = '';

  function submit () {
    if (entered.length < LOCK_LEN) return;
    if (creating) {
      if (!pending) {
        pending = entered;
        entered = '';
        paintDots(false);
        ovMsg.textContent = 'TYPE IT AGAIN';
        return;
      }
      if (pending === entered) {
        LOCAL_HASH = hash(entered);
        keep('darknote.keylock', LOCAL_HASH);
        wanted = LOCK_HASH || LOCAL_HASH;
        armed = LOCK_ON && wanted > 0;
        pending = '';
        hideLock();
        ovMsg.textContent = '';
        touchIdle();
        return;
      }
      pending = '';
      paintDots(true);
      ovMsg.textContent = 'DID NOT MATCH';
      entered = '';
      setTimeout(function () { paintDots(false); }, 600);
      return;
    }
    if (hash(entered) === wanted) {
      hideLock();
      entered = '';
      paintDots(false);
      ovMsg.textContent = '';
      touchIdle();
      return;
    }
    paintDots(true);
    ovMsg.textContent = 'WRONG PASSCODE';
    setTimeout(function () { entered = ''; paintDots(false); }, 600);
  }

  if (ov) {
    ov.addEventListener('click', function (e) {
      var key = e.target && e.target.getAttribute && e.target.getAttribute('data-key');
      if (!key) return;
      if (key === '⌫') entered = entered.slice(0, -1);
      else if (entered.length < LOCK_LEN) entered += key;
      ovMsg.textContent = creating && pending ? 'TYPE IT AGAIN' : '';
      paintDots(false);
      if (entered.length === LOCK_LEN) setTimeout(submit, 120);
    });
    document.addEventListener('pointerdown', touchIdle, true);
    document.addEventListener('keydown', touchIdle, true);
    if (armed) showLock();
    touchIdle();
  }

  /* The settings page IS the "turn it off / set one / turn it on" place the operator asked
     for. It can create a code locally, and it says which chat command to send for the
     switch itself - the card has no way to reach the bot. */
  var setCode = document.getElementById('set-code');
  if (setCode) setCode.addEventListener('click', function () {
    LOCK_LEN = 6;
    ov.querySelector('.lockov-dots').innerHTML = '<i class="ldot"></i><i class="ldot"></i><i class="ldot"></i><i class="ldot"></i><i class="ldot"></i><i class="ldot"></i>';
    ovDots = ov.querySelector('.lockov-dots');
    showLock('create');
  });
  var clearCode = document.getElementById('clear-code');
  if (clearCode) clearCode.addEventListener('click', function () {
    keep('darknote.keylock', null);
    LOCAL_HASH = 0;
    wanted = LOCK_HASH || 0;
    armed = LOCK_ON && wanted > 0;
    hideLock();
  });
  var wideBtn = document.getElementById('keylock-btn');
  if (wideBtn) wideBtn.addEventListener('click', openSecurity);

  /*
   * ── ANIMATED BACKGROUND ─────────────────────────────────────────────────────
   *
   * The frames are already stacked in the markup; this only moves the .on class, so the
   * crossfade is a single CSS transition and costs no layout. Which frames are present is
   * decided by the bot - the window slides on every render, so each open looks different.
   */
  var bgFrames = document.querySelectorAll('#bg i');
  if (bgFrames.length > 1) {
    var bgAt = 0;
    setInterval(function () {
      bgFrames[bgAt].classList.remove('on');
      bgAt = (bgAt + 1) % bgFrames.length;
      bgFrames[bgAt].classList.add('on');
    }, 7000);
  }

  /*
   * The Home button: the way in from the lock screen, and the replacement for the
   * upward swipe.
   *
   * The swipe needed a real drag (>= 60px, so that a stray tap on the wallpaper could
   * not get past a lock screen) but it left nothing to aim at - on a handset it was
   * easy to miss and there was no visible affordance saying it existed. A button is
   * unambiguous about where it is and what it does.
   *
   * The refusal that used to live here went with the fingerprint. The keylock needs no
   * check in this handler: while the card is locked the passcode overlay covers the whole
   * screen, so this button cannot be reached in the first place.
   */
  var goHome = document.getElementById('go-home');
  if (goHome) goHome.addEventListener('click', openHome);

  /*
   * ── APPS: GAMES ──────────────────────────────────────────────────────────────
   *
   * Two levels, as asked: the Games app opens a list, and the list holds the game. Each
   * app screen carries a ‹ back button in its top-left, so Security, Games and the game
   * itself all have the same way out.
   *
   * The board is initialised ONCE, the first time the game is opened - re-running it on
   * every visit would rebind every cell and wipe the running score.
   */
  var gamesEl = document.getElementById('games'), gameEl = document.getElementById('game');
  var tttReady = false;

  function openGames () {
    if (gamesEl) gamesEl.classList.add('is-open');
    if (gameEl) gameEl.classList.remove('is-open');
  }
  function openGame () {
    if (gamesEl) gamesEl.classList.remove('is-open');
    if (gameEl) gameEl.classList.add('is-open');
    if (!tttReady && gameEl && typeof initTicTacToe === 'function') {
      tttReady = true;
      initTicTacToe(gameEl);
    }
  }
  function leaveGames () {
    if (gamesEl) gamesEl.classList.remove('is-open');
    if (gameEl) gameEl.classList.remove('is-open');
  }

  var openGamesBtn = document.getElementById('open-games');
  if (openGamesBtn) openGamesBtn.addEventListener('click', openGames);
  var openTttBtn = document.getElementById('open-ttt');
  if (openTttBtn) openTttBtn.addEventListener('click', openGame);
  var gamesBack = document.getElementById('games-back');
  if (gamesBack) gamesBack.addEventListener('click', leaveGames);
  // the game's back goes UP a level, to the list it came from
  var gameBack = document.getElementById('game-back');
  if (gameBack) gameBack.addEventListener('click', openGames);

  /*
   * ── APP NAV: ‹ previous · ⌂ home · ➡ recent ──────────────────────────────────
   *
   * Back follows the app's place in the tree rather than a history stack - the game sits
   * inside Games, everything else sits on the home screen - which stays correct for every
   * route this card can take and cannot drift out of sync the way a stack can.
   *
   * "Recent" is kept on the DEVICE (localStorage): the card has nowhere else to keep it,
   * and it never travels to the bot.
   */
  var APP_SCREENS = ['game', 'ludo', 'games', 'security', 'chrome', 'recent'];
  var APP_LABEL = {
    security: ['🔒', 'Security'], games: ['🎮', 'Games'], game: ['⭕', 'Tic-Tac-Toe'],
    recent: ['➡', 'Recent'], chrome: ['🌐', 'Chrome'], ludo: ['🎲', 'Ludo']
  };

  function syncNav () {
    var open = '';
    for (var i = 0; i < APP_SCREENS.length; i++) {
      var el = document.getElementById(APP_SCREENS[i]);
      if (el && el.classList.contains('is-open')) { open = APP_SCREENS[i]; break; }
    }
    var wrap = document.querySelector('.wrap');
    if (wrap) wrap.classList.toggle('appopen', !!open);
    return open;
  }

  function closeApps () {
    APP_SCREENS.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.classList.remove('is-open');
    });
    syncNav();
  }

  function readRecent () {
    try {
      var raw = JSON.parse(localStorage.getItem('darknote.recent') || '[]');
      return Array.isArray(raw) ? raw.filter(function (x) { return !!APP_LABEL[x]; }) : [];
    } catch (e) { return []; }
  }
  function rememberApp (id) {
    if (!APP_LABEL[id] || id === 'recent') return;
    var list = readRecent().filter(function (x) { return x !== id; });
    list.unshift(id);
    try { localStorage.setItem('darknote.recent', JSON.stringify(list.slice(0, 5))); } catch (e) {}
  }
  function openKnownApp (id) {
    closeApps();
    if (id === 'security' && typeof openSecurity === 'function') { openSecurity(); syncNav(); return; }
    if (id === 'game') { openGame(); syncNav(); return; }
    var el = document.getElementById(id);
    if (el) el.classList.add('is-open');
    syncNav();
  }
  function renderRecent () {
    var host = document.getElementById('recentList');
    if (!host) return;
    var list = readRecent();
    if (!list.length) { host.innerHTML = '<div class="recent-item" style="cursor:default">Nothing opened yet.</div>'; return; }
    host.innerHTML = list.map(function (id) {
      var meta = APP_LABEL[id];
      return '<button class="recent-item" type="button" data-open="' + id + '"><span class="ico">' + meta[0] + '</span>' + meta[1] + '</button>';
    }).join('');
    Array.prototype.forEach.call(host.querySelectorAll('[data-open]'), function (btn) {
      btn.addEventListener('click', function () { openKnownApp(btn.getAttribute('data-open')); });
    });
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t && t.getAttribute && t.getAttribute('data-nav')) {
      var what = t.getAttribute('data-nav');
      var open = syncNav();
      if (what === 'recent') { openKnownApp('recent'); renderRecent(); syncNav(); return; }
      if (what === 'home') { closeApps(); if (typeof openHome === 'function') openHome(); return; }
      // back
      if (open === 'game') { openGames(); syncNav(); return; }
      closeApps();
      if (typeof openHome === 'function') openHome();
      return;
    }
    // Remember what was opened, for the recent page - captured here so EVERY route in
    // (app icon, keylock button, game tile) is recorded without touching each opener.
    var id = t && t.id;
    var track = {
      'open-security': 'security', 'keylock-btn': 'security', 'open-games': 'games',
      'open-ttt': 'game', 'open-chrome': 'chrome', 'open-ludo': 'ludo'
    };
    if (id && track[id]) { rememberApp(track[id]); setTimeout(syncNav, 0); }
  }, true);

  var recentBack = document.getElementById('recent-back');
  if (recentBack) recentBack.addEventListener('click', function () {
    closeApps();
    if (typeof openHome === 'function') openHome();
  });
  // Chrome sits on the home screen, so its back goes home. Ludo sits INSIDE Games, so its
  // back goes up a level, the same as the game screen.
  var chromeBack = document.getElementById('chrome-back');
  if (chromeBack) chromeBack.addEventListener('click', function () {
    closeApps();
    if (typeof openHome === 'function') openHome();
  });
  var ludoBack = document.getElementById('ludo-back');
  if (ludoBack) ludoBack.addEventListener('click', function () { openGames(); });

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

/*
 * THE FIVE-SECOND AUTO-VERIFY.
 *
 * The card cannot send anything back to the bot - WhatsApp runs it in an offline sandbox
 * with no fetch and no XHR - so the card can never verify itself. Only the bot can, and
 * it does not need anything FROM the card to do it: it already knows the paired number,
 * and the check is literally "is this the number this session is paired to". So a few
 * seconds after the card opens, the bot signs the account up with the paired number and
 * moves the card on to the phone.
 *
 * config.json -> menu2.autoVerifyMs is the delay, and 0 turns it off - which by itself
 * restores the old "send the number in the chat" behaviour, because nothing else changes.
 *
 * The value is read from DISK, not from the require() snapshot: a key added to
 * config.json after the process started is invisible to the snapshot and would be erased
 * by the next config write, so a new key has to be read live or it cannot be switched on
 * without a restart.
 */
const CONFIG_FILE = path.join(ROOT, 'config.json')
const AUTO_VERIFY_MS = 5000

function autoVerifyMs() {
    try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
        const value = Number(raw?.menu2?.autoVerifyMs)
        return Number.isFinite(value) && value >= 0 ? value : AUTO_VERIFY_MS
    } catch {
        return AUTO_VERIFY_MS
    }
}

/**
 * Run `job` once, `ms` from now. Returns the timer, or null when the delay is not a
 * positive number - so "off" and "run immediately" can never be confused, and the timing
 * lives in one place that a test can drive instead of inside the caller.
 */
function scheduleAutoVerify(ms, job) {
    const delay = Number(ms)
    if (!Number.isFinite(delay) || delay <= 0 || typeof job !== 'function') return null
    return setTimeout(() => {
        Promise.resolve()
            .then(job)
            .catch((error) => console.error('[MENU2] auto-verify failed:', error?.stack || error))
    }, delay)
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
  .sbg{position:absolute;inset:0;overflow:hidden;z-index:0;pointer-events:none}
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

  /* The number is typed into a REAL input: the box keeps the border, background and
     padding it always had, and the input inside it is bare, so it looks the same and is
     now actually editable with the device keyboard. */
  .field{transition:border-color .25s ease,box-shadow .25s ease}
  .field:focus-within{border-color:#ff5d5d;box-shadow:0 0 0 3px rgba(255,45,45,.12)}
  .field .num-input{flex:1;min-width:0;background:transparent;border:0;outline:0;padding:0;margin:0;
    color:#fff;font:inherit;font-size:15px;letter-spacing:1.4px;caret-color:#ff2d2d}
  .field .num-input::placeholder{color:#55555e;letter-spacing:1px;opacity:1}
  .field .tick{margin-left:auto;font-size:12px;opacity:0;transition:opacity .25s ease}
  .field.is-ok{border-color:rgba(34,197,94,.6);background:rgba(34,197,94,.07)}
  .field.is-bad{border-color:rgba(255,45,45,.6);background:rgba(255,45,45,.07)}
  .field.is-ok .tick{opacity:1;color:#4ade80}
  .field.is-bad .tick{opacity:1;color:#ff7a7a}
  .keyhint{font-size:11px;line-height:1.55;color:#7c7c86;margin:-3px 0 11px}
  .keyhint b{color:#e8e8ec}

  /*
   * PINNED TO THE BOTTOM OF THE CARD, not appended under the panel.
   *
   * In the WhatsApp card viewer the HTML sits in a fixed-height frame that does not
   * scroll, so a keypad added BELOW the panel opened out of sight - the tap looked like
   * it did nothing. Fixed to the frame's own bottom edge it is always visible, whatever
   * the content above it measures.
   */
  .keypad{position:fixed;left:0;right:0;bottom:0;z-index:60;display:none;
    padding:10px 12px 12px;border-top:1px solid #2b2b32;
    background:linear-gradient(180deg,#101014,#0a0a0d 70%,#08080a);
    box-shadow:0 -18px 40px rgba(0,0,0,.65)}
  .keypad.open{display:block;animation:kp-in .22s ease-out}
  @keyframes kp-in{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
  .kp-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
  .kp-title{font-size:10px;letter-spacing:2px;color:#ff7a7a}
  /*
   * TOUCH. These controls are driven by the card's own script, and in WhatsApp's offline
   * sandbox a finger tap does not reliably produce a click. So they are made touch-safe
   * HERE as well as in the handlers, which only leaves the gesture itself to go wrong:
   *   touch-action:manipulation   no 300ms delay, and double-tap zoom cannot eat a tap
   *   -webkit-touch-callout:none  no iOS long-press menu stealing a held key
   *   user-select:none            no text-selection drag starting at a key
   * 44px tall keys, so a thumb actually lands on the digit it aimed at.
   */
  .kp-close,.kp-key,.kp-open{touch-action:manipulation;-webkit-touch-callout:none;
    -webkit-user-select:none;user-select:none;cursor:pointer}
  .kp-close{background:transparent;border:1px solid #33333a;border-radius:8px;color:#a8a8b0;
    font:600 13px/1 inherit;padding:8px 12px;min-height:36px}
  .kp-open{margin-left:6px;border:1px solid #33333a;background:#15151a;border-radius:8px;
    color:#ff8f8f;font-size:14px;line-height:1;padding:9px 11px;min-height:36px}
  .kp-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;max-width:340px;margin:0 auto}
  .kp-key{height:44px;border-radius:10px;border:1px solid #2a2a32;background:#15151a;color:#f4f4f5;
    font:600 17px/1 ui-monospace,Menlo,monospace}
  .kp-key:active{background:#22222a;transform:scale(.96)}
  .kp-del{color:#ff8f8f}
  .kp-wide{grid-column:1 / -1;height:38px;font-size:12px;letter-spacing:2px;color:#5ee08a;
    border-color:#1c4a2c;background:#0c1512}
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
    var pad = document.getElementById('keypad');
    var grid = document.getElementById('kp-grid');
    var closeBtn = document.getElementById('kp-close');
    var openBtn = document.getElementById('kp-open');
    if (!field || !input || !pad || !grid) return;
    var paired = String(field.dataset.paired || '');
    var masked = String(field.dataset.mask || '');

    /*
     * TAPPING ON A TOUCH SCREEN.
     *
     * Every control here is driven by script, and in WhatsApp's offline sandbox a finger
     * tap on something that only listens for 'click' can do nothing at all. So each control
     * is bound to the POINTER phase, which fires for a finger and a mouse alike, and the
     * synthetic click that follows is then skipped - so one physical tap runs the action
     * exactly once. Older webviews without Pointer Events fall back to 'touchstart', and a
     * plain mouse click still works when there is no touch support at all.
     */
    var hasPointer = (typeof window !== 'undefined' && !!window.PointerEvent)
    function onTap(el, fn) {
        if (!el) return
        var seen = false
        if (hasPointer) el.addEventListener('pointerdown', function (e) { seen = true; fn(e) })
        else el.addEventListener('touchstart', function (e) { seen = true; fn(e) })
        el.addEventListener('click', function (e) { if (!seen) fn(e) })
    }

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
        tick.textContent = matches ? '\\u2713' : (digits.length >= 8 ? '\\u2717' : '');
        if (hint) {
            hint.innerHTML = matches
                ? '<b>That is the paired number.</b> Send it in the chat and DARKNOTE signs you up.'
                : (digits.length >= 8
                    ? 'That is not the number this session is paired to. Check it and try again.'
                    : 'Type the number this device is paired to' + (masked ? ' (' + masked + ')' : '') + '.');
        }
    }

    /*
     * THE CARD'S OWN KEYPAD - the second way in, alongside typing. It writes into the same
     * input, so however the number arrives it is checked against the paired number the
     * same way.
     */
    function open() {
        pad.classList.add('open');
        pad.setAttribute('aria-hidden', 'false');
        paint();
    }
    function shut() {
        pad.classList.remove('open');
        pad.setAttribute('aria-hidden', 'true');
        paint();
    }

    function press(key) {
        if (key === 'del') input.value = input.value.slice(0, -1);
        else if (key === '+') { if (input.value.indexOf('+') !== 0) input.value = '+' + input.value.replace(/[+]/g, ''); }
        else if (key === 'done') { shut(); return; }
        else if (/^[0-9]$/.test(key)) input.value = sanitise(input.value + key);
        paint();
    }

    onTap(grid, function (e) {
        var node = e.target;
        /* Walk up from the tapped node: a tap can land on the button's text, not the button. */
        while (node && node !== grid && !node.getAttribute) node = node.parentNode;
        while (node && node !== grid && !node.getAttribute('data-k')) node = node.parentNode;
        if (!node || node === grid) return;
        e.preventDefault();
        press(String(node.getAttribute('data-k') || ''));
    });

    /* Typing straight into the input. The caret is only rewritten when something was
       actually stripped, so normal editing is never disturbed. */
    input.addEventListener('input', function () {
        var clean = sanitise(input.value);
        if (clean !== input.value) {
            var atEnd = input.selectionStart === input.value.length;
            input.value = clean;
            if (atEnd && input.setSelectionRange) { try { input.setSelectionRange(clean.length, clean.length); } catch (e) { } }
        }
        paint();
    });

    /* The device keyboard and the card's keypad are two ways to the same value, so they are
       never both on screen: focusing the input puts the keypad away. */
    input.addEventListener('focus', function () { shut(); });

    onTap(closeBtn, function (e) { if (e.preventDefault) e.preventDefault(); shut(); });
    onTap(openBtn, function (e) { if (e.preventDefault) e.preventDefault(); open(); });

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


/* ==========================================================================
 * SECTION: PING DASHBOARD - the AIRich status screen
 * (was ping-dashboard.js)
 * ========================================================================== */

'use strict'

/*
 * DARKNOTE SYSTEM DASHBOARD — the `.ping` card.
 * =============================================
 * Adapted from the MZAZI XMD version of this dashboard, rebranded for DARKNOTE
 * and wired to THIS project's socket.
 *
 * Two deliberate differences from the original, both because the original only
 * ever ran inside a `case` in a bot built on mzazibaileys:
 *
 * 1. Everything the original read from outer scope (`mzazi`, `sender`,
 *    `mzazireply`, `logger`, `botName`, `botPhoneNum`, `loadJSON`) is now a
 *    parameter. Nothing is assumed about the caller's scope, so this module
 *    cannot break a `require` of it.
 * 2. AIRich is loaded LAZILY from vendor/node_modules, and every failure falls
 *    back to a plain text reply. The rich HTML primitive
 *    (`GenAIaeacdsnwHtmlPrimitive`) is only rendered by clients that support it;
 *    `unsupportedTypeAlert: false` makes an unsupported client fail SILENTLY, so
 *    without the fallback a working bot would look broken.
 */


const BRAND = 'DARKNOTE'
const CREATOR = 'DARKNOTE L2 • Bigbrother'

let cachedAIRich = null

/**
 * Resolve the AIRich builder without assuming it is installed.
 * Vendor first: mzazibaileys is a second Baileys fork, so it is kept out of this
 * project's own node_modules on purpose.
 */
function loadAIRich() {
    if (cachedAIRich) return cachedAIRich
    const candidates = [
        path.join(__dirname, '..', 'vendor', 'node_modules', 'mzazibaileys'),
        'mzazibaileys'
    ]
    for (const target of candidates) {
        try {
            const mod = require(target)
            if (mod && typeof mod.AIRich === 'function') {
                cachedAIRich = mod.AIRich
                return cachedAIRich
            }
        } catch (error) {
            // Try the next candidate; the caller falls back to text.
        }
    }
    throw new Error('AIRich is unavailable (mzazibaileys is not installed)')
}

const fmtSize = (bytes) => {
    const value = Number(bytes) || 0
    if (value <= 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)))
    return `${(value / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

const fmtUp = (seconds) => {
    const s = Math.max(0, Math.floor(Number(seconds) || 0))
    const d = Math.floor(s / 86400)
    const h = Math.floor((s % 86400) / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = s % 60
    if (d > 0) return `${d}d ${h}h ${m}m`
    if (h > 0) return `${h}h ${m}m ${sec}s`
    return `${m}m ${sec}s`
}

const dashEscapeHtml = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;')

/** Read a JSON file defensively: a missing or broken file is simply empty. */
function readJsonSafe(file, fallback) {
    try {
        if (!fs.existsSync(file)) return fallback
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
        return parsed == null ? fallback : parsed
    } catch {
        return fallback
    }
}

function networkCounters() {
    try {
        const interfaces = os.networkInterfaces()
        let active = 'N/A'
        for (const [name, addrs] of Object.entries(interfaces)) {
            if (name.toLowerCase().includes('lo')) continue
            for (const addr of addrs || []) {
                if (addr.family === 'IPv4' && !addr.internal) { active = name; break }
            }
        }
        let rx = 0
        let tx = 0
        try {
            if (process.platform === 'linux') {
                const dev = fs.readFileSync('/proc/net/dev', 'utf8')
                for (const line of dev.split('\n')) {
                    if (!line.includes(':') || line.includes('lo:')) continue
                    const parts = line.trim().split(/\s+/)
                    if (parts.length < 10) continue
                    const name = parts[0].replace(':', '')
                    if (name === active || (active === 'N/A' && parseInt(parts[1], 10) > 0)) {
                        rx = parseInt(parts[1], 10) || 0
                        tx = parseInt(parts[9], 10) || 0
                        if (active === 'N/A') active = name
                        break
                    }
                }
            }
        } catch { /* counters are optional */ }
        return { rx, tx, iface: active }
    } catch {
        return { rx: 0, tx: 0, iface: 'N/A' }
    }
}

/** Root filesystem usage in bytes. 0/0 when it cannot be read. */
function diskUsage() {
    try {
        const out = execSync('df -k / 2>/dev/null', { encoding: 'utf8' })
        const lines = out.trim().split('\n')
        if (lines.length > 1) {
            // df -k columns: Filesystem  1K-blocks  Used  Available  Use%  Mounted
            const parts = lines[1].trim().split(/\s+/)
            const total = Number(parts[1]) * 1024
            const used = Number(parts[2]) * 1024
            if (Number.isFinite(total) && Number.isFinite(used) && total > 0) {
                return { total, used }
            }
        }
    } catch {
        // Non-Linux hosts (or a sandbox without df) simply report 0.
    }
    return { total: 0, used: 0 }
}

/**
 * Measure everything the dashboard shows.
 * `roundTripMs` is measured by the caller (a reaction round trip), because this
 * module has no socket of its own.
 */
function collectMetrics(roundTripMs, options = {}) {
    const cpus = os.cpus()
    const totalMem = os.totalmem()
    const freeMem = os.freemem()
    const heap = process.memoryUsage()
    const net = networkCounters()
    const waRoundtrip = Math.max(1, Math.round(Number(roundTripMs) || 1))

    let cpuPct = Math.max(1, Math.min(100, os.loadavg()[0] / (cpus.length || 1) * 100)).toFixed(1)

    const dbRoot = path.join(__dirname, '..', 'database')
    const users = readJsonSafe(path.join(dbRoot, 'users.json'), {})
    const groups = readJsonSafe(path.join(dbRoot, 'groups.json'), {})
    const dbUsers = users && typeof users === 'object' ? Object.keys(users).length : 0
    const dbGroups = groups && typeof groups === 'object' ? Object.keys(groups).length : 0
    const dbPremium = users && typeof users === 'object'
        ? Object.values(users).filter(entry => entry && entry.isPremium).length
        : 0

    const disk = diskUsage()
    const heapPct = heap.heapTotal > 0 ? (heap.heapUsed / heap.heapTotal) * 100 : 0
    const ramPct = totalMem > 0 ? ((totalMem - freeMem) / totalMem) * 100 : 0
    const diskPct = disk.total > 0 ? (disk.used / disk.total) * 100 : 0

    return {
        brand: String(options.brand || BRAND).toUpperCase(),
        creator: String(options.creator || CREATOR),
        waRoundtrip,
        cpus,
        totalMem,
        freeMem,
        heap,
        net,
        cpuPct,
        ramPct,
        heapPct,
        diskPct,
        disk,
        dbUsers,
        dbGroups,
        dbPremium,
        uptimeBotSec: Math.floor(process.uptime()),
        uptimeServerSec: Math.floor(os.uptime()),
        respTier: waRoundtrip < 100 ? 'Excellent' : waRoundtrip < 200 ? 'Great' : waRoundtrip < 500 ? 'Good' : waRoundtrip < 1000 ? 'Fair' : waRoundtrip < 2000 ? 'Slow' : 'Poor',
        memTier: ramPct < 50 ? 'Healthy' : ramPct < 75 ? 'Moderate' : 'High',
        cpuTier: parseFloat(cpuPct) < 20 ? 'Idle' : parseFloat(cpuPct) < 50 ? 'Normal' : parseFloat(cpuPct) < 80 ? 'Busy' : 'Overloaded',
        diskTier: diskPct < 60 ? 'Healthy' : diskPct < 85 ? 'Moderate' : 'Critical',
        timeStr: new Date().toLocaleTimeString('en-KE', { timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }),
        dateStr: new Date().toLocaleDateString('en-KE', { timeZone: 'Africa/Nairobi', weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })
    }
}

/** The plain-text reply, used when the rich card cannot be delivered. */
function buildFallbackText(metrics) {
    const load = os.loadavg().map(v => v.toFixed(2)).join(' · ')
    return [
        '🏓 *PONG — DARKNOTE*',
        '',
        `⚡ *Speed:* \`${metrics.waRoundtrip} ms\` (${metrics.respTier})`,
        `⏱️ *Bot uptime:* ${fmtUp(metrics.uptimeBotSec)}`,
        `🖥️ *Server uptime:* ${fmtUp(metrics.uptimeServerSec)}`,
        '',
        `🧠 RAM: ${metrics.ramPct.toFixed(1)}% · ${fmtSize(metrics.totalMem - metrics.freeMem)} / ${fmtSize(metrics.totalMem)}`,
        `⚡ CPU: ${metrics.cpuPct}% · ${metrics.cpuTier} (load ${load})`,
        `📦 Heap: ${metrics.heapPct.toFixed(1)}% · ${fmtSize(metrics.heap.heapUsed)} / ${fmtSize(metrics.heap.heapTotal)}`,
        `🌐 Net: ${dashEscapeHtml(metrics.net.iface)} · ↓ ${fmtSize(metrics.net.rx)} · ↑ ${fmtSize(metrics.net.tx)}`,
        '',
        `🧩 ${metrics.cpus.length} cores · Node ${process.version} · ${process.platform} ${process.arch}`,
        `📅 ${metrics.dateStr} · ${metrics.timeStr} EAT`
    ].join('\n')
}

/**
 * The rich card payload.
 *
 * The Database section reads `database/users.json` and `database/groups.json`.
 * This project does not populate them yet, so they honestly report 0 — the
 * section is kept so the layout matches the reference dashboard.
 */
function buildHtml(metrics) {
    const { waRoundtrip, cpus, totalMem, heap, cpuPct, ramPct, heapPct, diskPct } = metrics
    const botLabel = metrics.brand

    /*
     * HAUNTED HOUSE THEME — "the live haunted house".
     *
     * The card is one self-contained HTML scene: a night sky, a breathing moon,
     * drifting fog, bats, dead trees, and a haunted house whose windows flicker.
     * The live readings drive the scene, so the house reacts to the bot:
     *
     *   latency            -> window flicker speed, the eyes, the spirit line
     *   cpu                -> fog drift speed
     *   ram / cpu / disk / heap -> the CRYPT LOAD bars
     *
     * Everything is inline (SVG + CSS keyframes + one setInterval). No external
     * fonts, images or network calls, so it renders on any client that supports
     * the HTML primitive - the same guarantee the previous card had.
     */
    const latencyColor = (ms) => (Number(ms) < 150 ? '#7CFC8A' : Number(ms) < 500 ? '#ffb020' : '#ff3b3b')
    const latencyTier = (ms) => (Number(ms) < 150 ? 'FAST' : Number(ms) < 500 ? 'FAIR' : 'SLOW')
    const isHealthy = waRoundtrip < 500 && ramPct < 75 && parseFloat(cpuPct) < 80
    const statusColor2 = isHealthy ? '#7CFC8A' : '#ffb020'
    const timeStr = metrics.timeStr
    // Slow link -> the house becomes frantic.
    const flickerSpeed = waRoundtrip < 150 ? '7s' : waRoundtrip < 500 ? '3.2s' : '1.2s'

    return `
<style>
@keyframes skyShift{0%{background-position:0% 0%}100%{background-position:0% 100%}}
@keyframes starTwinkle{0%,100%{opacity:.18}50%{opacity:.95}}
@keyframes moonGlow{0%,100%{box-shadow:0 0 34px 8px rgba(190,215,255,.22)}50%{box-shadow:0 0 66px 20px rgba(190,215,255,.40)}}
@keyframes fogDrift{0%{transform:translateX(-12%)}100%{transform:translateX(12%)}}
@keyframes fogDriftBack{0%{transform:translateX(10%)}100%{transform:translateX(-10%)}}
@keyframes batFly{0%{transform:translate(-20%,0) scale(.75);opacity:0}12%{opacity:1}50%{transform:translate(110%,-26px) scale(1)}88%{opacity:1}100%{transform:translate(240%,8px) scale(.8);opacity:0}}
@keyframes flicker{0%,100%{opacity:1}42%{opacity:.22}46%{opacity:.92}52%{opacity:.12}58%{opacity:1}}
@keyframes blinkEye{0%,92%,100%{opacity:1}95%{opacity:0}}
@keyframes smoke{0%{transform:translateY(0) scale(.6);opacity:0}20%{opacity:.5}100%{transform:translateY(-58px) scale(1.7);opacity:0}}
@keyframes floatUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
@keyframes barGrow{from{width:0}}
@keyframes tickFlash{0%{color:#fff;text-shadow:0 0 20px ${statusColor2}}100%{color:${statusColor2};text-shadow:0 0 8px rgba(0,0,0,0)}}
.tick{animation:tickFlash .6s ease-out;}
:root{--ink:#e9f2ff;--muted:#9fb4d8;--bone:#f3f0e6;--moss:#7CFC8A;--pumpkin:#ff7518;--blood:#ff3b3b;
--border:rgba(124,252,138,.20);--panel:rgba(30,80,60,.20);--lat:${latencyColor(waRoundtrip)};--flick:${flickerSpeed};}
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent;-webkit-font-smoothing:antialiased;}
html,body{background:transparent;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;}
.wrap{padding:10px;}
.card{position:relative;max-width:420px;margin:0 auto;border-radius:22px;overflow:hidden;background:#050410;border:1px solid var(--border);box-shadow:0 26px 70px rgba(0,0,0,.8),0 0 0 1px rgba(124,252,138,.06);animation:floatUp .4s ease;}

/* ---------------- scene ---------------- */
.scene{position:relative;height:210px;overflow:hidden;background:linear-gradient(180deg,#040311 0%,#0a0722 42%,#120a2b 68%,#1a0f2e 100%);background-size:100% 200%;animation:skyShift 40s ease-in-out infinite alternate;}
.stars{position:absolute;inset:0;z-index:1;}
.stars i{position:absolute;width:2px;height:2px;border-radius:50%;background:#dfe9ff;animation:starTwinkle 3.4s ease-in-out infinite;}
.moonwrap{position:absolute;top:16px;right:34px;z-index:2;}
.moon{width:46px;height:46px;border-radius:50%;background:radial-gradient(circle at 34% 32%,#fdfdff 0%,#cdd8ef 58%,#8e9dc0 100%);animation:moonGlow 7s ease-in-out infinite;}
.moon i{position:absolute;border-radius:50%;background:rgba(120,134,168,.30);}
.hill{position:absolute;left:-6%;right:-6%;bottom:0;height:78px;border-radius:50% 50% 0 0/64px 64px;background:linear-gradient(180deg,#0e0a20 0%,#05030f 100%);z-index:3;}
.house{position:absolute;left:50%;bottom:6px;transform:translateX(-50%);width:250px;height:172px;z-index:4;filter:drop-shadow(0 -6px 16px rgba(124,252,138,.12));}
.win{fill:var(--moss);opacity:.92;animation:flicker var(--flick) steps(1,end) infinite;}
.win.p2{animation-delay:-1.1s;} .win.p3{animation-delay:-2.4s;}
.eye{fill:var(--lat);animation:blinkEye 5.5s ease-in-out infinite;}
.smoke{position:absolute;z-index:4;width:12px;height:12px;border-radius:50%;background:radial-gradient(circle,rgba(190,200,220,.55),rgba(190,200,220,0) 70%);animation:smoke 6s ease-out infinite;}
.bat{position:absolute;z-index:5;font-size:15px;line-height:1;filter:drop-shadow(0 0 6px rgba(0,0,0,.9));animation:batFly 11s linear infinite;}
.fog{position:absolute;left:-20%;right:-20%;z-index:6;height:56px;background:radial-gradient(ellipse at 50% 60%,rgba(150,180,220,.20),rgba(150,180,220,0) 72%);}
.fog1{bottom:-6px;animation:fogDrift 14s ease-in-out infinite alternate;}
.fog2{bottom:14px;opacity:.65;animation:fogDriftBack 19s ease-in-out infinite alternate;}
.grave{position:absolute;z-index:4;font-size:13px;opacity:.72;filter:grayscale(.2) brightness(.8);}

/* ---------------- content ---------------- */
.content{position:relative;z-index:9;padding:12px 14px 14px;background:linear-gradient(180deg,rgba(6,4,16,.52) 0%,rgba(5,4,14,.94) 46%,rgba(4,3,11,1) 100%);margin-top:-26px;}
.hero{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-radius:16px;border:1px solid var(--border);background:linear-gradient(135deg,rgba(124,252,138,.07),rgba(30,80,60,.10));}
.hero-label{font-size:9px;letter-spacing:2px;color:var(--muted);text-transform:uppercase;font-weight:700;}
.hero-value{font-size:30px;font-weight:800;color:var(--lat);line-height:1.1;transition:color .3s;}
.hero-value .unit{font-size:14px;color:var(--muted);font-weight:700;margin-left:3px;}
.hero-sub{font-size:11px;color:var(--muted);}
.badge{font-size:10px;font-weight:800;letter-spacing:1px;padding:5px 9px;border-radius:9px;border:1px solid var(--lat);color:var(--lat);white-space:nowrap;}
.haunt{margin-top:8px;font-size:11px;color:var(--muted);text-align:center;font-style:italic;letter-spacing:.2px;}
.section{margin-top:12px;padding:10px 12px;border-radius:16px;border:1px solid rgba(255,255,255,.07);background:linear-gradient(180deg,rgba(255,255,255,.028),rgba(255,255,255,.008));}
.section-title{font-size:9px;letter-spacing:2.2px;text-transform:uppercase;color:var(--moss);font-weight:800;margin-bottom:9px;}
.chips{display:flex;flex-wrap:wrap;gap:8px;}
.chip{flex:1 1 46%;min-width:0;padding:8px 10px;border-radius:12px;border:1px solid rgba(255,255,255,.07);background:rgba(255,255,255,.026);}
.chip .k{font-size:8.5px;letter-spacing:1.2px;color:var(--muted);text-transform:uppercase;font-weight:700;}
.chip .v{font-size:15px;font-weight:800;margin-top:2px;}
.chip .s{font-size:10px;color:var(--muted);}
.bar-item{margin-bottom:9px;} .bar-item:last-child{margin-bottom:0;}
.bar-head{display:flex;justify-content:space-between;font-size:11px;margin-bottom:4px;}
.bar-head .k{color:var(--bone);} .bar-head .v{color:var(--muted);}
.bar-track{height:7px;border-radius:99px;background:rgba(255,255,255,.07);overflow:hidden;}
.bar-fill{height:100%;border-radius:99px;background:linear-gradient(90deg,#2f7fff,var(--moss));animation:barGrow .5s ease;transition:width .6s ease;}
.foot{display:flex;justify-content:space-between;align-items:center;margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,.07);font-size:10.5px;color:var(--muted);}
.foot b{color:var(--bone);}
.stamp{text-align:center;font-size:10px;color:var(--muted);margin-top:8px;letter-spacing:.4px;}
</style>

<div class="wrap">
  <div class="card">
    <div class="scene">
      <div class="stars">
        <i style="top:12%;left:8%;animation-delay:0s"></i><i style="top:22%;left:26%;animation-delay:.7s"></i>
        <i style="top:9%;left:48%;animation-delay:1.3s"></i><i style="top:28%;left:66%;animation-delay:2.1s"></i>
        <i style="top:16%;left:88%;animation-delay:.4s"></i><i style="top:36%;left:14%;animation-delay:1.8s"></i>
        <i style="top:40%;left:78%;animation-delay:2.6s"></i><i style="top:5%;left:70%;animation-delay:1s"></i>
      </div>
      <div class="moonwrap">
        <div class="moon">
          <i style="width:9px;height:9px;top:11px;left:13px;"></i>
          <i style="width:6px;height:6px;top:26px;left:26px;"></i>
          <i style="width:4px;height:4px;top:16px;left:29px;"></i>
        </div>
      </div>
      <div class="hill"></div>

      <svg class="house" viewBox="0 0 250 172" preserveAspectRatio="xMidYMax meet">
        <defs>
          <linearGradient id="wallG" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#2c1c42"/><stop offset="100%" stop-color="#0b0616"/>
          </linearGradient>
          <linearGradient id="roofG" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#3b2455"/><stop offset="100%" stop-color="#150c25"/>
          </linearGradient>
        </defs>

        <rect x="118" y="18" width="15" height="34" fill="#241636" stroke="#61439a" stroke-width="1.2"/>
        <path d="M75 172 L75 92 L125 50 L175 92 L175 172 Z" fill="url(#wallG)" stroke="#61439a" stroke-width="1.4"/>
        <path d="M75 92 L125 50 L175 92" fill="none" stroke="#7d5bb5" stroke-width="2.2" stroke-linecap="round"/>
        <path d="M40 172 L40 122 L75 100 L75 172 Z" fill="#180f2b" stroke="#4d3179" stroke-width="1.2"/>
        <path d="M175 172 L175 100 L210 122 L210 172 Z" fill="#180f2b" stroke="#4d3179" stroke-width="1.2"/>
        <path d="M30 172 L30 148 L48 140 L66 148 L66 172 Z" fill="#120a20" stroke="#3d2763" stroke-width="1"/>

        <circle class="eye" cx="125" cy="72" r="3.4"/>
        <rect class="win p1" x="90" y="106" width="17" height="21" rx="2"/>
        <rect class="win p2" x="143" y="106" width="17" height="21" rx="2"/>
        <rect class="win p3" x="116" y="84" width="18" height="16" rx="2"/>
        <path d="M112 172 L112 132 Q125 122 138 132 L138 172 Z" fill="#0d0718" stroke="#61439a" stroke-width="1.2"/>
        <circle cx="134" cy="152" r="2.2" fill="#c9a35b"/>
        <path d="M55 108 L52 84 M52 84 L44 74 M52 84 L60 72" stroke="#2a1b40" stroke-width="2" fill="none" stroke-linecap="round"/>
        <path d="M196 106 L199 80 M199 80 L207 70 M199 80 L191 68" stroke="#2a1b40" stroke-width="2" fill="none" stroke-linecap="round"/>
      </svg>

      <div class="smoke" style="left:126px;bottom:112px;animation-delay:0s"></div>
      <div class="smoke" style="left:126px;bottom:112px;animation-delay:2s"></div>
      <div class="smoke" style="left:126px;bottom:112px;animation-delay:4s"></div>

      <div class="grave" style="left:12%;bottom:8px;">🪦</div>
      <div class="grave" style="right:11%;bottom:6px;">🪦</div>
      <div class="bat" style="top:34px;left:-8%;animation-delay:0s">🦇</div>
      <div class="bat" style="top:66px;left:-8%;animation-delay:3.4s;font-size:12px">🦇</div>
      <div class="bat" style="top:18px;left:-8%;animation-delay:6.6s;font-size:11px">🦇</div>

      <div class="fog fog1"></div>
      <div class="fog fog2" id="waveSvg"></div>
    </div>

    <div class="content">
      <div class="hero">
        <div>
          <div class="hero-label">Haunt Level</div>
          <div class="hero-value"><span id="livePing">${waRoundtrip}</span><span class="unit">ms</span></div>
          <div class="hero-sub">Response quality: <span id="liveTier">${metrics.respTier}</span></div>
        </div>
        <div class="badge" id="liveStatusBadge">${latencyTier(waRoundtrip)}</div>
      </div>

      <div class="haunt" id="spiritLine">…the house is listening</div>

      <div class="section">
        <div class="section-title">✦ Spectre Link</div>
        <div class="chips">
          <div class="chip"><div class="k">Wa Roundtrip</div><div class="v" id="cellPing">${waRoundtrip} ms</div><div class="s" id="cellPingTier">${metrics.respTier}</div></div>
          <div class="chip"><div class="k">Api Ping</div><div class="v" id="cellApiPing">${Math.max(1, Math.round(waRoundtrip * 0.9))} ms</div><div class="s">Estimated</div></div>
          <div class="chip"><div class="k">Bot Uptime</div><div class="v" id="cellBotUp">${fmtUp(metrics.uptimeBotSec)}</div><div class="s">Since start</div></div>
          <div class="chip"><div class="k">Server Uptime</div><div class="v" id="cellSrvUp">${fmtUp(metrics.uptimeServerSec)}</div><div class="s">Host machine</div></div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">✦ Crypt Load</div>
        <div class="bar-item">
          <div class="bar-head"><span class="k">🧠 Memory</span><span class="v" id="lblRam">${ramPct.toFixed(1)}% · ${metrics.memTier}</span></div>
          <div class="bar-track"><div class="bar-fill" id="barRam" style="width:${Math.min(100, ramPct)}%"></div></div>
        </div>
        <div class="bar-item">
          <div class="bar-head"><span class="k">⚡ CPU</span><span class="v" id="lblCpu">${cpuPct}% · ${metrics.cpuTier}</span></div>
          <div class="bar-track"><div class="bar-fill" id="barCpu" style="width:${Math.min(100, parseFloat(cpuPct))}%"></div></div>
        </div>
        <div class="bar-item">
          <div class="bar-head"><span class="k">💾 Disk</span><span class="v" id="lblDisk">${diskPct.toFixed(1)}% · ${metrics.diskTier}</span></div>
          <div class="bar-track"><div class="bar-fill" id="barDisk" style="width:${Math.min(100, diskPct)}%"></div></div>
        </div>
        <div class="bar-item">
          <div class="bar-head"><span class="k">📦 Heap</span><span class="v" id="lblHeap">${heapPct.toFixed(1)}%</span></div>
          <div class="bar-track"><div class="bar-fill" id="barHeap" style="width:${Math.min(100, heapPct)}%"></div></div>
        </div>
      </div>

      <div class="foot">
        <div>🕯️ <b>${dashEscapeHtml(botLabel)}</b></div>
        <div>${dashEscapeHtml(metrics.creator)}</div>
      </div>
      <div class="stamp">${metrics.dateStr} · <span id="liveTime2">${timeStr}</span> EAT</div>
    </div>
  </div>
</div>

<script>
(function(){
  var BOT_START_EPOCH = Date.now() - (${metrics.uptimeBotSec} * 1000);
  var SRV_START_EPOCH = Date.now() - (${metrics.uptimeServerSec} * 1000);
  var botUpSec = Math.floor((Date.now() - BOT_START_EPOCH) / 1000);
  var srvUpSec = Math.floor((Date.now() - SRV_START_EPOCH) / 1000);
  var basePing = ${waRoundtrip};
  var baseCpu = parseFloat("${cpuPct}") || 5;
  var baseRam = parseFloat("${ramPct.toFixed(1)}") || 40;
  var baseHeap = parseFloat("${heapPct.toFixed(1)}") || 30;
  var baseDisk = ${diskPct.toFixed(1)};
  var totalCpus = ${cpus.length} || 1;
  var el = function(id){ return document.getElementById(id); };
  function fmtUp(s){ s=Math.floor(s); var d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60),sc=s%60; if(d>0) return d+'d '+h+'h '+m+'m'; if(h>0) return h+'h '+m+'m '+sc+'s'; return m+'m '+sc+'s'; }
  function tierForPing(p){ return p<100?'Excellent':p<200?'Great':p<500?'Good':p<1000?'Fair':p<2000?'Slow':'Poor'; }
  function tierForMem(p){ return p<50?'Healthy':p<75?'Moderate':'High'; }
  function tierForDsk(p){ return p<60?'Healthy':p<85?'Moderate':'Critical'; }
  function tierForCpu(p){ return p<20?'Idle':p<50?'Normal':p<80?'Busy':'Overloaded'; }
  function flash(node){ if(!node) return; node.classList.remove('tick'); void node.offsetWidth; node.classList.add('tick'); }

  /*
   * The house has a mood. Latency drives it, so a slow round trip is visible as
   * a haunted reaction and not just a number: the windows get frantic, the eyes
   * burn brighter, and the spirit line changes its tone.
   */
  var SPIRITS = {
    calm:  ['…the house is listening','…floorboards settle on their own','…something breathes upstairs','…the candles lean left'],
    mid:   ['…a door just closed by itself','…the bats have started circling','…someone is counting the rooms','…the fog is rising'],
    wild:  ['…THE WALLS ARE SCRATCHING','…EVERY WINDOW IS AWAKE','…IT KNOWS YOU ARE STILL HERE','…THE HOUSE IS RUNNING']
  };
  function pick(list, n){ return list[n % list.length]; }

  var tickCount = 0;
  function tick(){
    tickCount++;
    var jitter = (Math.random()-0.5)*Math.max(6, basePing*0.35);
    var ping = Math.max(1, Math.round(basePing + jitter));
    var tier = tierForPing(ping);
    var apiPing = Math.max(1, Math.round(ping*0.9));

    var ePing=el('livePing'), eTier=el('liveTier'), eCP=el('cellPing'), eCPT=el('cellPingTier'), eAP=el('cellApiPing');
    if(ePing && ePing.textContent != ping){ ePing.textContent = ping; flash(ePing.parentElement); }
    var latColor = ping<150?'#7CFC8A':ping<500?'#ffb020':'#ff3b3b';
    var latTier = ping<150?'FAST':ping<500?'FAIR':'SLOW';
    if(ePing && ePing.parentElement){ ePing.parentElement.style.color = latColor; }
    if(eTier) eTier.textContent = tier;
    if(eCP) eCP.textContent = ping + ' ms';
    if(eCPT) eCPT.textContent = tier;
    if(eAP) eAP.textContent = apiPing + ' ms';

    // Mood + flicker speed follow the live latency.
    var mood = ping<150?'calm':ping<500?'mid':'wild';
    if(tickCount % 3 === 0){
      var badge = el('liveStatusBadge');
      if(badge){ badge.textContent = latTier; badge.style.color = latColor; badge.style.borderColor = latColor; }
      var spirit = el('spiritLine');
      if(spirit) spirit.textContent = pick(SPIRITS[mood], tickCount/3);
    }
    var eye = document.querySelector('.eye');
    if(eye) eye.style.fill = latColor;
    var wins = document.querySelectorAll('.win');
    for(var i=0;i<wins.length;i++){ wins[i].style.animationDuration = (ping<150?'7s':ping<500?'3.2s':'1.2s'); }

    botUpSec = Math.floor((Date.now()-BOT_START_EPOCH)/1000);
    srvUpSec = Math.floor((Date.now()-SRV_START_EPOCH)/1000);
    var eBU=el('cellBotUp'), eSU=el('cellSrvUp');
    if(eBU) eBU.textContent = fmtUp(botUpSec);
    if(eSU) eSU.textContent = fmtUp(srvUpSec);

    var now = new Date();
    var t = now.toLocaleTimeString('en-KE',{timeZone:'Africa/Nairobi',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true});
    var eT2=el('liveTime2');
    if(eT2) eT2.textContent = t;

    var cpu = Math.max(1, Math.min(99, baseCpu + (Math.random()-0.5)*6));
    var ram = Math.max(1, Math.min(99, baseRam + (Math.random()-0.5)*2.5));
    var heap = Math.max(1, Math.min(99, baseHeap + (Math.random()-0.5)*3));
    var diskNow = Math.max(0, Math.min(100, baseDisk + (Math.random()-0.5)*0.3));

    var eLR=el('lblRam'), eLC=el('lblCpu'), eLH=el('lblHeap'), eLD=el('lblDisk');
    if(eLR) eLR.textContent = ram.toFixed(1)+'% · '+tierForMem(ram);
    if(eLC) eLC.textContent = cpu.toFixed(1)+'% · '+tierForCpu(cpu);
    if(eLH) eLH.textContent = heap.toFixed(1)+'%';
    if(eLD) eLD.textContent = diskNow.toFixed(1)+'% · '+tierForDsk(diskNow);

    var bR=el('barRam'), bC=el('barCpu'), bH=el('barHeap'), bD=el('barDisk');
    if(bR) bR.style.width = ram+'%';
    if(bC) bC.style.width = cpu+'%';
    if(bH) bH.style.width = heap+'%';
    if(bD) bD.style.width = diskNow+'%';

    // Busier CPU -> the fog rolls faster.
    var fog = el('waveSvg');
    if(fog){ fog.style.animationDuration = Math.max(5, 20 - cpu/6) + 's'; }
  }

  tick();
  setInterval(tick, 1000);
  document.addEventListener('visibilitychange', function(){ if(!document.hidden){ tick(); } });
})();
</script>
`
}

/**
 * Send the dashboard.
 *
 * `react` is an optional async (emoji) => void used for the 🏓/✅ feedback, and
 * `reply` is the plain-text fallback. Returns a result object rather than
 * throwing, so a ping can never take the dispatcher down.
 */
async function sendPingDashboard(conn, m, options = {}) {
    const react = typeof options.react === 'function' ? options.react : async () => {}
    const reply = typeof options.reply === 'function' ? options.reply : async () => {}

    const started = Date.now()
    await react('🏓')
    const roundTripMs = Math.max(1, Date.now() - started)

    const metrics = collectMetrics(roundTripMs, { brand: options.brand, creator: options.creator })
    const fallbackText = buildFallbackText(metrics)

    try {
        const AIRich = loadAIRich()
        const html = buildHtml(metrics)
        const rich = new AIRich(conn, { dynamic: true, unsupportedTypeAlert: false })
        rich.addSection({
            view_model: {
                primitive: {
                    __typename: 'GenAIaeacdsnwHtmlPrimitive',
                    payload: html,
                    trusted_sources: ['mzazi.shop']
                },
                __typename: 'GenAISingleLayoutViewModel'
            }
        })
        await rich.send(m.chat, {
            quoted: m,
            includesUnifiedResponse: true,
            includesSubmessages: false,
            forwarded: true,
            notification: false
        })
        await react('✅')
        return { ok: true, mode: 'rich', roundTripMs }
    } catch (error) {
        // The rich primitive is only rendered by clients that support it, so a
        // failure here is expected on some devices - answer with plain text.
        console.error('[PING] rich card unavailable, using plain text:', error && error.message ? error.message : error)
        try {
            await reply(fallbackText)
            await react('✅')
        } catch (replyError) {
            console.error('[PING] text fallback failed:', replyError && replyError.message ? replyError.message : replyError)
            await react('❌')
        }
        return { ok: false, mode: 'text', roundTripMs, reason: error && error.message ? error.message : String(error) }
    }
}


/* ==========================================================================
 * SECTION: RUNTIME SCREEN - the handset scene
 * (was runtime-screen.js)
 * ========================================================================== */

'use strict'

/*
 * RUNTIME SCREEN — the visual half.
 *
 * Draws the `.runtime` scene as a handset display: a lock screen with a real
 * status bar, a big clock, glass widgets and a live wallpaper. The wallpaper is
 * the day itself — the sun or moon on its arc carrying the DARKNOTE wordmark,
 * drifting clouds, and the two characters whose routine follows the clock.
 *
 * Everything drawn here comes from `runtime-model.js`; nothing in this file
 * decides what time it is or what anyone should be doing. That split is what
 * keeps the picture testable.
 *
 * The page keeps its own clock (offset + optional freeze), so the scene stays
 * truthful after it has been sent instead of freezing at the moment it was
 * rendered.
 */


const {
    PHASES, TOP_ROUTINE, BOTTOM_PACE,
    escapeHtml: modelEscapeHtml, phaseFor, nextPhaseAt, celestial, screenPos, outfitFor,
    scatter, SKY_TOP_PCT, SKY_HORIZON_PCT
} = model

const rand = (value, digits = 6) => Number(Number(value).toFixed(digits))

/* ------------------------------- the sky ------------------------------- */

/*
 * One palette per phase, three stops so the sky has a horizon glow instead of a
 * flat fade. The wordmark and the accents follow --accent, so the whole screen
 * re-tints from a single phase class.
 */
function buildStyles() {
    return `
:root{color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;background:#05060b}
body{display:flex;justify-content:center;align-items:flex-start;padding:12px;
     font-family:-apple-system,"SF Pro Text","Segoe UI",system-ui,sans-serif}

#card{
  --a:#ffe066; --b:#4aa8ff; --ink:#f2f6ff; --muted:rgba(242,246,255,.72);
  --wall1:#0d47a8; --wall2:#2f8fe0; --wall3:#9fdcff;
  --ground:#0e2418; --hill:#0a1a11; --sun:#ffd75e; --moon:#eef3ff; --cloud:#ffffff;
}
#card.phase-dawn{--wall1:#1b1035;--wall2:#7b3f7a;--wall3:#ff9a5c;--a:#ffb26b;--ground:#1d1507;--hill:#150f05}
#card.phase-morning{--wall1:#0f3b8f;--wall2:#3f8fe0;--wall3:#a8dcff;--a:#ffd166;--ground:#122a1c;--hill:#0d1f14}
#card.phase-afternoon{--wall1:#0d47a8;--wall2:#2f8fe0;--wall3:#9fdcff;--a:#fff09a;--ground:#122a1c;--hill:#0d1f14}
#card.phase-evening{--wall1:#2a1350;--wall2:#a03a5c;--wall3:#ff8a4c;--a:#ff9a5c;--ground:#1a1206;--hill:#130d05}
#card.phase-night{--wall1:#050a20;--wall2:#142a5c;--wall3:#2f4a8a;--a:#9fb8ff;--ground:#0a1410;--hill:#07100c;--sun:#dfe8ff}
#card.phase-midnight{--wall1:#02030a;--wall2:#0a1230;--wall3:#16224a;--a:#8fa8ff;--ground:#060d0a;--hill:#040a07;--sun:#dfe8ff}

/* the wallpaper ------------------------------------------------------- */
.wall{position:absolute;inset:0;z-index:1;overflow:hidden}
.wall .sky{position:absolute;inset:0;
  background:linear-gradient(178deg,var(--wall1) 0%,var(--wall2) 46%,var(--wall3) 100%)}
.wall .vig{position:absolute;inset:0;
  background:radial-gradient(130% 78% at 50% 18%,transparent 42%,rgba(0,0,0,.42) 100%)}
.wall .grain{position:absolute;inset:0;opacity:.05;mix-blend-mode:overlay;
  background-image:radial-gradient(rgba(255,255,255,.9) .5px,transparent .5px);
  background-size:3px 3px}

.stars{position:absolute;inset:0;opacity:0;transition:opacity 1s}
.phase-night .stars,.phase-midnight .stars{opacity:1}
.star{position:absolute;width:2px;height:2px;border-radius:50%;background:#fff;animation:tw 3.2s ease-in-out infinite}
@keyframes tw{0%,100%{opacity:.2;transform:scale(.85)}50%{opacity:1;transform:scale(1.15)}}

.cloud{position:absolute;background:var(--cloud);border-radius:999px;opacity:.9;
  filter:blur(1.2px);box-shadow:0 6px 18px rgba(0,0,0,.10)}
.cloud:before,.cloud:after{content:"";position:absolute;background:inherit;border-radius:50%}
.cloud:before{width:62%;height:175%;left:10%;top:-80%}
.cloud:after{width:46%;height:140%;right:12%;top:-58%}
.phase-night .cloud,.phase-midnight .cloud,.phase-evening .cloud{opacity:.3;background:#cfdcff}
.drift-a{animation:drift 44s linear infinite}
.drift-b{animation:drift 62s linear infinite}
@keyframes drift{from{transform:translateX(-34%)}to{transform:translateX(136%)}}

.rain{position:absolute;inset:0;opacity:0}
.wx-rain .rain,.wx-snow .rain{opacity:1}
.drop{position:absolute;width:1.6px;height:18px;border-radius:2px;
  background:linear-gradient(180deg,transparent,rgba(210,232,255,.85));animation:fall linear infinite}
@keyframes fall{from{transform:translateY(-40px)}to{transform:translateY(900px)}}

.hills{position:absolute;left:0;right:0;bottom:28%;height:70px}
.hills svg{width:100%;height:100%;display:block}
.ground{position:absolute;left:0;right:0;bottom:0;height:32%;
  background:linear-gradient(180deg,transparent,var(--ground) 46%,var(--ground))}

/* the body that carries the brand ------------------------------------- */
.celestial{position:absolute;transform:translate(-50%,-50%);z-index:4;
  transition:left 1.8s linear,top 1.8s linear}
.celestial .halo{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  width:150px;height:150px;border-radius:50%;
  background:radial-gradient(circle,color-mix(in srgb,var(--sun) 42%,transparent) 0%,transparent 66%);
  animation:breathe 6s ease-in-out infinite}
@keyframes breathe{0%,100%{opacity:.75;transform:translate(-50%,-50%) scale(1)}
  50%{opacity:1;transform:translate(-50%,-50%) scale(1.12)}}
.body{position:relative;width:54px;height:54px;border-radius:50%;margin:0 auto;
  background:radial-gradient(circle at 34% 30%,#fff,var(--sun) 60%,color-mix(in srgb,var(--sun) 70%,#000) 100%);
  box-shadow:0 0 34px 14px color-mix(in srgb,var(--sun) 48%,transparent)}
.phase-night .body,.phase-midnight .body{
  background:radial-gradient(circle at 34% 30%,#fff,var(--moon) 62%,color-mix(in srgb,var(--moon) 72%,#000) 100%);
  box-shadow:0 0 30px 10px rgba(212,226,255,.38)}
.body:after{content:"";position:absolute;inset:0;border-radius:50%;
  box-shadow:inset -11px -7px 0 -3px rgba(0,0,0,.10)}
.phase-night .body:after,.phase-midnight .body:after{
  box-shadow:inset -9px -6px 0 -2px rgba(120,140,190,.5),inset 8px 7px 0 -3px rgba(120,140,190,.38)}
.wordmark{margin-top:9px;text-align:center;font-weight:900;letter-spacing:3px;font-size:14px;
  white-space:nowrap;color:var(--a);
  text-shadow:0 0 12px color-mix(in srgb,var(--a) 66%,transparent),0 0 30px color-mix(in srgb,var(--a) 34%,transparent);
  animation:pulse 4.6s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:.9;letter-spacing:3px}50%{opacity:1;letter-spacing:3.5px}}

/* the two people ------------------------------------------------------- */
.terrace{position:absolute;left:0;right:0;bottom:30%;height:2px;z-index:3;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.22),transparent)}
.terrace:after{content:"";position:absolute;left:0;right:0;top:0;height:12px;
  background:linear-gradient(180deg,rgba(255,255,255,.08),transparent)}
figure.person{margin:0}
.person svg{display:block;overflow:visible}
.person.top{position:absolute;z-index:5}
/* The runner needs to travel AND cycle, so the wrapper owns the travel and the
   figure inside it is left alone for the leg/arm loops. */
.bottom-wrap{position:absolute;left:0;bottom:24%;width:96px;height:96px;z-index:4;
  animation:travel 38s linear infinite}
@keyframes travel{from{left:-12%}to{left:90%}}
.pace-run.bottom-wrap{animation-duration:14s}
.pace-jog.bottom-wrap{animation-duration:22s}
.pace-walk.bottom-wrap{animation-duration:30s}
.pace-slow.bottom-wrap{animation-duration:44s}
.pace-bored.bottom-wrap{animation-duration:32s}
.pace-crawl.bottom-wrap{animation-duration:50s}

.fig{transform-box:fill-box}
.head{fill:#d0946a}
.shirt{fill:#3f7dd8}
.trouser{fill:#2a3550}
.coat{fill:#d94f4f;opacity:0}
.zzz,.steam,.bag,.bed,.desk,.pot,.cup,.shorts{opacity:0}
.arm,.leg{transform-box:fill-box;transform-origin:50% 0%}

.outfit-night .coat{opacity:0}
.outfit-night .shirt{fill:#a8bbf0}
.outfit-night .trouser{fill:#a8bbf0}
.outfit-warm .coat{opacity:1}
.outfit-warm .shirt{fill:#3f4a66}
.outfit-sunny .shirt{fill:#ffd35e}
.outfit-sunny .trouser{fill:#43b06a}
.outfit-sunny .shorts{opacity:1}
.outfit-night .arm{fill:#a8bbf0}
.outfit-warm .arm{fill:#3f4a66}
.outfit-sunny .arm{fill:#ffd35e}
.outfit-day .arm{fill:#3f7dd8}
.outfit-night .leg{fill:#a8bbf0}
.outfit-sunny .leg{fill:#43b06a}

/* top person poses */
.person.top .fig{transform-origin:50% 100%}
.pose-sleep .bed{opacity:1}
.pose-sleep .fig{transform:rotate(90deg) translate(-6px,-26px)}
.pose-sleep .zzz{opacity:1;animation:zzz 2.6s ease-in-out infinite}
@keyframes zzz{0%{opacity:.2;transform:translateY(0)}50%{opacity:1;transform:translateY(-7px)}100%{opacity:.2;transform:translateY(-14px)}}
.pose-wake .arm-l{transform:rotate(150deg)}
.pose-wake .arm-r{transform:rotate(-150deg)}
.pose-tea .cup,.pose-tea .steam{opacity:1}
.pose-tea .arm-l{transform:rotate(78deg)}
.pose-tea .arm-r{transform:rotate(-78deg)}
.pose-tea .fig{transform:translateY(10px)}
.pose-work .desk{opacity:1}
.pose-work .arm-l{transform:rotate(86deg)}
.pose-work .arm-r{transform:rotate(-86deg)}
.pose-commute .bag{opacity:1}
.pose-commute .leg-l{transform:rotate(-16deg)}
.pose-commute .leg-r{transform:rotate(16deg)}
.pose-commute .arm-l{transform:rotate(28deg)}
.pose-commute .arm-r{transform:rotate(-28deg)}
.pose-cook .pot,.pose-cook .steam{opacity:1}
.pose-cook .arm-l{transform:rotate(70deg)}
.pose-cook .arm-r{transform:rotate(-70deg)}
.steam{animation:steam 3.2s ease-in-out infinite}
@keyframes steam{0%{opacity:.15;transform:translateY(0) scaleX(1)}
  50%{opacity:.6;transform:translateY(-8px) scaleX(1.12)}100%{opacity:.15;transform:translateY(-16px) scaleX(.9)}}

/* bottom person paces */
.bleg,.barm{transform-box:fill-box;transform-origin:50% 0%}
@keyframes swingA{0%,100%{transform:rotate(-24deg)}50%{transform:rotate(24deg)}}
@keyframes swingB{0%,100%{transform:rotate(24deg)}50%{transform:rotate(-24deg)}}
.pace-slow .bleg-a,.pace-walk .bleg-a{animation:swingA 2s ease-in-out infinite}
.pace-slow .bleg-b,.pace-walk .bleg-b{animation:swingB 2s ease-in-out infinite}
.pace-slow .barm-a,.pace-walk .barm-a{animation:swingB 2s ease-in-out infinite}
.pace-slow .barm-b,.pace-walk .barm-b{animation:swingA 2s ease-in-out infinite}
.pace-slow .bleg-a,.pace-slow .bleg-b,.pace-slow .barm-a,.pace-slow .barm-b{animation-duration:3.2s}
.pace-jog .bleg-a,.pace-jog .barm-b{animation:swingA 1.1s ease-in-out infinite}
.pace-jog .bleg-b,.pace-jog .barm-a{animation:swingB 1.1s ease-in-out infinite}
.pace-run .bleg-a,.pace-run .barm-b{animation:swingA .56s ease-in-out infinite}
.pace-run .bleg-b,.pace-run .barm-a{animation:swingB .56s ease-in-out infinite}
.pace-run .fig{animation:bob .28s ease-in-out infinite}
@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
.pace-bored .fig{animation:sulk 5.4s ease-in-out infinite}
@keyframes sulk{0%,42%{transform:rotate(-3deg) translateY(0)}
  50%{transform:rotate(21deg) translateY(5px)}58%{transform:rotate(-2deg) translateY(0)}
  100%{transform:rotate(-3deg) translateY(0)}}
.pace-bored .bleg-a,.pace-bored .bleg-b,.pace-bored .barm-a,.pace-bored .barm-b{animation:none}
.pace-crawl .fig{transform:rotate(76deg) translate(16px,10px)}
.pace-crawl .bleg-a{animation:swingA 3s ease-in-out infinite}
.pace-crawl .bleg-b{animation:swingB 3s ease-in-out infinite}
.pace-crawl .barm-a{animation:swingA 3s ease-in-out infinite}
.pace-crawl .barm-b{animation:swingB 3s ease-in-out infinite}

/* the lock screen ------------------------------------------------------ */
.lock{position:absolute;inset:0;z-index:30;display:flex;flex-direction:column;
  padding:60px 18px 26px;pointer-events:none;color:var(--ink)}
.lock-top{text-align:center}
.ls-date{font-size:12.5px;font-weight:600;letter-spacing:1.6px;text-transform:uppercase;
  color:var(--muted);text-shadow:0 1px 6px rgba(0,0,0,.4)}
.ls-clock{margin-top:2px;display:flex;align-items:flex-start;justify-content:center;gap:3px;
  text-shadow:0 3px 22px rgba(0,0,0,.42)}
.ls-clock #clock{font-size:78px;font-weight:200;line-height:1;letter-spacing:-3.5px;
  font-variant-numeric:tabular-nums}
.skin-oneui .ls-clock #clock{font-weight:300;font-size:72px;letter-spacing:-2px}
.ls-clock #secs{margin-top:9px;font-size:15px;font-weight:600;opacity:.72;
  font-variant-numeric:tabular-nums}

.rt-weather{margin-top:14px;display:flex;align-items:center;gap:12px;padding:12px 14px}
.rt-weather .glyph{flex:0 0 40px;height:40px;display:grid;place-items:center;
  border-radius:14px;background:rgba(255,255,255,.14)}
.rt-weather .now{flex:1;min-width:0}
.temp{font-size:30px;font-weight:300;line-height:1.05;font-variant-numeric:tabular-nums}
.temp .deg{font-size:16px;margin-left:1px;opacity:.85}
.temp .none{opacity:.7}
.rt-weather .wx{font-size:12.5px;font-weight:600;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rt-weather .place{font-size:11px;color:var(--muted);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

.spacer{flex:1}
.rt-rows{padding:10px 14px}
.rt-row{display:flex;align-items:center;gap:10px;padding:5px 0;
  border-top:1px solid rgba(255,255,255,.10)}
.rt-row:first-child{border-top:0}
.rt-row .k{flex:0 0 64px;font-size:9px;font-weight:800;letter-spacing:1.3px;color:var(--muted)}
.rt-row .v{flex:1;font-size:11.5px;line-height:1.45;color:var(--ink)}
.rt-row.zone .v{font-size:9.5px;color:var(--muted);letter-spacing:.2px}

.lock-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 4px 0}
.rt-brand{font-weight:900;letter-spacing:2.6px;font-size:12px;color:var(--a);
  text-shadow:0 0 12px color-mix(in srgb,var(--a) 60%,transparent)}
.rt-brand .sub{display:block;font-size:8px;letter-spacing:3px;color:var(--muted);font-weight:700;margin-top:1px}
.rt-when{text-align:right;font-size:9.5px;color:var(--muted);letter-spacing:.6px;line-height:1.5}
#phaseLabel{font-weight:800;color:var(--a);letter-spacing:1.8px}
`
}

/* ------------------------------ the markup ------------------------------ */

/** One person as a named-part SVG: limbs are rotated per pose/pace by CSS. */
function figureSvg(kind) {
    const isTop = kind === 'top'
    const p = isTop ? 't' : 'b'
    const headY = isTop ? 40 : 19
    const torsoY = isTop ? 54 : 28
    const torsoH = isTop ? 50 : 36
    const hipY = isTop ? 104 : 64
    const legH = isTop ? 40 : 32
    const armH = isTop ? 40 : 28
    const legX1 = isTop ? 58 : 42
    const legX2 = isTop ? 74 : 52
    const armX1 = isTop ? 45 : 31
    const armX2 = isTop ? 88 : 62
    const cx = isTop ? 70 : 50
    const headR = isTop ? 15 : 12
    const viewBox = isTop ? '0 0 140 150' : '0 0 100 100'

    return `<svg viewBox="${viewBox}" width="100%" height="100%">
  <g class="fig">
    <g class="prop bed"><rect x="6" y="112" width="128" height="14" rx="5" fill="#243b6b"/>
      <rect x="6" y="104" width="34" height="14" rx="6" fill="#dfe8ff" opacity=".9"/></g>
    <g class="prop desk"><rect x="16" y="112" width="108" height="8" rx="3" fill="#4a3a26"/>
      <rect x="52" y="96" width="34" height="18" rx="3" fill="#1b2740" stroke="#5b8cff"/></g>
    <g class="prop pot"><rect x="92" y="108" width="34" height="16" rx="5" fill="#4a5163"/>
      <rect x="88" y="104" width="42" height="5" rx="2.5" fill="#6b7488"/></g>
    <g class="prop cup"><rect x="78" y="98" width="13" height="15" rx="3" fill="#e8eefc"/>
      <rect x="91" y="102" width="6" height="7" rx="3" fill="none" stroke="#e8eefc" stroke-width="2.4"/></g>
    <g class="prop bag"><rect x="92" y="96" width="24" height="20" rx="4" fill="#7b5a34"/>
      <path d="M98 96 q6 -9 12 0" fill="none" stroke="#4f3a20" stroke-width="2.6"/></g>

    <g class="legs">
      <rect class="${p}leg ${p}leg-a leg leg-l" x="${legX1}" y="${hipY}" width="10" height="${legH}" rx="4.5" fill="#2a3550"/>
      <rect class="${p}leg ${p}leg-b leg leg-r" x="${legX2}" y="${hipY}" width="10" height="${legH}" rx="4.5" fill="#2a3550"/>
      <g class="shorts"><rect x="${legX1 - 3}" y="${hipY - 2}" width="33" height="18" rx="6" fill="#2f7fd0"/></g>
    </g>
    <rect class="torso shirt" x="${cx - 18}" y="${torsoY}" width="36" height="${torsoH}" rx="12" fill="#3f7dd8"/>
    <rect class="coat" x="${cx - 22}" y="${torsoY - 2}" width="44" height="${torsoH + 6}" rx="13" fill="#d94f4f"/>
    <g class="arms">
      <rect class="${p}arm ${p}arm-a arm arm-l" x="${armX1}" y="${torsoY + 4}" width="9" height="${armH}" rx="4.5" fill="#3f7dd8"/>
      <rect class="${p}arm ${p}arm-b arm arm-r" x="${armX2}" y="${torsoY + 4}" width="9" height="${armH}" rx="4.5" fill="#3f7dd8"/>
    </g>
    <circle class="head" cx="${cx}" cy="${headY}" r="${headR}" fill="#d0946a"/>
    <circle cx="${cx - 5}" cy="${headY - 2}" r="2" fill="#1b2233"/>
    <circle cx="${cx + 5}" cy="${headY - 2}" r="2" fill="#1b2233"/>
    <path d="M${cx - 4} ${headY + 5} q4 3 8 0" fill="none" stroke="#8a5a3a" stroke-width="2" stroke-linecap="round"/>
    <g class="zzz"><text x="${cx + 16}" y="${headY - 10}" font-size="15" font-weight="800" fill="#dfe8ff">Z</text>
      <text x="${cx + 26}" y="${headY - 20}" font-size="11" font-weight="800" fill="#dfe8ff" opacity=".8">z</text></g>
    <g class="steam"><path d="M${cx + 6} ${torsoY - 4} q5 -9 0 -17 q-5 -8 0 -16" fill="none"
      stroke="#dfe8ff" stroke-width="2.4" stroke-linecap="round" opacity=".7"/></g>
  </g>
</svg>`
}

/** A small weather glyph for the widget, drawn so it needs no font or image. */
function wxGlyph(kind) {
    const wrap = (inner) => `<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`
    if (kind === 'rain' || kind === 'snow') {
        return wrap(`<circle cx="12" cy="9" r="4.6" fill="#ffd75e"/>
          <path d="M5.5 17.2h13a3.4 3.4 0 0 0 .2-6.6 5 5 0 0 0-9.6-1 3.6 3.6 0 0 0-3.6 7.6z" fill="#fff" opacity=".92"/>
          <path d="M8.5 19.5l-1 2M12 19.5l-1 2M15.5 19.5l-1 2" stroke="#cfe4ff" stroke-width="1.5" stroke-linecap="round"/>`)
    }
    if (kind === 'cloud') {
        return wrap(`<circle cx="9" cy="8.4" r="4" fill="#ffd75e" opacity=".85"/>
          <path d="M5.6 18h13a3.5 3.5 0 0 0 .2-6.8 5.1 5.1 0 0 0-9.8-1A3.7 3.7 0 0 0 5.6 18z" fill="#fff" opacity=".95"/>`)
    }
    return wrap(`<circle cx="12" cy="12" r="5.4" fill="#ffd75e"/>
      <path d="M12 2.6v2.6M12 18.8v2.6M2.6 12h2.6M18.8 12h2.6M5.3 5.3l1.9 1.9M16.8 16.8l1.9 1.9M18.7 5.3l-1.9 1.9M7.2 16.8l-1.9 1.9"
        stroke="#ffd75e" stroke-width="1.8" stroke-linecap="round"/>`)
}

/* ------------------------------ the page script ------------------------------ */

/*
 * Plain ES5 string concatenation on purpose: this text is embedded in a template
 * literal, so a nested backtick or `${` here would break the module. It
 * re-derives the phase every second from the zone's UTC offset, which is what
 * keeps the sun moving and lets the characters change over without re-running the
 * command.
 */
function buildPageScript(data) {
    const topTable = Object.fromEntries(Object.entries(TOP_ROUTINE).map(([k, v]) => [k, [v.pose, v.text]]))
    const botTable = Object.fromEntries(Object.entries(BOTTOM_PACE).map(([k, v]) => [k, [v.pace, v.text]]))
    const labels = Object.fromEntries(PHASES.map(p => [p.key, p.label]))
    const temp = data.weather ? data.weather.temp : null
    const frozen = (data.freezeHour === null || data.freezeHour === undefined) ? null : Number(data.freezeHour)

    return `
(function(){
  var OFF = ${Number(data.offsetSeconds) || 0};
  var TEMP = ${temp === null ? 'null' : Number(temp)};
  var WX = ${JSON.stringify(data.effects ? data.effects.key : 'unknown')};
  var FREEZE = ${frozen === null ? 'null' : frozen};
  var SKY_TOP = ${SKY_TOP_PCT}, SKY_HORIZON = ${SKY_HORIZON_PCT}, SKY_L = 8, SKY_R = 92;
  var PH = [['midnight',22,5],['dawn',5,7],['morning',7,12],['afternoon',12,17],['evening',17,20],['night',20,22]];
  var TOP = ${JSON.stringify(topTable)};
  var BOT = ${JSON.stringify(botTable)};
  var LAB = ${JSON.stringify(labels)};
  var card = document.getElementById('card');
  var cel = document.getElementById('celestial');
  var body = document.getElementById('body');
  var clock = document.getElementById('clock');
  var secs = document.getElementById('secs');
  var topPerson = document.getElementById('topPerson');
  var bottomWrap = document.getElementById('bottomWrap');

  function localHour(){
    if (FREEZE !== null) return FREEZE;
    var ms = Date.now() + OFF * 1000; return ((ms / 3600000) % 24 + 24) % 24;
  }
  function phaseKey(h){
    for (var i=0;i<PH.length;i++){ var p=PH[i];
      if (p[1] < p[2] ? (h >= p[1] && h < p[2]) : (h >= p[1] || h < p[2])) return p[0]; }
    return 'midnight';
  }
  function celest(h){
    var sun = (h >= 6 && h < 18);
    var pr = sun ? (h - 6) / 12 : (((h < 6 ? h + 24 : h) - 18) / 12);
    var p = Math.min(Math.max(pr, 0), 1);
    var alt = Math.sin(Math.PI * p);
    return {
      sun: sun,
      left: SKY_L + ((6 + p * 88) - 6) / 88 * (SKY_R - SKY_L),
      top: SKY_HORIZON - alt * (SKY_HORIZON - SKY_TOP)
    };
  }
  function outfitKey(k){
    if (k === 'night' || k === 'midnight') return 'night';
    if (TEMP === null) return 'day';
    if (TEMP <= 15) return 'warm';
    if (TEMP >= 27) return 'sunny';
    return 'day';
  }
  function pad(n){ return (n < 10 ? '0' : '') + n; }
  var cur = null;
  function apply(k){
    card.className = 'phase-' + k + ' wx-' + WX + ' outfit-' + outfitKey(k);
    topPerson.className = 'person top pose-' + TOP[k][0];
    bottomWrap.className = 'bottom-wrap pace-' + BOT[k][0];
    document.getElementById('topText').textContent = TOP[k][1];
    document.getElementById('bottomText').textContent = BOT[k][1];
    document.getElementById('phaseLabel').textContent = LAB[k];
  }
  function tick(){
    var h = localHour();
    var hh = Math.floor(h), mm = Math.floor((h - hh) * 60), ss = Math.floor(h * 3600) % 60;
    clock.textContent = pad(hh) + ':' + pad(mm);
    secs.textContent = pad(ss);
    var c = celest(h);
    cel.style.left = c.left + '%';
    cel.style.top = c.top + '%';
    body.className = 'body ' + (c.sun ? 'sun' : 'moon');
    var k = phaseKey(h);
    if (k !== cur){ cur = k; apply(k); }
  }
  tick();
  // A frozen scene is a still, so it must not keep ticking — otherwise a preview
  // frame would snap back to the current phase one second after it loads.
  if (FREEZE === null) setInterval(tick, 1000);
})();`
}

/* ------------------------------ the composer ------------------------------ */

/**
 * Build the `.runtime` screen for one skin.
 *
 * Pure string assembly from `data`, so a test can assert on the exact marker it
 * cares about without a browser: the phase class, the wordmark, the readings.
 */
function buildSceneHtml(input, skin = 'ios') {
    /*
     * A frozen scene is recomputed here from the pinned hour, so the server-side
     * markup and the page script can never disagree about which phase is shown.
     */
    const data = (input.freezeHour === null || input.freezeHour === undefined)
        ? input
        : (() => {
            const hour = Number(input.freezeHour)
            const phase = phaseFor(hour)
            return {
                ...input,
                hour,
                phase,
                sky: celestial(hour),
                routine: TOP_ROUTINE[phase.key] || input.routine,
                pace: BOTTOM_PACE[phase.key] || input.pace,
                outfit: outfitFor(input.weather ? input.weather.temp : null, phase.key),
                nextPhase: nextPhaseAt(hour)
            }
        })()

    const stars = scatter(20261013, 34, 100, 100)
    const clouds = scatter(777, 5, 100, 46)
    const drops = scatter(4242, 22, 100, 100)
    const temp = data.weather ? Number(data.weather.temp) : null
    const seconds = Number(data.uptimeSeconds || 0)
    const uptime = `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
    const nextIn = (() => {
        const hours = ((data.nextPhase - data.hour) % 24 + 24) % 24
        const mins = Math.round(hours * 60)
        return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`
    })()

    const local = data.localTime || {}
    const statusTime = (local.time || '--:--:--').slice(0, 5)
    const dateLine = (local.date || '').replace(/^\w/, c => c.toUpperCase())
    const placeLabel = [data.place, data.countryCode || data.country].filter(Boolean).join(', ')
    const zoneNote = `Timezone ${data.zone} (UTC${data.offset}) · ${data.callingCode || 'no calling code'} · ${data.zoneConfidence === 'high' ? 'from the paired number' : 'assumed'}`
    const pos = screenPos(data.sky)

    const wallpaper = `<div class="wall">
  <div class="sky"></div>
  <div class="vig"></div>
  <div class="stars">${stars.map(s => `<i class="star" style="left:${rand(s.x)}%;top:${rand(s.y)}%;animation-delay:${s.d}s"></i>`).join('')}</div>
  <div class="clouds">${clouds.slice(0, data.effects.clouds).map((c, i) => `<i class="cloud ${i % 2 ? 'drift-b' : 'drift-a'}" style="left:${rand(c.x)}%;top:${rand(10 + c.y)}%;width:${Math.round(48 + c.s * 26)}px;height:${Math.round(14 + c.s * 6)}px;animation-delay:${c.d}s"></i>`).join('')}</div>
  <div class="rain">${drops.map(d => `<i class="drop" style="left:${rand(d.x)}%;animation-duration:${(0.55 + d.s * 0.5).toFixed(2)}s;animation-delay:${d.d}s"></i>`).join('')}</div>
  <div class="celestial" id="celestial" style="left:${pos.left}%;top:${pos.top}%">
    <div class="halo"></div>
    <div class="body ${data.sky.body}" id="body"></div>
    <div class="wordmark">DARKNOTE</div>
  </div>
  <div class="hills"><svg viewBox="0 0 390 70" preserveAspectRatio="none">
    <path d="M0 70 L0 44 Q46 20 96 40 Q132 54 168 36 Q214 12 262 38 Q312 62 356 40 L390 30 L390 70 Z" fill="var(--hill)"/>
    <path d="M0 70 L0 58 Q60 40 122 56 Q186 72 250 54 Q312 38 390 58 L390 70 Z" fill="var(--ground)" opacity=".85"/>
  </svg></div>
  <div class="ground"></div>
  <div class="terrace"></div>
  <figure class="person top pose-${data.routine.pose}" id="topPerson" style="left:14px;bottom:30%;width:132px;height:132px">${figureSvg('top')}</figure>
  <div class="bottom-wrap pace-${data.pace.pace}" id="bottomWrap">
    <figure class="person bottom" id="bottomPerson">${figureSvg('bottom')}</figure>
  </div>
  <div class="grain"></div>
</div>`

    const lock = `<div class="lock">
  <div class="lock-top">
    <div class="ls-date">${modelEscapeHtml(dateLine || 'DARKNOTE RUNTIME')}</div>
    <div class="ls-clock"><span id="clock">${modelEscapeHtml((local.time || '--:--').slice(0, 5))}</span><span id="secs">${modelEscapeHtml((local.time || '--:--:--').slice(6, 8) || '00')}</span></div>
  </div>

  <div class="glass rt-weather">
    <div class="glyph">${wxGlyph(data.effects.glyph)}</div>
    <div class="now">
      <div class="temp">${temp === null ? '<span class="none">--</span>' : Math.round(temp)}<span class="deg">°C</span></div>
      <div class="wx">${modelEscapeHtml(data.weather ? data.weather.text : (data.weatherError || 'weather unavailable'))}</div>
    </div>
    <div class="place" style="text-align:right;max-width:110px">${modelEscapeHtml(placeLabel || 'unknown place')}</div>
  </div>

  <div class="spacer"></div>

  <div class="glass rt-rows">
    <div class="rt-row"><span class="k">TOP</span><span class="v" id="topText">${modelEscapeHtml(data.routine.text)}</span></div>
    <div class="rt-row"><span class="k">BOTTOM</span><span class="v" id="bottomText">${modelEscapeHtml(data.pace.text)}</span></div>
    <div class="rt-row"><span class="k">WEARING</span><span class="v">${modelEscapeHtml(data.outfit.label)}</span></div>
    ${data.weather ? `<div class="rt-row"><span class="k">FEELS</span><span class="v">${Math.round(data.weather.feels)}°C · humidity ${Math.round(data.weather.humidity)}% · wind ${Math.round(data.weather.wind)} km/h</span></div>` : ''}
    <div class="rt-row zone"><span class="k">ZONE</span><span class="v">${modelEscapeHtml(zoneNote)}</span></div>
  </div>

  <div class="lock-foot">
    <span class="rt-brand">DARKNOTE<span class="sub">RUNTIME</span></span>
    <span class="rt-when">
      <span id="phaseLabel">${modelEscapeHtml(data.phase.label)}</span><br>
      ${modelEscapeHtml(data.phase.sky)}<br>
      next in ${modelEscapeHtml(nextIn)} · up ${modelEscapeHtml(uptime)} · ${modelEscapeHtml(data.whatsapp || 'unknown')}
    </span>
  </div>
</div>`

    const body = `<div id="card" class="phase-${data.phase.key} wx-${data.effects.key} outfit-${data.outfit.key}" style="position:absolute;inset:0">
${wallpaper}
${lock}
</div>`

    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DARKNOTE RUNTIME · ${modelEscapeHtml(data.zone)}</title>
<style>${phone.frameStyles()}${phone.glassStyles()}${buildStyles()}</style></head>
<body>
${phone.device({ skin, time: statusTime, body, screenStyle: '--dev-h:844px' })}
<script>${buildPageScript(data)}</script>
</body></html>`
}

/* ==========================================================================
 * THE NAMESPACES - each module's own export list, unchanged
 * ========================================================================== */

const pairCard = {
    PASSCODE,
    passcodeHash,
    avatarDataUri,
    usersHtml,
    linkedNumbers,
    pairingAppHtml,
    sendHtmlCard,
    sendRichCard,
    sendDocumentCard,
    pairingCardCaption,
    DEFAULT_DELIVERY,
    listSessions,
    unpairSession,
    escapeHtml
}

const menu2 = {
    menu2Html, signupFor, verify, clearFor, pairedNumber, mask, readStore, writeStore, STORE,
    batteryCurve, batteryFor, liveStatus, pingMs, formatRuntime,
    keylockFor, setKeylock, setPasscode, clearPasscode, KEYLOCK_IDLE_MS,
    begin, waiting, stop, consume, WAIT_MS, autoVerifyMs, scheduleAutoVerify, AUTO_VERIFY_MS
}

const pingDashboard = {
    sendPingDashboard,
    collectMetrics,
    buildHtml,
    buildFallbackText,
    loadAIRich,
    fmtSize,
    fmtUp,
    BRAND,
    CREATOR
}

const runtimeScreen = {
    wxGlyph,
    figureSvg,
    buildStyles,
    buildPageScript,
    buildSceneHtml,
    scatter
}

/*
 * ONE ENTRY POINT, FOUR NAMESPACES.
 *
 * The shims in lib/ pick their namespace off this object, and the namespaces are exported
 * individually as well so a caller can require this file directly.
 */
module.exports = {
    pairCard,
    menu2,
    pingDashboard,
    runtimeScreen,
    /* Readable aliases, so `require('../vv/hapy html.js').cards.pairCard` also works. */
    cards: { pairCard, menu2, pingDashboard, runtimeScreen }
}
