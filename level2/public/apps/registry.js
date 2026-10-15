'use strict'

/*
 * THE APP REGISTRY.
 *
 * Every app on the phone registers itself here; the home grid, the navigation
 * stack and the app host all read from this list. Adding an app therefore means
 * adding ONE file (and one <script> tag) - the shell, the grid and the Back button
 * never need editing again.
 *
 *   DarknoteApps.register({
 *       id: 'settings',              // also the navigation id and the #hash
 *       label: 'Settings',           // shown under the icon
 *       icon: '<span>⚙</span>',      // inner HTML of the icon tile
 *       iconClass: 'icon-settings',  // its background (see styles.css)
 *       render(root, ctx) { ... }    // called every time the app is opened
 *   })
 *
 * `render` receives the live `ctx` (see app.js): ctx.api for real server calls,
 * ctx.nav for navigation, ctx.state for the last known bot state. An app keeps its
 * own state in its own module, so leaving and returning does not have to reset it.
 */

window.DarknoteApps = {
    list: [],
    register(app) {
        if (!app?.id || typeof app.render !== 'function') {
            throw new Error('an app needs an id and a render(root, ctx) function')
        }
        if (this.list.some(existing => existing.id === app.id)) {
            throw new Error(`duplicate app id: ${app.id}`)
        }
        this.list.push(app)
        return app
    },
    get(id) {
        return this.list.find(app => app.id === id) || null
    }
}

/*
 * THE GAME REGISTRY.
 *
 * Games are a separate axis from apps: the Games console lists whatever is
 * registered here, so a new game is a new file and nothing else. Deliberately empty
 * for now - Tic-Tac-Toe arrives with the games stage, and an empty console is
 * honest where a fake game would not be.
 */
window.DarknoteGames = {
    list: [],
    register(game) {
        if (!game?.id || typeof game.render !== 'function') {
            throw new Error('a game needs an id and a render(root, ctx) function')
        }
        this.list.push(game)
        return game
    }
}
