'use strict'

/*
 * OFFLINE RUN — the black-and-white cactus runner.
 *
 * The eighth game, and the only one that was still missing from the phone arcade: it
 * shipped in the standalone DARKNOTE_PHONE_ARCADE.html prototype but never made it into
 * the interface, so the console listed seven games while the prototype had eight.
 *
 * It is deliberately monochrome (grayscale filter, no colour, no images, no webfont),
 * which is what "offline" means here: the game must look and play identically with the
 * network switched off, so it fetches nothing and depends on no remote asset.
 *
 * Registered like every other game — the console, the home grid and the Back button read
 * this list, so adding the game is this file plus one <script> tag and nothing else.
 */
;(function () {
    const TICK_MS = 70          // one frame of the runner
    const JUMP_MS = 520         // how long the dino is off the ground
    const JUMP_PX = 70
    const HIT_MIN = 20          // a cactus inside this window of the dino's x is a hit
    const HIT_MAX = 65
    const BASE_SPEED = 3        // px per frame at score 0; rises with the score

    window.DarknoteGames.register({
        id: 'offline-run',
        label: 'Offline Run',
        players: '1 player',
        blurb: 'Black-and-white cactus runner that needs no network.',

        render(root, ctx) {
            let timer = null
            let active = false
            let jumping = false
            let score = 0
            let cacti = []

            const stop = () => {
                if (timer) clearInterval(timer)
                timer = null
                active = false
            }

            function welcome() {
                root.innerHTML = ''
                root.appendChild(ctx.el(`
                    <section class="arcade-welcome">
                        <div class="arcade-hero-icon">🦖</div>
                        <div class="arcade-kicker">DARKNOTE ARCADE</div>
                        <h2>OFFLINE RUN</h2>
                        <p>Hop the cacti for as long as you can. Renders in black and white and needs no network at all.</p>
                        <div class="arcade-stat-row"><span>🦖 Endless runner</span><span>📱 Tap to jump</span><span>⚫ No network</span></div>
                        <button class="btn is-primary" type="button" data-offline-start>START RUNNING</button>
                        <div class="note">Tap anywhere on the stage, or the JUMP button. The run gets faster as your score climbs.</div>
                    </section>`))
                root.querySelector('[data-offline-start]').addEventListener('click', () => start())
            }

            function paint(host, scoreEl) {
                const dino = host.querySelector('[data-offline-dino]')
                if (dino) dino.style.transform = `translateY(${jumping ? -JUMP_PX : 0}px)`
                if (scoreEl) scoreEl.textContent = String(score)
            }

            function jump(host, scoreEl) {
                if (!active || jumping) return
                jumping = true
                paint(host, scoreEl)
                setTimeout(() => { jumping = false; paint(host, scoreEl) }, JUMP_MS)
            }

            function gameOver(host, noteEl) {
                stop()
                noteEl.textContent = `Game over! Score ${score}. Tap Restart to run again.`
            }

            function start() {
                stop()
                root.innerHTML = ''
                root.appendChild(ctx.el(`
                    <section class="mini-game" data-offline-game>
                        <div class="mini-game-head">
                            <div><small>DARKNOTE ARCADE</small><h3>OFFLINE RUN</h3></div>
                            <span>🦖</span>
                        </div>
                        <div class="big-score offline-score" data-offline-score>0</div>
                        <div class="offline-stage" data-offline-stage aria-label="Offline Run stage">
                            <div class="offline-badge">NO NETWORK NEEDED</div>
                            <div class="offline-ground"></div>
                            <div class="offline-dino" data-offline-dino aria-label="your dino">🦖</div>
                            <div class="offline-scanline"></div>
                        </div>
                        <div class="game-actions">
                            <button class="game-action" type="button" data-offline-jump>⬆ JUMP</button>
                            <button class="game-action" type="button" data-offline-restart>Restart</button>
                        </div>
                        <div class="game-note" data-offline-note>Tap the stage or JUMP to hop over the cacti.</div>
                    </section>`))

                const host = root.querySelector('[data-offline-game]')
                const stage = host.querySelector('[data-offline-stage]')
                const scoreEl = host.querySelector('[data-offline-score]')
                const noteEl = host.querySelector('[data-offline-note]')

                score = 0
                jumping = false
                active = true
                cacti = []
                paint(host, scoreEl)

                const hop = () => jump(host, scoreEl)
                stage.addEventListener('click', hop)
                host.querySelector('[data-offline-jump]').addEventListener('click', hop)
                host.querySelector('[data-offline-restart]').addEventListener('click', () => start())

                timer = setInterval(() => {
                    /*
                     * Leaving the game (Back, or another app) empties the host. An interval
                     * that kept running would move cacti inside a detached tree forever, so
                     * the frame is the place the game notices it is gone.
                     */
                    if (!root.isConnected || !host.isConnected) { stop(); return }

                    score += 1
                    scoreEl.textContent = String(score)

                    if (Math.random() < 0.22) {
                        const cactus = ctx.el('<div class="offline-cactus" aria-hidden="true">🌵</div>')
                        stage.appendChild(cactus)
                        cacti.push({ el: cactus, x: stage.clientWidth + 10 })
                    }

                    const speed = BASE_SPEED + Math.floor(score / 30)
                    for (const cactus of [...cacti]) {
                        cactus.x -= speed
                        cactus.el.style.left = `${cactus.x}px`
                        if (cactus.x < HIT_MAX && cactus.x > HIT_MIN && !jumping) { gameOver(host, noteEl); return }
                        if (cactus.x < -40) {
                            cactus.el.remove()
                            cacti = cacti.filter(item => item !== cactus)
                        }
                    }
                }, TICK_MS)
            }

            welcome()
        }
    })
})()
