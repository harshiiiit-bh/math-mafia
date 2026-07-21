const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(__dirname, 'db.json');

// ---------- Load chapter content ----------
const chapters = {}; // id -> chapter object
fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json')).forEach(f => {
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
  chapters[raw.chapter] = raw;
});
const chapterList = Object.values(chapters).sort((a, b) => a.chapter - b.chapter);

// A question is "gradable" (usable in auto-scored quiz/test) if its answer is short
// and doesn't look like a proof. Everything else is browsable in Practice mode only.
function isGradable(ex) {
  if (!ex.answer) return false;
  const a = ex.answer.toLowerCase();
  // Multi-part answers like "(i) ... (ii) ... (iii) ..." can't be graded with one text box
  if ((a.match(/\(/g) || []).length >= 2) return false;
  if (a.length > 70) return false;
  if (/proof|prove|show that|hence|justif/.test(a) && a.length > 40) return false;
  return true;
}

// Flat pool of gradable questions, tagged with chapter id
const questionPool = [];
chapterList.forEach(ch => {
  (ch.exercises || []).forEach(ex => {
    if (isGradable(ex)) {
      questionPool.push({
        qid: `${ch.chapter}-${ex.id}`,
        chapter: ch.chapter,
        chapterTitle: ch.title,
        topic: ex.topic,
        difficulty: ex.difficulty,
        question: ex.question,
        answer: ex.answer,
        source: ex.source
      });
    }
  });
});

// ---------- Tiny JSON-file DB (no native deps, easy to deploy anywhere) ----------
function loadDB() {
  if (!fs.existsSync(DB_FILE)) return { tests: {}, attempts: {} };
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { tests: {}, attempts: {} }; }
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
let db = loadDB();

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (db.tests[code]);
  return code;
}

function normalize(str) {
  return String(str).toLowerCase().replace(/rs\.?|₹|cm|m\b|degrees?|deg\b/g, '').replace(/[^a-z0-9.\-]/g, '').trim();
}
function checkAnswer(userAns, correctAns) {
  const u = normalize(userAns);
  const c = normalize(correctAns);
  if (!u) return false;
  if (u === c) return true;
  // allow partial containment for multi-part answers e.g. "13 and 14"
  return c.includes(u) && u.length >= 2 || u.includes(c) && c.length >= 2;
}

function pickQuestions(chapterIds, count) {
  const pool = questionPool.filter(q => chapterIds.includes(q.chapter));
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, shuffled.length)).map(q => q.qid);
}

function questionsPublic(qids) {
  return qids.map(qid => {
    const q = questionPool.find(x => x.qid === qid);
    return q ? { qid: q.qid, chapterTitle: q.chapterTitle, topic: q.topic, difficulty: q.difficulty, question: q.question, source: q.source } : null;
  }).filter(Boolean);
}

// ---------- API ----------
app.get('/api/chapters', (req, res) => {
  res.json(chapterList.map(c => ({
    id: c.chapter,
    title: c.title,
    noteCount: (c.notes || []).length,
    formulaCount: (c.formulas || []).length,
    exampleCount: (c.examples || []).length,
    exerciseCount: (c.exercises || []).length,
    gradableCount: questionPool.filter(q => q.chapter === c.chapter).length
  })));
});

app.get('/api/chapter/:id', (req, res) => {
  const ch = chapters[req.params.id];
  if (!ch) return res.status(404).json({ error: 'Chapter not found' });
  res.json(ch);
});

// Quick Heist (practice quiz) - instant feedback, not saved to leaderboard
app.post('/api/quiz/generate', (req, res) => {
  const { chapterIds, count } = req.body;
  if (!Array.isArray(chapterIds) || !chapterIds.length) return res.status(400).json({ error: 'Pick at least one chapter' });
  const qids = pickQuestions(chapterIds, count || 10);
  res.json({ questions: questionsPublic(qids) });
});

app.post('/api/quiz/check', (req, res) => {
  const { qid, answer } = req.body;
  const q = questionPool.find(x => x.qid === qid);
  if (!q) return res.status(404).json({ error: 'Question not found' });
  const correct = checkAnswer(answer || '', q.answer);
  res.json({ correct, correctAnswer: q.answer });
});

// Solo Job / Big Heist (timed test, not shared) & Gang War (shared via code)
app.post('/api/test/create', (req, res) => {
  const { chapterIds, count, creatorName, mode } = req.body;
  if (!Array.isArray(chapterIds) || !chapterIds.length) return res.status(400).json({ error: 'Pick at least one chapter' });
  const qids = pickQuestions(chapterIds, count || 10);
  if (!qids.length) return res.status(400).json({ error: 'No gradable questions available for that selection' });
  const code = genCode();
  db.tests[code] = {
    code, chapterIds, qids, creatorName: creatorName || 'Anonymous',
    mode: mode || 'squad', createdAt: Date.now()
  };
  db.attempts[code] = [];
  saveDB(db);
  res.json({ code, questions: questionsPublic(qids), chapters: chapterIds.map(id => chapters[id]?.title).filter(Boolean) });
});

app.get('/api/test/:code', (req, res) => {
  const test = db.tests[req.params.code.toUpperCase()];
  if (!test) return res.status(404).json({ error: 'No gang war found with that code' });
  res.json({
    code: test.code,
    creatorName: test.creatorName,
    chapters: test.chapterIds.map(id => chapters[id]?.title).filter(Boolean),
    questions: questionsPublic(test.qids)
  });
});

app.post('/api/test/:code/submit', (req, res) => {
  const code = req.params.code.toUpperCase();
  const test = db.tests[code];
  if (!test) return res.status(404).json({ error: 'No gang war found with that code' });
  const { name, answers, timeTakenSeconds } = req.body;
  if (!name) return res.status(400).json({ error: 'Alias required' });

  let score = 0;
  const breakdown = test.qids.map(qid => {
    const q = questionPool.find(x => x.qid === qid);
    const userAns = (answers && answers[qid]) || '';
    const correct = q ? checkAnswer(userAns, q.answer) : false;
    if (correct) score++;
    return { qid, correct, yourAnswer: userAns, correctAnswer: q ? q.answer : '' };
  });

  const attempt = {
    name, score, total: test.qids.length,
    timeTakenSeconds: timeTakenSeconds || 0,
    submittedAt: Date.now()
  };
  db.attempts[code] = db.attempts[code] || [];
  db.attempts[code].push(attempt);
  saveDB(db);

  res.json({ score, total: test.qids.length, breakdown });
});

app.get('/api/test/:code/leaderboard', (req, res) => {
  const code = req.params.code.toUpperCase();
  const test = db.tests[code];
  if (!test) return res.status(404).json({ error: 'No gang war found with that code' });
  const attempts = (db.attempts[code] || []).slice().sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.timeTakenSeconds - b.timeTakenSeconds;
  });
  res.json({ code, creatorName: test.creatorName, total: test.qids.length, leaderboard: attempts });
});

