'use strict';
/*
 * Everything in core.js that is not money: number parsing, dates, identifiers, banking, QR payloads,
 * numbering, status, creation and normalisation. Expected values are derived independently here
 * (own reference implementations of mod 97, the IČO check and the CNB account check).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../core.js');

// ------------------------------------------------------------ references

function lettersToDigits(s) {
  let out = '';
  for (const ch of s) out += ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
  return out;
}
/** ISO 13616: check digits for a country code and BBAN. */
function refIbanCheck(cc, bban) {
  const rem = BigInt(lettersToDigits(bban + cc + '00')) % 97n;
  return String(98n - rem).padStart(2, '0');
}
function refIbanValid(iban) {
  const s = iban.replace(/\s/g, '').toUpperCase();
  return BigInt(lettersToDigits(s.slice(4) + s.slice(0, 4))) % 97n === 1n;
}
function refIcoCheck(first7) {
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += Number(first7[i]) * (8 - i);
  const r = sum % 11;
  if (r === 0) return 1;
  if (r === 1) return 0;
  return 11 - r;
}
function refIcoRemainder(first7) {
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += Number(first7[i]) * (8 - i);
  return sum % 11;
}
function refCzOk(prefix, number) {
  const wp = [10, 5, 8, 4, 2, 1];
  const wn = [6, 3, 7, 9, 10, 5, 8, 4, 2, 1];
  const p = prefix.padStart(6, '0');
  const n = number.padStart(10, '0');
  let sp = 0, sn = 0;
  for (let i = 0; i < 6; i++) sp += Number(p[i]) * wp[i];
  for (let i = 0; i < 10; i++) sn += Number(n[i]) * wn[i];
  return sp % 11 === 0 && sn % 11 === 0 && Number(n) !== 0;
}
function refCzIban(prefix, number, bank) {
  const bban = bank + prefix.padStart(6, '0') + number.padStart(10, '0');
  return 'CZ' + refIbanCheck('CZ', bban) + bban;
}
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
function parseSpayd(text) {
  const parts = text.split('*');
  const map = {};
  parts.slice(2).forEach((p) => { const i = p.indexOf(':'); map[p.slice(0, i)] = p.slice(i + 1); });
  return { head: parts[0], version: parts[1], keys: parts.slice(2).map((p) => p.slice(0, p.indexOf(':'))), map, parts };
}

const CZ_IBAN = 'CZ6508000000192000145399';
const SK_IBAN = 'SK3112000000198742637541';
const DE_IBAN = 'DE89370400440532013000';
const GB_IBAN = 'GB82WEST12345698765432';

// ------------------------------------------------------ number parsing

test('normalizeDecimalString: Czech and English notations', () => {
  const t = core.normalizeDecimalString;
  assert.equal(t('1 210,50'), '1210.50');
  assert.equal(t('1,210.50'), '1210.50');
  assert.equal(t('1.210,50'), '1210.50');
  assert.equal(t('1210.5'), '1210.5');
  assert.equal(t('1210,5'), '1210.5');
  assert.equal(t('1 234 567,89'), '1234567.89');
  assert.equal(t('1,234,567.89'), '1234567.89');
  assert.equal(t('1.234.567,89'), '1234567.89');
  assert.equal(t("1'234'567.89"), '1234567.89');
  assert.equal(t('1,234,567'), '1234567');
  assert.equal(t('1.234.567'), '1234567');
  assert.equal(t('1 234,5'), '1234.5');
  assert.equal(t('1 234,5'), '1234.5');
  assert.equal(t('  42  '), '42');
  assert.equal(t(42), '42');
  assert.equal(t(12.5), '12.5');
});

test('normalizeDecimalString: a single separator is read as the decimal mark', () => {
  const t = core.normalizeDecimalString;
  assert.equal(t('1,5'), '1.5');
  assert.equal(t('1.5'), '1.5');
  assert.equal(t('1,234'), '1.234');
  assert.equal(t('1.234'), '1.234');
  assert.equal(t(',5'), '.5');
  assert.equal(t('.5'), '.5');
  assert.equal(t('5,'), '5.');
});

test('normalizeDecimalString: minus signs', () => {
  const t = core.normalizeDecimalString;
  assert.equal(t('-3'), '-3');
  assert.equal(t('−3'), '-3');
  assert.equal(t('–3,5'), '-3.5');
  assert.equal(t('-1 210,50'), '-1210.50');
  assert.equal(t('-.5'), '-.5');
  assert.equal(t('--3'), '');
  assert.equal(t('3-'), '');
  assert.equal(t('1-2'), '');
  assert.equal(t('-'), '');
});

test('normalizeDecimalString: garbage and exponents are not numbers', () => {
  const t = core.normalizeDecimalString;
  for (const bad of ['', '   ', null, undefined, 'abc', '12abc', '1e3', '1E-3', '+5', '.', ',', '1.2,3.4', '0x10', 'NaN', 'Infinity', '--', '€5', '5 Kč']) {
    assert.equal(t(bad), '', 'input ' + JSON.stringify(bad));
  }
  assert.equal(t({}), '');
  assert.equal(t(true), '');
});

test('normalizeDecimalString: repeated separators are thousands marks only when every group has 3 digits', () => {
  const t = core.normalizeDecimalString;
  for (const bad of ['1..2', '1,,2', '1.2.3', '1,2,3', '12.34.56', '1.2345.678', '1,23,456']) assert.equal(t(bad), '', bad);
  assert.equal(t('1.234.567'), '1234567');
  assert.equal(t('1,234,567'), '1234567');
});

test('parseNumber: numbers, strings and garbage', () => {
  const p = core.parseNumber;
  assert.equal(p('1 210,50'), 1210.5);
  assert.equal(p('1,210.50'), 1210.5);
  assert.equal(p('−2,5'), -2.5);
  assert.equal(p(7), 7);
  assert.equal(p(-0.25), -0.25);
  assert.equal(p('0'), 0);
  assert.equal(p('5,'), 5);
  for (const bad of ['', null, undefined, 'abc', '1e5', 'Infinity', true, {}]) {
    assert.ok(Number.isNaN(p(bad)), 'input ' + JSON.stringify(bad));
  }
  assert.ok(Number.isNaN(p(NaN)));
});

test('decToInt: scaling and rounding at the cut (half away from zero, read from decimal digits)', () => {
  const d = core.decToInt;
  assert.equal(d('1210,50', 2), 121050);
  assert.equal(d('1 210.5', 2), 121050);
  assert.equal(d('3', 4), 30000);
  assert.equal(d('0,125', 2), 13);
  assert.equal(d('0,124999', 2), 12);
  assert.equal(d('-0,125', 2), -13);
  assert.equal(d('-0,124', 2), -12);
  assert.equal(d('0,995', 2), 100);
  assert.equal(d('9,995', 2), 1000);
  assert.equal(d('2,5', 0), 3);
  assert.equal(d('-2,5', 0), -3);
  assert.equal(d('2,4', 0), 2);
  assert.equal(d('.5', 0), 1);
  assert.equal(d('-.5', 0), -1);
  assert.equal(d('5.', 2), 500);
  assert.equal(d('0.00005', 4), 1);
  assert.equal(d('0.00004', 4), 0);
  assert.equal(d('12.34567', 4), 123457);
  assert.equal(d('007', 2), 700);
});

test('decToInt: JS numbers are rounded by their shortest decimal text, not by binary error', () => {
  const d = core.decToInt;
  assert.equal(d(1.005, 2), 101);
  assert.equal(d(0.285, 2), 29);
  assert.equal(d(1.45, 1), 15);
  assert.equal(d(-1.005, 2), -101);
  assert.equal(d(12.345, 2), 1235);
  assert.equal(d(8.325, 2), 833);
  assert.equal(d(0.1 + 0.2, 2), 30);
  assert.equal(d(5e-5, 4), 1);
  assert.equal(d(1e-7, 4), 0);
  assert.equal(d(100, 2), 10000);
  assert.equal(d(0, 2), 0);
});

test('decToInt: garbage becomes 0', () => {
  const d = core.decToInt;
  for (const bad of ['', null, undefined, 'abc', '1e3', NaN, Infinity, -Infinity, '.', '-', {}, [], true]) {
    assert.equal(d(bad, 2), 0, 'input ' + String(bad));
  }
});

test('decToInt: never returns negative zero', () => {
  assert.ok(Object.is(core.decToInt('-0', 2), 0), "'-0'");
  assert.ok(Object.is(core.decToInt('-0,001', 2), 0), "'-0,001'");
  assert.ok(Object.is(core.decToInt('-0.4', 0), 0), "'-0.4' at 0 digits");
  assert.ok(Object.is(core.decToInt(-0, 2), 0), '-0');
  assert.ok(Object.is(core.decToInt(-0.001, 2), 0), '-0.001');
});

// ------------------------------------------------------ mulDiv, roundToStep

test('mulDiv: half away from zero on integers', () => {
  const m = core.mulDiv;
  assert.equal(m(1, 1, 2), 1);
  assert.equal(m(-1, 1, 2), -1);
  assert.equal(m(1, 1, 3), 0);
  assert.equal(m(2, 1, 3), 1);
  assert.equal(m(-2, 1, 3), -1);
  assert.equal(m(5, 1, 10), 1);
  assert.equal(m(4, 1, 10), 0);
  assert.equal(m(-5, 1, 10), -1);
  assert.equal(m(-4, 1, 10), 0);
  assert.equal(m(3, 7, 2), 11);
  assert.equal(m(-3, 7, 2), -11);
  assert.equal(m(1, 1, -2), -1);
  assert.equal(m(-1, 1, -2), 1);
  assert.equal(m(0, 5, 3), 0);
  assert.equal(m(7, 0, 3), 0);
});

test('mulDiv: zero divisor gives 0, products past 2^53 stay exact', () => {
  assert.equal(core.mulDiv(5, 5, 0), 0);
  assert.equal(core.mulDiv(123456789012, 1000000, 1000), 123456789012000);
  assert.equal(core.mulDiv(2 ** 40, 2 ** 40, 2 ** 40), 2 ** 40);
  assert.equal(core.mulDiv(99999999999, 9999, 10000), 99989999999);
});

test('mulDiv: truncates fractional inputs and survives NaN and Infinity', () => {
  assert.equal(core.mulDiv(1.9, 1, 1), 1);
  assert.equal(core.mulDiv(-1.9, 1, 1), -1);
  assert.doesNotThrow(() => core.mulDiv(NaN, 1, 1), 'NaN input');
  assert.doesNotThrow(() => core.mulDiv(1, 1, NaN), 'NaN divisor');
  assert.doesNotThrow(() => core.mulDiv(Infinity, 1, 1), 'Infinity input');
  assert.doesNotThrow(() => core.roundToStep(NaN, 10), 'roundToStep NaN');
});

test('roundToStep: rounds to the step, half away from zero', () => {
  const r = core.roundToStep;
  assert.equal(r(1234, 10), 1230);
  assert.equal(r(1235, 10), 1240);
  assert.equal(r(-1234, 10), -1230);
  assert.equal(r(-1235, 10), -1240);
  assert.equal(r(1224, 50), 1200);
  assert.equal(r(1225, 50), 1250);
  assert.equal(r(1275, 50), 1300);
  assert.equal(r(149, 100), 100);
  assert.equal(r(150, 100), 200);
  assert.equal(r(-50, 100), -100);
  assert.equal(r(-49, 100), 0);
  assert.equal(r(1234, 0), 1234);
  assert.equal(r(1234, undefined), 1234);
  assert.equal(r(0, 100), 0);
});

// ------------------------------------------------------------- dates

test('isIsoDate', () => {
  for (const ok of ['2026-02-28', '2024-02-29', '2000-02-29', '2026-12-31', '2026-01-01', '1999-12-31']) assert.equal(core.isIsoDate(ok), true, ok);
  for (const bad of ['2026-02-29', '2100-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '2026-01-32', '2026-1-1', '26-01-01',
    '2026-01-01T00:00:00Z', ' 2026-01-01', '2026-01-01 ', '2026/01/01', '', 'abcd-ef-gh', '2026-01-00']) {
    assert.equal(core.isIsoDate(bad), false, JSON.stringify(bad));
  }
  for (const nonString of [null, undefined, 20260101, {}, [], new Date(), true]) assert.equal(core.isIsoDate(nonString), false);
});

