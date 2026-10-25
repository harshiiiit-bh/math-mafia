'use strict';

const OPTION_LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SUPER_SCRIPT = { '⁰': '^0', '¹': '^1', '²': '^2', '³': '^3', '⁴': '^4', '⁵': '^5', '⁶': '^6', '⁷': '^7', '⁸': '^8', '⁹': '^9' };

function normalizeAnswer(value) {
  if (value === null || value === undefined) return '';
  let text = Array.from(String(value), ch => SUPER_SCRIPT[ch] || ch).join('').normalize('NFKC');
  text = text
    .replace(/\\(?:displaystyle|textstyle)\b/g, '')
    .replace(/\\(?:left|right)\b/g, '')
    .replace(/\\(?:times|cdot)\b/g, 'x')
    .replace(/\\div\b/g, '/')
    .replace(/\\pi\b/gi, 'pi')
    .replace(/\\sqrt\s*\{([^{}]+)\}/gi, 'root$1')
    .replace(/\\d?frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/gi, '$1/$2')
    .replace(/[−–—]/g, '-')
    .replace(/[×·⋅]/g, 'x')
    .replace(/÷/g, '/')
    .replace(/√\s*/g, 'root')
    .replace(/π/g, 'pi')
    .replace(/^\s*(?:answer|ans)\s*[:=]\s*/i, '')
    .replace(/(?:₹|rs\.?)\s*/gi, '')
    .replace(/(\d),(?=\d{3}(?:\D|$))/g, '$1')
    .replace(/[{}$\\]/g, '')
    .replace(/\s+/g, '')
    .replace(/[.,;:]$/, '')
    .toLowerCase();

  // Ignore a trailing measurement unit, but never delete letters from ordinary words.
  const withoutUnit = text.replace(/(?:kilometres?|kilometers?|centimetres?|centimeters?|millimetres?|millimeters?|degrees?|deg|cm|mm|km|kg|seconds?|secs?|minutes?|mins?|hours?|hrs?|°)$/i, '');
  if (withoutUnit !== text && /[\d)]$/.test(withoutUnit)) text = withoutUnit;
  return text;
}

function parseSimpleNumber(value) {
  const text = normalizeAnswer(value);
  const match = text.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(?:\/([+-]?(?:\d+(?:\.\d*)?|\.\d+)))?$/);
  if (!match) return null;
  const numerator = Number(match[1]);
  const denominator = match[2] === undefined ? 1 : Number(match[2]);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : null;
}

function acceptedAnswerVariants(correctAnswer) {
  const raw = String(correctAnswer == null ? '' : correctAnswer).trim();
  const variants = new Set();
  const add = value => {
    const normalized = normalizeAnswer(value);
    if (normalized) variants.add(normalized);
  };

  add(raw);
  // Explanations commonly follow a short expected response in parentheses or after a dash.
  add(raw.replace(/\([^()]*\)/g, ' '));
  const prefix = raw.split(/\s+(?:--|—|–)\s+/)[0].trim();
  if (prefix && prefix.length <= 36 && !/[=^]/.test(prefix)) add(prefix);
  return [...variants];
}

function answersEquivalent(userAnswer, correctAnswer) {
  const user = normalizeAnswer(userAnswer);
  if (!user) return false;
  const variants = acceptedAnswerVariants(correctAnswer);
  if (variants.includes(user)) return true;

  // Keep numeric equivalence conservative; never infer correctness from substrings.
  const userNumber = parseSimpleNumber(user);
  if (userNumber === null) return false;
  return variants.some(variant => {
    const correctNumber = parseSimpleNumber(variant);
    return correctNumber !== null &&
      Math.abs(userNumber - correctNumber) <= 1e-9 * Math.max(1, Math.abs(userNumber), Math.abs(correctNumber));
  });
}

function getOptionIndex(answer, options) {
  if (!Array.isArray(options) || !options.length || answer === null || answer === undefined) return -1;
  const raw = String(answer).trim();
  const prefixedLabel = raw.match(/^(?:option|choice)\s+([A-Z])(?:[.):\-]\s*(.*))?$/i);
  if (prefixedLabel) {
    const index = OPTION_LABELS.indexOf(prefixedLabel[1].toUpperCase());
    const remainder = (prefixedLabel[2] || '').trim();
    if (index >= 0 && index < options.length && (!remainder || answersEquivalent(remainder, options[index]) || /^\([^()]*\)$/.test(remainder))) return index;
  }
  const bareLabel = raw.match(/^\(?([A-Z])\)?[.)]?$/i);
  if (bareLabel) {
    const index = OPTION_LABELS.indexOf(bareLabel[1].toUpperCase());
    if (index >= 0 && index < options.length) return index;
  }

  // Also accept answer keys like “B. 12” and “B (the correct option)”.
  const labelled = raw.match(/^\(?([A-Z])\)?(?:[.)]|\s+(?=\())\s*(.*)$/i);
  if (labelled) {
    const index = OPTION_LABELS.indexOf(labelled[1].toUpperCase());
    if (index >= 0 && index < options.length) {
      const remainder = labelled[2].trim();
      if (!remainder || answersEquivalent(remainder, options[index]) || /^\([^()]*\)$/.test(remainder)) return index;
    }
  }

  return options.findIndex(option => answersEquivalent(answer, option));
}

function checkAnswer(userAnswer, correctAnswer, options) {
  if (userAnswer === null || userAnswer === undefined || String(userAnswer).trim() === '') return false;

  if (Array.isArray(options) && options.length) {
    const expectedIndex = getOptionIndex(correctAnswer, options);
    // An invalid answer key must never fall through to plain text comparison.
    if (expectedIndex < 0) return false;
    const submittedIndex = getOptionIndex(userAnswer, options);
    return submittedIndex === expectedIndex;
  }

  // Deliberately require an exact normalized match (or an equivalent simple number).
  // Substring matches caused answers like “112” to be accepted for “12”.
  return answersEquivalent(userAnswer, correctAnswer);
}

function isGradable(exercise) {
  if (!exercise || exercise.answer === null || exercise.answer === undefined) return false;
  const answer = String(exercise.answer).trim();
  if (!answer) return false;

  if (Array.isArray(exercise.options) && exercise.options.length) {
    // A broken answer key should not send an impossible MCQ into a scored test.
    return getOptionIndex(exercise.answer, exercise.options) >= 0;
  }

  const partMarkers = answer.match(/\(\s*(?:i|ii|iii|iv|v|vi|a|b|c|d|\d+)\s*\)/gi) || [];
  if (partMarkers.length >= 2) return false;
  if (answer.length > 70) return false;
  if (/\b(?:proof|prove|show that|hence|justify|justification)\b/i.test(answer) && answer.length > 30) return false;
  return true;
}

module.exports = { normalizeAnswer, parseSimpleNumber, getOptionIndex, checkAnswer, isGradable };
