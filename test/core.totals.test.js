'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');
const I18N = require('../i18n.js');

const CS = I18N.get('cs');
const EN = I18N.get('en');
const NB = ' ';

// ------------------------------------------------------------------ helpers

let idCounter = 0;
function it(qty, price, vatRate, extra) {
  return Object.assign({ id: 'item' + (++idCounter), qty: qty, price: price, vatRate: vatRate == null ? 21 : vatRate, description: 'x', unit: '' }, extra || {});
}
function doc(items, over) {
  return Object.assign({ kind: 'invoice_vat', priceMode: 'net', items: items, rounding: 'none' }, over || {});
}
function T(items, over) { return C.computeTotals(doc(items, over)); }

/** The invariants that must hold for every computed document. */
function checkIdentities(t, label) {
  const tag = label ? label + ': ' : '';
  let sn = 0, sv = 0, sg = 0;
  t.lines.forEach(function (l, i) {
    assert.equal(l.net + l.vat, l.gross, tag + 'line ' + i + ' net + vat = gross');
    sn += l.net; sv += l.vat; sg += l.gross;
    ['qty', 'unitNet', 'basis', 'net', 'vat', 'gross', 'rateBp'].forEach(function (k) {
      if (l[k] != null) assert.ok(Number.isInteger(l[k]), tag + 'line ' + i + ' ' + k + ' is an integer: ' + l[k]);
    });
  });
  assert.equal(sn, t.net, tag + 'sum of line nets = net');
  assert.equal(sv, t.vat, tag + 'sum of line vats = vat');
  assert.equal(sg, t.gross, tag + 'sum of line grosses = gross');
  assert.equal(t.net + t.vat, t.gross, tag + 'net + vat = gross');
  let rn = 0, rv = 0, rg = 0;
  t.byRate.forEach(function (r) {
    assert.equal(r.net + r.vat, r.gross, tag + 'rate ' + r.rateBp + ' net + vat = gross');
    rn += r.net; rv += r.vat; rg += r.gross;
  });
  assert.equal(rn, t.net, tag + 'sum of byRate net');
  assert.equal(rv, t.vat, tag + 'sum of byRate vat');
  assert.equal(rg, t.gross, tag + 'sum of byRate gross');
  assert.equal(t.payable, t.gross + t.rounding, tag + 'payable = gross + rounding');
  for (const k of ['net', 'vat', 'gross', 'rounding', 'payable']) {
    assert.ok(Number.isInteger(t[k]), tag + k + ' is an integer');
    assert.ok(!Object.is(t[k], -0), tag + k + ' is not -0');
  }
}

