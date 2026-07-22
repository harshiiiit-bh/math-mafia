const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// Serve question/answer diagram images referenced by PYP papers, e.g.
// /assets/science/questions/2026-set1/q4.png -> <repo-root>/assets/science/questions/2026-set1/q4.png
app.use('/assets', express.static(path.join(__dirname, 'assets')));

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(__dirname, 'db.json');

// ---------- Subjects ----------
// One folder per subject under data/<subjectId>/*.json for chapters, data/<subjectId>/pyp/*.json for
// previous-year papers. Every subject uses the exact same JSON schema, so all study modes (notes,
// formulas, Quick Heist, Solo Job, Gang War, Previous Papers) work identically for each one.
const SUBJECTS = [
  { id: 'maths', name: 'Maths', icon: '📐' },
  { id: 'science', name: 'Science', icon: '🔬' },
  { id: 'sst', name: 'SST', icon: '🌍' },
  { id: 'english', name: 'English', icon: '📖' }
];
const SUBJECT_IDS = SUBJECTS.map(s => s.id);

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

// Strip trailing/inline parenthetical explanations, e.g. "B (probability can never be negative)" -> "B "
function stripParenthetical(str) {
  return String(str).replace(/\([^)]*\)/g, ' ');
}
function normalize(str) {
  return String(str).toLowerCase().replace(/rs\.?|₹|cm|m\b|degrees?|deg\b/g, '').replace(/[^a-z0-9.\-]/g, '').trim();
}
function checkAnswer(userAns, correctAns) {
  const u = normalize(userAns);
  // Compare against both the full correct answer and a version with parenthetical
  // explanations stripped, so "B" matches "B (probability can never be negative)".
  const c = normalize(correctAns);
  const cCore = normalize(stripParenthetical(correctAns));
  if (!u) return false;
  if (u === c || u === cCore) return true;
  // allow partial containment for multi-part answers e.g. "13 and 14"
  if ((c.includes(u) && u.length >= 2) || (u.includes(c) && c.length >= 2)) return true;
  return (cCore.includes(u) && u.length >= 2) || (u.includes(cCore) && cCore.length >= 2);
}

// Strip diagram markers/punctuation before comparing question text across papers (duplicate detection)
function normalizeQuestionText(raw) {
  return String(raw || '')
    .replace(/\[DIAGRAM:[^\]]*\]/gi, ' ')       // ignore image references when comparing
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')          // strip punctuation/symbols
    .replace(/\s+/g, ' ')
    .trim();
}
function textSimilarity(a, b) {
  if (!a || !b) return 0;
  const tokenize = s => s.split(' ').filter(w => w.length > 2 || /^\d+$/.test(w));
  const wordsA = new Set(tokenize(a));
  const wordsB = new Set(tokenize(b));
  if (!wordsA.size || !wordsB.size) return 0;
  let shared = 0;
  wordsA.forEach(w => { if (wordsB.has(w)) shared++; });
  return shared / Math.max(wordsA.size, wordsB.size); // Jaccard-style overlap, 0..1
}
const SIMILARITY_DUPLICATE_THRESHOLD = 0.85; // catches lightly-reworded repeats, same chapter only

// Subjects that are really bundles of separate books (SST) or a single book worth grouping for
// browsing (Science) get a "branch" registry. Chapter numbering in SST restarts per book (History
// ch.1, Geography ch.1, ...) so branch is NOT just cosmetic there — it's what keeps chapter ids
// unique. Science numbers straight through 1-13, so branch is purely an organizational filter.
const BRANCHES = {
  science: [
    { id: 'physics', name: 'Physics' },
    { id: 'chemistry', name: 'Chemistry' },
    { id: 'biology', name: 'Biology' }
  ],
  sst: [
    { id: 'history', name: 'History' },
    { id: 'geography', name: 'Geography' },
    { id: 'economics', name: 'Economics' },
    { id: 'civics', name: 'Civics' }
  ]
};
function branchesFor(subjectId) { return BRANCHES[subjectId] || []; }
function branchName(subjectId, branchId) {
  const b = branchesFor(subjectId).find(x => x.id === branchId);
  return b ? b.name : branchId;
}
// The globally-unique id for a chapter: "<branch>-<chapterNum>" when the chapter has a branch
// (put "branch": "history" in that chapter's JSON), otherwise just the plain chapter number as
// a string. This id is what URLs, qids, and every chapterIds[] filter actually key off.
function chapterCompositeId(branch, chapterNum) {
  return branch ? `${branch}-${chapterNum}` : String(chapterNum);
}

// ---------- Load one subject's data (chapters + PYP papers), fully self-contained ----------
// qids are namespaced "<subjectId>:<...>" so they stay globally unique once tests/gang wars start
// mixing questions across subjects — findQuestionByQid() below resolves any qid from any subject.
function loadSubject(subjectId) {
  const subjDir = path.join(DATA_DIR, subjectId);
  const chapters = {}; // composite id -> chapter object
  if (fs.existsSync(subjDir)) {
    fs.readdirSync(subjDir).filter(f => f.endsWith('.json')).forEach(f => {
      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(path.join(subjDir, f), 'utf8'));
      } catch (err) {
        // A typo or trailing comma in ONE chapter file must never take the whole site down.
        // Skip just this file and keep going — every other chapter still loads and works.
        console.error(`[Study Mafia] Skipping broken file data/${subjectId}/${f}: ${err.message}`);
        return;
      }
      const branch = raw.branch || null;
      const id = chapterCompositeId(branch, raw.chapter);
      raw.id = id;
      raw.branch = branch;
      chapters[id] = raw;
    });
  }
  const chapterList = Object.values(chapters).sort((a, b) => {
    if (a.chapter !== b.chapter) return a.chapter - b.chapter;
    return (a.branch || '').localeCompare(b.branch || '');
  });

  const questionPool = [];
  chapterList.forEach(ch => {
    (ch.exercises || []).forEach(ex => {
      if (isGradable(ex)) {
        questionPool.push({
          qid: `${subjectId}:${ch.id}-${ex.id}`,
          subject: subjectId, chapterId: ch.id, chapter: ch.chapter, branch: ch.branch, chapterTitle: ch.title,
          topic: ex.topic, difficulty: ex.difficulty, question: ex.question,
          answer: ex.answer, source: ex.source
        });
      }
    });
  });

  const DIFFICULTIES = [];
  questionPool.forEach(q => {
    if (q.difficulty && !DIFFICULTIES.includes(q.difficulty)) DIFFICULTIES.push(q.difficulty);
  });

  // ---------- Previous Year Papers (PYP) for this subject ----------
  const PYP_DIR = path.join(subjDir, 'pyp');
  const papers = {};
  if (fs.existsSync(PYP_DIR)) {
    fs.readdirSync(PYP_DIR).filter(f => f.endsWith('.json')).forEach(f => {
      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(path.join(PYP_DIR, f), 'utf8'));
      } catch (err) {
        console.error(`[Study Mafia] Skipping broken file data/${subjectId}/pyp/${f}: ${err.message}`);
        return;
      }
      const paperId = raw.id || `${raw.year}-set${raw.set || 1}`;
      raw.id = paperId;
      papers[paperId] = raw;
    });
  }
  const paperList = Object.values(papers).sort((a, b) => (b.year - a.year) || ((a.set || 1) - (b.set || 1)));
  function paperLabelFor(p) { return `${p.board ? p.board + ' ' : ''}${p.year}${p.set ? ' Set ' + p.set : ''}`; }

  const pypPool = [];
  paperList.forEach(p => {
    (p.questions || []).forEach((ex, idx) => {
      const qid = `${subjectId}:pyp-${p.id}-${ex.id != null ? ex.id : idx + 1}`;
      // A PYP question can specify its own "branch" (needed for SST papers spanning books);
      // if omitted it falls back to whatever branch that chapter number is already registered under.
      const exBranch = ex.branch || (Object.values(chapters).find(c => c.chapter === ex.chapter) || {}).branch || null;
      const chapterId = chapterCompositeId(exBranch, ex.chapter);
      pypPool.push({
        qid, subject: subjectId, paperId: p.id, paperLabel: paperLabelFor(p),
        year: p.year, set: p.set || 1, order: idx,
        chapterId, chapter: ex.chapter, branch: exBranch,
        chapterTitle: (chapters[chapterId] && chapters[chapterId].title) || ('Chapter ' + ex.chapter),
        topic: ex.topic, difficulty: ex.difficulty, marks: ex.marks,
        question: ex.question, answer: ex.answer, gradable: isGradable(ex)
      });
    });
  });

  // Duplicate detection across PYP papers: CBSE previous-year/sample papers frequently reuse the
  // exact same question, verbatim or lightly reworded, across different years/sets. Only the FIRST
  // occurrence (earliest year, then earliest set, then original order) stays eligible for shuffled
  // cross-paper pools. This never touches a specific full-paper run — those read a paper's own
  // question list directly, so every real paper still shows intact.
  (function detectPypDuplicates() {
    const sorted = [...pypPool].sort((a, b) => (a.year - b.year) || (a.set - b.set) || (a.order - b.order));
    const seenByExactText = new Map();
    const keptByChapter = {};
    sorted.forEach(q => {
      const norm = normalizeQuestionText(q.question);
      q.normText = norm;
      q.isDuplicate = false;
      q.duplicateOf = null;
      if (!norm) return;
      if (seenByExactText.has(norm)) { q.isDuplicate = true; q.duplicateOf = seenByExactText.get(norm); return; }
      const bucket = keptByChapter[q.chapterId] || (keptByChapter[q.chapterId] = []);
      const near = bucket.find(o => textSimilarity(norm, o.norm) >= SIMILARITY_DUPLICATE_THRESHOLD);
      if (near) { q.isDuplicate = true; q.duplicateOf = near.qid; return; }
      seenByExactText.set(norm, q.qid);
      bucket.push({ qid: q.qid, norm });
    });
  })();

  function filterPool(chapterIds, difficulty) {
    return questionPool.filter(q => {
      if (!chapterIds.includes(q.chapterId)) return false;
      if (difficulty && difficulty !== 'all' && String(q.difficulty).toLowerCase() !== String(difficulty).toLowerCase()) return false;
      return true;
    });
  }
  function pickQuestions(chapterIds, count, difficulty) {
    const pool = filterPool(chapterIds, difficulty);
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(count, shuffled.length)).map(q => q.qid);
  }
  function pypGradablePool() { return pypPool.filter(q => q.gradable && !q.isDuplicate); }
  function filterPypPool(chapterIds, difficulty) {
    return pypGradablePool().filter(q => {
      if (Array.isArray(chapterIds) && chapterIds.length && !chapterIds.includes(q.chapterId)) return false;
      if (difficulty && difficulty !== 'all' && String(q.difficulty).toLowerCase() !== String(difficulty).toLowerCase()) return false;
      return true;
    });
  }
  function pickPypQuestions(chapterIds, count, difficulty) {
    const pool = filterPypPool(chapterIds, difficulty);
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(count, shuffled.length)).map(q => q.qid);
  }
  function paperGradableQids(paperId) {
    return pypPool.filter(q => q.paperId === paperId && q.gradable).sort((a, b) => a.order - b.order).map(q => q.qid);
  }

  return {
    id: subjectId, chapters, chapterList, questionPool, DIFFICULTIES,
    papers, paperList, paperLabelFor, pypPool,
    filterPool, pickQuestions, pypGradablePool, filterPypPool, pickPypQuestions, paperGradableQids
  };
}

const SUBJECT_DATA = {};
SUBJECT_IDS.forEach(id => { SUBJECT_DATA[id] = loadSubject(id); });

// A question, wherever it lives (any subject's chapter pool or PYP pool), found by its global qid.
// qid namespaces never collide: "<subject>:<chapter>-<id>" or "<subject>:pyp-<paperId>-<id>".
// This is what lets /api/quiz/check, gang war submit, and mixed-subject wars all work off one qid list.
function findQuestionByQid(qid) {
  const subjectId = String(qid).split(':')[0];
  const subj = SUBJECT_DATA[subjectId];
  if (!subj) return null;
  return subj.questionPool.find(x => x.qid === qid) || subj.pypPool.find(x => x.qid === qid);
}
function questionsPublic(qids) {
  return qids.map(qid => {
    const q = findQuestionByQid(qid);
    if (!q) return null;
    const subjInfo = SUBJECTS.find(s => s.id === q.subject);
    return {
      qid: q.qid, subject: q.subject, subjectName: subjInfo ? subjInfo.name : q.subject,
      chapterTitle: q.chapterTitle, topic: q.topic, difficulty: q.difficulty,
      question: q.question, source: q.source || null,
      paperId: q.paperId || null, paperLabel: q.paperLabel || null, marks: q.marks || null
    };
  }).filter(Boolean);
}

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

// ---------- API ----------
app.get('/api/subjects', (req, res) => {
  res.json(SUBJECTS.map(s => ({ ...s, chapterCount: SUBJECT_DATA[s.id].chapterList.length })));
});

