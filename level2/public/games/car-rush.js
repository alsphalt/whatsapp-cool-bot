'use strict'

/* CAR RUSH — an offline, touch-friendly lane-dodging arcade game. */
;(function () {
    const LANES = 3
    const state = { phase: 'welcome', lane: 1, obstacles: [], score: 0, speed: 760, timer: null, best: 0 }
    const clampLane = value => Math.max(0, Math.min(LANES - 1, value))

    function stop() {
        if (state.timer) clearInterval(state.timer)
        state.timer = null
    }

    function renderWelcome(root, ctx) {
        root.appendChild(ctx.el(`
            <section class="arcade-welcome">
                <div class="arcade-hero-icon">🏎️</div>
                <div class="arcade-kicker">DARKNOTE ARCADE</div>
                <h2>CAR RUSH</h2>
                <p>Dodge traffic, switch lanes, and see how long you can survive.</p>
                <div class="arcade-stat-row"><span>🎮 3 lanes</span><span>📱 Touch controls</span><span>⚡ Endless run</span></div>
                <button class="btn is-primary" type="button" data-car-start>START ENGINE</button>
                <div class="note">Tap left or right to change lanes. Avoid every car and barrier.</div>
            </section>`))
        root.querySelector('[data-car-start]').addEventListener('click', () => start(root, ctx))
    }

    function draw(root, ctx) {
        const game = root.querySelector('[data-car-game]')
        if (!game) return
        const lanes = game.querySelector('[data-car-lanes]')
        lanes.innerHTML = ''
        for (let lane = 0; lane < LANES; lane++) {
            const col = ctx.el(`<div class="car-lane" data-lane="${lane}"></div>`)
            for (const obstacle of state.obstacles.filter(item => item.lane === lane)) {
                const obj = ctx.el(`<div class="car-obstacle" style="top:${obstacle.y}%" aria-label="obstacle">${obstacle.kind}</div>`)
                col.appendChild(obj)
            }
            if (state.lane === lane) col.appendChild(ctx.el('<div class="car-player" aria-label="your car">🏎️</div>'))
            lanes.appendChild(col)
        }
        const score = game.querySelector('[data-car-score]')
        if (score) score.textContent = String(state.score)
        const best = game.querySelector('[data-car-best]')
        if (best) best.textContent = String(state.best)
    }

    function finish(root, ctx) {
        stop()
        state.phase = 'over'
        state.best = Math.max(state.best, state.score)
        draw(root, ctx)
        const game = root.querySelector('[data-car-game]')
        if (!game) return
        const overlay = ctx.el(`<div class="car-game-over"><div class="arcade-hero-icon">💥</div><h2>CRASH!</h2><p>Run score: <strong>${state.score}</strong></p><button class="btn is-primary" type="button" data-car-restart>RACE AGAIN</button></div>`)
        game.appendChild(overlay)
        overlay.querySelector('[data-car-restart]').addEventListener('click', () => start(root, ctx))
    }

    function tick(root, ctx) {
        if (!root.isConnected || !root.querySelector('[data-car-game]')) { stop(); state.phase = 'welcome'; return }
        state.obstacles = state.obstacles.map(item => ({ ...item, y: item.y + 9 })).filter(item => item.y < 105)
        if (Math.random() < 0.68) {
            const lane = Math.floor(Math.random() * LANES)
            if (!state.obstacles.some(item => item.lane === lane && item.y < 22)) {
                state.obstacles.push({ lane, y: -12, kind: Math.random() < 0.25 ? '🚧' : '🚙' })
            }
        }
        if (state.obstacles.some(item => item.lane === state.lane && item.y >= 70 && item.y <= 91)) {
            finish(root, ctx)
            return
        }
        state.score += 1
        if (state.score % 10 === 0) state.speed = Math.max(280, state.speed - 18)
        draw(root, ctx)
        if (state.timer) { clearInterval(state.timer); state.timer = setInterval(() => tick(root, ctx), state.speed) }
    }

    function start(root, ctx) {
        stop()
        state.phase = 'playing'; state.lane = 1; state.obstacles = []; state.score = 0; state.speed = 760
        root.innerHTML = ''
        root.appendChild(ctx.el(`
            <section class="car-game" data-car-game>
                <div class="car-hud"><div><small>SCORE</small><strong data-car-score>0</strong></div><div><small>BEST THIS SESSION</small><strong data-car-best>${state.best}</strong></div><div class="car-live">● LIVE</div></div>
                <div class="car-road" data-car-lanes aria-label="Three-lane race track"></div>
                <div class="car-controls"><button class="btn" type="button" data-car-left aria-label="Move left">◀ LEFT</button><button class="btn" type="button" data-car-right aria-label="Move right">RIGHT ▶</button></div>
                <div class="note">Avoid the traffic. Each tick adds one point and the race gets faster.</div>
            </section>`))
        const move = delta => { if (state.phase === 'playing') { state.lane = clampLane(state.lane + delta); draw(root, ctx) } }
        root.querySelector('[data-car-left]').addEventListener('click', () => move(-1))
        root.querySelector('[data-car-right]').addEventListener('click', () => move(1))
        draw(root, ctx)
        state.timer = setInterval(() => tick(root, ctx), state.speed)
    }

    window.addEventListener('pagehide', stop)
    window.DarknoteGames.register({
        id: 'car-rush', label: 'Car Rush', players: '1 player', blurb: 'Dodge traffic in a fast lane-racing game.',
        render(root, ctx) {
            stop()
            if (state.phase === 'playing') state.phase = 'welcome'
            renderWelcome(root, ctx)
        }
    })
})()
