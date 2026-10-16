'use strict'

/*
 * TIC-TAC-TOE — one implementation, two homes.
 *
 * The same game is reachable from `.tictactoe` and from inside the Menu 2 card
 * (home -> Games -> Tic-Tac-Toe), so it is written once here and composed by both.
 *
 * Every class is namespaced `ttt-`. The original draft used bare names like .card, .btn,
 * .status and .cell, and the Menu 2 card already defines .card, .btn and .status for its
 * own chrome - dropping it in unscoped would have had the two styling each other.
 *
 * The AI is minimax with alpha-beta pruning, so it is unbeatable; the best a player can
 * manage is a draw. That is deliberate - the score board tracks draws for a reason.
 */

const GAME = {
    title: 'Tic-Tac-Toe',
    subtitle: 'You (✕) vs DARKNOTE AI (◯)',
    player: '✕',
    ai: '◯'
}

const styles = `
.ttt-root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#fff;font-size:14px;line-height:1.5;box-sizing:border-box}
.ttt-root *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
.ttt-card{position:relative;max-width:420px;margin:0 auto;border-radius:20px;overflow:hidden;background:linear-gradient(180deg,#0a0a0f,#05050a);border:1px solid rgba(255,255,255,.1);box-shadow:0 20px 60px rgba(0,0,0,.6)}
.ttt-bg{position:absolute;inset:0;background:linear-gradient(135deg,rgba(29,185,84,.16),rgba(124,58,237,.1),rgba(59,130,246,.12),rgba(245,176,66,.1));background-size:400% 400%;animation:tttShift 18s ease infinite;z-index:0}
.ttt-grid-bg{position:absolute;inset:0;background-image:radial-gradient(circle at 1px 1px,rgba(255,255,255,.05) 1px,transparent 0);background-size:24px 24px;z-index:1}
.ttt-veil{position:absolute;inset:0;background:linear-gradient(180deg,rgba(8,8,12,.85),rgba(8,8,12,.96) 50%,rgba(8,8,12,1));z-index:2}
.ttt-content{position:relative;z-index:3;padding:16px}
@keyframes tttShift{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
@keyframes tttPop{0%{transform:scale(.4);opacity:0}60%{transform:scale(1.15)}100%{transform:scale(1);opacity:1}}
@keyframes tttGlow{0%,100%{box-shadow:0 0 18px rgba(30,215,96,.6) inset}50%{box-shadow:0 0 38px rgba(30,215,96,1) inset}}
@keyframes tttDot{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.75)}}

.ttt-head{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.ttt-logo{width:46px;height:46px;border-radius:14px;background:linear-gradient(135deg,#1db954,#1ed760);display:flex;align-items:center;justify-content:center;font-size:22px;flex:0 0 auto;box-shadow:0 8px 22px rgba(29,185,84,.35)}
.ttt-title{font-size:16px;font-weight:900}
.ttt-sub{font-size:10px;color:#9a9a9a;letter-spacing:1.3px;text-transform:uppercase;font-weight:700;margin-top:3px;display:flex;align-items:center;gap:6px}
.ttt-dot{width:6px;height:6px;border-radius:50%;background:#1ed760;animation:tttDot 1.6s ease-in-out infinite}

.ttt-score{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:12px}
.ttt-sc{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:8px;text-align:center}
.ttt-sc .k{font-size:9px;color:#9a9a9a;letter-spacing:1.2px;text-transform:uppercase;font-weight:800}
.ttt-sc .v{font-size:18px;font-weight:900;font-variant-numeric:tabular-nums}
.ttt-sc.you .v{color:#ff4757}
.ttt-sc.ai .v{color:#1ed760}
.ttt-sc.draw .v{color:#9a9a9a}

.ttt-board{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px;padding:8px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:16px}
.ttt-cell{position:relative;aspect-ratio:1/1;border-radius:12px;background:linear-gradient(135deg,#0e0e14,#08080e);border:1.5px solid rgba(255,255,255,.08);display:flex;align-items:center;justify-content:center;font-size:40px;font-weight:900;cursor:pointer;transition:transform .12s ease,border-color .2s ease}
.ttt-cell:active:not(.taken){transform:scale(.94);border-color:#1db954}
.ttt-cell.x{color:#ff4757;text-shadow:0 0 20px rgba(255,71,87,.6);border-color:rgba(255,71,87,.35)}
.ttt-cell.o{color:#1ed760;text-shadow:0 0 20px rgba(30,215,96,.6);border-color:rgba(30,215,96,.35)}
.ttt-cell.pop{animation:tttPop .35s ease-out}
.ttt-cell.win{border-color:#1ed760;background:linear-gradient(135deg,rgba(29,185,84,.25),rgba(30,215,96,.08));animation:tttGlow 1.4s ease-in-out infinite}
.ttt-cell.taken{cursor:default}

.ttt-status{display:flex;align-items:center;justify-content:center;gap:8px;padding:12px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:12px;margin-bottom:12px;font-size:13px;font-weight:800;min-height:44px}
.ttt-status.win{background:linear-gradient(135deg,rgba(29,185,84,.2),rgba(30,215,96,.06));border-color:#1db954}
.ttt-status.lose{background:linear-gradient(135deg,rgba(255,71,87,.2),rgba(255,71,87,.06));border-color:#ff4757}
.ttt-btns{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.ttt-btn{padding:12px;border-radius:12px;cursor:pointer;background:linear-gradient(135deg,rgba(29,185,84,.2),rgba(30,215,96,.08));border:1.5px solid #1db954;color:#1ed760;font-size:12px;font-weight:900;letter-spacing:1.1px;text-transform:uppercase;font-family:inherit;transition:transform .15s ease}
.ttt-btn:active{transform:scale(.97)}
.ttt-btn.secondary{background:linear-gradient(135deg,rgba(255,255,255,.08),rgba(255,255,255,.03));border-color:rgba(255,255,255,.18);color:#fff}
.ttt-wide{width:100%;margin-top:8px}
.ttt-mode{position:absolute;inset:0;z-index:5;background:rgba(5,5,10,.97);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:20px}
.ttt-mode[hidden]{display:none}
.ttt-mode-k{font-size:11px;letter-spacing:2.4px;color:#9a9a9a;font-weight:800;margin-bottom:6px}
`

