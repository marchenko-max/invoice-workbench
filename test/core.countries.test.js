'use strict';
// A company outside the Czech Republic: what its tax is called and at what rates, what its numbers are called,
// and how its bank account is written.   node --test test/core.countries.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');
const I18n = require('../i18n.js');
require('../i18n-extra.js');

function company(country, over) {
  const c = C.newCompany('supplier');
  c.name = 'Made-up Co';
  c.country = country;
  C.followCountry(c, 'CZ');          // what the company dialog does when the country is picked
  c.vatPayer = true;
  return Object.assign(c, over || {});
}
function vmOf(supplier, over, language) {
  const inv = C.newInvoice(supplier, { today: '2026-11-18' });
  inv.items[0].price = 1000;
  inv.items[0].description = 'Work';
  inv.customer.name = 'Customer';
  inv.language = language || supplier.defaults.language;
  Object.assign(inv, over || {});
  const vm = C.buildViewModel(inv, { labels: I18n.get(inv.language), countryName: function (c) { return c; }, images: {} });
  vm.invoice = inv;
  return vm;
}
const labels = function (rows) { return rows.map(function (r) { return r.label; }); };
const valueOf = function (rows, label) { const r = rows.filter(function (x) { return x.label === label; })[0]; return r ? r.value : undefined; };

test('a country’s profile: tax, rates and the way a bank account is written', function () {
  assert.deepEqual([C.countryProfile('CZ').tax, C.countryProfile('CZ').bank], ['vat', 'cz']);
  assert.deepEqual(C.taxRatesFor('CZ'), [21, 12, 0]);
  assert.deepEqual(C.taxRatesFor('UA'), [20, 14, 7, 0]);
  assert.deepEqual(C.taxRatesFor('SK'), [23, 19, 5, 0]);
  assert.deepEqual([C.countryProfile('US').tax, C.countryProfile('US').bank, C.taxRatesFor('US')], ['sales', 'us', []]);
  assert.deepEqual([C.countryProfile('JP').tax, C.countryProfile('JP').bank, C.taxRatesFor('JP')], ['vat', 'iban', []]);
  assert.equal(C.countryProfile(''), C.countryProfile('CZ'), 'a record with no country is a Czech one');
  assert.equal(C.countryProfile('ua'), C.countryProfile('UA'));
  const rates = C.taxRatesFor('CZ');
  rates.push(99);
  assert.deepEqual(C.taxRatesFor('CZ'), [21, 12, 0], 'the list handed out is a copy');
});

test('the rate a new line starts with: the company’s own, else its country’s standard one', function () {
  assert.equal(C.defaultTaxRate(company('CZ')), 21);
  assert.equal(C.defaultTaxRate(company('UA')), 20);
  assert.equal(C.defaultTaxRate(company('US')), 0);
  const texas = company('US');
  texas.defaults.taxRate = '8.25';
  assert.equal(C.defaultTaxRate(texas), 8.25);
  assert.equal(C.newInvoice(texas, { today: '2026-11-18' }).items[0].vatRate, 8.25);
  const zero = company('CZ');
  zero.defaults.taxRate = 0;
  assert.equal(C.defaultTaxRate(zero), 0, 'a zero someone typed is a rate');
  zero.defaults.taxRate = '  ';
  assert.equal(C.defaultTaxRate(zero), 21, 'an empty field is not');
  assert.equal(C.newInvoice(company('UA', { vatPayer: false }), { today: '2026-11-18' }).items[0].vatRate, 0);
});

test('a US routing number is checked by its weights', function () {
  assert.equal(C.validateRouting('021000021'), true);
  assert.equal(C.validateRouting('0210-0002 1'), true);
  assert.equal(C.validateRouting('021000022'), false);
  assert.equal(C.validateRouting('12345678'), false);
  assert.equal(C.validateRouting('000000000'), false);
  assert.equal(C.validateRouting(''), false);
});

