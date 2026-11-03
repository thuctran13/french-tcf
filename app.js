const LS_KEY = 'tcf-progress-v2';
const LS_OLD = 'tcf-progress-v1';
const INTERVALS = [0, 1, 2, 4, 7]; // Leitner: box -> days until next review (box 0 = again today)

let P = loadProgress();
let curTab = 'today';
let curTopic = -1;
let TQ = null; // topic quiz session (in memory only)

function todayStr(d){ d = d||new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function addDays(str, n){ const d = new Date(str+'T12:00:00'); d.setDate(d.getDate()+n); return todayStr(d); }
function hashStr(s){ let h = 2166136261; for(let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h>>>0; }
function rng(seed){ let a = seed; return function(){ a|=0; a = a+0x6D2B79F5|0; let t = Math.imul(a^a>>>15, 1|a); t = t+Math.imul(t^t>>>7, 61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function shuffle(arr, r){ for(let i=arr.length-1;i>0;i--){ const j = Math.floor(r()*(i+1)); const t=arr[i]; arr[i]=arr[j]; arr[j]=t; } return arr; }

function normalize(p){
  if(!p || typeof p !== 'object' || !p.boxes) return null;
  return { boxes: p.boxes, days: p.days || {}, listDate: p.listDate || '',
           todayList: Array.isArray(p.todayList) ? p.todayList : [],
           todayAnswers: p.todayAnswers || {}, version: 2 };
}
function loadProgress(){
  try{ const p = normalize(JSON.parse(localStorage.getItem(LS_KEY))); if(p) return p; }catch(e){}
  try{
    const old = JSON.parse(localStorage.getItem(LS_OLD));
    const m = normalize(old);
    if(m){
      // v1 -> v2 migration: keep Leitner boxes, day history and today's list;
      // words already self-rated today in v1 count as done (unscored).
      m.todayAnswers = {};
      if(m.listDate === todayStr() && Array.isArray(old.reviewedToday)){
        old.reviewedToday.forEach(function(i){ m.todayAnswers[i] = {ok:null, type:'v1'}; });
      }
      return m;
    }
  }catch(e){}
  return { boxes:{}, days:{}, listDate:'', todayList:[], todayAnswers:{}, version:2 };
}
function save(){ try{ localStorage.setItem(LS_KEY, JSON.stringify(P)); }catch(e){} }

let frVoice = null;
let curUtt = null; // keep a reference so WebKit doesn't garbage-collect the utterance mid-speech
function loadVoices(){
  try{
    const vs = speechSynthesis.getVoices();
    frVoice = vs.find(function(v){ return v.lang && v.lang.toLowerCase().replace('_','-').indexOf('fr') === 0; }) || null;
  }catch(e){}
}
function speak(text){
  if(!('speechSynthesis' in window)) return;
  const clean = String(text).replace(/…/g,' ').replace(/\.\.\./g,' ');
  function doSpeak(){
    try{
      const u = new SpeechSynthesisUtterance(clean);
      curUtt = u;
      u.lang = 'fr-FR'; u.rate = 0.92;
      if(frVoice) u.voice = frVoice;
      u.onend = u.onerror = function(){ if(curUtt === u) curUtt = null; };
      speechSynthesis.speak(u);
      if(speechSynthesis.paused) speechSynthesis.resume(); // iOS sometimes starts paused
    }catch(e){}
  }
  try{
    if(speechSynthesis.speaking || speechSynthesis.pending){
      // iOS WebKit bug: speak() in the same tick as cancel() often never plays.
      speechSynthesis.cancel();
      setTimeout(doSpeak, 80);
    } else {
      doSpeak();
    }
  }catch(e){ doSpeak(); }
}
if('speechSynthesis' in window){ loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }

/* ---------- SRS (Leitner), driven by quiz answers ---------- */
function ensureToday(){
  const t = todayStr();
  if(P.listDate === t && P.todayList.length) return;
  const due = [];
  for(let i=0;i<WORDS.length;i++){
    const b = P.boxes[i];
    if(b && b.d <= t) due.push(i);
  }
  due.sort((a,b)=> (P.boxes[a].d < P.boxes[b].d ? -1 : 1) || (P.boxes[a].b - P.boxes[b].b));
  const r = rng(hashStr('tcf-'+t));
  const idx = [];
  for(let i=0;i<WORDS.length;i++) if(!P.boxes[i]) idx.push(i);
  shuffle(idx, r);
  // Cap review words at half the daily set so every day also brings new words;
  // yesterday's words coming back is the memory system working, not a bug —
  // but a full repeat of the same 10 feels broken. Overflow reviews roll forward.
  const REVIEWS_MAX = 5;
  const list = due.slice(0, REVIEWS_MAX);
  for(const i of idx){ if(list.length >= 10) break; list.push(i); }
  for(const i of due.slice(REVIEWS_MAX)){ if(list.length >= 10) break; list.push(i); }
  P.listDate = t; P.todayList = list.slice(0, Math.max(10, Math.min(15, list.length)));
  P.todayAnswers = {};
  save();
}
function applyAnswer(i, ok){
  const t = todayStr();
  const cur = P.boxes[i] || {b:0, d:t};
  const nb = ok ? Math.min(4, cur.b+1) : 0;
  P.boxes[i] = {b:nb, d: ok ? addDays(t, INTERVALS[nb]) : t};
  return nb;
}
function streak(){
  let s = 0; let d = new Date();
  if(!P.days[todayStr(d)] || !P.days[todayStr(d)].done){ d.setDate(d.getDate()-1); }
  while(true){ const k = todayStr(d); if(P.days[k] && P.days[k].done > 0){ s++; d.setDate(d.getDate()-1); } else break; }
  return s;
}
function learned(){ let n = 0; for(const k in P.boxes) if(P.boxes[k].b >= 4) n++; return n; }
function dayScore(){
  let sc = 0, ans = 0, done = 0;
  for(const k in P.todayAnswers){
    done++;
    if(P.todayAnswers[k].ok === true){ sc++; ans++; }
    else if(P.todayAnswers[k].ok === false){ ans++; }
  }
  return {score: sc, answered: ans, done: done, total: P.todayList.length};
}

/* ---------- question generation ---------- */
function low(s){ return String(s||'').toLowerCase(); }
function pickDistractors(i, r, forbidden){
  // forbidden: Set of lowercase strings that may not appear as options
  const w = WORDS[i];
  const tiers = [
    function(j){ return WORDS[j].lvl === w.lvl && WORDS[j].pos === w.pos; },
    function(j){ return WORDS[j].pos === w.pos; },
    function(){ return true; }
  ];
  const picked = [];
  for(const tier of tiers){
    if(picked.length >= 2) break;
    const pool = [];
    for(let j=0;j<WORDS.length;j++){
      if(j === i || picked.indexOf(j) >= 0 || !tier(j)) continue;
      const cw = WORDS[j];
      if(forbidden.has(low(cw.w))) continue;
      if((cw.syn||[]).some(function(s){ return forbidden.has(low(s)); })) continue;
      pool.push(j);
    }
    while(pool.length && picked.length < 2){
      const j = pool.splice(Math.floor(r()*pool.length), 1)[0];
      picked.push(j);
      forbidden.add(low(WORDS[j].w));
      (WORDS[j].syn||[]).forEach(function(s){ forbidden.add(low(s)); });
    }
  }
  return picked;
}
function makeQuestion(i, seedStr){
  const w = WORDS[i];
  const r = rng(hashStr(seedStr + '|' + i));
  if(w.syn && w.syn.length){
    const correct = w.syn[Math.floor(r()*w.syn.length)];
    const forbidden = new Set([low(w.w)]);
    w.syn.forEach(function(s){ forbidden.add(low(s)); });
    const ds = pickDistractors(i, r, forbidden);
    const opts = shuffle([correct].concat(ds.map(function(j){ return WORDS[j].w; })), r);
    return { type:'syn', label:'Synonyme', text:'Quel mot est synonyme de « ' + w.w + ' » ?',
             options: opts, answer: correct };
  }
  const correct = w.en;
  const forbidden = new Set([low(correct)]);
  const ds = pickDistractors(i, r, forbidden);
  const opts = [correct];
  for(const j of ds){
    let g = WORDS[j].en;
    if(forbidden.has(low(g))) continue;
    forbidden.add(low(g)); opts.push(g);
  }
  // extremely defensive: top up from anywhere if duplicates starved the pool
  let k = 0;
  while(opts.length < 3 && k < WORDS.length){
    const g = WORDS[k].en;
    if(!forbidden.has(low(g))){ forbidden.add(low(g)); opts.push(g); }
    k++;
  }
  return { type:'def', label:'Signification', text:'Que signifie « ' + w.w + ' » ?',
           options: shuffle(opts, r), answer: correct };
}

/* ---------- shared card fragments ---------- */
function revealHtml(i){
  const w = WORDS[i];
  let h = '<div class="gloss">' + esc(w.en) + '</div>';
  if(w.syn && w.syn.length) h += '<div class="synline">Synonymes : ' + esc(w.syn.join(', ')) + '</div>';
  if(w.ex){
    h += '<div class="ex">« ' + esc(w.ex) + ' » <button class="spk" style="min-width:38px;height:38px;font-size:14px" onclick="event.stopPropagation();speak(WORDS[' + i + '].ex)">🔊</button><span class="en">' + esc(w.exEn) + '</span></div>';
  }
  return h;
}
function wordHead(i){
  const w = WORDS[i];
  const st = P.boxes[i];
  let h = '<div class="wtop"><div class="word">' + esc(w.w) + '</div>';
  h += '<button class="spk" aria-label="Écouter" onclick="event.stopPropagation();speak(WORDS[' + i + '].w)">🔊</button>';
  h += '<span class="badge ' + (w.lvl === 'B1' ? 'b1' : 'b2') + '">' + w.lvl + '</span></div>';
  h += '<div class="pos">' + esc(w.pos) + (st ? ' · boîte ' + st.b + '/4' : '') + '</div>';
  return h;
}

/* ---------- daily quiz ---------- */
function quizCard(i){
  const ans = P.todayAnswers[i];
  const q = makeQuestion(i, 'q2-' + P.listDate);
  let h = '<div class="card' + (ans ? ' done' : '') + '" id="card-' + i + '">' + wordHead(i);
  h += '<div class="qtype">' + (q.type === 'syn' ? '🧩 Synonyme' : '📖 Signification') + '</div>';
  h += '<div class="qtext">' + esc(q.text) + '</div><div class="opts">';
  q.options.forEach(function(opt, k){
    let cls = 'opt', dis = '';
    if(ans){
      dis = ' disabled';
      if(opt === q.answer) cls += ' correct';
      else if(ans.picked === opt) cls += ' wrong';
      else cls += ' dim';
    }
    h += '<button class="' + cls + '"' + dis + ' onclick="answerDaily(' + i + ',' + k + ')">' + esc(opt) + '</button>';
  });
  h += '</div>';
  if(ans){
    if(ans.ok === true) h += '<div class="fb ok" style="display:block">✓ Bonne réponse !</div>';
    else if(ans.ok === false) h += '<div class="fb ko" style="display:block">✗ Faux — bonne réponse : ' + esc(q.answer) + '</div>';
    else h += '<div class="fb" style="display:block;color:var(--grey)">Révisé avec l\'ancienne version</div>';
    h += '<div class="reveal" style="display:block">' + revealHtml(i);
    const st = P.boxes[i];
    if(st) h += '<div class="state ' + (ans.ok === false ? 'ko' : 'ok') + '">' +
      (ans.ok === false ? '↩ Boîte 0 — ce mot reviendra demain' : 'Boîte ' + st.b + '/4 · prochain rappel : ' + st.d) + '</div>';
    h += '</div>';
  }
  h += '</div>';
  return h;
}
function answerDaily(i, k){
  if(P.todayAnswers[i]) return;
  const q = makeQuestion(i, 'q2-' + P.listDate);
  const picked = q.options[k];
  const ok = picked === q.answer;
  P.todayAnswers[i] = {ok: ok, type: q.type, picked: picked};
  applyAnswer(i, ok);
  const t = todayStr();
  const ds = dayScore();
  P.days[t] = P.days[t] || {done: 0, score: 0};
  P.days[t].done = ds.done; P.days[t].score = ds.score;
  save();
  renderToday();
}
function renderStats(){
  const el = document.getElementById('stats');
  if(!el) return;
  const ds = dayScore();
  el.innerHTML =
    '<div class="stat"><b>' + ds.score + '/' + ds.answered + '</b><span>score du jour</span></div>' +
    '<div class="stat"><b>' + ds.done + '/' + ds.total + '</b><span>aujourd\'hui</span></div>' +
    '<div class="stat"><b>' + streak() + ' 🔥</b><span>jours de suite</span></div>' +
    '<div class="stat"><b>' + learned() + '</b><span>mots appris</span></div>';
  const bar = document.getElementById('pbar');
  if(bar) bar.style.width = (ds.total ? Math.round(ds.done/ds.total*100) : 0) + '%';
}
function renderToday(){
  document.getElementById('hdr-sub').textContent = 'Quiz du jour · ' + new Date().toLocaleDateString('fr-CA', {weekday:'long', day:'numeric', month:'long'});
  ensureToday();
  const ds = dayScore();
  let h = '<div class="stats" id="stats"></div><div class="progressbar"><i id="pbar"></i></div>';
  if(ds.total && ds.done >= ds.total){
    h += '<div class="summary"><b>🎉 Série terminée !</b>Résultat du jour : <b style="display:inline;font-size:19px">' +
         ds.score + ' / ' + ds.answered + '</b> bonnes réponses.' +
         (ds.score === ds.answered && ds.answered > 0 ? ' Sans faute, bravo !' :
          ds.answered ? ' Les mots ratés reviendront demain.' : '') + '</div>';
  }
  if(!P.todayList.length) h += '<div class="empty">Aucun mot aujourd\'hui. Revenez demain !</div>';
  for(const i of P.todayList) h += quizCard(i);
  h += '<div class="tools"><button onclick="exportProgress()">⬇ Exporter ma progression</button>'
     + '<label for="importFile">⬆ Importer</label></div>'
     + '<p class="note">Sauvegarde : exportez le fichier JSON, réimportez-le après un changement d\'appareil ou de navigateur. Les fichiers de la version 1 sont acceptés.</p>';
  view.innerHTML = h;
  renderStats();
}

/* ---------- topics: browse + quiz ---------- */
function browseCard(i){
  const w = WORDS[i];
  let h = '<div class="card" id="card-' + i + '">' + wordHead(i);
  h += '<div class="reveal">' + revealHtml(i) + '</div>';
  h += '<div class="hint">Touchez la carte pour voir la traduction 👆</div></div>';
  return h;
}
function bindCards(root){
  root.querySelectorAll('.card').forEach(function(c){
    c.addEventListener('click', function(){ c.classList.toggle('open'); });
  });
}
function cap(s){ return s.charAt(0).toUpperCase() + s.slice(1); }
function openTopic(k){ curTopic = k; TQ = null; renderTopics(); window.scrollTo(0,0); }
function renderTopics(){
  document.getElementById('hdr-sub').textContent = 'Vocabulaire par thème — TCF Canada';
  if(curTopic < 0){
    let h = '<p class="note">Choisissez un thème : les mots sont de niveau B1/B2 (FLELex). Les mots très courants du thème (école, santé…) sont classés A1/A2 et déjà acquis à ce niveau.</p>';
    TOPICS.forEach(function(t, k){
      h += '<button class="topic" onclick="openTopic(' + k + ')">' + esc(cap(t.name)) + '<small>' + t.words.length + ' mots</small></button>';
    });
    view.innerHTML = h;
    return;
  }
  if(TQ){ renderTopicQuiz(); return; }
  const t = TOPICS[curTopic];
  let h = '<button class="back" onclick="curTopic=-1;renderTopics()">← Tous les thèmes</button>';
  h += '<h2 class="sec">' + esc(cap(t.name)) + '</h2>';
  h += '<button class="bigbtn" onclick="startTopicQuiz()">🧠 Lancer le quiz du thème (10 questions)</button>';
  for(const i of t.words) h += browseCard(i);
  view.innerHTML = h;
  bindCards(view);
}
function startTopicQuiz(){
  const t = TOPICS[curTopic];
  const r = rng(hashStr('tq-' + Date.now()));
  const idx = t.words.slice();
  shuffle(idx, r);
  const withSyn = idx.filter(function(i){ return WORDS[i].syn && WORDS[i].syn.length; });
  const rest = idx.filter(function(i){ return !(WORDS[i].syn && WORDS[i].syn.length); });
  const order = withSyn.concat(rest).slice(0, Math.min(10, idx.length));
  TQ = { order: order, pos: 0, score: 0, current: null, answered: false, seed: 'tq-' + Date.now() + '-' + curTopic };
  renderTopicQuiz();
  window.scrollTo(0,0);
}
function renderTopicQuiz(){
  const t = TOPICS[curTopic];
  let h = '<button class="back" onclick="TQ=null;renderTopics()">← Quitter le quiz</button>';
  h += '<h2 class="sec">Quiz · ' + esc(cap(t.name)) + '</h2>';
  if(TQ.pos >= TQ.order.length){
    h += '<div class="summary"><b>🎉 Quiz terminé !</b>Résultat : <b style="display:inline;font-size:19px">' +
         TQ.score + ' / ' + TQ.order.length + '</b> bonnes réponses.</div>';
    h += '<button class="bigbtn" onclick="startTopicQuiz()">🔁 Refaire un quiz</button>';
    h += '<button class="ghostbtn" onclick="TQ=null;renderTopics()">Retour au thème</button>';
    view.innerHTML = h;
    return;
  }
  const i = TQ.order[TQ.pos];
  if(!TQ.current) TQ.current = makeQuestion(i, TQ.seed + '|' + TQ.pos);
  const q = TQ.current;
  h += '<p class="note">Question ' + (TQ.pos + 1) + ' / ' + TQ.order.length + ' · Score : ' + TQ.score + '</p>';
  h += '<div class="card">' + wordHead(i);
  h += '<div class="qtype">' + (q.type === 'syn' ? '🧩 Synonyme' : '📖 Signification') + '</div>';
  h += '<div class="qtext">' + esc(q.text) + '</div><div class="opts">';
  q.options.forEach(function(opt, k){
    let cls = 'opt', dis = '';
    if(TQ.answered){
      dis = ' disabled';
      if(opt === q.answer) cls += ' correct';
      else if(TQ.picked === opt) cls += ' wrong';
      else cls += ' dim';
    }
    h += '<button class="' + cls + '"' + dis + ' onclick="answerTopic(' + k + ')">' + esc(opt) + '</button>';
  });
  h += '</div>';
  if(TQ.answered){
    h += TQ.lastOk
      ? '<div class="fb ok" style="display:block">✓ Bonne réponse !</div>'
      : '<div class="fb ko" style="display:block">✗ Faux — bonne réponse : ' + esc(q.answer) + '</div>';
    h += '<div class="reveal" style="display:block">' + revealHtml(i) + '</div>';
    h += '<button class="bigbtn" style="margin-top:12px" onclick="nextTopicQ()">' +
         (TQ.pos + 1 >= TQ.order.length ? 'Voir le résultat' : 'Question suivante →') + '</button>';
  }
  h += '</div>';
  view.innerHTML = h;
}
function answerTopic(k){
  if(!TQ || TQ.answered) return;
  const i = TQ.order[TQ.pos];
  const q = TQ.current;
  TQ.picked = q.options[k];
  TQ.lastOk = TQ.picked === q.answer;
  if(TQ.lastOk) TQ.score++;
  TQ.answered = true;
  applyAnswer(i, TQ.lastOk);
  save();
  renderTopicQuiz();
}
function nextTopicQ(){
  TQ.pos++; TQ.current = null; TQ.answered = false; TQ.picked = null;
  renderTopicQuiz();
  window.scrollTo(0,0);
}

/* ---------- writing patterns (unchanged) ---------- */
function patCard(p){
  let h = '<div class="card pat"><div class="wtop"><div class="fr word" style="font-size:19px">' + esc(p[0]) + '</div>';
  h += '<button class="spk" onclick="event.stopPropagation();speak(this.closest(\'.card\').querySelector(\'.fr\').textContent)">🔊</button></div>';
  h += '<div class="en pat">' + esc(p[1]) + '</div>';
  h += '<div class="ex">« ' + esc(p[2]) + ' »</div></div>';
  return h;
}
function renderWrite(){
  document.getElementById('hdr-sub').textContent = 'Structures pour écrire — Expression écrite TCF';
  let h = '<h2 class="sec">Ouvertures par tâche (TCF)</h2>';
  for(const sub of PATTERNS.tasks){
    h += '<h3 class="sub2">' + esc(sub[0]) + '</h3>';
    for(const p of sub[1]) h += patCard(p);
  }
  h += '<h2 class="sec">Connecteurs et structures par fonction</h2>';
  for(const g of PATTERNS.groups){
    h += '<h3 class="sub2">' + esc(g[0]) + '</h3>';
    for(const p of g[1]) h += patCard(p);
  }
  view.innerHTML = h;
  view.querySelectorAll('.pat').forEach(function(c){ c.addEventListener('click', function(){ speak(c.querySelector('.fr').textContent); }); });
}

const view = document.getElementById('view');
function showTab(t){
  curTab = t;
  ['today','topics','write'].forEach(function(x){ document.getElementById('tab-'+x).classList.toggle('on', x === t); });
  if(t === 'today') renderToday();
  else if(t === 'topics') renderTopics();
  else renderWrite();
  window.scrollTo(0,0);
}

/* ---------- backup (v1 files accepted) ---------- */
function exportProgress(){
  const blob = new Blob([JSON.stringify(P, null, 1)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'tcf-progress-' + todayStr() + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function(){ URL.revokeObjectURL(a.href); }, 2000);
}
document.getElementById('importFile').addEventListener('change', function(ev){
  const f = ev.target.files[0]; if(!f) return;
  const rd = new FileReader();
  rd.onload = function(){
    try{
      const p = normalize(JSON.parse(rd.result));
      if(!p) throw new Error('bad');
      P = p; P.listDate = ''; save();
      alert('Progression importée ✓');
      if(curTab === 'today') renderToday();
    }catch(e){ alert('Fichier invalide — import annulé.'); }
  };
  rd.readAsText(f);
  ev.target.value = '';
});

// One-time rebuild of today's list under the review-cap rule (2026-11-03):
// keeps Leitner boxes and day history, just regenerates today's 10.
try{
  if(!localStorage.getItem('tcf-fix-20261103')){
    P.listDate = ''; P.todayList = []; P.todayAnswers = {};
    save();
    localStorage.setItem('tcf-fix-20261103', '1');
  }
}catch(e){}

// If iOS resumes this page from a frozen/suspended state (home-screen apps do
// this), force a real reload so the day, words and code are actually fresh.
window.addEventListener('pageshow', function(e){ if(e.persisted) location.reload(); });

ensureToday();
renderToday();
