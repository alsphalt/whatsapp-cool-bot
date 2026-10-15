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

const phone = require('./phone-frame.js')
const model = require('./runtime-model.js')

const {
    PHASES, TOP_ROUTINE, BOTTOM_PACE,
    escapeHtml, phaseFor, nextPhaseAt, celestial, screenPos, outfitFor,
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
    <div class="ls-date">${escapeHtml(dateLine || 'DARKNOTE RUNTIME')}</div>
    <div class="ls-clock"><span id="clock">${escapeHtml((local.time || '--:--').slice(0, 5))}</span><span id="secs">${escapeHtml((local.time || '--:--:--').slice(6, 8) || '00')}</span></div>
  </div>

  <div class="glass rt-weather">
    <div class="glyph">${wxGlyph(data.effects.glyph)}</div>
    <div class="now">
      <div class="temp">${temp === null ? '<span class="none">--</span>' : Math.round(temp)}<span class="deg">°C</span></div>
      <div class="wx">${escapeHtml(data.weather ? data.weather.text : (data.weatherError || 'weather unavailable'))}</div>
    </div>
    <div class="place" style="text-align:right;max-width:110px">${escapeHtml(placeLabel || 'unknown place')}</div>
  </div>

  <div class="spacer"></div>

  <div class="glass rt-rows">
    <div class="rt-row"><span class="k">TOP</span><span class="v" id="topText">${escapeHtml(data.routine.text)}</span></div>
    <div class="rt-row"><span class="k">BOTTOM</span><span class="v" id="bottomText">${escapeHtml(data.pace.text)}</span></div>
    <div class="rt-row"><span class="k">WEARING</span><span class="v">${escapeHtml(data.outfit.label)}</span></div>
    ${data.weather ? `<div class="rt-row"><span class="k">FEELS</span><span class="v">${Math.round(data.weather.feels)}°C · humidity ${Math.round(data.weather.humidity)}% · wind ${Math.round(data.weather.wind)} km/h</span></div>` : ''}
    <div class="rt-row zone"><span class="k">ZONE</span><span class="v">${escapeHtml(zoneNote)}</span></div>
  </div>

  <div class="lock-foot">
    <span class="rt-brand">DARKNOTE<span class="sub">RUNTIME</span></span>
    <span class="rt-when">
      <span id="phaseLabel">${escapeHtml(data.phase.label)}</span><br>
      ${escapeHtml(data.phase.sky)}<br>
      next in ${escapeHtml(nextIn)} · up ${escapeHtml(uptime)} · ${escapeHtml(data.whatsapp || 'unknown')}
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
<title>DARKNOTE RUNTIME · ${escapeHtml(data.zone)}</title>
<style>${phone.frameStyles()}${phone.glassStyles()}${buildStyles()}</style></head>
<body>
${phone.device({ skin, time: statusTime, body, screenStyle: '--dev-h:844px' })}
<script>${buildPageScript(data)}</script>
</body></html>`
}

module.exports = {
    wxGlyph,
    figureSvg,
    buildStyles,
    buildPageScript,
    buildSceneHtml,
    scatter
}