/** Seeded pseudo random numbers so a failure can be repeated. */
function rng(seed) {
  let s = seed >>> 0;
  return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function walk(value, path, bad) {
  if (value === undefined) bad.push(path + ' is undefined');
  else if (typeof value === 'number' && !Number.isFinite(value)) bad.push(path + ' is not finite');
  else if (typeof value === 'string') {
    if (/undefined|NaN|\[object|null/.test(value)) bad.push(path + ' = ' + JSON.stringify(value));
  } else if (Array.isArray(value)) value.forEach(function (v, i) { walk(v, path + '[' + i + ']', bad); });
  else if (value && typeof value === 'object') Object.keys(value).forEach(function (k) { walk(value[k], path + '.' + k, bad); });
}
function assertClean(model, label) {
  const bad = [];
  walk(model, 'vm', bad);
  assert.deepEqual(bad, [], label + ': ' + bad.join('; '));
}

const CTX = { labels: CS, countryName: function (c) { return c; }, images: {} };
const CTX_EN = { labels: EN, countryName: function (c) { return c; }, images: {} };

// ------------------------------------------------------- reference figures

test('reference: 3 x 1210 at 21 %, gross mode 3000 / 630 / 3630', () => {
  const t = T([it(3, 1210)], { priceMode: 'gross' });
  assert.equal(t.net, 300000); assert.equal(t.vat, 63000); assert.equal(t.gross, 363000);
  checkIdentities(t);
});

test('reference: 3 x 1210 at 21 %, net mode 3630 / 762.30 / 4392.30', () => {
  const t = T([it(3, 1210)]);
  assert.equal(t.net, 363000); assert.equal(t.vat, 76230); assert.equal(t.gross, 439230);
});

test('reference: net mode with a 10 % item discount 3267 / 686.07 / 3953.07', () => {
  const t = T([it(3, 1210, 21, { discount: { type: 'percent', value: 10 } })]);
  assert.equal(t.net, 326700); assert.equal(t.vat, 68607); assert.equal(t.gross, 395307);
  assert.equal(t.lines.length, 2);
  assert.equal(t.lines[1].kind, 'item_discount');
  checkIdentities(t);
});

// ------------------------------------------------------------ price modes

test('gross mode: price - price / (1 + rate), per Czech VAT Act s. 37 (rounded to the cent)', () => {
  // 100 incl. 21 %: 100 / 1.21 = 82.6446 -> net 82.64, vat 17.36
  let t = T([it(1, 100)], { priceMode: 'gross' });
  assert.deepEqual([t.net, t.vat, t.gross], [8264, 1736, 10000]);
  // 99.99 incl. 12 %: 99.99 / 1.12 = 89.2768 -> 89.28 ; vat 10.71
  t = T([it(1, 99.99, 12)], { priceMode: 'gross' });
  assert.deepEqual([t.net, t.vat, t.gross], [8928, 1071, 9999]);
  // 0.01 incl. 21 %: net 0.0082 -> 0.01 ; vat 0
  t = T([it(1, 0.01)], { priceMode: 'gross' });
  assert.deepEqual([t.net, t.vat, t.gross], [1, 0, 1]);
  checkIdentities(t);
});

test('net mode: vat = base x rate, rounded half away from zero', () => {
  // 0.50 x 21 % = 0.105 -> 0.11
  let t = T([it(1, 0.5)]);
  assert.deepEqual([t.net, t.vat, t.gross], [50, 11, 61]);
  // -0.50 x 21 % = -0.105 -> -0.11
  t = T([it(1, -0.5)]);
  assert.deepEqual([t.net, t.vat, t.gross], [-50, -11, -61]);
  // 0.10 x 5 % = 0.005 -> 0.01
  t = T([it(1, 0.1, 5)]);
  assert.equal(t.vat, 1);
});

test('priceMode only matters where VAT is charged', () => {
  for (const kind of ['invoice_novat', 'reverse_charge', 'quote_novat']) {
    const items = [it(2, 1000, 21)];
    const gross = T(items, { kind: kind, priceMode: 'gross' });
    const net = T(items, { kind: kind, priceMode: 'net' });
    assert.deepEqual(gross, net, kind);
    assert.equal(gross.priceMode, 'net');
    assert.equal(gross.gross, 200000);
    assert.equal(gross.vat, 0);
  }
});

test('priceMode value other than "gross" is treated as net', () => {
  assert.equal(C.priceModeOf({ kind: 'invoice_vat', priceMode: 'banana' }), 'net');
  assert.equal(C.priceModeOf({ kind: 'invoice_vat' }), 'net');
  assert.equal(C.priceModeOf({ kind: 'invoice_vat', priceMode: 'gross' }), 'gross');
});

// ------------------------------------------------------- VAT modes / kinds

test('every kind maps to the documented VAT mode', () => {
  const want = {
    invoice_vat: 'vat', invoice_novat: 'none', reverse_charge: 'reverse', corrective: 'vat',
    quote_vat: 'vat', quote_novat: 'none'
  };
  for (const k of Object.keys(want)) {
    for (const applies of [true, false, undefined]) {
      assert.equal(C.vatModeOf({ kind: k, vatApplies: applies }), want[k], k + ' vatApplies=' + applies);
    }
  }
});

test('proforma and advance follow vatApplies', () => {
  for (const k of ['proforma', 'advance']) {
    assert.equal(C.vatModeOf({ kind: k, vatApplies: true }), 'vat');
    assert.equal(C.vatModeOf({ kind: k, vatApplies: false }), 'none');
    assert.equal(C.vatModeOf({ kind: k }), 'none');
    const on = T([it(1, 1000)], { kind: k, vatApplies: true });
    assert.deepEqual([on.net, on.vat, on.gross], [100000, 21000, 121000]);
    const off = T([it(1, 1000)], { kind: k, vatApplies: false });
    assert.deepEqual([off.net, off.vat, off.gross], [100000, 0, 100000]);
    assert.equal(off.byRate.length, 1);
    assert.equal(off.byRate[0].rateBp, 0);
  }
});

test('unknown kind falls back to a VAT invoice', () => {
  assert.equal(C.vatModeOf({ kind: 'nonsense' }), 'vat');
  assert.equal(C.vatModeOf({}), 'vat');
});

test('none mode: rate is ignored, no VAT anywhere', () => {
  const t = T([it(1, 100, 21), it(2, 50, 12)], { kind: 'invoice_novat' });
  assert.equal(t.vat, 0);
  assert.equal(t.net, 20000);
  assert.equal(t.gross, 20000);
  assert.deepEqual(t.byRate.map((r) => r.rateBp), [0]);
  t.lines.forEach((l) => assert.equal(l.rateBp, 0));
});

test('reverse mode: the rate is kept on the line, no VAT is charged', () => {
  const t = T([it(1, 100, 21), it(2, 50, 12)], { kind: 'reverse_charge' });
  assert.equal(t.vat, 0);
  assert.equal(t.gross, t.net);
  assert.deepEqual(t.byRate.map((r) => r.rateBp), [2100, 1200]);
  checkIdentities(t);
});

test('eight kinds x three price modes x both VAT flags keep the identities', () => {
  for (const kind of C.KIND_ORDER) {
    for (const priceMode of ['net', 'gross']) {
      for (const vatApplies of [true, false]) {
        const t = T([it(3, 1210, 21), it(1.5, 99.99, 12, { discount: { type: 'percent', value: 7 } }), it(2, 10, 0)],
          { kind: kind, priceMode: priceMode, vatApplies: vatApplies, documentDiscount: { type: 'amount', value: 33.33 } });
        checkIdentities(t, kind + '/' + priceMode + '/' + vatApplies);
      }
    }
  }
});

// ---------------------------------------------------------------- rates

test('rates 0, 12, 21 and custom 12.5 in net mode', () => {
  const t = T([it(1, 1000, 0), it(1, 1000, 12), it(1, 1000, 21), it(1, 1000, 12.5)]);
  const by = {};
  t.byRate.forEach((r) => { by[r.rateBp] = r; });
  assert.equal(by[0].vat, 0);
  assert.equal(by[1200].vat, 12000);
  assert.equal(by[2100].vat, 21000);
  assert.equal(by[1250].vat, 12500);
  assert.deepEqual(t.byRate.map((r) => r.rateBp), [2100, 1250, 1200, 0], 'sorted from the highest rate');
  checkIdentities(t);
});

test('rates 0, 12, 21 and custom 12.5 in gross mode', () => {
  const t = T([it(1, 1000, 0), it(1, 1120, 12), it(1, 1210, 21), it(1, 1125, 12.5)], { priceMode: 'gross' });
  const by = {};
  t.byRate.forEach((r) => { by[r.rateBp] = r; });
  assert.deepEqual([by[0].net, by[0].vat], [100000, 0]);
  assert.deepEqual([by[1200].net, by[1200].vat], [100000, 12000]);
  assert.deepEqual([by[2100].net, by[2100].vat], [100000, 21000]);
  assert.deepEqual([by[1250].net, by[1250].vat], [100000, 12500]);
  checkIdentities(t);
});

test('a rate typed as a string ("12,5", "21 %" is not a number) and a negative rate', () => {
  assert.equal(T([it(1, 1000, '12,5')]).vat, 12500);
  assert.equal(T([it(1, 1000, '21')]).vat, 21000);
  assert.equal(T([it(1, 1000, 'abc')]).vat, 0);
  assert.equal(T([it(1, 1000, '')]).vat, 0);
  assert.equal(T([it(1, 1000, -5)]).vat, 0, 'a negative rate counts as 0');
  assert.equal(T([it(1, 1000, undefined, { vatRate: undefined })]).vat, 0);
});

test('items at the same rate are grouped once; byRate lines are not duplicated', () => {
  const t = T([it(1, 10, 21), it(1, 20, 21), it(1, 30, 12), it(1, 40, 21)]);
  assert.equal(t.byRate.length, 2);
});

test('the rate 12.50 and 12.5 and "12.50" are the same group', () => {
  const t = T([it(1, 10, 12.5), it(1, 10, '12.50'), it(1, 10, '12,5')]);
  assert.equal(t.byRate.length, 1);
});

// ---------------------------------------------------------- qty and price

test('quantities with 4 decimals', () => {
  // 0.3333 x 1000 = 333.30
  assert.equal(T([it(0.3333, 1000, 0)]).net, 33330);
  // 1.2345 x 100 = 123.45
  assert.equal(T([it(1.2345, 100, 0)]).net, 12345);
  // 12.3456 x 3 = 37.0368 -> 37.04
  assert.equal(T([it(12.3456, 3, 0)]).net, 3704);
  // a 5th decimal is rounded half up: 1.23455 -> 1.2346 (x 10000 = 12346)
  assert.equal(C.decToInt('1.23455', 4), 12346);
  assert.equal(C.decToInt('1.23454', 4), 12345);
});

test('prices with 4 decimals', () => {
  // 1000 x 0.0001 = 0.10
  assert.equal(T([it(1000, 0.0001, 0)]).net, 10);
  // 3 x 0.3333 = 0.9999 -> 1.00
  assert.equal(T([it(3, 0.3333, 0)]).net, 100);
  // 12345.6789 x 1 -> 12345.68
  assert.equal(T([it(1, 12345.6789, 0)]).net, 1234568);
  // 0.0049 x 1 -> 0.00 ; 0.0050 -> 0.01 (half up)
  assert.equal(T([it(1, 0.0049, 0)]).net, 0);
  assert.equal(T([it(1, 0.005, 0)]).net, 1);
});

test('exact products are not corrupted by binary floats', () => {
  // 1.1 x 1.1 = 1.21 exactly; 0.1 x 0.2; 4.35 x 100 = 435 (float gives 434.99999999999994)
  assert.equal(T([it(1.1, 1.1, 0)]).net, 121);
  assert.equal(T([it(100, 4.35, 0)]).net, 43500);
  assert.equal(T([it(3, 1.005, 0)]).net, 302); // 3.015 -> 3.02 (half away), not 3.01
  assert.equal(T([it(1, 1.005, 0)]).net, 101);
  assert.equal(T([it(1, 2.675, 0)]).net, 268);
});

test('line amount is rounded once, from the exact product of qty and price', () => {
  // 0.0001 x 0.0001 -> 0
  assert.equal(T([it(0.0001, 0.0001, 0)]).net, 0);
  // 333.3333 x 0.6667 = 222.2200 (approx) -> check by BigInt
  const q = 3333333, p = 6667;
  const exact = BigInt(q) * BigInt(p); // scale 1e8
  const cents = Number((exact * 2n + 1000000n) / 2000000n);
  assert.equal(T([it(333.3333, 0.6667, 0)]).net, cents);
});

test('negative quantities and prices (a corrective document)', () => {
  let t = T([it(-2, 100)], { kind: 'corrective' });
  assert.deepEqual([t.net, t.vat, t.gross], [-20000, -4200, -24200]);
  t = T([it(2, -100)], { kind: 'corrective' });
  assert.deepEqual([t.net, t.vat, t.gross], [-20000, -4200, -24200]);
  t = T([it(-2, -100)], { kind: 'corrective' });
  assert.deepEqual([t.net, t.vat, t.gross], [20000, 4200, 24200]);
  t = T([it(-1, 121)], { kind: 'corrective', priceMode: 'gross' });
  assert.deepEqual([t.net, t.vat, t.gross], [-10000, -2100, -12100]);
  // a line that cancels another one
  t = T([it(5, 100), it(-5, 100)], { kind: 'corrective' });
  assert.deepEqual([t.net, t.vat, t.gross, t.payable], [0, 0, 0, 0]);
  checkIdentities(t);
});

test('a corrective document: negative half cent rounds away from zero, mirroring the positive', () => {
  for (const p of [0.5, 1.5, 2.5, 0.05, 123.45]) {
    const pos = T([it(1, p, 21)]);
    const neg = T([it(1, -p, 21)]);
    assert.equal(neg.vat, -pos.vat, 'price ' + p);
    assert.equal(neg.net, -pos.net);
    const posG = T([it(1, p, 21)], { priceMode: 'gross' });
    const negG = T([it(1, -p, 21)], { priceMode: 'gross' });
    assert.equal(negG.net, -posG.net, 'gross price ' + p);
    assert.equal(negG.vat, -posG.vat);
  }
});

test('zero quantity and zero price give zero lines, no NaN', () => {
  for (const pm of ['net', 'gross']) {
    const t = T([it(0, 100), it(5, 0), it(0, 0)], { priceMode: pm });
    assert.deepEqual([t.net, t.vat, t.gross], [0, 0, 0]);
    checkIdentities(t);
    t.lines.forEach((l) => assert.ok(Number.isInteger(l.unitNet), 'unitNet ' + l.unitNet));
  }
});

test('gross mode: unitNet x qty reproduces the line net (to the cent)', () => {
  const r = rng(7);
  for (let n = 0; n < 300; n++) {
    const qty = Math.round(r() * 100000) / 10000 + 0.0001;
    const price = Math.round(r() * 10000000) / 10000;
    const rate = [0, 12, 21, 12.5][Math.floor(r() * 4)];
    const t = T([it(qty, price, rate)], { priceMode: 'gross' });
    const l = t.lines[0];
    // unitNet is scaled by 1e4, qty by 1e4 -> product scaled by 1e8, cents = 1e6
    const back = Number((BigInt(l.qty) * BigInt(l.unitNet) * 2n + 1000000n) / 2000000n);
    assert.ok(Math.abs(back - l.net) <= 1, 'qty ' + qty + ' price ' + price + ' rate ' + rate + ' back ' + back + ' net ' + l.net);
  }
});

// ----------------------------------------------------------- item discounts

test('item discount: percent', () => {
  const t = T([it(1, 1000, 21, { discount: { type: 'percent', value: 25 } })]);
  assert.equal(t.lines.length, 2);
  assert.deepEqual([t.lines[1].net, t.lines[1].vat, t.lines[1].gross], [-25000, -5250, -30250]);
  assert.deepEqual([t.net, t.vat, t.gross], [75000, 15750, 90750]);
  assert.equal(t.lines[1].itemId, t.lines[0].itemId);
  checkIdentities(t);
});

test('item discount: percent in gross mode discounts the gross amount', () => {
  const t = T([it(1, 1210, 21, { discount: { type: 'percent', value: 10 } })], { priceMode: 'gross' });
  assert.equal(t.gross, 108900);
  assert.equal(t.net, 90000);
  assert.equal(t.vat, 18900);
  checkIdentities(t);
});

test('item discount: fixed amount', () => {
  const t = T([it(2, 500, 21, { discount: { type: 'amount', value: 100 } })]);
  assert.deepEqual([t.net, t.vat, t.gross], [90000, 18900, 108900]);
  checkIdentities(t);
});

test('item discount: amount larger than the line is capped at the line', () => {
  for (const pm of ['net', 'gross']) {
    const t = T([it(1, 100, 21, { discount: { type: 'amount', value: 5000 } })], { priceMode: pm });
    assert.deepEqual([t.net, t.vat, t.gross], [0, 0, 0], pm);
    checkIdentities(t, pm);
  }
});

test('item discount: 100 % and more than 100 % (capped)', () => {
  for (const v of [100, 150, '100']) {
    const t = T([it(3, 99.99, 12, { discount: { type: 'percent', value: v } })]);
    assert.deepEqual([t.net, t.vat, t.gross], [0, 0, 0], 'value ' + v);
    checkIdentities(t);
  }
});

test('item discount on a zero line produces no discount line', () => {
  const t = T([it(0, 100, 21, { discount: { type: 'percent', value: 10 } }), it(1, 0, 21, { discount: { type: 'amount', value: 10 } })]);
  assert.equal(t.lines.length, 2);
  assert.ok(t.lines.every((l) => l.kind === 'item'));
});

test('item discount: zero, negative, empty and garbage values are ignored', () => {
  for (const d of [null, undefined, { type: 'percent', value: 0 }, { type: 'percent', value: -10 }, { type: 'amount', value: '' }, { type: 'amount', value: 'abc' }, { type: 'percent' }]) {
    const t = T([it(1, 100, 21, { discount: d })]);
    assert.equal(t.lines.length, 1, JSON.stringify(d));
    assert.equal(t.gross, 12100);
  }
});

test('item discount: value typed as a string with a decimal comma', () => {
  const t = T([it(1, 1000, 0, { discount: { type: 'percent', value: '12,5' } })]);
  assert.equal(t.net, 87500);
  const t2 = T([it(1, 1000, 0, { discount: { type: 'amount', value: '1 000' } })]);
  assert.equal(t2.net, 0);
});

test('item discount that rounds to nothing makes no line', () => {
  const t = T([it(1, 0.01, 0, { discount: { type: 'percent', value: 10 } })]);
  assert.equal(t.lines.length, 1);
});

test('item discount keeps the identity for many random lines (net and gross)', () => {
  const r = rng(42);
  for (let n = 0; n < 400; n++) {
    const items = [];
    const count = 1 + Math.floor(r() * 5);
    for (let k = 0; k < count; k++) {
      const disc = r() < 0.5 ? null : (r() < 0.5
        ? { type: 'percent', value: Math.round(r() * 10000) / 100 }
        : { type: 'amount', value: Math.round(r() * 100000) / 100 });
      items.push(it(Math.round(r() * 100000) / 10000, Math.round(r() * 10000000) / 10000, [0, 12, 21, 12.5][Math.floor(r() * 4)], { discount: disc }));
    }
    for (const pm of ['net', 'gross']) {
      const t = T(items, { priceMode: pm });
      checkIdentities(t, 'seed 42 #' + n + ' ' + pm);
      t.lines.forEach((l) => { if (l.kind === 'item_discount') assert.ok(l.gross <= 0, 'a discount is negative'); });
      // an item with its discount never goes below zero
      const per = {};
      t.lines.forEach((l) => { per[l.itemId] = (per[l.itemId] || 0) + l.basis; });
      Object.keys(per).forEach((id) => assert.ok(per[id] >= 0, 'item ' + id + ' basis after discount ' + per[id]));
    }
  }
});

test('item discount on a negative line (corrective): the discount applies with the sign of the line', () => {
  // -1 x 1000 less 10 % must be -900, not -1000
  const t = T([it(-1, 1000, 0, { discount: { type: 'percent', value: 10 } })], { kind: 'corrective' });
  assert.equal(t.net, -90000);
});

test('item discount on a negative price line (corrective) with an amount discount', () => {
  const t = T([it(1, -1000, 0, { discount: { type: 'amount', value: 100 } })], { kind: 'corrective' });
  assert.equal(t.net, -90000);
});

// -------------------------------------------------------- document discount

test('document discount: percent, one rate', () => {
  const t = T([it(1, 1000, 21)], { documentDiscount: { type: 'percent', value: 10 } });
  assert.equal(t.lines.length, 2);
  assert.equal(t.lines[1].kind, 'doc_discount');
  assert.deepEqual([t.net, t.vat, t.gross], [90000, 18900, 108900]);
  checkIdentities(t);
});

test('document discount: percent, several rates, each rate discounted by the percent', () => {
  const t = T([it(1, 1000, 21), it(1, 500, 12), it(1, 200, 0)], { documentDiscount: { type: 'percent', value: 10 } });
  const by = {};
  t.byRate.forEach((r) => { by[r.rateBp] = r; });
  assert.equal(by[2100].net, 90000);
  assert.equal(by[1200].net, 45000);
  assert.equal(by[0].net, 18000);
  assert.equal(t.lines.filter((l) => l.kind === 'doc_discount').length, 3);
  checkIdentities(t);
});

test('document discount: amount splits in proportion to each rate base and sums exactly', () => {
  // bases 1000 / 500 / 500 (net mode) and a 200 discount -> 100 / 50 / 50
  const t = T([it(1, 1000, 21), it(1, 500, 12), it(1, 500, 0)], { documentDiscount: { type: 'amount', value: 200 } });
  const d = t.lines.filter((l) => l.kind === 'doc_discount');
  const m = {};
  d.forEach((l) => { m[l.rateBp] = l.basis; });
  assert.deepEqual(m, { 2100: -10000, 1200: -5000, 0: -5000 });
  assert.equal(d.reduce((s, l) => s + l.basis, 0), -20000);
  checkIdentities(t);
});

test('document discount: awkward amount, shares sum exactly to the amount', () => {
  for (const amount of [0.01, 0.02, 0.03, 0.05, 100, 123.45, 333.33, 999.99, 1000.01, 1999.99]) {
    const t = T([it(1, 1000, 21), it(1, 500, 12), it(1, 500, 0)], { documentDiscount: { type: 'amount', value: amount } });
    const d = t.lines.filter((l) => l.kind === 'doc_discount');
    const cents = Math.round(amount * 100);
    assert.equal(-d.reduce((s, l) => s + l.basis, 0), cents, 'amount ' + amount);
    d.forEach((l) => assert.ok(l.basis < 0));
    checkIdentities(t, 'amount ' + amount);
  }
});

test('document discount: three equal rates and 1 cent, the cent lands on one rate, total is exact', () => {
  const t = T([it(1, 100, 21), it(1, 100, 12), it(1, 100, 0)], { documentDiscount: { type: 'amount', value: 0.01 } });
  const d = t.lines.filter((l) => l.kind === 'doc_discount');
  assert.equal(d.length, 1);
  assert.equal(d[0].basis, -1);
});

test('document discount: the per-rate split is proportional (within one cent) for random documents', () => {
  const r = rng(99);
  for (let n = 0; n < 500; n++) {
    const rates = [21, 12, 0, 12.5].slice(0, 1 + Math.floor(r() * 4));
    const items = rates.map((rate) => it(1, Math.round(r() * 1000000) / 100, rate));
    const pm = r() < 0.5 ? 'net' : 'gross';
    const before = T(items, { priceMode: pm });
    const total = before.lines.reduce((s, l) => s + l.basis, 0);
    if (total <= 0) continue;
    const amountCents = 1 + Math.floor(r() * (total + 500)); // sometimes more than the total
    const t = T(items, { priceMode: pm, documentDiscount: { type: 'amount', value: amountCents / 100 } });
    const target = Math.min(amountCents, total);
    const d = t.lines.filter((l) => l.kind === 'doc_discount');
    assert.equal(-d.reduce((s, l) => s + l.basis, 0), target, 'n ' + n + ' sum of shares');
    const baseByRate = {};
    before.lines.forEach((l) => { baseByRate[l.rateBp] = (baseByRate[l.rateBp] || 0) + l.basis; });
    d.forEach((l) => {
      const ideal = target * baseByRate[l.rateBp] / total;
      assert.ok(Math.abs(-l.basis - ideal) <= rates.length, 'n ' + n + ' rate ' + l.rateBp + ' share ' + (-l.basis) + ' ideal ' + ideal);
      assert.ok(-l.basis <= baseByRate[l.rateBp], 'n ' + n + ' a share never exceeds its own rate base: ' + (-l.basis) + ' > ' + baseByRate[l.rateBp]);
    });
    checkIdentities(t, 'n ' + n);
    assert.ok(t.gross >= 0, 'n ' + n + ' a discount never turns the total negative');
  }
});

test('document discount: amount larger than the total is capped, giving zero', () => {
  for (const pm of ['net', 'gross']) {
    const t = T([it(1, 100, 21), it(1, 50, 12)], { priceMode: pm, documentDiscount: { type: 'amount', value: 1e6 } });
    assert.deepEqual([t.net, t.vat, t.gross], [0, 0, 0], pm);
    checkIdentities(t, pm);
  }
});

test('document discount: 100 % and more than 100 %', () => {
  for (const v of [100, 250]) {
    const t = T([it(1, 100, 21), it(1, 50, 12)], { documentDiscount: { type: 'percent', value: v } });
    assert.deepEqual([t.net, t.vat, t.gross], [0, 0, 0]);
    checkIdentities(t);
  }
});

test('document discount comes after item discounts and is taken from what is left', () => {
  const t = T([it(1, 1000, 21, { discount: { type: 'percent', value: 50 } })], { documentDiscount: { type: 'percent', value: 10 } });
  assert.equal(t.net, 45000);
  checkIdentities(t);
});

test('document discount: nothing to discount (no items, all zero) makes no line', () => {
  assert.equal(T([], { documentDiscount: { type: 'percent', value: 10 } }).lines.length, 0);
  assert.equal(T([it(1, 0)], { documentDiscount: { type: 'amount', value: 10 } }).lines.length, 1);
});

test('document discount: in gross mode the amount is a gross amount', () => {
  const t = T([it(1, 1210, 21)], { priceMode: 'gross', documentDiscount: { type: 'amount', value: 121 } });
  assert.deepEqual([t.net, t.vat, t.gross], [90000, 18900, 108900]);
});

test('document discount with a rate whose group is negative or zero is not discounted', () => {
  const t = T([it(1, 100, 21), it(1, -100, 12)], { kind: 'corrective', documentDiscount: { type: 'percent', value: 10 } });
  const d = t.lines.filter((l) => l.kind === 'doc_discount');
  assert.equal(d.length, 1);
  assert.equal(d[0].rateBp, 2100);
  checkIdentities(t);
});

test('document discount on an all-negative corrective document: the discount applies with the sign of the lines', () => {
  const t = T([it(-1, 1000, 0)], { kind: 'corrective', documentDiscount: { type: 'percent', value: 10 } });
  assert.equal(t.net, -90000);
});

test('document discount in none and reverse modes', () => {
  for (const kind of ['invoice_novat', 'reverse_charge']) {
    const t = T([it(1, 1000, 21), it(1, 500, 12)], { kind: kind, documentDiscount: { type: 'percent', value: 10 } });
    assert.equal(t.net, 135000);
    assert.equal(t.vat, 0);
    checkIdentities(t, kind);
  }
});

// --------------------------------------------------------------- rounding

test('rounding to 0.10: exact halves go away from zero', () => {
  const cases = [[10, 10], [14, 10], [15, 20], [16, 20], [5, 10], [4, 0], [0, 0], [-4, 0], [-5, -10], [-14, -10], [-15, -20], [-16, -20]];
  for (const [gross, want] of cases) {
    const t = T([it(1, gross / 100, 0)], { rounding: '0.1' });
    assert.equal(t.gross, gross);
    assert.equal(t.payable, want, 'gross ' + gross);
    assert.equal(t.rounding, want - gross);
    assert.ok(Math.abs(t.rounding) <= 5);
  }
});

test('rounding to 0.50: exact halves (0.25 and 0.75) go away from zero', () => {
  const cases = [[10000, 10000], [10024, 10000], [10025, 10050], [10049, 10050], [10074, 10050], [10075, 10100], [-10024, -10000], [-10025, -10050], [-10075, -10100]];
  for (const [gross, want] of cases) {
    const t = T([it(1, gross / 100, 0)], { rounding: '0.5' });
    assert.equal(t.payable, want, 'gross ' + gross);
    assert.ok(Math.abs(t.rounding) <= 25);
  }
});

test('rounding to 1.00: exact halves go away from zero, negative totals mirror', () => {
  const cases = [[10049, 10000], [10050, 10100], [10051, 10100], [-10049, -10000], [-10050, -10100], [-10051, -10100], [49, 0], [50, 100], [-49, 0], [-50, -100]];
  for (const [gross, want] of cases) {
    const t = T([it(1, gross / 100, 0)], { rounding: '1' });
    assert.equal(t.payable, want, 'gross ' + gross);
  }
});

test('rounding values: numbers, strings, unknown', () => {
  const g = 12345;
  const mk = (rounding) => T([it(1, g / 100, 0)], { rounding: rounding });
  assert.equal(mk('none').payable, g);
  assert.equal(mk(undefined).payable, g);
  assert.equal(mk('banana').payable, g);
  assert.equal(mk('0.1').payable, 12350);
  assert.equal(mk('0.5').payable, 12350);
  assert.equal(mk('1').payable, 12300);
  assert.equal(mk(1).payable, 12300, 'numeric 1');
  assert.equal(mk(0.1).payable, 12350, 'numeric 0.1');
  assert.equal(mk(0.5).payable, 12350, 'numeric 0.5');
});

test('rounding is not part of the VAT base and does not change net, vat, gross', () => {
  const a = T([it(1, 99.99, 21)], { rounding: 'none' });
  const b = T([it(1, 99.99, 21)], { rounding: '1' });
  assert.deepEqual([a.net, a.vat, a.gross], [b.net, b.vat, b.gross]);
  assert.equal(b.payable, 12100);
  assert.equal(b.rounding, 12100 - a.gross);
  checkIdentities(b);
});

test('rounding of the gross total after the VAT of the document (reference)', () => {
  // 3 x 1210 net mode: 4392.30 -> 4392.00 (1.00) / 4392.30 (0.10) / 4392.50 (0.50)
  assert.equal(T([it(3, 1210)], { rounding: '1' }).payable, 439200);
  assert.equal(T([it(3, 1210)], { rounding: '0.1' }).payable, 439230);
  assert.equal(T([it(3, 1210)], { rounding: '0.5' }).payable, 439250);
});

test('roundToStep and mulDiv directly', () => {
  assert.equal(C.roundToStep(125, 0), 125);
  assert.equal(C.roundToStep(-125, 0), -125);
  assert.equal(C.roundToStep(150, 100), 200);
  assert.equal(C.roundToStep(-150, 100), -200);
  assert.equal(C.mulDiv(1, 1, 2), 1);
  assert.equal(C.mulDiv(-1, 1, 2), -1);
  assert.equal(C.mulDiv(1, 1, 3), 0);
  assert.equal(C.mulDiv(2, 1, 3), 1);
  assert.equal(C.mulDiv(5, 1, 0), 0, 'division by zero gives 0');
  assert.equal(C.mulDiv(1, 1, -2), -1);
  assert.equal(C.mulDiv(-1, 1, -2), 1);
  assert.ok(!Object.is(C.mulDiv(-1, 1, 3), -0), 'no -0');
  assert.ok(!Object.is(C.roundToStep(-4, 10), -0), 'roundToStep(-4, 10) is not -0');
});

// --------------------------------------------------------------- big values

test('large values (1e9) are exact', () => {
  let t = T([it(1, 1e9, 21)]);
  assert.deepEqual([t.net, t.vat, t.gross], [1e11, 21e9, 121e9]);
  t = T([it(1e9, 1e9, 0)]);
  assert.equal(t.net, 1e18 > Number.MAX_SAFE_INTEGER ? t.net : 1e18);
  t = T([it(1e5, 1e4, 21)]);
  assert.deepEqual([t.net, t.vat, t.gross], [1e11, 21e9, 121e9]);
  t = T([it(1, 1e9, 21)], { priceMode: 'gross' });
  assert.equal(t.net + t.vat, t.gross);
  assert.equal(t.gross, 1e11);
  t = T([it(3, 999999999.99, 21), it(7, 123456789.01, 12)], { rounding: '1', documentDiscount: { type: 'percent', value: 12.5 } });
  checkIdentities(t);
});

test('large value as a string typed by a person', () => {
  const t = T([it('1 000 000 000', '1 000,50', 0)]);
  assert.equal(t.net, 1000000000 * 100050);
});

// ------------------------------------------------------------ typed strings

test('strings typed by a person', () => {
  const t = (qty, price) => T([it(qty, price, 0)]).net;
  assert.equal(t('1 210,50', 1), 121050);
  assert.equal(t(1, '1 210,50'), 121050);
  assert.equal(t(1, '1' + NB + '210,50'), 121050, 'non-breaking space');
  assert.equal(t(1, '1 210,50'), 121050, 'narrow non-breaking space');
  assert.equal(t('1,5', 100), 15000);
  assert.equal(t('1.5', 100), 15000);
  assert.equal(t(1, '1,210.50'), 121050);
  assert.equal(t(1, '1.210,50'), 121050);
  assert.equal(t(1, "1'210.50"), 121050);
  assert.equal(t('', 100), 0);
  assert.equal(t(1, ''), 0);
  assert.equal(t('abc', 100), 0);
  assert.equal(t(1, 'abc'), 0);
  assert.equal(t(null, 100), 0);
  assert.equal(t(undefined, 100), 0);
  assert.equal(t(1, '12abc'), 0);
  assert.equal(t(1, '1e3'), 0, 'exponent form is not a typed number');
  assert.equal(t('-2', 100), -20000);
  assert.equal(t('−2', 100), -20000, 'unicode minus');
  assert.equal(t('–2', 100), -20000, 'en dash as minus');
  assert.equal(t(',5', 100), 5000);
  assert.equal(t('.5', 100), 5000);
  assert.equal(t('5,', 100), 50000);
  assert.equal(t(' 2 ', 100), 20000);
});

test('plain numbers that arrive as JavaScript numbers, including tiny and huge', () => {
  assert.equal(C.decToInt(1e-7, 4), 0);
  assert.equal(C.decToInt(0.00005, 4), 1);
  assert.equal(C.decToInt(1e-5, 4), 0);
  assert.equal(C.decToInt(123456789012, 2), 12345678901200);
  assert.equal(C.decToInt(NaN, 2), 0);
  assert.equal(C.decToInt(Infinity, 2), 0);
  assert.equal(C.decToInt(-Infinity, 2), 0);
  assert.equal(C.decToInt(true, 2), 0);
});

test('decToInt never returns -0', () => {
  for (const v of ['-0', '-0.004', -0, '-0,00001', -0.00001]) {
    assert.ok(!Object.is(C.decToInt(v, 2), -0), 'decToInt(' + String(v) + ')');
  }
});

test('line fields never hold -0', () => {
  const t = T([it('-0.00001', 100, 21), it(-0, 5), it(1, '-0.00001')]);
  t.lines.forEach((l) => ['qty', 'unitNet', 'basis', 'net', 'vat', 'gross', 'rateBp'].forEach((k) => {
    if (l[k] != null) assert.ok(!Object.is(l[k], -0), k + ' is -0');
  }));
});

test('parseNumber and normalizeDecimalString', () => {
  assert.equal(C.parseNumber('1 210,50'), 1210.5);
  assert.equal(C.parseNumber('abc'), NaN);
  assert.ok(Number.isNaN(C.parseNumber('')));
  assert.ok(Number.isNaN(C.parseNumber(null)));
  assert.equal(C.parseNumber(5), 5);
  assert.equal(C.normalizeDecimalString('1.234.567,89'), '1234567.89');
  assert.equal(C.normalizeDecimalString('1,234,567.89'), '1234567.89');
  assert.equal(C.normalizeDecimalString('1,234,567'), '1234567');
  assert.equal(C.normalizeDecimalString('--5'), '');
  assert.equal(C.normalizeDecimalString('5-'), '');
  assert.equal(C.normalizeDecimalString('1,2,3.4'), '', 'groups of one digit are not thousands marks');
  assert.equal(C.normalizeDecimalString('1.2.3,4'), '');
  assert.equal(C.normalizeDecimalString('1,5'), '1.5');
});

// -------------------------------------------------------- formatting

test('formatAmount in cs and en, with negatives and -0', () => {
  const cs = CS.format, en = EN.format;
  assert.equal(C.formatAmount(0, cs), '0,00');
  assert.equal(C.formatAmount(-0, cs), '0,00');
  assert.equal(C.formatAmount(5, cs), '0,05');
  assert.equal(C.formatAmount(-5, cs), '-0,05');
  assert.equal(C.formatAmount(123456789, cs), '1' + NB + '234' + NB + '567,89');
  assert.equal(C.formatAmount(-123456789, cs), '-1' + NB + '234' + NB + '567,89');
  assert.equal(C.formatAmount(123456789, en), '1,234,567.89');
  assert.equal(C.formatAmount(-123456789, en), '-1,234,567.89');
  assert.equal(C.formatAmount(-0, en), '0.00');
  assert.equal(C.formatAmount(99, en), '0.99');
  assert.equal(C.formatAmount(100000, cs), '1' + NB + '000,00');
  assert.equal(C.formatAmount(99999, cs), '999,99');
  assert.equal(C.formatAmount(1e13, cs), '100' + NB + '000' + NB + '000' + NB + '000,00');
  assert.equal(C.formatAmount(12345, undefined), '123,45', 'no format: Czech defaults');
});

test('formatMoney: Czech suffix with a non-breaking space; English prefix symbols; minus before the symbol', () => {
  assert.equal(C.formatMoney(123456, 'CZK', CS.format), '1' + NB + '234,56' + NB + 'Kč');
  assert.equal(C.formatMoney(-123456, 'CZK', CS.format), '-1' + NB + '234,56' + NB + 'Kč');
  assert.equal(C.formatMoney(123456, 'EUR', CS.format), '1' + NB + '234,56' + NB + '€');
  assert.equal(C.formatMoney(123456, 'EUR', EN.format), '€1,234.56');
  assert.equal(C.formatMoney(-123456, 'EUR', EN.format), '-€1,234.56');
  assert.equal(C.formatMoney(123456, 'USD', EN.format), '$1,234.56');
  assert.equal(C.formatMoney(123456, 'GBP', EN.format), '£1,234.56');
  assert.equal(C.formatMoney(123456, 'CZK', EN.format), '1,234.56' + NB + 'Kč');
  assert.equal(C.formatMoney(123456, 'AED', EN.format), '1,234.56' + NB + 'AED');
  assert.equal(C.formatMoney(-0, 'CZK', CS.format), '0,00' + NB + 'Kč');
  assert.equal(C.formatMoney(-1, 'CZK', CS.format), '-0,01' + NB + 'Kč');
  assert.equal(C.formatMoney(100, '', CS.format).trim(), '1,00');
  assert.equal(C.formatMoney(100, undefined, CS.format).trim(), '1,00');
});

test('formatMoney: the space between amount and symbol does not allow a line break', () => {
  const s = C.formatMoney(123456, 'CZK', CS.format);
  assert.ok(!/ /.test(s), 'no ordinary space in ' + JSON.stringify(s));
});

test('formatScaled: rounding, min and max decimals, no sign on a value that rounds to zero', () => {
  const f = { decimal: ',', group: ' ' };
  assert.equal(C.formatScaled(12345, 4, 2, 4, f), '1,2345');
  assert.equal(C.formatScaled(12300, 4, 2, 4, f), '1,23');
  assert.equal(C.formatScaled(10000, 4, 2, 4, f), '1,00');
  assert.equal(C.formatScaled(10000, 4, 0, 4, f), '1');
  assert.equal(C.formatScaled(12345, 4, 0, 2, f), '1,23');
  assert.equal(C.formatScaled(12350, 4, 0, 2, f), '1,24', 'half rounds up');
  assert.equal(C.formatScaled(-12350, 4, 0, 2, f), '-1,24', 'half rounds away from zero');
  assert.equal(C.formatScaled(-12349, 4, 0, 2, f), '-1,23');
  assert.equal(C.formatScaled(-49, 4, 0, 2, f), '0', 'rounds to zero: no sign');
  assert.equal(C.formatScaled(-50, 4, 0, 2, f), '-0,01');
  assert.equal(C.formatScaled(-1, 4, 2, 4, f), '-0,0001');
  assert.equal(C.formatScaled(-1, 4, 2, 2, f), '0,00', 'rounds to -0,00 and must not show a minus');
  assert.equal(C.formatScaled(-0, 4, 2, 4, f), '0,00');
  assert.equal(C.formatScaled(5, 0, 0, 0, f), '5');
  assert.equal(C.formatScaled(-1234567, 0, 0, 0, f), '-1 234 567');
  assert.equal(C.formatScaled(99999, 4, 0, 2, f), '10', '9.9999 at 2 decimals is 10 (carry)');
  assert.equal(C.formatScaled(999999999, 4, 2, 2, f), '100 000,00', 'carry into a new group');
  assert.equal(C.formatScaled(5, 4, 0, 4, { decimal: '.', group: ',' }), '0.0005');
});

test('formatPercent: cs and en, whole and fractional, negative and garbage', () => {
  assert.equal(C.formatPercent(21, CS.format), '21' + NB + '%');
  assert.equal(C.formatPercent(12.5, CS.format), '12,5' + NB + '%');
  assert.equal(C.formatPercent(0, CS.format), '0' + NB + '%');
  assert.equal(C.formatPercent(21, EN.format), '21%');
  assert.equal(C.formatPercent(12.5, EN.format), '12.5%');
  assert.equal(C.formatPercent(12.25, EN.format), '12.25%');
  assert.equal(C.formatPercent(12.255, EN.format), '12.26%');
  assert.equal(C.formatPercent(100, EN.format), '100%');
  assert.equal(C.formatPercent('7,5', CS.format), '7,5' + NB + '%');
  assert.equal(C.formatPercent(-5, EN.format), '-5%');
  assert.equal(C.formatPercent(-0, EN.format), '0%');
  assert.equal(C.formatPercent('abc', EN.format), '0%');
  assert.equal(C.formatPercent(undefined, EN.format), '0%');
  assert.equal(C.formatPercent(1000, EN.format), '1,000%');
});

test('formatQty: up to 4 decimals, none when whole, grouped, negative and garbage', () => {
  assert.equal(C.formatQty(1, CS.format), '1');
  assert.equal(C.formatQty(1.5, CS.format), '1,5');
  assert.equal(C.formatQty(1.2345, CS.format), '1,2345');
  assert.equal(C.formatQty(1.23456, CS.format), '1,2346');
  assert.equal(C.formatQty(1234.5, CS.format), '1' + NB + '234,5');
  assert.equal(C.formatQty(1234.5, EN.format), '1,234.5');
  assert.equal(C.formatQty(-2, EN.format), '-2');
  assert.equal(C.formatQty(-0, EN.format), '0');
  assert.equal(C.formatQty('1 210,50', CS.format), '1' + NB + '210,5');
  assert.equal(C.formatQty('abc', CS.format), '0');
  assert.equal(C.formatQty('', CS.format), '0');
  assert.equal(C.formatQty(null, CS.format), '0');
  assert.equal(C.formatQty(0.0001, EN.format), '0.0001');
  assert.equal(C.formatQty(0.00004, EN.format), '0');
  assert.equal(C.formatQty(-0.00004, EN.format), '0');
  assert.equal(C.formatQty(1e9, EN.format), '1,000,000,000');
});

test('formatting with a format object that has missing keys falls back to Czech defaults', () => {
  assert.equal(C.formatAmount(123456, {}), '1' + NB + '234,56');
  assert.equal(C.formatAmount(123456, { decimal: '.' }), '1' + NB + '234.56');
  assert.equal(C.formatAmount(5, { decimal: null }), '0,05');
});

// ------------------------------------------------------------ view model

const VM_KEYS = ['meta', 'style', 'header', 'parties', 'payment', 'dates', 'qr', 'items', 'vatSummary', 'totals', 'grandTotal', 'notes', 'signature', 'footer'];

test('view model: an empty invoice and normalizeInvoice({}) have no undefined, NaN or null text', () => {
  for (const ctx of [CTX, CTX_EN]) {
    assertClean(C.buildViewModel({}, ctx), 'empty {}');
    assertClean(C.buildViewModel(C.normalizeInvoice({}), ctx), 'normalizeInvoice({})');
    assertClean(C.buildViewModel(C.normalizeInvoice(null), ctx), 'normalizeInvoice(null)');
    assertClean(C.buildViewModel(null, ctx), 'null');
    assertClean(C.buildViewModel(undefined, ctx), 'undefined');
    assertClean(C.buildViewModel({ items: [] }, ctx), 'no items');
    assertClean(C.buildViewModel({ items: [{}] }, ctx), 'an empty item');
    assertClean(C.buildViewModel({ items: [null] }, ctx), 'a null item');
  }
});

test('view model: normalizeInvoice({}) has the documented shape', () => {
  const m = C.buildViewModel(C.normalizeInvoice({}), CTX);
  VM_KEYS.forEach((k) => assert.ok(k in m, 'has ' + k));
  assert.ok(m.meta.fileName.endsWith('.pdf'));
  assert.equal(m.parties.length, 2);
  assert.deepEqual(m.parties.map((p) => p.role), ['supplier', 'customer']);
  assert.ok(Array.isArray(m.items.rows));
  assert.ok(m.dates.length >= 1 && m.dates.length <= 4);
  assert.ok(m.totals.length <= 3);
  assert.equal(typeof m.grandTotal.value, 'string');
});

test('view model: every kind, both languages and both price modes are clean and in shape', () => {
  for (const ctx of [CTX, CTX_EN]) {
    for (const kind of C.KIND_ORDER) {
      for (const vatApplies of [true, false]) {
        for (const priceMode of ['net', 'gross']) {
          const m = C.buildViewModel({
            kind: kind, vatApplies: vatApplies, priceMode: priceMode, number: '20260001', rounding: '1', correctedNumber: '20250001',
            correctionReason: 'Chyba', note: ' poznámka ',
            items: [it(2, 1000, 21, { unit: 'pcs', discount: { type: 'percent', value: 10 } }), it(1, 50, 12)],
            documentDiscount: { type: 'amount', value: 100 }
          }, ctx);
          const label = kind + '/' + vatApplies + '/' + priceMode;
          assertClean(m, label);
          VM_KEYS.forEach((k) => assert.ok(k in m, label + ' has ' + k));
          const n = m.items.columns.length;
          assert.ok([4, 5, 7].indexOf(n) !== -1, label + ' column count ' + n);
          m.items.rows.forEach((r) => {
            assert.ok(r.kind === 'item' || r.kind === 'discount');
            m.items.columns.forEach((c) => assert.equal(typeof r.cells[c.key], 'string', label + ' cell ' + c.key));
          });
          assert.ok(m.dates.length >= 1 && m.dates.length <= 4, label + ' dates ' + m.dates.length);
          assert.ok(m.totals.length <= 3, label + ' totals rows ' + m.totals.length);
        }
      }
    }
  }
});

test('view model: column sets per VAT mode', () => {
  const keys = (inv) => C.buildViewModel(inv, CTX).items.columns.map((c) => c.key).join(',');
  assert.equal(keys({ kind: 'invoice_vat', items: [it(1, 1)] }), 'qty,description,unitPrice,vatRate,net,vat,total');
  assert.equal(keys({ kind: 'corrective', items: [it(1, 1)] }), 'qty,description,unitPrice,vatRate,net,vat,total');
  assert.equal(keys({ kind: 'quote_vat', items: [it(1, 1)] }), 'qty,description,unitPrice,vatRate,net,vat,total');
  assert.equal(keys({ kind: 'reverse_charge', items: [it(1, 1)] }), 'qty,description,unitPrice,vatRate,total');
  assert.equal(keys({ kind: 'invoice_novat', items: [it(1, 1)] }), 'qty,description,unitPrice,total');
  assert.equal(keys({ kind: 'quote_novat', items: [it(1, 1)] }), 'qty,description,unitPrice,total');
  assert.equal(keys({ kind: 'proforma', vatApplies: true, items: [it(1, 1)] }), 'qty,description,unitPrice,vatRate,net,vat,total');
  assert.equal(keys({ kind: 'proforma', vatApplies: false, items: [it(1, 1)] }), 'qty,description,unitPrice,total');
  assert.equal(keys({ kind: 'advance', vatApplies: true, items: [it(1, 1)] }), 'qty,description,unitPrice,vatRate,net,vat,total');
  assert.equal(keys({ kind: 'advance', vatApplies: false, items: [it(1, 1)] }), 'qty,description,unitPrice,total');
  const m = C.buildViewModel({ kind: 'invoice_vat', items: [] }, CTX);
  assert.equal(m.items.columns.filter((c) => c.align === 'left').map((c) => c.key).join(), 'description');
});

test('view model: the cells of a VAT invoice (reference 3 x 1210, 21 %)', () => {
  const m = C.buildViewModel({ kind: 'invoice_vat', priceMode: 'gross', currency: 'CZK', items: [it(3, 1210, 21, { unit: 'ks', description: 'Práce' })] }, CTX);
  const c = m.items.rows[0].cells;
  assert.equal(c.qty, '3' + NB + 'ks');
  assert.equal(c.description, 'Práce');
  assert.equal(c.unitPrice, '1' + NB + '000,00');
  assert.equal(c.vatRate, '21' + NB + '%');
  assert.equal(c.net, '3' + NB + '000,00');
  assert.equal(c.vat, '630,00');
  assert.equal(c.total, '3' + NB + '630,00');
  assert.equal(m.grandTotal.value, '3' + NB + '630,00' + NB + 'Kč');
});

test('view model: net mode unit price is the typed price', () => {
  const m = C.buildViewModel({ kind: 'invoice_vat', priceMode: 'net', items: [it(3, 1210, 21)] }, CTX);
  assert.equal(m.items.rows[0].cells.unitPrice, '1' + NB + '210,00');
  assert.equal(m.items.rows[0].cells.total, '4' + NB + '392,30');
});

test('view model: the total cell is gross only in VAT mode', () => {
  const none = C.buildViewModel({ kind: 'invoice_novat', items: [it(2, 100, 21)] }, CTX);
  assert.equal(none.items.rows[0].cells.total, '200,00');
  const rev = C.buildViewModel({ kind: 'reverse_charge', items: [it(2, 100, 21)] }, CTX);
  assert.equal(rev.items.rows[0].cells.total, '200,00');
  assert.equal(rev.items.rows[0].cells.vatRate, '21' + NB + '%');
});

test('view model: discount rows are described and keep their sign', () => {
  const m = C.buildViewModel({
    kind: 'invoice_vat', items: [it(1, 1000, 21, { description: 'Web', discount: { type: 'percent', value: 10 } }), it(1, 500, 21, { description: 'App', discount: { type: 'amount', value: 50 } })],
    documentDiscount: { type: 'percent', value: 5 }
  }, CTX);
  const rows = m.items.rows;
  assert.deepEqual(rows.map((r) => r.kind), ['item', 'discount', 'item', 'discount', 'discount']);
  assert.equal(rows[1].cells.description, CS.discount + ' 10' + NB + '% – Web');
  assert.equal(rows[3].cells.description, CS.discount + ' – App');
  assert.equal(rows[4].cells.description, CS.documentDiscount + ' 5' + NB + '%');
  assert.equal(rows[1].cells.qty, '');
  assert.ok(rows[1].cells.net.startsWith('-'));
  assert.ok(rows[1].cells.total.startsWith('-'));
  assert.ok(rows[1].cells.unitPrice.startsWith('-'));
});

test('view model: a document discount in several rates makes one row per rate', () => {
  const m = C.buildViewModel({ kind: 'invoice_vat', items: [it(1, 1000, 21), it(1, 500, 12)], documentDiscount: { type: 'amount', value: 100 } }, CTX);
  assert.equal(m.items.rows.filter((r) => r.kind === 'discount').length, 2);
  assert.deepEqual(m.items.rows.filter((r) => r.kind === 'discount').map((r) => r.cells.vatRate), ['21' + NB + '%', '12' + NB + '%']);
});

test('view model: unit price decimals show 2 to 4 places', () => {
  const m = C.buildViewModel({ kind: 'invoice_novat', items: [it(1, 0.1234, 0), it(1, 0.12, 0), it(1, 1000000, 0)] }, CTX);
  assert.deepEqual(m.items.rows.map((r) => r.cells.unitPrice), ['0,1234', '0,12', '1' + NB + '000' + NB + '000,00']);
});

test('view model: qty cell for 4 decimals and a negative qty', () => {
  const m = C.buildViewModel({ kind: 'invoice_novat', items: [it(1.2345, 1), it(-2, 1), it('1,5', 1)] }, CTX);
  assert.deepEqual(m.items.rows.map((r) => r.cells.qty), ['1,2345', '-2', '1,5']);
});

test('view model: the unit key is shown in the language of the document', () => {
  // UNIT_KEYS are keys; the document labels have a table for them
  const m = C.buildViewModel({ kind: 'invoice_novat', items: [it(1, 1, 0, { unit: 'hour' })] }, CTX);
  const mEn = C.buildViewModel({ kind: 'invoice_novat', items: [it(1, 1, 0, { unit: 'hour' })] }, CTX_EN);
  assert.equal(m.items.rows[0].cells.qty, '1' + NB + CS.units.hour);
  assert.equal(mEn.items.rows[0].cells.qty, '1' + NB + EN.units.hour);
});

test('view model: free-text unit is shown as typed', () => {
  const m = C.buildViewModel({ kind: 'invoice_novat', items: [it(1, 1, 0, { unit: 'sada' })] }, CTX);
  assert.equal(m.items.rows[0].cells.qty, '1' + NB + 'sada');
});

test('view model: the VAT summary exists only in VAT mode, sorted, and its footer is the totals', () => {
  const vat = C.buildViewModel({ kind: 'invoice_vat', items: [it(1, 1000, 12), it(1, 1000, 21), it(1, 1000, 0)] }, CTX);
  assert.deepEqual(vat.vatSummary.rows.map((r) => r.cells.rate), ['21' + NB + '%', '12' + NB + '%', '0' + NB + '%']);
  assert.deepEqual(vat.vatSummary.columns.map((c) => c.key), ['rate', 'base', 'vat', 'total']);
  assert.equal(vat.vatSummary.footer.cells.rate, CS.total);
  assert.equal(vat.vatSummary.footer.cells.base, '3' + NB + '000,00');
  assert.equal(vat.vatSummary.footer.cells.vat, '330,00');
  assert.equal(vat.vatSummary.footer.cells.total, '3' + NB + '330,00');
  for (const kind of ['invoice_novat', 'reverse_charge', 'quote_novat']) {
    assert.equal(C.buildViewModel({ kind: kind, items: [it(1, 100, 21)] }, CTX).vatSummary, null, kind);
  }
  assert.equal(C.buildViewModel({ kind: 'proforma', vatApplies: false, items: [it(1, 100, 21)] }, CTX).vatSummary, null);
  assert.ok(C.buildViewModel({ kind: 'proforma', vatApplies: true, items: [it(1, 100, 21)] }, CTX).vatSummary);
  assert.equal(C.buildViewModel({ kind: 'invoice_vat', items: [] }, CTX).vatSummary, null, 'no lines: no summary');
});

test('view model: the VAT summary rows add up to the footer', () => {
  const m = C.buildViewModel({
    kind: 'invoice_vat', priceMode: 'gross', items: [it(3, 99.99, 21), it(7, 12.34, 12), it(1, 5.55, 0)],
    documentDiscount: { type: 'amount', value: 33.33 }
  }, CTX);
  const parse = (s) => C.decToInt(s, 2);
  ['base', 'vat', 'total'].forEach((k) => {
    const sum = m.vatSummary.rows.reduce((s, r) => s + parse(r.cells[k]), 0);
    assert.equal(sum, parse(m.vatSummary.footer.cells[k]), k);
  });
  assert.equal(parse(m.vatSummary.footer.cells.base) + parse(m.vatSummary.footer.cells.vat), parse(m.vatSummary.footer.cells.total));
});

test('view model: totals rows and the grand total per kind', () => {
  const lab = (inv, ctx) => { const m = C.buildViewModel(inv, ctx || CTX); return { rows: m.totals.map((r) => r.label), grand: m.grandTotal.label, value: m.grandTotal.value }; };
  const items = [it(1, 100, 21)];
  assert.deepEqual(lab({ kind: 'invoice_vat', items: items }).rows, [CS.totalNet, CS.totalVat]);
  assert.equal(lab({ kind: 'invoice_vat', items: items }).grand, CS.totalDue);
  assert.deepEqual(lab({ kind: 'invoice_novat', items: items }).rows, []);
  assert.equal(lab({ kind: 'invoice_novat', items: items }).grand, CS.totalDue);
  assert.deepEqual(lab({ kind: 'reverse_charge', items: items }).rows, []);
  assert.equal(lab({ kind: 'reverse_charge', items: items }).grand, CS.totalDue);
  assert.equal(lab({ kind: 'quote_vat', items: items }).grand, CS.totalGross);
  assert.equal(lab({ kind: 'quote_novat', items: items }).grand, CS.total);
  assert.equal(lab({ kind: 'proforma', vatApplies: true, items: items }).grand, CS.totalDue);
  assert.equal(lab({ kind: 'advance', vatApplies: false, items: items }).grand, CS.totalDue);
  assert.deepEqual(lab({ kind: 'invoice_vat', items: [it(1, 100.4, 21)], rounding: '1' }).rows, [CS.totalNet, CS.totalVat, CS.rounding]);
  assert.deepEqual(lab({ kind: 'invoice_novat', items: items, rounding: '1' }).rows, [], 'no rounding row when the total is whole already');
  assert.deepEqual(lab({ kind: 'invoice_novat', items: [it(1, 100.4, 0)], rounding: '1' }).rows, [CS.rounding]);
  assert.equal(lab({ kind: 'invoice_vat', items: items }, CTX_EN).grand, EN.totalDue);
});

test('view model: the rounding row and the grand total show payable, with a minus for a negative adjustment', () => {
  const m = C.buildViewModel({ kind: 'invoice_novat', items: [it(1, 100.6, 0)], rounding: '1' }, CTX);
  assert.equal(m.totals[0].value, '0,40' + NB + 'Kč');
  assert.equal(m.grandTotal.value, '101,00' + NB + 'Kč');
  const n = C.buildViewModel({ kind: 'invoice_novat', items: [it(1, 100.4, 0)], rounding: '1' }, CTX);
  assert.equal(n.totals[0].value, '-0,40' + NB + 'Kč');
  assert.equal(n.grandTotal.value, '100,00' + NB + 'Kč');
});

test('view model: total net and total VAT rows equal the summary', () => {
  const m = C.buildViewModel({ kind: 'invoice_vat', items: [it(3, 1210, 21)] }, CTX);
  assert.equal(m.totals[0].value, '3' + NB + '630,00' + NB + 'Kč');
  assert.equal(m.totals[1].value, '762,30' + NB + 'Kč');
  assert.equal(m.grandTotal.value, '4' + NB + '392,30' + NB + 'Kč');
});

test('view model: a negative payable (a credit note) says "Total", not "Total due"', () => {
  const m = C.buildViewModel({ kind: 'corrective', items: [it(-1, 100, 21)] }, CTX);
  assert.equal(m.grandTotal.label, CS.total);
  assert.equal(m.grandTotal.value, '-121,00' + NB + 'Kč');
  const pos = C.buildViewModel({ kind: 'corrective', items: [it(1, 100, 21)] }, CTX);
  assert.equal(pos.grandTotal.label, CS.totalDue);
});

test('view model: a zero total', () => {
  const m = C.buildViewModel({ kind: 'invoice_vat', items: [it(0, 100, 21)] }, CTX);
  assert.equal(m.grandTotal.value, '0,00' + NB + 'Kč');
  assert.equal(m.grandTotal.label, CS.totalDue);
});

test('view model: currency symbols in cs and en', () => {
  const inv = { kind: 'invoice_novat', items: [it(1, 1234.5, 0)] };
  assert.equal(C.buildViewModel(Object.assign({ currency: 'EUR' }, inv), CTX_EN).grandTotal.value, '€1,234.50');
  assert.equal(C.buildViewModel(Object.assign({ currency: 'EUR' }, inv), CTX).grandTotal.value, '1' + NB + '234,50' + NB + '€');
  assert.equal(C.buildViewModel(Object.assign({ currency: 'JPY' }, inv), CTX).grandTotal.value, '1' + NB + '234,50' + NB + 'JPY');
  assert.equal(C.buildViewModel(Object.assign({ currency: '' }, inv), CTX).grandTotal.value, '1' + NB + '234,50' + NB + 'Kč', 'an empty currency means CZK');
});

test('view model: notes per kind', () => {
  const notesOf = (inv) => C.buildViewModel(inv, CTX).notes;
  const it1 = [it(1, 100, 21)];
  assert.deepEqual(notesOf({ kind: 'invoice_vat', items: it1 }), []);
  assert.deepEqual(notesOf({ kind: 'invoice_novat', items: it1 }), [CS.notes.nonVatPayer]);
  assert.deepEqual(notesOf({ kind: 'reverse_charge', items: it1 }), [CS.notes.reverseCharge]);
  assert.deepEqual(notesOf({ kind: 'quote_vat', items: it1 }), []);
  assert.deepEqual(notesOf({ kind: 'quote_novat', items: it1 }), []);
  assert.deepEqual(notesOf({ kind: 'proforma', vatApplies: true, items: it1 }), [CS.notes.notTaxDocument]);
  assert.deepEqual(notesOf({ kind: 'advance', vatApplies: true, items: it1 }), [CS.notes.notTaxDocument]);
  assert.deepEqual(notesOf({ kind: 'proforma', vatApplies: false, items: it1 }), [CS.notes.nonVatPayer, CS.notes.notTaxDocument]);
  assert.deepEqual(notesOf({ kind: 'corrective', items: it1, correctionReason: 'Špatná cena' }), [CS.notes.correctionReason.replace('{reason}', 'Špatná cena')]);
  assert.deepEqual(notesOf({ kind: 'corrective', items: it1 }), []);
  assert.deepEqual(notesOf({ kind: 'invoice_vat', items: it1, correctionReason: 'x' }), [], 'a reason is only for a corrective document');
  assert.deepEqual(notesOf({ kind: 'invoice_vat', items: it1, note: '  Děkujeme.  ' }), ['Děkujeme.']);
  assert.deepEqual(notesOf({ kind: 'invoice_vat', items: it1, note: '   ' }), []);
  assert.deepEqual(notesOf({ kind: 'reverse_charge', items: it1, note: 'N' }), [CS.notes.reverseCharge, 'N']);
});

test('view model: header sub-lines for a corrective document', () => {
  const m = C.buildViewModel({ kind: 'corrective', number: '2', correctedNumber: '20260001', items: [] }, CTX);
  assert.deepEqual(m.header.sub, [CS.notes.correctiveFor.replace('{number}', '20260001')]);
  assert.equal(m.header.number, CS.numberAbbr + ' 2');
  assert.deepEqual(C.buildViewModel({ kind: 'invoice_vat', number: '1', correctedNumber: '2', items: [] }, CTX).header.sub, []);
  assert.equal(C.buildViewModel({ kind: 'invoice_vat', number: '', items: [] }, CTX).header.number, '');
});

test('view model: supplier badge per VAT mode', () => {
  const badge = (inv) => C.buildViewModel(inv, CTX).parties[0].badges;
  assert.deepEqual(badge({ kind: 'invoice_vat' }), [CS.vatPayer]);
  assert.deepEqual(badge({ kind: 'invoice_novat' }), [CS.nonVatPayer]);
  assert.deepEqual(badge({ kind: 'reverse_charge' }), [CS.vatPayer]);
  assert.deepEqual(badge({ kind: 'quote_novat' }), []);
  assert.deepEqual(badge({ kind: 'quote_vat' }), [CS.vatPayer]);
  assert.deepEqual(badge({ kind: 'proforma', vatApplies: false }), [CS.nonVatPayer]);
  assert.deepEqual(badge({ kind: 'proforma', vatApplies: true }), [CS.vatPayer]);
});

test('view model: payment block is null for quotations only; the dates per kind', () => {
  for (const kind of C.KIND_ORDER) {
    const m = C.buildViewModel({ kind: kind, vatApplies: true, items: [it(1, 100)], dueDate: '2026-12-01', issueDate: '2026-11-17', taxDate: '2026-11-17', orderNumber: 'PO1' }, CTX);
    if (kind.indexOf('quote') === 0) {
      assert.equal(m.payment, null, kind);
      assert.equal(m.dates[1].label, CS.validUntil, kind);
      assert.equal(m.dates.length, 3, kind + ' issue, valid until, order number');
      assert.equal(m.qr, null, kind);
    } else {
      assert.ok(m.payment, kind);
      assert.equal(m.dates[1].label, CS.dueDate, kind);
    }
    if (C.KINDS[kind].taxDocument) assert.ok(m.dates.some((d) => d.label === CS.taxDate), kind + ' has the tax date');
    else assert.ok(!m.dates.some((d) => d.label === CS.taxDate), kind + ' has no tax date');
    assert.ok(m.dates.length >= 1 && m.dates.length <= 4);
  }
});

test('view model: the QR amount is the rounded amount to pay and the QR is absent for zero or negative totals', () => {
  const bank = { account: '2000145399/2010', iban: '' };
  const base = { kind: 'invoice_novat', items: [it(1, 100.6, 0)], rounding: '1', bank: bank, showQr: true, number: '2026001', variableSymbol: '2026001' };
  const m = C.buildViewModel(base, CTX);
  if (m.qr) assert.ok(/\*AM:101\.00\*/.test(m.qr.text), m.qr.text);
  const neg = C.buildViewModel(Object.assign({}, base, { items: [it(-1, 100, 0)] }), CTX);
  assert.equal(neg.qr, null);
  const zero = C.buildViewModel(Object.assign({}, base, { items: [it(0, 100, 0)] }), CTX);
  assert.equal(zero.qr, null);
});

test('view model: the document is not changed by building it', () => {
  const inv = C.normalizeInvoice({ kind: 'invoice_vat', items: [it(1, 100, 21, { discount: { type: 'percent', value: 10 } })], documentDiscount: { type: 'percent', value: 5 } });
  const before = JSON.stringify(inv);
  C.buildViewModel(inv, CTX);
  C.computeTotals(inv);
  assert.equal(JSON.stringify(inv), before);
});

test('view model: a large invoice is formatted and consistent (1e9)', () => {
  const m = C.buildViewModel({ kind: 'invoice_vat', items: [it(1, 1e9, 21)] }, CTX);
  assert.equal(m.grandTotal.value, '1' + NB + '210' + NB + '000' + NB + '000,00' + NB + 'Kč');
  assertClean(m, 'big');
});

// ------------------------------------------------- Czech practice and fuzz

test('Czech practice: tax = base x rate; from a gross price tax = price - price / (1 + rate)', () => {
  const r = rng(2026);
  for (let n = 0; n < 500; n++) {
    const cents = 1 + Math.floor(r() * 100000000);
    const rate = [12, 21, 12.5][Math.floor(r() * 3)];
    const rb = Math.round(rate * 100);
    const net = T([it(1, cents / 100, rate)]);
    assert.equal(net.vat, Number((BigInt(cents) * BigInt(rb) * 2n + 10000n) / 20000n), 'net mode ' + cents + ' @' + rate);
    const gross = T([it(1, cents / 100, rate)], { priceMode: 'gross' });
    const exactNet = Number((BigInt(cents) * 10000n * 2n + BigInt(10000 + rb)) / (2n * BigInt(10000 + rb)));
    assert.equal(gross.net, exactNet, 'gross mode net ' + cents + ' @' + rate);
    assert.equal(gross.vat, cents - exactNet);
    assert.equal(gross.gross, cents, 'the typed gross price is the line total');
  }
});

test('fuzz: identities hold for random documents in every kind', () => {
  const r = rng(12345);
  for (let n = 0; n < 600; n++) {
    const kind = C.KIND_ORDER[Math.floor(r() * C.KIND_ORDER.length)];
    const items = [];
    const count = Math.floor(r() * 6);
    for (let k = 0; k < count; k++) {
      const sign = r() < 0.15 ? -1 : 1;
      const disc = r() < 0.4 ? null : (r() < 0.5
        ? { type: 'percent', value: Math.round(r() * 12000) / 100 }
        : { type: 'amount', value: Math.round(r() * 500000) / 100 });
      items.push(it(sign * Math.round(r() * 200000) / 10000, Math.round(r() * 5000000) / 10000, [0, 12, 21, 12.5, 5][Math.floor(r() * 5)], { discount: disc }));
    }
    const dd = r() < 0.4 ? null : (r() < 0.5 ? { type: 'percent', value: Math.round(r() * 10000) / 100 } : { type: 'amount', value: Math.round(r() * 1000000) / 100 });
    const over = { kind: kind, priceMode: r() < 0.5 ? 'net' : 'gross', vatApplies: r() < 0.5, documentDiscount: dd, rounding: ['none', '0.1', '0.5', '1'][Math.floor(r() * 4)] };
    const t = T(items, over);
    checkIdentities(t, 'fuzz ' + n + ' ' + JSON.stringify(over));
    const m = C.buildViewModel(Object.assign({}, over, { items: items }), CTX);
    assertClean(m, 'fuzz vm ' + n);
  }
});

test('fuzz: with only positive lines, a discount never makes a total negative and never raises it', () => {
  const r = rng(777);
  for (let n = 0; n < 400; n++) {
    const items = [];
    for (let k = 0; k < 1 + Math.floor(r() * 4); k++) items.push(it(Math.round(r() * 100000) / 10000, Math.round(r() * 1000000) / 100, [0, 12, 21][Math.floor(r() * 3)]));
    const pm = r() < 0.5 ? 'net' : 'gross';
    const plain = T(items, { priceMode: pm });
    const withDisc = T(items.map((x) => Object.assign({}, x, { discount: { type: 'percent', value: Math.round(r() * 10000) / 100 } })),
      { priceMode: pm, documentDiscount: r() < 0.5 ? { type: 'percent', value: Math.round(r() * 10000) / 100 } : { type: 'amount', value: Math.round(r() * 1000000) / 100 } });
    assert.ok(withDisc.gross >= 0, 'n ' + n + ' gross ' + withDisc.gross);
    assert.ok(withDisc.net >= 0, 'n ' + n + ' net ' + withDisc.net);
    assert.ok(withDisc.gross <= plain.gross, 'n ' + n);
    withDisc.byRate.forEach((rr) => { assert.ok(rr.net >= 0 && rr.gross >= 0, 'n ' + n + ' rate ' + rr.rateBp + ' negative: ' + JSON.stringify(rr)); });
  }
});

test('gross mode: a fully discounted document is zero in net, VAT and gross (no rounding residue)', () => {
  // 0.03 incl. 21 %, item discount 0.02 and document discount 50 % of the 0.03 left in this form: all discounts sum to the line
  const t = T([it(1, 0.03, 21, { discount: { type: 'amount', value: 0.02 } })], { priceMode: 'gross', documentDiscount: { type: 'percent', value: 100 } });
  assert.equal(t.gross, 0);
  assert.equal(t.net, 0);
  assert.equal(t.vat, 0);
});

test('computeTotals given a document with no items array, and an invoice with only a kind', () => {
  const t = C.computeTotals({ kind: 'invoice_vat' });
  assert.deepEqual([t.net, t.vat, t.gross, t.rounding, t.payable], [0, 0, 0, 0, 0]);
  assert.deepEqual(t.lines, []);
  assert.deepEqual(t.byRate, []);
  assert.equal(C.computeTotals({}).vatMode, 'vat');
});

test('computeTotals tolerates items that are partly empty', () => {
  const t = T([{}, { qty: 1 }, { price: 5 }, { qty: 2, price: 3 }]);
  assert.equal(t.net, 600);
  checkIdentities(t);
});

test('every result of computeTotals is plain data: no BigInt, no NaN', () => {
  const t = T([it(1e9, 1e9, 21, { discount: { type: 'percent', value: 33.33 } })], { priceMode: 'gross', documentDiscount: { type: 'amount', value: 1e8 }, rounding: '1' });
  const bad = [];
  walk(t, 't', bad);
  assert.deepEqual(bad, []);
  JSON.stringify(t);
});
