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

// Distinct difficulty labels actually present in the loaded question data (order of first appearance)
const DIFFICULTIES = [];
questionPool.forEach(q => {
  if (q.difficulty && !DIFFICULTIES.includes(q.difficulty)) DIFFICULTIES.push(q.difficulty);
});

function filterPool(chapterIds, difficulty) {
  return questionPool.filter(q => {
    if (!chapterIds.includes(q.chapter)) return false;
    if (difficulty && difficulty !== 'all' && String(q.difficulty).toLowerCase() !== String(difficulty).toLowerCase()) return false;
    return true;
  });
}

function pickQuestions(chapterIds, count, difficulty) {
  const pool = filterPool(chapterIds, difficulty);
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

// Metadata for setup pages (difficulty options, etc.)
app.get('/api/meta', (req, res) => {
  res.json({ difficulties: DIFFICULTIES });
});

// Live count of how many gradable questions match a chapter+difficulty selection,
// so setup pages can clamp the "number of questions" input.
app.post('/api/pool-count', (req, res) => {
  const { chapterIds, difficulty } = req.body;
  if (!Array.isArray(chapterIds) || !chapterIds.length) return res.json({ count: 0 });
  res.json({ count: filterPool(chapterIds, difficulty).length });
});

// Quick Heist (practice quiz) - instant feedback, not saved to leaderboard
app.post('/api/quiz/generate', (req, res) => {
  const { chapterIds, count, difficulty } = req.body;
  if (!Array.isArray(chapterIds) || !chapterIds.length) return res.status(400).json({ error: 'Pick at least one chapter' });
  const qids = pickQuestions(chapterIds, count || 10, difficulty);
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
  const { chapterIds, count, creatorName, mode, difficulty, timeLimitSeconds } = req.body;
  if (!Array.isArray(chapterIds) || !chapterIds.length) return res.status(400).json({ error: 'Pick at least one chapter' });
  const qids = pickQuestions(chapterIds, count || 10, difficulty);
  if (!qids.length) return res.status(400).json({ error: 'No gradable questions available for that selection' });
  const code = genCode();
  db.tests[code] = {
    code, chapterIds, qids, creatorName: creatorName || 'Anonymous',
    mode: mode || 'squad', createdAt: Date.now(),
    difficulty: difficulty || 'all',
    timeLimitSeconds: (typeof timeLimitSeconds === 'number' && timeLimitSeconds > 0) ? timeLimitSeconds : null
  };
  db.attempts[code] = [];
  saveDB(db);
  res.json({
    code, questions: questionsPublic(qids), chapters: chapterIds.map(id => chapters[id]?.title).filter(Boolean),
    timeLimitSeconds: db.tests[code].timeLimitSeconds
  });
});

app.get('/api/test/:code', (req, res) => {
  const test = db.tests[req.params.code.toUpperCase()];
  if (!test) return res.status(404).json({ error: 'No gang war found with that code' });
  res.json({
    code: test.code,
    creatorName: test.creatorName,
    chapters: test.chapterIds.map(id => chapters[id]?.title).filter(Boolean),
    questions: questionsPublic(test.qids),
    difficulty: test.difficulty || 'all',
    timeLimitSeconds: test.timeLimitSeconds || null
  });
});

app.post('/api/test/:code/submit', (req, res) => {
  const code = req.params.code.toUpperCase();
  const test = db.tests[code];
  if (!test) return res.status(404).json({ error: 'No gang war found with that code' });
  const { name, answers, timeTakenSeconds, perQuestionSeconds } = req.body;
  if (!name) return res.status(400).json({ error: 'Alias required' });

  let score = 0;
  const breakdown = test.qids.map(qid => {
    const q = questionPool.find(x => x.qid === qid);
    const userAns = (answers && answers[qid]) || '';
    const correct = q ? checkAnswer(userAns, q.answer) : false;
    if (correct) score++;
    return {
      qid, correct, yourAnswer: userAns, correctAnswer: q ? q.answer : '',
      timeSec: (perQuestionSeconds && typeof perQuestionSeconds[qid] === 'number') ? perQuestionSeconds[qid] : null
    };
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
// Catch-all for any non-API GET path: the frontend does real client-side routing
// (each chapter, setup screen, war code, etc. has its own URL), so a direct visit
// or refresh on e.g. /chapter/3 or /war/ABC123 must still get the app shell.
app.get(/^(?!\/api\/).*/, (req, res) => {
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
<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@500&family=Dancing+Script:wght@600&family=Cinzel:wght@600;700&display=swap" rel="stylesheet">
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
  text-align:center; margin:0 auto 14px; position:relative; display:inline-block;
}
.tagline-script::after{
  content:""; position:absolute; left:8%; right:8%; bottom:-6px; height:1px;
  background:linear-gradient(90deg, transparent, var(--gold), transparent);
}

/* ---------- Quote Overlay (post-gate, pre-dashboard) ---------- */
#quoteOverlay{
  position:fixed; inset:0; z-index:200;
  display:none; align-items:center; justify-content:center;
  padding:24px;
  opacity:0; transition:opacity 0.45s ease;
  background:rgba(6,9,7,0.74);
  backdrop-filter: blur(9px) saturate(115%);
  -webkit-backdrop-filter: blur(9px) saturate(115%);
}
#quoteOverlay.show{ display:flex; opacity:1; }
.quote-box{
  position:relative;
  width:100%; max-width:560px;
  background:var(--card);
  border:1.5px solid var(--card-border);
  border-radius:14px;
  padding:52px 40px 36px;
  text-align:center;
  box-shadow:0 24px 60px rgba(0,0,0,0.55), 0 0 40px rgba(212,175,55,0.06);
  transform:translateY(10px) scale(0.97); transition:transform 0.45s ease;
}
#quoteOverlay.show .quote-box{ transform:translateY(0) scale(1); }
.quote-box .badge-seal-sm{
  position:absolute; top:-28px; left:50%; transform:translateX(-50%);
  width:52px; height:52px; border-radius:50%; border:2px solid var(--gold);
  display:flex; align-items:center; justify-content:center;
  font-family:'Oswald'; font-size:18px; font-weight:700; color:var(--gold);
  background:var(--bg);
  box-shadow:0 0 0 5px rgba(212,175,55,0.08), 0 0 22px rgba(212,175,55,0.18);
}
#quoteOverlay .quote-mark{ font-family:'Oswald'; font-size:54px; color:var(--gold); line-height:1; margin-bottom:4px; opacity:0.85; }
#quoteOverlay .quote-text{
  font-family:'Oswald', sans-serif; font-size:clamp(19px,3.4vw,28px); color:var(--cream);
  line-height:1.4; text-transform:uppercase; letter-spacing:0.01em;
}
#quoteOverlay .quote-sub{ color:var(--gold-soft); font-size:13px; letter-spacing:0.1em; text-transform:uppercase; margin-top:18px; }
.quote-enter-btn{ margin-top:26px; padding:12px 34px; }
#quoteOverlay .quote-hint{ color:var(--muted); font-size:11px; letter-spacing:0.06em; margin-top:14px; opacity:0.7; }
#quoteOverlay .quote-credit{ position:absolute; bottom:22px; left:0; right:0; text-align:center; color:var(--muted); font-size:11.5px; letter-spacing:0.06em; }
.name-form{ display:flex; flex-direction:column; gap:14px; width:100%; max-width:360px; }
.name-form label{ font-size:12px; letter-spacing:0.12em; text-transform:uppercase; color:var(--gold-soft); text-align:left; }
.name-form input{
  background:var(--card); border:1.5px solid var(--card-border); color:var(--gold-soft);
  padding:14px 16px; font-size:19px; border-radius:6px; outline:none;
  font-family:'Cinzel', serif; font-weight:600; letter-spacing:0.04em;
  transition:border-color 0.15s, box-shadow 0.15s;
}
.name-form input::placeholder{ font-family:'IBM Plex Sans', sans-serif; font-weight:400; letter-spacing:0; color:var(--muted); }
.name-form input:focus{ border-color:var(--gold); box-shadow:0 0 0 3px rgba(212,175,55,0.12); }
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
.topbar .brand{ display:flex; align-items:center; gap:10px; font-family:'Oswald'; font-weight:700; font-size:18px; flex-shrink:0; }
.topbar .brand .dot{ width:10px;height:10px;border-radius:50%; background:var(--gold); }
.topbar .brand-badge{
  width:26px; height:26px; border-radius:50%; border:1.5px solid var(--gold);
  display:flex; align-items:center; justify-content:center; flex-shrink:0;
  font-family:'Oswald'; font-size:10px; font-weight:700; color:var(--gold);
  box-shadow:0 0 0 3px rgba(212,175,55,0.08), 0 0 12px rgba(212,175,55,0.15);
}
.ticker{
  flex:1; display:flex; align-items:center; justify-content:center; overflow:hidden;
  margin:0 24px; min-width:0; padding:8px 18px; border:1px solid var(--card-border);
  border-radius:8px; background:rgba(212,175,55,0.03);
}
.ticker-text{
  font-size:13px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  max-width:100%; opacity:0; transition:opacity 0.3s ease; font-family:'IBM Plex Sans', sans-serif;
}
.ticker-text .ticker-tag{ color:var(--gold-soft); font-weight:600; letter-spacing:0.04em; text-transform:uppercase; font-size:11px; margin-right:8px; }
.topbar .who{ font-size:13px; color:var(--muted); display:flex; align-items:center; gap:12px; flex-shrink:0; }
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
.mode-card .vault-count{ display:inline-block; background:var(--gold); color:var(--bg); font-family:'IBM Plex Sans'; font-size:11px; font-weight:700; padding:1px 7px; border-radius:20px; vertical-align:middle; margin-left:4px; }
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
.ch-card.clickable{ cursor:pointer; transition:border-color 0.15s, box-shadow 0.15s, transform 0.15s; }
.ch-card.clickable:hover{ border-color:var(--gold); transform:translateY(-2px); }
.ch-card.clickable.active{ border-color:var(--gold); box-shadow:inset 0 0 0 1px var(--gold), 0 0 24px rgba(212,175,55,0.14); }
.ch-card.clickable.active::after{ content:"● OPEN"; position:absolute; top:14px; right:14px; color:var(--gold); font-size:10px; font-family:'Oswald'; letter-spacing:0.06em; }
.progress-track{ height:6px; border-radius:4px; background:rgba(255,255,255,0.06); overflow:hidden; margin-top:14px; }
.progress-fill{ height:100%; border-radius:4px; background:linear-gradient(90deg, var(--gold-soft), var(--gold)); transition:width 0.4s ease; }
.progress-label{ font-size:11px; color:var(--muted); margin-top:7px; }
.progress-label .pct{ color:var(--gold-soft); font-weight:600; }

.ch-expand{ display:none; margin-top:20px; background:var(--card); border:1.5px solid var(--gold); border-radius:12px; padding:26px; }
.ch-expand.show{ display:block; animation:expandIn 0.25s ease; }
@keyframes expandIn{ from{ opacity:0; transform:translateY(-8px); } to{ opacity:1; transform:translateY(0); } }
.ch-expand .exp-head{ display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:16px; gap:12px; }
.ch-expand .exp-head h3{ font-size:20px; color:var(--cream); margin-top:4px; }
.exp-close{ background:none; border:1px solid var(--card-border); color:var(--muted); border-radius:6px; padding:7px 14px; font-size:12px; flex-shrink:0; }
.exp-close:hover{ border-color:var(--gold); color:var(--gold); }

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
.ex-item{ background:var(--card); border:1px solid var(--card-border); border-radius:8px; padding:16px 18px; margin-bottom:10px; position:relative; transition:border-color 0.2s; }
.ex-item .meta{ display:flex; gap:8px; margin-bottom:8px; flex-wrap:wrap; padding-right:30px; }
.ex-item .meta span{ font-size:10.5px; text-transform:uppercase; letter-spacing:0.06em; padding:3px 8px; border-radius:20px; background:rgba(212,175,55,0.1); color:var(--gold-soft); }
.ex-item .q{ font-size:14.5px; margin-bottom:8px; padding-right:24px; }
.ex-item details summary{ font-size:12.5px; color:var(--gold-soft); cursor:pointer; }
.ex-item details p{ margin-top:6px; font-size:13.5px; color:var(--muted); }
.ex-item.bookmarked{ border-color:rgba(212,175,55,0.45); }
.bookmark-btn{
  position:absolute; top:14px; right:14px; background:none; border:none; cursor:pointer;
  font-size:17px; color:var(--card-border); transition:color 0.15s, transform 0.15s; line-height:1; padding:2px;
}
.bookmark-btn:hover{ transform:scale(1.18); color:var(--gold-soft); }
.bookmark-btn.active{ color:var(--gold); }

/* ---------- Overall progress summary ---------- */
.summary-card{
  display:flex; justify-content:space-between; align-items:center; gap:26px; flex-wrap:wrap;
  background:linear-gradient(135deg, rgba(212,175,55,0.09), rgba(212,175,55,0.015));
  border:1px solid var(--card-border); border-radius:12px; padding:22px 26px; margin-bottom:36px;
}
.summary-left .summary-rank{ font-family:'Oswald'; font-size:22px; color:var(--gold); letter-spacing:0.03em; text-transform:uppercase; }
.summary-left .summary-sub{ font-size:12.5px; color:var(--muted); margin-top:5px; }
.summary-right{ flex:1; min-width:220px; max-width:340px; }
.summary-right .summary-pct{ font-family:'Oswald'; font-size:24px; color:var(--cream); text-align:right; margin-bottom:7px; }
.summary-right .progress-track{ height:9px; }

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
.feedback.locked{ background:rgba(212,175,55,0.08); color:var(--gold-soft); }
.nav-row{ display:flex; justify-content:space-between; gap:12px; }
.q-card input[type=text]:disabled{ opacity:0.6; cursor:not-allowed; border-color:var(--card-border); }
.time-tag{ float:right; font-family:'IBM Plex Mono'; color:var(--muted); font-size:12px; }
.setup-select{
  width:100%; background:var(--bg); border:1.5px solid var(--card-border); color:var(--cream);
  padding:11px 14px; border-radius:6px; font-size:14px; outline:none; margin-bottom:4px;
}
.setup-select:focus{ border-color:var(--gold); }
.timer-choice{ display:flex; flex-direction:column; gap:8px; margin:10px 0; }
.radio-opt{ display:flex; align-items:center; gap:8px; font-size:13.5px; color:var(--cream); text-transform:none; letter-spacing:normal; cursor:pointer; }
.radio-opt input{ accent-color:var(--gold); }

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

/* ============================================================
   RESPONSIVE — mobile, tablet, laptop
   ============================================================ */
.table-scroll{ overflow-x:auto; -webkit-overflow-scrolling:touch; margin-bottom:20px; border-radius:8px; }
.table-scroll .formula-table{ margin-bottom:0; min-width:480px; }

/* Tablet and below (~1024px): tighten main content width usage */
@media (max-width: 1024px){
  main{ padding:26px 20px 70px; }
  .mode-grid{ grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); }
}

/* Phones and small tablets (~768px) */
@media (max-width: 768px){
  .topbar{ padding:12px 16px; flex-wrap:wrap; gap:8px; row-gap:6px; }
  .topbar .brand{ font-size:15px; }
  .topbar .who{ font-size:11.5px; gap:8px; flex-wrap:wrap; }
  .ticker{ order:3; flex-basis:100%; margin:0; }
  .summary-card{ flex-direction:column; align-items:stretch; }
  .summary-right{ max-width:100%; }
  .summary-right .summary-pct{ text-align:left; }
  .rec-clock{ font-size:10.5px; padding-left:8px; gap:4px; }
  main{ padding:20px 14px 60px; }
  #gate{ padding:20px 16px; }
  .badge-seal{ width:70px; height:70px; font-size:26px; }
  .live-clock{ top:14px; font-size:11px; }
  .name-form{ max-width:100%; }
  .mode-grid{ grid-template-columns:1fr 1fr; gap:10px; }
  .mode-card{ padding:14px; }
  .mode-card .icon{ font-size:20px; margin-bottom:6px; }
  .mode-card h3{ font-size:14px; }
  .mode-card p{ font-size:11.5px; }
  .chapter-grid{ grid-template-columns:1fr; gap:10px; }
  .ch-card{ padding:14px; }
  .tabs{ gap:6px; overflow-x:auto; flex-wrap:nowrap; padding-bottom:4px; -webkit-overflow-scrolling:touch; }
  .tab{ padding:7px 12px; font-size:12px; white-space:nowrap; flex-shrink:0; }
  .setup-box{ padding:16px; }
  .q-card{ padding:18px; }
  .q-card .qtext{ font-size:15px; }
  .code-display{ padding:22px 16px; }
  .code-display .code{ font-size:30px; letter-spacing:0.06em; }
  .result-hero .big{ font-size:44px; }
  .runner-top{ flex-wrap:wrap; gap:6px; }
  .nav-row{ gap:8px; }
  .nav-row button{ flex:1; font-size:12.5px; padding:12px 10px; }
  .lb-row{ padding:11px 12px; }
  .lb-row .name{ padding:0 8px; font-size:13px; }
  #quoteOverlay .quote-mark{ font-size:44px; }
  #quoteOverlay .quote-text{ font-size:19px; }
}

/* Very small phones (~420px) */
@media (max-width: 420px){
  .mode-grid{ grid-template-columns:1fr; }
  #gate h1{ font-size:34px; }
  .tagline-script{ font-size:22px; }
  .code-display .code{ font-size:24px; letter-spacing:0.03em; }
  .topbar .who span.rec-clock{ display:none; }
}
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
  <div class="quote-box">
    <div class="badge-seal-sm">MM</div>
    <div class="quote-mark">"</div>
    <p class="quote-text" id="quoteText"></p>
    <p class="quote-sub" id="quoteSub">— The Family</p>
    <button type="button" class="btn quote-enter-btn" id="quoteEnterBtn">Enter →</button>
    <p class="quote-hint">or press Enter to continue</p>
  </div>
  <p class="quote-credit">Designed by: Harshit Chaubey</p>
</div>

<div id="app">
  <div class="topbar">
    <div class="brand"><span class="brand-badge">MM</span> MATH MAFIA</div>
    <div class="ticker" id="topTicker"><span class="ticker-text" id="tickerText"></span></div>
    <div class="who">Playing as <b id="whoName"></b> <button class="btn-ghost" id="switchBtn">switch</button>
      <span class="rec-clock"><span class="rec-dot"></span>REC <span id="dashClock"></span></span>
    </div>
  </div>
  <main id="main"></main>
</div>

<script>
const state = { name: '', view: 'dashboard', selectedChapters: [], chapters: [], meta: null, currentChapter: null, quiz: null, quizIdx: 0, quizScore: 0, testCode: null, testTimer: null, testStart: null, timeLimitSeconds: null, runnerMode: null, warMeta: null };

// ---------- Router (every screen is a real, dedicated, back-button-friendly page) ----------
function navigate(path){
  if(location.pathname + location.search !== path){ history.pushState(null, '', path); }
  route();
}
function replaceUrl(path){
  if(location.pathname + location.search !== path){ history.replaceState(null, '', path); }
}
window.addEventListener('popstate', route);

function route(){
  const path = location.pathname;
  const qs = new URLSearchParams(location.search);
  const seg = path.split('/').filter(Boolean);

  if(seg[0]==='chapter' && seg[1]) return openChapterPage(parseInt(seg[1],10), qs.get('tab')||'notes');
  if(seg[0]==='pick' && seg[1]==='notes') return renderPicker('notesPicker','The Intel','Pick a chapter to read its notes.',false,(ids)=>navigate('/chapter/'+ids[0]+'?tab=notes'));
  if(seg[0]==='pick' && seg[1]==='formulas') return renderPicker('formulaPicker','Cheat Sheet','Pick a chapter for its formula sheet.',false,(ids)=>navigate('/chapter/'+ids[0]+'?tab=formulas'));
  if(seg[0]==='pick' && seg[1]==='quiz') return renderPicker('quizPicker','Quick Heist','Pick one or more chapters to mix questions from.',true,(ids)=>navigate('/setup/quiz?ch='+ids.join(',')));
  if(seg[0]==='pick' && seg[1]==='solo') return renderPicker('soloPicker','Solo Job','Pick chapters for your timed test.',true,(ids)=>navigate('/setup/solo?ch='+ids.join(',')));
  if(seg[0]==='pick' && seg[1]==='war') return renderPicker('createWar','Start a Gang War','Pick chapters — your crew will get the exact same questions.',true,(ids)=>navigate('/setup/war?ch='+ids.join(',')));
  if(seg[0]==='pick' && seg[1]==='join') return renderJoinWar();
  if(seg[0]==='vault') return renderVault();
  if(seg[0]==='setup' && seg[1]) return renderTestSetup(seg[1], (qs.get('ch')||'').split(',').filter(Boolean).map(Number));
  if(seg[0]==='run' && seg[1]==='quiz' && state.quiz) return renderQuizQuestion();
  if(seg[0]==='run' && seg[1]==='solo' && state.quiz) return renderTimedRunner();
  if(seg[0]==='run' && seg[1]==='war' && state.quiz) return renderTimedRunner();
  if(seg[0]==='war' && seg[1]) return joinGangWar(seg[1].toUpperCase());
  if(seg[0]==='leaderboard' && seg[1]) return viewLeaderboard(seg[1].toUpperCase());
  return renderDashboard();
}

// Maps the old view-name calls (mode-grid buttons) onto real routes
function goto(view){
  const map = { notesPicker:'/pick/notes', formulaPicker:'/pick/formulas', quizPicker:'/pick/quiz', soloPicker:'/pick/solo', createWar:'/pick/war', joinWar:'/pick/join', vault:'/vault' };
  navigate(map[view] || '/');
}

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
  const enterBtn = document.getElementById('quoteEnterBtn');
  const q = getRandomQuote();
  quoteText.textContent = q.text;
  quoteSub.textContent = '— ' + q.author;
  overlay.classList.add('show');

  const finish = ()=>{
    clearTimeout(quoteAutoTimer);
    document.removeEventListener('keydown', quoteKeyHandler);
    enterBtn.removeEventListener('click', finish);
    overlay.classList.remove('show');
    setTimeout(()=>{ gate.style.display='none'; enterApp(name); }, 400);
  };
  quoteKeyHandler = (e)=>{ if(e.key === 'Enter') finish(); };
  document.addEventListener('keydown', quoteKeyHandler);
  enterBtn.addEventListener('click', finish);
  quoteAutoTimer = setTimeout(finish, 6000);
}

function enterApp(name){
  state.name = name;
  gate.style.display='none';
  appEl.classList.add('active');
  document.getElementById('whoName').textContent = name;
  Promise.all([loadChapters(), loadMeta()]).then(()=>{ route(); initTicker(); });
}

async function loadChapters(){
  const res = await fetch('/api/chapters');
  state.chapters = await res.json();
}
async function loadMeta(){
  try{ const res = await fetch('/api/meta'); state.meta = await res.json(); }
  catch(e){ state.meta = { difficulties: [] }; }
}

// ---------- Topbar question ticker ----------
let tickerPool = [];
let tickerIdx = 0;
let tickerTimer = null;
async function initTicker(){
  if(tickerTimer) return; // already running, don't restart on re-entry
  try{
    const chData = await Promise.all(state.chapters.map(c => fetch('/api/chapter/'+c.id).then(r=>r.json())));
    chData.forEach(ch=>{
      (ch.exercises||[]).forEach(e=>{ if(e.question) tickerPool.push({tag:ch.title, q:e.question}); });
      (ch.examples||[]).forEach(e=>{ if(e.question) tickerPool.push({tag:ch.title, q:e.question}); });
    });
    if(!tickerPool.length) return;
    tickerPool.sort(()=>Math.random()-0.5);
    rollTicker();
    tickerTimer = setInterval(rollTicker, 10000);
  }catch(err){ /* ticker is decorative, fail silently */ }
}
function rollTicker(){
  const el = document.getElementById('tickerText');
  if(!el || !tickerPool.length) return;
  el.style.opacity = '0';
  setTimeout(()=>{
    const item = tickerPool[tickerIdx % tickerPool.length];
    tickerIdx++;
    el.innerHTML = '<span class="ticker-tag">'+esc(item.tag)+'</span>'+esc(item.q);
    el.style.opacity = '1';
  }, 300);
}

function esc(s){ return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// ---------- Dashboard ----------
function renderDashboard(){
  state.view='dashboard'; state.selectedChapters=[];
  replaceUrl('/');
  const main = document.getElementById('main');
  const overall = getOverallProgress();
  const vaultCount = Object.keys(getBookmarks()).length;
  main.innerHTML = \`
    <div class="summary-card">
      <div class="summary-left">
        <div class="summary-rank">${'$'}{rankTitle(overall.pct)}</div>
        <div class="summary-sub">${'$'}{overall.viewed} of ${'$'}{overall.total} questions cracked across the syndicate</div>
      </div>
      <div class="summary-right">
        <div class="summary-pct">${'$'}{overall.pct}%</div>
        <div class="progress-track"><div class="progress-fill" style="width:${'$'}{overall.pct}%"></div></div>
      </div>
    </div>
    <div class="section-title">Choose your move</div>
    <div class="mode-grid">
      <button class="mode-card" onclick="goto('notesPicker')"><span class="icon">📒</span><h3>The Intel</h3><p>Chapter-wise short notes, straight to the point.</p></button>
      <button class="mode-card" onclick="goto('formulaPicker')"><span class="icon">🧾</span><h3>Cheat Sheet</h3><p>Every formula per chapter (totally legal, we checked).</p></button>
      <button class="mode-card" onclick="goto('quizPicker')"><span class="icon">⚡</span><h3>Quick Heist</h3><p>Instant-feedback practice quiz, no pressure, no leaderboard.</p></button>
      <button class="mode-card" onclick="goto('soloPicker')"><span class="icon">🎯</span><h3>Solo Job</h3><p>Timed test on one or many chapters. Just you and the clock.</p></button>
      <button class="mode-card" onclick="goto('createWar')"><span class="icon">🤝</span><h3>Start a Gang War</h3><p>Pick chapters, get a code, challenge your crew. Leaderboard included.</p></button>
      <button class="mode-card" onclick="goto('joinWar')"><span class="icon">🔑</span><h3>Join a Gang War</h3><p>Got a code from a friend? Enter it and take them down.</p></button>
      <button class="mode-card" onclick="goto('vault')"><span class="icon">⭐</span><h3>Revision Vault${'$'}{vaultCount ? \` <span class="vault-count">${'$'}{vaultCount}</span>\` : ''}</h3><p>Every question you've starred for a second look, all in one place.</p></button>
    </div>
    <div class="section-title">Contents</div>
    <div class="chapter-grid" id="chGrid"></div>
  \`;
  const grid = document.getElementById('chGrid');
  grid.innerHTML = state.chapters.map(c => {
    const total = c.exampleCount + c.exerciseCount;
    const pct = progressPct(c.id, total);
    return \`
    <div class="ch-card clickable" data-id="${'$'}{c.id}" data-total="${'$'}{total}" onclick="navigate('/chapter/${'$'}{c.id}')">
      <div class="num">CH ${'$'}{c.id}</div>
      <h3>${'$'}{esc(c.title)}</h3>
      <div class="progress-track"><div class="progress-fill" style="width:${'$'}{pct}%"></div></div>
      <div class="progress-label"><span class="pct">${'$'}{pct}%</span> complete</div>
    </div>
  \`;
  }).join('');
}

function renderPicker(key,title,sub,multi,onGo){
  const main = document.getElementById('main');
  main.innerHTML = \`
    <div class="crumbs"><button onclick="navigate('/')">← The Turf</button></div>
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

// ---------- Progress tracking (per-name, stored locally) ----------
function progressKey(){ return 'mm_progress_' + (state.name || 'guest'); }
function getProgress(){ try{ return JSON.parse(localStorage.getItem(progressKey()) || '{}'); }catch(e){ return {}; } }
function progressPct(chapterId, total){
  if(!total) return 0;
  const prog = getProgress();
  const viewed = Math.min((prog[chapterId] || []).length, total);
  return Math.round((viewed/total)*100);
}
function getOverallProgress(){
  const prog = getProgress();
  let total = 0, viewed = 0;
  state.chapters.forEach(c=>{
    const t = c.exampleCount + c.exerciseCount;
    total += t;
    viewed += Math.min((prog[c.id] || []).length, t);
  });
  return { viewed, total, pct: total ? Math.round((viewed/total)*100) : 0 };
}
function rankTitle(pct){
  if(pct >= 100) return "The Don";
  if(pct >= 75) return "Underboss";
  if(pct >= 50) return "Capo";
  if(pct >= 25) return "Soldier";
  if(pct > 0) return "Associate";
  return "Rookie";
}
function markPracticeViewed(chapterId, pid){
  const prog = getProgress();
  const arr = prog[chapterId] || [];
  if(!arr.includes(pid)){ arr.push(pid); prog[chapterId] = arr; localStorage.setItem(progressKey(), JSON.stringify(prog)); }
  const card = document.querySelector('.ch-card[data-id="'+chapterId+'"]');
  if(card){
    const total = parseInt(card.dataset.total || '0', 10);
    const pct = progressPct(chapterId, total);
    const fill = card.querySelector('.progress-fill');
    const label = card.querySelector('.progress-label .pct');
    if(fill) fill.style.width = pct + '%';
    if(label) label.textContent = pct + '%';
  }
  const summaryPct = document.querySelector('.summary-right .summary-pct');
  if(summaryPct){
    const overall = getOverallProgress();
    summaryPct.textContent = overall.pct + '%';
    const rankEl = document.querySelector('.summary-left .summary-rank');
    if(rankEl) rankEl.textContent = rankTitle(overall.pct);
    const subEl = document.querySelector('.summary-left .summary-sub');
    if(subEl) subEl.textContent = overall.viewed + ' of ' + overall.total + ' questions cracked across the syndicate';
    const fillEl = document.querySelector('.summary-right .progress-fill');
    if(fillEl) fillEl.style.width = overall.pct + '%';
  }
}

// ---------- Revision Vault (starred/bookmarked questions) ----------
function bookmarkKey(){ return 'mm_bookmarks_' + (state.name || 'guest'); }
function getBookmarks(){ try{ return JSON.parse(localStorage.getItem(bookmarkKey()) || '{}'); }catch(e){ return {}; } }
function saveBookmarks(b){ localStorage.setItem(bookmarkKey(), JSON.stringify(b)); }
function isBookmarked(key){ return !!getBookmarks()[key]; }
function toggleBookmark(btn, chapterId, chapterTitle, item){
  const key = chapterId + '::' + item.pid;
  const marks = getBookmarks();
  if(marks[key]){
    delete marks[key];
    btn.classList.remove('active'); btn.textContent = '☆';
    btn.closest('.ex-item')?.classList.remove('bookmarked');
  } else {
    marks[key] = { chapterId, chapterTitle, pid:item.pid, kind:item.kind, topic:item.topic, difficulty:item.difficulty, source:item.source, question:item.question, answer:item.answer };
    btn.classList.add('active'); btn.textContent = '★';
    btn.closest('.ex-item')?.classList.add('bookmarked');
  }
  saveBookmarks(marks);
}
function renderVault(){
  const main = document.getElementById('main');
  const marks = getBookmarks();
  const entries = Object.entries(marks);
  main.innerHTML = \`
    <div class="crumbs"><button onclick="navigate('/')">← The Turf</button></div>
    <div class="section-title">Revision Vault</div>
    <p style="color:var(--muted); margin-bottom:20px; font-size:14px;">Every question you've starred, saved for when you need one last look.</p>
    <div id="vaultBody"></div>
  \`;
  const body = document.getElementById('vaultBody');
  if(!entries.length){
    body.innerHTML = '<div class="empty">Nothing stashed yet — hit the ☆ on any question in a chapter\\'s Practice Bank to save it here.</div>';
    return;
  }
  body.innerHTML = entries.map(([key, item]) => \`
    <div class="ex-item bookmarked" data-key="${'$'}{key}">
      <button class="bookmark-btn active" data-key="${'$'}{key}">★</button>
      <div class="meta"><span>CH ${'$'}{item.chapterId} — ${'$'}{esc(item.chapterTitle)}</span>${'$'}{item.topic ? \`<span>${'$'}{esc(item.topic)}</span>\` : ''}${'$'}{item.difficulty ? \`<span>${'$'}{esc(item.difficulty)}</span>\` : ''}</div>
      <div class="q">${'$'}{esc(item.question)}</div>
      <details><summary>Show ${'$'}{item.kind==='example' ? 'solution' : 'answer'}</summary><p>${'$'}{esc(item.answer||'')}</p></details>
    </div>\`).join('');
  body.querySelectorAll('.bookmark-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const marks2 = getBookmarks();
      delete marks2[btn.dataset.key];
      saveBookmarks(marks2);
      btn.closest('.ex-item').remove();
      if(!Object.keys(marks2).length){ renderVault(); }
    });
  });
}

// A chapter's practice bank = worked examples + exercises, merged into one list
// (examples show as "worked" items with a solution, exercises show topic/difficulty/source + answer)
function mergePractice(ch){
  const examples = (ch.examples || []).map((e,i) => ({
    pid: 'ex'+i, kind:'example', topic: e.topic || 'Worked Example', difficulty: '', source: 'Example',
    question: e.question, answer: e.solution
  }));
  const exercises = (ch.exercises || []).map(e => ({
    pid: 'q'+e.id, kind:'exercise', topic: e.topic || '', difficulty: e.difficulty || '', source: e.source || '',
    question: e.question, answer: e.answer
  }));
  return [...examples, ...exercises];
}
function practiceItemHTML(item, chapterId, chapterTitle){
  const key = chapterId + '::' + item.pid;
  const marked = isBookmarked(key);
  return \`
    <div class="ex-item${'$'}{marked ? ' bookmarked' : ''}">
      <button class="bookmark-btn${'$'}{marked ? ' active' : ''}" data-pid="${'$'}{item.pid}">${'$'}{marked ? '★' : '☆'}</button>
      <div class="meta"><span>${'$'}{esc(item.source||'')}</span><span>${'$'}{esc(item.topic||'')}</span>${'$'}{item.difficulty ? \`<span>${'$'}{esc(item.difficulty)}</span>\` : ''}</div>
      <div class="q">${'$'}{esc(item.question)}</div>
      <details data-pid="${'$'}{item.pid}"><summary>Show ${'$'}{item.kind==='example' ? 'solution' : 'answer'}</summary><p>${'$'}{esc(item.answer||'')}</p></details>
    </div>\`;
}
function wirePracticeToggles(container, chapterId, chapterTitle, items){
  container.querySelectorAll('details[data-pid]').forEach(d=>{
    d.addEventListener('toggle', ()=>{ if(d.open) markPracticeViewed(chapterId, d.dataset.pid); });
  });
  const byPid = {}; items.forEach(it => byPid[it.pid] = it);
  container.querySelectorAll('.bookmark-btn[data-pid]').forEach(btn=>{
    btn.addEventListener('click', ()=> toggleBookmark(btn, chapterId, chapterTitle, byPid[btn.dataset.pid]));
  });
}

// ---------- Chapter page (its own dedicated URL: /chapter/:id) ----------
async function openChapterPage(id, tab){
  const main = document.getElementById('main');
  main.innerHTML = '<div class="empty">Loading chapter…</div>';
  const res = await fetch('/api/chapter/'+id);
  if(!res.ok){ main.innerHTML = '<div class="empty">Chapter not found.</div><div class="crumbs"><button onclick="navigate(\\'/\\')">← The Turf</button></div>'; return; }
  const ch = await res.json();
  state.currentChapter = ch;
  renderChapterView(ch, tab || 'notes');
}

function renderChapterView(ch, tab){
  replaceUrl('/chapter/'+ch.chapter+'?tab='+tab);
  const main = document.getElementById('main');
  main.innerHTML = \`
    <div class="crumbs"><button onclick="navigate('/')">← The Turf</button></div>
    <div class="section-title">CH ${'$'}{ch.chapter} — ${'$'}{esc(ch.title)}</div>
    <div class="mode-grid" style="margin-bottom:28px;">
      <button class="mode-card" onclick="navigate('/setup/quiz?ch=${'$'}{ch.chapter}')"><span class="icon">⚡</span><h3>Quick Heist</h3><p>Practice this chapter only, instant feedback.</p></button>
      <button class="mode-card" onclick="navigate('/setup/solo?ch=${'$'}{ch.chapter}')"><span class="icon">🎯</span><h3>Solo Job</h3><p>Timed test on this chapter, just you and the clock.</p></button>
      <button class="mode-card" onclick="navigate('/setup/war?ch=${'$'}{ch.chapter}')"><span class="icon">🤝</span><h3>Start a Gang War</h3><p>Challenge your crew on this chapter, code + leaderboard.</p></button>
    </div>
    <div class="tabs">
      <button class="tab" data-t="notes">📒 Notes</button>
      <button class="tab" data-t="formulas">🧾 Formulas</button>
      <button class="tab" data-t="exercises">📚 Practice Bank</button>
    </div>
    <div id="chBody"></div>
  \`;
  document.querySelectorAll('.tab').forEach(t=>{
    t.addEventListener('click', ()=>{
      document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
      t.classList.add('active');
      replaceUrl('/chapter/'+ch.chapter+'?tab='+t.dataset.t);
      renderChBody(ch, t.dataset.t);
    });
    if(t.dataset.t===tab) t.classList.add('active');
  });
  renderChBody(ch, tab);
}

function renderChBody(ch, tab){
  const body = document.getElementById('chBody');
  if(tab==='notes'){
    body.innerHTML = (ch.notes||[]).map(n=>\`<div class="note-item">${'$'}{esc(n)}</div>\`).join('') || '<div class="empty">No notes yet for this chapter.</div>';
  } else if(tab==='formulas'){
    body.innerHTML = \`<div class="table-scroll"><table class="formula-table"><thead><tr><th>Formula</th><th>Name</th><th>Use</th></tr></thead><tbody>\` +
      (ch.formulas||[]).map(f=>\`<tr><td class="f">${'$'}{esc(f.formula)}</td><td>${'$'}{esc(f.name)}</td><td>${'$'}{esc(f.use)}</td></tr>\`).join('') +
      \`</tbody></table></div>\`;
  } else if(tab==='exercises'){
    const items = mergePractice(ch);
    body.innerHTML = items.map(it=>practiceItemHTML(it, ch.chapter, ch.title)).join('') || '<div class="empty">No practice questions loaded.</div>';
    wirePracticeToggles(body, ch.chapter, ch.title, items);
  }
}

// ---------- Quick Heist (practice quiz, instant feedback) ----------
// ---------- Test setup page: difficulty, question count, timer (shared by Quiz / Solo / Gang War) ----------
async function renderTestSetup(mode, chapterIds){
  const main = document.getElementById('main');
  chapterIds = (chapterIds||[]).filter(id => state.chapters.some(c=>c.id===id));
  if(!chapterIds.length){
    main.innerHTML = \`<div class="empty">No chapters selected.</div><div class="crumbs" style="justify-content:center;margin-top:16px;"><button onclick="navigate('/')">← The Turf</button></div>\`;
    return;
  }
  const titles = chapterIds.map(id => { const c = state.chapters.find(x=>x.id===id); return c ? 'CH '+c.id+' — '+c.title : ''; }).filter(Boolean);
  const modeInfo = {
    quiz: { title:'Quick Heist Setup', sub:'Instant feedback, no leaderboard.', defCount:10, defTimer:false, defMinutes:10, goBtn:'Start Heist →', pickPath:'/pick/quiz' },
    solo: { title:'Solo Job Setup', sub:'Timed test, just you and the clock.', defCount:15, defTimer:true, defMinutes:15, goBtn:'Start the Job →', pickPath:'/pick/solo' },
    war:  { title:'Gang War Setup', sub:'Everyone who joins with your code gets these exact settings.', defCount:12, defTimer:true, defMinutes:15, goBtn:'Create the War →', pickPath:'/pick/war' }
  }[mode] || { title:'Test Setup', sub:'', defCount:10, defTimer:false, defMinutes:10, goBtn:'Start →', pickPath:'/' };

  main.innerHTML = \`
    <div class="crumbs"><button onclick="navigate('${'$'}{modeInfo.pickPath}')">← Change Chapters</button></div>
    <div class="section-title">${'$'}{esc(modeInfo.title)}</div>
    <p style="color:var(--muted); margin-bottom:20px; font-size:14px;">${'$'}{esc(modeInfo.sub)}</p>
    <div class="setup-box">
      <label>Chapters</label>
      <div style="color:var(--cream); font-size:13.5px; margin-bottom:18px;">${'$'}{titles.map(esc).join(' · ')}</div>

      <label for="diffSel">Difficulty</label>
      <select id="diffSel" class="setup-select"></select>

      <label for="countInput" style="margin-top:18px;">Number of Questions</label>
      <div class="count-row">
        <input type="number" id="countInput" min="1" value="${'$'}{modeInfo.defCount}" style="width:90px; background:var(--bg); border:1.5px solid var(--card-border); color:var(--cream); padding:10px; border-radius:6px; font-size:15px;">
        <span class="val" id="countAvail" style="width:auto; font-family:'IBM Plex Sans'; font-size:12.5px; color:var(--muted);"></span>
      </div>

      <label style="margin-top:18px;">Time Limit</label>
      <div class="timer-choice">
        <label class="radio-opt"><input type="radio" name="timerMode" id="timerNone" ${'$'}{modeInfo.defTimer?'':'checked'}> No timer — take your time</label>
        <label class="radio-opt"><input type="radio" name="timerMode" id="timerOn" ${'$'}{modeInfo.defTimer?'checked':''}> Set a time limit</label>
      </div>
      <div class="count-row" id="minutesRow" style="${'$'}{modeInfo.defTimer?'':'display:none;'}">
        <input type="number" id="minutesInput" min="1" value="${'$'}{modeInfo.defMinutes}" style="width:90px; background:var(--bg); border:1.5px solid var(--card-border); color:var(--cream); padding:10px; border-radius:6px; font-size:15px;">
        <span class="val" style="width:auto; font-family:'IBM Plex Sans'; font-size:12.5px; color:var(--muted);">minutes for the whole test</span>
      </div>
    </div>
    <div style="display:flex; justify-content:flex-end;">
      <button class="btn" id="setupGo">${'$'}{esc(modeInfo.goBtn)}</button>
    </div>
  \`;

  const diffSel = document.getElementById('diffSel');
  const difficulties = (state.meta && state.meta.difficulties) || [];
  diffSel.innerHTML = '<option value="all">All Difficulties</option>' + difficulties.map(d=>\`<option value="${'$'}{esc(d)}">${'$'}{esc(d)}</option>\`).join('');

  const countInput = document.getElementById('countInput');
  const countAvail = document.getElementById('countAvail');
  async function refreshAvailable(){
    try{
      const res = await fetch('/api/pool-count', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({chapterIds, difficulty: diffSel.value}) });
      const data = await res.json();
      const max = Math.max(data.count, 0);
      countAvail.textContent = max + ' gradable question' + (max===1?'':'s') + ' available';
      countInput.max = String(max || 1);
      if(max && parseInt(countInput.value,10) > max) countInput.value = max;
    }catch(e){ countAvail.textContent=''; }
  }
  diffSel.addEventListener('change', refreshAvailable);
  refreshAvailable();

  document.getElementById('timerNone').addEventListener('change', ()=>{ document.getElementById('minutesRow').style.display='none'; });
  document.getElementById('timerOn').addEventListener('change', ()=>{ document.getElementById('minutesRow').style.display='flex'; });

  document.getElementById('setupGo').addEventListener('click', ()=>{
    const count = Math.max(1, parseInt(countInput.value,10) || modeInfo.defCount);
    const difficulty = diffSel.value;
    const noTimer = document.getElementById('timerNone').checked;
    const minutes = Math.max(1, parseInt(document.getElementById('minutesInput').value,10) || modeInfo.defMinutes);
    const opts = { difficulty, count, timeLimitSeconds: noTimer ? null : minutes*60 };
    if(mode==='quiz') startQuiz(chapterIds, opts);
    else if(mode==='solo') startSoloTest(chapterIds, opts);
    else if(mode==='war') createGangWar(chapterIds, opts);
  });
}

// ---------- Quick Heist (practice quiz, instant feedback) ----------
async function startQuiz(chapterIds, opts){
  opts = opts || {};
  const res = await fetch('/api/quiz/generate', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({chapterIds, count: opts.count||10, difficulty: opts.difficulty||'all'}) });
  const data = await res.json();
  if(data.error){ alert(data.error); return; }
  state.quiz = data.questions.map(q=>({...q, given:'', submitted:false, shownAt:null, timeSec:null}));
  state.quizIdx = 0; state.quizScore = 0;
  state.timeLimitSeconds = opts.timeLimitSeconds || null;
  state.testStart = Date.now();
  if(!state.quiz.length){ alert('No gradable questions found for that selection yet.'); navigate('/'); return; }
  navigate('/run/quiz');
}

function renderQuizQuestion(){
  const main = document.getElementById('main');
  const q = state.quiz[state.quizIdx];
  if(!q.submitted && q.shownAt==null) q.shownAt = Date.now();
  main.innerHTML = \`
    <div class="crumbs"><button onclick="navigate('/')">← Abort Heist</button></div>
    <div class="runner-top">
      <div class="q-progress" style="margin-bottom:0;">Question ${'$'}{state.quizIdx+1} of ${'$'}{state.quiz.length} · Score so far: ${'$'}{state.quizScore}</div>
      <div class="timer" id="runTimer">00:00</div>
    </div>
    <div class="q-card">
      <div style="font-size:11px;color:var(--gold-soft);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:10px;">${'$'}{esc(q.chapterTitle)} · ${'$'}{esc(q.topic||'')}${'$'}{q.difficulty?' · '+esc(q.difficulty):''}</div>
      <div class="qtext">${'$'}{esc(q.question)}</div>
      <input type="text" id="qAns" value="${'$'}{esc(q.given||'')}" placeholder="Type your answer..." autocomplete="off" ${'$'}{q.submitted?'disabled':''}>
      <div id="qFeedback">${'$'}{q.submitted ? \`<div class="feedback ${'$'}{q.correct?'correct':'wrong'}">${'$'}{q.correct?'✅ Correct!':'❌ Not quite. Correct answer: '+esc(q.correctAnswer||'')}<span class="time-tag">⏱ ${'$'}{q.timeSec}s</span></div>\` : ''}</div>
    </div>
    <div class="nav-row">
      <button class="btn-outline" onclick="navigate('/')">Quit</button>
      <button class="btn" id="qSubmit">${'$'}{q.submitted ? (state.quizIdx+1>=state.quiz.length?'Finish Heist':'Next Question →') : 'Submit Answer'}</button>
    </div>
  \`;
  const input = document.getElementById('qAns');
  if(!q.submitted) input.focus();
  clearInterval(state.testTimer);
  state.testTimer = setInterval(()=>{
    const s = Math.floor((Date.now()-state.testStart)/1000);
    const mm = String(Math.floor(s/60)).padStart(2,'0'), ss = String(s%60).padStart(2,'0');
    const t = document.getElementById('runTimer'); if(t) t.textContent = mm+':'+ss;
  }, 500);
  const act = ()=>checkQuizAnswer(q);
  document.getElementById('qSubmit').addEventListener('click', act);
  if(!q.submitted) input.addEventListener('keydown', e=>{ if(e.key==='Enter') act(); });
}

async function checkQuizAnswer(q){
  if(q.submitted){
    state.quizIdx++;
    if(state.quizIdx >= state.quiz.length){ clearInterval(state.testTimer); renderQuizDone(); } else { renderQuizQuestion(); }
    return;
  }
  const val = document.getElementById('qAns').value;
  const res = await fetch('/api/quiz/check', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({qid:q.qid, answer:val}) });
  const data = await res.json();
  q.given = val; q.submitted = true; q.correct = data.correct; q.correctAnswer = data.correctAnswer;
  q.timeSec = Math.max(0, Math.round((Date.now()-q.shownAt)/1000));
  if(data.correct) state.quizScore++;
  renderQuizQuestion();
}

function renderQuizDone(){
  const main = document.getElementById('main');
  main.innerHTML = \`
    <div class="result-hero">
      <div class="big">${'$'}{state.quizScore} / ${'$'}{state.quiz.length}</div>
      <div class="sub">Heist complete. Not bad, ${'$'}{esc(state.name)}.</div>
      <div style="margin-top:24px;"><button class="btn" onclick="navigate('/')">Back to The Turf</button></div>
    </div>
    <div class="section-title" style="margin-top:20px;">Breakdown</div>
    ${'$'}{state.quiz.map(r=>\`<div class="ex-item"><div class="q">${'$'}{esc(r.question)}</div><div class="feedback ${'$'}{r.correct?'correct':'wrong'}">${'$'}{r.correct?'✅ Correct':'❌ Your answer: '+esc(r.given||'(blank)')+' — Correct: '+esc(r.correctAnswer||'')}<span class="time-tag">⏱ ${'$'}{r.timeSec!=null?r.timeSec+'s':'—'}</span></div></div>\`).join('')}
  \`;
}

// ---------- Shared timed runner (Solo Job + Gang War): explicit submit, then answer is locked ----------
function renderTimedRunner(){
  const main = document.getElementById('main');
  const q = state.quiz[state.quizIdx];
  if(!q.submitted && q.shownAt==null) q.shownAt = Date.now();
  const isWar = state.runnerMode==='war';
  const codeLabel = isWar ? 'Code '+state.testCode+' · ' : '';
  const isLast = state.quizIdx === state.quiz.length-1;
  main.innerHTML = \`
    <div class="runner-top">
      <div class="q-progress" style="margin-bottom:0;">${'$'}{codeLabel}Question ${'$'}{state.quizIdx+1} of ${'$'}{state.quiz.length}</div>
      <div class="timer" id="runTimer">00:00</div>
    </div>
    <div class="q-card">
      <div style="font-size:11px;color:var(--gold-soft);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:10px;">${'$'}{esc(q.chapterTitle)}${'$'}{q.difficulty?' · '+esc(q.difficulty):''}</div>
      <div class="qtext">${'$'}{esc(q.question)}</div>
      <input type="text" id="qAns" value="${'$'}{esc(q.given||'')}" placeholder="Type your answer..." autocomplete="off" ${'$'}{q.submitted?'disabled':''}>
      ${'$'}{q.submitted ? \`<div class="feedback locked">🔒 Answer locked<span class="time-tag">⏱ ${'$'}{q.timeSec}s</span></div>\` : ''}
    </div>
    <div class="nav-row">
      <button class="btn-outline" id="prevBtn" ${'$'}{state.quizIdx===0?'disabled':''}>← Previous</button>
      <button class="btn" id="actionBtn">${'$'}{q.submitted ? (isLast?(isWar?'Submit to the Family':'Finish Job'):'Next →') : 'Submit Answer'}</button>
    </div>
  \`;
  const input = document.getElementById('qAns');
  if(!q.submitted) input.focus();
  clearInterval(state.testTimer);
  state.testTimer = setInterval(()=>{
    const t = document.getElementById('runTimer');
    if(!t) return;
    if(state.timeLimitSeconds){
      const remain = state.timeLimitSeconds - Math.floor((Date.now()-state.testStart)/1000);
      if(remain <= 0){ t.textContent = '00:00'; clearInterval(state.testTimer); autoFinishOnTimeout(); return; }
      const mm = String(Math.floor(remain/60)).padStart(2,'0'), ss = String(remain%60).padStart(2,'0');
      t.textContent = mm+':'+ss;
    } else {
      const s = Math.floor((Date.now()-state.testStart)/1000);
      const mm = String(Math.floor(s/60)).padStart(2,'0'), ss = String(s%60).padStart(2,'0');
      t.textContent = mm+':'+ss;
    }
  }, 500);
  document.getElementById('prevBtn').addEventListener('click', ()=>{ if(!q.submitted) q.given = input.value; state.quizIdx--; renderTimedRunner(); });
  document.getElementById('actionBtn').addEventListener('click', ()=>{
    if(!q.submitted){
      q.given = input.value;
      q.submitted = true;
      q.timeSec = Math.max(0, Math.round((Date.now()-q.shownAt)/1000));
      renderTimedRunner();
      return;
    }
    if(isLast){ clearInterval(state.testTimer); if(isWar) finishGangWar(); else finishSoloTest(); }
    else { state.quizIdx++; renderTimedRunner(); }
  });
  if(!q.submitted){
    input.addEventListener('keydown', e=>{ if(e.key==='Enter'){ document.getElementById('actionBtn').click(); } });
  }
}
function autoFinishOnTimeout(){
  const curInput = document.getElementById('qAns');
  state.quiz.forEach((q,i)=>{
    if(!q.submitted){
      if(i===state.quizIdx && curInput) q.given = curInput.value;
      q.timeSec = q.shownAt ? Math.max(0, Math.round((Date.now()-q.shownAt)/1000)) : 0;
      q.submitted = true;
    }
  });
  if(state.runnerMode==='war') finishGangWar(); else finishSoloTest();
}

// ---------- Solo Job (timed, local only) ----------
async function startSoloTest(chapterIds, opts){
  opts = opts || {};
  const res = await fetch('/api/quiz/generate', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({chapterIds, count: opts.count||15, difficulty: opts.difficulty||'all'}) });
  const data = await res.json();
  if(data.error || !data.questions.length){ alert(data.error||'No questions available.'); return; }
  state.quiz = data.questions.map(q=>({...q, given:'', submitted:false, shownAt:null, timeSec:null}));
  state.quizIdx = 0; state.testStart = Date.now(); state.runnerMode = 'solo';
  state.timeLimitSeconds = opts.timeLimitSeconds || null;
  navigate('/run/solo');
}

async function finishSoloTest(){
  clearInterval(state.testTimer);
  const timeTaken = Math.floor((Date.now()-state.testStart)/1000);
  let score = 0;
  for(const q of state.quiz){
    const res = await fetch('/api/quiz/check', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({qid:q.qid, answer:q.given}) });
    const data = await res.json();
    q.correct = data.correct; q.correctAnswer = data.correctAnswer;
    if(data.correct) score++;
  }
  const mm = String(Math.floor(timeTaken/60)).padStart(2,'0'), ss = String(timeTaken%60).padStart(2,'0');
  const main = document.getElementById('main');
  main.innerHTML = \`
    <div class="result-hero">
      <div class="big">${'$'}{score} / ${'$'}{state.quiz.length}</div>
      <div class="sub">Job done in ${'$'}{mm}:${'$'}{ss}</div>
      <div style="margin-top:24px;"><button class="btn" onclick="navigate('/')">Back to The Turf</button></div>
    </div>
    <div class="section-title" style="margin-top:20px;">Breakdown</div>
    ${'$'}{state.quiz.map(r=>\`<div class="ex-item"><div class="q">${'$'}{esc(r.question)}</div><div class="feedback ${'$'}{r.correct?'correct':'wrong'}">${'$'}{r.correct?'✅ Correct':'❌ Your answer: '+esc(r.given||'(blank)')+' — Correct: '+esc(r.correctAnswer||'')}<span class="time-tag">⏱ ${'$'}{r.timeSec!=null?r.timeSec+'s':'—'}</span></div></div>\`).join('')}
  \`;
}

// ---------- Gang War (shared test code + leaderboard) ----------
async function createGangWar(chapterIds, opts){
  opts = opts || {};
  const res = await fetch('/api/test/create', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({chapterIds, count: opts.count||12, creatorName: state.name, mode:'squad', difficulty: opts.difficulty||'all', timeLimitSeconds: opts.timeLimitSeconds||null}) });
  const data = await res.json();
  if(data.error){ alert(data.error); return; }
  state.testCode = data.code;
  const main = document.getElementById('main');
  main.innerHTML = \`
    <div class="crumbs"><button onclick="navigate('/')">← The Turf</button></div>
    <div class="code-display">
      <div style="color:var(--muted); font-size:13px; text-transform:uppercase; letter-spacing:0.08em;">Gang War Code</div>
      <div class="code">${'$'}{data.code}</div>
      <div style="color:var(--muted); font-size:13px;">Share this code with your crew — same questions, same rules, same fight.</div>
      <div style="margin-top:6px; font-size:12.5px; color:var(--gold-soft);">${'$'}{data.chapters.join(' · ')} — ${'$'}{data.questions.length} questions${'$'}{data.timeLimitSeconds ? ' · '+Math.round(data.timeLimitSeconds/60)+' min limit' : ' · no timer'}</div>
    </div>
    <div style="display:flex; gap:12px; justify-content:center;">
      <button class="btn" onclick="navigate('/war/${'$'}{data.code}')">Take the Test Now</button>
      <button class="btn-outline" onclick="navigate('/leaderboard/${'$'}{data.code}')">View Leaderboard</button>
    </div>
  \`;
}

function renderJoinWar(){
  const main = document.getElementById('main');
  main.innerHTML = \`
    <div class="crumbs"><button onclick="navigate('/')">← The Turf</button></div>
    <div class="setup-box" style="max-width:420px; margin:40px auto; text-align:center;">
      <div class="section-title">Enter Gang War Code</div>
      <input type="text" id="joinCode" maxlength="6" placeholder="ABC123" style="width:100%; text-align:center; text-transform:uppercase; font-family:'IBM Plex Mono'; font-size:22px; letter-spacing:0.2em; background:var(--bg); border:1.5px solid var(--card-border); color:var(--gold); padding:14px; border-radius:8px; margin:16px 0;">
      <button class="btn" id="joinGo" style="width:100%;">Enter the War →</button>
    </div>
  \`;
  const go = ()=>{ const c = document.getElementById('joinCode').value.trim().toUpperCase(); if(c) navigate('/war/'+c); };
  document.getElementById('joinGo').addEventListener('click', go);
  document.getElementById('joinCode').addEventListener('keydown', e=>{ if(e.key==='Enter') go(); });
  document.getElementById('joinCode').focus();
}

async function joinGangWar(code){
  const main = document.getElementById('main');
  main.innerHTML = '<div class="empty">Entering the war…</div>';
  const res = await fetch('/api/test/'+code);
  const data = await res.json();
  if(data.error){ alert(data.error); navigate('/'); return; }
  state.testCode = code;
  state.quiz = data.questions.map(q=>({...q, given:'', submitted:false, shownAt:null, timeSec:null}));
  state.quizIdx = 0; state.testStart = Date.now(); state.runnerMode = 'war';
  state.timeLimitSeconds = data.timeLimitSeconds || null;
  renderTimedRunner();
}

async function finishGangWar(){
  clearInterval(state.testTimer);
  const timeTaken = Math.floor((Date.now()-state.testStart)/1000);
  const answers = {}; const perQuestionSeconds = {};
  state.quiz.forEach(q=>{ answers[q.qid] = q.given; perQuestionSeconds[q.qid] = q.timeSec; });
  const res = await fetch('/api/test/'+state.testCode+'/submit', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name: state.name, answers, timeTakenSeconds: timeTaken, perQuestionSeconds }) });
  const data = await res.json();
  const mm = String(Math.floor(timeTaken/60)).padStart(2,'0'), ss = String(timeTaken%60).padStart(2,'0');
  const byQid = {}; (data.breakdown||[]).forEach(b=>byQid[b.qid]=b);
  const main = document.getElementById('main');
  main.innerHTML = \`
    <div class="result-hero">
      <div class="big">${'$'}{data.score} / ${'$'}{data.total}</div>
      <div class="sub">Submitted in ${'$'}{mm}:${'$'}{ss}. The family is watching.</div>
      <div style="margin-top:24px; display:flex; gap:12px; justify-content:center;">
        <button class="btn" onclick="navigate('/leaderboard/${'$'}{state.testCode}')">View Leaderboard</button>
        <button class="btn-outline" onclick="navigate('/')">Back to The Turf</button>
      </div>
    </div>
    <div class="section-title" style="margin-top:20px;">Breakdown</div>
    ${'$'}{state.quiz.map(q=>{ const b = byQid[q.qid]||{}; return \`<div class="ex-item"><div class="q">${'$'}{esc(q.question)}</div><div class="feedback ${'$'}{b.correct?'correct':'wrong'}">${'$'}{b.correct?'✅ Correct':'❌ Your answer: '+esc(q.given||'(blank)')+' — Correct: '+esc(b.correctAnswer||'')}<span class="time-tag">⏱ ${'$'}{q.timeSec!=null?q.timeSec+'s':'—'}</span></div></div>\`; }).join('')}
  \`;
}

async function viewLeaderboard(code){
  const main = document.getElementById('main');
  main.innerHTML = '<div class="empty">Loading leaderboard…</div>';
  const res = await fetch('/api/test/'+code+'/leaderboard');
  const data = await res.json();
  if(data.error){ alert(data.error); navigate('/'); return; }
  main.innerHTML = \`
    <div class="crumbs"><button onclick="navigate('/')">← The Turf</button></div>
    <div class="section-title">Most Wanted — Code ${'$'}{esc(code)}</div>
    <p style="color:var(--muted); font-size:13px; margin-bottom:20px;">Started by ${'$'}{esc(data.creatorName)} · ${'$'}{data.total} questions</p>
    <div id="lbList"></div>
    <div style="margin-top:20px; text-align:center;">
      <button class="btn-outline" id="lbRefresh">Refresh</button>
    </div>
  \`;
  document.getElementById('lbRefresh').addEventListener('click', ()=>viewLeaderboard(code));
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
