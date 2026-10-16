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
            <div class="panel arcade-console-head">
                <div class="arcade-console-icon">🎮</div>
                <div><h3>DARKNOTE ARCADE</h3><p>Pick a game and play right inside your phone.</p></div>
            </div>
            <div class="arcade-safety-note">Offline mini-games · No game activity is sent to your WhatsApp chats.</div>
        `))

        if (!games.length) {
            root.appendChild(ctx.el('<div class="panel"><h3>ARCADE STARTING</h3><div class="note">No games have registered yet. Try refreshing the page.</div></div>'))
            return
        }

        const list = ctx.el('<div class="arcade-game-grid" aria-label="Available games"></div>')
        for (const game of games) {
            const card = ctx.el(`
                <article class="arcade-game-card">
                    <div class="arcade-game-art" aria-hidden="true">${game.id === 'car-rush' ? '🏎️' : game.id === 'offline-run' ? '🦖' : game.id === 'tictactoe' ? '❎' : game.id === 'ludo-mini' ? '🎲' : game.id === 'ninja-rush' ? '🥷' : game.id === 'snake' ? '🐍' : game.id === 'memory-match' ? '🧠' : game.id === 'reaction-tap' ? '⚡' : '🎮'}</div>
                    <div class="arcade-game-info">
                        <h4>${ctx.escape(game.label)}</h4>
                        <p>${ctx.escape(game.blurb || game.players || 'Ready to play')}</p>
                        <button class="btn is-primary" type="button">PLAY NOW</button>
                    </div>
                </article>`)
            card.querySelector('button').addEventListener('click', () => ctx.nav.push(`game:${game.id}`))
            list.appendChild(card)
        }
        root.appendChild(list)
        root.appendChild(ctx.el('<div class="note arcade-footer">More games can be added to this console without rebuilding the phone interface.</div>'))
    }
})
