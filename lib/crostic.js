'use strict'

/*
 * CROSTIC 300 — the number/letter puzzle card.
 *
 * A crostic: each clue is a word, every distinct letter in the answers is given a
 * number, and the numbered cells spell a hidden message. 300 levels, 3 difficulty
 * tiers, generated deterministically from the level number so a level is always the
 * same puzzle for everybody.
 *
 * WHY THIS FILE EXISTS rather than an inline block in BIGBRO.js: the case stays thin
 * and the card stays readable, which is the same split `.tictactoe` uses (see
 * lib/tictactoe.js). The card is delivered with `mode: 'both'` for the same reason
 * the tic-tac-toe card is — a rendered rich card swallows taps, and every control in
 * here (level grid, clue selection, on-screen keyboard, Hint/Clear) lives in the
 * card's own script.
 *
 * THE CARD IS DELIBERATELY SELF-CONTAINED. No fetch, no XHR, no remote image, no
 * <a href>: the WhatsApp card sandbox is offline, so everything it needs — including
 * the 220-entry dictionary and the hidden-message pool — travels inside the markup.
 */

/**
 * The card, whole: styles, markup and script in one string.
 *
 * Kept as a single payload because the three parts are one document and are always
 * shipped together; `crosticDocument()` below only wraps it in the page shell.
 */
