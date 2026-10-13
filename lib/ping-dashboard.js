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

const os = require('os')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

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

const escapeHtml = (value) => String(value == null ? '' : value)
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
        `🌐 Net: ${escapeHtml(metrics.net.iface)} · ↓ ${fmtSize(metrics.net.rx)} · ↑ ${fmtSize(metrics.net.tx)}`,
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
        <div>🕯️ <b>${escapeHtml(botLabel)}</b></div>
        <div>${escapeHtml(metrics.creator)}</div>
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

module.exports = {
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