// ---------- Mix Subjects Gang War ----------
// Registered BEFORE the generic /api/:subject/... routes below — otherwise Express would treat
// the literal path segment "mix" as a subject id and 404 it via the app.param('subject', ...) guard.
// parts: [{ subject, chapterIds, count, difficulty }, ...] — one or more subjects, each with its
// own chapter selection and question count. All qids are globally namespaced, so the resulting
// test reuses the exact same /api/test/:code, /submit, /leaderboard routes as a single-subject war.
app.post('/api/mix/test/create', (req, res) => {
  const { parts, creatorName, timeLimitSeconds, readingTimeSeconds } = req.body;
  if (!Array.isArray(parts) || !parts.length) return res.status(400).json({ error: 'Add chapters from at least one subject' });
  let qids = [];
  const chaptersLabel = [];
  const subjectsUsed = [];
  for (const part of parts) {
    const subj = SUBJECT_DATA[part.subject];
    if (!subj) return res.status(400).json({ error: 'Unknown subject: ' + part.subject });
    if (!Array.isArray(part.chapterIds) || !part.chapterIds.length) return res.status(400).json({ error: 'Pick chapters for every subject in the mix' });
    const partQids = subj.pickQuestions(part.chapterIds, part.count || 5, part.difficulty);
    if (!partQids.length) return res.status(400).json({ error: `No gradable questions available for ${part.subject}` });
    qids = qids.concat(partQids);
    subjectsUsed.push(part.subject);
    const subjInfo = SUBJECTS.find(s => s.id === part.subject);
    const chLabels = part.chapterIds.map(id => subj.chapters[id]?.title).filter(Boolean);
    chaptersLabel.push(`${subjInfo ? subjInfo.name : part.subject}: ${chLabels.join(', ')}`);
  }
  qids = qids.sort(() => Math.random() - 0.5); // shuffle across subjects so it's a true mix, not blocks
  const code = genCode();
  db.tests[code] = {
    code, mode: 'mix', subjects: subjectsUsed, qids, creatorName: creatorName || 'Anonymous',
    createdAt: Date.now(), chaptersLabel,
    timeLimitSeconds: (typeof timeLimitSeconds === 'number' && timeLimitSeconds > 0) ? timeLimitSeconds : null,
    readingTimeSeconds: (typeof readingTimeSeconds === 'number' && readingTimeSeconds > 0) ? readingTimeSeconds : null
  };
  db.attempts[code] = [];
  saveDB(db);
  res.json({
    code, questions: questionsPublic(qids), chapters: chaptersLabel,
    timeLimitSeconds: db.tests[code].timeLimitSeconds,
    readingTimeSeconds: db.tests[code].readingTimeSeconds
  });
});

// Every subject-scoped route below hangs off /api/:subject/... — this middleware validates the
// subject once and hands every route handler the loaded data via req.subj.
app.param('subject', (req, res, next, id) => {
  const subj = SUBJECT_DATA[id];
  if (!subj) return res.status(404).json({ error: 'Unknown subject: ' + id });
  req.subj = subj;
  req.subjectId = id;
  next();
});

app.get('/api/:subject/chapters', (req, res) => {
  const { chapterList, questionPool } = req.subj;
  res.json(chapterList.map(c => ({
    id: c.id,
    chapterNum: c.chapter,
    branch: c.branch || null,
    branchName: c.branch ? branchName(req.subjectId, c.branch) : null,
    title: c.title,
    noteCount: (c.notes || []).length,
    formulaCount: (c.formulas || []).length,
    exampleCount: (c.examples || []).length,
    exerciseCount: (c.exercises || []).length,
    gradableCount: questionPool.filter(q => q.chapterId === c.id).length
  })));
});

app.get('/api/:subject/chapter/:id', (req, res) => {
  const ch = req.subj.chapters[req.params.id];
  if (!ch) return res.status(404).json({ error: 'Chapter not found' });
  res.json(ch);
});

// Sub-subject / book registry for this subject (empty array for subjects with none, e.g. Maths, English)
app.get('/api/:subject/branches', (req, res) => {
  const list = branchesFor(req.subjectId);
  res.json(list.map(b => ({
    ...b,
    chapterCount: req.subj.chapterList.filter(c => c.branch === b.id).length
  })));
});

// Metadata for setup pages (difficulty options, etc.)
app.get('/api/:subject/meta', (req, res) => {
  res.json({ difficulties: req.subj.DIFFICULTIES });
});

// Live count of how many gradable questions match a chapter+difficulty selection,
// so setup pages can clamp the "number of questions" input.
app.post('/api/:subject/pool-count', (req, res) => {
  const { chapterIds, difficulty } = req.body;
  if (!Array.isArray(chapterIds) || !chapterIds.length) return res.json({ count: 0 });
  res.json({ count: req.subj.filterPool(chapterIds, difficulty).length });
});

// Quick Heist (practice quiz) - instant feedback, not saved to leaderboard
app.post('/api/:subject/quiz/generate', (req, res) => {
  const { chapterIds, count, difficulty } = req.body;
  if (!Array.isArray(chapterIds) || !chapterIds.length) return res.status(400).json({ error: 'Pick at least one chapter' });
  const qids = req.subj.pickQuestions(chapterIds, count || 10, difficulty);
  res.json({ questions: questionsPublic(qids) });
});

// Global (subject-agnostic): a qid always self-describes which subject it belongs to.
app.post('/api/quiz/check', (req, res) => {
  const { qid, answer } = req.body;
  const q = findQuestionByQid(qid);
  if (!q) return res.status(404).json({ error: 'Question not found' });
  const correct = checkAnswer(answer || '', q.answer);
  res.json({ correct, correctAnswer: q.answer });
});

// Solo Job / Big Heist (timed test, not shared) & Gang War (shared via code), single subject
app.post('/api/:subject/test/create', (req, res) => {
  const { chapterIds, count, creatorName, mode, difficulty, timeLimitSeconds, readingTimeSeconds } = req.body;
  if (!Array.isArray(chapterIds) || !chapterIds.length) return res.status(400).json({ error: 'Pick at least one chapter' });
  const qids = req.subj.pickQuestions(chapterIds, count || 10, difficulty);
  if (!qids.length) return res.status(400).json({ error: 'No gradable questions available for that selection' });
  const code = genCode();
  const chaptersLabel = chapterIds.map(id => req.subj.chapters[id]?.title).filter(Boolean);
  db.tests[code] = {
    code, subjects: [req.subjectId], chapterIds, qids, creatorName: creatorName || 'Anonymous',
    mode: mode || 'squad', createdAt: Date.now(),
    difficulty: difficulty || 'all', chaptersLabel,
    timeLimitSeconds: (typeof timeLimitSeconds === 'number' && timeLimitSeconds > 0) ? timeLimitSeconds : null,
    readingTimeSeconds: (typeof readingTimeSeconds === 'number' && readingTimeSeconds > 0) ? readingTimeSeconds : null
  };
  db.attempts[code] = [];
  saveDB(db);
  res.json({
    code, questions: questionsPublic(qids), chapters: chaptersLabel,
    timeLimitSeconds: db.tests[code].timeLimitSeconds,
    readingTimeSeconds: db.tests[code].readingTimeSeconds
  });
});

// ---------- Global test/gang-war routes (subject-agnostic — qids self-describe their subject) ----------
app.get('/api/test/:code', (req, res) => {
  const test = db.tests[req.params.code.toUpperCase()];
  if (!test) return res.status(404).json({ error: 'No gang war found with that code' });
  const subj = (test.subjects && test.subjects.length === 1) ? SUBJECT_DATA[test.subjects[0]] : null;
  const paper = (test.paperId && subj) ? subj.papers[test.paperId] : null;
  res.json({
    code: test.code,
    creatorName: test.creatorName,
    chapters: test.chaptersLabel || (test.chapterIds || []).map(id => subj?.chapters[id]?.title).filter(Boolean),
    questions: questionsPublic(test.qids),
    difficulty: test.difficulty || 'all',
    timeLimitSeconds: test.timeLimitSeconds || null,
    readingTimeSeconds: test.readingTimeSeconds || null,
    paperTotalMarks: (paper && paper.totalMarks) || test.paperTotalMarks || null
  });
});