// ---------- Frontend ----------
app.get('/', (req, res) => {
  res.set('Content-Type', 'text/html');
  res.send(FRONTEND_HTML);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Math Mafia running on port ${PORT}`));

// ================================================================
// FRONTEND (single-file embedded, per house style)
// ================================================================
const FRONTEND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Math Mafia — Class 10 Maths</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@500&family=Dancing+Script:wght@600&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#0B0F0D;
  --felt:#123524;
  --felt-light:#1B4A32;
  --gold:#D4AF37;
  --gold-soft:#E8C766;
  --cream:#F5EFDF;
  --red:#8C2A3B;
  --card:#151A17;
  --card-border:#2A332C;
  --muted:#9BA69C;
}
*{box-sizing:border-box; margin:0; padding:0;}
body{
  background:var(--bg);
  color:var(--cream);
  font-family:'IBM Plex Sans', sans-serif;
  min-height:100vh;
  background-image:
    radial-gradient(circle at 20% 10%, rgba(212,175,55,0.05), transparent 40%),
    radial-gradient(circle at 80% 90%, rgba(18,53,36,0.4), transparent 50%);
}
h1,h2,h3,.display{ font-family:'Oswald', sans-serif; letter-spacing:0.02em; text-transform:uppercase; }
.mono{ font-family:'IBM Plex Mono', monospace; }
::selection{ background:var(--gold); color:var(--bg); }
a{color:inherit;}
button{ font-family:inherit; cursor:pointer; }
.hidden{ display:none !important; }

/* ---------- Gate ---------- */
#gate{
  min-height:100vh; display:flex; align-items:center; justify-content:center; flex-direction:column;
  padding:24px; text-align:center;
  position:relative; overflow:hidden;
}
#gate::before{
  content:"";
  position:absolute; inset:0;
  background-image: repeating-linear-gradient(45deg, rgba(212,175,55,0.03) 0, rgba(212,175,55,0.03) 2px, transparent 2px, transparent 40px);
  pointer-events:none;
}
.badge-seal{
  width:88px; height:88px; border-radius:50%;
  border:3px solid var(--gold);
  display:flex; align-items:center; justify-content:center;
  font-family:'Oswald'; font-size:32px; font-weight:700; color:var(--gold);
  margin-bottom:22px;
  box-shadow: 0 0 0 6px rgba(212,175,55,0.08), 0 0 30px rgba(212,175,55,0.15);
  animation: sealIn 0.7s ease;
}
@keyframes sealIn{ from{ transform:scale(0.4) rotate(-25deg); opacity:0;} to{ transform:scale(1) rotate(0); opacity:1;} }
#gate h1{ font-size:clamp(32px,7vw,58px); color:var(--cream); margin-bottom:6px; }
#gate h1 span{ color:var(--gold); }
#gate .tagline{ color:var(--muted); font-size:15px; margin-bottom:36px; max-width:420px; }
.live-clock{
  position:absolute; top:22px; left:50%; transform:translateX(-50%);
  color:rgba(245,239,223,0.7); font-family:'IBM Plex Sans', sans-serif; font-size:13px;
  letter-spacing:0.04em; font-variant-numeric:tabular-nums;
}
.tagline-main{
  color:var(--cream); font-size:14px; letter-spacing:0.12em; text-transform:uppercase;
  text-align:center; margin-top:14px; margin-bottom:6px; font-family:'IBM Plex Sans', sans-serif; font-weight:500;
}
.tagline-script{
  font-family:'Dancing Script', cursive; color:var(--gold); font-size:28px;
  text-align:center; margin-bottom:14px; position:relative; display:inline-block;
  left:50%; transform:translateX(-50%);
}
.tagline-script::after{
  content:""; position:absolute; left:8%; right:8%; bottom:-6px; height:1px;
  background:linear-gradient(90deg, transparent, var(--gold), transparent);
}

/* ---------- Quote Overlay (post-gate, pre-dashboard) ---------- */
#quoteOverlay{
  position:fixed; inset:0; background:var(--bg); z-index:200;
  display:none; align-items:center; justify-content:center; flex-direction:column;
  text-align:center; padding:24px;
  opacity:0; transition:opacity 0.5s ease;
}
#quoteOverlay.show{ display:flex; opacity:1; }
#quoteOverlay .quote-mark{ font-family:'Oswald'; font-size:64px; color:var(--gold); line-height:1; margin-bottom:6px; opacity:0.85; }
#quoteOverlay .quote-text{
  font-family:'Oswald', sans-serif; font-size:clamp(22px,4.2vw,36px); color:var(--cream);
  max-width:720px; line-height:1.4; text-transform:uppercase; letter-spacing:0.01em;
}
#quoteOverlay .quote-sub{ color:var(--gold-soft); font-size:13px; letter-spacing:0.1em; text-transform:uppercase; margin-top:18px; }
#quoteOverlay .quote-hint{ color:var(--muted); font-size:11px; letter-spacing:0.06em; margin-top:26px; opacity:0.7; }
#quoteOverlay .quote-credit{ position:absolute; bottom:24px; left:0; right:0; text-align:center; color:var(--muted); font-size:11.5px; letter-spacing:0.06em; }
.name-form{ display:flex; flex-direction:column; gap:14px; width:100%; max-width:360px; }
.name-form label{ font-size:12px; letter-spacing:0.12em; text-transform:uppercase; color:var(--gold-soft); text-align:left; }
.name-form input{
  background:var(--card); border:1.5px solid var(--card-border); color:var(--cream);
  padding:14px 16px; font-size:17px; border-radius:6px; outline:none; font-family:'IBM Plex Sans';
  transition:border-color 0.15s;
}
.name-form input:focus{ border-color:var(--gold); }
.name-form .err{ color:var(--red); font-size:13px; text-align:left; min-height:16px; }
.btn{
  background:var(--gold); color:var(--bg); border:none; padding:14px 20px;
  font-family:'Oswald'; font-weight:600; font-size:15px; letter-spacing:0.06em; text-transform:uppercase;
  border-radius:6px; transition:transform 0.12s, box-shadow 0.12s;
}
.btn:hover{ transform:translateY(-1px); box-shadow:0 6px 18px rgba(212,175,55,0.25); }
.btn:active{ transform:translateY(0); }
.btn-outline{
  background:transparent; border:1.5px solid var(--card-border); color:var(--cream);
  padding:12px 18px; font-family:'Oswald'; font-weight:500; font-size:13px; letter-spacing:0.05em; text-transform:uppercase;
  border-radius:6px;
}
.btn-outline:hover{ border-color:var(--gold); color:var(--gold-soft); }
.btn-ghost{ background:transparent; border:none; color:var(--muted); font-size:13px; text-decoration:underline; }

/* ---------- App shell ---------- */
#app{ display:none; min-height:100vh; }
#app.active{ display:block; }
.topbar{
  display:flex; align-items:center; justify-content:space-between;
  padding:16px 28px; border-bottom:1px solid var(--card-border);
  position:sticky; top:0; background:rgba(11,15,13,0.92); backdrop-filter:blur(6px); z-index:50;
}
.topbar .brand{ display:flex; align-items:center; gap:10px; font-family:'Oswald'; font-weight:700; font-size:18px; }
.topbar .brand .dot{ width:10px;height:10px;border-radius:50%; background:var(--gold); }
.topbar .who{ font-size:13px; color:var(--muted); display:flex; align-items:center; gap:12px; }
.topbar .who b{ color:var(--gold-soft); }
.rec-clock{
  display:flex; align-items:center; gap:6px; font-family:'IBM Plex Mono', monospace;
  font-size:12px; color:var(--red); letter-spacing:0.06em; padding-left:12px; border-left:1px solid var(--card-border);
}
.rec-dot{ width:8px; height:8px; border-radius:50%; background:var(--red); animation:recPulse 1.2s infinite; }
@keyframes recPulse{ 0%,100%{ opacity:1; } 50%{ opacity:0.25; } }
main{ max-width:1080px; margin:0 auto; padding:32px 24px 80px; }
.section-title{ font-size:14px; color:var(--gold-soft); letter-spacing:0.12em; margin-bottom:14px; }
.crumbs{ font-size:13px; color:var(--muted); margin-bottom:18px; }
.crumbs button{ background:none;border:none;color:var(--gold-soft); text-decoration:underline; font-size:13px; }

/* ---------- Dashboard grid ---------- */
.mode-grid{ display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:16px; margin-bottom:44px; }
.mode-card{
  background:var(--card); border:1px solid var(--card-border); border-radius:10px; padding:20px;
  text-align:left; transition:border-color 0.15s, transform 0.15s;
}
.mode-card:hover{ border-color:var(--gold); transform:translateY(-2px); }
.mode-card .icon{ font-size:26px; margin-bottom:10px; display:block; }
.mode-card h3{ font-size:16px; color:var(--cream); margin-bottom:6px; }
.mode-card p{ font-size:12.5px; color:var(--muted); line-height:1.5; }

.chapter-grid{ display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:14px; }
.ch-card{
  background:var(--card); border:1px solid var(--card-border); border-radius:10px; padding:18px;
  text-align:left; position:relative; overflow:hidden;
}
.ch-card:hover{ border-color:var(--gold); }
.ch-card .num{ font-family:'Oswald'; color:var(--gold); font-size:13px; letter-spacing:0.08em; }
.ch-card h3{ font-size:16px; margin:6px 0 10px; color:var(--cream); }
.ch-card .stats{ display:flex; gap:12px; font-size:11.5px; color:var(--muted); flex-wrap:wrap; }
.ch-card .stats span{ background:rgba(212,175,55,0.08); padding:3px 8px; border-radius:20px; }
.ch-card.selectable{ cursor:pointer; }
.ch-card.selected{ border-color:var(--gold); box-shadow:inset 0 0 0 1px var(--gold); }
.ch-card.selected::after{ content:"✓ IN"; position:absolute; top:14px; right:14px; color:var(--gold); font-size:11px; font-family:'Oswald'; }

/* ---------- Chapter content view ---------- */
.tabs{ display:flex; gap:8px; margin-bottom:22px; flex-wrap:wrap; }
.tab{ background:var(--card); border:1px solid var(--card-border); color:var(--muted); padding:9px 16px; border-radius:20px; font-size:13px; }
.tab.active{ border-color:var(--gold); color:var(--gold-soft); }
.note-item{ background:var(--card); border:1px solid var(--card-border); border-left:3px solid var(--gold); border-radius:6px; padding:14px 16px; margin-bottom:10px; font-size:14.5px; line-height:1.6; color:var(--cream); }
.formula-table{ width:100%; border-collapse:collapse; margin-bottom:20px; }
.formula-table th{ text-align:left; font-size:11px; letter-spacing:0.08em; text-transform:uppercase; color:var(--gold-soft); padding:10px 12px; border-bottom:1px solid var(--card-border); }
.formula-table td{ padding:12px; border-bottom:1px solid var(--card-border); font-size:14px; vertical-align:top; }
.formula-table td.f{ font-family:'IBM Plex Mono'; color:var(--gold-soft); white-space:nowrap; }
.example-card{ background:var(--card); border:1px solid var(--card-border); border-radius:8px; padding:16px 18px; margin-bottom:12px; }
.example-card .q{ color:var(--cream); font-size:14.5px; margin-bottom:8px; font-weight:500; }
.example-card details summary{ color:var(--gold-soft); font-size:12.5px; cursor:pointer; letter-spacing:0.04em; text-transform:uppercase; }
.example-card details p{ margin-top:8px; font-size:14px; color:var(--muted); line-height:1.6; }
.ex-item{ background:var(--card); border:1px solid var(--card-border); border-radius:8px; padding:16px 18px; margin-bottom:10px; }
.ex-item .meta{ display:flex; gap:8px; margin-bottom:8px; flex-wrap:wrap; }
.ex-item .meta span{ font-size:10.5px; text-transform:uppercase; letter-spacing:0.06em; padding:3px 8px; border-radius:20px; background:rgba(212,175,55,0.1); color:var(--gold-soft); }
.ex-item .q{ font-size:14.5px; margin-bottom:8px; }
.ex-item details summary{ font-size:12.5px; color:var(--gold-soft); cursor:pointer; }
.ex-item details p{ margin-top:6px; font-size:13.5px; color:var(--muted); }

/* ---------- Quiz / Test runner ---------- */
.setup-box{ background:var(--card); border:1px solid var(--card-border); border-radius:10px; padding:24px; margin-bottom:24px; }
.setup-box label{ font-size:12px; color:var(--gold-soft); text-transform:uppercase; letter-spacing:0.08em; display:block; margin-bottom:10px; }
.count-row{ display:flex; align-items:center; gap:14px; margin:18px 0; }
.count-row input[type=range]{ flex:1; accent-color:var(--gold); }
.count-row .val{ font-family:'Oswald'; color:var(--gold); font-size:20px; width:36px; text-align:center; }
.q-progress{ font-size:12.5px; color:var(--muted); margin-bottom:8px; }
.timer{ font-family:'IBM Plex Mono'; color:var(--gold-soft); font-size:14px; }
.runner-top{ display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; }
.q-card{ background:var(--card); border:1px solid var(--card-border); border-radius:12px; padding:28px; margin-bottom:20px; }
.q-card .qtext{ font-size:17px; line-height:1.6; margin-bottom:20px; color:var(--cream); }
.q-card input[type=text]{
  width:100%; background:var(--bg); border:1.5px solid var(--card-border); color:var(--cream);
  padding:12px 14px; border-radius:6px; font-size:15px; outline:none;
}
.q-card input[type=text]:focus{ border-color:var(--gold); }
.feedback{ margin-top:12px; font-size:13.5px; padding:10px 12px; border-radius:6px; }
.feedback.correct{ background:rgba(80,160,90,0.12); color:#8FD19E; }
.feedback.wrong{ background:rgba(140,42,59,0.18); color:#E39AA6; }
.nav-row{ display:flex; justify-content:space-between; gap:12px; }

.code-display{ text-align:center; padding:32px; background:var(--card); border:1px dashed var(--gold); border-radius:12px; margin-bottom:24px; }
.code-display .code{ font-family:'Oswald'; font-size:44px; letter-spacing:0.1em; color:var(--gold); margin:10px 0; }
.lb-row{ display:flex; justify-content:space-between; align-items:center; padding:14px 16px; background:var(--card); border:1px solid var(--card-border); border-radius:8px; margin-bottom:8px; }
.lb-row .rank{ font-family:'Oswald'; color:var(--gold); width:30px; }
.lb-row.top1{ border-color:var(--gold); box-shadow:0 0 0 1px var(--gold); }
.lb-row .name{ flex:1; padding:0 12px; }
.lb-row .score{ font-family:'IBM Plex Mono'; }
.lb-row .time{ font-family:'IBM Plex Mono'; color:var(--muted); font-size:12.5px; width:70px; text-align:right; }

.result-hero{ text-align:center; padding:40px 20px; }
.result-hero .big{ font-family:'Oswald'; font-size:64px; color:var(--gold); }
.result-hero .sub{ color:var(--muted); margin-top:6px; }

.empty{ text-align:center; padding:60px 20px; color:var(--muted); }
</style>
</head>
<body>

<div id="gate">
  <div class="live-clock" id="liveClock"></div>
  <div class="badge-seal">MM</div>
  <h1>Math <span>Mafia</span></h1>
  <p class="tagline-main">Welcome to the gang, buddy.</p>
  <p class="tagline-script">It's time for a voyage.</p>
  <form class="name-form" id="gateForm">
    <label for="nameInput">Your Alias</label>
    <input id="nameInput" type="text" placeholder="e.g. Rohan 'The Rational' Sharma" autocomplete="off" autofocus>
    <div class="err" id="nameErr"></div>
    <button type="submit" class="btn">BOOYAH!!!! →</button>
  </form>
</div>

<div id="quoteOverlay">
  <div class="quote-mark">"</div>
  <p class="quote-text" id="quoteText"></p>
  <p class="quote-sub" id="quoteSub">— The Family</p>
  <p class="quote-hint">Press Enter to continue</p>
  <p class="quote-credit">Designed by: Harshit Chaubey</p>
</div>

<div id="app">
  <div class="topbar">
    <div class="brand"><span class="dot"></span> MATH MAFIA</div>
    <div class="who">Playing as <b id="whoName"></b> <button class="btn-ghost" id="switchBtn">switch</button>
      <span class="rec-clock"><span class="rec-dot"></span>REC <span id="dashClock"></span></span>
    </div>
  </div>
  <main id="main"></main>
</div>

<script>
const state = { name: '', view: 'dashboard', selectedChapters: [], chapters: [], currentChapter: null, quiz: null, quizIdx: 0, quizScore: 0, testCode: null, testTimer: null, testStart: null };

// ---------- Gate ----------
const gate = document.getElementById('gate');
const appEl = document.getElementById('app');
const nameInput = document.getElementById('nameInput');

function boot(){
  const saved = localStorage.getItem('mm_name');
  if(saved){ showQuoteThenEnter(saved); }
}
document.getElementById('gateForm').addEventListener('submit', e=>{
  e.preventDefault();
  const val = nameInput.value.trim();
  if(!val){ document.getElementById('nameErr').textContent = 'Every family member needs a name.'; return; }
  localStorage.setItem('mm_name', val);
  showQuoteThenEnter(val);
});
document.getElementById('switchBtn').addEventListener('click', ()=>{
  localStorage.removeItem('mm_name');
  appEl.classList.remove('active'); gate.style.display='flex'; nameInput.value=''; nameInput.focus();
});

// Combinatorial quote engine: OPENERS x CLOSERS gives 2000+ unique quote combinations
const QUOTE_OPENERS = [
  "In this family, we don't run from problems",
  "Every equation has a weakness",
  "Respect is earned one correct answer at a time",
  "The board doesn't forgive excuses",
  "A true don never fears a quadratic",
  "We don't lose marks around here",
  "Loyalty to the syllabus, ambition for the topper's list",
  "Numbers don't lie",
  "Some solve for x",
  "The family that practices together, tops together",
  "Nobody remembers the ones who gave up on Chapter 5",
  "A weak formula sheet is a weak alibi",
  "The exam hall shows no mercy",
  "Silence the doubts, solve the problem",
  "There's no shortcut to the topper's chair",
  "Every topper was once confused about circles too",
  "The syllabus doesn't care about your excuses",
  "One mistake doesn't end the game",
  "Consistency is the only real formula",
  "The mind that practices daily fears no exam",
  "Discipline beats talent when talent skips revision",
  "A true hustler shows up for every chapter",
  "The scoreboard remembers, not the shortcuts",
  "Fear the blank page less than the wasted hour",
  "Every proof starts with a single bold step",
  "Nobody built a legacy by skipping practice",
  "The clock is running, not waiting",
  "Small wins compound into big scores",
  "The family respects effort, not luck",
  "A sharp mind cuts through any word problem",
  "Doubt kills more marks than difficulty ever will",
  "The real competition is yesterday's you",
  "Confidence is built one solved paper at a time",
  "Nothing replaces the grind of daily practice",
  "The formula sheet is a weapon, not a crutch",
  "Every chapter conquered is territory claimed",
  "Panic never solved a single equation",
  "The sharpest minds stay calm under pressure",
  "Excellence is just habit wearing a nice suit",
  "The topper's list has no room for hesitation",
  "A calm mind finds the pattern faster",
  "Every mistake is tuition, not failure",
  "The grind doesn't care how you feel today",
  "Real players revise even when nobody's watching",
  "Marks follow effort like shadows follow light",
  "The board exam only respects preparation",
  "Greatness is built in the quiet study hours",
  "A true scholar never fears a hard question",
  "The scoreboard doesn't lie about who worked",
  "Every heist needs a plan; every exam needs revision"
];
const QUOTE_CLOSERS = [
  "we solve them",
  "find it before it finds you",
  "keep showing up",
  "so neither do we",
  "we conquer it instead",
  "we collect them",
  "that's the only code that matters",
  "so should your calculations",
  "we solve for legacy",
  "that's how the family wins",
  "so show up for every single one",
  "so sharpen it before exam day",
  "so walk in prepared",
  "then let the answer speak",
  "only steady practice up the stairs",
  "confusion is just the first step to clarity",
  "so respect it with real preparation",
  "the next attempt decides everything",
  "not luck, not shortcuts",
  "and rewards it every single time",
  "revision beats raw talent every time",
  "not just the easy ones",
  "not the loudest excuses",
  "every minute still counts",
  "and the rest follows",
  "the work always does",
  "make every minute count",
  "day after day, chapter after chapter",
  "not empty promises",
  "one careful step at a time",
  "confidence follows preparation, not the other way around",
  "and that's a fight worth winning daily",
  "one solved question at a time",
  "and no app can do that for you",
  "not a shortcut for lazy days",
  "one chapter, one win at a time",
  "not luck under pressure",
  "even when nobody's clapping",
  "and habits build champions",
  "hesitation costs more than mistakes ever will",
  "not just the loud ones",
  "not a scoreboard of regrets",
  "the mind that stays sharp finds it first",
  "there's no partial credit for giving up",
  "even when nobody's watching",
  "and no shortcut replaces it",
  "and preparation is the only currency",
  "in the hours nobody sees",
  "the syllabus rewards patience, not panic",
  "so bring the plan, execute it, and win"
];
function getRandomFamilyQuote(){
  const o = QUOTE_OPENERS[Math.floor(Math.random()*QUOTE_OPENERS.length)];
  const c = QUOTE_CLOSERS[Math.floor(Math.random()*QUOTE_CLOSERS.length)];
  return { text: o + ', ' + c + '.', author: 'The Family' };
}

// Real quotes: freedom fighters, scientists, world leaders, and Bhagavad Gita shlokas (translated)
const REAL_QUOTES = [
  { text: "Agitate, educate, organize.", author: "Dr. B.R. Ambedkar" },
  { text: "Cultivation of mind should be the ultimate aim of human existence.", author: "Dr. B.R. Ambedkar" },
  { text: "Be the change that you wish to see in the world.", author: "Mahatma Gandhi" },
  { text: "Freedom is not worth having if it does not include the freedom to make mistakes.", author: "Mahatma Gandhi" },
  { text: "Give me blood, and I shall give you freedom.", author: "Netaji Subhas Chandra Bose" },
  { text: "It is easy to kill individuals but you cannot kill the ideas.", author: "Bhagat Singh" },
  { text: "Dream is not that which you see while sleeping, it is something that does not let you sleep.", author: "Dr. A.P.J. Abdul Kalam" },
  { text: "Excellence is a continuous process and not an accident.", author: "Dr. A.P.J. Abdul Kalam" },
  { text: "If you want to shine like a sun, first burn like a sun.", author: "Dr. A.P.J. Abdul Kalam" },
  { text: "Arise, awake, and stop not till the goal is reached.", author: "Swami Vivekananda" },
  { text: "All power is within you; you can do anything and everything.", author: "Swami Vivekananda" },
  { text: "In a gentle way, you can shake the world.", author: "Mahatma Gandhi" },
  { text: "Failure will never overtake me if my determination to succeed is strong enough.", author: "Dr. A.P.J. Abdul Kalam" },
  { text: "It always seems impossible until it's done.", author: "Nelson Mandela" },
  { text: "Education is the most powerful weapon which you can use to change the world.", author: "Nelson Mandela" },
  { text: "I have not failed. I've just found 10,000 ways that won't work.", author: "Thomas Edison" },
  { text: "Imagination is more important than knowledge.", author: "Albert Einstein" },
  { text: "In the middle of difficulty lies opportunity.", author: "Albert Einstein" },
  { text: "It's not that I'm so smart, it's just that I stay with problems longer.", author: "Albert Einstein" },
  { text: "The unexamined life is not worth living.", author: "Socrates" },
  { text: "It always seems impossible until you actually start.", author: "Muhammad Ali" },
  { text: "I hated every minute of training, but I said, don't quit. Suffer now and live the rest of your life as a champion.", author: "Muhammad Ali" },
  { text: "Genius is one percent inspiration and ninety-nine percent perspiration.", author: "Thomas Edison" },
  { text: "The mind is everything. What you think you become.", author: "Gautam Buddha" },
  { text: "Do not dwell in the past, do not dream of the future, concentrate the mind on the present moment.", author: "Gautam Buddha" },
  { text: "Change is the end result of all true learning.", author: "Leo Buscaglia" },
  { text: "You have the right to work, but never to the fruit of work.", author: "Bhagavad Gita, Chapter 2, Verse 47" },
  { text: "Whatever happened, happened for good. Whatever is happening, is happening for good. Whatever will happen, will also happen for good.", author: "Bhagavad Gita, Chapter 2" },
  { text: "The soul is neither born, and nor does it die.", author: "Bhagavad Gita, Chapter 2, Verse 20" },
  { text: "Set thy heart upon thy work, but never on its reward.", author: "Bhagavad Gita, Chapter 2, Verse 47" },
  { text: "A person can rise through the efforts of his own mind; or draw himself down, in the same manner. Because each person is his own friend or enemy.", author: "Bhagavad Gita, Chapter 6, Verse 5" },
  { text: "There is neither this world, nor the world beyond, nor happiness for the one who is over-doubting.", author: "Bhagavad Gita, Chapter 4, Verse 40" },
  { text: "Man is made by his belief. As he believes, so he is.", author: "Bhagavad Gita, Chapter 17" }
];

function getRandomQuote(){
  // Roughly 40% chance of a real attributed quote, 60% chance of a generated family line
  if(Math.random() < 0.4){
    return REAL_QUOTES[Math.floor(Math.random()*REAL_QUOTES.length)];
  }
  return getRandomFamilyQuote();
}

let quoteAutoTimer = null;
let quoteKeyHandler = null;
function showQuoteThenEnter(name){
  const overlay = document.getElementById('quoteOverlay');
  const quoteText = document.getElementById('quoteText');
  const quoteSub = document.getElementById('quoteSub');
  gate.style.display='none';
  const q = getRandomQuote();
  quoteText.textContent = q.text;
  quoteSub.textContent = '— ' + q.author;
  overlay.classList.add('show');

  const finish = ()=>{
    clearTimeout(quoteAutoTimer);
    document.removeEventListener('keydown', quoteKeyHandler);
    overlay.classList.remove('show');
    setTimeout(()=>{ enterApp(name); }, 400);
  };
  quoteKeyHandler = (e)=>{ if(e.key === 'Enter') finish(); };
  document.addEventListener('keydown', quoteKeyHandler);
  quoteAutoTimer = setTimeout(finish, 6000);
}

function enterApp(name){
  state.name = name;
  gate.style.display='none';
  appEl.classList.add('active');
  document.getElementById('whoName').textContent = name;
  loadChapters().then(renderDashboard);
}

async function loadChapters(){
  const res = await fetch('/api/chapters');
  state.chapters = await res.json();
}

function esc(s){ return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// ---------- Dashboard ----------
function renderDashboard(){
  state.view='dashboard'; state.selectedChapters=[];
  const main = document.getElementById('main');
  main.innerHTML = \`
    <div class="section-title">Choose your move</div>
    <div class="mode-grid">
      <button class="mode-card" onclick="goto('notesPicker')"><span class="icon">📒</span><h3>The Intel</h3><p>Chapter-wise short notes, straight to the point.</p></button>
      <button class="mode-card" onclick="goto('formulaPicker')"><span class="icon">🧾</span><h3>Cheat Sheet</h3><p>Every formula per chapter (totally legal, we checked).</p></button>
      <button class="mode-card" onclick="goto('quizPicker')"><span class="icon">⚡</span><h3>Quick Heist</h3><p>Instant-feedback practice quiz, no pressure, no leaderboard.</p></button>
      <button class="mode-card" onclick="goto('soloPicker')"><span class="icon">🎯</span><h3>Solo Job</h3><p>Timed test on one or many chapters. Just you and the clock.</p></button>
      <button class="mode-card" onclick="goto('createWar')"><span class="icon">🤝</span><h3>Start a Gang War</h3><p>Pick chapters, get a code, challenge your crew. Leaderboard included.</p></button>
      <button class="mode-card" onclick="goto('joinWar')"><span class="icon">🔑</span><h3>Join a Gang War</h3><p>Got a code from a friend? Enter it and take them down.</p></button>
    </div>
    <div class="section-title">The Turf — 5 Chapters Loaded (more coming)</div>
    <div class="chapter-grid" id="chGrid"></div>
  \`;
  const grid = document.getElementById('chGrid');
  grid.innerHTML = state.chapters.map(c => \`
    <div class="ch-card">
      <div class="num">CH ${'$'}{c.id}</div>
      <h3>${'$'}{esc(c.title)}</h3>
      <div class="stats">
        <span>${'$'}{c.noteCount} notes</span>
        <span>${'$'}{c.formulaCount} formulas</span>
        <span>${'$'}{c.exampleCount} examples</span>
        <span>${'$'}{c.gradableCount} gradable Qs</span>
      </div>
    </div>
  \`).join('');
}

function goto(view){
  state.view = view;
  if(view==='notesPicker') renderPicker('notesPicker','The Intel','Pick a chapter to read its notes.',false,(ids)=>openChapter(ids[0],'notes'));
  else if(view==='formulaPicker') renderPicker('formulaPicker','Cheat Sheet','Pick a chapter for its formula sheet.',false,(ids)=>openChapter(ids[0],'formulas'));
  else if(view==='quizPicker') renderPicker('quizPicker','Quick Heist','Pick one or more chapters to mix questions from.',true,(ids)=>startQuiz(ids));
  else if(view==='soloPicker') renderPicker('soloPicker','Solo Job','Pick chapters for your timed test.',true,(ids)=>startSoloTest(ids));
  else if(view==='createWar') renderPicker('createWar','Start a Gang War','Pick chapters — your crew will get the exact same questions.',true,(ids)=>createGangWar(ids));
  else if(view==='joinWar') renderJoinWar();
}

function renderPicker(key,title,sub,multi,onGo){
  const main = document.getElementById('main');
  main.innerHTML = \`
    <div class="crumbs"><button onclick="renderDashboard()">← The Turf</button></div>
    <div class="section-title">${'$'}{esc(title)}</div>
    <p style="color:var(--muted); margin-bottom:20px; font-size:14px;">${'$'}{esc(sub)}</p>
    <div class="chapter-grid" id="pickGrid"></div>
    <div style="margin-top:24px; display:flex; justify-content:flex-end;">
      <button class="btn" id="pickGo">Let's Go →</button>
    </div>
  \`;
  const grid = document.getElementById('pickGrid');
  grid.innerHTML = state.chapters.map(c => \`
    <div class="ch-card selectable" data-id="${'$'}{c.id}" onclick="toggleChapter(this,${'$'}{c.id},${'$'}{multi})">
      <div class="num">CH ${'$'}{c.id}</div>
      <h3>${'$'}{esc(c.title)}</h3>
      <div class="stats"><span>${'$'}{c.gradableCount} gradable Qs</span><span>${'$'}{c.noteCount} notes</span></div>
    </div>
  \`).join('');
  state.selectedChapters = [];
  document.getElementById('pickGo').addEventListener('click', ()=>{
    if(!state.selectedChapters.length){ alert('Pick at least one chapter first.'); return; }
    onGo(state.selectedChapters);
  });
}

function toggleChapter(el,id,multi){
  if(!multi){
    document.querySelectorAll('.ch-card.selectable').forEach(c=>c.classList.remove('selected'));
    state.selectedChapters = [id];
    el.classList.add('selected');
    return;
  }
  const idx = state.selectedChapters.indexOf(id);
  if(idx>-1){ state.selectedChapters.splice(idx,1); el.classList.remove('selected'); }
  else { state.selectedChapters.push(id); el.classList.add('selected'); }
}

// ---------- Chapter content (Notes / Formulas / Examples) ----------
async function openChapter(id, tab){
  const res = await fetch('/api/chapter/'+id);
  const ch = await res.json();
  state.currentChapter = ch;
  renderChapterView(ch, tab || 'notes');
}

function renderChapterView(ch, tab){
  const main = document.getElementById('main');
  main.innerHTML = \`
    <div class="crumbs"><button onclick="renderDashboard()">← The Turf</button></div>
    <div class="section-title">CH ${'$'}{ch.chapter} — ${'$'}{esc(ch.title)}</div>
    <div class="tabs">
      <button class="tab" data-t="notes">📒 Notes</button>
      <button class="tab" data-t="formulas">🧾 Formulas</button>
      <button class="tab" data-t="examples">✏️ Examples</button>
      <button class="tab" data-t="exercises">📚 Practice Bank</button>
    </div>
    <div id="chBody"></div>
  \`;
  document.querySelectorAll('.tab').forEach(t=>{
    t.addEventListener('click', ()=>{ document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active')); t.classList.add('active'); renderChBody(ch, t.dataset.t); });
    if(t.dataset.t===tab) t.classList.add('active');
  });
  renderChBody(ch, tab);
}

function renderChBody(ch, tab){
  const body = document.getElementById('chBody');
  if(tab==='notes'){
    body.innerHTML = (ch.notes||[]).map(n=>\`<div class="note-item">${'$'}{esc(n)}</div>\`).join('') || '<div class="empty">No notes yet for this chapter.</div>';
  } else if(tab==='formulas'){
    body.innerHTML = \`<table class="formula-table"><thead><tr><th>Formula</th><th>Name</th><th>Use</th></tr></thead><tbody>\` +
      (ch.formulas||[]).map(f=>\`<tr><td class="f">${'$'}{esc(f.formula)}</td><td>${'$'}{esc(f.name)}</td><td>${'$'}{esc(f.use)}</td></tr>\`).join('') +
      \`</tbody></table>\`;
  } else if(tab==='examples'){
    body.innerHTML = (ch.examples||[]).map(e=>\`
      <div class="example-card">
        <div class="q">${'$'}{esc(e.question)}</div>
        <details><summary>Show solution</summary><p>${'$'}{esc(e.solution)}</p></details>
      </div>\`).join('') || '<div class="empty">No worked examples yet.</div>';
  } else if(tab==='exercises'){
    body.innerHTML = (ch.exercises||[]).map(e=>\`
      <div class="ex-item">
        <div class="meta"><span>${'$'}{esc(e.source||'')}</span><span>${'$'}{esc(e.topic||'')}</span><span>${'$'}{esc(e.difficulty||'')}</span></div>
        <div class="q">${'$'}{esc(e.question)}</div>
        <details><summary>Show answer</summary><p>${'$'}{esc(e.answer)}</p></details>
      </div>\`).join('') || '<div class="empty">No exercises loaded.</div>';
  }
}

// ---------- Quick Heist (practice quiz, instant feedback) ----------
async function startQuiz(chapterIds){
  const res = await fetch('/api/quiz/generate', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({chapterIds, count:10}) });
  const data = await res.json();
  if(data.error){ alert(data.error); return; }
  state.quiz = data.questions; state.quizIdx = 0; state.quizScore = 0;
  if(!state.quiz.length){ alert('No gradable questions found for that selection yet.'); renderDashboard(); return; }
  renderQuizQuestion();
}

function renderQuizQuestion(){
  const main = document.getElementById('main');
  const q = state.quiz[state.quizIdx];
  main.innerHTML = \`
    <div class="crumbs"><button onclick="renderDashboard()">← Abort Heist</button></div>
    <div class="q-progress">Question ${'$'}{state.quizIdx+1} of ${'$'}{state.quiz.length} · Score so far: ${'$'}{state.quizScore}</div>
    <div class="q-card">
      <div style="font-size:11px;color:var(--gold-soft);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:10px;">${'$'}{esc(q.chapterTitle)} · ${'$'}{esc(q.topic||'')}</div>
      <div class="qtext">${'$'}{esc(q.question)}</div>
      <input type="text" id="qAns" placeholder="Type your answer..." autocomplete="off">
      <div id="qFeedback"></div>
    </div>
    <div class="nav-row">
      <button class="btn-outline" onclick="renderDashboard()">Quit</button>
      <button class="btn" id="qSubmit">Submit Answer</button>
    </div>
  \`;
  document.getElementById('qAns').focus();
  const submit = ()=>checkQuizAnswer(q);
  document.getElementById('qSubmit').addEventListener('click', submit);
  document.getElementById('qAns').addEventListener('keydown', e=>{ if(e.key==='Enter') submit(); });
}

async function checkQuizAnswer(q){
  const val = document.getElementById('qAns').value;
  const btn = document.getElementById('qSubmit');
  if(btn.dataset.checked){
    state.quizIdx++;
    if(state.quizIdx >= state.quiz.length){ renderQuizDone(); } else { renderQuizQuestion(); }
    return;
  }
  const res = await fetch('/api/quiz/check', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({qid:q.qid, answer:val}) });
  const data = await res.json();
  if(data.correct) state.quizScore++;
  document.getElementById('qFeedback').innerHTML = \`<div class="feedback ${'$'}{data.correct?'correct':'wrong'}">${'$'}{data.correct?'✅ Correct!':'❌ Not quite. Correct answer: '+esc(data.correctAnswer)}</div>\`;
  btn.textContent = state.quizIdx+1 >= state.quiz.length ? 'Finish Heist' : 'Next Question →';
  btn.dataset.checked = '1';
}

function renderQuizDone(){
  const main = document.getElementById('main');
  main.innerHTML = \`
    <div class="result-hero">
      <div class="big">${'$'}{state.quizScore} / ${'$'}{state.quiz.length}</div>
      <div class="sub">Heist complete. Not bad, ${'$'}{esc(state.name)}.</div>
      <div style="margin-top:24px;"><button class="btn" onclick="renderDashboard()">Back to The Turf</button></div>
    </div>\`;
}

// ---------- Solo Job (timed, local only) ----------
async function startSoloTest(chapterIds){
  const res = await fetch('/api/quiz/generate', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({chapterIds, count:15}) });
  const data = await res.json();
  if(data.error || !data.questions.length){ alert(data.error||'No questions available.'); return; }
  state.quiz = data.questions.map(q=>({...q, given:''}));
  state.quizIdx = 0; state.testStart = Date.now();
  renderSoloRunner();
}

function renderSoloRunner(){
  const main = document.getElementById('main');
  const q = state.quiz[state.quizIdx];
  main.innerHTML = \`
    <div class="runner-top">
      <div class="q-progress" style="margin-bottom:0;">Question ${'$'}{state.quizIdx+1} of ${'$'}{state.quiz.length}</div>
      <div class="timer" id="soloTimer">00:00</div>
    </div>
    <div class="q-card">
      <div style="font-size:11px;color:var(--gold-soft);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:10px;">${'$'}{esc(q.chapterTitle)}</div>
      <div class="qtext">${'$'}{esc(q.question)}</div>
      <input type="text" id="qAns" value="${'$'}{esc(q.given||'')}" placeholder="Type your answer..." autocomplete="off">
    </div>
    <div class="nav-row">
      <button class="btn-outline" id="prevBtn" ${'$'}{state.quizIdx===0?'disabled':''}>← Previous</button>
      <button class="btn" id="nextBtn">${'$'}{state.quizIdx===state.quiz.length-1?'Finish Job':'Next →'}</button>
    </div>
  \`;
  document.getElementById('qAns').focus();
  clearInterval(state.testTimer);
  state.testTimer = setInterval(()=>{
    const s = Math.floor((Date.now()-state.testStart)/1000);
    const mm = String(Math.floor(s/60)).padStart(2,'0'), ss = String(s%60).padStart(2,'0');
    const t = document.getElementById('soloTimer'); if(t) t.textContent = mm+':'+ss;
  }, 500);
  document.getElementById('prevBtn').addEventListener('click', ()=>{ saveSoloAns(); state.quizIdx--; renderSoloRunner(); });
  document.getElementById('nextBtn').addEventListener('click', ()=>{
    saveSoloAns();
    if(state.quizIdx === state.quiz.length-1){ finishSoloTest(); } else { state.quizIdx++; renderSoloRunner(); }
  });
}
function saveSoloAns(){ state.quiz[state.quizIdx].given = document.getElementById('qAns').value; }

async function finishSoloTest(){
  clearInterval(state.testTimer);
  const timeTaken = Math.floor((Date.now()-state.testStart)/1000);
  let score = 0;
  const results = [];
  for(const q of state.quiz){
    const res = await fetch('/api/quiz/check', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({qid:q.qid, answer:q.given}) });
    const data = await res.json();
    if(data.correct) score++;
    results.push({...q, correct:data.correct, correctAnswer:data.correctAnswer});
  }
  const mm = String(Math.floor(timeTaken/60)).padStart(2,'0'), ss = String(timeTaken%60).padStart(2,'0');
  const main = document.getElementById('main');
  main.innerHTML = \`
    <div class="result-hero">
      <div class="big">${'$'}{score} / ${'$'}{state.quiz.length}</div>
      <div class="sub">Job done in ${'$'}{mm}:${'$'}{ss}</div>
      <div style="margin-top:24px;"><button class="btn" onclick="renderDashboard()">Back to The Turf</button></div>
    </div>
    <div class="section-title" style="margin-top:20px;">Breakdown</div>
    ${'$'}{results.map(r=>\`<div class="ex-item"><div class="q">${'$'}{esc(r.question)}</div><div class="feedback ${'$'}{r.correct?'correct':'wrong'}">${'$'}{r.correct?'✅ Correct':'❌ Your answer: '+esc(r.given||'(blank)')+' — Correct: '+esc(r.correctAnswer)}</div></div>\`).join('')}
  \`;
}

// ---------- Gang War (shared test code + leaderboard) ----------
async function createGangWar(chapterIds){
  const res = await fetch('/api/test/create', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({chapterIds, count:12, creatorName: state.name, mode:'squad'}) });
  const data = await res.json();
  if(data.error){ alert(data.error); return; }
  state.testCode = data.code;
  const main = document.getElementById('main');
  main.innerHTML = \`
    <div class="crumbs"><button onclick="renderDashboard()">← The Turf</button></div>
    <div class="code-display">
      <div style="color:var(--muted); font-size:13px; text-transform:uppercase; letter-spacing:0.08em;">Gang War Code</div>
      <div class="code">${'$'}{data.code}</div>
      <div style="color:var(--muted); font-size:13px;">Share this code with your crew — same questions, same fight.</div>
      <div style="margin-top:6px; font-size:12.5px; color:var(--gold-soft);">${'$'}{data.chapters.join(' · ')} — ${'$'}{data.questions.length} questions</div>
    </div>
    <div style="display:flex; gap:12px; justify-content:center;">
      <button class="btn" onclick="joinGangWar('${'$'}{data.code}')">Take the Test Now</button>
      <button class="btn-outline" onclick="viewLeaderboard('${'$'}{data.code}')">View Leaderboard</button>
    </div>
  \`;
}

function renderJoinWar(){
  const main = document.getElementById('main');
  main.innerHTML = \`
    <div class="crumbs"><button onclick="renderDashboard()">← The Turf</button></div>
    <div class="setup-box" style="max-width:420px; margin:40px auto; text-align:center;">
      <div class="section-title">Enter Gang War Code</div>
      <input type="text" id="joinCode" maxlength="6" placeholder="ABC123" style="width:100%; text-align:center; text-transform:uppercase; font-family:'IBM Plex Mono'; font-size:22px; letter-spacing:0.2em; background:var(--bg); border:1.5px solid var(--card-border); color:var(--gold); padding:14px; border-radius:8px; margin:16px 0;">
      <button class="btn" id="joinGo" style="width:100%;">Enter the War →</button>
    </div>
  \`;
  const go = ()=>{ const c = document.getElementById('joinCode').value.trim().toUpperCase(); if(c) joinGangWar(c); };
  document.getElementById('joinGo').addEventListener('click', go);
  document.getElementById('joinCode').addEventListener('keydown', e=>{ if(e.key==='Enter') go(); });
  document.getElementById('joinCode').focus();
}

async function joinGangWar(code){
  const res = await fetch('/api/test/'+code);
  const data = await res.json();
  if(data.error){ alert(data.error); renderDashboard(); return; }
  state.testCode = code;
  state.quiz = data.questions.map(q=>({...q, given:''}));
  state.quizIdx = 0; state.testStart = Date.now();
  renderWarRunner(data);
}

function renderWarRunner(meta){
  const main = document.getElementById('main');
  const q = state.quiz[state.quizIdx];
  main.innerHTML = \`
    <div class="runner-top">
      <div class="q-progress" style="margin-bottom:0;">Code ${'$'}{state.testCode} · Question ${'$'}{state.quizIdx+1} of ${'$'}{state.quiz.length}</div>
      <div class="timer" id="warTimer">00:00</div>
    </div>
    <div class="q-card">
      <div style="font-size:11px;color:var(--gold-soft);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:10px;">${'$'}{esc(q.chapterTitle)}</div>
      <div class="qtext">${'$'}{esc(q.question)}</div>
      <input type="text" id="qAns" value="${'$'}{esc(q.given||'')}" placeholder="Type your answer..." autocomplete="off">
    </div>
    <div class="nav-row">
      <button class="btn-outline" id="prevBtn" ${'$'}{state.quizIdx===0?'disabled':''}>← Previous</button>
      <button class="btn" id="nextBtn">${'$'}{state.quizIdx===state.quiz.length-1?'Submit to the Family':'Next →'}</button>
    </div>
  \`;
  document.getElementById('qAns').focus();
  clearInterval(state.testTimer);
  state.testTimer = setInterval(()=>{
    const s = Math.floor((Date.now()-state.testStart)/1000);
    const mm = String(Math.floor(s/60)).padStart(2,'0'), ss = String(s%60).padStart(2,'0');
    const t = document.getElementById('warTimer'); if(t) t.textContent = mm+':'+ss;
  }, 500);
  document.getElementById('prevBtn').addEventListener('click', ()=>{ saveSoloAns(); state.quizIdx--; renderWarRunner(meta); });
  document.getElementById('nextBtn').addEventListener('click', ()=>{
    saveSoloAns();
    if(state.quizIdx === state.quiz.length-1){ finishGangWar(); } else { state.quizIdx++; renderWarRunner(meta); }
  });
}

async function finishGangWar(){
  clearInterval(state.testTimer);
  const timeTaken = Math.floor((Date.now()-state.testStart)/1000);
  const answers = {}; state.quiz.forEach(q=>{ answers[q.qid] = q.given; });
  const res = await fetch('/api/test/'+state.testCode+'/submit', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name: state.name, answers, timeTakenSeconds: timeTaken }) });
  const data = await res.json();
  const mm = String(Math.floor(timeTaken/60)).padStart(2,'0'), ss = String(timeTaken%60).padStart(2,'0');
  const main = document.getElementById('main');
  main.innerHTML = \`
    <div class="result-hero">
      <div class="big">${'$'}{data.score} / ${'$'}{data.total}</div>
      <div class="sub">Submitted in ${'$'}{mm}:${'$'}{ss}. The family is watching.</div>
      <div style="margin-top:24px; display:flex; gap:12px; justify-content:center;">
        <button class="btn" onclick="viewLeaderboard('${'$'}{state.testCode}')">View Leaderboard</button>
        <button class="btn-outline" onclick="renderDashboard()">Back to The Turf</button>
      </div>
    </div>
  \`;
}

async function viewLeaderboard(code){
  const res = await fetch('/api/test/'+code+'/leaderboard');
  const data = await res.json();
  if(data.error){ alert(data.error); return; }
  const main = document.getElementById('main');
  main.innerHTML = \`
    <div class="crumbs"><button onclick="renderDashboard()">← The Turf</button></div>
    <div class="section-title">Most Wanted — Code ${'$'}{code}</div>
    <p style="color:var(--muted); font-size:13px; margin-bottom:20px;">Started by ${'$'}{esc(data.creatorName)} · ${'$'}{data.total} questions</p>
    <div id="lbList"></div>
    <div style="margin-top:20px; text-align:center;">
      <button class="btn-outline" onclick="viewLeaderboard('${'$'}{code}')">Refresh</button>
    </div>
  \`;
  const list = document.getElementById('lbList');
  if(!data.leaderboard.length){ list.innerHTML = '<div class="empty">No one has taken this test yet. Be the first.</div>'; return; }
  list.innerHTML = data.leaderboard.map((a,i)=>{
    const mm = String(Math.floor(a.timeTakenSeconds/60)).padStart(2,'0'), ss = String(a.timeTakenSeconds%60).padStart(2,'0');
    return \`<div class="lb-row ${'$'}{i===0?'top1':''}"><div class="rank">#${'$'}{i+1}</div><div class="name">${'$'}{esc(a.name)}</div><div class="score">${'$'}{a.score}/${'$'}{data.total}</div><div class="time">${'$'}{mm}:${'$'}{ss}</div></div>\`;
  }).join('');
}

function updateLiveClock(){
  const now = new Date();
  let h = now.getHours();
  const m = String(now.getMinutes()).padStart(2,'0');
  const s = String(now.getSeconds()).padStart(2,'0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if(h === 0) h = 12;
  const timeStr12 = h + ':' + m + ':' + s + ' ' + ampm;
  const gateEl = document.getElementById('liveClock');
  if(gateEl) gateEl.textContent = timeStr12;
  const dashEl = document.getElementById('dashClock');
  if(dashEl) dashEl.textContent = String(now.getHours()).padStart(2,'0') + ':' + m + ':' + s;
}
updateLiveClock();
setInterval(updateLiveClock, 1000);

boot();
</script>
</body>
</html>`;