const markup = `
<div class="ttt-root"><div class="ttt-card">
  <div class="ttt-bg"></div>
  <div class="ttt-grid-bg"></div>
  <div class="ttt-veil"></div>
  <div class="ttt-content">
    <div class="ttt-head">
      <div class="ttt-logo">🎮</div>
      <div>
        <div class="ttt-title">${GAME.title}</div>
        <div class="ttt-sub"><span class="ttt-dot"></span>${GAME.subtitle}</div>
      </div>
    </div>
    <div class="ttt-score">
      <div class="ttt-sc you"><div class="k">You</div><div class="v" id="tttYou">0</div></div>
      <div class="ttt-sc draw"><div class="k">Draw</div><div class="v" id="tttDraw">0</div></div>
      <div class="ttt-sc ai"><div class="k">AI</div><div class="v" id="tttAi">0</div></div>
    </div>
    <div class="ttt-board" id="tttBoard">
      <div class="ttt-cell" data-i="0"></div><div class="ttt-cell" data-i="1"></div><div class="ttt-cell" data-i="2"></div>
      <div class="ttt-cell" data-i="3"></div><div class="ttt-cell" data-i="4"></div><div class="ttt-cell" data-i="5"></div>
      <div class="ttt-cell" data-i="6"></div><div class="ttt-cell" data-i="7"></div><div class="ttt-cell" data-i="8"></div>
    </div>
    <div class="ttt-status" id="tttStatus">Your turn</div>
    <div class="ttt-btns">
      <button class="ttt-btn" id="tttNew" type="button">New Game</button>
      <button class="ttt-btn secondary" id="tttClear" type="button">Reset Score</button>
    </div>
    <button class="ttt-btn secondary ttt-wide" id="tttModeBtn" type="button">Change mode</button>
  </div>
  <div class="ttt-mode" id="tttMode">
    <div class="ttt-mode-k">CHOOSE A MODE</div>
    <button class="ttt-btn" id="tttAiMode" type="button">🤖 Play with AI</button>
    <button class="ttt-btn secondary" id="tttDuoMode" type="button">👥 1v1 — two players, this device</button>
  </div>
</div></div>`

