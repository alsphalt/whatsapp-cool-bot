'use strict';

/*
 * TIC-TAC-TOE — the first game in the Darknote console.
 *
 * Lives in games/ and knows nothing about the shell beyond the two things the
 * registry hands it: a root element to render into and the shared context. Adding
 * the next game means adding a file like this one; the console and the phone never
 * change.
 *
 * THE THREE DIFFICULTIES ARE ACTUALLY DIFFERENT (requirement 13):
 *   EASY    picks a random legal move about half the time; otherwise it takes a win
 *           or blocks one. Beatable, and it plays visibly badly often enough to learn on.
 *   HARD    always takes a win, always blocks a threat, then prefers centre/corners
 *           with a 1-in-8 slip so it is strong but not identical to Extreme.
 *   EXTREME full minimax with alpha-beta: never loses a game it can draw, and wins
 *           every game it can. Verified in the harness by playing it out.
 *
 * The board is 9 cells in a flat array; X is the human, O is the AI.
 *
 * `window.DarknoteTTT` exposes the pure functions so they can be tested without
 * clicking anything.
 */

(function () {
    const LINES = [
        [0, 1, 2], [3, 4, 5], [6, 7, 8],   // rows
        [0, 3, 6], [1, 4, 7], [2, 5, 8],   // columns
        [0, 4, 8], [2, 4, 6]               // diagonals
    ]
    const HUMAN = 'X'
    const AI = 'O'

    const DIFFICULTIES = {
        easy: {
            label: 'Easy',
            tagline: 'Learning',
            blurb: 'Plays loosely and often misses the move that would beat you.',
            accent: '#17b24a'
        },
        hard: {
            label: 'Hard',
            tagline: 'Sharp',
            blurb: 'Takes a win, blocks yours, and fights for the centre and corners.',
            accent: '#ffb04a'
        },
        extreme: {
            label: 'Extreme',
            tagline: 'Unbeatable',
            blurb: 'Full search of every line. The best you can get is a draw.',
            accent: '#ff2d2d'
        }
    }

    /* ------------------------------- game rules ------------------------------ */

    /** The winner of a board, or null. `line` is the winning three cells. */
    function winnerOf(board) {
        for (const line of LINES) {
            const [a, b, c] = line
            if (board[a] && board[a] === board[b] && board[a] === board[c]) {
                return { player: board[a], line }
            }
        }
        return null
    }

    const isFull = (board) => board.every(cell => cell !== null)
    const freeCells = (board) => board.map((cell, i) => (cell ? null : i)).filter(i => i !== null)

    /* --------------------------------- the AI -------------------------------- */

    /*
     * Minimax from the AI's point of view. Scores are depth-adjusted (10 - depth) so
     * that a win now beats a win later - without that the AI can shuffle instead of
     * finishing, which looks stupid even though it never loses.
     */
    function search(board, turn, depth, alpha, beta) {
        const decided = winnerOf(board)
        if (decided) return { score: decided.player === AI ? 10 - depth : depth - 10, move: null }
        if (isFull(board)) return { score: 0, move: null }

        let best = { score: turn === AI ? -Infinity : Infinity, move: null }
        for (const move of freeCells(board)) {
            board[move] = turn
            const { score } = search(board, turn === AI ? HUMAN : AI, depth + 1, alpha, beta)
            board[move] = null

            if (turn === AI) {
                if (score > best.score) best = { score, move }
                alpha = Math.max(alpha, score)
            } else {
                if (score < best.score) best = { score, move }
                beta = Math.min(beta, score)
            }
            if (beta <= alpha) break      // this branch cannot change the decision
        }
        return best
    }

    /** The move that would make `player` win immediately, or null. */
    function immediateWin(board, player) {
        for (const move of freeCells(board)) {
            board[move] = player
            const won = winnerOf(board)
            board[move] = null
            if (won) return move
        }
        return null
    }

    /**
     * Choose a move. `random` is injectable so the harness can make Easy's
     * randomness deterministic instead of hoping.
     */
    function chooseMove(board, difficulty, random = Math.random) {
        const moves = freeCells(board)
        if (!moves.length) return null
        if (difficulty === 'extreme') return search([...board], AI, 0, -Infinity, Infinity).move

        if (difficulty === 'hard') {
            const win = immediateWin([...board], AI)
            if (win !== null) return win
            const block = immediateWin([...board], HUMAN)
            if (block !== null) return block
            // Positions are ranked, then a 1-in-8 slip keeps it from being Extreme.
            const ranked = [4, 0, 2, 6, 8, 1, 3, 5, 7].filter(i => moves.includes(i))
            if (random() < 0.125) return moves[Math.floor(random() * moves.length)]
            return ranked[0]
        }

        // EASY: about half the time it plays a sensible move, otherwise any move.
        if (random() < 0.45) {
            const win = immediateWin([...board], AI)
            if (win !== null) return win
            const block = immediateWin([...board], HUMAN)
            if (block !== null) return block
            return [4, 0, 2, 6, 8].filter(i => moves.includes(i))[0] ?? moves[0]
        }
        return moves[Math.floor(random() * moves.length)]
    }

    /* ------------------------------- game state ------------------------------ */
    /*
     * Module scope, so leaving the game and coming back does NOT throw the round
     * away: Back preserves it, and only New Game or Play Again clears the board.
     */
    const state = {
        phase: 'loading',        // loading | difficulty | playing | over
        difficulty: 'hard',
        board: Array(9).fill(null),
        turn: HUMAN,
        result: null,            // { winner: 'X'|'O'|'draw', line }
        busy: false,
        progress: 0,
        prepared: false
    }

    function clearBoard() {
        state.board = Array(9).fill(null)
        state.turn = HUMAN
        state.result = null
        state.busy = false
    }

    /* ------------------------------ the loading ----------------------------- */

    /*
     * "WELCOME TO DARKNOTE GAMING / Preparing your game..."
     *
     * The steps below are REAL: the board is built, the winning-line table is
     * assembled and the AI is warmed with a real first move. Progress is reported as
     * those steps complete, so it cannot report work that did not happen.
     *
     * There is also a MINIMUM VISIBLE TIME. That is presentation, not a fake
     * progress bar: the welcome would otherwise be a flash on a fast device. The bar
     * never invents steps - it simply is not allowed to finish earlier than the
     * message can be read.
     */
    const MIN_LOADING_MS = 1100

    async function prepare(ctx, onStep) {
        const startedAt = Date.now()
        const steps = [
            ['Building the board', () => {
                const template = document.createElement('template')
                template.innerHTML = '<div class="ttt-board">' + '<button class="ttt-cell" type="button"></button>'.repeat(9) + '</div>'
                return template.content.firstElementChild
            }],
            ['Laying out the winning lines', () => LINES.map(line => line.join('-'))],
            ['Waking the DARKNOTE AI', () => chooseMove(Array(9).fill(null), 'extreme')]
        ]

        const results = []
        for (let i = 0; i < steps.length; i++) {
            const [label, run] = steps[i]
            const value = run()
            results.push(value)
            onStep?.({ label, index: i + 1, total: steps.length })
            // Yield so the progress actually paints between steps.
            await new Promise(resolve => setTimeout(resolve, 0))
        }

        const elapsed = Date.now() - startedAt
        if (elapsed < MIN_LOADING_MS) await new Promise(resolve => setTimeout(resolve, MIN_LOADING_MS - elapsed))
        return results[0]
    }

    /* -------------------------------- rendering ------------------------------ */

    const fmt = (ctx, text) => ctx.escape(text)

    function renderLoading(root, ctx) {
        root.appendChild(ctx.el(`
            <div class="ttt-loading">
                <div class="ttt-loading-glow"></div>
                <div class="ttt-loading-icon">🎮</div>
                <div class="ttt-loading-title">WELCOME TO DARKNOTE GAMING</div>
                <div class="ttt-loading-sub">Preparing your game...</div>
                <div class="ttt-bar"><i style="width:${state.progress}%"></i></div>
                <div class="ttt-step" id="ttt-step">initialising…</div>
            </div>`))
    }

    function renderDifficulty(root, ctx) {
        const cards = Object.entries(DIFFICULTIES).map(([id, meta]) => `
            <button class="ttt-diff${state.difficulty === id ? ' is-picked' : ''}" type="button" data-difficulty="${id}">
                <span class="ttt-diff-dot" style="background:${meta.accent}"></span>
                <span class="ttt-diff-text">
                    <span class="ttt-diff-label">${fmt(ctx, meta.label)}<em>${fmt(ctx, meta.tagline)}</em></span>
                    <span class="ttt-diff-blurb">${fmt(ctx, meta.blurb)}</span>
                </span>
            </button>`).join('')

        root.appendChild(ctx.el(`
            <div class="panel">
                <h3>CHOOSE DIFFICULTY</h3>
                ${cards}
                <div class="note" style="margin-top:10px">You play as <strong>X</strong>, the AI plays as <strong>O</strong>. X always moves first.</div>
            </div>
            <button class="btn is-primary" type="button" id="ttt-start">Start game</button>
            <div class="note" style="text-align:center">Difficulty can be changed between rounds.</div>
        `))

        for (const button of root.querySelectorAll('[data-difficulty]')) {
            button.addEventListener('click', () => {
                state.difficulty = button.dataset.difficulty
                ctx.nav.render()
            })
        }
        root.querySelector('#ttt-start').addEventListener('click', () => {
            clearBoard()
            state.phase = 'playing'
            ctx.nav.render()
        })
    }

    function renderBoard(root, ctx) {
        const won = state.result
        const status = won
            ? (won.winner === 'draw' ? "It's a draw." : (won.winner === HUMAN ? 'You win.' : 'The AI wins.'))
            : (state.turn === HUMAN ? 'Your move' : 'AI thinking…')

        const cells = state.board.map((value, index) => {
            const winning = won?.line?.includes(index)
            return `<button class="ttt-cell${value ? ' is-' + value.toLowerCase() : ''}${winning ? ' is-winning' : ''}"
                            type="button" data-cell="${index}" ${value || won ? 'disabled' : ''}>${value || ''}</button>`
        }).join('')

        root.appendChild(ctx.el(`
            <div class="ttt-status">
                <span class="ttt-turn ${state.turn === HUMAN ? 'is-you' : 'is-ai'}">${fmt(ctx, status)}</span>
                <span class="ttt-diff-chip" style="border-color:${DIFFICULTIES[state.difficulty].accent}">${fmt(ctx, DIFFICULTIES[state.difficulty].label)}</span>
            </div>
            <div class="ttt-board-wrap">
                <div class="ttt-board">${cells}</div>
            </div>
            <div class="ttt-actions">
                <button class="btn is-primary" type="button" id="ttt-again">${won ? 'Play again' : 'Restart round'}</button>
                <button class="btn" type="button" id="ttt-new">New game</button>
                <button class="btn" type="button" id="ttt-change">Change difficulty</button>
            </div>
            <div class="note" style="text-align:center">Back keeps this round; nothing is reset until you start a new one.</div>
        `))

        const clickable = !won && state.turn === HUMAN && !state.busy
        for (const cell of root.querySelectorAll('[data-cell]')) {
            if (!clickable) { cell.disabled = true; continue }
            cell.addEventListener('click', () => playHuman(Number(cell.dataset.cell), ctx))
        }

        root.querySelector('#ttt-again').addEventListener('click', () => { clearBoard(); state.phase = 'playing'; ctx.nav.render() })
        root.querySelector('#ttt-new').addEventListener('click', () => { clearBoard(); state.phase = 'difficulty'; ctx.nav.render() })
        root.querySelector('#ttt-change').addEventListener('click', () => { clearBoard(); state.phase = 'difficulty'; ctx.nav.render() })
    }

    /* --------------------------------- turns --------------------------------- */

    async function playHuman(index, ctx) {
        // Guard: occupied cell, wrong turn, game already finished, or an AI reply
        // still in flight. Clicking fast must not corrupt the board.
        if (state.busy || state.result || state.turn !== HUMAN || state.board[index]) return
        state.board[index] = HUMAN
        settle()
        ctx.nav.render()
        if (state.result) return

        state.turn = AI
        state.busy = true
        ctx.nav.render()

        // A short pause so the AI's reply reads as a move rather than a jump cut.
        await new Promise(resolve => setTimeout(resolve, 420))
        const move = chooseMove([...state.board], state.difficulty)
        if (move !== null) state.board[move] = AI
        state.busy = false
        state.turn = HUMAN
        settle()
        ctx.nav.render()
    }

    function settle() {
        const won = winnerOf(state.board)
        if (won) { state.result = won; state.phase = 'over'; return }
        if (isFull(state.board)) { state.result = { winner: 'draw', line: null }; state.phase = 'over' }
    }

    /* -------------------------------- the module ----------------------------- */

    async function render(root, ctx) {
        if (state.phase === 'loading') {
            renderLoading(root, ctx)
            if (!state.prepared) {
                state.prepared = true          // one preparation, not one per visit
                await prepare(ctx, ({ label, index, total }) => {
                    state.progress = Math.round((index / total) * 100)
                    const bar = document.querySelector('.ttt-bar i')
                    const step = document.getElementById('ttt-step')
                    if (bar) bar.style.width = `${state.progress}%`
                    if (step) step.textContent = label
                })
                state.progress = 100
                const bar = document.querySelector('.ttt-bar i')
                if (bar) bar.style.width = '100%'
                await new Promise(resolve => setTimeout(resolve, 220))
            }
            state.phase = 'difficulty'
            ctx.nav.render()
            return
        }
        if (state.phase === 'difficulty') return renderDifficulty(root, ctx)
        return renderBoard(root, ctx)
    }

    window.DarknoteGames.register({
        id: 'tictactoe',
        label: 'Tic-Tac-Toe',
        players: 'You vs DARKNOTE AI',
        blurb: 'Three difficulties, including an unbeatable one.',
        render
    })

    /* Exposed for the test harness: the rules and the AI are pure functions. */
    window.DarknoteTTT = { LINES, DIFFICULTIES, winnerOf, isFull, freeCells, immediateWin, chooseMove, search, state, clearBoard }
})()
