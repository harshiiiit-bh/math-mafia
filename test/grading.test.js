'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkAnswer, isGradable, normalizeAnswer } = require('../lib/grading');

test('MCQs accept a correct option letter when the key stores the full option text', () => {
  const options = ['2', '4', '6', '8'];
  assert.equal(checkAnswer('B', '4', options), true);
  assert.equal(checkAnswer('B', 'B', options), true);
  assert.equal(checkAnswer('B', 'Option B', options), true);
  assert.equal(checkAnswer('B', 'Choice B: 4', options), true);
  assert.equal(checkAnswer('A', '4', options), false);
});

test('MCQs accept a correct option text when the key stores a letter', () => {
  const options = ['Prime number', 'Composite number', 'Neither', 'Both'];
  assert.equal(checkAnswer('Prime number', 'A', options), true);
  assert.equal(checkAnswer('C', 'A', options), false);
  assert.equal(checkAnswer('B', 'B (probability can never be negative)', options), true);
});

test('answer matching does not accept misleading partial numeric matches', () => {
  assert.equal(checkAnswer('112', '12'), false);
  assert.equal(checkAnswer('12', '112'), false);
  assert.equal(checkAnswer('0.5', '1/2'), true);
  assert.equal(checkAnswer('22,338', '22338'), true);
  assert.equal(checkAnswer('No', 'No -- 6^n has no factor of 5.'), true);
  assert.equal(checkAnswer('Yes', 'Yes (because the graph crosses the axis)'), true);
  assert.equal(checkAnswer('13', '113'), false);
  assert.equal(checkAnswer('HCF 13', 'HCF 13 -- LCM 182'), false);
});

test('math symbols and common units normalize predictably', () => {
  assert.equal(normalizeAnswer('3 × 2'), '3x2');
  assert.equal(checkAnswer('12 cm', '12'), true);
  assert.equal(checkAnswer('x²', 'x^2'), true);
  assert.equal(checkAnswer('12m', '12'), false);
  assert.equal(checkAnswer('12s', '12'), false);
});

test('empty answers are wrong and valid zero answers remain gradable', () => {
  assert.equal(checkAnswer('', '0'), false);
  assert.equal(checkAnswer('0', 0), true);
  assert.equal(isGradable({ question: 'Calculate the result', answer: 0 }), true);
});

test('multi-part and proof answers are not sent to one-box auto-grading', () => {
  assert.equal(isGradable({ question: 'Find the requested values', answer: '(i) 3 (ii) 4' }), false);
  assert.equal(isGradable({ question: 'Prove that the expression is irrational.', answer: 'Proof: show that the expression is irrational by contradiction.' }), false);
  assert.equal(isGradable({ question: 'Find the LCM.', answer: '22338' }), true);
});

test('MCQ answer labels support more than six choices', () => {
  const options = Array.from({ length: 26 }, (_, i) => 'Option ' + String.fromCharCode(65+i));
  assert.equal(checkAnswer('Z', 'Z', options), true);
  assert.equal(checkAnswer('Option Z', 'Z', options), true);
  assert.equal(checkAnswer('Y', 'Z', options), false);
});

test('image solutions, proof prompts and blank stems are not auto-graded', () => {
  assert.equal(isGradable({ question: 'Prove that √3 is irrational.', answer: 'assets/maths/answers/2026-set1/q26.png' }), false);
  assert.equal(isGradable({ question: 'Find the result.', answer: 'assets/maths/answers/2026-set1/q27.png' }), false);
  assert.equal(isGradable({ question: 'Show that x = 3.', answer: 'x = 3' }), false);
  assert.equal(isGradable({ question: '', answer: '42' }), false);
  assert.equal(isGradable({ question: 'Assertion and reason', assertion: 'A', reason: 'R', answer: 'A', options: ['A', 'B', 'C', 'D'] }), true);
});

test('option lists beyond the A–Z UI limit are not auto-gradable', () => {
  const options = Array.from({ length: 27 }, (_, i) => 'Option ' + (i + 1));
  assert.equal(isGradable({ answer: 'Option 27', options }), false);
  assert.equal(checkAnswer('Option 27', 'Option 27', options), false);
});

test('MCQs with invalid answer keys are excluded from graded pools', () => {
  assert.equal(isGradable({ question: 'Select the correct option.', answer: 'Z', options: ['one', 'two', 'three', 'four'] }), false);
  assert.equal(checkAnswer('Z', 'Z', ['one', 'two', 'three', 'four']), false);
  assert.equal(isGradable({ question: 'Select the correct option.', answer: 'two', options: ['one', 'two', 'three', 'four'] }), true);
});