test('addDays: month ends, leap years, negative and zero', () => {
  const a = core.addDays;
  assert.equal(a('2026-01-31', 1), '2026-02-01');
  assert.equal(a('2026-02-28', 1), '2026-03-01');
  assert.equal(a('2024-02-28', 1), '2024-02-29');
  assert.equal(a('2024-02-28', 2), '2024-03-01');
  assert.equal(a('2100-02-28', 1), '2100-03-01');
  assert.equal(a('2000-02-28', 1), '2000-02-29');
  assert.equal(a('2026-12-31', 1), '2027-01-01');
  assert.equal(a('2026-01-01', -1), '2025-12-31');
  assert.equal(a('2026-03-01', -1), '2026-02-28');
  assert.equal(a('2024-03-01', -1), '2024-02-29');
  assert.equal(a('2026-11-17', 0), '2026-11-17');
  assert.equal(a('2026-01-31', 30), '2026-03-02');
  assert.equal(a('2026-01-01', 365), '2027-01-01');
  assert.equal(a('2024-01-01', 366), '2025-01-01');
  assert.equal(a('2026-01-01', '14'), '2026-01-15');
  assert.equal(a('2026-01-01', 1.4), '2026-01-02');
  assert.equal(a('2026-01-01', NaN), '2026-01-01');
  assert.equal(a('2026-01-01', undefined), '2026-01-01');
  assert.equal(a('2026-01-01', 'abc'), '2026-01-01');
});

test('addDays: crosses the European DST changes without drifting', () => {
  assert.equal(core.addDays('2026-03-28', 1), '2026-03-29');
  assert.equal(core.addDays('2026-03-29', 1), '2026-03-30');
  assert.equal(core.addDays('2026-10-24', 2), '2026-10-26');
  assert.equal(core.addDays('2026-10-25', 1), '2026-10-26');
  assert.equal(core.addDays('2026-03-01', 61), '2026-05-01');
});

test('addDays: bad dates give an empty string, huge offsets do not throw', () => {
  assert.equal(core.addDays('2026-02-30', 1), '');
  assert.equal(core.addDays('', 1), '');
  assert.equal(core.addDays(null, 1), '');
  assert.equal(core.addDays('2026-1-1', 1), '');
  assert.doesNotThrow(() => core.addDays('2026-01-01', 1e9), '1e9 days');
  assert.doesNotThrow(() => core.addDays('2026-01-01', Infinity), 'Infinity days');
  assert.equal(core.addDays('2026-01-01', 1e9), '');
  assert.equal(core.addDays('2026-01-01', Infinity), '');
});

test('daysBetween: signed, leap-aware, NaN on bad dates', () => {
  const b = core.daysBetween;
  assert.equal(b('2026-01-01', '2026-01-01'), 0);
  assert.equal(b('2026-01-01', '2026-01-31'), 30);
  assert.equal(b('2026-01-31', '2026-01-01'), -30);
  assert.equal(b('2024-02-28', '2024-03-01'), 2);
  assert.equal(b('2026-02-28', '2026-03-01'), 1);
  assert.equal(b('2026-01-01', '2027-01-01'), 365);
  assert.equal(b('2024-01-01', '2025-01-01'), 366);
  assert.equal(b('2026-03-28', '2026-03-30'), 2);
  assert.equal(b('2026-10-24', '2026-10-26'), 2);
  assert.ok(Number.isNaN(b('2026-02-30', '2026-03-01')));
  assert.ok(Number.isNaN(b('2026-01-01', '')));
  assert.ok(Number.isNaN(b(null, '2026-01-01')));
  for (const [from, n] of [['2024-02-29', 400], ['2026-05-31', -123], ['1999-12-31', 1]]) {
    assert.equal(b(from, core.addDays(from, n)), n, from + ' ' + n);
  }
});

