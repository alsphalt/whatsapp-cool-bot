'use strict'

/*
 * PHONE DISPLAY CHROME
 * -------------------
 * Shared shell for the `.pair` card and the `.runtime` scene, so both look like a
 * real handset screen instead of a floating web page.
 *
 * Two skins, because the owner asked for "a samsung and iphone display":
 *
 *   ios    -> iPhone: dynamic island, 54px corners, hairline status glyphs,
 *             thin (weight 200) lock-screen clock.
 *   oneui  -> Samsung One UI: centred punch-hole camera, tighter 44px corners,
 *             slightly heavier clock, softer glass.
 *
 * The chrome is pure decoration and is deliberately `pointer-events:none`, so it
 * can never swallow a tap meant for the passcode keypad or a card control. Every
 * skin difference is a CSS custom property or a class, so the markup is identical
 * for both and a test can assert on one shape.
 *
 * Nothing here knows about pairing or weather — callers pass their own screen
 * body and place the chrome on top of it.
 */

const SKINS = {
    ios: { key: 'ios', label: 'iPhone', chrome: 'island' },
    oneui: { key: 'oneui', label: 'Galaxy', chrome: 'punch' }
}

/** Which skins to render for a `runtimeSkin` config value. */
function resolveSkins(value) {
    const wanted = String(value || '').trim().toLowerCase()
    if (wanted === 'both' || wanted === '') return ['ios', 'oneui']
    if (SKINS[wanted]) return [wanted]
    // Anything unrecognised falls back to both rather than rendering nothing.
    return ['ios', 'oneui']
}

/**
 * CSS for the handset shell. `--dev-w` and `--dev-h` let a caller pin the screen
 * size (the lock screen does) or let it grow with content (the pairing app does).
 */
function frameStyles() {
    return `
.device{
  /* --sb-h is the status-bar band the chrome occupies at the top of the screen.
     It is published as a custom property because the chrome is painted OVER the
     screen body: any caller whose content starts at the top edge (the pairing
     panel does) has to keep clear of it, and hard-coding 52px there as well
     would let the two drift apart. */
  --sb-h:52px;
  --dev-r:54px; --dev-w:390px; --dev-bg:#000;
  width:var(--dev-w); max-width:100%; margin:0 auto; padding:6px;
  border-radius:var(--dev-r); position:relative;
  background:linear-gradient(155deg,#4b5364 0%,#20252f 26%,#0d1015 62%,#070910 100%);
  box-shadow:0 30px 70px rgba(0,0,0,.75),0 2px 0 rgba(255,255,255,.10) inset,
             0 -2px 0 rgba(0,0,0,.6) inset,0 0 0 1px rgba(255,255,255,.05)
}
.skin-oneui{--dev-r:46px}
.device .screen{
  position:relative; width:100%; overflow:hidden; background:var(--dev-bg);
  border-radius:calc(var(--dev-r) - 5px); isolation:isolate;
  height:var(--dev-h,auto); min-height:var(--dev-min-h,0px)
}
/* side buttons, so the frame reads as hardware */
.device:before,.device:after{content:"";position:absolute;width:3px;border-radius:3px;
  background:linear-gradient(180deg,#5a6273,#2a303c)}
.device:before{left:-3px;top:112px;height:58px;box-shadow:0 74px 0 #3a414f}
.device:after{right:-3px;top:150px;height:82px}

.statusbar{
  position:absolute;top:0;left:0;right:0;height:var(--sb-h,52px);z-index:70;pointer-events:none;
  display:flex;align-items:center;justify-content:space-between;padding:6px 26px 0;
  font:600 14px/1 -apple-system,"SF Pro Text","Segoe UI",system-ui,sans-serif;
  color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.45)
}
.skin-oneui .statusbar{font-size:13.5px;padding-left:30px;padding-right:22px}
.sb-right{display:flex;align-items:center;gap:5px}
.sb-right svg{display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.4))}

.island{position:absolute;top:13px;left:50%;transform:translateX(-50%);
  width:120px;height:34px;border-radius:20px;background:#000;z-index:80;pointer-events:none}
.skin-oneui .island{display:none}
.punch{display:none}
.skin-oneui .punch{display:block;position:absolute;top:16px;left:50%;transform:translateX(-50%);
  width:13px;height:13px;border-radius:50%;background:#000;z-index:80;pointer-events:none;
  box-shadow:0 0 0 1.5px rgba(255,255,255,.10)}

/* the home indicator every modern handset has */
.homebar{position:absolute;left:50%;bottom:9px;transform:translateX(-50%);
  width:132px;height:5px;border-radius:3px;background:rgba(255,255,255,.55);z-index:70;
  pointer-events:none}
.skin-oneui .homebar{width:110px;background:rgba(255,255,255,.42)}
`
}