const payload = `
<style>
@keyframes bgShift{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
@keyframes floatUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
@keyframes pulseDot{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.75)}}
@keyframes cellPop{0%{transform:scale(.6);opacity:0}70%{transform:scale(1.15)}100%{transform:scale(1);opacity:1}}
@keyframes shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}
:root{--ink:#fff;--muted:#9a9a9a;--border:rgba(255,255,255,.1);--panel:rgba(255,255,255,.04);--accent:#1db954;--accent2:#1ed760;}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent;user-select:none;}
html,body{margin:0;padding:0;background:transparent;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",Roboto,sans-serif;font-size:14px;-webkit-font-smoothing:antialiased;overflow-x:hidden;}
.wrap{padding:8px;}
.card{position:relative;max-width:440px;margin:0 auto;border-radius:22px;overflow:hidden;background:linear-gradient(180deg,#0a0a0f,#05050a);border:1px solid var(--border);box-shadow:0 24px 70px rgba(0,0,0,.7);}
.bg{position:absolute;inset:0;background:linear-gradient(135deg,rgba(29,185,84,.14),rgba(124,58,237,.1),rgba(59,130,246,.12),rgba(245,176,66,.1));background-size:400% 400%;animation:bgShift 18s ease infinite;opacity:.85;}
.veil{position:absolute;inset:0;background:linear-gradient(180deg,rgba(8,8,12,.85),rgba(8,8,12,.96) 50%,rgba(8,8,12,1));}
.content{position:relative;z-index:3;padding:14px;}
.head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;}
.head-left{display:flex;align-items:center;gap:10px;}
.logo{width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;font-size:20px;box-shadow:0 8px 24px rgba(29,185,84,.35);}
.head-title{font-size:15px;font-weight:900;}
.head-sub{font-size:9.5px;color:var(--muted);letter-spacing:1.2px;text-transform:uppercase;font-weight:700;margin-top:2px;display:flex;align-items:center;gap:6px;}
.live-dot{width:6px;height:6px;border-radius:50%;background:var(--accent2);animation:pulseDot 1.6s ease-in-out infinite;display:inline-block;}
.coin{background:linear-gradient(135deg,#fbbf24,#d97706);color:#000;padding:4px 10px;border-radius:20px;font-weight:900;font-size:11px;}
.level-screen{display:block;}
.level-screen.hide{display:none;}
.pager{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:6px 0;font-size:11px;font-weight:800;color:var(--muted);letter-spacing:1px;}
.pager button{background:var(--panel);border:1px solid var(--border);color:var(--ink);padding:4px 10px;border-radius:8px;font-family:inherit;font-weight:800;cursor:pointer;}
.level-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:8px 0;}
.level-btn{aspect-ratio:1/1;border-radius:10px;background:var(--panel);border:1.5px solid var(--border);cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;transition:transform .15s;}
.level-btn:active{transform:scale(.94);}
.level-btn.locked{opacity:.3;cursor:not-allowed;}
.level-btn.done{border-color:var(--accent);background:linear-gradient(135deg,rgba(29,185,84,.2),rgba(30,215,96,.05));}
.level-btn .num{font-size:15px;font-weight:900;color:var(--accent2);}
.level-btn .tier{font-size:7.5px;color:var(--muted);letter-spacing:.8px;font-weight:800;margin-top:2px;text-transform:uppercase;}
.grid-wrap{margin-bottom:10px;}
.grid-label{font-size:9px;color:var(--muted);letter-spacing:1.5px;text-transform:uppercase;font-weight:800;margin-bottom:6px;}
.quote-grid{display:flex;flex-wrap:wrap;gap:3px;padding:8px;background:var(--panel);border:1px solid var(--border);border-radius:12px;justify-content:center;}
.gcell{width:28px;height:36px;border-radius:6px;background:linear-gradient(135deg,#0e0e14,#08080e);border:1.5px solid rgba(255,255,255,.08);display:flex;flex-direction:column;align-items:center;justify-content:center;}
.gcell .gletter{font-size:14px;line-height:1;color:var(--accent2);font-weight:900;}
.gcell .gnum{font-size:7.5px;color:var(--muted);margin-top:2px;font-weight:700;}
.gcell.filled{border-color:rgba(30,215,96,.35);background:linear-gradient(135deg,rgba(29,185,84,.12),rgba(30,215,96,.04));}
.clues-scroll{max-height:200px;overflow-y:auto;padding-right:4px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.2) transparent;}
.clues-scroll::-webkit-scrollbar{width:4px;}
.clues-scroll::-webkit-scrollbar-thumb{background:rgba(255,255,255,.2);border-radius:2px;}
.clue-item{padding:8px;background:var(--panel);border:1px solid var(--border);border-radius:10px;margin-bottom:5px;}
.clue-item.active{border-color:var(--accent);background:linear-gradient(135deg,rgba(29,185,84,.08),rgba(30,215,96,.02));}
.clue-item.solved{border-color:rgba(30,215,96,.35);}
.clue-text{font-size:11px;font-weight:700;margin-bottom:6px;color:rgba(255,255,255,.9);}
.clue-text .clue-id{color:var(--accent2);font-weight:900;margin-right:4px;}
.clue-blanks{display:flex;gap:3px;flex-wrap:wrap;}
.blank{width:26px;height:32px;border-radius:6px;background:rgba(255,255,255,.04);border:1.5px solid rgba(255,255,255,.12);display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;transition:border-color .15s;}
.blank .bletter{font-size:14px;font-weight:900;color:var(--accent2);line-height:1;}
.blank .bnum{font-size:7.5px;color:var(--muted);margin-top:2px;font-weight:700;}
.blank.filled{border-color:rgba(30,215,96,.4);background:linear-gradient(135deg,rgba(29,185,84,.12),rgba(30,215,96,.04));}
.blank.selected{border-color:var(--accent2);box-shadow:0 0 10px rgba(30,215,96,.5);background:linear-gradient(135deg,rgba(29,185,84,.25),rgba(30,215,96,.1));}
.kbd{margin-top:8px;display:flex;flex-direction:column;gap:4px;align-items:center;}
.krow{display:flex;gap:3px;justify-content:center;}
.key{width:28px;height:34px;border-radius:7px;background:linear-gradient(135deg,rgba(255,255,255,.08),rgba(255,255,255,.03));border:1px solid rgba(255,255,255,.15);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit;color:var(--ink);}
.key:active{transform:scale(.9);background:rgba(29,185,84,.3);}
.key.del{width:48px;font-size:11px;background:linear-gradient(135deg,rgba(255,71,87,.2),rgba(255,71,87,.08));border-color:rgba(255,71,87,.4);}
.controls{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-top:8px;}
.btn{padding:10px 6px;border-radius:10px;cursor:pointer;background:linear-gradient(135deg,rgba(29,185,84,.2),rgba(30,215,96,.08));border:1.5px solid var(--accent);color:var(--accent2);font-size:10px;font-weight:900;letter-spacing:.8px;text-transform:uppercase;font-family:inherit;}
.btn:active:not(:disabled){transform:scale(.97);}
.btn:disabled{opacity:.35;cursor:not-allowed;}
.btn.secondary{background:linear-gradient(135deg,rgba(255,255,255,.08),rgba(255,255,255,.03));border-color:rgba(255,255,255,.18);color:var(--ink);}
.btn.hint{background:linear-gradient(135deg,rgba(251,191,36,.2),rgba(251,191,36,.08));border-color:#fbbf24;color:#fbbf24;}
.msg{text-align:center;font-size:11px;font-weight:700;color:var(--muted);min-height:18px;margin-top:6px;}
.msg.warn{color:#fbbf24;animation:shake .3s ease-out;}
.msg.win{color:var(--accent2);font-size:12px;font-weight:900;}
.foot{margin-top:10px;padding-top:8px;border-top:1px solid var(--border);display:flex;justify-content:space-between;font-size:8.5px;color:var(--muted);letter-spacing:1.2px;text-transform:uppercase;font-weight:700;}
.foot b{color:var(--ink);font-weight:800;}
</style>

<div class="wrap"><div class="card">
  <div class="bg"></div><div class="veil"></div>
  <div class="content">
    <div class="head">
      <div class="head-left">
        <div class="logo">📝</div>
        <div>
          <div class="head-title">Crostic 300</div>
          <div class="head-sub"><span class="live-dot"></span>Number-Letter Puzzle</div>
        </div>
      </div>
      <div class="coin" id="coinCount">💡 20</div>
    </div>

    <div class="level-screen" id="levelScreen">
      <div class="pager"><button id="prevPg">←</button><span id="pgLabel">Levels 1-12</span><button id="nextPg">→</button></div>
      <div class="level-grid" id="levelGrid"></div>
      <div class="msg" id="levelMsg">Tap a level to begin</div>
    </div>

    <div class="level-screen hide" id="gameScreen">
      <div class="grid-wrap">
        <div class="grid-label" id="puzzleTitle">Puzzle</div>
        <div class="quote-grid" id="quoteGrid"></div>
      </div>
      <div class="clues-scroll" id="cluesScroll"></div>
      <div class="kbd" id="kbd">
        <div class="krow" data-row="1"></div>
        <div class="krow" data-row="2"></div>
        <div class="krow" data-row="3"></div>
      </div>
      <div class="controls">
        <button class="btn hint" id="hintBtn">💡 Hint</button>
        <button class="btn secondary" id="clearBtn">🗑️ Clear</button>
        <button class="btn secondary" id="backBtn">← Levels</button>
      </div>
      <div class="msg" id="msg">Select a clue or grid cell</div>
    </div>

    <div class="foot"><div>⚡ <b>MZAZI PUZZLES</b></div><div>MZAZI TECH INC</div></div>
  </div>
</div></div>

<script>
(function(){
  // ═══════════════════════════════════════════════════════════
  //  DICTIONARY — [clue, answer]
  //  ~220 entries. Add more to expand the pool.
  // ═══════════════════════════════════════════════════════════
  var WORDS = [
    // ── Directions / Opposites ──
    ["Opposite of south","NORTH"],["Opposite of north","SOUTH"],["Opposite of east","WEST"],
    ["Opposite of west","EAST"],["Opposite of up","DOWN"],["Opposite of down","UP"],
    ["Opposite of hot","COLD"],["Opposite of cold","HOT"],["Opposite of war","PEACE"],
    ["Opposite of day","NIGHT"],["Opposite of night","DAY"],["Opposite of good","BAD"],
    ["Opposite of bad","GOOD"],["Opposite of win","LOSE"],["Opposite of lose","WIN"],
    ["Opposite of open","SHUT"],["Opposite of loud","QUIET"],["Opposite of fast","SLOW"],
    ["Opposite of big","SMALL"],["Opposite of small","BIG"],["Opposite of rich","POOR"],
    ["Opposite of clean","DIRTY"],["Opposite of wet","DRY"],["Opposite of light","DARK"],
    ["Opposite of hard","SOFT"],["Opposite of high","LOW"],["Opposite of true","FALSE"],
    ["Opposite of start","END"],["Opposite of find","LOSE"],
    // ── Nature / Science ──
    ["H2O","WATER"],["Red planet","MARS"],["Our planet","EARTH"],["Gas we breathe","OXYGEN"],
    ["Largest ocean","PACIFIC"],["Frozen water","ICE"],["Earth's satellite","MOON"],
    ["Our sun is one","STAR"],["Green plant part","LEAF"],["Tall plant","TREE"],
    ["Colorful flower","ROSE"],["Yellow fruit","BANANA"],["Red fruit","APPLE"],
    ["Spicy vegetable","ONION"],["Number of planets","EIGHT"],["Study of stars","ASTRONOMY"],
    ["Center of an atom","NUCLEUS"],["Table of elements","PERIODIC"],["Speed of light symbol","C"],
    ["Force pulling down","GRAVITY"],["Gas plants breathe in","CARBON"],["Organic compound","PROTEIN"],
    ["Frozen precipitation","SNOW"],["Water falling","RAIN"],["Bright flash in sky","LIGHTNING"],
    ["Powerful storm","HURRICANE"],["Very large sea","OCEAN"],["Sandy shore","BEACH"],
    ["Rocky peak","MOUNTAIN"],["Flowing waterway","RIVER"],["Dry sandy region","DESERT"],
    // ── Animals ──
    ["Man's best friend","DOG"],["Feline pet","CAT"],["Cat's sound","MEOW"],
    ["Lion's home","DEN"],["King of the jungle","LION"],["Baby cat","KITTEN"],
    ["Baby dog","PUPPY"],["Largest land animal","ELEPHANT"],["Tallest animal","GIRAFFE"],
    ["Black and white bear","PANDA"],["Fastest land animal","CHEETAH"],["Striped horse","ZEBRA"],
    ["Honey maker","BEE"],["Web spinner","SPIDER"],["Slow shelled reptile","TURTLE"],
    ["Flying mammal","BAT"],["Large primate","GORILLA"],["Wise bird","OWL"],
    ["Colorful parrot","MACAW"],["Sea predator","SHARK"],["Eight-armed sea creature","OCTOPUS"],
    // ── Geography ──
    ["Country of sushi","JAPAN"],["Land of pyramids","EGYPT"],["Eiffel Tower city","PARIS"],
    ["Big Apple","NEWYORK"],["Land Down Under","AUSTRALIA"],["Boot-shaped country","ITALY"],
    ["Land of maple syrup","CANADA"],["Country of pasta","ITALY"],["Taj Mahal country","INDIA"],
    ["Wall of China country","CHINA"],["Statue of Liberty city","NEWYORK"],["Capital of France","PARIS"],
    ["Capital of Japan","TOKYO"],["Capital of England","LONDON"],["Capital of Italy","ROME"],
    ["Longest river","NILE"],["Land of fire and ice","ICELAND"],["Land of the free","AMERICA"],
    ["Capital of Kenya","NAIROBI"],["Capital of Egypt","CAIRO"],
    // ── Marvel / Superheroes ──
    ["Marvel hero ___ Man","IRON"],["The Dark Knight","BATMAN"],["Man of Steel","SUPERMAN"],
    ["Web-slinger","SPIDER"],["God of Thunder","THOR"],["Green giant","HULK"],
    ["Wakanda king","PANTHER"],["Star-Spangled Man","AMERICA"],["Sorcerer Supreme","STRANGE"],
    ["Mutant leader","PROFESSOR"],["Clawed hero","WOLVERINE"],["Archer Avenger","HAWKEYE"],
    // ── Common Phrases ──
    ["An apple a day keeps the doctor ___","AWAY"],["Expand from seed to tree","GROW"],
    ["'Old Glory' in the USA","FLAG"],["Tick tock goes the ___","CLOCK"],
    ["Raining cats and ___","DOGS"],["Every ___ has a silver lining","CLOUD"],
    ["Break a ___","LEG"],["Hit the ___ on the head","NAIL"],["Piece of ___","CAKE"],
    ["Bite the ___","BULLET"],["Under the ___","WEATHER"],["Once in a blue ___","MOON"],
    ["Spill the ___","BEANS"],["Cost an arm and a ___","LEG"],["In hot ___","WATER"],
    // ── Music / Arts ──
    ["Do re mi ___","FA"],["King of pop","JACKSON"],["Music with words","SONG"],
    ["String instrument","GUITAR"],["Played with sticks","DRUM"],["Painting surface","CANVAS"],
    ["Famous Mona Lisa artist","DAVINCI"],["Piano's cousin","ORGAN"],["Black and white keys","PIANO"],
    // ── Food ──
    ["Morning meal","BREAKFAST"],["Italian dish","PASTA"],["Japanese dish","SUSHI"],
    ["Bread spread","BUTTER"],["Sweet treat","CANDY"],["Coffee additive","CREAM"],
    ["Citrus fruit","LEMON"],["Tropical fruit","MANGO"],["Cold dessert","ICECREAM"],
    ["Baked grain food","BREAD"],["Cereal grain","WHEAT"],["Red sauce base","TOMATO"],
    ["Orange vegetable","CARROT"],["White grain","RICE"],["Clear drink","WATER"],
    // ── Body / Health ──
    ["Thinking organ","BRAIN"],["Pumping organ","HEART"],["Sight organ","EYE"],
    ["Hearing organ","EAR"],["Breathing organ","LUNG"],["Chewing part","TOOTH"],
    ["Arm joint","ELBOW"],["Leg joint","KNEE"],["Blood pump","HEART"],
    // ── Tech / Modern ──
    ["Small computer","LAPTOP"],["Pocket phone","MOBILE"],["Global network","INTERNET"],
    ["Wireless tech","WIFI"],["Screen device","MONITOR"],["Typing device","KEYBOARD"],
    ["Clicking device","MOUSE"],["Digital memory","DATA"],["Encrypted data","PASSWORD"],
    ["Search engine","GOOGLE"],["Social video app","TIKTOK"],["Chat app","WHATSAPP"],
    // ── Colors ──
    ["Color of sky","BLUE"],["Color of grass","GREEN"],["Color of blood","RED"],
    ["Color of sun","YELLOW"],["Color of night","BLACK"],["Color of snow","WHITE"],
    ["Color of rose","PINK"],["Color of violet","PURPLE"],
    // ── Sports ──
    ["World Cup sport","SOCCER"],["Basket sport","BASKETBALL"],["Olympic sport with bat","BASEBALL"],
    ["Racquet sport","TENNIS"],["Fastest runner","BOLT"],["Football legend","PELÉ"],
    ["Kenyan running legend","KIPCHOGE"],["Ball over net","VOLLEYBALL"],
    // ── Common Words ──
    ["Say hello","GREET"],["Express joy","SMILE"],["Show sorrow","CRY"],
    ["Speak quietly","WHISPER"],["Shout loudly","YELL"],["Think deeply","PONDER"],
    ["Move quickly","RUN"],["Move slowly","WALK"],["Stop working","REST"],
    ["Give up","QUIT"],["Begin again","RESET"],["Look carefully","STARE"],
    ["Feel afraid","FEAR"],["Feel joy","HAPPY"],["Feel sad","SORROW"],
    // ── Misc ──
    ["Number after nine","TEN"],["Number before two","ONE"],["Half a dozen","SIX"],
    ["Dozen","TWELVE"],["Roman one","ONE"],["Zero","NOTHING"],
    ["Day before today","YESTERDAY"],["Day after today","TOMORROW"],["Middle of week","WEDNESDAY"],
    ["First month","JANUARY"],["Last month","DECEMBER"],["Last day","SUNDAY"],
    // ── Names ──
    ["First man on moon","ARMSTRONG"],["Father of physics","NEWTON"],["Theory of relativity","EINSTEIN"],
    ["Apple founder","JOBS"],["Microsoft founder","GATES"],["Tesla founder","MUSK"],
    ["South African leader","MANDELA"],["Indian leader","GANDHI"],["Kenyan freedom fighter","KENYATTA"],
    ["First US president","WASHINGTON"],["Civil rights leader","KING"],
    // ── Verbs ──
    ["Create","MAKE"],["Destroy","BREAK"],["Combine","MERGE"],["Separate","SPLIT"],
    ["Increase","GROW"],["Decrease","SHRINK"],["Start","BEGIN"],["Finish","COMPLETE"],
    ["Think","PONDER"],["Know","UNDERSTAND"],["Learn","STUDY"],["Teach","INSTRUCT"]
  ];

  // ═══════════════════════════════════════════════════════════
  //  HIDDEN MESSAGES (quotes, proverbs, themes)
  // ═══════════════════════════════════════════════════════════
  var HIDDEN = [
    "KNOWLEDGE IS POWER","TIME IS MONEY","PRACTICE MAKES PERFECT",
    "ACTIONS SPEAK LOUDER","BETTER LATE THAN NEVER","HONESTY IS THE BEST POLICY",
    "UNITY IS STRENGTH","LOOK BEFORE YOU LEAP","HOPE FOR THE BEST",
    "TWO HEADS ARE BETTER","ALL THAT GLITTERS","EVERY CLOUD HAS A SILVER LINING",
    "WHERE THERE IS A WILL","A JOURNEY OF A THOUSAND","IF IT AINT BROKE",
    "EARLY BIRD CATCHES WORM","ROME WAS NOT BUILT IN A DAY",
    "SMILE AND THE WORLD SMILES","PEACE BEGINS WITH A SMILE","LOVE CONQUERS ALL",
    "THE BEST IS YET TO COME","DREAM BIG WORK HARD","STAY HUNGRY STAY FOOLISH",
    "BELIEVE YOU CAN","YOU MISS EVERY SHOT","HARD WORK BEATS TALENT",
    "THE JOURNEY IS THE REWARD","GROWTH MINDSET","COURAGE OVER COMFORT",
    "CREATE YOUR OWN PATH","LEARN FROM YESTERDAY","LIVE FOR TODAY",
    "PLAN FOR TOMORROW","BE THE CHANGE","CHOOSE KINDNESS ALWAYS",
    "PROGRESS NOT PERFECTION","SMALL STEPS EVERY DAY","FOCUS ON THE GOOD",
    "NEVER STOP LEARNING","KINDNESS COSTS NOTHING","AIM FOR THE STARS",
    "FIND JOY IN SMALL THINGS","BREATHE AND BEGIN AGAIN","YOU ARE STRONGER",
    "EVERY DAY IS A GIFT","TURN PAIN INTO POWER","BE BRAVE BE KIND"
  ];

  // ═══════════════════════════════════════════════════════════
  //  SEEDED RNG — deterministic per level
  // ═══════════════════════════════════════════════════════════
  function seedRandom(seed){
    var s = (seed * 9301 + 49297) % 233280;
    return function(){
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };
  }

  // ═══════════════════════════════════════════════════════════
  //  LEVEL GENERATOR
  //  Level 1-50:  Easy (3 clues, 3-5 letter words)
  //  Level 51-150: Medium (5 clues, 4-7 letters)
  //  Level 151-300: Hard (7 clues, 5-11 letters)
  // ═══════════════════════════════════════════════════════════
  function generateLevel(n){
    var rng = seedRandom(n);
    var tier = n <= 50 ? 1 : n <= 150 ? 2 : 3;
    var clueCount = tier === 1 ? 3 : tier === 2 ? 5 : 7;
    var minLen = tier === 1 ? 3 : tier === 2 ? 4 : 5;
    var maxLen = tier === 1 ? 5 : tier === 2 ? 7 : 12;

    // Filter pool by length
    var pool = [];
    for (var i = 0; i < WORDS.length; i++){
      var w = WORDS[i];
      if (w[1].length >= minLen && w[1].length <= maxLen) pool.push(w);
    }
    if (pool.length < clueCount) pool = WORDS.slice();

    // Pick N unique clues
    var picked = [];
    var used = {};
    var attempts = 0;
    while (picked.length < clueCount && attempts < 500){
      attempts++;
      var idx = Math.floor(rng() * pool.length);
      if (used[idx]) continue;
      // Avoid duplicate answers in the same puzzle
      var dup = false;
      for (var d = 0; d < picked.length; d++){
        if (picked[d][1] === pool[idx][1]){ dup = true; break; }
      }
      if (dup) continue;
      used[idx] = true;
      picked.push(pool[idx]);
    }

    // Collect unique letters across all answers
    var letters = {};
    picked.forEach(function(w){
      for (var k = 0; k < w[1].length; k++) letters[w[1][k]] = true;
    });
    var letterList = Object.keys(letters);

    // Shuffle to randomize numbers
    for (var si = letterList.length - 1; si > 0; si--){
      var sj = Math.floor(rng() * (si + 1));
      var tmp = letterList[si]; letterList[si] = letterList[sj]; letterList[sj] = tmp;
    }

    // Assign number 1..N to each unique letter
    var letterToNum = {};
    for (var li = 0; li < letterList.length; li++){
      letterToNum[letterList[li]] = li + 1;
    }

    // Find a hidden message whose letters are ALL covered
    var validMsgs = [];
    for (var mi = 0; mi < HIDDEN.length; mi++){
      var msg = HIDDEN[mi];
      var ok = true;
      var seen = {};
      for (var mi2 = 0; mi2 < msg.length; mi2++){
        var ch = msg[mi2];
        if (ch === ' ') continue;
        if (seen[ch]) continue;
        seen[ch] = true;
        if (!letters[ch]){ ok = false; break; }
      }
      if (ok) validMsgs.push(msg);
    }

    // Fallback: if no message covered, build one from available letters
    var hidden;
    if (validMsgs.length){
      hidden = validMsgs[Math.floor(rng() * validMsgs.length)];
    } else {
      // Use the longest answer as the "hidden" content
      var longest = picked.reduce(function(a, b){ return a[1].length > b[1].length ? a : b; });
      hidden = longest[1];
    }

    // Build grid cells from hidden message
    var grid = [];
    for (var gi = 0; gi < hidden.length; gi++){
      var gc = hidden[gi];
      if (gc === ' ') continue;
      grid.push({ number: letterToNum[gc] });
    }

    // Build clue objects
    var clues = picked.map(function(w, idx){
      var id = String.fromCharCode(65 + idx);
      var nums = [];
      for (var ci = 0; ci < w[1].length; ci++) nums.push(letterToNum[w[1][ci]]);
      return { id: id, clue: w[0], answer: w[1], numbers: nums };
    });

    return {
      id: 'lvl_' + n,
      title: 'Level ' + n,
      difficulty: tier,
      hiddenMessage: hidden,
      clues: clues,
      grid: grid
    };
  }

  // ═══════════════════════════════════════════════════════════
  //  STATE
  // ═══════════════════════════════════════════════════════════
  var MAX_LEVELS = 300;
  var PER_PAGE = 12;

  var state = {
    page: 0,
    level: null,
    levelNum: 0,
    numberToLetter: {},
    answers: {},
    selectedClue: null,
    selectedPos: 0,
    coins: 20,
    solved: {}
  };

  var levelScreen = document.getElementById('levelScreen');
  var gameScreen  = document.getElementById('gameScreen');
  var levelGrid   = document.getElementById('levelGrid');
  var quoteGrid   = document.getElementById('quoteGrid');
  var cluesScroll = document.getElementById('cluesScroll');
  var puzzleTitle = document.getElementById('puzzleTitle');
  var msg         = document.getElementById('msg');
  var coinCount   = document.getElementById('coinCount');
  var hintBtn     = document.getElementById('hintBtn');
  var clearBtn    = document.getElementById('clearBtn');
  var backBtn     = document.getElementById('backBtn');
  var prevPg      = document.getElementById('prevPg');
  var nextPg      = document.getElementById('nextPg');
  var pgLabel     = document.getElementById('pgLabel');
  var kbd         = document.getElementById('kbd');

  // ── Keyboard ──
  function buildKeyboard(){
    var rows = [
      ['Q','W','E','R','T','Y','U','I','O','P'],
      ['A','S','D','F','G','H','J','K','L'],
      ['Z','X','C','V','B','N','M']
    ];
    Array.prototype.slice.call(kbd.querySelectorAll('.krow')).forEach(function(rowEl, ri){
      rowEl.innerHTML = '';
      rows[ri].forEach(function(ch){
        var k = document.createElement('button');
        k.className = 'key';
        k.textContent = ch;
        k.addEventListener('click', function(){ onKey(ch); });
        rowEl.appendChild(k);
      });
      if (ri === 2){
        var del = document.createElement('button');
        del.className = 'key del';
        del.textContent = '⌫ Del';
        del.addEventListener('click', onDelete);
        rowEl.appendChild(del);
      }
    });
  }

  // ── Level grid render (with pagination) ──
  function renderLevelGrid(){
    levelGrid.innerHTML = '';
    var start = state.page * PER_PAGE;
    var end = Math.min(start + PER_PAGE, MAX_LEVELS);
    for (var n = start + 1; n <= end; n++){
      var btn = document.createElement('div');
      var locked = n > 1 && !state.solved[n - 1];
      var done = state.solved[n];
      var tier = n <= 50 ? 'EASY' : n <= 150 ? 'MED' : 'HARD';
      btn.className = 'level-btn' + (locked ? ' locked' : '') + (done ? ' done' : '');
      btn.innerHTML = '<div class="num">' + (done ? '✓' : n) + '</div><div class="tier">' + tier + '</div>';
      if (!locked){
        btn.addEventListener('click', (function(lv){
          return function(){ startLevel(lv); };
        })(n));
      }
      levelGrid.appendChild(btn);
    }
    pgLabel.textContent = 'Levels ' + (start + 1) + '-' + end + ' / ' + MAX_LEVELS;
    prevPg.disabled = state.page === 0;
    nextPg.disabled = end >= MAX_LEVELS;
  }

  prevPg.addEventListener('click', function(){ if (state.page > 0){ state.page--; renderLevelGrid(); }});
  nextPg.addEventListener('click', function(){ if ((state.page + 1) * PER_PAGE < MAX_LEVELS){ state.page++; renderLevelGrid(); }});

  // ── Start a level ──
  function startLevel(n){
    state.levelNum = n;
    state.level = generateLevel(n);
    state.numberToLetter = {};
    state.answers = {};
    state.selectedClue = state.level.clues[0].id;
    state.selectedPos = 0;

    state.level.clues.forEach(function(c){
      state.answers[c.id] = new Array(c.answer.length).fill('');
    });

    levelScreen.classList.add('hide');
    gameScreen.classList.remove('hide');
    puzzleTitle.textContent = 'Level ' + n + ' · ' + (state.level.difficulty === 1 ? 'Easy' : state.level.difficulty === 2 ? 'Medium' : 'Hard');
    setMsg('Solve clues to reveal the hidden message');

    renderQuoteGrid();
    renderClues();
    updateCoins();
  }

  // ── Quote grid ──
  function renderQuoteGrid(){
    quoteGrid.innerHTML = '';
    state.level.grid.forEach(function(cell){
      var d = document.createElement('div');
      d.className = 'gcell';
      var letter = state.numberToLetter[cell.number] || '';
      if (letter){
        d.classList.add('filled');
        d.innerHTML = '<span class="gletter">' + letter + '</span><span class="gnum">' + cell.number + '</span>';
      } else {
        d.innerHTML = '<span class="gletter" style="opacity:.3">?</span><span class="gnum">' + cell.number + '</span>';
      }
      quoteGrid.appendChild(d);
    });
  }

  // ── Clues ──
  function renderClues(){
    cluesScroll.innerHTML = '';
    state.level.clues.forEach(function(c){
      var item = document.createElement('div');
      item.className = 'clue-item';
      if (c.id === state.selectedClue) item.classList.add('active');
      var solved = state.answers[c.id].every(function(l){ return l === 'X' || l; });
      var complete = state.answers[c.id].every(function(l, i){ return l === c.answer[i]; });
      if (complete) item.classList.add('solved');

      var html = '<div class="clue-text"><span class="clue-id">' + c.id + '.</span>' + c.clue + '</div><div class="clue-blanks">';
      for (var i = 0; i < c.answer.length; i++){
        var letter = state.answers[c.id][i] || '';
        var cls = 'blank' + (letter ? ' filled' : '') + (c.id === state.selectedClue && i === state.selectedPos ? ' selected' : '');
        html += '<div class="' + cls + '" data-clue="' + c.id + '" data-pos="' + i + '">' +
                '<span class="bletter">' + (letter || '') + '</span>' +
                '<span class="bnum">' + c.numbers[i] + '</span></div>';
      }
      html += '</div>';
      item.innerHTML = html;

      Array.prototype.slice.call(item.querySelectorAll('.blank')).forEach(function(b){
        b.addEventListener('click', function(){
          state.selectedClue = b.dataset.clue;
          state.selectedPos = parseInt(b.dataset.pos);
          renderClues();
          renderQuoteGrid();
        });
      });
      cluesScroll.appendChild(item);
    });
  }

  // ── Key input ──
  function onKey(ch){
    if (!state.selectedClue) return;
    var clue = state.level.clues.filter(function(c){ return c.id === state.selectedClue; })[0];
    var num = clue.numbers[state.selectedPos];
    var existing = state.numberToLetter[num];

    if (existing && existing !== ch){
      setMsg('⚠️ Number ' + num + ' was ' + existing + ', now ' + ch, 'warn');
    }

    state.numberToLetter[num] = ch;
    state.answers[state.selectedClue][state.selectedPos] = ch;

    var next = state.selectedPos + 1;
    if (next >= clue.answer.length) next = 0;
    state.selectedPos = next;

    renderClues();
    renderQuoteGrid();
    checkCompletion();
  }

  function onDelete(){
    if (!state.selectedClue) return;
    var clue = state.level.clues.filter(function(c){ return c.id === state.selectedClue; })[0];
    var num = clue.numbers[state.selectedPos];
    var old = state.answers[state.selectedClue][state.selectedPos];

    state.answers[state.selectedClue][state.selectedPos] = '';
    if (state.numberToLetter[num] === old) delete state.numberToLetter[num];

    // Clear dependent cells
    state.level.clues.forEach(function(c){
      c.numbers.forEach(function(n, i){
        if (n === num) state.answers[c.id][i] = '';
      });
    });

    renderClues();
    renderQuoteGrid();
    setMsg('Cleared number ' + num);
  }

  // ── Hint ──
  hintBtn.addEventListener('click', function(){
    if (!state.selectedClue){ setMsg('Select a clue first', 'warn'); return; }
    if (state.coins < 5){ setMsg('Need 5 coins for a hint', 'warn'); return; }
    var clue = state.level.clues.filter(function(c){ return c.id === state.selectedClue; })[0];
    var correct = clue.answer[state.selectedPos];
    var num = clue.numbers[state.selectedPos];
    state.numberToLetter[num] = correct;
    state.answers[state.selectedClue][state.selectedPos] = correct;
    state.coins -= 5;
    updateCoins();
    renderClues();
    renderQuoteGrid();
    setMsg('💡 Revealed: ' + correct + ' = number ' + num);
    checkCompletion();
  });

  clearBtn.addEventListener('click', onDelete);

  backBtn.addEventListener('click', function(){
    gameScreen.classList.add('hide');
    levelScreen.classList.remove('hide');
    renderLevelGrid();
  });

  // ── Completion ──
  function checkCompletion(){
    var perfect = state.level.clues.every(function(c){
      for (var i = 0; i < c.answer.length; i++){
        if (state.answers[c.id][i] !== c.answer[i]) return false;
      }
      return true;
    });

    if (perfect){
      state.solved[state.levelNum] = true;
      state.coins += 15;
      updateCoins();
      setMsg('🏆 LEVEL ' + state.levelNum + ' COMPLETE! "' + state.level.hiddenMessage + '"', 'win');
      setTimeout(function(){
        gameScreen.classList.add('hide');
        levelScreen.classList.remove('hide');
        renderLevelGrid();
        // Auto-jump to the page containing the newly unlocked level
        var nextLvl = state.levelNum + 1;
        if (nextLvl <= MAX_LEVELS){
          state.page = Math.floor((nextLvl - 1) / PER_PAGE);
          renderLevelGrid();
        }
      }, 2200);
    }
  }

  function updateCoins(){ coinCount.textContent = '💡 ' + state.coins; }
  function setMsg(t, cls){
    msg.className = 'msg' + (cls ? ' ' + cls : '');
    msg.textContent = t;
  }

  // ── Boot ──
  buildKeyboard();
  renderLevelGrid();
  updateCoins();
})();
<\/script>
`

/**
 * The card as a standalone page, for `.crostic`.
 *
 * The payload is a fragment (styles + markup + script); this wraps it in the page shell
 * so the SAME string works for both halves of `mode: 'both'` — the inline rich card and
 * the document the owner can open in a real browser, which is where the puzzle is
 * actually playable.
 */
function crosticDocument (title = 'DARKNOTE // CROSTIC 300') {
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
</head><body>
${payload}
</body></html>`
}

module.exports = { payload, crosticDocument }