test('how an account is written follows its kind, and an older record is read from what it holds', function () {
  assert.equal(C.bankKind({ kind: 'us', account: '1' }, 'CZ'), 'us');
  assert.equal(C.bankKind({ account: '19-2000145399/0800' }, 'UA'), 'cz');
  assert.equal(C.bankKind({ iban: 'UA21 3223 1300 0002 6007 2335 6600 1' }, 'CZ'), 'iban');
  assert.equal(C.bankKind({ account: '12345', routing: '021000021' }, 'CZ'), 'us');
  assert.equal(C.bankKind({}, 'US'), 'us');
  assert.equal(C.bankKind({}, 'UA'), 'iban');
  assert.equal(C.bankKind({}, ''), 'cz');
  assert.equal(C.bankKind({ kind: 'nonsense' }, 'DE'), 'iban');
});

test('a Czech company’s document is what it was', function () {
  const vm = vmOf(company('CZ', { companyNumber: '27082440', taxNumber: 'CZ27082440' }), { taxDate: '2026-11-18' });
  assert.deepEqual(labels(vm.parties[0].ids), ['IČO', 'DIČ']);
  assert.deepEqual(vm.parties[0].badges, ['Plátce DPH']);
  assert.deepEqual(labels(vm.totals).slice(0, 2), ['Celkem bez DPH', 'DPH']);
  assert.ok(vm.dates.some(function (d) { return d.label === I18n.get('cs').taxDate; }));
});

test('a US company: a subtotal, sales tax and a total, with no VAT wording anywhere', function () {
  const us = company('US', { companyNumber: '12-3456789' });
  us.defaults.taxRate = '8.25';
  us.bank = Object.assign(C.emptyBank(), { bankName: 'First Made-up Bank', routing: '021000021', account: '000123456789', accountName: 'Made-up Co LLC', swift: 'madeus33' });
  const vm = vmOf(us, { taxDate: '2026-11-18' });
  assert.equal(vm.invoice.language, 'en');
  assert.equal(vm.invoice.currency, 'USD');
  assert.equal(vm.header.title.toLowerCase(), 'invoice', 'no "tax document" in the title');
  assert.deepEqual(vm.parties[0].ids, [{ label: 'EIN', value: '12-3456789' }]);
  assert.deepEqual(vm.parties[0].badges, []);
  assert.deepEqual(labels(vm.totals), ['Subtotal', 'Sales tax']);
  assert.deepEqual(vm.totals.map(function (r) { return r.value; }), ['$1,000.00', '$82.50']);
  assert.equal(vm.grandTotal.value, '$1,082.50');
  assert.deepEqual(vm.items.columns.map(function (c) { return c.label; }), ['Qty', 'Description', 'Unit price', 'Tax rate', 'Net', 'Sales tax', 'Total']);
  assert.deepEqual(vm.vatSummary.columns.map(function (c) { return c.label; }), ['Tax rate', 'Taxable amount', 'Sales tax', 'Total']);
  assert.equal(vm.dates.some(function (d) { return d.label === I18n.get('en').taxDate; }), false, 'no date of taxable supply');
  assert.deepEqual(labels(vm.payment.rows).slice(0, 4), ['Bank', 'ABA routing no.', 'Bank account', 'SWIFT/BIC']);
  assert.equal(labels(vmOf(us, null, 'cs').payment.rows)[1], 'Směrovací číslo (ABA)', 'the routing number is named in the document\u2019s language');
  assert.equal(valueOf(vm.payment.rows, 'ABA routing no.'), '021000021');
  assert.equal(valueOf(vm.payment.rows, 'Bank account'), '000123456789 (Made-up Co LLC)');
  assert.equal(valueOf(vm.payment.rows, 'SWIFT/BIC'), 'MADEUS33');
  assert.equal(vm.qr, null, 'no payment code for an account with no IBAN');
  assert.equal(labels(vm.payment.rows).indexOf('Variable symbol'), -1, 'and no Czech payment symbol');
  const text = JSON.stringify(vm);
  assert.equal(/VAT/.test(text.replace(/"invoice":.*$/, '')), false, 'the word VAT is nowhere on the page');
});