test('localToday uses the local calendar day, zero padded', () => {
  assert.equal(core.localToday(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  assert.equal(core.localToday(new Date(2026, 11, 31, 0, 0)), '2026-12-31');
  assert.ok(core.isIsoDate(core.localToday()));
});

test('formatDate: each token', () => {
  const f = core.formatDate;
  assert.equal(f('2026-03-07'), '07. 03. 2026');
  assert.equal(f('2026-03-07', { date: 'D. M. YYYY' }), '7. 3. 2026');
  assert.equal(f('2026-03-07', { date: 'DD/MM/YYYY' }), '07/03/2026');
  assert.equal(f('2026-03-07', { date: 'YYYY-MM-DD' }), '2026-03-07');
  assert.equal(f('2026-12-25', { date: 'D.M.YYYY' }), '25.12.2026');
  assert.equal(f('2026-03-07', { date: 'DDMMYYYY' }), '07032026');
  assert.equal(f('2026-03-07', { date: 'D MMM YYYY', months: ['led', 'úno', 'bře'] }), '7 bře 2026');
  assert.equal(f('2026-03-07', { date: 'D MMM YYYY' }), '7 03 2026', 'MMM without a months list falls back to MM');
  assert.equal(f('2026-04-07', { date: 'D MMM YYYY', months: ['led', 'úno', 'bře'] }), '7 04 2026', 'missing month name falls back to MM');
  assert.equal(f('2026-03-07', { date: 'MMM D, YYYY', months: ['Jan', 'Feb', 'Mar'] }), 'Mar 7, 2026');
  assert.equal(f('2026-03-07', { date: 'YYYY' }), '2026');
  assert.equal(f('2024-02-29', null), '29. 02. 2024');
  assert.equal(f('2026-03-07', {}), '07. 03. 2026');
  assert.equal(f('2026-03-07', { date: null }), '07. 03. 2026');
});

test('formatDate: invalid input gives an empty string', () => {
  for (const bad of ['', null, undefined, '2026-02-30', '7.3.2026', 20260307]) assert.equal(core.formatDate(bad), '', String(bad));
});

// -------------------------------------------------------------- IČO

test('validateIco: real company numbers', () => {
  for (const ico of ['27082440', '00006947', '45274649', '25596641', '00064581']) {
    assert.equal(core.validateIco(ico), refIcoCheck(ico.slice(0, 7)) === Number(ico[7]), ico + ' vs reference');
  }
  assert.equal(core.validateIco('27082440'), true);
  assert.equal(core.validateIco('00006947'), true);
  assert.equal(core.validateIco('27082441'), false);
});

test('validateIco: the edge remainders 0, 1 and 10 follow the published rule', () => {
  const seen = { 0: null, 1: null, 10: null };
  for (let n = 0; n < 2000000 && (seen[0] === null || seen[1] === null || seen[10] === null); n += 13) {
    const base = String(n).padStart(7, '0');
    const r = refIcoRemainder(base);
    if (r in seen && seen[r] === null) seen[r] = base;
  }
  assert.ok(seen[0] && seen[1] && seen[10], 'found a base for each edge remainder');
  // remainder 0 -> check digit 1, remainder 1 -> check digit 0, remainder 10 -> check digit 1
  assert.equal(core.validateIco(seen[0] + '1'), true, 'remainder 0');
  assert.equal(core.validateIco(seen[0] + '0'), false, 'remainder 0, wrong digit 0');
  assert.equal(core.validateIco(seen[1] + '0'), true, 'remainder 1');
  assert.equal(core.validateIco(seen[1] + '1'), false, 'remainder 1, wrong digit 1');
  assert.equal(core.validateIco(seen[10] + '1'), true, 'remainder 10');
  assert.equal(core.validateIco(seen[10] + '0'), false, 'remainder 10, wrong digit 0');
});

test('validateIco: sweep against the reference, every wrong check digit is rejected', () => {
  const rnd = lcg(42);
  for (let i = 0; i < 400; i++) {
    const base = String(Math.floor(rnd() * 1e7)).padStart(7, '0');
    const good = refIcoCheck(base);
    for (let c = 0; c <= 9; c++) assert.equal(core.validateIco(base + c), c === good, base + c);
  }
});

test('validateIco: formats', () => {
  assert.equal(core.validateIco('270 824 40'), true);
  assert.equal(core.validateIco(' 27082440 '), true);
  assert.equal(core.validateIco(27082440), true);
  assert.equal(core.validateIco(6947), true, 'short numbers are zero padded');
  assert.equal(core.validateIco('6947'), true);
  for (const bad of ['', null, undefined, '2708244', '270824401', 'ABCDEFGH', '2708244a', '-27082440', '27082.40', '27-082-440', {}]) {
    assert.equal(core.validateIco(bad), bad === '2708244' ? core.validateIco('02708244') : false, JSON.stringify(bad));
  }
});

// ----------------------------------------------------- Czech accounts

test('parseCzAccount', () => {
  const p = core.parseCzAccount;
  assert.deepEqual(p('19-2000145399/0800'), { prefix: '19', number: '2000145399', bank: '0800' });
  assert.deepEqual(p('2000145399/0800'), { prefix: '', number: '2000145399', bank: '0800' });
  assert.deepEqual(p('000019-2000145399/0800'), { prefix: '000019', number: '2000145399', bank: '0800' });
  assert.deepEqual(p(' 19 - 2000145399 / 0800 '), { prefix: '19', number: '2000145399', bank: '0800' });
  assert.deepEqual(p('19 - 2000145399/0800'), { prefix: '19', number: '2000145399', bank: '0800' });
  assert.deepEqual(p('1/0100'), { prefix: '', number: '1', bank: '0100' });
  for (const bad of ['', null, undefined, '2000145399', '2000145399/800', '2000145399/08000', '1234567-2000145399/0800',
    '19-20001453991/0800', '19-/0800', '/0800', 'abc/0800', '19-2000145399-0800', '19-2000145399/08a0', '19--2000145399/0800']) {
    assert.equal(p(bad), null, JSON.stringify(bad));
  }
});

test('validateCzAccount: the CNB weights', () => {
  assert.equal(core.validateCzAccount('19-2000145399/0800'), true);
  assert.equal(core.validateCzAccount('2000145399/0800'), true);
  assert.equal(core.validateCzAccount('19-2000145398/0800'), false);
  assert.equal(core.validateCzAccount('20-2000145399/0800'), false);
  assert.equal(core.validateCzAccount('2000145390/0800'), false);
  assert.equal(core.validateCzAccount('0/0800'), false);
  assert.equal(core.validateCzAccount('0000000000/0800'), false);
  assert.equal(core.validateCzAccount('abc'), false);
  assert.equal(core.validateCzAccount(''), false);
  assert.equal(core.validateCzAccount(null), false);
});

test('validateCzAccount: sweep against the reference (prefixes of every length)', () => {
  const rnd = lcg(7);
  let positives = 0;
  for (let i = 0; i < 6000; i++) {
    const plen = Math.floor(rnd() * 7);
    const nlen = 1 + Math.floor(rnd() * 10);
    const prefix = plen ? String(Math.floor(rnd() * Math.pow(10, plen))).padStart(plen, '0') : '';
    const number = String(Math.floor(rnd() * Math.pow(10, nlen))).padStart(nlen, '0');
    const text = (prefix ? prefix + '-' : '') + number + '/0800';
    const expected = refCzOk(prefix, number);
    if (expected) positives++;
    assert.equal(core.validateCzAccount(text), expected, text);
  }
  assert.ok(positives > 5, 'the sweep hit some valid accounts (' + positives + ')');
});

test('czAccountToIban: against an independent ISO 13616 mod 97', () => {
  assert.equal(core.czAccountToIban('19-2000145399/0800'), 'CZ6508000000192000145399');
  assert.equal(core.czAccountToIban('2000145399/0800'), refCzIban('', '2000145399', '0800'));
  assert.equal(core.czAccountToIban('1/0100'), refCzIban('', '1', '0100'));
  assert.equal(core.czAccountToIban('000019-2000145399/0800'), 'CZ6508000000192000145399');
  assert.equal(core.czAccountToIban('123456-1234567890/2010'), refCzIban('123456', '1234567890', '2010'));
  assert.equal(core.czAccountToIban('abc'), '');
  assert.equal(core.czAccountToIban(''), '');
  assert.equal(core.czAccountToIban(null), '');
});

test('czAccountToIban: sweep, always 24 characters, always a valid IBAN, check digits padded', () => {
  const rnd = lcg(99);
  const banks = ['0100', '0300', '0600', '0710', '0800', '2010', '2700', '3030', '5500', '6210'];
  let smallCheck = 0;
  for (let i = 0; i < 3000; i++) {
    const plen = Math.floor(rnd() * 7);
    const nlen = 1 + Math.floor(rnd() * 10);
    const prefix = plen ? String(Math.floor(rnd() * Math.pow(10, plen))).padStart(plen, '0') : '';
    const number = String(Math.floor(rnd() * Math.pow(10, nlen))).padStart(nlen, '0');
    const bank = banks[Math.floor(rnd() * banks.length)];
    const text = (prefix ? prefix + '-' : '') + number + '/' + bank;
    const iban = core.czAccountToIban(text);
    assert.equal(iban, refCzIban(prefix, number, bank), text);
    assert.equal(iban.length, 24, text);
    assert.equal(refIbanValid(iban), true, text);
    assert.equal(core.validateIban(iban), true, text);
    if (iban.slice(2, 4) < '10') smallCheck++;
  }
  assert.ok(smallCheck > 0, 'saw a check number below 10, so the zero padding was exercised');
});

// ------------------------------------------------------------- IBAN

test('validateIban: valid examples for CZ, SK, DE, GB', () => {
  for (const iban of [CZ_IBAN, SK_IBAN, DE_IBAN, GB_IBAN]) {
    assert.equal(refIbanValid(iban), true, 'reference ' + iban);
    assert.equal(core.validateIban(iban), true, iban);
  }
  assert.equal(core.validateIban('CZ65 0800 0000 1920 0014 5399'), true);
  assert.equal(core.validateIban('cz6508000000192000145399'), true);
  assert.equal(core.validateIban('CZ65-0800-0000-1920-0014-5399'), true);
  assert.equal(core.validateIban('  GB82 WEST 1234 5698 7654 32  '), true);
  assert.equal(core.validateIban('CZ65 0800 0000 1920 0014 5399'), true);
});

test('validateIban: broken ones', () => {
  const bad = [
    'CZ6608000000192000145399', // wrong check digits
    'CZ6508000000192000145398', // last digit changed
    'CZ6508000000912000145399', // two digits swapped
    'CZ650800000019200014539', // one short
    'CZ65080000001920001453999', // one long
    'SK3112000000198742637540',
    'SK311200000019874263754', // SK too short
    'DE89370400440532013001',
    'GB82WEST12345698765431',
    'GB82WEST1234569876543', // short
    '', null, undefined, 'CZ', '1234', 'XX', 'CZ65', '6508000000192000145399', '65CZ08000000192000145399', 'CZ6A08000000192000145399',
    'CZ65.0800.0000.1920.0014.5399', 'CZ65_0800_0000_1920_0014_5399', {}
  ];
  for (const b of bad) assert.equal(core.validateIban(b), false, JSON.stringify(b));
});

test('validateIban: a Czech or Slovak IBAN of the wrong length is rejected even when its mod 97 is right', () => {
  for (const [cc, len] of [['CZ', 23], ['CZ', 25], ['SK', 22], ['SK', 26]]) {
    const bban = '0800000019200014539912345'.slice(0, len - 4).padEnd(len - 4, '0');
    const iban = cc + refIbanCheck(cc, bban) + bban;
    assert.equal(refIbanValid(iban), true);
    assert.equal(core.validateIban(iban), false, cc + len);
  }
});

test('validateIban: country lengths of the registry are enforced (DE 22, GB 22)', () => {
  // mod 97 is right, the length is not what Germany or Great Britain use
  const mk = (cc, bban) => cc + refIbanCheck(cc, bban) + bban;
  const de21 = mk('DE', '37040044053201300'); // 21 characters
  const de23 = mk('DE', '3704004405320130001'); // 23 characters
  const gb21 = mk('GB', 'WEST1234569876543'); // 21 characters
  const gb23 = mk('GB', 'WEST123456987654321'); // 23 characters
  for (const iban of [de21, gb21, de23, gb23]) {
    assert.equal(refIbanValid(iban), true, iban);
    assert.equal(core.validateIban(iban), false, iban + ' has the wrong length for its country');
  }
});

test('formatIban', () => {
  assert.equal(core.formatIban(CZ_IBAN), 'CZ65 0800 0000 1920 0014 5399');
  assert.equal(core.formatIban(GB_IBAN), 'GB82 WEST 1234 5698 7654 32');
  assert.equal(core.formatIban('cz65 0800 0000 1920 0014 5399'), 'CZ65 0800 0000 1920 0014 5399');
  assert.equal(core.formatIban('CZ65'), 'CZ65');
  assert.equal(core.formatIban('CZ650'), 'CZ65 0');
  assert.equal(core.formatIban(''), '');
  assert.equal(core.formatIban(null), '');
  assert.equal(core.formatIban(CZ_IBAN).endsWith(' '), false);
});

test('resolveIban: typed IBAN first, then one derived from a Czech account', () => {
  assert.equal(core.resolveIban({ iban: GB_IBAN, account: '19-2000145399/0800' }), GB_IBAN);
  assert.equal(core.resolveIban({ iban: 'gb82 west 1234 5698 7654 32' }), GB_IBAN);
  assert.equal(core.resolveIban({ iban: '', account: '19-2000145399/0800' }), CZ_IBAN);
  assert.equal(core.resolveIban({ account: '19-2000145399/0800' }), CZ_IBAN);
  assert.equal(core.resolveIban({ iban: 'CZ00 1234', account: '19-2000145399/0800' }), CZ_IBAN, 'invalid typed IBAN falls back');
  assert.equal(core.resolveIban({ iban: 'CZ00 1234', account: '' }), '');
  assert.equal(core.resolveIban({ iban: '', account: 'not an account' }), '');
  assert.equal(core.resolveIban({}), '');
  assert.equal(core.resolveIban(null), '');
  assert.equal(core.resolveIban(undefined), '');
});

test('resolveIban: an account number that fails the CNB check does not become a payable IBAN', () => {
  assert.equal(core.validateCzAccount('19-2000145398/0800'), false);
  assert.equal(core.resolveIban({ account: '19-2000145398/0800' }), '', 'a typo in the account would put a QR code on the invoice that pays a stranger');
});

// ------------------------------------------------------------- SPAYD

const SP = { iban: CZ_IBAN, amountCents: 123450, currency: 'CZK', variableSymbol: '20260001', dueDate: '2026-12-01', message: 'Faktura 20260001', recipient: 'Jan Novák' };

test('spayd: a full payload', () => {
  const s = core.spayd(SP);
  const p = parseSpayd(s);
  assert.equal(p.head, 'SPD');
  assert.equal(p.version, '1.0');
  assert.equal(p.map.ACC, CZ_IBAN);
  assert.equal(p.map.AM, '1234.50');
  assert.equal(p.map.CC, 'CZK');
  assert.equal(p.map['X-VS'], '20260001');
  assert.equal(p.map.DT, '20261201');
  assert.equal(p.map.MSG, 'FAKTURA 20260001');
  assert.equal(p.map.RN, 'JAN NOVAK');
  assert.ok(s.startsWith('SPD*1.0*ACC:' + CZ_IBAN + '*'), 'ACC is the first field');
  assert.equal(new Set(p.keys).size, p.keys.length, 'no field twice');
  assert.ok(/^[\x20-\x7e]+$/.test(s), 'ASCII only');
});

test('spayd: fields follow the order the standard asks for (alphabetical keys, ACC first)', () => {
  const s = core.spayd(Object.assign({}, SP, { constantSymbol: '308', specificSymbol: '77' }));
  const keys = parseSpayd(s).keys;
  assert.deepEqual(keys, ['ACC', 'AM', 'CC', 'DT', 'MSG', 'RN', 'X-KS', 'X-SS', 'X-VS']);
});

test('spayd: AM has two decimals and a dot', () => {
  const am = (c) => parseSpayd(core.spayd({ iban: CZ_IBAN, amountCents: c })).map.AM;
  assert.equal(am(5), '0.05');
  assert.equal(am(100), '1.00');
  assert.equal(am(100000), '1000.00');
  assert.equal(am(123456), '1234.56');
  assert.equal(am(1), '0.01');
  assert.equal(am(100000000), '1000000.00', 'no thousands separator');
  assert.equal(am(999999999), '9999999.99');
});

test('spayd: no AM when there is no positive amount', () => {
  for (const c of [0, -5, NaN, undefined, null, 'abc']) {
    const s = core.spayd({ iban: CZ_IBAN, amountCents: c });
    assert.ok(s.startsWith('SPD*1.0*ACC:'), String(c));
    assert.equal('AM' in parseSpayd(s).map, false, String(c));
  }
});

test('spayd: AM never exceeds the 10 characters the standard allows', () => {
  const s = core.spayd({ iban: CZ_IBAN, amountCents: 1000000000 }); // 10 000 000.00
  if (s) assert.ok(!('AM' in parseSpayd(s).map) || parseSpayd(s).map.AM.length <= 10, 'AM ' + (s && parseSpayd(s).map.AM));
  const big = core.spayd({ iban: CZ_IBAN, amountCents: 99999999999 });
  if (big) assert.ok(!('AM' in parseSpayd(big).map) || parseSpayd(big).map.AM.length <= 10, 'AM ' + (big && parseSpayd(big).map.AM));
  assert.equal(parseSpayd(core.spayd({ iban: CZ_IBAN, amountCents: 999999999 })).map.AM.length, 10);
});

test('spayd: currency is upper case, and omitted when not given', () => {
  assert.equal(parseSpayd(core.spayd({ iban: CZ_IBAN, amountCents: 100, currency: 'eur' })).map.CC, 'EUR');
  assert.equal('CC' in parseSpayd(core.spayd({ iban: CZ_IBAN, amountCents: 100 })).map, false);
});

test('spayd: VS, KS and SS carry digits only and at most 10', () => {
  const p = parseSpayd(core.spayd({ iban: CZ_IBAN, variableSymbol: 'FV-2026/0001', constantSymbol: ' 0308 ', specificSymbol: 'SS 99' }));
  assert.equal(p.map['X-VS'], '20260001');
  assert.equal(p.map['X-KS'], '0308');
  assert.equal(p.map['X-SS'], '99');
  const long = parseSpayd(core.spayd({ iban: CZ_IBAN, variableSymbol: '123456789012', constantSymbol: '12345678901', specificSymbol: '9876543210987' }));
  assert.equal(long.map['X-VS'].length, 10);
  assert.equal(long.map['X-KS'].length, 10);
  assert.equal(long.map['X-SS'].length, 10);
  const lead = parseSpayd(core.spayd({ iban: CZ_IBAN, variableSymbol: '0001' }));
  assert.equal(lead.map['X-VS'], '0001', 'leading zeros stay');
  const none = parseSpayd(core.spayd({ iban: CZ_IBAN, variableSymbol: 'abc', constantSymbol: '', specificSymbol: null }));
  assert.equal('X-VS' in none.map || 'X-KS' in none.map || 'X-SS' in none.map, false);
  const num = parseSpayd(core.spayd({ iban: CZ_IBAN, variableSymbol: 20260001 }));
  assert.equal(num.map['X-VS'], '20260001');
});

test('spayd: DT is YYYYMMDD and only for a real date', () => {
  assert.equal(parseSpayd(core.spayd({ iban: CZ_IBAN, dueDate: '2026-03-07' })).map.DT, '20260307');
  for (const bad of ['2026-02-30', '7.3.2026', '', null, undefined, '20260307', '2026-3-7']) {
    assert.equal('DT' in parseSpayd(core.spayd({ iban: CZ_IBAN, dueDate: bad })).map, false, String(bad));
  }
});

test('spayd: MSG is upper-cased ASCII, at most 60, and has no asterisk', () => {
  const msg = (m) => parseSpayd(core.spayd({ iban: CZ_IBAN, message: m })).map.MSG;
  assert.equal(msg('Faktura č. 5'), 'FAKTURA C. 5');
  assert.equal(msg('Příliš žluťoučký kůň'), 'PRILIS ZLUTOUCKY KUN');
  assert.equal(msg('a*b**c'), 'A B C');
  assert.equal(msg('  many   spaces  '), 'MANY SPACES');
  assert.equal(msg('line\nbreak\ttab'), 'LINE BREAK TAB');
  assert.equal(msg('A&B <tag> "q"'), 'A B TAG Q');
  assert.equal(msg('FV-2026-015'), 'FV-2026-015');
  assert.equal(msg('a'.repeat(100)).length, 60);
  assert.equal(msg(''), undefined);
  assert.equal(msg(null), undefined);
  assert.equal(msg('***'), undefined);
  assert.equal(msg('日本語'), undefined, 'nothing encodable is left, so the field is omitted');
  const s = core.spayd({ iban: CZ_IBAN, message: 'x*y', recipient: 'a*b' });
  assert.equal(s.split('*').length, 5, 'only the separators are asterisks: SPD, 1.0, ACC, MSG, RN');
});

test('spayd: a truncated MSG or RN never ends with a space', () => {
  const m = parseSpayd(core.spayd({ iban: CZ_IBAN, message: 'A'.repeat(59) + ' BCD' })).map.MSG;
  assert.equal(m, 'A'.repeat(59), 'MSG ' + JSON.stringify(m));
  const r = parseSpayd(core.spayd({ iban: CZ_IBAN, recipient: 'A'.repeat(34) + ' BCD' })).map.RN;
  assert.equal(r, 'A'.repeat(34), 'RN ' + JSON.stringify(r));
});

test('spayd: a percent sign is not sent raw (it is the escape character of the format)', () => {
  const m = parseSpayd(core.spayd({ iban: CZ_IBAN, message: 'Sleva 10%AB' })).map.MSG;
  assert.ok(m === undefined || !/%(?![0-9A-F]{2})/.test(m) || m.indexOf('%25') !== -1, 'MSG ' + m);
  assert.equal(/%AB/.test(m || ''), false, 'raw %AB would be decoded as a byte by a reader: ' + m);
});

test('spayd: RN is at most 35 characters and has no diacritics', () => {
  const rn = (n) => parseSpayd(core.spayd({ iban: CZ_IBAN, recipient: n })).map.RN;
  assert.equal(rn('Novák & Synové s.r.o.'), 'NOVAK SYNOVE S.R.O.');
  assert.equal(rn('x'.repeat(80)).length, 35);
  assert.equal(rn(''), undefined);
});

test('spayd: empty when the IBAN is not valid', () => {
  for (const iban of ['', null, undefined, 'CZ6608000000192000145399', 'garbage', '19-2000145399/0800']) {
    assert.equal(core.spayd({ iban, amountCents: 100 }), '', String(iban));
  }
});

test('spayd: the IBAN is normalised and a foreign IBAN passes through', () => {
  assert.equal(parseSpayd(core.spayd({ iban: 'cz65 0800 0000 1920 0014 5399' })).map.ACC, CZ_IBAN);
  assert.equal(parseSpayd(core.spayd({ iban: DE_IBAN })).map.ACC, DE_IBAN);
});

// --------------------------------------------------------------- EPC

const EP = { iban: DE_IBAN, bic: 'COBADEFFXXX', amountCents: 123450, recipient: 'Max Müller GmbH', message: 'Invoice 20260001' };

test('epcQr: 11 lines in the EPC069-12 order', () => {
  const t = core.epcQr(EP);
  const lines = t.split('\n');
  assert.equal(lines.length, 11);
  assert.equal(lines[0], 'BCD');
  assert.equal(lines[1], '002');
  assert.equal(lines[2], '1');
  assert.equal(lines[3], 'SCT');
  assert.equal(lines[4], 'COBADEFFXXX');
  assert.equal(lines[5], 'Max Muller GmbH');
  assert.equal(lines[6], DE_IBAN);
  assert.equal(lines[7], 'EUR1234.50');
  assert.equal(lines[8], '', 'purpose');
  assert.equal(lines[9], '', 'structured reference');
  assert.equal(lines[10], 'Invoice 20260001');
  assert.ok(!t.includes('\r'));
  assert.ok(lines.every((l) => l === l.trim()), 'no line has leading or trailing spaces');
  assert.ok(Buffer.byteLength(t, 'utf8') <= 331, 'fits the 331 byte limit');
});

test('epcQr: the BIC line may be empty and is dropped when it is not a BIC', () => {
  assert.equal(core.epcQr(Object.assign({}, EP, { bic: '' })).split('\n')[4], '');
  assert.equal(core.epcQr(Object.assign({}, EP, { bic: undefined })).split('\n')[4], '');
  assert.equal(core.epcQr(Object.assign({}, EP, { bic: 'NOT-A-BIC' })).split('\n')[4], '');
  assert.equal(core.epcQr(Object.assign({}, EP, { bic: 'COBADEFF' })).split('\n')[4], 'COBADEFF');
  assert.equal(core.epcQr(Object.assign({}, EP, { bic: 'cobadeffxxx' })).split('\n')[4], 'COBADEFFXXX');
  assert.equal(core.epcQr(Object.assign({}, EP, { bic: 'COBA DEFF XXX' })).split('\n')[4], 'COBADEFFXXX');
  assert.equal(core.epcQr(Object.assign({}, EP, { bic: 'COBADEFFXX' })).split('\n')[4], '', '10 characters is not a BIC');
  assert.equal(core.epcQr(Object.assign({}, EP, { bic: 'COBADEF' })).split('\n')[4], '');
});

test('epcQr: amount is EUR with a dot, no grouping', () => {
  const a = (c) => core.epcQr(Object.assign({}, EP, { amountCents: c })).split('\n')[7];
  assert.equal(a(1), 'EUR0.01');
  assert.equal(a(100), 'EUR1.00');
  assert.equal(a(123456), 'EUR1234.56');
  assert.equal(a(100000000), 'EUR1000000.00');
  assert.equal(a(99999999999), 'EUR999999999.99');
});

test('epcQr: name is at most 70 characters and never ends with a space', () => {
  const name = (n) => core.epcQr(Object.assign({}, EP, { recipient: n })).split('\n')[5];
  assert.equal(name('x'.repeat(100)).length, 70);
  assert.equal(name('Line\nbreak'), 'Line break');
  assert.equal(name('  padded  '), 'padded');
  assert.equal(name('A'.repeat(69) + ' BCD'), 'A'.repeat(69), 'a name cut at 70 must not leave a trailing space');
});

test('epcQr: remittance is at most 140 characters, one line, no trailing space', () => {
  const rem = (m) => core.epcQr(Object.assign({}, EP, { message: m })).split('\n')[10];
  assert.equal(rem('x'.repeat(300)).length, 140);
  assert.equal(rem('a\r\nb\nc'), 'a b c');
  assert.equal(rem('A'.repeat(139) + ' BCD'), 'A'.repeat(139), 'a remittance cut at 140 must not leave a trailing space');
});

test('epcQr: an empty remittance leaves no trailing separators', () => {
  const t = core.epcQr(Object.assign({}, EP, { message: '' }));
  assert.equal(t, t.replace(/\s+$/, ''), JSON.stringify(t.slice(-12)));
});

test('epcQr: empty when it cannot be a valid payment', () => {
  assert.equal(core.epcQr(Object.assign({}, EP, { iban: 'DE00' })), '');
  assert.equal(core.epcQr(Object.assign({}, EP, { iban: '' })), '');
  assert.equal(core.epcQr(Object.assign({}, EP, { amountCents: 0 })), '');
  assert.equal(core.epcQr(Object.assign({}, EP, { amountCents: -100 })), '');
  assert.equal(core.epcQr(Object.assign({}, EP, { amountCents: NaN })), '');
  assert.equal(core.epcQr(Object.assign({}, EP, { amountCents: 100000000000 })), '');
  assert.equal(core.epcQr(Object.assign({}, EP, { recipient: '' })), '');
  assert.equal(core.epcQr(Object.assign({}, EP, { recipient: '   ' })), '');
  assert.equal(core.epcQr(Object.assign({}, EP, { recipient: null })), '');
});

test('epcQr: the IBAN is written without spaces, in capitals', () => {
  assert.equal(core.epcQr(Object.assign({}, EP, { iban: 'de89 3704 0044 0532 0130 00' })).split('\n')[6], DE_IBAN);
});

// -------------------------------------------------------- paymentQr

function payInv(over) {
  const inv = core.normalizeInvoice(Object.assign({
    kind: 'invoice_vat', number: '20260001', variableSymbol: '20260001', dueDate: '2026-12-01', currency: 'CZK',
    paymentMethod: 'transfer', showQr: true,
    bank: { account: '19-2000145399/0800', iban: '', swift: 'KOMBCZPP', hidden: false },
    supplier: { name: 'Dodavatel s.r.o.', country: 'CZ' }, customer: { name: 'Zákazník', country: 'CZ' }
  }, over));
  return inv;
}
const TOTAL = { payable: 12100 };

test('paymentQr: the basic Czech case gives a SPAYD', () => {
  const q = core.paymentQr(payInv(), TOTAL);
  assert.equal(q.type, 'spayd');
  const p = parseSpayd(q.text);
  assert.equal(p.map.ACC, CZ_IBAN);
  assert.equal(p.map.AM, '121.00');
  assert.equal(p.map.CC, 'CZK');
  assert.equal(p.map['X-VS'], '20260001');
  assert.equal(p.map.DT, '20261201');
  assert.equal(p.map.MSG, '20260001');
});

test('paymentQr: documents that are not payable have no QR', () => {
  for (const kind of ['quote_vat', 'quote_novat']) assert.equal(core.paymentQr(payInv({ kind }), TOTAL), null, kind);
  for (const kind of ['invoice_vat', 'invoice_novat', 'reverse_charge', 'corrective', 'proforma', 'advance']) {
    assert.equal(core.paymentQr(payInv({ kind }), TOTAL).type, 'spayd', kind);
  }
});

test('paymentQr: QR off, other payment method, hidden bank', () => {
  assert.equal(core.paymentQr(payInv({ showQr: false }), TOTAL), null);
  for (const paymentMethod of ['cash', 'card', 'cod', 'paypal', 'offset']) assert.equal(core.paymentQr(payInv({ paymentMethod }), TOTAL), null, paymentMethod);
  assert.equal(core.paymentQr(payInv({ bank: { account: '19-2000145399/0800', hidden: true } }), TOTAL), null);
});

test('paymentQr: nothing to pay, nothing to scan', () => {
  assert.equal(core.paymentQr(payInv(), { payable: 0 }), null);
  assert.equal(core.paymentQr(payInv(), { payable: -100 }), null);
  assert.equal(core.paymentQr(payInv(), { payable: NaN }), null);
  assert.equal(core.paymentQr(payInv(), { payable: 1 }).type, 'spayd');
});

test('paymentQr: no usable bank details', () => {
  assert.equal(core.paymentQr(payInv({ bank: { account: '', iban: '' } }), TOTAL), null);
  assert.equal(core.paymentQr(payInv({ bank: { account: '', iban: 'CZ00 0000' } }), TOTAL), null);
  assert.equal(core.paymentQr(payInv({ bank: { account: 'abc', iban: '' } }), TOTAL), null);
  assert.equal(core.paymentQr(payInv({ bank: null }), TOTAL), null);
});

test('paymentQr: CZK needs a Czech account, a foreign IBAN gives no QR', () => {
  assert.equal(core.paymentQr(payInv({ bank: { iban: CZ_IBAN } }), TOTAL).type, 'spayd');
  assert.equal(core.paymentQr(payInv({ bank: { iban: SK_IBAN } }), TOTAL), null);
  assert.equal(core.paymentQr(payInv({ bank: { iban: DE_IBAN } }), TOTAL), null);
  assert.equal(core.paymentQr(payInv({ bank: { iban: GB_IBAN } }), TOTAL), null);
});

test('paymentQr: EUR with a foreign IBAN is a SEPA QR', () => {
  const q = core.paymentQr(payInv({ currency: 'EUR', bank: { iban: DE_IBAN, swift: 'COBADEFFXXX' } }), TOTAL);
  assert.equal(q.type, 'epc');
  const lines = q.text.split('\n');
  assert.equal(lines.length, 11);
  assert.equal(lines[4], 'COBADEFFXXX');
  assert.equal(lines[5], 'Dodavatel s.r.o.');
  assert.equal(lines[6], DE_IBAN);
  assert.equal(lines[7], 'EUR121.00');
  assert.equal(lines[10], '20260001');
  assert.equal(core.paymentQr(payInv({ currency: 'EUR', bank: { iban: SK_IBAN } }), TOTAL).type, 'epc');
});

test('paymentQr: EUR with a Czech IBAN depends on the customer', () => {
  const cz = core.paymentQr(payInv({ currency: 'EUR' }), TOTAL);
  assert.equal(cz.type, 'spayd');
  assert.equal(parseSpayd(cz.text).map.CC, 'EUR');
  const foreign = core.paymentQr(payInv({ currency: 'EUR', customer: { name: 'Kunde', country: 'DE' } }), TOTAL);
  assert.equal(foreign.type, 'epc');
  assert.equal(foreign.text.split('\n')[6], CZ_IBAN);
  const noCountry = core.paymentQr(payInv({ currency: 'EUR', customer: { name: 'Kunde', country: '' } }), TOTAL);
  assert.equal(noCountry.type, 'spayd');
  const sk = core.paymentQr(payInv({ currency: 'EUR', customer: { name: 'Zákazník', country: 'SK' } }), TOTAL);
  assert.equal(sk.type, 'epc');
});

test('paymentQr: a SEPA QR needs a supplier name; a Czech IBAN then falls back to SPAYD, a foreign one to nothing', () => {
  assert.equal(core.paymentQr(payInv({ currency: 'EUR', bank: { iban: DE_IBAN }, supplier: { name: '' } }), TOTAL), null);
  const fb = core.paymentQr(payInv({ currency: 'EUR', customer: { country: 'DE' }, supplier: { name: '' } }), TOTAL);
  assert.equal(fb.type, 'spayd');
});

test('paymentQr: currencies other than CZK and EUR', () => {
  const usdCz = core.paymentQr(payInv({ currency: 'USD' }), TOTAL);
  assert.equal(usdCz.type, 'spayd');
  assert.equal(parseSpayd(usdCz.text).map.CC, 'USD');
  assert.equal(core.paymentQr(payInv({ currency: 'USD', bank: { iban: DE_IBAN } }), TOTAL), null);
  assert.equal(core.paymentQr(payInv({ currency: 'PLN', bank: { iban: DE_IBAN } }), TOTAL), null);
  assert.equal(core.paymentQr(payInv({ currency: 'eur', bank: { iban: DE_IBAN } }), TOTAL).type, 'epc', 'currency is case-insensitive');
  assert.equal(core.paymentQr(payInv({ currency: '' }), TOTAL).type, 'spayd', 'empty currency means CZK');
});

test('paymentQr: the document number is the message, an empty number gives none', () => {
  assert.equal(parseSpayd(core.paymentQr(payInv({ number: 'FV-2026-015' }), TOTAL).text).map.MSG, 'FV-2026-015');
  assert.equal('MSG' in parseSpayd(core.paymentQr(payInv({ number: '' }), TOTAL).text).map, false);
});

// ---------------------------------------------------------- numbering

test('formatPattern: tokens, padding and growth', () => {
  const f = core.formatPattern;
  assert.equal(f('YYYYNNNN', '2026-11-17', 3), '20260003');
  assert.equal(f('YYNNN', '2026-11-17', 3), '26003');
  assert.equal(f('FV-YYYY-NNN', '2026-11-17', 15), 'FV-2026-015');
  assert.equal(f('YYYYMMNNN', '2026-11-17', 3), '202611003');
  assert.equal(f('YYYY/MM/NN', '2026-01-05', 7), '2026/01/07');
  assert.equal(f('NNNN', '2026-11-17', 12345), '12345', 'grows past the padding');
  assert.equal(f('NNNN', '2026-11-17', 0), '0000');
  assert.equal(f('N', '2026-11-17', 7), '7');
  assert.equal(f('NNNNNN', '2026-11-17', 999999), '999999');
  assert.equal(f('NNNNNN', '2026-11-17', 1000000), '1000000');
  assert.equal(f('F-NNN-YYYY', '2026-11-17', '8'), 'F-008-2026');
  assert.equal(f('YYYYNNNN', '2026-11-17', 3), f('YYYYNNNN', '2026-11-17', '3'));
});

test('formatPattern: patterns with no N or nothing at all get a sequence', () => {
  assert.equal(core.formatPattern('', '2026-11-17', 3), '20260003');
  assert.equal(core.formatPattern(null, '2026-11-17', 3), '20260003');
  assert.equal(core.formatPattern(undefined, '2026-11-17', 3), '20260003');
  assert.equal(core.formatPattern('   ', '2026-11-17', 3), '20260003');
  assert.equal(core.formatPattern('FV', '2026-11-17', 3), 'FV0003');
  assert.equal(core.formatPattern('YYYY/', '2026-11-17', 3), '2026/0003');
  assert.equal(core.formatPattern('YYYY', '2026-11-17', 3), '20260003');
});

test('formatPattern: a bad date means today', () => {
  const y = String(new Date().getFullYear());
  assert.equal(core.formatPattern('YYYY-N', 'nonsense', 1), y + '-1');
  assert.equal(core.formatPattern('YYYY-N', undefined, 1), y + '-1');
});

test('formatPattern: a letter N in a prefix is text, only the sequence run is a number', () => {
  assert.equal(core.formatPattern('INV-YYYY-NNN', '2026-01-01', 5), 'INV-2026-005');
  assert.equal(core.formatPattern('NAB-YYYY-NNN', '2026-01-01', 5), 'NAB-2026-005');
});

test('formatPattern: a very long sequence is not printed in exponent form', () => {
  assert.equal(core.formatPattern('NNNN', '2026-01-01', 10 ** 21), '1' + '0'.repeat(21));
});

test('matchPattern: reads a number back through its pattern', () => {
  const m = core.matchPattern;
  assert.deepEqual(m('YYYYNNNN', '20260003'), { year: '2026', month: null, seq: 3 });
  assert.deepEqual(m('YYYYNNNN', '202610000'), { year: '2026', month: null, seq: 10000 });
  assert.deepEqual(m('FV-YYYY-NNN', 'FV-2026-015'), { year: '2026', month: null, seq: 15 });
  assert.deepEqual(m('YYYYMMNNN', '202611012'), { year: '2026', month: '11', seq: 12 });
  assert.deepEqual(m('YYNNN', '26003'), { year: '26', month: null, seq: 3 });
  assert.deepEqual(m('NNNN', '0042'), { year: null, month: null, seq: 42 });
  assert.deepEqual(m('YYYY/MM/NN', '2026/01/07'), { year: '2026', month: '01', seq: 7 });
  assert.deepEqual(m('', '20260003'), { year: '2026', month: null, seq: 3 }, 'empty pattern behaves as the default');
  assert.deepEqual(m('FV', 'FV0003'), { year: null, month: null, seq: 3 });
  assert.deepEqual(m('YYYYNNNN', 20260003), { year: '2026', month: null, seq: 3 }, 'a numeric number');
});

test('matchPattern: other shapes do not match', () => {
  const m = core.matchPattern;
  assert.equal(m('YYYYNNNN', '2026003'), null, 'sequence shorter than the pattern');
  assert.equal(m('YYYYNNNN', 'FV-2026-015'), null);
  assert.equal(m('YYYYNNNN', '20260003x'), null);
  assert.equal(m('YYYYNNNN', ' 20260003'), null);
  assert.equal(m('YYYYNNNN', ''), null);
  assert.equal(m('YYYYNNNN', null), null);
  assert.equal(m('YYYYNNNN', undefined), null);
  assert.equal(m('FV-YYYY-NNN', 'FV-2026-15'), null);
  assert.equal(m('F.V-NNN', 'FxV-001'), null, 'a dot in a pattern is a dot, not a wildcard');
  assert.deepEqual(m('F.V-NNN', 'F.V-001'), { year: null, month: null, seq: 1 });
  assert.deepEqual(m('(A)NNN', '(A)001'), { year: null, month: null, seq: 1 }, 'regex characters in a prefix are literal');
  assert.equal(m('(A)NNN', 'A001'), null);
});

test('nextNumber: continues a number that fits the pattern', () => {
  const n = core.nextNumber;
  assert.equal(n('YYYYNNNN', { number: '20260003' }, '2026-11-17'), '20260004');
  assert.equal(n('YYYYNNNN', { number: '20260009' }, '2026-11-17'), '20260010');
  assert.equal(n('YYYYNNNN', { number: '20269999' }, '2026-11-17'), '202610000', 'grows past the padding');
  assert.equal(n('YYYYNNNN', { number: '202610000' }, '2026-11-17'), '202610001', 'and keeps going');
  assert.equal(n('NNNNNN', { number: '000009' }, '2026-11-17'), '000010', 'padding kept');
  assert.equal(n('NNNNNN', { number: '999999' }, '2026-11-17'), '1000000');
  assert.equal(n('FV-YYYY-NNN', { number: 'FV-2026-015' }, '2026-11-17'), 'FV-2026-016');
});

test('nextNumber: restarts at 1 when the year changes', () => {
  const n = core.nextNumber;
  assert.equal(n('YYYYNNNN', { number: '20251234' }, '2026-01-02'), '20260001');
  assert.equal(n('YYNNNN', { number: '251234' }, '2026-01-02'), '260001');
  assert.equal(n('YYNNNN', { number: '261234' }, '2026-06-02'), '260001'.replace('0001', '1235'));
  assert.equal(n('FV-YYYY-NNN', { number: 'FV-2026-015' }, '2027-01-02'), 'FV-2027-001');
  assert.equal(n('YYYYNNNN', { number: '20261234' }, '2025-12-31'), '20250001', 'an earlier date also restarts');
  assert.equal(n('NNNN', { number: '0099' }, '2031-01-01'), '0100', 'no year token, no restart');
});

test('nextNumber: restarts at 1 when the month changes, where the pattern has MM', () => {
  const n = core.nextNumber;
  assert.equal(n('YYYYMMNNN', { number: '202610015' }, '2026-11-02'), '202611001');
  assert.equal(n('YYYYMMNNN', { number: '202610015' }, '2026-10-30'), '202610016');
  assert.equal(n('YYYYMMNNN', { number: '202612015' }, '2027-01-02'), '202701001');
  assert.equal(n('YYYYMMNNN', { number: '202511015' }, '2026-11-02'), '202611001', 'same month of another year');
  assert.equal(n('MM/NNN', { number: '10/015' }, '2026-11-02'), '11/001');
  assert.equal(n('MM/NNN', { number: '11/015' }, '2026-11-02'), '11/016');
});

test('nextNumber: custom shapes keep their shape', () => {
  const n = core.nextNumber;
  assert.equal(n('YYYYNNNN', { number: 'FV-2026-015', issueDate: '2026-03-01' }, '2026-11-17'), 'FV-2026-016');
  assert.equal(n('YYYYNNNN', { number: 'FV-2025-015', issueDate: '2025-12-30' }, '2026-01-04'), 'FV-2026-001');
  assert.equal(n('YYYYNNNN', { number: 'A-015' }, '2026-01-04'), 'A-016');
  assert.equal(n('YYYYNNNN', { number: 'A-099' }, '2026-01-04'), 'A-100');
  assert.equal(n('YYYYNNNN', { number: 'A-0099' }, '2026-01-04'), 'A-0100');
  assert.equal(n('YYYYNNNN', { number: 'A-9' }, '2026-01-04'), 'A-10');
  assert.equal(n('YYYYNNNN', { number: '15/2026' }, '2026-01-04'), '15/2027', 'the last run of digits goes up');
  assert.equal(n('YYYYNNNN', { number: '12' }, '2026-01-04'), '13');
  assert.equal(n('YYYYNNNN', { number: '2026-015/A' }, '2026-01-04'), '2026-016/A');
  assert.equal(n('YYYYNNNN', { number: 'FV-2026-015' }, '2026-11-17'), 'FV-2026-016', 'no issue date, no year change assumed');
});

test('nextNumber: numbers with no digits', () => {
  assert.equal(core.nextNumber('YYYYNNNN', { number: 'ABC' }, '2026-01-04'), 'ABC2');
  assert.equal(core.nextNumber('YYYYNNNN', { number: 'ABC2' }, '2026-01-04'), 'ABC3');
  assert.equal(core.nextNumber('YYYYNNNN', { number: '-' }, '2026-01-04'), '-2');
});

test('nextNumber: nothing before it means number 1', () => {
  assert.equal(core.nextNumber('YYYYNNNN', null, '2026-11-17'), '20260001');
  assert.equal(core.nextNumber('YYYYNNNN', undefined, '2026-11-17'), '20260001');
  assert.equal(core.nextNumber('YYYYNNNN', {}, '2026-11-17'), '20260001');
  assert.equal(core.nextNumber('YYYYNNNN', { number: '' }, '2026-11-17'), '20260001');
  assert.equal(core.nextNumber('FV-NNN', null, '2026-11-17'), 'FV-001');
  assert.equal(core.nextNumber('', null, '2026-11-17'), '20260001');
});

test('nextNumber: a sequence too long for a JS number is still counted exactly', () => {
  const big = '1'.repeat(22);
  assert.equal(core.nextNumber('NNNN', { number: big }, '2026-01-01'), '1'.repeat(21) + '2');
  assert.equal(core.nextNumber('NNNN', { number: '9007199254740993' }, '2026-01-01'), '9007199254740994');
});

test('nextNumber: a number whose year token comes from the issue date year of the next number', () => {
  // year change with a pattern that carries only YY and a number issued in the previous year
  assert.equal(core.nextNumber('YYNNN', { number: '25012', issueDate: '2025-12-31' }, '2026-01-01'), '26001');
});

test('suggestNumber: empty, null and junk lists', () => {
  assert.equal(core.suggestNumber('YYYYNNNN', [], '2026-11-17'), '20260001');
  assert.equal(core.suggestNumber('YYYYNNNN', null, '2026-11-17'), '20260001');
  assert.equal(core.suggestNumber('YYYYNNNN', undefined, '2026-11-17'), '20260001');
  assert.equal(core.suggestNumber('YYYYNNNN', [null, undefined, {}, { number: '' }, { number: null }], '2026-11-17'), '20260001');
  assert.equal(core.suggestNumber(null, null, '2026-11-17'), '20260001');
});

test('suggestNumber: continues the newest document and skips taken numbers', () => {
  const s = core.suggestNumber;
  assert.equal(s('YYYYNNNN', [{ number: '20260001', createdAt: '2026-01-01T10:00:00Z' }], '2026-11-17'), '20260002');
  assert.equal(s('YYYYNNNN', [
    { number: '20260002', createdAt: '2026-02-01T10:00:00Z' },
    { number: '20260001', createdAt: '2026-01-01T10:00:00Z' }], '2026-11-17'), '20260003');
  // the newest by createdAt is 0001 (an old number issued late), 0002 and 0003 are taken
  assert.equal(s('YYYYNNNN', [
    { number: '20260003', createdAt: '2026-01-01T10:00:00Z' },
    { number: '20260002', createdAt: '2026-01-02T10:00:00Z' },
    { number: '20260001', createdAt: '2026-01-03T10:00:00Z' }], '2026-11-17'), '20260004');
});

test('suggestNumber: without createdAt it still goes past the highest number', () => {
  assert.equal(core.suggestNumber('YYYYNNNN', [{ number: '20260002' }, { number: '20260005' }], '2026-11-17'), '20260006');
  assert.equal(core.suggestNumber('YYYYNNNN', [{ number: '20260005' }, { number: '20260002' }], '2026-11-17'), '20260006');
});

test('suggestNumber: year change restarts, and skips a taken first number', () => {
  const s = core.suggestNumber;
  assert.equal(s('YYYYNNNN', [{ number: '20251234', issueDate: '2025-12-20', createdAt: 'a' }], '2026-01-05'), '20260001');
  assert.equal(s('YYYYNNNN', [
    { number: '20251234', issueDate: '2025-12-20', createdAt: 'b' },
    { number: '20260001', issueDate: '2026-01-02', createdAt: 'a' }], '2026-01-05'), '20260002');
});

test('suggestNumber: custom shapes, FV-2026-015 and a year change', () => {
  const s = core.suggestNumber;
  assert.equal(s('YYYYNNNN', [{ number: 'FV-2026-015', issueDate: '2026-05-01', createdAt: 'a' }], '2026-11-17'), 'FV-2026-016');
  assert.equal(s('YYYYNNNN', [{ number: 'FV-2026-015', issueDate: '2026-05-01', createdAt: 'a' }], '2027-01-03'), 'FV-2027-001');
  assert.equal(s('FV-YYYY-NNN', [{ number: 'FV-2026-015', issueDate: '2026-05-01', createdAt: 'a' }], '2027-01-03'), 'FV-2027-001');
  assert.equal(s('FV-YYYY-NNN', [{ number: 'FV-2026-015', createdAt: 'a' }, { number: 'FV-2026-016', createdAt: 'b' }, { number: 'FV-2026-017', createdAt: 'c' }], '2026-11-17'), 'FV-2026-018');
});

test('suggestNumber: patterns without N and empty ones', () => {
  assert.equal(core.suggestNumber('FV', [{ number: 'FV0007', createdAt: 'a' }], '2026-11-17'), 'FV0008');
  assert.equal(core.suggestNumber('', [{ number: '20260007', createdAt: 'a' }], '2026-11-17'), '20260008');
  assert.equal(core.suggestNumber('   ', [], '2026-11-17'), '20260001');
});

test('suggestNumber: padding is kept and then grows, across a long run', () => {
  let list = [];
  let n = '';
  for (let i = 0; i < 20; i++) {
    n = core.suggestNumber('NNN', list, '2026-01-01');
    list = list.concat([{ number: n, createdAt: String(1000 + i) }]);
  }
  assert.equal(n, '020');
  list = [{ number: '997', createdAt: 'a' }];
  for (let i = 0; i < 5; i++) {
    n = core.suggestNumber('NNN', list, '2026-01-01');
    list = list.concat([{ number: n, createdAt: 'b' + i }]);
  }
  assert.deepEqual(list.map((d) => d.number), ['997', '998', '999', '1000', '1001', '1002']);
  assert.equal(new Set(list.map((d) => d.number)).size, list.length);
});

test('suggestNumber: numbers are never repeated over a long chain, with a letter prefix too', () => {
  const seen = new Set();
  let list = [];
  for (let i = 0; i < 300; i++) {
    const n = core.suggestNumber('YYYYNNNN', list, '2026-05-01');
    assert.equal(seen.has(n), false, n);
    seen.add(n);
    list.push({ number: n, issueDate: '2026-05-01', createdAt: String(10000 + i) });
  }
  assert.equal(list[299].number, '20260300');
});

test('suggestNumber: a prefix with an N in it (INV, NAB) numbers properly', () => {
  assert.equal(core.suggestNumber('INV-YYYY-NNN', [], '2026-01-01'), 'INV-2026-001');
  assert.equal(core.suggestNumber('INV-YYYY-NNN', [{ number: 'INV-2026-001', createdAt: 'a' }], '2026-01-01'), 'INV-2026-002');
});

test('defaultVariableSymbol: the last 10 digits of the number', () => {
  const v = core.defaultVariableSymbol;
  assert.equal(v('20260003'), '20260003');
  assert.equal(v('FV-2026-015'), '2026015');
  assert.equal(v('1234567890123'), '4567890123');
  assert.equal(v('1234567890'), '1234567890');
  assert.equal(v('ABC'), '');
  assert.equal(v(''), '');
  assert.equal(v(null), '');
  assert.equal(v(undefined), '');
  assert.equal(v(20260003), '20260003');
  assert.equal(v('0001'), '0001');
});

// ------------------------------------------------------------- status

test('statusOf', () => {
  const s = core.statusOf;
  assert.equal(s({}, '2026-11-17'), 'draft');
  assert.equal(s({ status: 'draft', dueDate: '2020-01-01' }, '2026-11-17'), 'draft');
  assert.equal(s({ status: 'weird' }, '2026-11-17'), 'draft');
  assert.equal(s({ status: 'paid' }, '2026-11-17'), 'paid');
  assert.equal(s({ status: 'paid', dueDate: '2020-01-01' }, '2026-11-17'), 'paid');
  assert.equal(s({ status: 'issued', dueDate: '2026-12-01' }, '2026-11-17'), 'issued');
  assert.equal(s({ status: 'issued', dueDate: '2026-11-17' }, '2026-11-17'), 'issued', 'due today is not overdue');
  assert.equal(s({ status: 'issued', dueDate: '2026-11-16' }, '2026-11-17'), 'overdue');
  assert.equal(s({ status: 'issued', kind: 'invoice_vat', dueDate: '2026-11-16' }, '2026-11-17'), 'overdue');
  assert.equal(s({ status: 'issued', kind: 'proforma', dueDate: '2026-11-16' }, '2026-11-17'), 'overdue');
  assert.equal(s({ status: 'issued', kind: 'quote_vat', dueDate: '2026-11-16' }, '2026-11-17'), 'issued', 'a quote is never overdue');
  assert.equal(s({ status: 'issued', kind: 'quote_novat', dueDate: '2020-01-01' }, '2026-11-17'), 'issued');
  assert.equal(s({ status: 'issued', dueDate: '' }, '2026-11-17'), 'issued');
  assert.equal(s({ status: 'issued', dueDate: 'soon' }, '2026-11-17'), 'issued');
  assert.equal(s({ status: 'issued', dueDate: '2020-01-01' }, undefined), 'issued');
  assert.equal(s({ status: 'issued', dueDate: '2020-01-01' }, 'today'), 'issued');
  assert.equal(s({ status: 'issued', kind: 'nonsense', dueDate: '2020-01-01' }, '2026-11-17'), 'overdue', 'unknown kind behaves as an invoice');
});

test('statusOf: hostile input does not throw', () => {
  assert.doesNotThrow(() => core.statusOf(null, '2026-11-17'));
  assert.doesNotThrow(() => core.statusOf(undefined, '2026-11-17'));
  assert.equal(core.statusOf(null, '2026-11-17'), 'draft');
  assert.equal(core.statusOf(undefined), 'draft');
});

// ----------------------------------------------------------- creation

test('uid: 16 characters of [a-z0-9], and not repeated', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const id = core.uid();
    assert.match(id, /^[a-z0-9]{16}$/);
    seen.add(id);
  }
  assert.equal(seen.size, 2000);
});

