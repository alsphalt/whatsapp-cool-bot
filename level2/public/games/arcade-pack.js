'use strict'

/* Additional offline mini-games for the DARKNOTE phone arcade. */
;(function () {
    const definitions = [
        { id: 'ludo-mini', label: 'Ludo Mini', players: '2 players', blurb: 'A quick two-player dice race to 30.' },
        { id: 'ninja-rush', label: 'Ninja Rush', players: '1 player', blurb: 'Dodge obstacles and survive as long as you can.' },
        { id: 'snake', label: 'Snake', players: '1 player', blurb: 'Eat fruit, grow longer, and avoid crashing.' },
        { id: 'memory-match', label: 'Memory Match', players: '1 player', blurb: 'Flip cards and find all eight pairs.' },
        { id: 'reaction-tap', label: 'Reaction Tap', players: '1 player', blurb: 'Wait for green, then test your reaction speed.' }
    ]
    const icons = { 'ludo-mini': '🎲', 'ninja-rush': '🥷', snake: '🐍', 'memory-match': '🧠', 'reaction-tap': '⚡' }

    function welcome(root, ctx, game, launch) {
        root.innerHTML = ''
        root.appendChild(ctx.el(`<section class="arcade-welcome"><div class="arcade-hero-icon">${icons[game.id]}</div><div class="arcade-kicker">DARKNOTE ARCADE</div><h2>${ctx.escape(game.label.toUpperCase())}</h2><p>${ctx.escape(game.blurb)}</p><div class="arcade-stat-row"><span>📱 Touch friendly</span><span>🎮 Offline game</span></div><button class="btn is-primary" type="button" data-mini-start>START GAME</button><div class="note">Game runs inside the phone interface and does not send anything to WhatsApp chats.</div></section>`))
        root.querySelector('[data-mini-start]').addEventListener('click', launch)
    }

    function shell(root, ctx, game, html) {
        root.innerHTML = ''
        root.appendChild(ctx.el(`<section class="mini-game" data-mini-root><div class="mini-game-head"><div><small>DARKNOTE ARCADE</small><h3>${ctx.escape(game.label.toUpperCase())}</h3></div><span>${icons[game.id]}</span></div>${html}</section>`))
        return root.querySelector('[data-mini-root]')
    }

    function register(game) {
        window.DarknoteGames.register({ ...game, render(root, ctx) {
            let stopGame = () => {}
            const observer = new MutationObserver(() => {
                if (!root.querySelector('[data-mini-root]')) {
                    stopGame()
                    observer.disconnect()
                }
            })
            observer.observe(root, { childList: true, subtree: true })
            const launch = () => { stopGame(); stopGame = game.play(root, ctx, game) || (() => {}) }
            welcome(root, ctx, game, launch)
        } })
    }

    register({ ...definitions[0], play(root, ctx, game) {
        const host = shell(root, ctx, game, '<div class="game-note" data-ludo-note>Player 1 turn. Roll the dice to move.</div><canvas class="game-board" data-ludo-board width="310" height="170"></canvas><div class="game-actions"><button class="game-action" data-ludo-roll>🎲 Roll dice</button><button class="game-action" data-ludo-reset>Restart</button></div>')
        const canvas = host.querySelector('canvas'), c = canvas.getContext('2d'), note = host.querySelector('[data-ludo-note]')
        let pos = [0, 0], turn = 0, done = false
        function draw() { c.clearRect(0,0,310,170); c.fillStyle='#111118'; c.fillRect(0,0,310,170); for(let i=0;i<=30;i++){c.fillStyle=i%5===0?'#393944':'#24242d';c.fillRect(12+i*9.5,72,7,25)} pos.forEach((p,i)=>{c.fillStyle=i?'#54b6ff':'#ff5d66';c.beginPath();c.arc(17+p*9.5,84,8,0,Math.PI*2);c.fill()});c.fillStyle='#ddd';c.font='12px sans-serif';c.fillText('START',8,60);c.fillText('FINISH',254,60);c.fillText('P1: '+pos[0]+' / 30',15,132);c.fillText('P2: '+pos[1]+' / 30',165,132) }
        host.querySelector('[data-ludo-roll]').onclick=()=>{if(done)return;const d=1+Math.floor(Math.random()*6);pos[turn]=Math.min(30,pos[turn]+d);if(pos[turn]>=30){done=true;note.textContent=`🎉 Player ${turn+1} wins with a roll of ${d}!`;host.querySelector('[data-ludo-roll]').disabled=true}else{note.textContent=`Player ${turn+1} rolled ${d} and is at ${pos[turn]}. Player ${2-turn} turn.`;turn=1-turn}draw()}
        host.querySelector('[data-ludo-reset]').onclick=()=>{pos=[0,0];turn=0;done=false;note.textContent='Player 1 turn. Roll the dice to move.';host.querySelector('[data-ludo-roll]').disabled=false;draw()}; draw(); return () => {}
    } })

    register({ ...definitions[1], play(root, ctx, game) {
        const host = shell(root, ctx, game, '<div class="big-score" data-run-score>Score: 0</div><div class="runner-stage" data-run-stage><div class="runner-player" data-run-player>🥷</div></div><div class="game-actions"><button class="game-action" data-run-left>← LEFT</button><button class="game-action" data-run-right>RIGHT →</button><button class="game-action" data-run-start>Start / Restart</button></div><div class="game-note" data-run-note>Move lanes to avoid obstacles.</div>')
        const stage=host.querySelector('[data-run-stage]'), player=host.querySelector('[data-run-player]'), scoreEl=host.querySelector('[data-run-score]'), note=host.querySelector('[data-run-note]')
        let lane=1,score=0,obstacles=[],timer=null,active=false
        function paint(){player.style.left=(lane*33+8)+'%'} function move(d){lane=Math.max(0,Math.min(2,lane+d));paint()}
        function start(){clearInterval(timer);stage.querySelectorAll('.runner-obstacle').forEach(n=>n.remove());obstacles=[];lane=1;score=0;active=true;paint();scoreEl.textContent='Score: 0';note.textContent='Go! Dodge the obstacles.';timer=setInterval(()=>{if(!host.isConnected){clearInterval(timer);return}score++;scoreEl.textContent='Score: '+score;if(Math.random()<.34){const l=Math.floor(Math.random()*3),o=document.createElement('span');o.className='runner-obstacle';o.textContent=['🪨','🔥','💥'][Math.floor(Math.random()*3)];o.style.left=(l*33+12)+'%';o.style.top='-25px';stage.appendChild(o);obstacles.push({el:o,l,y:-25})}for(const o of [...obstacles]){o.y+=7;o.el.style.top=o.y+'px';if(o.y>145&&o.y<190&&o.l===lane){active=false;clearInterval(timer);note.textContent='Game over! Score '+score+'. Tap Start / Restart to try again.'}if(o.y>230){o.el.remove();obstacles=obstacles.filter(q=>q!==o)}}},120)}
        host.querySelector('[data-run-left]').onclick=()=>move(-1);host.querySelector('[data-run-right]').onclick=()=>move(1);host.querySelector('[data-run-start]').onclick=start;stage.onclick=()=>move(1);paint();return()=>{active=false;clearInterval(timer)}
    } })

    register({ ...definitions[2], play(root, ctx, game) {
        const host=shell(root,ctx,game,'<div class="big-score" data-snake-score>Score: 0</div><canvas class="game-board" data-snake-board width="300" height="300"></canvas><div class="game-actions snake-controls"><button class="game-action" data-dir="up">↑</button><button class="game-action" data-dir="left">←</button><button class="game-action" data-dir="down">↓</button><button class="game-action" data-dir="right">→</button><button class="game-action" data-snake-reset>Restart</button></div><div class="game-note" data-snake-note>Use the arrows or keyboard keys.</div>')
        const c=host.querySelector('canvas'),x=c.getContext('2d'),sc=host.querySelector('[data-snake-score]'),nt=host.querySelector('[data-snake-note]');let s,dir,food,score,timer
        function draw(){x.fillStyle='#101018';x.fillRect(0,0,300,300);x.fillStyle='#ff6970';x.fillRect(food.x*15,food.y*15,13,13);s.forEach((p,i)=>{x.fillStyle=i?'#54d6a0':'#b7ffdd';x.fillRect(p.x*15+1,p.y*15+1,13,13)});sc.textContent='Score: '+score}
        function reset(){clearInterval(timer);s=[{x:7,y:7},{x:6,y:7},{x:5,y:7}];dir={x:1,y:0};food={x:12,y:8};score=0;nt.textContent='Use the arrows or keyboard keys.';timer=setInterval(step,130);draw()}
        function step(){if(!host.isConnected){clearInterval(timer);return}const h={x:s[0].x+dir.x,y:s[0].y+dir.y};if(h.x<0||h.x>=20||h.y<0||h.y>=20||s.some(p=>p.x===h.x&&p.y===h.y)){clearInterval(timer);nt.textContent='Game over! Score '+score+'. Tap Restart to play again.';return}s.unshift(h);if(h.x===food.x&&h.y===food.y){score+=10;do{food={x:Math.floor(Math.random()*20),y:Math.floor(Math.random()*20)}}while(s.some(p=>p.x===food.x&&p.y===food.y))}else s.pop();draw()}
        const directions={up:{x:0,y:-1},down:{x:0,y:1},left:{x:-1,y:0},right:{x:1,y:0}};function set(d){if(d.x!==-dir.x||d.y!==-dir.y)dir=d}
        host.querySelectorAll('[data-dir]').forEach(b=>b.onclick=()=>set(directions[b.dataset.dir]));host.querySelector('[data-snake-reset]').onclick=reset
        function key(e){const d={ArrowUp:directions.up,ArrowDown:directions.down,ArrowLeft:directions.left,ArrowRight:directions.right}[e.key];if(d&&host.isConnected){e.preventDefault();set(d)}}window.addEventListener('keydown',key);reset();return()=>{clearInterval(timer);window.removeEventListener('keydown',key)}
    } })

    register({ ...definitions[3], play(root, ctx, game) {
        const host=shell(root,ctx,game,'<div class="game-note" data-memory-note>Pairs: 0/8 · Moves: 0</div><div class="memory-board" data-memory-board></div><div class="game-actions"><button class="game-action" data-memory-reset>Shuffle / Restart</button></div>');const grid=host.querySelector('[data-memory-board]'),note=host.querySelector('[data-memory-note]'),emojis=['🐉','🎮','⚡','👾','🎲','🥷','🐍','🌙'];let cards=[],first=null,lock=false,matches=0,moves=0,timeout=null
        function render(){grid.innerHTML='';cards.forEach((v,i)=>{const b=document.createElement('button');b.className='memory-card';b.textContent=v.open||v.done?v.value:'?';b.style.color=v.done?'#54d6a0':'#ff7077';b.setAttribute('aria-label',v.open||v.done?v.value:'Hidden card');b.onclick=()=>flip(i);grid.appendChild(b)})}
        function flip(i){const v=cards[i];if(lock||v.done||v.open)return;v.open=true;if(first===null){first=i;render();return}moves++;const a=cards[first];if(a.value===v.value){a.done=v.done=true;matches++;first=null;note.textContent='Pairs: '+matches+'/8 · Moves: '+moves+(matches===8?' · You won! 🎉':'');render()}else{lock=true;render();timeout=setTimeout(()=>{a.open=v.open=false;first=null;lock=false;render()},650)}}
        function reset(){clearTimeout(timeout);cards=[...emojis,...emojis].sort(()=>Math.random()-.5).map(value=>({value,open:false,done:false}));first=null;lock=false;matches=0;moves=0;note.textContent='Pairs: 0/8 · Moves: 0';render()}host.querySelector('[data-memory-reset]').onclick=reset;reset();return()=>clearTimeout(timeout)
    } })

    register({ ...definitions[4], play(root, ctx, game) {
        const host=shell(root,ctx,game,'<div class="game-note" data-reaction-note>Press Start, wait for green, then tap the panel.</div><button class="reaction-pad" data-reaction-pad type="button">READY?</button><div class="game-actions"><button class="game-action" data-reaction-start>Start</button></div>');let phase='idle',timer=null,started=0;const pad=host.querySelector('[data-reaction-pad]'),note=host.querySelector('[data-reaction-note]')
        pad.onclick=()=>{if(phase==='wait'){clearTimeout(timer);phase='done';const ms=performance.now()-started;pad.classList.remove('is-wait');pad.textContent=Math.round(ms)+' ms';note.textContent='Your reaction time: '+Math.round(ms)+' milliseconds.'}else if(phase==='ready'){clearTimeout(timer);phase='early';pad.textContent='TOO EARLY!';note.textContent='Wait until the panel turns green.'}}
        host.querySelector('[data-reaction-start]').onclick=()=>{clearTimeout(timer);phase='ready';pad.classList.remove('is-wait');pad.classList.add('is-ready');pad.textContent='WAIT...';note.textContent='Wait for green!';timer=setTimeout(()=>{if(phase==='ready'){phase='wait';pad.classList.remove('is-ready');pad.classList.add('is-wait');started=performance.now();pad.textContent='TAP NOW!'}},1000+Math.random()*2500)}
        return()=>clearTimeout(timer)
    } })
})()
