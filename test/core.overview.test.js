// The overview: what was invoiced or received, period by period.   node --test test/core.overview.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');

function doc(over) {
  const sup = { id: 's1', vatPayer: false, defaults: {}, bank: {} };
  const d = C.newInvoice(sup, { today: '2026-01-01' });
  d.items = [Object.assign(C.newItem(0), { qty: 1, price: 0 })];
  d.status = 'issued';
  Object.assign(d, over);
  if (over.amount != null) d.items[0].price = over.amount;
  if (over.customerName != null) d.customer.name = over.customerName;
  return d;
}

test('givenAnyDay_whenThePeriodsAreListed_thenTheyEndWithTheCurrentOne', () => {
  const months = C.periodKeys('2026-11-17', 'month');
  assert.equal(months.length, 13);
  assert.equal(months[0], '2025-11');
  assert.equal(months[12], '2026-11');
  assert.deepEqual(C.periodKeys('2026-01-31', 'month').slice(0, 2), ['2025-01', '2025-02']);
  const quarters = C.periodKeys('2026-11-17', 'quarter');
  assert.deepEqual(quarters, ['2025-Q1', '2025-Q2', '2025-Q3', '2025-Q4', '2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4']);
  assert.deepEqual(C.periodKeys('2026-02-10', 'quarter').slice(-2), ['2025-Q4', '2026-Q1']);
  assert.deepEqual(C.periodKeys('2026-11-17', 'year', 2024), ['2024', '2025', '2026']);
  assert.deepEqual(C.periodKeys('2026-11-17', 'year', 2010), ['2021', '2022', '2023', '2024', '2025', '2026']);   // six at most
  assert.deepEqual(C.periodKeys('2026-11-17', 'year', 2030), ['2026']);
  assert.equal(C.periodKey('2026-11-17', 'month'), '2026-11');
  assert.equal(C.periodKey('2026-11-17', 'quarter'), '2026-Q4');
  assert.equal(C.periodKey('2026-03-31', 'quarter'), '2026-Q1');
  assert.equal(C.periodKey('2026-04-01', 'quarter'), '2026-Q2');
  assert.equal(C.periodKey('nonsense', 'month'), '');
});

test('givenDocumentsOfAYear_whenIssuedIsAsked_thenEachSitsInTheMonthOfItsIssueDate', () => {
  const docs = [
    doc({ issueDate: '2026-03-02', amount: 71500, kind: 'advance', status: 'paid', customerName: 'Alfa' }),
    doc({ issueDate: '2026-03-30', amount: 155098.89, status: 'paid', customerName: 'Alfa' }),
    doc({ issueDate: '2026-08-15', dueDate: '2026-09-30', amount: 30782.89, customerName: 'Beta' }),   // issued, past due
    doc({ issueDate: '2026-11-10', dueDate: '2026-11-24', amount: 1000, customerName: 'Beta' }),         // issued, not due
    doc({ issueDate: '2026-11-11', amount: 5000, status: 'draft', customerName: 'Gama' }),
    doc({ issueDate: '2024-01-01', amount: 999999, status: 'paid', customerName: 'Old' }),               // before the window
    doc({ issueDate: '2026-05-05', amount: 123456, kind: 'quote_novat', customerName: 'Quote' }),        // not income
    doc({ issueDate: '2026-05-06', amount: 654321, kind: 'proforma', customerName: 'Proforma' })         // not income
  ];
  const o = C.overview(docs, { today: '2026-11-17', granularity: 'month', measure: 'issued' });
  const at = (key) => o.periods.find((p) => p.key === key);
  assert.equal(o.currency, 'CZK');
  assert.equal(at('2026-03').amount, 7150000 + 15509889);
  assert.equal(at('2026-03').count, 2);
  assert.equal(at('2026-08').amount, 3078289);
  assert.equal(at('2026-11').amount, 100000);          // the draft is not income yet
  assert.equal(at('2026-05').amount, 0);               // a quotation and a proforma are not counted
  assert.equal(o.total.amount, 7150000 + 15509889 + 3078289 + 100000);
  assert.equal(o.total.count, 4);
  assert.deepEqual(o.statuses, {
    paid: { amount: 7150000 + 15509889, count: 2 },
    waiting: { amount: 100000, count: 1 },
    overdue: { amount: 3078289, count: 1 },
    draft: { amount: 500000, count: 1 }
  });
  assert.deepEqual(o.customers.map((c) => [c.name, c.amount, c.count]), [['Alfa', 22659889, 2], ['Beta', 3178289, 2]]);
  // the periods add up to the total
  assert.equal(o.periods.reduce((s, p) => s + p.amount, 0), o.total.amount);
});

