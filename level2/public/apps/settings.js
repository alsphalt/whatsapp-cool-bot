'use strict'

/*
 * SETTINGS — the control centre, foundation only.
 *
 * Every value shown is read from the server or from the device. There is no
 * invented toggle here: the "Bot features" panel states plainly that no feature
 * switches are wired yet, and says where they will go. That is deliberate - a
 * switch that changes nothing on screen and nothing on the bot is worse than an
 * empty panel, because it looks like it works.
 */

window.DarknoteApps.register({
    id: 'settings',
    label: 'Settings',
    icon: '<span>⚙</span>',
    iconClass: 'icon-settings',

    render(root, ctx) {
        const rows = (pairs) => pairs
            .map(([key, value, kind = '']) => `<div class="row"><span class="k">${key}</span><span class="v${kind ? ` is-${kind}` : ''}">${ctx.escape(value)}</span></div>`)
            .join('')

        const battery = window.__darknoteBattery
        const state = ctx.state

        root.appendChild(ctx.el(`
            <div class="panel">
                <h3>INTERFACE</h3>
                ${rows([
                    ['Name', state?.interface?.name || 'DARKNOTE LEVEL 2'],
                    ['Version', state?.interface?.version || 'unknown'],
                    ['Mode', state?.mode === 'level2' ? 'LEVEL 2 (this interface)' : 'ORIGINAL DARKNOTE', state?.mode === 'level2' ? 'good' : '']
                ])}
            </div>

            <div class="panel">
                <h3>BOT</h3>
                ${rows([
                    ['Connection', state?.bot || 'unknown', state?.bot === 'connected' ? 'good' : 'warn'],
                    ['Paired number', state?.botNumber || '—'],
                    ['Bot uptime', state?.uptimeSeconds != null ? formatDuration(state.uptimeSeconds) : '—'],
                    ['Mode changed', state?.modeChangedAt ? new Date(state.modeChangedAt).toLocaleString() : '—']
                ])}
            </div>

            <div class="panel">
                <h3>SERVER</h3>
                ${rows([
                    ['Reachable', 'yes (this page is served by it)', 'good'],
                    ['Port', String(state?.server?.port ?? '—')],
                    ['Started', state?.server?.startedAt ? new Date(state.server.startedAt).toLocaleTimeString() : '—'],
                    ['Passcode', state?.configured ? 'configured (stored as a hash)' : 'not configured', state?.configured ? 'good' : 'bad']
                ])}
            </div>

            <div class="panel">
                <h3>DEVICE</h3>
                ${rows([
                    ['Local time', new Date().toLocaleTimeString()],
                    ['Battery', battery ? `${battery.level}%${battery.charging ? ' (charging)' : ''}` : '—'],
                    ['Battery source', battery ? (battery.real ? 'device sensor' : 'simulated — this browser does not expose it') : '—', battery?.real === false ? 'warn' : '']
                ])}
            </div>

            <div class="panel">
                <h3>BOT FEATURES</h3>
                <div class="note">
                    No feature switches are wired yet. Bot features will be added here one at
                    a time as they are approved, and each one will call the bot and report its
                    real result rather than only changing this screen.
                </div>
            </div>

            <button class="btn" type="button" id="refresh-state">Refresh from the bot</button>
            <div class="result" id="refresh-result"></div>
        `))

        root.querySelector('#refresh-state').addEventListener('click', async (event) => {
            const button = event.currentTarget
            const result = root.querySelector('#refresh-result')
            button.disabled = true
            result.className = 'result'
            result.textContent = 'Reading the current state…'
            try {
                await ctx.refreshState()
                // Repaint FIRST, then write: rendering replaces the DOM, and a result
                // written before that is wiped along with the old nodes.
                ctx.nav.render()
                const fresh = root.querySelector('#refresh-result') || document.getElementById('refresh-result')
                if (fresh) {
                    fresh.className = 'result is-ok'
                    fresh.textContent = `State read at ${new Date().toLocaleTimeString()}.`
                }
            } catch (error) {
                result.className = 'result is-bad'
                result.textContent = error.message
            } finally {
                button.disabled = false
            }
        })
    }
})

function formatDuration(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0))
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    if (h) return `${h}h ${m}m`
    if (m) return `${m}m ${s % 60}s`
    return `${s}s`
}