/** Glass widget look, identical in both skins apart from the corner radius. */
function glassStyles() {
    return `
.glass{
  background:rgba(255,255,255,.155);
  -webkit-backdrop-filter:blur(20px) saturate(160%);backdrop-filter:blur(20px) saturate(160%);
  border:1px solid rgba(255,255,255,.20);border-radius:24px;
  box-shadow:0 10px 30px rgba(0,0,0,.28),0 1px 0 rgba(255,255,255,.24) inset
}
.skin-oneui .glass{background:rgba(255,255,255,.13);border-radius:28px;
  border-color:rgba(255,255,255,.16)}
`
}

/** Signal / wifi / battery, drawn rather than font-dependent. */
function statusIcons() {
    return `<span class="sb-right">
<svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor" aria-hidden="true">
  <rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="6" width="3" height="6" rx="1"/>
  <rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>
<svg width="17" height="12" viewBox="0 0 17 12" fill="none" stroke="currentColor" stroke-width="1.7"
     stroke-linecap="round" aria-hidden="true">
  <path d="M1 4.1a11 11 0 0 1 15 0"/><path d="M3.6 6.9a7.4 7.4 0 0 1 9.8 0"/>
  <circle cx="8.5" cy="10.2" r="1.1" fill="currentColor" stroke="none"/></svg>
<svg width="26" height="12" viewBox="0 0 26 12" aria-hidden="true">
  <rect x="0.6" y="0.6" width="21" height="10.8" rx="3.2" fill="none" stroke="currentColor"
        stroke-opacity=".55" stroke-width="1.1"/>
  <rect x="2.2" y="2.2" width="15" height="7.6" rx="1.9" fill="currentColor"/>
  <path d="M23.4 4.2v3.6a2 2 0 0 0 0-3.6z" fill="currentColor" fill-opacity=".6"/></svg>
</span>`
}

/**
 * Wrap a screen body in the handset.
 *
 * @param {object} o
 * @param {string} o.skin   'ios' | 'oneui'
 * @param {string} o.time   status-bar clock text
 * @param {string} o.body   the screen content (wallpaper, app, widgets)
 * @param {string} o.screenStyle  extra inline style for the screen element
 * @param {string} o.className    extra classes for the device
 */
function device({ skin = 'ios', time = '', body = '', screenStyle = '', className = '' }) {
    const s = SKINS[skin] ? skin : 'ios'
    return `<div class="device skin-${s} ${className}">
  <div class="screen"${screenStyle ? ` style="${screenStyle}"` : ''}>
${body}
    <div class="statusbar"><span class="sb-time">${time}</span>${statusIcons()}</div>
    <div class="island"></div><div class="punch"></div>
    <div class="homebar"></div>
  </div>
</div>`
}

/*
 * Split open/close, for callers that build their own screen body inline (the
 * pairing card does, because its stages are already a long template). `device()`
 * above is the same thing in one piece for callers that assemble a body string.
 */
function screenOpen({ skin = 'ios', screenStyle = '', className = '' } = {}) {
    const s = SKINS[skin] ? skin : 'ios'
    return `<div class="device skin-${s} ${className}">
  <div class="screen"${screenStyle ? ` style="${screenStyle}"` : ''}>`
}

function screenClose({ time = '' } = {}) {
    return `    <div class="statusbar"><span class="sb-time">${time}</span>${statusIcons()}</div>
    <div class="island"></div><div class="punch"></div>
    <div class="homebar"></div>
  </div>
</div>`
}

module.exports = {
    SKINS, resolveSkins, frameStyles, glassStyles, statusIcons,
    device, screenOpen, screenClose
}
