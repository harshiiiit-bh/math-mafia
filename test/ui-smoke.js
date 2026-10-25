'use strict';

const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:4173';

async function assertNoHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth
  }));
  assert.ok(
    metrics.document <= metrics.viewport + 2,
    label + ' overflows horizontally: document ' + metrics.document + 'px, viewport ' + metrics.viewport + 'px'
  );
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#nameInput').fill('Browser QA');
    await page.getByRole('button', { name: /Continue/ }).click();
    await page.locator('#app.active').waitFor();
    await page.locator('#chGrid .ch-card').first().waitFor();
    assert.equal(await page.locator('#chGrid .ch-card').count(), 14, 'Maths dashboard should expose 14 chapters');
    await assertNoHorizontalOverflow(page, 'Desktop dashboard');

    // Chapter tabs: notes, formulas, practice bank and MCQ filters.
    await page.locator('#chGrid .ch-card').filter({ hasText: 'Real Numbers' }).click();
    await page.locator('#chBody .note-item').first().waitFor();
    for (const tab of ['formulas', 'exercises', 'mcq']) {
      await page.locator('.tabs button[data-t="' + tab + '"]').click();
      await page.locator('#chBody').waitFor();
      await page.waitForFunction(() => {
        const body = document.querySelector('#chBody');
        return body && body.textContent.trim().length > 0;
      });
    }
    const mcqTabs = page.locator('.mcq-subtab');
    await mcqTabs.first().waitFor();
    await page.locator('.mcq-subtab[data-st="mcq"]').click();
    await page.locator('.mcq-subtab[data-st="assertion-reason"]').click();
    await assertNoHorizontalOverflow(page, 'Desktop chapter page');

    // The practice flow should select a chapter, validate question availability, and reach a question.
    await page.locator('.crumbs button').first().click();
    await page.locator('#main .mode-card').filter({ hasText: 'Practice Quiz' }).click();
    await page.locator('#pickGrid .ch-card[data-id="9"]').click();
    await page.locator('#pickGo').click();
    await page.locator('#countAvail').waitFor();
    await page.waitForFunction(() => {
      const el = document.querySelector('#countAvail');
      return el && /gradible|gradable question/.test(el.textContent);
    });
    await page.locator('#setupGo').waitFor();
    assert.equal(await page.locator('#setupGo').isDisabled(), false, 'Selected test setup should be enabled when questions exist');
    await page.locator('#setupGo').click();
    await page.locator('.q-card .qtext').waitFor();

    // Submit one practice answer and verify feedback is rendered (the answer can intentionally be wrong).
    const options = page.locator('.mcq-opt');
    if (await options.count()) {
      await options.first().click();
    } else {
      await page.locator('#qAns').fill('Browser QA answer');
    }
    await page.locator('#qSubmit').click();
    await page.locator('#qFeedback .feedback').waitFor();
    await page.locator('.crumbs button').first().click();
    await page.locator('#chGrid .ch-card').first().waitFor();

    // Previous-paper list, detail and full-paper setup must remain usable.
    await page.locator('#main .mode-card').filter({ hasText: 'Previous Papers' }).click();
    await page.locator('#pypGrid .ch-card').first().waitFor();
    await page.locator('#pypGrid .ch-card').filter({ hasText: '2026 Set 1' }).click();
    await page.locator('#pypSoloBtn').waitFor();
    assert.match(await page.locator('#main').innerText(), /questions in scored tests/i);
    await page.locator('#pypSoloBtn').click();
    await page.locator('#paperSetupGo').waitFor();
    await page.locator('.crumbs button').first().click();
    await page.locator('#pypSoloBtn').waitFor();
    await assertNoHorizontalOverflow(page, 'Desktop paper detail');

    // Unsupported subject data should be an explicit useful state; its notes navigation still works.
    await page.locator('#subjectTabs .subj-tab').filter({ hasText: 'Science' }).click();
    await page.getByRole('button', { name: /Browse Short Notes/ }).waitFor();
    await page.getByRole('button', { name: /Browse Short Notes/ }).click();
    await page.locator('#main .mode-card').filter({ hasText: 'Physics' }).waitFor();
    await page.locator('#main .mode-card').filter({ hasText: 'Physics' }).click();
    await page.locator('#main').waitFor();
    assert.ok((await page.locator('#main').innerText()).trim().length > 0, 'Science notes route should render a meaningful page');

    // Check phone layout after the major screens have rendered.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#subjectTabs .subj-tab').filter({ hasText: 'Maths' }).click();
    await page.locator('#main').waitFor();
    await assertNoHorizontalOverflow(page, 'Mobile dashboard');

    assert.deepEqual(pageErrors, [], 'Browser should not emit uncaught JavaScript errors');
    console.log('Browser UI smoke passed: chapter tabs, quiz flow, PYP screens, Science empty state, and mobile overflow.');
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