test('newCompany: supplier and customer shapes', () => {
  const s = core.newCompany('supplier');
  assert.equal(s.kind, 'supplier');
  assert.equal(typeof s.id, 'string');
  assert.equal(s.vatPayer, false);
  assert.equal(s.country, 'CZ');
  assert.deepEqual(s.bank, { account: '', accountName: '', iban: '', swift: '', showIban: false, hidden: false });
  assert.equal(s.logo, null);
  assert.equal(s.stamp, null);
  assert.deepEqual(s.defaults, core.SUPPLIER_DEFAULTS);
  assert.notEqual(s.defaults, core.SUPPLIER_DEFAULTS, 'defaults are a copy');
  s.defaults.dueDays = 99;
  assert.equal(core.SUPPLIER_DEFAULTS.dueDays, 14, 'changing a supplier does not change the shared defaults');
  assert.notEqual(core.newCompany('supplier').id, s.id);
  assert.notEqual(core.newCompany('supplier').defaults, core.newCompany('supplier').defaults);

  const c = core.newCompany('customer');
  assert.equal(c.kind, 'customer');
  assert.equal(c.country, 'CZ');
  assert.equal('bank' in c, false);
  assert.equal('defaults' in c, false);
  assert.equal('vatPayer' in c, false);
  for (const k of Object.keys(core.emptyParty())) assert.ok(k in c, k);
});