test('givenPaidDocuments_whenPaidIsAsked_thenEachSitsWhereItWasPaid', () => {
  const docs = [
    doc({ issueDate: '2026-06-20', dueDate: '2026-07-04', amount: 100, status: 'paid', paidDate: '2026-07-10' }),
    doc({ issueDate: '2026-06-21', dueDate: '2026-08-01', amount: 200, status: 'paid', paidDate: '' }),   // no payment date: its due date
    doc({ issueDate: '2026-06-22', dueDate: '', amount: 400, status: 'paid', paidDate: '' }),             // nor a due date: its issue date
    doc({ issueDate: '2026-06-23', amount: 800, status: 'issued' })                                       // not paid: nowhere
  ];
  const o = C.overview(docs, { today: '2026-11-17', measure: 'paid' });
  const at = (key) => o.periods.find((p) => p.key === key).amount;
  assert.equal(at('2026-07'), 10000);
  assert.equal(at('2026-08'), 20000);
  assert.equal(at('2026-06'), 40000);
  assert.equal(o.total.amount, 70000);
  assert.equal(o.statuses.paid.count, 3);
  assert.equal(o.statuses.waiting.count + o.statuses.overdue.count, 1);
});

test('givenVatSeveralCurrenciesAndCompanies_whenTheOverviewIsBuilt_thenNothingIsMixed', () => {
  const vat = doc({ issueDate: '2026-10-01', kind: 'invoice_vat', status: 'paid' });
  vat.items = [Object.assign(C.newItem(21), { qty: 1, price: 1000 })];
  const credit = doc({ issueDate: '2026-10-05', kind: 'corrective', status: 'issued' });
  credit.items = [Object.assign(C.newItem(21), { qty: -1, price: 100 })];
  const euro = doc({ issueDate: '2026-10-02', amount: 50, currency: 'EUR', status: 'paid' });
  const other = doc({ issueDate: '2026-10-03', amount: 7, supplierId: 's2', status: 'paid' });
  const all = [vat, credit, euro, other];

  const czk = C.overview(all, { today: '2026-11-17', supplierId: 's1' });
  assert.deepEqual(czk.currencies, ['CZK', 'EUR']);
  assert.equal(czk.currency, 'CZK');
  assert.equal(czk.total.amount, 121000 - 12100);       // a corrective document takes its amount away
  assert.equal(czk.total.net, 100000 - 10000);
  assert.equal(czk.total.vat, 21000 - 2100);
  assert.equal(czk.total.count, 2);

  const eur = C.overview(all, { today: '2026-11-17', supplierId: 's1', currency: 'EUR' });
  assert.equal(eur.total.amount, 5000);
  const everyone = C.overview(all, { today: '2026-11-17' });
  assert.equal(everyone.total.amount, 121000 - 12100 + 700);
  // an unknown currency falls back to the most used one, and no documents at all gives empty periods, not an error
  assert.equal(C.overview(all, { today: '2026-11-17', currency: 'XXX' }).currency, 'CZK');
  const none = C.overview([], { today: '2026-11-17', granularity: 'quarter' });
  assert.equal(none.periods.length, 8);
  assert.equal(none.total.amount, 0);
  assert.deepEqual(none.customers, []);
  assert.doesNotThrow(() => C.overview(null, {}));
});