app.post('/api/test/:code/submit', (req, res) => {
  const code = req.params.code.toUpperCase();
  const test = db.tests[code];
  if (!test) return res.status(404).json({ error: 'No gang war found with that code' });
  const { name, answers, timeTakenSeconds, perQuestionSeconds } = req.body;
  if (!name) return res.status(400).json({ error: 'Alias required' });

  // Full PYP papers are marked out of the paper's official total (e.g. 80), on top of the
  // plain correct/total count — only the auto-gradable subset of the paper counts toward it.
  const subj = (test.subjects && test.subjects.length === 1) ? SUBJECT_DATA[test.subjects[0]] : null;
  const paper = (test.paperId && subj) ? subj.papers[test.paperId] : null;
  const marksMode = !!paper;

  let score = 0, marksScored = 0, marksTotal = 0;
  const breakdown = test.qids.map(qid => {
    const q = findQuestionByQid(qid);
    const userAns = (answers && answers[qid]) || '';
    const correct = q ? checkAnswer(userAns, q.answer) : false;
    const marks = (q && typeof q.marks === 'number') ? q.marks : 0;
    if (correct) score++;
    if (marksMode) { marksTotal += marks; if (correct) marksScored += marks; }
    return {
      qid, correct, yourAnswer: userAns, correctAnswer: q ? q.answer : '', marks: marksMode ? marks : null,
      timeSec: (perQuestionSeconds && typeof perQuestionSeconds[qid] === 'number') ? perQuestionSeconds[qid] : null
    };
  });

  const attempt = {
    name, score, total: test.qids.length,
    timeTakenSeconds: timeTakenSeconds || 0,
    submittedAt: Date.now(),
    marksScored: marksMode ? marksScored : null,
    marksTotal: marksMode ? marksTotal : null,
    paperTotalMarks: (paper && paper.totalMarks) || null
  };
  db.attempts[code] = db.attempts[code] || [];
  db.attempts[code].push(attempt);
  saveDB(db);

  res.json({ score, total: test.qids.length, breakdown, marksScored: attempt.marksScored, marksTotal: attempt.marksTotal, paperTotalMarks: attempt.paperTotalMarks });
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

// ---------- Previous Year Papers API (per subject) ----------
app.get('/api/:subject/pyp/papers', (req, res) => {
  const { paperList, pypPool } = req.subj;
  res.json(paperList.map(p => {
    const qs = pypPool.filter(q => q.paperId === p.id);
    return {
      id: p.id, year: p.year, set: p.set || 1, board: p.board || null, totalMarks: p.totalMarks || null,
      questionCount: qs.length,
      gradableCount: qs.filter(q => q.gradable).length,
      chapters: [...new Set(qs.map(q => q.chapterId))].sort()
    };
  }));
});

// Distinct chapters that have PYP coverage, for the chapterwise picker
app.get('/api/:subject/pyp/chapters', (req, res) => {
  const counts = {};
  req.subj.pypGradablePool().forEach(q => {
    if (!counts[q.chapterId]) counts[q.chapterId] = { id: q.chapterId, chapterNum: q.chapter, title: q.chapterTitle, branch: q.branch || null, branchName: q.branch ? branchName(req.subjectId, q.branch) : null, gradableCount: 0 };
    counts[q.chapterId].gradableCount++;
  });
  res.json(Object.values(counts).sort((a, b) => (a.branch || '').localeCompare(b.branch || '') || a.id.localeCompare(b.id)));
});

// Chapter Weightage — how often each chapter actually shows up across every unique (deduplicated)
// PYP question on file. Lets a student see, at a glance, which chapters the board leans on most.
app.get('/api/:subject/pyp/weightage', (req, res) => {
  const { pypPool, paperList } = req.subj;
  const unique = pypPool.filter(q => !q.isDuplicate);
  const totalUnique = unique.length;
  const byChapter = {};
  unique.forEach(q => {
    if (!byChapter[q.chapterId]) {
      byChapter[q.chapterId] = { id: q.chapterId, chapterNum: q.chapter, title: q.chapterTitle, branch: q.branch || null, questionCount: 0, marks: 0, papers: new Set() };
    }
    const c = byChapter[q.chapterId];
    c.questionCount++;
    c.marks += (typeof q.marks === 'number' ? q.marks : 0);
    c.papers.add(q.paperId);
  });
  const rows = Object.values(byChapter).map(c => ({
    id: c.id, chapterNum: c.chapterNum, title: c.title, branch: c.branch, branchName: c.branch ? branchName(req.subjectId, c.branch) : null,
    questionCount: c.questionCount, marks: c.marks,
    paperCount: c.papers.size,
    percent: totalUnique ? Math.round((c.questionCount / totalUnique) * 1000) / 10 : 0
  })).sort((a, b) => b.questionCount - a.questionCount);
  res.json({
    totalUniqueQuestions: totalUnique,
    totalRawQuestions: pypPool.length,
    duplicatesFound: pypPool.length - totalUnique,
    paperCount: paperList.length,
    chapters: rows
  });
});

app.get('/api/:subject/pyp/paper/:id', (req, res) => {
  const p = req.subj.papers[req.params.id];
  if (!p) return res.status(404).json({ error: 'Paper not found' });
  const qs = req.subj.pypPool.filter(q => q.paperId === p.id).sort((a, b) => a.order - b.order);
  res.json({
    id: p.id, year: p.year, set: p.set || 1, board: p.board || null, totalMarks: p.totalMarks || null,
    questions: qs.map(q => ({ qid: q.qid, chapterId: q.chapterId, chapter: q.chapter, branch: q.branch || null, chapterTitle: q.chapterTitle, topic: q.topic, difficulty: q.difficulty, marks: q.marks, question: q.question, gradable: q.gradable }))
  });
});

app.post('/api/:subject/pyp/pool-count', (req, res) => {
  const { chapterIds, difficulty } = req.body;
  res.json({ count: req.subj.filterPypPool(chapterIds || [], difficulty).length });
});

// Practice / Quick-Heist-style generation. Pass { paperId } for one full paper (original order),
// or { chapterIds, count, difficulty } for a chapterwise mix pulled across every paper.
app.post('/api/:subject/pyp/quiz/generate', (req, res) => {
  const { paperId, chapterIds, count, difficulty } = req.body;
  let qids;
  if (paperId) {
    if (!req.subj.papers[paperId]) return res.status(400).json({ error: 'Paper not found' });
    qids = req.subj.paperGradableQids(paperId);
  } else {
    if (!Array.isArray(chapterIds) || !chapterIds.length) return res.status(400).json({ error: 'Pick at least one chapter' });
    qids = req.subj.pickPypQuestions(chapterIds, count || 10, difficulty);
  }
  if (!qids.length) return res.status(400).json({ error: 'No gradable PYP questions available for that selection' });
  res.json({ questions: questionsPublic(qids) });
});

// Solo Job / Gang War creation for PYP: { paperId } = full paper, or { chapterIds, count, difficulty } = chapterwise mix.
app.post('/api/:subject/pyp/test/create', (req, res) => {
  const { paperId, chapterIds, count, creatorName, difficulty, timeLimitSeconds, readingTimeSeconds } = req.body;
  let qids, label;
  if (paperId) {
    const p = req.subj.papers[paperId];
    if (!p) return res.status(400).json({ error: 'Paper not found' });
    qids = req.subj.paperGradableQids(paperId);
    label = [req.subj.paperLabelFor(p)];
  } else {
    if (!Array.isArray(chapterIds) || !chapterIds.length) return res.status(400).json({ error: 'Pick at least one chapter' });
    qids = req.subj.pickPypQuestions(chapterIds, count || 12, difficulty);
    label = chapterIds.map(id => req.subj.chapters[id]?.title).filter(Boolean);
  }
  if (!qids.length) return res.status(400).json({ error: 'No gradable PYP questions available for that selection' });
  const code = genCode();
  const paperObj = paperId ? req.subj.papers[paperId] : null;
  db.tests[code] = {
    code, subjects: [req.subjectId], source: 'pyp', paperId: paperId || null, chapterIds: chapterIds || null, qids,
    chaptersLabel: label, creatorName: creatorName || 'Anonymous',
    mode: 'squad', createdAt: Date.now(), difficulty: difficulty || 'all',
    timeLimitSeconds: (typeof timeLimitSeconds === 'number' && timeLimitSeconds > 0) ? timeLimitSeconds : null,
    readingTimeSeconds: (typeof readingTimeSeconds === 'number' && readingTimeSeconds > 0) ? readingTimeSeconds : null
  };
  db.attempts[code] = [];
  saveDB(db);
  res.json({
    code, questions: questionsPublic(qids), chapters: label,
    timeLimitSeconds: db.tests[code].timeLimitSeconds,
    readingTimeSeconds: db.tests[code].readingTimeSeconds,
    paperTotalMarks: (paperObj && paperObj.totalMarks) || null
  });
});

// ---------- Frontend ----------
// Catch-all for any non-API GET path: the frontend does real client-side routing
// (each subject, chapter, setup screen, war code, etc. has its own URL), so a direct visit
// or refresh on e.g. /s/science/chapter/3 or /war/ABC123 must still get the app shell.
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.set('Content-Type', 'text/html');
  res.send(FRONTEND_HTML);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Study Mafia running on port ${PORT}`));

// ================================================================
// FRONTEND (single-file embedded, per house style)
// ================================================================
const FRONTEND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Study Mafia — Class 10 (Maths · Science · SST · English)</title>
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
.subject-tabs{
  display:flex; gap:6px; padding:10px 28px; border-bottom:1px solid var(--card-border);
  background:rgba(212,175,55,0.02); overflow-x:auto; -webkit-overflow-scrolling:touch;
  position:sticky; top:57px; z-index:49;
}
.subj-tab{
  background:var(--card); border:1px solid var(--card-border); color:var(--muted);
  padding:8px 16px; border-radius:20px; font-size:13px; font-family:'Oswald'; letter-spacing:0.03em;
  white-space:nowrap; flex-shrink:0; transition:border-color 0.15s, color 0.15s;
}
.subj-tab:hover{ border-color:var(--gold-soft); color:var(--cream); }
.subj-tab.active{ border-color:var(--gold); color:var(--gold); background:rgba(212,175,55,0.08); }
.branch-tabs{
  top:98px; padding:8px 28px; background:rgba(0,0,0,0.15); border-bottom:1px solid var(--card-border);
}
.branch-tabs .subj-tab{ padding:6px 14px; font-size:12px; }
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
.note-item.img-note{ padding:0; overflow:hidden; }
.note-item.img-note .q-diagram{ margin:0; border:0; border-radius:0; }
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
.q-diagram{ display:block; max-width:100%; height:auto; margin:12px auto; border-radius:8px; border:1px solid var(--card-border); background:#fff; }
.ex-item .q-diagram{ max-width:320px; }
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
  .subject-tabs{ padding:8px 12px; top:auto; position:static; }
  .branch-tabs{ top:auto; position:static; }
  .subj-tab{ padding:7px 12px; font-size:12px; }
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
  <div class="badge-seal">SM</div>
  <h1>Study <span>Mafia</span></h1>
  <p class="tagline-main">Welcome to the gang, buddy.</p>
  <p class="tagline-script">It's time for a voyage.</p>
  <form class="name-form" id="gateForm">
    <label for="nameInput">Your Alias</label>
    <input id="nameInput" type="text" placeholder="e.g. harshit chaubey" autocomplete="off" autofocus>
    <div class="err" id="nameErr"></div>
    <button type="submit" class="btn">BOOYAH!!!! →</button>
  </form>
</div>

<div id="quoteOverlay">
  <div class="quote-box">
    <div class="badge-seal-sm">SM</div>
    <div class="quote-mark">"</div>
    <p class="quote-text" id="quoteText"></p>
    <p class="quote-sub" id="quoteSub">— Study Mafia</p>
    <button type="button" class="btn quote-enter-btn" id="quoteEnterBtn">Enter →</button>
    <p class="quote-hint">or press Enter to continue</p>
  </div>
  <p class="quote-credit">Designed by: Harshit Chaubey</p>
</div>

<div id="app">
  <div class="topbar">
    <div class="brand"><span class="brand-badge">SM</span> STUDY MAFIA</div>
    <div class="ticker" id="topTicker"><span class="ticker-text" id="tickerText"></span></div>
    <div class="who">Playing as <b id="whoName"></b> <button class="btn-ghost" id="switchBtn">switch</button>
      <span class="rec-clock"><span class="rec-dot"></span>REC <span id="dashClock"></span></span>
    </div>
  </div>
  <div class="subject-tabs" id="subjectTabs"></div>
  <main id="main"></main>
</div>

<script>
const SUBJECT_IDS = ['maths','science','sst','english'];
const state = { name: '', subject: localStorage.getItem('sm_subject') || 'maths', branch: 'all', subjects: [], chaptersCache: {}, metaCache: {}, branchesCache: {}, view: 'dashboard', selectedChapters: [], chapters: [], meta: null, currentChapter: null, quiz: null, quizIdx: 0, quizScore: 0, testCode: null, testTimer: null, testStart: null, timeLimitSeconds: null, readingTimeSeconds: null, paperTotalMarks: null, runnerMode: null, warMeta: null, pypPapers: null, pypChapters: null, mixParts: [] };

// Builds a URL under the CURRENT subject, e.g. sp('/chapter/3') -> '/s/maths/chapter/3'
function sp(path){ return '/s/' + state.subject + (path || ''); }

// Looks up a branch's display name (Physics, History, ...) for the given subject
function branchName(subjectId, branchId){
  const list = state.branchesCache[subjectId] || [];
  const b = list.find(x=>x.id===branchId);
  return b ? b.name : branchId;
}

// ---------- Router (every screen is a real, dedicated, back-button-friendly page) ----------
function navigate(path){
  if(location.pathname + location.search !== path){ history.pushState(null, '', path); }
  route();
}
function replaceUrl(path){
  if(location.pathname + location.search !== path){ history.replaceState(null, '', path); }
}
window.addEventListener('popstate', route);

// Loads (and caches) chapters + meta + branches for a subject, switching state.subject if needed.
async function ensureSubject(subj){
  if(state.subject !== subj){
    state.subject = subj;
    state.branch = 'all'; // reset the branch filter whenever the subject itself changes
    localStorage.setItem('sm_subject', subj);
  }
  renderSubjectTabs();
  if(!state.chaptersCache[subj]){
    const [chRes, metaRes, branchRes] = await Promise.all([ fetch('/api/'+subj+'/chapters'), fetch('/api/'+subj+'/meta'), fetch('/api/'+subj+'/branches') ]);
    state.chaptersCache[subj] = await chRes.json();
    try{ state.metaCache[subj] = await metaRes.json(); }catch(e){ state.metaCache[subj] = { difficulties: [] }; }
    try{ state.branchesCache[subj] = await branchRes.json(); }catch(e){ state.branchesCache[subj] = []; }
  }
  state.chapters = state.chaptersCache[subj];
  state.meta = state.metaCache[subj];
  renderBranchTabs();
  initTicker();
}

// Chapters visible right now, honoring the active branch filter (if this subject has branches)
function visibleChapters(){
  if(state.branch==='all' || !state.branch) return state.chapters;
  return state.chapters.filter(c=>c.branch===state.branch);
}

// ---------- Sub-subject / branch tab bar (Science: Physics/Chem/Bio, SST: History/Geo/Eco/Civics) ----------
function renderBranchTabs(){
  let bar = document.getElementById('branchTabs');
  const branches = state.branchesCache[state.subject] || [];
  if(!branches.length){
    if(bar) bar.innerHTML = '';
    return;
  }
  if(!bar){
    bar = document.createElement('div');
    bar.id = 'branchTabs';
    bar.className = 'subject-tabs branch-tabs';
    document.getElementById('subjectTabs').insertAdjacentElement('afterend', bar);
  }
  const tabs = [{id:'all', name:'All'}, ...branches];
  bar.innerHTML = tabs.map(b => \`<button class="subj-tab${'$'}{b.id===state.branch?' active':''}" onclick="switchBranch('${'$'}{b.id}')">${'$'}{esc(b.name)}${'$'}{b.chapterCount!=null && b.id!=='all' ? ' ('+b.chapterCount+')' : ''}</button>\`).join('');
}
function switchBranch(id){
  state.branch = id;
  renderBranchTabs();
  route(); // re-render whatever screen we're on, filtered to the new branch
}

function route(){
  const path = location.pathname;
  const qs = new URLSearchParams(location.search);
  const seg = path.split('/').filter(Boolean);

  // ---- Global, subject-agnostic routes (a war code or run-in-progress isn't tied to one subject URL) ----
  if(seg[0]==='war' && seg[1]) return joinGangWar(seg[1].toUpperCase());
  if(seg[0]==='leaderboard' && seg[1]) return viewLeaderboard(seg[1].toUpperCase());
  if(seg[0]==='pick' && seg[1]==='join') return renderJoinWar();
  if(seg[0]==='mix' && seg[1]==='pick') return renderMixPicker();
  if(seg[0]==='mix' && seg[1]==='setup') return renderMixWarSetup();
  if(seg[0]==='run' && seg[1]==='quiz' && state.quiz) return renderQuizQuestion();
  if(seg[0]==='run' && seg[1]==='solo' && state.quiz) return renderTimedRunner();
  if(seg[0]==='run' && seg[1]==='war' && state.quiz) return renderTimedRunner();

  // ---- Subject-scoped routes: /s/<subject>/... ----
  if(seg[0]==='s' && seg[1]){
    if(!SUBJECT_IDS.includes(seg[1])) return navigate('/s/maths');
    return ensureSubject(seg[1]).then(()=>{
      const sub = seg.slice(2);
      if(sub[0]==='chapter' && sub[1]) return openChapterPage(sub[1], qs.get('tab')||'notes');
      if(sub[0]==='pick' && sub[1]==='notes') return renderPicker('notesPicker','The Intel','Pick a chapter to read its notes.',false,(ids)=>navigate(sp('/chapter/'+ids[0]+'?tab=notes')));
      if(sub[0]==='pick' && sub[1]==='formulas') return renderPicker('formulaPicker','Cheat Sheet','Pick a chapter for its formula sheet.',false,(ids)=>navigate(sp('/chapter/'+ids[0]+'?tab=formulas')));
      if(sub[0]==='pick' && sub[1]==='quiz') return renderPicker('quizPicker','Quick Heist','Pick one or more chapters to mix questions from.',true,(ids)=>navigate(sp('/setup/quiz?ch='+ids.join(','))));
      if(sub[0]==='pick' && sub[1]==='solo') return renderPicker('soloPicker','Solo Job','Pick chapters for your timed test.',true,(ids)=>navigate(sp('/setup/solo?ch='+ids.join(','))));
      if(sub[0]==='pick' && sub[1]==='war') return renderPicker('createWar','Start a Gang War','Pick chapters — your crew will get the exact same questions.',true,(ids)=>navigate(sp('/setup/war?ch='+ids.join(','))));
      if(sub[0]==='vault') return renderVault();
      if(sub[0]==='setup' && sub[1]) return renderTestSetup(sub[1], (qs.get('ch')||'').split(',').filter(Boolean));
      if(sub[0]==='pyp' && sub[1]==='paper' && sub[2] && sub[3]==='setup' && sub[4]) return renderPypPaperSetup(sub[2], sub[4]);
      if(sub[0]==='pyp' && sub[1]==='paper' && sub[2]) return renderPypPaperDetail(sub[2]);
      if(sub[0]==='pyp' && sub[1]==='pick' && sub[2]) return renderPypPicker(sub[2]);
      if(sub[0]==='pyp' && sub[1]==='setup' && sub[2]) return renderPypTestSetup(sub[2], (qs.get('ch')||'').split(',').filter(Boolean));
      if(sub[0]==='pyp' && sub[1]==='weightage') return renderPypWeightage();
      if(sub[0]==='pyp') return renderPypHome();
      return renderDashboard();
    });
  }

  // No subject in the URL (e.g. bare "/") — redirect into the last-used (or default) subject
  return navigate('/s/' + (state.subject || 'maths'));
}

// Maps the old view-name calls (mode-grid buttons) onto real routes
function goto(view){
  if(view==='joinWar') return navigate('/pick/join');
  const map = { notesPicker:'/pick/notes', formulaPicker:'/pick/formulas', quizPicker:'/pick/quiz', soloPicker:'/pick/solo', createWar:'/pick/war', vault:'/vault' };
  navigate(sp(map[view] || ''));
}

// ---------- Subject tab bar (always visible once inside the app) ----------
function renderSubjectTabs(){
  const bar = document.getElementById('subjectTabs');
  if(!bar) return;
  const list = state.subjects.length ? state.subjects : SUBJECT_IDS.map(id=>({id, name: id[0].toUpperCase()+id.slice(1)}));
  bar.innerHTML = list.map(s => \`<button class="subj-tab${'$'}{s.id===state.subject?' active':''}" onclick="switchSubject('${'$'}{s.id}')">${'$'}{s.icon?s.icon+' ':''}${'$'}{esc(s.name)}</button>\`).join('');
}
function switchSubject(id){
  if(id===state.subject){ navigate('/s/'+id); return; }
  navigate('/s/'+id);
}
async function loadSubjects(){
  try{ const res = await fetch('/api/subjects'); state.subjects = await res.json(); }
  catch(e){ /* falls back to the hardcoded SUBJECT_IDS list */ }
  renderSubjectTabs();
}

// ---------- Gate ----------
const gate = document.getElementById('gate');
const appEl = document.getElementById('app');
const nameInput = document.getElementById('nameInput');

function boot(){
  const saved = localStorage.getItem('sm_name');
  if(saved){ showQuoteThenEnter(saved); }
}
document.getElementById('gateForm').addEventListener('submit', e=>{
  e.preventDefault();
  const val = nameInput.value.trim();
  if(!val){ document.getElementById('nameErr').textContent = 'Every family member needs a name.'; return; }
  localStorage.setItem('sm_name', val);
  showQuoteThenEnter(val);
});
document.getElementById('switchBtn').addEventListener('click', ()=>{
  localStorage.removeItem('sm_name');
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
  return { text: o + ', ' + c + '.', author: 'Study Mafia' };
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
  loadSubjects().then(()=>{ route(); });
}

// ---------- Topbar question ticker ----------
let tickerPool = [];
let tickerIdx = 0;
let tickerTimer = null;
let tickerLoadedFor = null;
async function initTicker(){
  if(tickerLoadedFor === state.subject) return; // already have this subject's pool loaded
  tickerLoadedFor = state.subject;
  tickerPool = []; tickerIdx = 0;
  try{
    const chData = await Promise.all(state.chapters.map(c => fetch('/api/'+state.subject+'/chapter/'+c.id).then(r=>r.json())));
    chData.forEach(ch=>{
      (ch.exercises||[]).forEach(e=>{ if(e.question) tickerPool.push({tag:ch.title, q:e.question}); });
      (ch.examples||[]).forEach(e=>{ if(e.question) tickerPool.push({tag:ch.title, q:e.question}); });
    });
    if(!tickerPool.length) return;
    tickerPool.sort(()=>Math.random()-0.5);
    rollTicker();
    if(!tickerTimer) tickerTimer = setInterval(rollTicker, 10000);
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

// Renders question/answer text that may contain diagram images:
//  - inline markers like "...text... [DIAGRAM: assets/questions/2026-set1/q4.png] ...text..."
//  - or a bare answer field that is JUST an image path, e.g. "assets/answers/2026-set1/q26.png"
// Everything else is escaped as plain text, same as esc() always did.
function renderMedia(raw){
  if(!raw) return '';
  const s = String(raw).trim();
  const bareImg = /^assets\\/[\\w\\-\\/]+\\.(png|jpe?g|gif|webp)$/i;
  if(bareImg.test(s)){
    return \`<img class="q-diagram" src="/${'$'}{esc(s)}" alt="Solution diagram" loading="lazy">\`;
  }
  return esc(String(raw)).replace(/\\[DIAGRAM:\\s*([\\w\\-\\/]+\\.(?:png|jpe?g|gif|webp))\\s*\\]/gi, (m, p1) => {
    return \`<br><img class="q-diagram" src="/${'$'}{esc(p1)}" alt="Question diagram" loading="lazy"><br>\`;
  });
}

// ---------- Dashboard ----------
function renderDashboard(){
  state.view='dashboard'; state.selectedChapters=[];
  replaceUrl(sp(''));
  renderSubjectTabs();
  const main = document.getElementById('main');
  const overall = getOverallProgress();
  const vaultCount = Object.keys(getBookmarks()).length;
  const subjInfo = (state.subjects||[]).find(s=>s.id===state.subject);
  main.innerHTML = \`
    <div class="summary-card">
      <div class="summary-left">
        <div class="summary-rank">${'$'}{rankTitle(overall.pct)}</div>
        <div class="summary-sub">${'$'}{overall.viewed} of ${'$'}{overall.total} questions cracked in ${'$'}{esc(subjInfo?subjInfo.name:state.subject)}</div>
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
      <button class="mode-card" onclick="navigate('/mix/pick')"><span class="icon">🌐</span><h3>Mix Subjects War</h3><p>Blend chapters from every subject into one Gang War.</p></button>
      <button class="mode-card" onclick="goto('joinWar')"><span class="icon">🔑</span><h3>Join a Gang War</h3><p>Got a code from a friend? Enter it and take them down.</p></button>
      <button class="mode-card" onclick="navigate(sp('/pyp'))"><span class="icon">📜</span><h3>Previous Papers</h3><p>Real board papers, year-wise and chapter-wise, with every test mode.</p></button>
      <button class="mode-card" onclick="goto('vault')"><span class="icon">⭐</span><h3>Revision Vault${'$'}{vaultCount ? \` <span class="vault-count">${'$'}{vaultCount}</span>\` : ''}</h3><p>Every question you've starred for a second look, all in one place.</p></button>
    </div>
    <div class="section-title">Contents</div>
    <div class="chapter-grid" id="chGrid"></div>
  \`;
  const grid = document.getElementById('chGrid');
  grid.innerHTML = visibleChapters().map(c => {
    const total = c.exampleCount + c.exerciseCount;
    const pct = progressPct(c.id, total);
    return \`
    <div class="ch-card clickable" data-id="${'$'}{c.id}" data-total="${'$'}{total}" onclick="navigate(sp('/chapter/${'$'}{c.id}'))">
      <div class="num">${'$'}{c.branchName ? esc(c.branchName)+' · ' : ''}CH ${'$'}{c.chapterNum}</div>
      <h3>${'$'}{esc(c.title)}</h3>
      <div class="progress-track"><div class="progress-fill" style="width:${'$'}{pct}%"></div></div>
      <div class="progress-label"><span class="pct">${'$'}{pct}%</span> complete</div>
    </div>
  \`;
  }).join('') || '<div class="empty">No chapters here yet.</div>';
}

function renderPicker(key,title,sub,multi,onGo){
  const main = document.getElementById('main');
  main.innerHTML = \`
    <div class="crumbs"><button onclick="navigate(sp(''))">← The Turf</button></div>
    <div class="section-title">${'$'}{esc(title)}</div>
    <p style="color:var(--muted); margin-bottom:20px; font-size:14px;">${'$'}{esc(sub)}</p>
    <div class="chapter-grid" id="pickGrid"></div>
    <div style="margin-top:24px; display:flex; justify-content:flex-end;">
      <button class="btn" id="pickGo">Let's Go →</button>
    </div>
  \`;
  const grid = document.getElementById('pickGrid');
  grid.innerHTML = visibleChapters().map(c => \`
    <div class="ch-card selectable" data-id="${'$'}{c.id}" onclick="toggleChapter(this,'${'$'}{c.id}',${'$'}{multi})">
      <div class="num">${'$'}{c.branchName ? esc(c.branchName)+' · ' : ''}CH ${'$'}{c.chapterNum}</div>
      <h3>${'$'}{esc(c.title)}</h3>
      <div class="stats"><span>${'$'}{c.gradableCount} gradable Qs</span><span>${'$'}{c.noteCount} notes</span></div>
    </div>
  \`).join('') || '<div class="empty">No chapters here yet.</div>';
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
function progressKey(){ return 'sm_progress_' + state.subject + '_' + (state.name || 'guest'); }
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

// ---------- PYP progress tracking (per paper, per-name, stored locally — same pattern as chapter progress) ----------
function pypProgressKey(){ return 'sm_pyp_progress_' + state.subject + '_' + (state.name || 'guest'); }
function getPypProgress(){ try{ return JSON.parse(localStorage.getItem(pypProgressKey()) || '{}'); }catch(e){ return {}; } }
function markPypQuestionAnswered(paperId, qid){
  const prog = getPypProgress();
  const arr = prog[paperId] || [];
  if(!arr.includes(qid)){ arr.push(qid); prog[paperId] = arr; localStorage.setItem(pypProgressKey(), JSON.stringify(prog)); }
}
function pypPaperStats(paperId, gradableCount){
  const answered = (getPypProgress()[paperId] || []).length;
  const pct = gradableCount ? Math.min(100, Math.round((answered/gradableCount)*100)) : 0;
  return { answered, pct, done: gradableCount > 0 && answered >= gradableCount };
}

// ---------- Revision Vault (starred/bookmarked questions) ----------
function bookmarkKey(){ return 'sm_bookmarks_' + state.subject + '_' + (state.name || 'guest'); }
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
    <div class="crumbs"><button onclick="navigate(sp(''))">← The Turf</button></div>
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
      <div class="q">${'$'}{renderMedia(item.question)}</div>
      <details><summary>Show ${'$'}{item.kind==='example' ? 'solution' : 'answer'}</summary><p>${'$'}{renderMedia(item.answer||'')}</p></details>
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
      <div class="q">${'$'}{renderMedia(item.question)}</div>
      <details data-pid="${'$'}{item.pid}"><summary>Show ${'$'}{item.kind==='example' ? 'solution' : 'answer'}</summary><p>${'$'}{renderMedia(item.answer||'')}</p></details>
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
  const res = await fetch('/api/'+state.subject+'/chapter/'+id);
  if(!res.ok){ main.innerHTML = '<div class="empty">Chapter not found.</div><div class="crumbs"><button onclick="navigate(sp(\\'\\'))">← The Turf</button></div>'; return; }
  const ch = await res.json();
  state.currentChapter = ch;
  renderChapterView(ch, tab || 'notes');
}

function renderChapterView(ch, tab){
  replaceUrl(sp('/chapter/'+ch.id+'?tab='+tab));
  const main = document.getElementById('main');
  const branchLabel = ch.branch ? branchName(state.subject, ch.branch) + ' · ' : '';
  main.innerHTML = \`
    <div class="crumbs"><button onclick="navigate(sp(''))">← The Turf</button></div>
    <div class="section-title">${'$'}{esc(branchLabel)}CH ${'$'}{ch.chapter} — ${'$'}{esc(ch.title)}</div>
    <div class="mode-grid" style="margin-bottom:28px;">
      <button class="mode-card" onclick="navigate(sp('/setup/quiz?ch=${'$'}{ch.id}'))"><span class="icon">⚡</span><h3>Quick Heist</h3><p>Practice this chapter only, instant feedback.</p></button>
      <button class="mode-card" onclick="navigate(sp('/setup/solo?ch=${'$'}{ch.id}'))"><span class="icon">🎯</span><h3>Solo Job</h3><p>Timed test on this chapter, just you and the clock.</p></button>
      <button class="mode-card" onclick="navigate(sp('/setup/war?ch=${'$'}{ch.id}'))"><span class="icon">🤝</span><h3>Start a Gang War</h3><p>Challenge your crew on this chapter, code + leaderboard.</p></button>
    </div>
    <div class="tabs">
      <button class="tab" data-t="notes">📒 Notes</button>
      <button class="tab" data-t="formulas">🧾 Formulas</button>
      <button class="tab" data-t="exercises">📚 Practice Bank</button>
      <button class="tab" data-t="imgnotes">🖼️ Image Notes</button>
    </div>
    <div id="chBody"></div>
  \`;
  document.querySelectorAll('.tab').forEach(t=>{
    t.addEventListener('click', ()=>{
      document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
      t.classList.add('active');
      replaceUrl(sp('/chapter/'+ch.chapter+'?tab='+t.dataset.t));
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
  } else if(tab==='imgnotes'){
    body.innerHTML = (ch.imageNotes||[]).map(p=>\`<div class="note-item img-note">${'$'}{renderMedia(p)}</div>\`).join('') || '<div class="empty">No image notes yet for this chapter.</div>';
  }
}

// ---------- Quick Heist (practice quiz, instant feedback) ----------
// ---------- Test setup page: difficulty, question count, timer (shared by Quiz / Solo / Gang War) ----------
async function renderTestSetup(mode, chapterIds){
  const main = document.getElementById('main');
  chapterIds = (chapterIds||[]).filter(id => state.chapters.some(c=>c.id===id));
  if(!chapterIds.length){
    main.innerHTML = \`<div class="empty">No chapters selected.</div><div class="crumbs" style="justify-content:center;margin-top:16px;"><button onclick="navigate(sp(''))">← The Turf</button></div>\`;
    return;
  }
  const titles = chapterIds.map(id => { const c = state.chapters.find(x=>x.id===id); if(!c) return ''; return (c.branchName?c.branchName+' · ':'')+'CH '+c.chapterNum+' — '+c.title; }).filter(Boolean);
  const modeInfo = {
    quiz: { title:'Quick Heist Setup', sub:'Instant feedback, no leaderboard.', defCount:10, defTimer:false, defMinutes:10, goBtn:'Start Heist →', pickPath:sp('/pick/quiz') },
    solo: { title:'Solo Job Setup', sub:'Timed test, just you and the clock.', defCount:15, defTimer:true, defMinutes:15, goBtn:'Start the Job →', pickPath:sp('/pick/solo') },
    war:  { title:'Gang War Setup', sub:'Everyone who joins with your code gets these exact settings.', defCount:12, defTimer:true, defMinutes:15, goBtn:'Create the War →', pickPath:sp('/pick/war') }
  }[mode] || { title:'Test Setup', sub:'', defCount:10, defTimer:false, defMinutes:10, goBtn:'Start →', pickPath:sp('') };

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
      <div class="count-row" id="minutesRow" style="${'$'}{modeInfo.defTimer?'':'display:none;'} gap:10px;">
        <input type="number" id="hoursInput" min="0" value="0" style="width:70px; background:var(--bg); border:1.5px solid var(--card-border); color:var(--cream); padding:10px; border-radius:6px; font-size:15px;">
        <span class="val" style="width:auto; font-family:'IBM Plex Sans'; font-size:12.5px; color:var(--muted);">hr</span>
        <input type="number" id="minutesInput" min="0" max="59" value="${'$'}{modeInfo.defMinutes}" style="width:70px; background:var(--bg); border:1.5px solid var(--card-border); color:var(--cream); padding:10px; border-radius:6px; font-size:15px;">
        <span class="val" style="width:auto; font-family:'IBM Plex Sans'; font-size:12.5px; color:var(--muted);">min — for the whole test</span>
      </div>

      <label class="radio-opt" style="margin-top:18px;"><input type="checkbox" id="readingOn"> Add reading time (typing disabled while reading)</label>
      <div class="count-row" id="readingRow" style="display:none;">
        <input type="number" id="readingMinutes" min="1" value="15" style="width:70px; background:var(--bg); border:1.5px solid var(--card-border); color:var(--cream); padding:10px; border-radius:6px; font-size:15px;">
        <span class="val" style="width:auto; font-family:'IBM Plex Sans'; font-size:12.5px; color:var(--muted);">min reading time, before the test clock starts</span>
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
      const res = await fetch('/api/'+state.subject+'/pool-count', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({chapterIds, difficulty: diffSel.value}) });
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
  document.getElementById('readingOn').addEventListener('change', (e)=>{ document.getElementById('readingRow').style.display = e.target.checked ? 'flex' : 'none'; });

  document.getElementById('setupGo').addEventListener('click', ()=>{
    const count = Math.max(1, parseInt(countInput.value,10) || modeInfo.defCount);
    const difficulty = diffSel.value;
    const noTimer = document.getElementById('timerNone').checked;
    const hours = Math.max(0, parseInt(document.getElementById('hoursInput').value,10) || 0);
    const minutes = Math.max(0, parseInt(document.getElementById('minutesInput').value,10) || 0);
    const totalSeconds = hours*3600 + minutes*60;
    const readingOn = document.getElementById('readingOn').checked;
    const readingMinutes = Math.max(1, parseInt(document.getElementById('readingMinutes').value,10) || 15);
    const opts = { difficulty, count, timeLimitSeconds: (noTimer || totalSeconds<=0) ? null : totalSeconds, readingTimeSeconds: readingOn ? readingMinutes*60 : null };
    if(mode==='quiz') startQuiz(chapterIds, opts);
    else if(mode==='solo') startSoloTest(chapterIds, opts);
    else if(mode==='war') createGangWar(chapterIds, opts);
  });
}

// ---------- Previous Year Papers (PYP) ----------
async function loadPypPapers(){
  if(!state.pypPapers){ const res = await fetch('/api/'+state.subject+'/pyp/papers'); state.pypPapers = await res.json(); }
  return state.pypPapers;
}
async function loadPypChapters(){
  if(!state.pypChapters){ const res = await fetch('/api/'+state.subject+'/pyp/chapters'); state.pypChapters = await res.json(); }
  return state.pypChapters;
}

function renderPypHome(){
  replaceUrl(sp('/pyp'));
  const main = document.getElementById('main');
  main.innerHTML = \`
    <div class="crumbs"><button onclick="navigate(sp(''))">← The Turf</button></div>
    <div class="section-title">Previous Year Papers</div>
    <p style="color:var(--muted); margin-bottom:20px; font-size:14px;">Real board papers. Take one whole, or mix questions by chapter across every year.</p>
    <div class="mode-grid" style="margin-bottom:32px;">
      <button class="mode-card" onclick="navigate(sp('/pyp/pick/quiz'))"><span class="icon">⚡</span><h3>Chapterwise Practice</h3><p>Pull PYP questions from any chapter, across every paper.</p></button>
      <button class="mode-card" onclick="navigate(sp('/pyp/pick/solo'))"><span class="icon">🎯</span><h3>Chapterwise Timed Test</h3><p>Same mix, but timed — one or many chapters.</p></button>
      <button class="mode-card" onclick="navigate(sp('/pyp/pick/war'))"><span class="icon">🤝</span><h3>Chapterwise Gang War</h3><p>Challenge your crew with a chapterwise PYP mix.</p></button>
      <button class="mode-card" onclick="navigate(sp('/pyp/weightage'))"><span class="icon">📊</span><h3>Chapter Weightage</h3><p>Which chapters the board actually leans on, based on every unique question on file.</p></button>
    </div>
    <div class="section-title">By Year</div>
    <div class="chapter-grid" id="pypGrid"><div class="empty">Loading papers…</div></div>
  \`;
  loadPypPapers().then(renderPypGrid);
}

function renderPypGrid(){
  const grid = document.getElementById('pypGrid');
  if(!grid) return;
  if(!state.pypPapers.length){ grid.innerHTML = '<div class="empty">No previous year papers uploaded yet. Check back soon.</div>'; return; }
  grid.innerHTML = state.pypPapers.map(p=>{
    const stats = pypPaperStats(p.id, p.gradableCount);
    return \`
    <div class="ch-card clickable" onclick="navigate(sp('/pyp/paper/${'$'}{p.id}'))">
      <div class="num">${'$'}{p.board?esc(p.board)+' · ':''}${'$'}{p.year}${'$'}{p.set?' Set '+p.set:''}${'$'}{stats.done?' · ✓':''}</div>
      <h3>${'$'}{p.questionCount} Questions${'$'}{p.totalMarks?' · '+p.totalMarks+' Marks':''}</h3>
      <div class="progress-track"><div class="progress-fill" style="width:${'$'}{stats.pct}%"></div></div>
      <div class="progress-label"><span class="pct">${'$'}{stats.pct}%</span> complete</div>
    </div>\`;
  }).join('');
}

async function renderPypWeightage(){
  replaceUrl(sp('/pyp/weightage'));
  const main = document.getElementById('main');
  main.innerHTML = '<div class="empty">Crunching the numbers…</div>';
  const res = await fetch('/api/'+state.subject+'/pyp/weightage');
  const data = await res.json();
  if(!data.chapters || !data.chapters.length){
    main.innerHTML = \`
    <div class="crumbs"><button onclick="navigate(sp('/pyp'))">← Previous Papers</button></div>
    <div class="section-title">Chapter Weightage</div>
    <div class="empty">No previous year papers uploaded yet. Check back soon.</div>\`;
    return;
  }
  const dupNote = data.duplicatesFound > 0
    ? \` (\${data.duplicatesFound} repeated question\${data.duplicatesFound===1?'':'s'} across papers auto-excluded, so this stays accurate)\`
    : '';
  main.innerHTML = \`
    <div class="crumbs"><button onclick="navigate(sp('/pyp'))">← Previous Papers</button></div>
    <div class="section-title">Chapter Weightage</div>
    <p style="color:var(--muted); margin-bottom:24px; font-size:14px;">
      Based on ${'$'}{data.totalUniqueQuestions} unique question${'$'}{data.totalUniqueQuestions===1?'':'s'} across ${'$'}{data.paperCount} paper${'$'}{data.paperCount===1?'':'s'}${'$'}{esc(dupNote)}.
    </p>
    <div id="weightageList">
      ${'$'}{data.chapters.map((c,i)=>\`
      <div class="ch-card" style="margin-bottom:12px; cursor:pointer;" onclick="navigate(sp('/chapter/${'$'}{c.id}'))">
        <div class="num">#${'$'}{i+1} · ${'$'}{c.branchName ? esc(c.branchName)+' · ' : ''}CH ${'$'}{c.chapterNum} — ${'$'}{esc(c.title)}</div>
        <h3>${'$'}{c.questionCount} question${'$'}{c.questionCount===1?'':'s'}${'$'}{c.marks?' · '+c.marks+' marks total':''} · in ${'$'}{c.paperCount} paper${'$'}{c.paperCount===1?'':'s'}</h3>
        <div class="progress-track"><div class="progress-fill" style="width:${'$'}{c.percent}%"></div></div>
        <div class="progress-label"><span class="pct">${'$'}{c.percent}%</span> of unique PYP questions</div>
      </div>\`).join('')}
    </div>
  \`;
}

async function renderPypPaperDetail(id){
  const main = document.getElementById('main');
  main.innerHTML = '<div class="empty">Loading paper…</div>';
  const res = await fetch('/api/'+state.subject+'/pyp/paper/'+id);
  const data = await res.json();
  if(data.error){ alert(data.error); navigate(sp('/pyp')); return; }
  const gradable = data.questions.filter(q=>q.gradable);
  const chapterCounts = {};
  data.questions.forEach(q=>{ chapterCounts[q.chapterTitle] = (chapterCounts[q.chapterTitle]||0)+1; });
  const stats = pypPaperStats(id, gradable.length);
  main.innerHTML = \`
    <div class="crumbs"><button onclick="navigate(sp('/pyp'))">← Previous Papers</button></div>
    <div class="section-title">${'$'}{data.board?esc(data.board)+' — ':''}${'$'}{data.year}${'$'}{data.set?' (Set '+data.set+')':''}${'$'}{stats.done?' ✓':''}</div>
    <p style="color:var(--muted); margin-bottom:12px; font-size:14px;">${'$'}{data.questions.length} questions${'$'}{data.totalMarks?' · '+data.totalMarks+' marks':''} · ${'$'}{gradable.length} auto-gradable</p>
    <div class="progress-track" style="margin-bottom:24px;"><div class="progress-fill" style="width:${'$'}{stats.pct}%"></div></div>
    <div class="mode-grid" style="margin-bottom:28px;">
      <button class="mode-card" id="pypPracticeBtn"><span class="icon">⚡</span><h3>Practice</h3><p>Instant feedback, no timer.</p></button>
      <button class="mode-card" id="pypSoloBtn"><span class="icon">🎯</span><h3>Full Test</h3><p>Timed, just you — the complete paper.</p></button>
      <button class="mode-card" id="pypWarBtn"><span class="icon">🤝</span><h3>Gang War</h3><p>Challenge your crew on this exact paper.</p></button>
    </div>
    <div class="section-title">Chapters Covered</div>
    <div class="chapter-grid">
      ${'$'}{Object.entries(chapterCounts).map(([t,c])=>\`<div class="ch-card"><h3>${'$'}{esc(t)}</h3><div class="stats"><span>${'$'}{c} question${'$'}{c===1?'':'s'}</span></div></div>\`).join('')}
    </div>
  \`;
  document.getElementById('pypPracticeBtn').addEventListener('click', ()=>startPypQuiz({paperId:id}));
  document.getElementById('pypSoloBtn').addEventListener('click', ()=>navigate(sp('/pyp/paper/'+id+'/setup/solo')));
  document.getElementById('pypWarBtn').addEventListener('click', ()=>navigate(sp('/pyp/paper/'+id+'/setup/war')));
}

// Full-paper time setup: hours+minutes and reading time for a whole PYP paper (marking is out of the
// paper's official totalMarks, shown here so the host knows what the "full test" is graded against).
async function renderPypPaperSetup(id, mode){
  const main = document.getElementById('main');
  main.innerHTML = '<div class="empty">Loading paper…</div>';
  const res = await fetch('/api/'+state.subject+'/pyp/paper/'+id);
  const data = await res.json();
  if(data.error){ alert(data.error); navigate(sp('/pyp')); return; }
  const gradable = data.questions.filter(q=>q.gradable);
  const defSeconds = gradable.length ? Math.max(600, gradable.length*90) : 900;
  const defHours = Math.floor(defSeconds/3600), defMinutes = Math.round((defSeconds%3600)/60);
  const modeInfo = { solo: { title:'Full Test Setup', goBtn:'Start the Job →' }, war: { title:'Gang War Setup', goBtn:'Create the War →' } }[mode] || { title:'Setup', goBtn:'Start →' };
  main.innerHTML = \`
    <div class="crumbs"><button onclick="navigate(sp('/pyp/paper/${'$'}{id}'))">← Back to Paper</button></div>
    <div class="section-title">${'$'}{esc(modeInfo.title)}</div>
    <p style="color:var(--muted); margin-bottom:20px; font-size:14px;">${'$'}{data.board?esc(data.board)+' — ':''}${'$'}{data.year}${'$'}{data.set?' (Set '+data.set+')':''} · ${'$'}{data.questions.length} questions${'$'}{data.totalMarks?' · marked out of '+data.totalMarks:''}</p>
    <div class="setup-box">
      <label style="margin-top:0;">Time Limit</label>
      <div class="count-row" style="gap:10px;">
        <input type="number" id="paperHoursInput" min="0" value="${'$'}{defHours}" style="width:70px; background:var(--bg); border:1.5px solid var(--card-border); color:var(--cream); padding:10px; border-radius:6px; font-size:15px;">
        <span class="val" style="width:auto; font-family:'IBM Plex Sans'; font-size:12.5px; color:var(--muted);">hr</span>
        <input type="number" id="paperMinutesInput" min="0" max="59" value="${'$'}{defMinutes}" style="width:70px; background:var(--bg); border:1.5px solid var(--card-border); color:var(--cream); padding:10px; border-radius:6px; font-size:15px;">
        <span class="val" style="width:auto; font-family:'IBM Plex Sans'; font-size:12.5px; color:var(--muted);">min</span>
      </div>
      <label class="radio-opt" style="margin-top:18px;"><input type="checkbox" id="paperReadingOn"> Add reading time (typing disabled while reading)</label>
      <div class="count-row" id="paperReadingRow" style="display:none;">
        <input type="number" id="paperReadingMinutes" min="1" value="15" style="width:70px; background:var(--bg); border:1.5px solid var(--card-border); color:var(--cream); padding:10px; border-radius:6px; font-size:15px;">
        <span class="val" style="width:auto; font-family:'IBM Plex Sans'; font-size:12.5px; color:var(--muted);">min reading time, before the test clock starts</span>
      </div>
    </div>
    <div style="display:flex; justify-content:flex-end;">
      <button class="btn" id="paperSetupGo">${'$'}{esc(modeInfo.goBtn)}</button>
    </div>
  \`;
  document.getElementById('paperReadingOn').addEventListener('change', (e)=>{ document.getElementById('paperReadingRow').style.display = e.target.checked ? 'flex' : 'none'; });
  document.getElementById('paperSetupGo').addEventListener('click', ()=>{
    const hours = Math.max(0, parseInt(document.getElementById('paperHoursInput').value,10) || 0);
    const minutes = Math.max(0, parseInt(document.getElementById('paperMinutesInput').value,10) || 0);
    const totalSeconds = Math.max(60, hours*3600 + minutes*60);
    const readingOn = document.getElementById('paperReadingOn').checked;
    const readingMinutes = Math.max(1, parseInt(document.getElementById('paperReadingMinutes').value,10) || 15);
    const opts = { paperId:id, timeLimitSeconds: totalSeconds, readingTimeSeconds: readingOn ? readingMinutes*60 : null, paperTotalMarks: data.totalMarks||null };
    if(mode==='solo') startPypSoloTest(opts);
    else createPypGangWar(opts);
  });
}

// Chapterwise picker, scoped to chapters that actually have PYP coverage (mirrors renderPicker)
async function renderPypPicker(mode){
  const titleMap = { quiz:'Chapterwise Practice', solo:'Chapterwise Timed Test', war:'Chapterwise Gang War' };
  const main = document.getElementById('main');
  main.innerHTML = '<div class="empty">Loading chapters…</div>';
  const pypChapters = await loadPypChapters();
  main.innerHTML = \`
    <div class="crumbs"><button onclick="navigate(sp('/pyp'))">← Previous Papers</button></div>
    <div class="section-title">${'$'}{esc(titleMap[mode]||'Pick Chapters')}</div>
    <p style="color:var(--muted); margin-bottom:20px; font-size:14px;">Pick one or more chapters — questions are pulled from every paper that covers them.</p>
    <div class="chapter-grid" id="pypPickGrid"></div>
    <div style="margin-top:24px; display:flex; justify-content:flex-end;">
      <button class="btn" id="pypPickGo">Let's Go →</button>
    </div>
  \`;
  const grid = document.getElementById('pypPickGrid');
  if(!pypChapters.length){ grid.innerHTML = '<div class="empty">No PYP questions loaded for any chapter yet.</div>'; return; }
  grid.innerHTML = pypChapters.map(c=>\`
    <div class="ch-card selectable" data-id="${'$'}{c.id}" onclick="toggleChapter(this,'${'$'}{c.id}',true)">
      <div class="num">${'$'}{c.branchName ? esc(c.branchName)+' · ' : ''}CH ${'$'}{c.chapterNum}</div>
      <h3>${'$'}{esc(c.title)}</h3>
      <div class="stats"><span>${'$'}{c.gradableCount} PYP Qs</span></div>
    </div>\`).join('');
  state.selectedChapters = [];
  document.getElementById('pypPickGo').addEventListener('click', ()=>{
    if(!state.selectedChapters.length){ alert('Pick at least one chapter first.'); return; }
    navigate(sp('/pyp/setup/'+mode+'?ch='+state.selectedChapters.join(',')));
  });
}

async function renderPypTestSetup(mode, chapterIds){
  const main = document.getElementById('main');
  chapterIds = chapterIds || [];
  if(!chapterIds.length){
    main.innerHTML = \`<div class="empty">No chapters selected.</div><div class="crumbs" style="justify-content:center;margin-top:16px;"><button onclick="navigate(sp('/pyp'))">← Previous Papers</button></div>\`;
    return;
  }
  const modeInfo = {
    quiz: { title:'Chapterwise Practice Setup', sub:'Instant feedback, no leaderboard.', defCount:10, defTimer:false, defMinutes:10, goBtn:'Start Practice →' },
    solo: { title:'Chapterwise Timed Test Setup', sub:'Timed test, just you and the clock.', defCount:15, defTimer:true, defMinutes:15, goBtn:'Start the Job →' },
    war:  { title:'Chapterwise Gang War Setup', sub:'Everyone who joins with your code gets these exact settings.', defCount:12, defTimer:true, defMinutes:15, goBtn:'Create the War →' }
  }[mode] || { title:'Test Setup', sub:'', defCount:10, defTimer:false, defMinutes:10, goBtn:'Start →' };

  main.innerHTML = \`
    <div class="crumbs"><button onclick="navigate(sp('/pyp/pick/${'$'}{mode}'))">← Change Chapters</button></div>
    <div class="section-title">${'$'}{esc(modeInfo.title)}</div>
    <p style="color:var(--muted); margin-bottom:20px; font-size:14px;">${'$'}{esc(modeInfo.sub)}</p>
    <div class="setup-box">
      <label>Chapters</label>
      <div style="color:var(--cream); font-size:13.5px; margin-bottom:18px;">${'$'}{chapterIds.map(id=>'CH '+id).join(' · ')}</div>

      <label for="pypDiffSel">Difficulty</label>
      <select id="pypDiffSel" class="setup-select"></select>

      <label for="pypCountInput" style="margin-top:18px;">Number of Questions</label>
      <div class="count-row">
        <input type="number" id="pypCountInput" min="1" value="${'$'}{modeInfo.defCount}" style="width:90px; background:var(--bg); border:1.5px solid var(--card-border); color:var(--cream); padding:10px; border-radius:6px; font-size:15px;">
        <span class="val" id="pypCountAvail" style="width:auto; font-family:'IBM Plex Sans'; font-size:12.5px; color:var(--muted);"></span>
      </div>

      <label style="margin-top:18px;">Time Limit</label>
      <div class="timer-choice">
        <label class="radio-opt"><input type="radio" name="pypTimerMode" id="pypTimerNone" ${'$'}{modeInfo.defTimer?'':'checked'}> No timer — take your time</label>
        <label class="radio-opt"><input type="radio" name="pypTimerMode" id="pypTimerOn" ${'$'}{modeInfo.defTimer?'checked':''}> Set a time limit</label>
      </div>
      <div class="count-row" id="pypMinutesRow" style="${'$'}{modeInfo.defTimer?'':'display:none;'} gap:10px;">
        <input type="number" id="pypHoursInput" min="0" value="0" style="width:70px; background:var(--bg); border:1.5px solid var(--card-border); color:var(--cream); padding:10px; border-radius:6px; font-size:15px;">
        <span class="val" style="width:auto; font-family:'IBM Plex Sans'; font-size:12.5px; color:var(--muted);">hr</span>
        <input type="number" id="pypMinutesInput" min="0" max="59" value="${'$'}{modeInfo.defMinutes}" style="width:70px; background:var(--bg); border:1.5px solid var(--card-border); color:var(--cream); padding:10px; border-radius:6px; font-size:15px;">
        <span class="val" style="width:auto; font-family:'IBM Plex Sans'; font-size:12.5px; color:var(--muted);">min — for the whole test</span>
      </div>

      <label class="radio-opt" style="margin-top:18px;"><input type="checkbox" id="pypReadingOn"> Add reading time (typing disabled while reading)</label>
      <div class="count-row" id="pypReadingRow" style="display:none;">
        <input type="number" id="pypReadingMinutes" min="1" value="15" style="width:70px; background:var(--bg); border:1.5px solid var(--card-border); color:var(--cream); padding:10px; border-radius:6px; font-size:15px;">
        <span class="val" style="width:auto; font-family:'IBM Plex Sans'; font-size:12.5px; color:var(--muted);">min reading time, before the test clock starts</span>
      </div>
    </div>
    <div style="display:flex; justify-content:flex-end;">
      <button class="btn" id="pypSetupGo">${'$'}{esc(modeInfo.goBtn)}</button>
    </div>
  \`;

  const diffSel = document.getElementById('pypDiffSel');
  const difficulties = (state.meta && state.meta.difficulties) || [];
  diffSel.innerHTML = '<option value="all">All Difficulties</option>' + difficulties.map(d=>\`<option value="${'$'}{esc(d)}">${'$'}{esc(d)}</option>\`).join('');

  const countInput = document.getElementById('pypCountInput');
  const countAvail = document.getElementById('pypCountAvail');
  async function refreshAvailable(){
    try{
      const res = await fetch('/api/'+state.subject+'/pyp/pool-count', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({chapterIds, difficulty: diffSel.value}) });
      const data = await res.json();
      const max = Math.max(data.count, 0);
      countAvail.textContent = max + ' gradable question' + (max===1?'':'s') + ' available';
      countInput.max = String(max || 1);
      if(max && parseInt(countInput.value,10) > max) countInput.value = max;
    }catch(e){ countAvail.textContent=''; }
  }
  diffSel.addEventListener('change', refreshAvailable);
  refreshAvailable();

  document.getElementById('pypTimerNone').addEventListener('click', ()=>{ document.getElementById('pypMinutesRow').style.display='none'; });
  document.getElementById('pypTimerOn').addEventListener('click', ()=>{ document.getElementById('pypMinutesRow').style.display='flex'; });
  document.getElementById('pypReadingOn').addEventListener('change', (e)=>{ document.getElementById('pypReadingRow').style.display = e.target.checked ? 'flex' : 'none'; });

  document.getElementById('pypSetupGo').addEventListener('click', ()=>{
    const count = Math.max(1, parseInt(countInput.value,10) || modeInfo.defCount);
    const difficulty = diffSel.value;
    const noTimer = document.getElementById('pypTimerNone').checked;
    const hours = Math.max(0, parseInt(document.getElementById('pypHoursInput').value,10) || 0);
    const minutes = Math.max(0, parseInt(document.getElementById('pypMinutesInput').value,10) || 0);
    const totalSeconds = hours*3600 + minutes*60;
    const readingOn = document.getElementById('pypReadingOn').checked;
    const readingMinutes = Math.max(1, parseInt(document.getElementById('pypReadingMinutes').value,10) || 15);
    const opts = { chapterIds, difficulty, count, timeLimitSeconds: (noTimer || totalSeconds<=0) ? null : totalSeconds, readingTimeSeconds: readingOn ? readingMinutes*60 : null };
    if(mode==='quiz') startPypQuiz(opts);
    else if(mode==='solo') startPypSoloTest(opts);
    else if(mode==='war') createPypGangWar(opts);
  });
}

// Start functions below all feed into the SAME runner screens as chapter-mode tests
// (renderQuizQuestion / renderTimedRunner / finishSoloTest / finishGangWar) — those already
// check '/api/quiz/check' and '/api/test/:code' which work across both question pools.
async function startPypQuiz(opts){
  opts = opts || {};
  const res = await fetch('/api/'+state.subject+'/pyp/quiz/generate', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(opts) });
  const data = await res.json();
  if(data.error){ alert(data.error); return; }
  state.quiz = data.questions.map(q=>({...q, given:'', submitted:false, shownAt:null, timeSec:null}));
  state.quizIdx = 0; state.quizScore = 0; state.testStart = Date.now();
  navigate('/run/quiz');
}
async function startPypSoloTest(opts){
  opts = opts || {};
  const res = await fetch('/api/'+state.subject+'/pyp/quiz/generate', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(opts) });
  const data = await res.json();
  if(data.error || !data.questions.length){ alert(data.error||'No questions available.'); return; }
  state.quiz = data.questions.map(q=>({...q, given:'', submitted:false, shownAt:null, timeSec:null}));
  state.quizIdx = 0; state.runnerMode = 'solo';
  state.timeLimitSeconds = opts.timeLimitSeconds || null;
  state.paperTotalMarks = opts.paperTotalMarks || null;
  state.readingTimeSeconds = opts.readingTimeSeconds || null;
  state.readingActive = !!state.readingTimeSeconds;
  state.readingStart = state.readingActive ? Date.now() : null;
  state.testStart = state.readingActive ? null : Date.now();
  navigate('/run/solo');
}
async function createPypGangWar(opts){
  opts = opts || {};
  const res = await fetch('/api/'+state.subject+'/pyp/test/create', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({...opts, creatorName: state.name}) });
  const data = await res.json();
  if(data.error){ alert(data.error); return; }
  state.testCode = data.code;
  const main = document.getElementById('main');
  main.innerHTML = \`
    <div class="crumbs"><button onclick="navigate(sp('/pyp'))">← Previous Papers</button></div>
    <div class="code-display">
      <div style="color:var(--muted); font-size:13px; text-transform:uppercase; letter-spacing:0.08em;">Gang War Code</div>
      <div class="code">${'$'}{data.code}</div>
      <div style="color:var(--muted); font-size:13px;">Share this code with your crew — same PYP questions, same rules, same fight.</div>
      <div style="margin-top:6px; font-size:12.5px; color:var(--gold-soft);">${'$'}{data.chapters.join(' · ')} — ${'$'}{data.questions.length} questions${'$'}{data.timeLimitSeconds ? ' · '+Math.round(data.timeLimitSeconds/60)+' min limit' : ' · no timer'}${'$'}{data.readingTimeSeconds ? ' · '+Math.round(data.readingTimeSeconds/60)+' min reading time' : ''}${'$'}{data.paperTotalMarks ? ' · marked out of '+data.paperTotalMarks : ''}</div>
    </div>
    <div style="display:flex; gap:12px; justify-content:center;">
      <button class="btn" onclick="navigate('/war/${'$'}{data.code}')">Take the Test Now</button>
      <button class="btn-outline" onclick="navigate('/leaderboard/${'$'}{data.code}')">View Leaderboard</button>
    </div>
  \`;
}

// ---------- Quick Heist (practice quiz, instant feedback) ----------
async function startQuiz(chapterIds, opts){
  opts = opts || {};
  const res = await fetch('/api/'+state.subject+'/quiz/generate', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({chapterIds, count: opts.count||10, difficulty: opts.difficulty||'all'}) });
  const data = await res.json();
  if(data.error){ alert(data.error); return; }
  state.quiz = data.questions.map(q=>({...q, given:'', submitted:false, shownAt:null, timeSec:null}));
  state.quizIdx = 0; state.quizScore = 0;
  state.timeLimitSeconds = opts.timeLimitSeconds || null;
  state.testStart = Date.now();
  if(!state.quiz.length){ alert('No gradable questions found for that selection yet.'); navigate(sp('')); return; }
  navigate('/run/quiz');
}

function renderQuizQuestion(){
  const main = document.getElementById('main');
  const q = state.quiz[state.quizIdx];
  if(!q.submitted && q.shownAt==null) q.shownAt = Date.now();
  main.innerHTML = \`
    <div class="crumbs"><button onclick="navigate(sp(''))">← Abort Heist</button></div>
    <div class="runner-top">
      <div class="q-progress" style="margin-bottom:0;">Question ${'$'}{state.quizIdx+1} of ${'$'}{state.quiz.length} · Score so far: ${'$'}{state.quizScore}</div>
      <div class="timer" id="runTimer">00:00</div>
    </div>
    <div class="q-card">
      <div style="font-size:11px;color:var(--gold-soft);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:10px;">${'$'}{q.subjectName?esc(q.subjectName)+' · ':''}${'$'}{esc(q.chapterTitle)} · ${'$'}{esc(q.topic||'')}${'$'}{q.difficulty?' · '+esc(q.difficulty):''}</div>
      <div class="qtext">${'$'}{renderMedia(q.question)}</div>
      <input type="text" id="qAns" value="${'$'}{esc(q.given||'')}" placeholder="Type your answer..." autocomplete="off" ${'$'}{q.submitted?'disabled':''}>
      <div id="qFeedback">${'$'}{q.submitted ? \`<div class="feedback ${'$'}{q.correct?'correct':'wrong'}">${'$'}{q.correct?'✅ Correct!':'❌ Not quite. Correct answer: '+renderMedia(q.correctAnswer||'')}<span class="time-tag">⏱ ${'$'}{q.timeSec}s</span></div>\` : ''}</div>
    </div>
    <div class="nav-row">
      <button class="btn-outline" onclick="navigate(sp(''))">Quit</button>
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
  if(q.paperId) markPypQuestionAnswered(q.paperId, q.qid);
  renderQuizQuestion();
}

function renderQuizDone(){
  const main = document.getElementById('main');
  main.innerHTML = \`
    <div class="result-hero">
      <div class="big">${'$'}{state.quizScore} / ${'$'}{state.quiz.length}</div>
      <div class="sub">Heist complete. Not bad, ${'$'}{esc(state.name)}.</div>
      <div style="margin-top:24px;"><button class="btn" onclick="navigate(sp(''))">Back to The Turf</button></div>
    </div>
    <div class="section-title" style="margin-top:20px;">Breakdown</div>
    ${'$'}{state.quiz.map(r=>\`<div class="ex-item"><div class="q">${'$'}{renderMedia(r.question)}</div><div class="feedback ${'$'}{r.correct?'correct':'wrong'}">${'$'}{r.correct?'✅ Correct':'❌ Your answer: '+esc(r.given||'(blank)')+' — Correct: '+renderMedia(r.correctAnswer||'')}<span class="time-tag">⏱ ${'$'}{r.timeSec!=null?r.timeSec+'s':'—'}</span></div></div>\`).join('')}
  \`;
}

// ---------- Reading Time: questions visible, no typing, own countdown before the answer clock starts ----------
function renderReadingPhase(){
  const main = document.getElementById('main');
  const isWar = state.runnerMode==='war';
  main.innerHTML = \`
    <div class="runner-top">
      <div class="q-progress" style="margin-bottom:0;">${'$'}{isWar ? 'Code '+state.testCode+' · ' : ''}Reading Time — no typing yet</div>
      <div class="timer" id="readTimer">00:00</div>
    </div>
    ${'$'}{state.quiz.map((q,i)=>\`<div class="q-card" style="margin-bottom:14px;"><div style="font-size:11px;color:var(--gold-soft);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:10px;">Question ${'$'}{i+1}${'$'}{q.marks?' · '+q.marks+' marks':''}</div><div class="qtext">${'$'}{renderMedia(q.question)}</div></div>\`).join('')}
    <div class="nav-row" style="justify-content:center;">
      <button class="btn" id="readStartNow">Start Answering Now →</button>
    </div>
  \`;
  clearInterval(state.testTimer);
  state.testTimer = setInterval(()=>{
    const t = document.getElementById('readTimer');
    if(!t) return;
    const remain = state.readingTimeSeconds - Math.floor((Date.now()-state.readingStart)/1000);
    if(remain <= 0){ t.textContent = '00:00'; clearInterval(state.testTimer); finishReadingPhase(); return; }
    const mm = String(Math.floor(remain/60)).padStart(2,'0'), ss = String(remain%60).padStart(2,'0');
    t.textContent = mm+':'+ss;
  }, 500);
  document.getElementById('readStartNow').addEventListener('click', ()=>{ clearInterval(state.testTimer); finishReadingPhase(); });
}
function finishReadingPhase(){
  state.readingActive = false;
  state.testStart = Date.now();
  renderTimedRunner();
}

// ---------- Shared timed runner (Solo Job + Gang War): explicit submit, then answer is locked ----------
function renderTimedRunner(){
  if(state.readingActive) return renderReadingPhase();
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
      <div style="font-size:11px;color:var(--gold-soft);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:10px;">${'$'}{q.subjectName?esc(q.subjectName)+' · ':''}${'$'}{esc(q.chapterTitle)}${'$'}{q.difficulty?' · '+esc(q.difficulty):''}</div>
      <div class="qtext">${'$'}{renderMedia(q.question)}</div>
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
  const res = await fetch('/api/'+state.subject+'/quiz/generate', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({chapterIds, count: opts.count||15, difficulty: opts.difficulty||'all'}) });
  const data = await res.json();
  if(data.error || !data.questions.length){ alert(data.error||'No questions available.'); return; }
  state.quiz = data.questions.map(q=>({...q, given:'', submitted:false, shownAt:null, timeSec:null}));
  state.quizIdx = 0; state.runnerMode = 'solo';
  state.timeLimitSeconds = opts.timeLimitSeconds || null;
  state.paperTotalMarks = opts.paperTotalMarks || null;
  state.readingTimeSeconds = opts.readingTimeSeconds || null;
  state.readingActive = !!state.readingTimeSeconds;
  state.readingStart = state.readingActive ? Date.now() : null;
  state.testStart = state.readingActive ? null : Date.now();
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
    if(q.paperId) markPypQuestionAnswered(q.paperId, q.qid);
  }
  const incorrect = state.quiz.length - score;
  const marksMode = state.quiz.some(q=>q.paperId) && state.paperTotalMarks;
  let marksLine = '';
  if(marksMode){
    let marksScored = 0;
    state.quiz.forEach(q=>{ if(q.correct && typeof q.marks==='number') marksScored += q.marks; });
    marksLine = \`<div class="sub" style="margin-top:4px;">Marked ${'$'}{marksScored} / ${'$'}{state.paperTotalMarks} (auto-gradable questions only)</div>\`;
  }
  const mm = String(Math.floor(timeTaken/60)).padStart(2,'0'), ss = String(timeTaken%60).padStart(2,'0');
  const main = document.getElementById('main');
  main.innerHTML = \`
    <div class="result-hero">
      <div class="big">${'$'}{score} / ${'$'}{state.quiz.length}</div>
      <div class="sub">${'$'}{score} correct · ${'$'}{incorrect} incorrect — Job done in ${'$'}{mm}:${'$'}{ss}</div>
      ${'$'}{marksLine}
      <div style="margin-top:24px;"><button class="btn" onclick="navigate(sp(''))">Back to The Turf</button></div>
    </div>
    <div class="section-title" style="margin-top:20px;">Breakdown</div>
    ${'$'}{state.quiz.map(r=>\`<div class="ex-item"><div class="q">${'$'}{renderMedia(r.question)}${'$'}{r.marks?' <span style="color:var(--gold-soft);font-size:12px;">('+r.marks+' marks)</span>':''}</div><div class="feedback ${'$'}{r.correct?'correct':'wrong'}">${'$'}{r.correct?'✅ Correct':'❌ Your answer: '+esc(r.given||'(blank)')+' — Correct: '+renderMedia(r.correctAnswer||'')}<span class="time-tag">⏱ ${'$'}{r.timeSec!=null?r.timeSec+'s':'—'}</span></div></div>\`).join('')}
  \`;
}

// ---------- Gang War (shared test code + leaderboard) ----------
async function createGangWar(chapterIds, opts){
  opts = opts || {};
  const res = await fetch('/api/'+state.subject+'/test/create', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({chapterIds, count: opts.count||12, creatorName: state.name, mode:'squad', difficulty: opts.difficulty||'all', timeLimitSeconds: opts.timeLimitSeconds||null, readingTimeSeconds: opts.readingTimeSeconds||null}) });
  const data = await res.json();
  if(data.error){ alert(data.error); return; }
  state.testCode = data.code;
  const main = document.getElementById('main');
  main.innerHTML = \`
    <div class="crumbs"><button onclick="navigate(sp(''))">← The Turf</button></div>
    <div class="code-display">
      <div style="color:var(--muted); font-size:13px; text-transform:uppercase; letter-spacing:0.08em;">Gang War Code</div>
      <div class="code">${'$'}{data.code}</div>
      <div style="color:var(--muted); font-size:13px;">Share this code with your crew — same questions, same rules, same fight.</div>
      <div style="margin-top:6px; font-size:12.5px; color:var(--gold-soft);">${'$'}{data.chapters.join(' · ')} — ${'$'}{data.questions.length} questions${'$'}{data.timeLimitSeconds ? ' · '+Math.round(data.timeLimitSeconds/60)+' min limit' : ' · no timer'}${'$'}{data.readingTimeSeconds ? ' · '+Math.round(data.readingTimeSeconds/60)+' min reading time' : ''}</div>
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
    <div class="crumbs"><button onclick="navigate(sp(''))">← The Turf</button></div>
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
  if(data.error){ alert(data.error); navigate(sp('')); return; }
  state.testCode = code;
  state.quiz = data.questions.map(q=>({...q, given:'', submitted:false, shownAt:null, timeSec:null}));
  state.quizIdx = 0; state.runnerMode = 'war';
  state.timeLimitSeconds = data.timeLimitSeconds || null;
  state.paperTotalMarks = data.paperTotalMarks || null;
  state.readingTimeSeconds = data.readingTimeSeconds || null;
  state.readingActive = !!state.readingTimeSeconds;
  state.readingStart = state.readingActive ? Date.now() : null;
  state.testStart = state.readingActive ? null : Date.now();
  renderTimedRunner();
}

async function finishGangWar(){
  clearInterval(state.testTimer);
  const timeTaken = Math.floor((Date.now()-state.testStart)/1000);
  const answers = {}; const perQuestionSeconds = {};
  state.quiz.forEach(q=>{ answers[q.qid] = q.given; perQuestionSeconds[q.qid] = q.timeSec; });
  const res = await fetch('/api/test/'+state.testCode+'/submit', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name: state.name, answers, timeTakenSeconds: timeTaken, perQuestionSeconds }) });
  const data = await res.json();
  state.quiz.forEach(q=>{ if(q.paperId) markPypQuestionAnswered(q.paperId, q.qid); });
  const mm = String(Math.floor(timeTaken/60)).padStart(2,'0'), ss = String(timeTaken%60).padStart(2,'0');
  const byQid = {}; (data.breakdown||[]).forEach(b=>byQid[b.qid]=b);
  const incorrect = data.total - data.score;
  const marksLine = (data.marksTotal!=null) ? \`<div class="sub" style="margin-top:4px;">Marked ${'$'}{data.marksScored} / ${'$'}{data.paperTotalMarks||data.marksTotal} (auto-gradable questions only)</div>\` : '';
  const main = document.getElementById('main');
  main.innerHTML = \`
    <div class="result-hero">
      <div class="big">${'$'}{data.score} / ${'$'}{data.total}</div>
      <div class="sub">${'$'}{data.score} correct · ${'$'}{incorrect} incorrect — Submitted in ${'$'}{mm}:${'$'}{ss}. The family is watching.</div>
      ${'$'}{marksLine}
      <div style="margin-top:24px; display:flex; gap:12px; justify-content:center;">
        <button class="btn" onclick="navigate('/leaderboard/${'$'}{state.testCode}')">View Leaderboard</button>
        <button class="btn-outline" onclick="navigate(sp(''))">Back to The Turf</button>
      </div>
    </div>
    <div class="section-title" style="margin-top:20px;">Breakdown</div>
    ${'$'}{state.quiz.map(q=>{ const b = byQid[q.qid]||{}; return \`<div class="ex-item"><div class="q">${'$'}{renderMedia(q.question)}${'$'}{b.marks?' <span style="color:var(--gold-soft);font-size:12px;">('+b.marks+' marks)</span>':''}</div><div class="feedback ${'$'}{b.correct?'correct':'wrong'}">${'$'}{b.correct?'✅ Correct':'❌ Your answer: '+esc(q.given||'(blank)')+' — Correct: '+renderMedia(b.correctAnswer||'')}<span class="time-tag">⏱ ${'$'}{q.timeSec!=null?q.timeSec+'s':'—'}</span></div></div>\`; }).join('')}
  \`;
}

async function viewLeaderboard(code){
  const main = document.getElementById('main');
  main.innerHTML = '<div class="empty">Loading leaderboard…</div>';
  const res = await fetch('/api/test/'+code+'/leaderboard');
  const data = await res.json();
  if(data.error){ alert(data.error); navigate(sp('')); return; }
  main.innerHTML = \`
    <div class="crumbs"><button onclick="navigate(sp(''))">← The Turf</button></div>
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
    const incorrect = data.total - a.score;
    const marksBit = (a.marksTotal!=null) ? \` <span style="color:var(--gold-soft);">· ${'$'}{a.marksScored}/${'$'}{a.paperTotalMarks||a.marksTotal} marks</span>\` : '';
    return \`<div class="lb-row ${'$'}{i===0?'top1':''}"><div class="rank">#${'$'}{i+1}</div><div class="name">${'$'}{esc(a.name)}</div><div class="score">${'$'}{a.score}✓ ${'$'}{incorrect}✗${'$'}{marksBit}</div><div class="time">${'$'}{mm}:${'$'}{ss}</div></div>\`;
  }).join('');
}

// ---------- Mix Subjects Gang War: pull chapters from several subjects into one combined war ----------
async function renderMixPicker(){
  const main = document.getElementById('main');
  if(!state.subjects.length) await loadSubjects();
  main.innerHTML = \`
    <div class="crumbs"><button onclick="navigate(sp(''))">← The Turf</button></div>
    <div class="section-title">Mix Subjects War</div>
    <p style="color:var(--muted); margin-bottom:20px; font-size:14px;">Add chapters from as many subjects as you want — your crew answers one combined test.</p>
    <div id="mixPartsList"></div>
    <div class="setup-box" style="margin-top:16px;">
      <label for="mixSubjSel">Add chapters from</label>
      <select id="mixSubjSel" class="setup-select"></select>
      <div class="chapter-grid" id="mixChGrid" style="margin-top:14px;"></div>
      <div style="display:flex; justify-content:flex-end; margin-top:14px;">
        <button class="btn-outline" id="mixAddBtn">+ Add these chapters</button>
      </div>
    </div>
    <div style="display:flex; justify-content:flex-end; margin-top:20px; gap:12px;">
      <button class="btn" id="mixContinue">Continue to Setup →</button>
    </div>
  \`;
  const subjSel = document.getElementById('mixSubjSel');
  subjSel.innerHTML = state.subjects.map(s=>\`<option value="${'$'}{s.id}">${'$'}{s.icon?s.icon+' ':''}${'$'}{esc(s.name)}</option>\`).join('');
  subjSel.value = state.subject;

  async function loadMixChapters(){
    const grid = document.getElementById('mixChGrid');
    grid.innerHTML = '<div class="empty">Loading…</div>';
    const res = await fetch('/api/'+subjSel.value+'/chapters');
    const chs = await res.json();
    grid.innerHTML = chs.map(c=>\`
      <div class="ch-card selectable" data-id="${'$'}{c.id}" onclick="this.classList.toggle('selected')">
        <div class="num">${'$'}{c.branchName ? esc(c.branchName)+' · ' : ''}CH ${'$'}{c.chapterNum}</div><h3>${'$'}{esc(c.title)}</h3>
        <div class="progress-label">${'$'}{c.gradableCount} gradable Qs</div>
      </div>\`).join('');
  }
  subjSel.addEventListener('change', loadMixChapters);
  loadMixChapters();

  function renderPartsList(){
    const list = document.getElementById('mixPartsList');
    if(!state.mixParts.length){ list.innerHTML = ''; return; }
    list.innerHTML = state.mixParts.map((p,i)=>{
      const sInfo = state.subjects.find(s=>s.id===p.subject) || {name:p.subject};
      return \`<div class="ch-card" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <div><b>${'$'}{sInfo.icon?sInfo.icon+' ':''}${'$'}{esc(sInfo.name)}</b> — ${'$'}{p.chapterIds.length} chapter(s) selected</div>
        <button class="btn-ghost" onclick="removeMixPart(${'$'}{i})">remove</button>
      </div>\`;
    }).join('');
  }
  renderPartsList();

  document.getElementById('mixAddBtn').addEventListener('click', ()=>{
    const grid = document.getElementById('mixChGrid');
    const ids = [...grid.querySelectorAll('.ch-card.selected')].map(el=>el.dataset.id);
    if(!ids.length){ alert('Pick at least one chapter first.'); return; }
    const existing = state.mixParts.find(p=>p.subject===subjSel.value);
    if(existing){ existing.chapterIds = [...new Set([...existing.chapterIds, ...ids])]; }
    else{ state.mixParts.push({ subject: subjSel.value, chapterIds: ids }); }
    renderPartsList();
    loadMixChapters();
  });
  document.getElementById('mixContinue').addEventListener('click', ()=>{
    if(!state.mixParts.length){ alert('Add chapters from at least one subject first.'); return; }
    navigate('/mix/setup');
  });
}

function removeMixPart(i){ state.mixParts.splice(i,1); renderMixPicker(); }

async function renderMixWarSetup(){
  const main = document.getElementById('main');
  if(!state.mixParts.length){ navigate('/mix/pick'); return; }
  main.innerHTML = '<div class="empty">Loading setup…</div>';
  const rows = await Promise.all(state.mixParts.map(async (p,i)=>{
    const sInfo = state.subjects.find(s=>s.id===p.subject) || {name:p.subject};
    const metaRes = await fetch('/api/'+p.subject+'/meta');
    const meta = await metaRes.json();
    return { i, p, sInfo, difficulties: meta.difficulties||[] };
  }));
  main.innerHTML = \`
    <div class="crumbs"><button onclick="navigate('/mix/pick')">← Change Chapters</button></div>
    <div class="section-title">Mix Subjects War Setup</div>
    <p style="color:var(--muted); margin-bottom:20px; font-size:14px;">Set how many questions to pull from each subject.</p>
    ${'$'}{rows.map(r=>\`
      <div class="setup-box" style="margin-bottom:14px;">
        <label>${'$'}{r.sInfo.icon?r.sInfo.icon+' ':''}${'$'}{esc(r.sInfo.name)}</label>
        <div style="color:var(--muted); font-size:13px; margin-bottom:12px;">${'$'}{r.p.chapterIds.length} chapter(s) selected</div>
        <label for="mixDiff${'$'}{r.i}">Difficulty</label>
        <select id="mixDiff${'$'}{r.i}" class="setup-select"><option value="all">All Difficulties</option>${'$'}{r.difficulties.map(d=>\`<option value="${'$'}{esc(d)}">${'$'}{esc(d)}</option>\`).join('')}</select>
        <label for="mixCount${'$'}{r.i}" style="margin-top:14px;">Number of Questions</label>
        <input type="number" id="mixCount${'$'}{r.i}" min="1" value="5" style="width:90px; background:var(--bg); border:1.5px solid var(--card-border); color:var(--cream); padding:10px; border-radius:6px; font-size:15px;">
      </div>
    \`).join('')}
    <div class="setup-box">
      <label style="margin-top:0;">Time Limit</label>
      <div class="timer-choice">
        <label class="radio-opt"><input type="radio" name="mixTimerMode" id="mixTimerNone"> No timer — take your time</label>
        <label class="radio-opt"><input type="radio" name="mixTimerMode" id="mixTimerOn" checked> Set a time limit</label>
      </div>
      <div class="count-row" id="mixMinutesRow" style="gap:10px;">
        <input type="number" id="mixHoursInput" min="0" value="0" style="width:70px; background:var(--bg); border:1.5px solid var(--card-border); color:var(--cream); padding:10px; border-radius:6px; font-size:15px;">
        <span class="val" style="width:auto; font-family:'IBM Plex Sans'; font-size:12.5px; color:var(--muted);">hr</span>
        <input type="number" id="mixMinutesInput" min="0" max="59" value="20" style="width:70px; background:var(--bg); border:1.5px solid var(--card-border); color:var(--cream); padding:10px; border-radius:6px; font-size:15px;">
        <span class="val" style="width:auto; font-family:'IBM Plex Sans'; font-size:12.5px; color:var(--muted);">min — for the whole test</span>
      </div>
      <label class="radio-opt" style="margin-top:18px;"><input type="checkbox" id="mixReadingOn"> Add reading time (typing disabled while reading)</label>
      <div class="count-row" id="mixReadingRow" style="display:none;">
        <input type="number" id="mixReadingMinutes" min="1" value="15" style="width:70px; background:var(--bg); border:1.5px solid var(--card-border); color:var(--cream); padding:10px; border-radius:6px; font-size:15px;">
        <span class="val" style="width:auto; font-family:'IBM Plex Sans'; font-size:12.5px; color:var(--muted);">min reading time, before the test clock starts</span>
      </div>
    </div>
    <div style="display:flex; justify-content:flex-end;">
      <button class="btn" id="mixGo">Create the War →</button>
    </div>
  \`;
  document.getElementById('mixTimerNone').addEventListener('change', ()=>{ document.getElementById('mixMinutesRow').style.display='none'; });
  document.getElementById('mixTimerOn').addEventListener('change', ()=>{ document.getElementById('mixMinutesRow').style.display='flex'; });
  document.getElementById('mixReadingOn').addEventListener('change', (e)=>{ document.getElementById('mixReadingRow').style.display = e.target.checked ? 'flex':'none'; });
  document.getElementById('mixGo').addEventListener('click', ()=>{
    const parts = rows.map(r=>({
      subject: r.p.subject, chapterIds: r.p.chapterIds,
      difficulty: document.getElementById('mixDiff'+r.i).value,
      count: Math.max(1, parseInt(document.getElementById('mixCount'+r.i).value,10) || 1)
    }));
    const noTimer = document.getElementById('mixTimerNone').checked;
    const hours = Math.max(0, parseInt(document.getElementById('mixHoursInput').value,10)||0);
    const minutes = Math.max(0, parseInt(document.getElementById('mixMinutesInput').value,10)||0);
    const totalSeconds = hours*3600+minutes*60;
    const readingOn = document.getElementById('mixReadingOn').checked;
    const readingMinutes = Math.max(1, parseInt(document.getElementById('mixReadingMinutes').value,10)||15);
    createMixGangWar({ parts, timeLimitSeconds: (noTimer||totalSeconds<=0)?null:totalSeconds, readingTimeSeconds: readingOn ? readingMinutes*60 : null });
  });
}

async function createMixGangWar(opts){
  const main = document.getElementById('main');
  main.innerHTML = '<div class="empty">Building the war…</div>';
  const res = await fetch('/api/mix/test/create', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ parts: opts.parts, creatorName: state.name, timeLimitSeconds: opts.timeLimitSeconds, readingTimeSeconds: opts.readingTimeSeconds }) });
  const data = await res.json();
  if(data.error){ alert(data.error); renderMixWarSetup(); return; }
  state.mixParts = [];
  state.testCode = data.code;
  main.innerHTML = \`
    <div class="crumbs"><button onclick="navigate(sp(''))">← The Turf</button></div>
    <div class="code-display">
      <div style="color:var(--muted); font-size:13px; text-transform:uppercase; letter-spacing:0.08em;">Mix Subjects Gang War Code</div>
      <div class="code">${'$'}{data.code}</div>
      <div style="color:var(--muted); font-size:13px;">Share this code with your crew — same mixed questions, same rules.</div>
      <div style="margin-top:6px; font-size:12.5px; color:var(--gold-soft);">${'$'}{data.chapters.join(' · ')} — ${'$'}{data.questions.length} questions${'$'}{data.timeLimitSeconds ? ' · '+Math.round(data.timeLimitSeconds/60)+' min limit' : ' · no timer'}</div>
    </div>
    <div style="display:flex; gap:12px; justify-content:center;">
      <button class="btn" onclick="navigate('/war/${'$'}{data.code}')">Take the Test Now</button>
      <button class="btn-outline" onclick="navigate('/leaderboard/${'$'}{data.code}')">View Leaderboard</button>
    </div>
  \`;
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