test('newCompany: an unknown or missing kind is a supplier', () => {
  assert.equal(core.newCompany().kind, 'supplier');
  assert.equal(core.newCompany('banana').kind, 'supplier');
  assert.equal(core.newCompany(null).kind, 'supplier');
});

test('partySnapshot: copies the party fields only, as strings', () => {
  const sup = Object.assign(core.newCompany('supplier'), { name: 'Acme', companyNumber: 27082440, city: 'Praha', email: null });
  const snap = core.partySnapshot(sup);
  assert.deepEqual(Object.keys(snap).sort(), Object.keys(core.emptyParty()).sort());
  assert.equal(snap.name, 'Acme');
  assert.equal(snap.companyNumber, '27082440');
  assert.equal(snap.email, '');
  assert.equal(snap.country, 'CZ');
  assert.deepEqual(core.partySnapshot(null), core.emptyParty());
  assert.deepEqual(core.partySnapshot(undefined), core.emptyParty());
});

function supplierWith(over, defaults) {
  const s = Object.assign(core.newCompany('supplier'), { name: 'Dodavatel s.r.o.', companyNumber: '27082440', street: 'Ulice 1', city: 'Praha', postcode: '11000' }, over || {});
  Object.assign(s.defaults, defaults || {});
  return s;
}

