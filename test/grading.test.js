'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkAnswer, isGradable, normalizeAnswer } = require('../lib/grading');

test('MCQs accept a correct option letter when the key stores the full option text', () => {
  const options = ['2', '4', '6', '8'];
  assert.equal(checkAnswer('B', '4', options), true);
  assert.equal(checkAnswer('B', 'B', options), true);
  assert.equal(checkAnswer('A', '4', options), false);
});

test('MCQs accept a correct option text when the key stores a letter', () => {
  const options = ['Prime number', 'Composite number', 'Neither', 'Both'];
  assert.equal(checkAnswer('Prime number', 'A', options), true);
  assert.equal(checkAnswer('C', 'A', options), false);
});

test('answer matching does not accept misleading partial numeric matches', () => {
  assert.equal(checkAnswer('112', '12'), false);
  assert.equal(checkAnswer('12', '112'), false);
  assert.equal(checkAnswer('0.5', '1/2'), true);
  assert.equal(checkAnswer('22,338', '22338'), true);
});

test('math symbols and common units normalize predictably', () => {
  assert.equal(normalizeAnswer('3 × 2'), '3x2');
  assert.equal(checkAnswer('12 cm', '12'), true);
  assert.equal(checkAnswer('x²', 'x^2'), true);
});

test('empty answers are wrong and valid zero answers remain gradable', () => {
  assert.equal(checkAnswer('', '0'), false);
  assert.equal(checkAnswer('0', 0), true);
  assert.equal(isGradable({ answer: 0 }), true);
});

test('multi-part and proof answers are not sent to one-box auto-grading', () => {
  assert.equal(isGradable({ answer: '(i) 3 (ii) 4' }), false);
  assert.equal(isGradable({ answer: 'Proof: show that the expression is irrational by contradiction.' }), false);
  assert.equal(isGradable({ answer: '22338' }), true);
});

test('MCQs with invalid answer keys are excluded from graded pools', () => {
  assert.equal(isGradable({ answer: 'Z', options: ['one', 'two', 'three', 'four'] }), false);
  assert.equal(isGradable({ answer: 'two', options: ['one', 'two', 'three', 'four'] }), true);
});