test('a US company that charges no tax: no tax lines, and no note about VAT', function () {
  const vm = vmOf(company('US', { vatPayer: false }));
  assert.equal(vm.invoice.kind, 'invoice_novat');
  assert.deepEqual(vm.totals, []);
  assert.equal(vm.notes.some(function (n) { return /VAT/.test(n); }), false);
  assert.deepEqual(vm.parties[0].badges, []);
});

test('a Ukrainian company: its codes by their own names, an IBAN, 20 % ПДВ', function () {
  const ua = company('UA', { companyNumber: '12345678', taxNumber: '123456789012' });
  ua.bank = Object.assign(C.emptyBank(), { iban: 'UA213223130000026007233566001', bankName: 'Вигаданий банк', swift: 'MADEUAUK' });
  const vm = vmOf(ua);
  assert.equal(vm.invoice.language, 'uk');
  assert.equal(vm.invoice.currency, 'UAH');
  assert.equal(vm.invoice.items[0].vatRate, 20);
  assert.deepEqual(labels(vm.parties[0].ids), ['ЄДРПОУ', 'ІПН']);
  assert.deepEqual(vm.parties[0].badges, ['Платник ПДВ']);
  assert.deepEqual(labels(vm.payment.rows).slice(0, 3), ['IBAN', 'SWIFT/BIC', 'Банк']);
  assert.equal(labels(vm.payment.rows).indexOf(I18n.get('uk').variableSymbol), -1, 'no Czech payment symbol on a Ukrainian document');
  assert.equal(valueOf(vm.payment.rows, 'IBAN'), 'UA21 3223 1300 0002 6007 2335 6600 1');
  assert.equal(vm.qr, null, 'a hryvnia payment has no QR Platba');
  const english = vmOf(ua, null, 'en');
  assert.deepEqual(labels(english.parties[0].ids), ['EDRPOU', 'VAT no. (IPN)']);
  const person = vmOf(company('UA', { companyNumber: '1234567890', vatPayer: false }));
  assert.deepEqual(labels(person.parties[0].ids), ['РНОКПП']);
  assert.deepEqual(person.parties[0].badges, ['Не є платником ПДВ']);
});

test('a euro payment to an IBAN outside the SEPA area gets no SEPA payment code', function () {
  const ua = company('UA');
  ua.bank = Object.assign(C.emptyBank(), { iban: 'UA213223130000026007233566001' });
  assert.equal(vmOf(ua, { currency: 'EUR' }).qr, null);
  const sk = company('SK');
  sk.bank = Object.assign(C.emptyBank(), { iban: 'SK3112000000198742637541' });
  const vm = vmOf(sk);
  assert.equal(vm.invoice.currency, 'EUR');
  assert.ok(vm.qr && /^BCD\n/.test(vm.qr.text), 'a SEPA payment code for a Slovak IBAN');
});

test('a customer abroad is labelled by their own country, whatever the supplier’s', function () {
  const cz = company('CZ', { companyNumber: '27082440' });
  const inv = { customer: Object.assign(C.emptyParty(), { name: 'Buyer Inc', country: 'US', companyNumber: '98-7654321' }) };
  const vm = vmOf(cz, inv, 'en');
  assert.deepEqual(vm.parties[1].ids, [{ label: 'EIN', value: '98-7654321' }]);
  assert.deepEqual(labels(vm.parties[0].ids), ['Company ID']);
});

test('a tax with a name of its own: the document says that name', function () {
  const au = company('AU', { taxName: 'GST' });
  au.defaults.taxRate = '10';
  const vm = vmOf(au, null, 'en');
  assert.deepEqual(labels(vm.totals), ['Subtotal', 'GST']);
  assert.deepEqual(vm.vatSummary.columns.map(function (c) { return c.label; }), ['Tax rate', 'Taxable amount', 'GST', 'Total']);
  assert.equal(vm.invoice.items[0].vatRate, 10);
  assert.equal(vm.invoice.taxName, 'GST');
  const stored = C.normalizeInvoice(JSON.parse(JSON.stringify(vm.invoice)));
  assert.equal(stored.taxName, 'GST', 'the name stays with the document');
});