test('newInvoice: a non-VAT-payer supplier', () => {
  const s = supplierWith();
  const inv = core.newInvoice(s, { today: '2026-11-17' });
  assert.equal(inv.kind, 'invoice_novat');
  assert.equal(inv.vatApplies, false);
  assert.equal(inv.items.length, 1);
  assert.equal(inv.items[0].vatRate, 0);
  assert.equal(inv.supplierId, s.id);
  assert.equal(inv.customerId, null);
  assert.equal(inv.issueDate, '2026-11-17');
  assert.equal(inv.taxDate, '2026-11-17');
  assert.equal(inv.dueIn, 14);
  assert.equal(inv.dueDate, '2026-12-01');
  assert.equal(inv.number, '20260001');
  assert.equal(inv.variableSymbol, '20260001');
  assert.equal(inv.status, 'draft');
  assert.equal(inv.currency, 'CZK');
  assert.equal(inv.language, 'cs');
  assert.equal(inv.paymentMethod, 'transfer');
  assert.equal(inv.showQr, true);
  assert.equal(inv.priceMode, 'net');
  assert.equal(inv.supplier.name, 'Dodavatel s.r.o.');
  assert.equal(inv.supplier.country, 'CZ');
  assert.equal('id' in inv.supplier, false);
  assert.equal('bank' in inv.supplier, false);
  assert.deepEqual(inv.customer, core.emptyParty());
  assert.equal(inv.documentDiscount, null);
  assert.equal(inv.paidDate, '');
});

