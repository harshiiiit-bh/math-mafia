# Math Mafia — Class 10 Maths Study Site

## What's inside
- `server.js` — the entire app: Express backend + embedded frontend (single file, as requested)
- `data/ch01.json ... ch05.json` — chapter content (notes, formulas, examples, exercises). Add ch06.json, ch07.json, etc. as more chapters get processed — the server auto-loads every .json file in /data on startup, no code changes needed.
- `db.json` — auto-created at runtime, stores Gang War test codes + leaderboard attempts. Safe to delete to reset all test history.

## Features live right now
- Name-gate entry (required, Enter submits)
- The Intel — chapter-wise notes
- Cheat Sheet — chapter-wise formula sheet
- Quick Heist — instant-feedback practice quiz, multi-chapter
- Solo Job — timed test, single or multiple chapters
- Gang War — create a test, get a 6-character code, share with friends. Everyone gets the same questions. Leaderboard sorts by score then time taken.
- Practice Bank tab — browse every NCERT exercise per chapter with answers, untimed.

## Run locally
```
npm install
npm start
```
Then open http://localhost:3000

## Known v1 limitation (important)
Auto-graded quizzes/tests only pull from exercises whose answers are short and single-part (a number, a short phrase) — multi-part questions like "(i)...(ii)...(iii)..." and proof-based questions are excluded from grading since they can't be checked with one text box. They're still fully visible in the Practice Bank tab. This will improve a lot once your PYQ/MIQ files are processed, since those are usually already MCQ-formatted — perfect for auto-grading. We can also split multi-part NCERT questions into individual gradable sub-questions later if you want more NCERT-based test volume.

## Deploy online
Ask Claude for the step-by-step (Render/Railway are the easiest free options for a Node app like this).
