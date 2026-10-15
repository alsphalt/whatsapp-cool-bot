'use strict'

/*
 * GAMES — the console shell.
 *
 * This stage builds the CONSOLE, not the games. It lists whatever registers itself
 * with window.DarknoteGames, so Tic-Tac-Toe (and anything after it) plugs in as a
 * separate file without this one changing.
 *
 * There is deliberately no game here yet. A playable-looking tile that leads to
 * nothing would be exactly the "looks right in a screenshot" outcome the project
 * asks to avoid, so the console says honestly that nothing is installed.
 *
 * The loading screen between picking a game and playing it belongs to the games
 * themselves, so that every game gets the same welcome without duplicating it here.
 */

window.DarknoteApps.register({
    id: 'games',
    label: 'Games',
    icon: '<span>🎮</span>',
    iconClass: 'icon-games',

    render(root, ctx) {
        const games = window.DarknoteGames.list

        root.appendChild(ctx.el(`
            <div class="panel">
                <h3>DARKNOTE GAMING</h3>
                <div class="note" style="margin:0">
                    A console inside the phone. Games run here in the interface - they are not
                    WhatsApp commands, and nothing about playing them reaches your chats.
                </div>
            </div>
        `))

        if (!games.length) {
            root.appendChild(ctx.el(`
                <div class="panel">
                    <h3>INSTALLED GAMES</h3>
                    <div class="row"><span class="k">Tic-Tac-Toe</span><span class="v is-warn">next stage</span></div>
                    <div class="note">
                        The console is ready and waiting for it: a game registers itself with
                        window.DarknoteGames.register(...) and appears here automatically, with its
                        own loading screen, difficulty selection and Back behaviour.
                    </div>
                </div>
            `))
            return
        }

        const list = ctx.el('<div class="panel"><h3>INSTALLED GAMES</h3></div>')
        for (const game of games) {
            const row = ctx.el(`
                <div class="row">
                    <span class="k">${ctx.escape(game.label)}</span>
                    <span class="v">${game.players || ''}</span>
                </div>`)
            const open = ctx.el('<button class="btn is-primary" type="button">Play</button>')
            open.addEventListener('click', () => ctx.nav.push(`game:${game.id}`))
            list.appendChild(row)
            list.appendChild(open)
        }
        root.appendChild(list)
    }
})