test('newInvoice: a VAT payer gets VAT documents at the top rate', () => {
  const inv = core.newInvoice(supplierWith({ vatPayer: true }), { today: '2026-11-17' });
  assert.equal(inv.kind, 'invoice_vat');
  assert.equal(inv.vatApplies, true);
  assert.equal(inv.items[0].vatRate, 21);
});

test('newInvoice: supplier defaults are used, and null defaults are ignored', () => {
  const s = supplierWith({}, { dueDays: 30, currency: 'EUR', language: 'en', paymentMethod: 'cash', rounding: '1', template: 'simple',
    color: '#aa0000', numberPattern: 'FV-YYYY-NNN', issuedBy: 'Jan', note: 'Thanks', priceMode: 'gross', showQr: false });
  const inv = core.newInvoice(s, { today: '2026-01-31' });
  assert.equal(inv.dueIn, 30);
  assert.equal(inv.dueDate, '2026-03-02');
  assert.equal(inv.currency, 'EUR');
  assert.equal(inv.language, 'en');
  assert.equal(inv.paymentMethod, 'cash');
  assert.equal(inv.rounding, '1');
  assert.equal(inv.template, 'simple');
  assert.equal(inv.color, '#aa0000');
  assert.equal(inv.number, 'FV-2026-001');
  assert.equal(inv.variableSymbol, '2026001');
  assert.equal(inv.issuedBy, 'Jan');
  assert.equal(inv.note, 'Thanks');
  assert.equal(inv.priceMode, 'gross');
  assert.equal(inv.showQr, false);

  const n = core.newInvoice(supplierWith({}, { dueDays: null, currency: null, numberPattern: null, showQr: null }), { today: '2026-11-17' });
  assert.equal(n.dueIn, 14);
  assert.equal(n.currency, 'CZK');
  assert.equal(n.number, '20260001');
  assert.equal(n.showQr, true);
});

test('newInvoice: due days from text, and nonsense falls back to 14', () => {
  const due = (v) => core.newInvoice(supplierWith({}, { dueDays: v }), { today: '2026-11-17' });
  assert.equal(due('30').dueDate, '2026-12-17');
  assert.equal(due(0).dueDate, '2026-11-17');
  assert.equal(due(-5).dueIn, 14);
  assert.equal(due('abc').dueIn, 14);
  assert.equal(due(undefined).dueIn, 14);
  assert.equal(due(NaN).dueDate, '2026-12-01');
});

test('newInvoice: priceMode accepts only gross and net', () => {
  assert.equal(core.newInvoice(supplierWith({}, { priceMode: 'weird' }), { today: '2026-11-17' }).priceMode, 'net');
  assert.equal(core.newInvoice(supplierWith({}, { priceMode: 'gross' }), { today: '2026-11-17' }).priceMode, 'gross');
});

test('newInvoice: the supplier bank is copied by value', () => {
  const s = supplierWith();
  s.bank = { account: '19-2000145399/0800', accountName: 'Main', iban: '', swift: 'KOMBCZPP', showIban: true, hidden: false, extra: 'ignored' };
  s.registerNote = 'Registered in Prague';
  const inv = core.newInvoice(s, { today: '2026-11-17' });
  assert.deepEqual(inv.bank, { account: '19-2000145399/0800', accountName: 'Main', iban: '', swift: 'KOMBCZPP', showIban: true, hidden: false });
  assert.notEqual(inv.bank, s.bank);
  assert.equal(inv.registerNote, 'Registered in Prague');
  inv.bank.account = 'changed';
  assert.equal(s.bank.account, '19-2000145399/0800');
});

test('newInvoice: kind option and its fallbacks', () => {
  const s = supplierWith();
  assert.equal(core.newInvoice(s, { kind: 'quote_novat', today: '2026-11-17' }).kind, 'quote_novat');
  assert.equal(core.newInvoice(s, { kind: 'reverse_charge', today: '2026-11-17' }).kind, 'reverse_charge');
  assert.equal(core.newInvoice(s, { kind: 'nonsense', today: '2026-11-17' }).kind, 'invoice_novat');
  assert.equal(core.newInvoice(supplierWith({ vatPayer: true }), { kind: 'nonsense', today: '2026-11-17' }).kind, 'invoice_vat');
  const pf = core.newInvoice(s, { kind: 'proforma', today: '2026-11-17' });
  assert.equal(core.vatModeOf(pf), 'none', 'a proforma of a non-payer has no VAT');
  const pfv = core.newInvoice(supplierWith({ vatPayer: true }), { kind: 'proforma', today: '2026-11-17' });
  assert.equal(core.vatModeOf(pfv), 'vat');
});

test('newInvoice: object prototype names are not document kinds', () => {
  for (const kind of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.equal(core.newInvoice(supplierWith(), { kind, today: '2026-11-17' }).kind, 'invoice_novat', kind);
  }
});

test('newInvoice: numbering reads only this supplier and this series', () => {
  const s = supplierWith({ vatPayer: true });
  const other = core.newCompany('supplier');
  const existing = [
    { supplierId: s.id, kind: 'invoice_vat', number: '20260005', issueDate: '2026-02-01', createdAt: '3' },
    { supplierId: s.id, kind: 'reverse_charge', number: '20260006', issueDate: '2026-02-02', createdAt: '4' },
    { supplierId: other.id, kind: 'invoice_vat', number: '20260099', issueDate: '2026-02-03', createdAt: '5' },
    { supplierId: s.id, kind: 'quote_vat', number: '20260077', issueDate: '2026-02-04', createdAt: '6' },
    { supplierId: s.id, kind: 'corrective', number: '20260088', issueDate: '2026-02-05', createdAt: '7' },
    null
  ];
  assert.equal(core.newInvoice(s, { today: '2026-11-17', existing }).number, '20260007', 'invoice series: invoice_vat and reverse_charge');
  assert.equal(core.newInvoice(s, { today: '2026-11-17', existing, kind: 'quote_vat' }).number, '20260078');
  assert.equal(core.newInvoice(s, { today: '2026-11-17', existing, kind: 'corrective' }).number, '20260089');
  assert.equal(core.newInvoice(s, { today: '2026-11-17', existing, kind: 'proforma' }).number, '20260001', 'proformas have a series of their own');
  assert.equal(core.newInvoice(other, { today: '2026-11-17', existing }).number, '20260100');
});

test('newInvoice: no supplier, no options, a bad today', () => {
  const a = core.newInvoice(null, { today: '2026-11-17' });
  assert.equal(a.supplierId, null);
  assert.equal(a.kind, 'invoice_novat');
  assert.equal(a.number, '20260001');
  const b = core.newInvoice(undefined);
  assert.ok(core.isIsoDate(b.issueDate));
  assert.equal(b.dueDate, core.addDays(b.issueDate, 14));
  const c = core.newInvoice(supplierWith(), { today: '2026-02-30' });
  assert.ok(core.isIsoDate(c.issueDate) && c.issueDate !== '2026-02-30');
  assert.notEqual(a.id, core.newInvoice(null, { today: '2026-11-17' }).id);
});

test('newInvoice: items get their own ids', () => {
  const inv = core.newInvoice(supplierWith(), { today: '2026-11-17' });
  assert.equal(typeof inv.items[0].id, 'string');
  assert.deepEqual(Object.keys(inv.items[0]).sort(), ['description', 'discount', 'id', 'price', 'qty', 'unit', 'vatRate'].sort());
  assert.notEqual(inv.items[0].id, inv.id);
});

// ---------------------------------------------------------- normalize

test('normalizeInvoice: a missing document gets everything', () => {
  for (const input of [null, undefined, {}, [], 0, '', false]) {
    const n = core.normalizeInvoice(input);
    assert.equal(Array.isArray(n), false);
    assert.ok(Array.isArray(n.items), JSON.stringify(input));
    assert.ok(core.KINDS[n.kind]);
    assert.equal(n.status, 'draft');
    assert.ok(core.isIsoDate(n.issueDate));
    assert.equal(n.rounding, 'none');
    assert.equal(n.paymentMethod, 'transfer');
    assert.deepEqual(n.customer, core.emptyParty());
    assert.deepEqual(n.bank, core.emptyBank());
    assert.equal(typeof n.id, 'string');
  }
});

test('normalizeInvoice: partial input keeps what it has and fills the rest', () => {
  const n = core.normalizeInvoice({
    id: 'abc', kind: 'quote_vat', number: 'N1', issueDate: '2026-03-01', status: 'issued', currency: 'EUR',
    supplier: { name: 'Acme' }, customer: { city: 'Brno' }, bank: { account: '1/0100' },
    items: [{ description: 'x' }, { id: 'keep', qty: 3 }, { id: '', price: 5 }, { id: null }]
  });
  assert.equal(n.id, 'abc');
  assert.equal(n.kind, 'quote_vat');
  assert.equal(n.number, 'N1');
  assert.equal(n.status, 'issued');
  assert.equal(n.currency, 'EUR');
  assert.equal(n.issueDate, '2026-03-01');
  assert.equal(n.dueDate, '2026-03-15', 'derived from the issue date of the document, not from today');
  assert.equal(n.taxDate, '2026-03-01');
  assert.equal(n.supplier.name, 'Acme');
  assert.equal(n.supplier.country, 'CZ');
  assert.equal(n.customer.city, 'Brno');
  assert.equal(n.customer.name, '');
  assert.equal(n.bank.account, '1/0100');
  assert.equal(n.bank.hidden, false);
  assert.equal(n.items.length, 4);
  assert.equal(n.items[0].description, 'x');
  assert.equal(n.items[0].qty, 1);
  assert.equal(n.items[0].price, 0);
  assert.equal(n.items[1].id, 'keep');
  assert.equal(n.items[1].qty, 3);
  assert.equal(n.items[2].price, 5);
  const ids = n.items.map((i) => i.id);
  assert.ok(ids.every((i) => typeof i === 'string' && i), JSON.stringify(ids));
  assert.equal(new Set(ids).size, ids.length);
});

test('normalizeInvoice: wrong enumerations are reset', () => {
  const n = core.normalizeInvoice({ kind: 'nope', status: 'archived', rounding: '0.25', paymentMethod: 'bitcoin' });
  assert.equal(n.kind, 'invoice_vat');
  assert.equal(n.status, 'draft');
  assert.equal(n.rounding, 'none');
  assert.equal(n.paymentMethod, 'transfer');
  const ok = core.normalizeInvoice({ status: 'paid', rounding: '0.5', paymentMethod: 'cash', kind: 'advance' });
  assert.equal(ok.status, 'paid');
  assert.equal(ok.rounding, '0.5');
  assert.equal(ok.paymentMethod, 'cash');
  assert.equal(ok.kind, 'advance');
  assert.equal(core.normalizeInvoice({ rounding: 1 }).rounding, 1, 'a numeric 1 is the step 1 and is kept');
});

test('normalizeInvoice: object prototype names are not enumeration values', () => {
  for (const name of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    const n = core.normalizeInvoice({ kind: name, rounding: name });
    assert.equal(n.kind, 'invoice_vat', 'kind ' + name);
    assert.equal(n.rounding, 'none', 'rounding ' + name);
  }
});

