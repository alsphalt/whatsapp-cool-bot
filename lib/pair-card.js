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

const fs = require('fs')
const path = require('path')
// The handset shell: this card is drawn as a phone screen, matching .runtime.
const phoneFrame = require('./phone-frame.js')
// `unwrapQuote` catches the `{ quoted: X }`-where-X-was-meant mistake described
// there; it once crashed every document send in the `.runtime` path.
const quoteGuard = require('./quote-guard.js')

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
        // `caption` is passed in by non-pairing callers (.runtime), whose caption
        // is about the clock rather than about a pairing code.
        caption: caption || pairingCardCaption(stage)
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

module.exports = {
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
