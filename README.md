# Math Mafia

A Class 10 learning studio for Maths, Science and Social Science. Math Mafia brings chapter resources, question practice, timed tests and friendly shared challenges into one responsive interface.

## What it includes

- **Chapter learning:** notes, formula sheets, worked examples and a browsable practice bank.
- **MCQ practice:** multiple-choice and Assertion–Reason questions with instant answer reveal.
- **Practice quizzes:** build question sets from selected chapters and see feedback after each response.
- **Timed tests:** practice under a time limit, with per-question navigation and a results breakdown.
- **Shared challenges:** create a short join code, share the same question set and compare scores on a leaderboard.
- **Previous papers:** browse available papers, practice by chapter and inspect question-weightage summaries where paper data exists.
- **Progress tracking:** reading/practice progress and the selected name are stored locally in the browser.

The site runs as a small Express application. `server.js` contains the API and embedded frontend; chapter content is loaded from JSON files in `data/`.

## Run locally

Requirements: Node.js 20 or newer.

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000).

Run the grading regression tests with:

```bash
npm test
```

The repository's GitHub Actions workflow checks JavaScript syntax, runs the grading regression tests, starts the Express app, and smoke-tests the subjects, Maths chapters and homepage on pushes and pull requests to `main`.

## Content layout

- `data/maths/<chapter-number>.json`, `data/science/<chapter-number>.json`, and `data/sst/<chapter-number>.json`: chapter notes, formulas, examples and exercises.
- `data/<subject>/mcq/`: optional dedicated MCQ banks.
- `data/<subject>/pyp/`: optional previous-year/sample papers.
- `notes/<subject>/`: optional static HTML short notes; Science and SST can also be organized by branch.
- `lib/grading.js`: centralized answer normalization, MCQ key handling and gradability rules.
- `test/grading.test.js`: regression coverage for the answer checker.
- `db.json`: created at runtime for shared test codes and leaderboard attempts.

Chapter JSON files are loaded at startup. Restart the server after changing content so it reloads the data.

## Scoring behavior and limitations

Scoring is deliberately conservative: MCQ answers can be provided as an option letter or option text, and simple numeric/fraction answers are normalized before comparison. It does not use substring guessing, because that can award points for incorrect answers such as `112` when the key is `12`.

Proof-based, multi-part, image-solution and blank-stem answers are excluded from one-box auto-graded pools and remain available in the practice bank. Full-paper tests select only one version of each internal-choice pair (for example, `22a`/`22b`) instead of scoring both alternatives. Their result shows the official paper total and the smaller mark total available from auto-gradable questions, so a student can see what was actually scored. The checker is **not** a symbolic algebra engine, so equivalent algebraic expressions may need a consistent answer format in the content JSON. Check answer keys before publishing a question bank.

## Deployment note

This application writes shared test codes and attempts to `db.json`. A hosting environment that uses an ephemeral filesystem can lose that data when the instance restarts or redeploys. Use persistent storage or migrate the shared-test records to a managed database before relying on long-term leaderboards.