/*
 * The game logic. `initTicTacToe(root)` is called once for whichever copy is on the page,
 * so the card and the standalone document can both host it without sharing state.
 */
const script = `
function initTicTacToe (root) {
  var scope = root || document;
  var X = ${JSON.stringify(GAME.player)}, O = ${JSON.stringify(GAME.ai)};
  var board = ['','','','','','','','',''];
  var turn = 'X', gameOver = false, locked = false;
  var score = { you: 0, ai: 0, draw: 0 };
  var q = function (s) { return scope.querySelector(s); };
  var cells = Array.prototype.slice.call(scope.querySelectorAll('.ttt-cell'));
  var statusEl = q('#tttStatus'), sYou = q('#tttYou'), sAi = q('#tttAi'), sDraw = q('#tttDraw');
  if (!statusEl || cells.length !== 9) return;
  var WINS = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];

  function setStatus (html, cls) { statusEl.className = 'ttt-status' + (cls ? ' ' + cls : ''); statusEl.innerHTML = html; }
  function checkWin (b) {
    for (var i = 0; i < WINS.length; i++) {
      var w = WINS[i];
      if (b[w[0]] && b[w[0]] === b[w[1]] && b[w[0]] === b[w[2]]) return { winner: b[w[0]], line: w };
    }
    return null;
  }
  function isFull (b) { for (var i = 0; i < 9; i++) if (!b[i]) return false; return true; }
  function render () {
    for (var i = 0; i < 9; i++) {
      var c = cells[i];
      c.className = 'ttt-cell';
      c.textContent = '';
      if (board[i] === 'X') { c.classList.add('x', 'taken'); c.textContent = X; }
      else if (board[i] === 'O') { c.classList.add('o', 'taken'); c.textContent = O; }
    }
  }
  function endGame (result) {
    gameOver = true; locked = true;
    if (result.winner === 'X') {
      score.you++; sYou.textContent = score.you;
      result.line.forEach(function (i) { cells[i].classList.add('win'); });
      setStatus(mode === 'duo' ? '🎉 <b>✕ wins!</b>' : '🎉 <b>You win!</b>', 'win');
    } else if (result.winner === 'O') {
      score.ai++; sAi.textContent = score.ai;
      result.line.forEach(function (i) { cells[i].classList.add('win'); });
      setStatus(mode === 'duo' ? '🎯 <b>◯ wins!</b>' : '🤖 <b>AI wins!</b>', 'lose');
    } else {
      score.draw++; sDraw.textContent = score.draw;
      setStatus('🤝 <b>It is a draw.</b>', '');
    }
  }

  /* minimax with alpha-beta pruning - unbeatable, so a draw is the best available result */
  function minimax (b, depth, isMax, alpha, beta) {
    var w = checkWin(b);
    if (w) return w.winner === 'O' ? 10 - depth : depth - 10;
    if (isFull(b)) return 0;
    var i, val;
    if (isMax) {
      var best = -Infinity;
      for (i = 0; i < 9; i++) if (!b[i]) {
        b[i] = 'O'; val = minimax(b, depth + 1, false, alpha, beta); b[i] = '';
        if (val > best) best = val;
        if (val > alpha) alpha = val;
        if (beta <= alpha) break;
      }
      return best;
    }
    var bestL = Infinity;
    for (i = 0; i < 9; i++) if (!b[i]) {
      b[i] = 'X'; val = minimax(b, depth + 1, true, alpha, beta); b[i] = '';
      if (val < bestL) bestL = val;
      if (val < beta) beta = val;
      if (beta <= alpha) break;
    }
    return bestL;
  }
  function bestMove (b) {
    var empty = [];
    for (var i = 0; i < 9; i++) if (!b[i]) empty.push(i);
    if (empty.length === 9) return [0, 2, 4, 6, 8][Math.floor(Math.random() * 5)];
    var best = -Infinity, move = -1;
    for (var k = 0; k < empty.length; k++) {
      var idx = empty[k];
      b[idx] = 'O';
      var sc = minimax(b, 0, false, -Infinity, Infinity);
      b[idx] = '';
      if (sc > best) { best = sc; move = idx; }
    }
    return move;
  }
  function aiTurn () {
    locked = true;
    setStatus('🤖 <b>AI thinking…</b>', '');
    setTimeout(function () {
      var move = bestMove(board);
      if (move >= 0) {
        board[move] = 'O';
        cells[move].classList.add('o', 'taken', 'pop');
        cells[move].textContent = O;
      }
      var w = checkWin(board);
      if (w) return endGame(w);
      if (isFull(board)) return endGame({ winner: null });
      turn = 'X'; locked = false;
      setStatus('Your turn');
    }, 360);
  }
  /* Whose move it is, in words for the mode being played. */
  function turnLabel () {
    if (mode !== 'duo') return 'Your turn';
    return (turn === 'X' ? '✕ player' : '◯ player') + ' — your move';
  }

  function tap (i) {
    if (gameOver || locked || board[i]) return;
    if (mode === 'ai' && turn !== 'X') return;   // the AI's half of the board is not tappable
    var mark = turn;
    board[i] = mark;
    cells[i].classList.add(mark === 'X' ? 'x' : 'o', 'taken', 'pop');
    cells[i].textContent = mark === 'X' ? X : O;
    var w = checkWin(board);
    if (w) return endGame(w);
    if (isFull(board)) return endGame({ winner: null });
    turn = mark === 'X' ? 'O' : 'X';
    if (mode === 'ai') aiTurn();
    else setStatus(turnLabel());
  }
  function newGame () {
    board = ['','','','','','','','',''];
    turn = 'X'; gameOver = false; locked = false;
    render();
    setStatus(turnLabel());
  }
  cells.forEach(function (cell, idx) {
    cell.addEventListener('click', function () { tap(idx); });
  });
  /*
   * ── MODES ────────────────────────────────────────────────────────────────────
   *
   * The chooser is shown before a game, as asked: "Play with AI" is the unbeatable
   * minimax opponent, "1v1" is two people taking turns on THIS device.
   *
   * 1v1 here means pass-and-play, and that is a limit worth being plain about: this page
   * is a standalone document with no channel back to the bot, so it cannot see what
   * another phone is doing. Two people on two devices tapping the same board is not
   * something this file can do - each would get their own private copy. What it CAN do
   * is hand one device back and forth, which is what this mode is.
   */
  var mode = 'ai';
  var modeEl = q('#tttMode');

  function showChooser () {
    if (modeEl) modeEl.removeAttribute('hidden');
  }
  function startMode (next) {
    mode = next === 'duo' ? 'duo' : 'ai';
    if (modeEl) modeEl.setAttribute('hidden', 'hidden');
    // The score columns mean different things per mode, so relabel rather than mislabel.
    var k = scope.querySelectorAll('.ttt-sc .k');
    if (k.length === 3) {
      k[0].textContent = mode === 'duo' ? '✕' : 'You';
      k[2].textContent = mode === 'duo' ? '◯' : 'AI';
    }
    newGame();
  }

  var n = q('#tttNew'), c2 = q('#tttClear');
  if (n) n.addEventListener('click', newGame);
  if (c2) c2.addEventListener('click', function () {
    score = { you: 0, ai: 0, draw: 0 };
    sYou.textContent = 0; sAi.textContent = 0; sDraw.textContent = 0;
    newGame();
  });
  var mBtn = q('#tttModeBtn');
  if (mBtn) mBtn.addEventListener('click', showChooser);
  var aiBtn = q('#tttAiMode'), duoBtn = q('#tttDuoMode');
  if (aiBtn) aiBtn.addEventListener('click', function () { startMode('ai'); });
  if (duoBtn) duoBtn.addEventListener('click', function () { startMode('duo'); });

  showChooser();
  newGame();
  return { restart: newGame, startMode: startMode };
}
`

/** The whole game as a standalone page, for `.tictactoe`. */
function gameDocument (title = 'DARKNOTE // TIC-TAC-TOE') {
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>*{margin:0;padding:0}html,body{min-height:100%;background:#05050a}body{padding:10px}${styles}</style>
</head><body>
${markup}
<script>${script}
initTicTacToe(document);
<\/script>
</body></html>`
}

module.exports = { GAME, styles, markup, script, gameDocument }
