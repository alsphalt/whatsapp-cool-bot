'use strict'

/*
 * SWAP — the way back to the original DARKNOTE.
 *
 * The button performs a REAL switch: it writes the active mode on the server and
 * then reports the state the server returned. It never says "success" because it
 * was pressed - it says what happened, including when the server refuses.
 *
 * Switching does not touch the WhatsApp session: no reconnect, no re-auth, no
 * restart. Only the mode value changes, and the router reads it per message.
 */

window.DarknoteApps.register({
    id: 'swap',
    label: 'Swap',
    icon: '<span class="swap-mark"><span class="head"></span><span class="body"></span></span>',
    iconClass: 'icon-swap',

    render(root, ctx) {
        const state = ctx.state
        const inLevel2 = state?.mode === 'level2'

        root.appendChild(ctx.el(`
            <div class="panel">
                <h3>ACTIVE MODE</h3>
                <div class="row">
                    <span class="k">Now running</span>
                    <span class="v ${inLevel2 ? 'is-good' : 'is-warn'}">${inLevel2 ? 'LEVEL 2 (this interface)' : 'ORIGINAL DARKNOTE'}</span>
                </div>
                <div class="row">
                    <span class="k">Switched</span>
                    <span class="v">${state?.modeChangedAt ? new Date(state.modeChangedAt).toLocaleString() : '—'}</span>
                </div>
            </div>

            <div class="panel">
                <h3>SWITCH USER</h3>
                <div class="note" style="margin:0 0 12px">
                    Returns you to the original DARKNOTE bot in WhatsApp. Commands, replies and
                    the bot's normal behaviour resume exactly as before, and this interface stops
                    handling them.
                </div>
                <button class="btn is-green" type="button" id="switch-user" ${inLevel2 ? '' : 'disabled'}>
                    Switch User
                </button>
                <div class="result" id="switch-result"></div>
            </div>

            <div class="panel">
                <h3>COMING BACK</h3>
                <div class="note" style="margin:0">
                    Type <strong>performance</strong> in WhatsApp to get the link that opens this
                    interface again. That direction is wired in the integration stage; this button
                    already performs the real switch.
                </div>
            </div>
        `))

        const button = root.querySelector('#switch-user')
        const result = root.querySelector('#switch-result')

        button.addEventListener('click', async () => {
            button.disabled = true
            result.className = 'result'
            result.textContent = 'Switching…'
            try {
                const { state: next } = await ctx.api.setMode('original', 'swap-app')
                ctx.state = next
                /*
                 * REPAINT, THEN WRITE. Rendering the app replaces its DOM, so a
                 * result written before the repaint is destroyed by it and the outcome
                 * of the switch is never seen. The order matters.
                 */
                ctx.nav.render()
                const fresh = document.getElementById('switch-result')
                if (!fresh) return
                fresh.className = 'result is-ok'
                fresh.textContent = next.mode === 'original'
                    ? `Mode is now ORIGINAL DARKNOTE (changed ${new Date(next.modeChangedAt).toLocaleTimeString()}). Open WhatsApp and use the bot as usual.`
                    : `The server reported mode "${next.mode}" — the switch did not take effect.`
            } catch (error) {
                result.className = 'result is-bad'
                result.textContent = `The switch failed: ${error.message}`
                button.disabled = false
            }
        })
    }
})