test('the Czech note about the tax in crowns is for Czech tax documents only', function () {
  const cz = vmOf(company('CZ'), { currency: 'EUR', exchangeRate: '25.25' });
  assert.ok(cz.notes.some(function (n) { return /CZK/.test(n); }));
  const ua = vmOf(company('UA'), { currency: 'EUR', exchangeRate: '25.25' });
  assert.equal(ua.notes.some(function (n) { return /CZK/.test(n); }), false);
});

test('every language has the words for a sales tax and for a bank', function () {
  I18n.list().forEach(function (l) {
    const t = I18n.get(l.code);
    assert.equal(typeof t.bankName, 'string', l.code);
    ['taxRate', 'tax', 'subtotal', 'taxable'].forEach(function (k) { assert.ok(t.sales && t.sales[k], l.code + '.' + k); });
  });
});

test('a company\u2019s usual currency and language follow its country until someone chooses otherwise', function () {
  const c = C.newCompany('supplier');
  c.country = 'UA';
  C.followCountry(c, 'CZ');
  assert.deepEqual([c.defaults.currency, c.defaults.language], ['UAH', 'uk']);
  c.country = 'US';
  C.followCountry(c, 'UA');
  assert.deepEqual([c.defaults.currency, c.defaults.language], ['USD', 'en']);
  c.defaults.currency = 'EUR';                 // the person's own choice
  c.country = 'CZ';
  C.followCountry(c, 'US');
  assert.deepEqual([c.defaults.currency, c.defaults.language], ['EUR', 'cs']);
  c.country = 'JP';                            // a country with no profile changes nothing
  C.followCountry(c, 'CZ');
  assert.deepEqual([c.defaults.currency, c.defaults.language], ['EUR', 'cs']);
});

// ------------------------------------------------- after the first review

test('another tax, every kind of document: no VAT wording in any language', function () {
  const us = company('US');
  us.defaults.taxRate = '5';
  const gst = company('JP', { taxName: 'Consumption tax', taxNumber: 'TX99' });
  // whole words only: "IVA" is also the end of the Spanish "rectificativa"
  const vatWords = /(?<![A-Za-z\u00C0-\u024F])(VAT|DPH|MwSt|USt|TVA|IVA|BTW|PDV)(?![A-Za-z\u00C0-\u024F])|ПДВ|Umsatzsteuergesetz|податковою накладною/;
  [us, gst].forEach(function (supplier) {
    C.KIND_ORDER.forEach(function (kind) {
      I18n.list().forEach(function (l) {
        const inv = C.newInvoice(supplier, { today: '2026-11-18', kind: kind });
        inv.items[0].price = 100;
        inv.items[0].description = 'Work';
        inv.language = l.code;
        inv.correctedNumber = '1';
        inv.correctionReason = 'Mistake';
        const vm = C.buildViewModel(inv, { labels: I18n.get(l.code), countryName: function (c) { return c; }, images: {} });
        const text = JSON.stringify([vm.header, vm.parties, vm.payment, vm.dates, vm.items.columns, vm.vatSummary, vm.totals, vm.grandTotal, vm.notes]);
        const hit = vatWords.exec(text);
        assert.equal(hit, null, supplier.country + ' ' + kind + ' ' + l.code + ': ' + (hit ? text.slice(Math.max(0, hit.index - 40), hit.index + 30) : ''));
        assert.equal(/undefined/.test(text), false, supplier.country + ' ' + kind + ' ' + l.code + ' has a missing word');
      });
    });
  });
});

test('a quotation of a company with another tax: its title and its total say nothing of VAT', function () {
  const us = company('US');
  ['en', 'cs', 'de'].forEach(function (code) {
    const vm = vmOf(us, { kind: 'quote_vat' }, code);
    assert.equal(vm.header.title, C.buildViewModel(Object.assign({}, vm.invoice, { kind: 'quote_novat' }), { labels: I18n.get(code), countryName: function (c) { return c; }, images: {} }).header.title, code);
    assert.equal(vm.grandTotal.label, I18n.get(code).total, code);
  });
});

