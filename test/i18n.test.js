'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const I18n = require(path.join(__dirname, '..', 'i18n.js'));
const extra = require(path.join(__dirname, '..', 'i18n-extra.js'));
const Core = require(path.join(__dirname, '..', 'core.js'));

const LANGS = ['sk', 'de', 'pl', 'uk', 'fr', 'es', 'nl', 'sr'];
const cs = I18n.get('cs');

function walk(obj, prefix, out) {
  for (const k of Object.keys(obj)) {
    const p = prefix ? prefix + '.' + k : k;
    const v = obj[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, p, out);
    else out[p] = v;
  }
  return out;
}
const csFlat = walk(cs, '', {});
const placeholders = (s) => (typeof s === 'string' ? (s.match(/\{\w+\}/g) || []).sort() : []);

test('all eight languages are registered', () => {
  assert.deepStrictEqual(extra.codes, LANGS);
  const codes = I18n.list().map((x) => x.code);
  for (const l of LANGS) assert.ok(codes.includes(l), l);
});

for (const lang of LANGS) {
  const t = I18n.get(lang);
  const flat = walk(t, '', {});

  test(lang + ': same key set and nesting as cs', () => {
    assert.notStrictEqual(t, cs);
    assert.deepStrictEqual(Object.keys(flat).sort(), Object.keys(csFlat).sort());
    // same nesting shape, deep
    const shape = (o) => JSON.stringify(Object.keys(o).sort().map((k) =>
      [k, o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) ? shape(o[k]) : typeof o[k]]));
    assert.strictEqual(shape(t.format).length > 0, true);
    for (const k of Object.keys(cs)) {
      const a = cs[k], b = t[k];
      assert.strictEqual(typeof b, typeof a, k);
      if (a && typeof a === 'object' && !Array.isArray(a) && k !== 'format') assert.strictEqual(shape(b), shape(a), k);
    }
    assert.deepStrictEqual(Object.keys(t.format).filter((k) => k !== 'months').sort(),
      Object.keys(cs.format).filter((k) => k !== 'months').sort());
  });

  test(lang + ': no empty strings', () => {
    for (const [k, v] of Object.entries(flat)) {
      if (typeof v === 'string' && k !== 'format.group') assert.ok(v.trim().length > 0, k);
    }
    assert.ok(t.languageName.trim());
    assert.strictEqual(typeof t.format.decimal, 'string');
    assert.ok(t.format.decimal.length === 1);
    assert.ok(t.format.group.length === 1);
    assert.notStrictEqual(t.format.decimal, t.format.group);
  });

  test(lang + ': every placeholder of cs is present', () => {
    for (const [k, v] of Object.entries(csFlat)) {
      const need = placeholders(v);
      if (!need.length) continue;
      assert.deepStrictEqual(placeholders(flat[k]), need, k);
    }
    assert.ok(t.format.percent.includes('{n}'));
  });

  test(lang + ': date pattern uses only tokens core.js knows', () => {
    const rest = t.format.date.replace(/YYYY|MMM|MM|M|DD|D/g, '');
    assert.ok(!/[A-Za-z]/.test(rest), 'stray letters: ' + rest);
    if (/MMM/.test(t.format.date)) {
      assert.ok(Array.isArray(t.format.months) && t.format.months.length === 12);
      t.format.months.forEach((m) => assert.ok(typeof m === 'string' && m.length > 0));
    }
    const out = Core.formatDate('2026-03-07', t.format);
    assert.ok(/2026/.test(out) && !/[A-Za-z]{4}/.test(out), out);
  });

  const base = () => ({
    issueDate: '2026-03-07', taxDate: '2026-03-07', dueDate: '2026-03-21', number: '20260001',
    variableSymbol: '20260001', constantSymbol: '0308', specificSymbol: '12', orderNumber: 'PO-1',
    language: lang, currency: 'EUR', priceMode: 'net', note: '',
    supplier: { name: 'Dodavatel s.r.o.', street: 'Ulice 1', city: 'Praha', postcode: '11000', country: 'CZ', companyNumber: '12345678', taxNumber: 'CZ12345678' },
    customer: { name: 'Customer GmbH', street: 'Strasse 2', city: 'Berlin', postcode: '10115', country: 'DE' },
    bank: { account: '123456789/0100', iban: 'CZ6508000000192000145399', showIban: true },
    items: [
      { qty: 3, unit: 'pcs', description: 'Služba', vatRate: 21, price: 1210, discount: { type: 'percent', value: 10 } },
      { qty: 1, unit: 'hour', description: 'Práce', vatRate: 12, price: 100, discount: null }
    ],
    documentDiscount: { type: 'percent', value: 5 }
  });
  const modes = [
    ['invoice_vat (vat)', { kind: 'invoice_vat', vatApplies: true }],
    ['invoice_novat (none)', { kind: 'invoice_novat', vatApplies: false }],
    ['reverse_charge (reverse)', { kind: 'reverse_charge', vatApplies: true }],
    ['corrective', { kind: 'corrective', vatApplies: true, correctedNumber: '20250099', correctionReason: 'x' }],
    ['quote_vat', { kind: 'quote_vat', vatApplies: true }],
    ['proforma', { kind: 'proforma', vatApplies: true }],
    ['advance', { kind: 'advance', vatApplies: false }]
  ];
  for (const [name, over] of modes) {
    test(lang + ': buildViewModel works for ' + name, () => {
      const inv = Object.assign(base(), over);
      const vm = Core.buildViewModel(inv, { labels: t, countryName: (c) => c, images: {} });
      assert.ok(vm.header.title && vm.header.title.length > 0);
      assert.strictEqual(vm.parties.length, 2);
      assert.ok(vm.grandTotal.label && vm.grandTotal.value);
      assert.ok(vm.items.columns.length >= 4);
      assert.ok(vm.items.columns.every((c) => c.label && c.label.trim()));
      assert.ok(vm.dates.every((d) => d.label && d.value));
      assert.ok(vm.footer.pageTemplate.includes('{page}'));
      const text = JSON.stringify(vm);
      assert.ok(!/undefined|NaN|\{number\}|\{reason\}|\{n\}/.test(text));
      if (name.startsWith('invoice_novat')) assert.ok(vm.parties[0].badges.includes(t.nonVatPayer));
      if (name.startsWith('invoice_vat')) assert.ok(vm.parties[0].badges.includes(t.vatPayer));
    });
  }
}