test('normalizeInvoice: hostile types do not throw', () => {
  const hostile = [
    { items: null }, { items: 'abc' }, { items: {} }, { items: 5 }, { items: [null, 5, 'x', [], [1, 2], true, undefined] },
    { supplier: null }, { supplier: 'Acme' }, { supplier: [] }, { supplier: 5 }, { customer: false }, { customer: [1] },
    { bank: null }, { bank: 'x' }, { bank: [1] }, { bank: 7 },
    { kind: 5 }, { kind: {} }, { kind: [] }, { status: {} }, { rounding: {} }, { rounding: [] }, { rounding: null },
    { paymentMethod: [] }, { issueDate: 5 }, { issueDate: {} }, { issueDate: 'x' }, { dueDate: 5 },
    { items: [{ qty: {}, price: [], vatRate: 'x', discount: 'bad' }] },
    JSON.parse('{"__proto__": {"kind": "quote_vat"}}'), 'a string', 12, true, [1, 2, 3]
  ];
  for (const h of hostile) {
    let n;
    assert.doesNotThrow(() => { n = core.normalizeInvoice(h); }, JSON.stringify(h));
    assert.ok(Array.isArray(n.items), JSON.stringify(h));
    assert.ok(core.KINDS[n.kind], JSON.stringify(h));
    assert.equal(typeof n.supplier, 'object');
    assert.equal(typeof n.customer, 'object');
    assert.equal(typeof n.bank, 'object');
    assert.doesNotThrow(() => core.computeTotals(n), 'totals of ' + JSON.stringify(h));
  }
});

test('normalizeInvoice: hostile values leave the party and bank shape intact', () => {
  for (const v of [null, 'Acme', [], 5, false, undefined]) {
    const n = core.normalizeInvoice({ supplier: v, customer: v, bank: v });
    for (const k of Object.keys(core.emptyParty())) {
      assert.equal(typeof n.supplier[k], 'string', 'supplier.' + k + ' for ' + JSON.stringify(v));
      assert.equal(typeof n.customer[k], 'string', 'customer.' + k + ' for ' + JSON.stringify(v));
    }
    for (const k of Object.keys(core.emptyBank())) assert.ok(k in n.bank, 'bank.' + k);
  }
});

test('normalizeInvoice: null scalars count as missing, like undefined', () => {
  const n = core.normalizeInvoice({ issueDate: '2026-03-01', currency: null, language: null, template: null, color: null, dueDate: null, taxDate: null, dueIn: null, priceMode: null });
  assert.equal(n.currency, 'CZK');
  assert.equal(n.language, 'cs');
  assert.equal(n.template, 'modern');
  assert.equal(n.color, '#1d4e89');
  assert.equal(n.dueDate, '2026-03-15');
  assert.equal(n.taxDate, '2026-03-01');
  assert.equal(n.dueIn, 14);
  assert.equal(n.priceMode, 'net');
  assert.ok(core.isIsoDate(core.normalizeInvoice({ issueDate: null }).issueDate), 'a null issue date becomes today');
});

test('normalizeInvoice: does not change its input, and is idempotent', () => {
  const input = { id: 'a', kind: 'quote_vat', issueDate: '2026-03-01', supplier: { name: 'S' }, items: [{ description: 'x', discount: { type: 'percent', value: 10 } }, { description: 'y' }] };
  const before = JSON.stringify(input);
  const n1 = core.normalizeInvoice(input);
  assert.equal(JSON.stringify(input), before);
  const n2 = core.normalizeInvoice(n1);
  assert.deepEqual(n2, n1);
  assert.notEqual(n1.items, input.items);
  assert.notEqual(n1.items[0], input.items[0]);
  assert.notEqual(n1.supplier, input.supplier);
});

test('normalizeInvoice: a fresh draft survives it unchanged', () => {
  const inv = core.newInvoice(supplierWith({ vatPayer: true }), { today: '2026-11-17' });
  assert.deepEqual(core.normalizeInvoice(inv), inv);
});

test('normalizeInvoice: a stored empty item list stays empty', () => {
  assert.deepEqual(core.normalizeInvoice({ items: [] }).items, []);
});

// ---------------------------------------------------------- duplicate

function original() {
  const s = supplierWith({ vatPayer: true });
  const inv = core.newInvoice(s, { today: '2026-01-10' });
  inv.customer = Object.assign(core.emptyParty(), { name: 'Zákazník', city: 'Brno' });
  inv.items = [
    { id: 'i1', qty: 2, unit: 'hour', description: 'Work', vatRate: 21, price: 1000, discount: { type: 'percent', value: 10 } },
    { id: 'i2', qty: 1, unit: '', description: 'Other', vatRate: 12, price: 500, discount: null }
  ];
  inv.documentDiscount = { type: 'amount', value: 100 };
  inv.status = 'paid';
  inv.paidDate = '2026-01-20';
  inv.recordNumber = 'R-77';
  inv.constantSymbol = '308';
  inv.note = 'Thanks';
  inv.createdAt = '2026-01-10T09:00:00Z';
  inv.updatedAt = '2026-01-20T09:00:00Z';
  inv.supplierId = s.id;
  return { inv, supplier: s };
}

test('duplicateInvoice: new identity, new number, draft, dates moved', () => {
  const { inv } = original();
  const copy = core.duplicateInvoice(inv, { today: '2026-03-05', existing: [inv] });
  assert.notEqual(copy.id, inv.id);
  assert.equal(copy.number, '20260002');
  assert.equal(copy.variableSymbol, '20260002');
  assert.equal(copy.recordNumber, '');
  assert.equal(copy.status, 'draft');
  assert.equal(copy.paidDate, '');
  assert.equal(copy.issueDate, '2026-03-05');
  assert.equal(copy.taxDate, '2026-03-05');
  assert.equal(copy.dueDate, '2026-03-19');
  assert.equal(copy.createdAt, '');
  assert.equal(copy.updatedAt, '');
  assert.equal(copy.customer.name, 'Zákazník');
  assert.equal(copy.constantSymbol, '308');
  assert.equal(copy.note, 'Thanks');
  assert.equal(copy.supplierId, inv.supplierId);
});

test('duplicateInvoice: items and nested data are copied, never shared', () => {
  const { inv } = original();
  const snapshot = JSON.stringify(inv);
  const copy = core.duplicateInvoice(inv, { today: '2026-03-05', existing: [inv] });
  assert.equal(JSON.stringify(inv), snapshot, 'the original is untouched');
  assert.equal(copy.items.length, 2);
  copy.items.forEach((it, i) => {
    assert.notEqual(it.id, inv.items[i].id, 'new item id');
    assert.equal(typeof it.id, 'string');
    assert.equal(it.description, inv.items[i].description);
    assert.equal(it.price, inv.items[i].price);
    assert.equal(it.qty, inv.items[i].qty);
    assert.notEqual(it, inv.items[i]);
  });
  assert.notEqual(copy.items[0].id, copy.items[1].id);
  assert.deepEqual(copy.items[0].discount, inv.items[0].discount);
  assert.notEqual(copy.items[0].discount, inv.items[0].discount);
  assert.notEqual(copy.documentDiscount, inv.documentDiscount);
  assert.deepEqual(copy.documentDiscount, inv.documentDiscount);
  assert.notEqual(copy.supplier, inv.supplier);
  assert.notEqual(copy.customer, inv.customer);
  assert.notEqual(copy.bank, inv.bank);
  copy.items[0].description = 'changed';
  copy.items[0].discount.value = 99;
  copy.customer.name = 'changed';
  copy.documentDiscount.value = 1;
  assert.equal(JSON.stringify(inv), snapshot, 'editing the copy never reaches the original');
});

test('duplicateInvoice: the due date keeps the payment term', () => {
  const { inv } = original();
  inv.dueIn = 30;
  assert.equal(core.duplicateInvoice(inv, { today: '2026-03-05', existing: [] }).dueDate, '2026-04-04');
  inv.dueIn = '7';
  assert.equal(core.duplicateInvoice(inv, { today: '2026-03-05', existing: [] }).dueDate, '2026-03-12');
  inv.dueIn = 0;
  assert.equal(core.duplicateInvoice(inv, { today: '2026-03-05', existing: [] }).dueDate, '2026-03-05');
  inv.dueIn = 'custom';
  inv.issueDate = '2026-01-10';
  inv.dueDate = '2026-01-25';
  assert.equal(core.duplicateInvoice(inv, { today: '2026-03-05', existing: [] }).dueDate, '2026-03-20', 'a custom term of 15 days');
  inv.dueDate = 'soon';
  assert.equal(core.duplicateInvoice(inv, { today: '2026-03-05', existing: [] }).dueDate, '2026-03-19', 'unreadable custom term means 14');
  inv.dueDate = '2026-01-05';
  assert.equal(core.duplicateInvoice(inv, { today: '2026-03-05', existing: [] }).dueDate, '2026-03-19', 'a negative term means 14');
  inv.dueIn = 'abc';
  assert.equal(core.duplicateInvoice(inv, { today: '2026-03-05', existing: [] }).dueDate, '2026-03-19');
});

test('duplicateInvoice: numbering uses the supplier and series, the year, and the pattern option', () => {
  const { inv } = original();
  const other = Object.assign({}, inv, { id: 'o', supplierId: 'someone-else', number: '20260090' });
  const quote = Object.assign({}, inv, { id: 'q', kind: 'quote_vat', number: '20260080' });
  assert.equal(core.duplicateInvoice(inv, { today: '2026-03-05', existing: [inv, other, quote] }).number, '20260002');
  assert.equal(core.duplicateInvoice(inv, { today: '2027-01-05', existing: [inv] }).number, '20270001', 'a new year starts again');
  assert.equal(core.duplicateInvoice(inv, { today: '2026-03-05', existing: [], pattern: 'FV-YYYY-NNN' }).number, 'FV-2026-001');
  const fv = Object.assign({}, inv, { number: 'FV-2026-004' });
  assert.equal(core.duplicateInvoice(fv, { today: '2026-03-05', existing: [fv], pattern: 'FV-YYYY-NNN' }).number, 'FV-2026-005');
  const q = core.duplicateInvoice(quote, { today: '2026-03-05', existing: [inv, other, quote] });
  assert.equal(q.number, '20260081', 'a quote continues the quote series');
  assert.equal(q.kind, 'quote_vat');
  assert.equal(core.duplicateInvoice(inv, { today: '2026-03-05' }).number, '20260001', 'no existing list');
});

test('duplicateInvoice: hostile input', () => {
  assert.doesNotThrow(() => core.duplicateInvoice(null, { today: '2026-03-05' }));
  assert.doesNotThrow(() => core.duplicateInvoice({}, { today: '2026-03-05' }));
  assert.doesNotThrow(() => core.duplicateInvoice(undefined, { today: '2026-03-05' }), 'undefined');
  assert.doesNotThrow(() => core.duplicateInvoice({ items: 'x', supplier: 5 }));
  const c = core.duplicateInvoice({}, { today: '2026-03-05' });
  assert.equal(c.status, 'draft');
  assert.equal(c.issueDate, '2026-03-05');
  assert.ok(core.isIsoDate(core.duplicateInvoice({}, { today: 'nonsense' }).issueDate));
});

test('duplicateInvoice: copies are independent of each other too', () => {
  const { inv } = original();
  const a = core.duplicateInvoice(inv, { today: '2026-03-05', existing: [inv] });
  const b = core.duplicateInvoice(inv, { today: '2026-03-05', existing: [inv] });
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.items[0].id, b.items[0].id);
  assert.notEqual(a.items[0], b.items[0]);
  const c = core.duplicateInvoice(a, { today: '2026-03-06', existing: [inv, a] });
  assert.equal(c.number, '20260003');
});

test('givenACzechInvoice_whenTheQrIsBuilt_thenItNamesTheSupplierAsRecipient', () => {
  const C = require('../core.js');
  const sup = C.newCompany('supplier');
  sup.name = 'Vzorová dílna s.r.o.';
  sup.bank.account = '19-2000145399/0800';
  const inv = C.newInvoice(sup, { today: '2026-11-17' });
  inv.items[0].price = 100;
  const qr = C.paymentQr(inv, C.computeTotals(inv));
  assert.equal(qr.type, 'spayd');
  // the recipient name is plain upper-case ASCII, as the rest of the payload
  assert.match(qr.text, /\*RN:VZOROVA DILNA S\.R\.O\.(\*|$)/);
  // a long name is cut to the 35 characters the standard allows, and an empty one adds no field
  inv.supplier.name = 'Velmi dlouhý název společnosti s ručením omezeným a ještě delší';
  const long = /\*RN:([^*]*)/.exec(C.paymentQr(inv, C.computeTotals(inv)).text);
  assert.ok(long && long[1].length <= 35 && long[1].length > 20);
  inv.supplier.name = '';
  assert.doesNotMatch(C.paymentQr(inv, C.computeTotals(inv)).text, /\*RN:/);
});
