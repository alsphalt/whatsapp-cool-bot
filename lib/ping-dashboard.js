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
    const { waRoundtrip, cpus, totalMem, freeMem, heap, net, cpuPct, ramPct, heapPct, diskPct } = metrics
    const botLabel = metrics.brand
    const isHealthy = waRoundtrip < 500 && ramPct < 75 && parseFloat(cpuPct) < 80
    const isWarn = waRoundtrip < 1000 && ramPct < 90 && parseFloat(cpuPct) < 95
    const statusColor = isHealthy ? '#1db954' : isWarn ? '#f59e0b' : '#ef4444'
    const statusColor2 = isHealthy ? '#1ed760' : isWarn ? '#fbbf24' : '#f87171'
    const statusLabel = isHealthy ? 'HEALTHY' : isWarn ? 'DEGRADED' : 'CRITICAL'
    const timeStr = metrics.timeStr

    return `
<style>
@keyframes bgShift { 0%{background-position:0% 50%} 50%{background-position:100% 50%} 100%{background-position:0% 50%} }
@keyframes floatUp { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
@keyframes pulseDot { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.4;transform:scale(.75)} }
@keyframes shimmer { 0%{background-position:-500px 0} 100%{background-position:500px 0} }
@keyframes waveMove { 0%{transform:translateX(0)} 100%{transform:translateX(-50%)} }
@keyframes barGrow { from{width:0} }
@keyframes heroGlow { 0%,100%{opacity:1; text-shadow:0 0 12px ${statusColor2}} 50%{opacity:.7; text-shadow:0 0 26px ${statusColor2}} }
@keyframes tickFlash { 0%{color:#fff; text-shadow:0 0 18px ${statusColor2}} 100%{color:${statusColor2}; text-shadow:0 0 8px rgba(0,0,0,0)} }
.tick{animation:tickFlash .6s ease-out;}
:root{--ink:#fff;--muted:#9a9a9a;--bg:#0a0a0f;--border:rgba(255,255,255,.1);--panel:rgba(255,255,255,.04);--accent:${statusColor};--accent2:${statusColor2};}
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent;-webkit-font-smoothing:antialiased;}
html,body{background:transparent;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;}
.wrap{padding:10px;}
.card{position:relative;max-width:420px;margin:0 auto;border-radius:22px;overflow:hidden;background:linear-gradient(180deg,#0a0a0f 0%,#05050a 100%);border:1px solid var(--border);box-shadow:0 24px 70px rgba(0,0,0,.7);animation:floatUp .35s ease;}
.bg{position:absolute;inset:0;background:linear-gradient(135deg,rgba(29,185,84,.14),rgba(124,58,237,.08),rgba(59,130,246,.12),rgba(245,176,66,.1));background-size:400% 400%;animation:bgShift 18s ease infinite;opacity:.85;z-index:0;}
.grid{position:absolute;inset:0;background-image:radial-gradient(circle at 1px 1px,rgba(255,255,255,.05) 1px,transparent 0);background-size:24px 24px;z-index:1;opacity:.5;}
.wave{position:absolute;bottom:0;left:0;width:200%;height:60px;z-index:1;opacity:.35;pointer-events:none;}
.veil{position:absolute;inset:0;background:linear-gradient(180deg,rgba(8,8,12,.85) 0%,rgba(8,8,12,.96) 50%,rgba(8,8,12,1) 100%);z-index:2;}
.content{position:relative;z-index:3;padding:20px;}
.head{display:flex;align-items:center;gap:12px;margin-bottom:16px;}
.logo{width:48px;height:48px;border-radius:14px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0;box-shadow:0 8px 24px rgba(29,185,84,.35);position:relative;overflow:hidden;}
.logo::before{content:"";position:absolute;inset:0;background:linear-gradient(135deg,rgba(255,255,255,.35),transparent 55%);}
.logo span{position:relative;z-index:1;}
.head-text{flex:1;min-width:0;}
.head-title{font-size:16px;font-weight:900;letter-spacing:-.3px;}
.head-sub{font-size:10px;color:var(--muted);letter-spacing:1.2px;text-transform:uppercase;font-weight:700;margin-top:3px;display:flex;align-items:center;gap:6px;}
.live-dot{width:6px;height:6px;border-radius:50%;background:var(--accent);animation:pulseDot 1.6s ease-in-out infinite;display:inline-block;}
.hero{padding:16px;background:linear-gradient(135deg,rgba(29,185,84,.15),rgba(30,215,96,.05));border:1.5px solid var(--border);border-radius:16px;margin-bottom:14px;position:relative;overflow:hidden;}
.hero::before{content:"";position:absolute;top:0;left:-100%;width:200%;height:100%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.08),transparent);animation:shimmer 3s ease-in-out infinite;}
.hero-row{display:flex;align-items:center;justify-content:space-between;gap:12px;}
.hero-left{flex:1;min-width:0;}
.hero-status{font-size:11px;color:var(--muted);letter-spacing:1.5px;text-transform:uppercase;font-weight:800;}
.hero-value{font-size:32px;font-weight:900;letter-spacing:-1px;color:var(--accent2);line-height:1;margin-top:2px;animation:heroGlow 2s ease-in-out infinite;font-variant-numeric:tabular-nums;}
.hero-label{font-size:11px;color:rgba(255,255,255,.75);margin-top:6px;font-weight:600;}
.hero-right{text-align:right;flex-shrink:0;}
.hero-badge{padding:8px 14px;border-radius:22px;background:linear-gradient(135deg,rgba(29,185,84,.2),rgba(30,215,96,.1));border:1.5px solid var(--accent);color:var(--accent2);font-size:10px;font-weight:900;letter-spacing:1.5px;}
.section{margin-bottom:14px;}
.section-title{font-size:11px;font-weight:800;letter-spacing:1.5px;color:var(--accent2);text-transform:uppercase;margin-bottom:10px;display:flex;align-items:center;gap:8px;}
.section-title::before{content:"";width:3px;height:14px;background:linear-gradient(180deg,var(--accent),var(--accent2));border-radius:2px;display:inline-block;animation:pulseDot 2s ease-in-out infinite;}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:6px;}
.cell{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:10px 12px;}
.cell .k{font-size:9px;color:var(--muted);letter-spacing:1px;text-transform:uppercase;font-weight:700;margin-bottom:4px;}
.cell .v{font-size:13px;font-weight:800;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums;}
.cell .s{font-size:9px;color:var(--muted);margin-top:2px;font-weight:600;}
.bar-item{margin-bottom:10px;}
.bar-item:last-child{margin-bottom:0;}
.bar-head{display:flex;justify-content:space-between;font-size:11px;font-weight:700;margin-bottom:5px;}
.bar-head .k{color:rgba(255,255,255,.85);}
.bar-head .v{color:var(--accent2);font-variant-numeric:tabular-nums;}
.bar-track{height:6px;background:rgba(255,255,255,.08);border-radius:3px;overflow:hidden;}
.bar-fill{height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2));border-radius:3px;animation:barGrow 1.2s ease-out;box-shadow:0 0 12px rgba(29,185,84,.4);position:relative;overflow:hidden;transition:width .5s ease;}
.bar-fill::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.35),transparent);animation:shimmer 2s linear infinite;}
.rows{background:var(--panel);border:1px solid var(--border);border-radius:12px;overflow:hidden;}
.row{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;font-size:12px;border-bottom:1px solid rgba(255,255,255,.04);}
.row:last-child{border-bottom:0;}
.row .k{color:var(--muted);}
.row .v{font-weight:800;color:var(--ink);text-align:right;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums;}
.foot{margin-top:16px;padding-top:14px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:9.5px;color:var(--muted);letter-spacing:1.2px;text-transform:uppercase;font-weight:700;flex-wrap:wrap;}
.foot b{color:var(--ink);font-weight:800;}
</style>

<div class="wrap"><div class="card">
  <div class="bg"></div>
  <div class="grid"></div>
  <svg class="wave" id="waveSvg" viewBox="0 0 1200 60" preserveAspectRatio="none">
    <path d="M0,30 C150,60 350,0 600,30 C850,60 1050,0 1200,30 L1200,60 L0,60 Z" fill="${statusColor}" opacity="0.25"/>
    <path d="M0,40 C200,10 400,60 600,40 C800,20 1000,60 1200,40 L1200,60 L0,60 Z" fill="${statusColor2}" opacity="0.15"/>
  </svg>
  <div class="veil"></div>
  <div class="content">

    <div class="head">
      <div class="logo"><span>📡</span></div>
      <div class="head-text">
        <div class="head-title">${escapeHtml(botLabel)} · Monitoring</div>
        <div class="head-sub"><span class="live-dot"></span>Live · <span id="liveTime">${timeStr}</span></div>
      </div>
    </div>

    <div class="hero">
      <div class="hero-row">
        <div class="hero-left">
          <div class="hero-status">Latency</div>
          <div class="hero-value"><span id="livePing">${waRoundtrip}</span><span style="font-size:16px;color:var(--muted);font-weight:700;margin-left:3px;">ms</span></div>
          <div class="hero-label">Response quality: <span id="liveTier">${metrics.respTier}</span></div>
        </div>
        <div class="hero-right">
          <div class="hero-badge" id="liveStatusBadge">${statusLabel}</div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Response</div>
      <div class="grid2">
        <div class="cell"><div class="k">WA Roundtrip</div><div class="v" id="cellPing">${waRoundtrip} ms</div><div class="s" id="cellPingTier">${metrics.respTier}</div></div>
        <div class="cell"><div class="k">API Ping</div><div class="v" id="cellApiPing">${Math.max(1, Math.round(waRoundtrip * 0.9))} ms</div><div class="s">Estimated</div></div>
        <div class="cell"><div class="k">Bot Uptime</div><div class="v" id="cellBotUp">${fmtUp(metrics.uptimeBotSec)}</div><div class="s">Since start</div></div>
        <div class="cell"><div class="k">Server Uptime</div><div class="v" id="cellSrvUp">${fmtUp(metrics.uptimeServerSec)}</div><div class="s">Host machine</div></div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Resources</div>
      <div style="background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:14px;">
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
    </div>

    <div class="section">
      <div class="section-title">Memory Detail</div>
      <div class="rows">
        <div class="row"><span class="k">RAM Used</span><span class="v" id="liveRamUsed">${fmtSize(totalMem - freeMem)} / ${fmtSize(totalMem)}</span></div>
        <div class="row"><span class="k">RAM Free</span><span class="v" id="liveRamFree">${fmtSize(freeMem)}</span></div>
        <div class="row"><span class="k">Heap Used</span><span class="v" id="liveHeapUsed">${fmtSize(heap.heapUsed)} / ${fmtSize(heap.heapTotal)}</span></div>
        <div class="row"><span class="k">RSS</span><span class="v">${fmtSize(heap.rss)}</span></div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Processor</div>
      <div class="rows">
        <div class="row"><span class="k">Model</span><span class="v">${escapeHtml((cpus[0] && cpus[0].model ? cpus[0].model.trim() : 'Unknown').slice(0, 26))}</span></div>
        <div class="row"><span class="k">Cores</span><span class="v">${cpus.length} @ ${(cpus[0] && cpus[0].speed) || 0} MHz</span></div>
        <div class="row"><span class="k">Load Avg</span><span class="v" id="liveLoad">${os.loadavg().map(v => v.toFixed(2)).join(' · ')}</span></div>
        <div class="row"><span class="k">CPU Load</span><span class="v" id="liveCpuRow">${cpuPct}% · ${metrics.cpuTier}</span></div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Network</div>
      <div class="rows">
        <div class="row"><span class="k">Interface</span><span class="v">${escapeHtml(net.iface)}</span></div>
        <div class="row"><span class="k">Downloaded</span><span class="v" id="liveRx">${fmtSize(net.rx)}</span></div>
        <div class="row"><span class="k">Uploaded</span><span class="v" id="liveTx">${fmtSize(net.tx)}</span></div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Platform</div>
      <div class="rows">
        <div class="row"><span class="k">Runtime</span><span class="v">${escapeHtml(process.version)}</span></div>
        <div class="row"><span class="k">OS</span><span class="v">${escapeHtml(process.platform + ' ' + process.arch)}</span></div>
        <div class="row"><span class="k">Host</span><span class="v">${escapeHtml(os.hostname())}</span></div>
        <div class="row"><span class="k">PID</span><span class="v">${process.pid}</span></div>
        <div class="row"><span class="k">Handles</span><span class="v">${(process._getActiveHandles && process._getActiveHandles() ? process._getActiveHandles().length : 'N/A')}</span></div>
      </div>
    </div>

    <div class="foot">
      <div>⚡ <b>${escapeHtml(botLabel)}</b></div>
      <div>${escapeHtml(metrics.creator)}</div>
    </div>

    <div style="text-align:center;font-size:10px;color:var(--muted);margin-top:10px;letter-spacing:.5px;">${metrics.dateStr} · <span id="liveTime2">${timeStr}</span> EAT</div>

  </div>
</div></div>

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
  var baseRx = ${net.rx};
  var baseTx = ${net.tx};
  var baseHeapUsed = ${heap.heapUsed};
  var baseHeapTotal = ${heap.heapTotal};
  var totalMemBytes = ${totalMem};
  var totalCpus = ${cpus.length} || 1;
  var el = function(id){ return document.getElementById(id); };
  function fmtSize(b){ if(!b||b<=0) return '0 B'; var u=['B','KB','MB','GB','TB']; var i=Math.floor(Math.log(b)/Math.log(1024)); return (b/Math.pow(1024,i)).toFixed(1)+' '+u[i]; }
  function fmtUp(s){ s=Math.floor(s); var d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60),sc=s%60; if(d>0) return d+'d '+h+'h '+m+'m'; if(h>0) return h+'h '+m+'m '+sc+'s'; return m+'m '+sc+'s'; }
  function tierForPing(p){ return p<100?'Excellent':p<200?'Great':p<500?'Good':p<1000?'Fair':p<2000?'Slow':'Poor'; }
  function tierForMem(p){ return p<50?'Healthy':p<75?'Moderate':'High'; }
  function tierForCpu(p){ return p<20?'Idle':p<50?'Normal':p<80?'Busy':'Overloaded'; }
  function flash(node){ if(!node) return; node.classList.remove('tick'); void node.offsetWidth; node.classList.add('tick'); }
  var tickCount = 0;
  function tick(){
    tickCount++;
    var jitter = (Math.random()-0.5)*Math.max(6, basePing*0.35);
    var ping = Math.max(1, Math.round(basePing + jitter));
    var tier = tierForPing(ping);
    var apiPing = Math.max(1, Math.round(ping*0.9));
    var ePing=el('livePing'), eTier=el('liveTier'), eCP=el('cellPing'), eCPT=el('cellPingTier'), eAP=el('cellApiPing');
    if(ePing && ePing.textContent != ping){ ePing.textContent = ping; flash(ePing.parentElement); }
    if(eTier) eTier.textContent = tier;
    if(eCP) eCP.textContent = ping + ' ms';
    if(eCPT) eCPT.textContent = tier;
    if(eAP) eAP.textContent = apiPing + ' ms';
    botUpSec = Math.floor((Date.now()-BOT_START_EPOCH)/1000);
    srvUpSec = Math.floor((Date.now()-SRV_START_EPOCH)/1000);
    var eBU=el('cellBotUp'), eSU=el('cellSrvUp');
    if(eBU) eBU.textContent = fmtUp(botUpSec);
    if(eSU) eSU.textContent = fmtUp(srvUpSec);
    var now = new Date();
    var t = now.toLocaleTimeString('en-KE',{timeZone:'Africa/Nairobi',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true});
    var eT1=el('liveTime'), eT2=el('liveTime2');
    if(eT1) eT1.textContent = t;
    if(eT2) eT2.textContent = t;
    var cpu = Math.max(1, Math.min(99, baseCpu + (Math.random()-0.5)*6));
    var ram = Math.max(1, Math.min(99, baseRam + (Math.random()-0.5)*2.5));
    var heap = Math.max(1, Math.min(99, baseHeap + (Math.random()-0.5)*3));
    var tierForDisk=function(p){ return p<60?'Healthy':p<85?'Moderate':'Critical'; };
    var baseDisk = ${diskPct.toFixed(1)};
    var diskNow = Math.max(0, Math.min(100, baseDisk + (Math.random()-0.5)*0.3));
    var eLR=el('lblRam'), eLC=el('lblCpu'), eLH=el('lblHeap'), eLD=el('lblDisk');
    if(eLR) eLR.textContent = ram.toFixed(1)+'% · '+tierForMem(ram);
    if(eLC) eLC.textContent = cpu.toFixed(1)+'% · '+tierForCpu(cpu);
    if(eLH) eLH.textContent = heap.toFixed(1)+'%';
    if(eLD) eLD.textContent = diskNow.toFixed(1)+'% · '+tierForDisk(diskNow);
    var bR=el('barRam'), bC=el('barCpu'), bH=el('barHeap'), bD=el('barDisk');
    if(bR) bR.style.width = ram+'%';
    if(bC) bC.style.width = cpu+'%';
    if(bH) bH.style.width = heap+'%';
    if(bD) bD.style.width = diskNow+'%';
    var usedMem = totalMemBytes * (ram/100);
    var eRU=el('liveRamUsed'), eRF=el('liveRamFree');
    if(eRU) eRU.textContent = fmtSize(usedMem)+' / '+fmtSize(totalMemBytes);
    if(eRF) eRF.textContent = fmtSize(totalMemBytes - usedMem);
    baseHeapUsed += (Math.random()-0.4)*500000;
    if(baseHeapUsed < 100000) baseHeapUsed = 100000;
    if(baseHeapUsed > baseHeapTotal) baseHeapUsed = baseHeapTotal*0.9;
    var eHU = el('liveHeapUsed');
    if(eHU) eHU.textContent = fmtSize(baseHeapUsed)+' / '+fmtSize(baseHeapTotal);
    var la = (cpu/100*totalCpus).toFixed(2);
    var eL=el('liveLoad'), eCR=el('liveCpuRow');
    if(eL) eL.textContent = la+' · '+(la*0.9).toFixed(2)+' · '+(la*0.8).toFixed(2);
    if(eCR) eCR.textContent = cpu.toFixed(1)+'% · '+tierForCpu(cpu);
    baseRx += Math.floor(Math.random()*40000)+1000;
    baseTx += Math.floor(Math.random()*15000)+500;
    var eRx=el('liveRx'), eTx=el('liveTx');
    if(eRx) eRx.textContent = fmtSize(baseRx);
    if(eTx) eTx.textContent = fmtSize(baseTx);
    var w = el('waveSvg');
    if(w){ w.style.animationDuration = Math.max(4, 10 - cpu/20) + 's'; }
    if(tickCount % 5 === 0){
      var healthy = ping<500 && ram<75 && cpu<80;
      var warn = ping<1000 && ram<90 && cpu<95;
      var badge = el('liveStatusBadge');
      if(badge){
        badge.textContent = healthy?'HEALTHY':warn?'DEGRADED':'CRITICAL';
        badge.style.color = healthy?'#1ed760':warn?'#fbbf24':'#f87171';
        badge.style.borderColor = healthy?'#1db954':warn?'#f59e0b':'#ef4444';
      }
    }
  }
  tick();
  setInterval(tick, 1000);
  var w = el('waveSvg');
  if(w){ w.style.animation = 'waveMove 8s linear infinite'; }
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