test('givenQuartersAndYears_whenTheOverviewIsBuilt_thenDocumentsFallIntoThem', () => {
  const docs = [
    doc({ issueDate: '2025-02-10', amount: 10, status: 'paid' }),
    doc({ issueDate: '2026-03-31', amount: 20, status: 'paid' }),
    doc({ issueDate: '2026-04-01', amount: 40, status: 'paid' })
  ];
  const q = C.overview(docs, { today: '2026-11-17', granularity: 'quarter' });
  assert.deepEqual(q.periods.map((p) => [p.key, p.amount]).filter((x) => x[1]), [['2025-Q1', 1000], ['2026-Q1', 2000], ['2026-Q2', 4000]]);
  const y = C.overview(docs, { today: '2026-11-17', granularity: 'year' });
  assert.deepEqual(y.periods.map((p) => [p.key, p.amount]), [['2025', 1000], ['2026', 6000]]);
});

test('givenACreditNoteNotYetSettled_whenTheTilesAreAddedUp_thenItStandsWithThePaidAndIsNeverOverdue', () => {
  const credit = doc({ kind: 'corrective', issueDate: '2026-10-05', dueDate: '2026-10-19', amount: -300, customerName: 'Alfa' });
  const invoice = doc({ issueDate: '2026-10-01', dueDate: '2026-10-15', amount: 1000, customerName: 'Alfa' });
  const o = C.overview([credit, invoice], { today: '2026-11-17' });
  assert.deepEqual(o.statuses.overdue, { amount: 100000, count: 1 });
  assert.deepEqual(o.statuses.waiting, { amount: 0, count: 0 });
  assert.deepEqual(o.statuses.paid, { amount: -30000, count: 1 });
  assert.equal(o.total.amount, 70000, 'the headline still counts the credit against the income');
  const future = doc({ kind: 'corrective', issueDate: '2026-11-10', dueDate: '2026-12-10', amount: -50 });
  assert.deepEqual(C.overview([future], { today: '2026-11-17' }).statuses.waiting, { amount: 0, count: 0 });
});

test('givenACurrencyLastUsedYearsAgo_whenNoCurrencyIsAskedFor_thenTheOneOnScreenIsShown', () => {
  const old = [doc({ issueDate: '2019-03-01', amount: 10, currency: 'EUR' }), doc({ issueDate: '2019-04-01', amount: 10, currency: 'EUR' })];
  const now = doc({ issueDate: '2026-10-01', amount: 500, currency: 'CZK' });
  const o = C.overview(old.concat([now]), { today: '2026-11-17' });
  assert.equal(o.currency, 'CZK');
  assert.deepEqual(o.currencies, ['EUR', 'CZK'], 'the list still starts with the most used');
  assert.equal(o.total.amount, 50000);
  assert.equal(C.overview(old.concat([now]), { today: '2026-11-17', currency: 'EUR' }).currency, 'EUR', 'a currency asked for is kept');
  assert.equal(C.overview(old, { today: '2026-11-17' }).currency, 'EUR', 'with nothing on screen, the most used');
  // under "received" what is on screen is what was paid in the window
  const paidEur = doc({ issueDate: '2024-01-05', amount: 10, currency: 'EUR', status: 'paid', paidDate: '2026-10-20' });
  const unpaidCzk = [doc({ issueDate: '2026-09-01', amount: 5, currency: 'CZK' }), doc({ issueDate: '2026-09-02', amount: 5, currency: 'CZK' })];
  assert.equal(C.overview(unpaidCzk.concat([paidEur]), { today: '2026-11-17', measure: 'paid' }).currency, 'EUR');
  assert.equal(C.overview(unpaidCzk.concat([paidEur]), { today: '2026-11-17' }).currency, 'CZK');
});