test('a corrective or reverse-charge document of a company with another tax is worded for it', function () {
  const us = company('US');
  const corrective = vmOf(us, { kind: 'corrective', correctedNumber: '20260001' });
  assert.equal(corrective.header.title.toLowerCase(), 'corrective invoice');
  const reverse = vmOf(us, { kind: 'reverse_charge' });
  assert.equal(reverse.header.title.toLowerCase(), 'invoice');
  assert.equal(reverse.items.columns[3].label, 'Tax rate');
  assert.deepEqual(reverse.notes, []);
});

test('a company with a tax name of its own has a tax number, not a VAT number', function () {
  const vm = vmOf(company('JP', { taxName: 'Consumption tax', taxNumber: 'TX99', companyNumber: '555' }), null, 'fr');
  assert.deepEqual(vm.parties[0].ids, [{ label: I18n.get('fr').companyNumber, value: '555' }, { label: 'N° fiscal', value: 'TX99' }]);
  assert.equal(vm.items.columns[4].label, 'Hors taxe');
});

test('payment symbols are for Czech and Slovak transfers only', function () {
  assert.equal(C.usesPaymentSymbols({ supplier: { country: 'CZ' }, bank: {} }), true);
  assert.equal(C.usesPaymentSymbols({ supplier: { country: '' }, bank: {} }), true);
  assert.equal(C.usesPaymentSymbols({ supplier: { country: 'SK' }, bank: { kind: 'iban' } }), true);
  assert.equal(C.usesPaymentSymbols({ supplier: { country: 'UA' }, bank: { kind: 'iban' } }), false);
  assert.equal(C.usesPaymentSymbols({ supplier: { country: 'US' }, bank: { kind: 'us' } }), false);
  assert.equal(C.usesPaymentSymbols({ supplier: { country: 'UA' }, bank: { kind: 'cz', account: '19-2000145399/0800' } }), true, 'a Czech account, whoever holds it');
});

test('an account of the US kind never gives an IBAN to a payment code, even with one left in it', function () {
  const stale = { kind: 'us', account: '123', routing: '021000021', iban: 'SK3112000000198742637541' };
  assert.equal(C.resolveIban(stale), '');
  const us = company('US');
  us.bank = Object.assign(C.emptyBank(), stale);
  assert.equal(vmOf(us, { currency: 'EUR' }).qr, null);
  assert.equal(C.resolveIban({ kind: 'iban', account: '19-2000145399/0800' }), '', 'nor does an IBAN account borrow a Czech number left in it');
});

test('a Czech account with only an IBAN prints as it always did, without the holder', function () {
  const cz = company('CZ');
  cz.bank = Object.assign(C.emptyBank(), { iban: 'CZ6508000000192000145399', accountName: 'Main' });
  assert.equal(valueOf(vmOf(cz).payment.rows, 'IBAN'), 'CZ65 0800 0000 1920 0014 5399');
  cz.bank.kind = 'iban';
  assert.equal(valueOf(vmOf(cz).payment.rows, 'IBAN'), 'CZ65 0800 0000 1920 0014 5399 (Main)');
});

test('a language someone chose is not changed by the country', function () {
  const c = C.newCompany('supplier');
  c.defaults.language = 'de';
  c.country = 'UA';
  C.followCountry(c, 'CZ');
  assert.equal(c.defaults.language, 'de');
  assert.equal(c.defaults.currency, 'UAH');
});

test('every language has every word of the sales table', function () {
  const keys = Object.keys(I18n.get('en').sales).sort();
  assert.deepEqual(keys, ['corrective', 'net', 'subtotal', 'tax', 'taxId', 'taxRate', 'taxable']);
  I18n.list().forEach(function (l) {
    assert.deepEqual(Object.keys(I18n.get(l.code).sales).sort(), keys, l.code);
    assert.equal(typeof I18n.get(l.code).routing, 'string', l.code);
  });
});
