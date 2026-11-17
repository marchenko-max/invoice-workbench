'use strict';
// The import from another invoicing service: reading ISDOC, unpacking what it arrives in, and deciding what goes where.
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');
const I = require('../import.js');
const { isdoc, bytes, zip, pdf, SUPPLIER, CUSTOMER } = require('./import-fixtures.js');

const TODAY = '2026-11-17';
const NOW = '2026-11-17T10:00:00.000Z';
const EMPTY = { companies: [], invoices: [] };

async function read(files) { return I.readFiles(files.map(function (f) { return { name: f[0], bytes: typeof f[1] === 'string' ? bytes(f[1]) : f[1] }; })); }
async function planOf(xml, have, opts) {
  const r = await read([].concat(xml).map(function (x, i) { return ['f' + i + '.isdoc', x]; }));
  return I.plan(r.found, have || EMPTY, Object.assign({ today: TODAY, now: NOW }, opts || {}));
}
const payable = function (inv) { return C.computeTotals(inv).payable; };

// ------------------------------------------------------------------ XML

test('the XML reader reads elements, attributes, text blocks and the built-in entities', function () {
  const root = I.parseXml('﻿<?xml version="1.0"?><!-- c --><a:r xmlns:a="u" k="1 &amp; 2"><b>x &lt; y &#269; &#x10D;</b><c><![CDATA[<raw> & more]]></c><d/></a:r>');
  assert.equal(root.name, 'r');
  assert.equal(root.attrs.k, '1 & 2');
  assert.equal(root.children[0].text, 'x < y č č');
  assert.equal(root.children[1].text, '<raw> & more');
  assert.equal(root.children[2].name, 'd');
});

test('an entity a DOCTYPE declares is never expanded', function () {
  const root = I.parseXml('<!DOCTYPE r [<!ENTITY big "aaaaaaaaaa"><!ENTITY x SYSTEM "file:///etc/passwd">]><r>&big;&x;</r>');
  assert.equal(root.text, '&big;&x;');
});

test('torn or misnested XML is refused, and nesting has a limit', function () {
  assert.throws(function () { I.parseXml('<a><b></a></b>'); }, /well-formed/);
  assert.throws(function () { I.parseXml('<a><b>'); }, /cut off/);
  assert.throws(function () { I.parseXml('<a/><b/>'); }, /not an XML document/);
  assert.throws(function () { I.parseXml('<a>'.repeat(400) + '</a>'.repeat(400)); }, /nested too deeply/);
});

test('an attribute named __proto__ does not reach any prototype', function () {
  const root = I.parseXml('<r __proto__="x" constructor="y"/>');
  assert.equal(({}).x, undefined);
  assert.equal(Object.getPrototypeOf(root.attrs), null);
});

// ---------------------------------------------------------------- ISDOC

test('a non-VAT payer’s invoice comes in with its line, parties, dates and payment details', async function () {
  const p = await planOf(isdoc({ note: 'Děkujeme', order: 'OBJ-7', payment: { ks: '0308' } }));
  assert.equal(p.invoices.length, 1);
  const inv = p.invoices[0];
  assert.equal(inv.kind, 'invoice_novat');
  assert.equal(inv.vatApplies, false);
  assert.equal(inv.number, '20260001');
  assert.equal(inv.issueDate, '2026-03-02');
  assert.equal(inv.dueDate, '2026-03-16');
  assert.equal(inv.dueIn, 14);
  assert.equal(inv.paymentMethod, 'transfer');
  assert.equal(inv.bank.account, '123456789/0800');
  assert.equal(inv.variableSymbol, '20260001');
  assert.equal(inv.constantSymbol, '0308');
  assert.equal(inv.orderNumber, 'OBJ-7');
  assert.equal(inv.note, 'Děkujeme');
  assert.equal(inv.issuedBy, 'Jana Vzorová');
  assert.deepEqual([inv.items[0].qty, inv.items[0].unit, inv.items[0].price, inv.items[0].description], [10, 'hod', 1500, 'Vývoj aplikace']);
  assert.equal(payable(inv), 1500000);
  assert.equal(inv.supplier.name, 'Ukázka s.r.o.');
  assert.equal(inv.supplier.street, 'Dlouhá 1');
  assert.equal(inv.customer.taxNumber, 'CZ22222222');
  assert.equal(inv.customer.email, 'fakturace@odberatel.example');
  assert.equal(inv.createdAt, '2026-03-02T00:00:00.000Z');
  assert.equal(inv.updatedAt, NOW);
  assert.deepEqual(p.notes, []);
});

test('a VAT payer’s invoice keeps its rates and adds up to the file’s total', async function () {
  const p = await planOf(isdoc({
    vat: true,
    lines: [
      { qty: 2, net: '2000.00', gross: '2420.00', vat: '420.00', unitNet: '1000', unitGross: '1210', rate: 21, text: 'Konzultace' },
      { qty: 1, net: '499.90', gross: '559.89', vat: '59.99', unitNet: '499.90', unitGross: '559.89', rate: 12, text: 'Kniha' }
    ],
    totals: { net: '2499.90', gross: '2979.89', payable: '2979.89', vat: '479.99' }
  }));
  const inv = p.invoices[0];
  assert.equal(inv.kind, 'invoice_vat');
  assert.equal(inv.vatApplies, true);
  assert.equal(inv.priceMode, 'net');
  assert.equal(inv.rounding, 'none');
  assert.deepEqual(inv.items.map(function (i) { return i.vatRate; }), [21, 12]);
  const t = C.computeTotals(inv);
  assert.deepEqual([t.net, t.vat, t.payable], [249990, 47999, 297989]);
  assert.deepEqual(p.notes, []);
});

test('prices that only add up with VAT included are read as prices with VAT', async function () {
  const p = await planOf(isdoc({
    vat: true,
    lines: [{ qty: 1, net: '82.64', gross: '100.00', vat: '17.36', unitNet: '82.64', unitGross: '100', rate: 21 }],
    totals: { net: '82.64', gross: '100.00', payable: '100.00' }
  }));
  assert.equal(p.invoices[0].priceMode, 'gross');
  assert.equal(p.invoices[0].items[0].price, 100);
  assert.equal(payable(p.invoices[0]), 10000);
  assert.deepEqual(p.notes, []);
});

test('a total rounded to whole crowns is read as that rounding', async function () {
  const p = await planOf(isdoc({
    lines: [{ qty: 1, net: '1234.56', unitNet: '1234.56' }],
    totals: { net: '1234.56', gross: '1234.56', rounding: '0.44', payable: '1235.00' }
  }));
  assert.equal(p.invoices[0].rounding, '1');
  assert.equal(payable(p.invoices[0]), 123500);
});

test('a difference of cents is made up by a rounding line, and said', async function () {
  const three = [0, 1, 2].map(function () { return { qty: 1, net: '1.02', gross: '1.23', vat: '0.21', unitNet: '1.02', unitGross: '1.23', rate: 21 }; });
  const p = await planOf(isdoc({ vat: true, lines: three, totals: { net: '3.06', gross: '3.71', payable: '3.71' } }));
  const inv = p.invoices[0];
  assert.equal(payable(inv), 371);
  assert.equal(inv.items.length, 4);
  assert.equal(inv.items[3].description, 'Zaokrouhlení');
  assert.equal(inv.items[3].price, 0.02);
  assert.match(p.notes[0].text, /rounding line of 0\.02 CZK/);
});

test('a total the lines cannot explain is imported as the lines say, and reported', async function () {
  const p = await planOf(isdoc({ totals: { net: '15000.00', gross: '15000.00', payable: '99000.00' } }));
  assert.equal(payable(p.invoices[0]), 1500000);
  assert.match(p.notes[0].text, /adds up to 15000 CZK here, 99000 CZK in the file/);
});

test('a foreign-currency invoice is read in its own currency, with its rate', async function () {
  const p = await planOf(isdoc({
    foreign: 'EUR', rate: '25.10', per: 1,
    lines: [{ qty: 2, unit: 'ks', netCurr: '200.00', net: '5020.00', grossCurr: '200.00', gross: '5020.00', unitNet: '2510', unitGross: '2510' }],
    totals: { net: '5020.00', netCurr: '200.00', gross: '5020.00', grossCurr: '200.00', payable: '5020.00', payableCurr: '200.00' },
    payment: { iban: 'CZ65 0800 0000 1920 0014 5399', bic: 'giBAczpx' }
  }));
  const inv = p.invoices[0];
  assert.equal(inv.currency, 'EUR');
  assert.equal(inv.exchangeRate, '25.1');
  assert.equal(inv.items[0].price, 100);
  assert.equal(payable(inv), 20000);
  assert.equal(inv.bank.iban, 'CZ6508000000192000145399');
  assert.equal(inv.bank.swift, 'GIBACZPX');
  assert.equal(inv.bank.showIban, true);
  assert.deepEqual(p.groups[0].totals, [{ currency: 'EUR', amount: 20000 }]);
});

test('advances already paid come off as a line of their own', async function () {
  const p = await planOf(isdoc({
    vat: true,
    lines: [{ qty: 1, net: '10000.00', gross: '12100.00', vat: '2100.00', unitNet: '10000', unitGross: '12100', rate: 21 }],
    totals: { net: '10000.00', gross: '12100.00', claimed: '6050.00', deposits: '-1000.00', payable: '5050.00' }
  }));
  const inv = p.invoices[0];
  assert.equal(inv.items.length, 2);
  assert.equal(inv.items[1].price, -7050);
  assert.equal(inv.items[1].vatRate, 0);
  assert.equal(payable(inv), 505000);
  assert.match(p.notes[0].text, /advance already paid/);
});

test('document types: a credit note, an advance invoice, and a payment tax document that is left out', async function () {
  const p = await planOf([
    isdoc({ type: 2, number: 'D1', vat: true, corrects: '20260001', lines: [{ qty: 1, net: '-100.00', gross: '-121.00', unitNet: '-100', unitGross: '-121', rate: 21 }], totals: { net: '-100.00', gross: '-121.00', payable: '-121.00' } }),
    isdoc({ type: 4, number: 'Z1' }),
    isdoc({ type: 5, number: 'P1' })
  ]);
  const byNumber = {};
  p.invoices.forEach(function (d) { byNumber[d.number] = d; });
  assert.equal(byNumber.D1.kind, 'corrective');
  assert.equal(byNumber.D1.correctedNumber, '20260001');
  assert.equal(payable(byNumber.D1), -12100);
  assert.equal(byNumber.Z1.kind, 'advance');
  assert.equal(byNumber.P1, undefined);
  assert.equal(p.skipped.length, 1);
  assert.match(p.skipped[0].reason, /payment received is not imported/);
});

test('a reverse-charge invoice is one', async function () {
  const p = await planOf(isdoc({ vat: true, lines: [{ qty: 1, net: '5000.00', gross: '5000.00', unitNet: '5000', rate: 0, reverse: true }], totals: { net: '5000.00', gross: '5000.00', payable: '5000.00' } }));
  assert.equal(p.invoices[0].kind, 'reverse_charge');
  assert.equal(payable(p.invoices[0]), 500000);
});

test('a file older than VATApplicable is a VAT payer’s when a line has a rate', async function () {
  const withRate = await planOf(isdoc({ vat: null, lines: [{ qty: 1, net: '100.00', gross: '121.00', unitNet: '100', unitGross: '121', rate: 21 }], totals: { net: '100.00', gross: '121.00', payable: '121.00' } }));
  assert.equal(withRate.invoices[0].kind, 'invoice_vat');
  const without = await planOf(isdoc({ vat: null }));
  assert.equal(without.invoices[0].kind, 'invoice_novat');
});

test('a quantity and a unit price that do not multiply to the line keep the line’s amount', async function () {
  const p = await planOf(isdoc({ lines: [{ qty: 3, unit: 'ks', net: '100.00', unitNet: '33.33', text: 'Sada' }], totals: { net: '100.00', gross: '100.00', payable: '100.00' } }));
  const item = p.invoices[0].items[0];
  assert.equal(payable(p.invoices[0]), 10000);
  assert.deepEqual([item.qty, item.price], [3, 33.3333]);
  const odd = await planOf(isdoc({ lines: [{ qty: 7, unit: 'ks', net: '0.05', unitNet: '0.01', text: 'Drobnost' }], totals: { net: '0.05', gross: '0.05', payable: '0.05' } }));
  assert.equal(payable(odd.invoices[0]), 5);
});

test('an invoice with no totals in the file is imported as its lines say', async function () {
  const p = await planOf(isdoc({ noTotals: true }));
  assert.equal(payable(p.invoices[0]), 1500000);
  assert.deepEqual(p.notes, []);
});

test('other XML is named for what it is', async function () {
  const r = await read([
    ['pohoda.xml', '<?xml version="1.0"?><dat:dataPack xmlns:dat="x"><dat:dataPackItem/></dat:dataPack>'],
    ['fakturoid.xml', '<invoices type="array"><invoice><number>1</number></invoice></invoices>'],
    ['other.xml', '<html><body/></html>'],
    ['torn.isdoc', '<Invoice><ID>1</ID>'],
    ['empty.isdoc', '']
  ]);
  assert.equal(r.found.length, 0);
  const why = {};
  r.skipped.forEach(function (s) { why[s.source] = s.reason; });
  assert.match(why['pohoda.xml'], /Pohoda/);
  assert.match(why['fakturoid.xml'], /own XML/);
  assert.match(why['other.xml'], /not an ISDOC invoice/);
  assert.match(why['torn.isdoc'], /cut off/);
  assert.match(why['empty.isdoc'], /empty/);
});

test('a file in another encoding is read in it', async function () {
  const xml = isdoc({ declaration: '<?xml version="1.0" encoding="windows-1250"?>\n', supplier: Object.assign({}, SUPPLIER, { name: 'Řemeslo' }) });
  const raw = Buffer.from(xml, 'utf8').toString('utf8');
  // encode by hand: every character of the fixture is ASCII except the Ř, e and so on of the names
  const table = { 'Ř': 0xD8, 'á': 0xE1, 'ě': 0xEC, 'í': 0xED, 'é': 0xE9, 'ý': 0xFD, 'ů': 0xF9, 'š': 0x9A, 'č': 0xE8, 'ž': 0x9E, 'ú': 0xFA, 'ř': 0xF8 };
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    out[i] = ch.charCodeAt(0) < 128 ? ch.charCodeAt(0) : table[ch];
    assert.ok(out[i], 'the fixture has a character the test cannot encode: ' + ch);
  }
  const r = await I.readFiles([{ name: 'cp1250.isdoc', bytes: out }]);
  assert.equal(r.found[0].data.supplier.name, 'Řemeslo');
  assert.equal(r.found[0].data.lines[0].description, 'Vývoj aplikace');
});

test('over-long text in a file is cut, not stored whole', async function () {
  const r = await read([['long.isdoc', isdoc({ note: 'n'.repeat(20000), supplier: Object.assign({}, SUPPLIER, { name: 'x'.repeat(5000) }) })]]);
  assert.equal(r.found[0].data.note.length, 4000);
  assert.equal(r.found[0].data.supplier.name.length, 300);
});

// ------------------------------------------------------------- archives

test('a ZIP of ISDOC files gives every invoice in it, whatever else is inside', async function () {
  const archive = zip([
    { name: 'faktury/20260001.isdoc', data: isdoc({ number: '20260001' }) },
    { name: 'faktury/20260002.isdoc', data: isdoc({ number: '20260002' }), store: true },
    { name: 'prehled.xlsx', data: 'PK not really a sheet' },
    { name: 'cti.txt', data: 'hello' },
    { name: 'faktury/', data: '' }
  ]);
  const r = await read([['export.zip', archive]]);
  assert.deepEqual(r.found.map(function (f) { return f.data.number; }), ['20260001', '20260002']);
  assert.equal(r.found[0].source, 'export.zip › 20260001.isdoc');
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /spreadsheet/);
});

test('an .isdocx gives the one invoice its manifest names', async function () {
  const archive = zip([
    { name: 'manifest.xml', data: '<?xml version="1.0"?><manifest xmlns="http://isdoc.cz/namespace/2013/manifest"><maindocument filename="FV%202026-1.isdoc"/></manifest>' },
    { name: 'FV 2026-1.isdoc', data: isdoc({ number: 'FV 2026-1' }) },
    { name: 'stare/jiny.isdoc', data: isdoc({ number: 'OLD' }) },
    { name: 'nahled.pdf', data: pdf(null) }
  ]);
  const r = await read([['faktura.isdocx', archive]]);
  assert.deepEqual(r.found.map(function (f) { return f.data.number; }), ['FV 2026-1']);
  assert.deepEqual(r.skipped, []);
});

test('archives inside an archive are opened, and PDFs inside give their invoice', async function () {
  const inner = zip([{ name: 'a.isdoc', data: isdoc({ number: 'A' }) }]);
  const outer = zip([{ name: 'inner.isdocx', data: inner }, { name: 'b-isdoc.pdf', data: pdf(isdoc({ number: 'B' })) }]);
  const r = await read([['all.zip', outer]]);
  assert.deepEqual(r.found.map(function (f) { return f.data.number; }).sort(), ['A', 'B']);
});

test('a password-protected, oversized or torn archive says so and takes nothing', async function () {
  const locked = await read([['locked.zip', zip([{ name: 'a.isdoc', data: isdoc(), encrypted: true }])]]);
  assert.equal(locked.found.length, 0);
  assert.match(locked.skipped[0].reason, /password/);
  const bomb = await read([['bomb.zip', zip([{ name: 'a.isdoc', data: isdoc(), claims: 900 * 1024 * 1024 }])]]);
  assert.equal(bomb.found.length, 0);
  assert.match(bomb.skipped[0].reason, /too large|more than this page will read/);
  const good = zip([{ name: 'a.isdoc', data: isdoc() }]);
  const torn = await read([['torn.zip', good.subarray(0, good.length - 30)]]);
  assert.equal(torn.found.length, 0);
  assert.match(torn.skipped[0].reason, /damaged|not a ZIP/);
});

test('a spreadsheet or a contacts file is turned away with the reason', async function () {
  const r = await read([['faktury.xlsx', zip([{ name: 'xl/workbook.xml', data: '<workbook/>' }])], ['faktury.csv', 'a;b;c'], ['kontakty.vcf', 'BEGIN:VCARD']]);
  assert.equal(r.found.length, 0);
  assert.match(r.skipped[0].reason, /spreadsheet/);
  assert.match(r.skipped[1].reason, /spreadsheet/);
  assert.match(r.skipped[2].reason, /Contacts/);
});

// ----------------------------------------------------------------- PDFs

test('a PDF that carries an ISDOC file gives its invoice', async function () {
  const direct = await read([['20260007.pdf', pdf(isdoc({ number: '20260007' }))]]);
  assert.equal(direct.found[0].data.number, '20260007');
  const indirect = await read([['20260008.pdf', pdf(isdoc({ number: '20260008' }), { indirect: true })]]);
  assert.equal(indirect.found[0].data.number, '20260008');
});

test('a PDF with nothing inside says what to do instead', async function () {
  const r = await read([['scan.pdf', pdf(null)]]);
  assert.equal(r.found.length, 0);
  assert.match(r.skipped[0].reason, /carries no invoice data/);
});

// ----------------------------------------------------------------- plan

test('a first import adds the issuing company, with its bank account, and each customer once', async function () {
  const other = { name: 'Druhý odběratel s.r.o.', ico: '33333333' };
  const p = await planOf([isdoc({ number: '1' }), isdoc({ number: '2', issue: '2026-04-01', payment: { due: '2026-04-15' } }), isdoc({ number: '3', customer: other })]);
  assert.equal(p.groups.length, 1);
  const g = p.groups[0];
  assert.deepEqual([g.name, g.companyNumber, g.isNew, g.count, g.duplicates, g.from, g.to], ['Ukázka s.r.o.', '11111111', true, 3, 0, '2026-03-02', '2026-04-01']);
  assert.deepEqual(g.totals, [{ currency: 'CZK', amount: 4500000 }]);
  const suppliers = p.companies.filter(function (c) { return c.kind === 'supplier'; });
  const customers = p.companies.filter(function (c) { return c.kind === 'customer'; });
  assert.equal(suppliers.length, 1);
  assert.equal(customers.length, 2);
  assert.equal(suppliers[0].vatPayer, false);
  assert.equal(suppliers[0].bank.account, '123456789/0800');
  assert.equal(suppliers[0].defaults.issuedBy, 'Jana Vzorová');
  assert.ok(p.invoices.every(function (d) { return d.supplierId === suppliers[0].id; }));
  const same = p.invoices.filter(function (d) { return d.customer.name === CUSTOMER.name; });
  assert.equal(same.length, 2);
  assert.equal(same[0].customerId, same[1].customerId);
  assert.ok(customers.some(function (c) { return c.id === same[0].customerId; }));
});

test('documents join a company and a customer that are already here', async function () {
  const mine = C.newCompany('supplier');
  mine.name = 'Ukázka, společnost s ručením omezeným';
  mine.companyNumber = '111 11 111';
  const theirs = C.newCompany('customer');
  theirs.name = 'Odběratel';
  theirs.companyNumber = '22222222';
  const p = await planOf(isdoc(), { companies: [mine, theirs], invoices: [] });
  assert.equal(p.groups[0].isNew, false);
  assert.deepEqual(p.companies, []);
  assert.equal(p.invoices[0].supplierId, mine.id);
  assert.equal(p.invoices[0].customerId, theirs.id);
});

test('a company with no number is matched by its name', async function () {
  const mine = C.newCompany('supplier');
  mine.name = '  ukázka   S.R.O. ';
  const p = await planOf(isdoc({ supplier: Object.assign({}, SUPPLIER, { ico: '' }) }), { companies: [mine], invoices: [] });
  assert.equal(p.groups[0].isNew, false);
  assert.equal(p.invoices[0].supplierId, mine.id);
});

test('a document that is already here, or twice in the files, is left out', async function () {
  const first = await planOf(isdoc({ number: '20260001' }));
  const have = { companies: first.companies, invoices: first.invoices };
  const again = await planOf([isdoc({ number: '20260001' }), isdoc({ number: '20260002' }), isdoc({ number: '20260002' })], have);
  assert.equal(again.duplicates, 2);
  assert.deepEqual(again.invoices.map(function (d) { return d.number; }), ['20260002']);
  assert.deepEqual(again.companies, []);
  const all = await planOf(isdoc({ number: '20260001' }), have);
  assert.equal(all.invoices.length, 0);
  assert.equal(all.groups[0].count, 0);
  assert.equal(all.groups[0].duplicates, 1);
});

test('the same number in another series is another document', async function () {
  const p = await planOf([isdoc({ number: '1' }), isdoc({ number: '1', type: 4 })]);
  assert.equal(p.invoices.length, 2);
  assert.equal(p.duplicates, 0);
});

test('paid or not follows the choice, and "nothing left to pay" speaks for itself', async function () {
  const past = isdoc({ number: 'P' });
  const future = isdoc({ number: 'F', issue: '2026-11-10', payment: { due: '2026-11-24' } });
  const settled = isdoc({ number: 'S', issue: '2026-11-10', payment: { due: '2026-11-24' }, totals: { payable: '0' } });
  const pick = function (p) { const o = {}; p.invoices.forEach(function (d) { o[d.number] = [d.status, d.paidDate]; }); return o; };
  assert.deepEqual(pick(await planOf([past, future, settled])), { P: ['paid', '2026-03-16'], F: ['issued', ''], S: ['paid', '2026-11-10'] });
  assert.deepEqual(pick(await planOf([past, future, settled], EMPTY, { paid: 'all' })), { P: ['paid', '2026-03-16'], F: ['paid', '2026-11-10'], S: ['paid', '2026-11-10'] });
  assert.deepEqual(pick(await planOf([past, future, settled], EMPTY, { paid: 'none' })), { P: ['issued', ''], F: ['issued', ''], S: ['paid', '2026-11-10'] });
  const s = (await planOf(settled)).invoices[0];
  assert.equal(payable(s), 1500000);
});

test('a company that is left out brings nothing in, and its customers stay out too', async function () {
  const other = { name: 'Jiná firma s.r.o.', ico: '44444444' };
  const files = [isdoc({ number: '1' }), isdoc({ number: '9', supplier: other, customer: { name: 'Jen jejich odběratel', ico: '55555555' } })];
  const both = await planOf(files);
  assert.equal(both.groups.length, 2);
  assert.equal(both.invoices.length, 2);
  const one = await planOf(files, EMPTY, { leaveOut: { 'n:44444444': true } });
  assert.deepEqual(one.groups.map(function (g) { return g.selected; }), [true, false]);
  assert.deepEqual(one.invoices.map(function (d) { return d.number; }), ['1']);
  assert.deepEqual(one.companies.map(function (c) { return c.name; }).sort(), ['Odběratel a.s.', 'Ukázka s.r.o.']);
  assert.equal(one.groups[1].count, 1);
});

test('invoices where one of my companies is the customer are flagged as received', async function () {
  const mine = C.newCompany('supplier');
  mine.name = 'Odběratel a.s.';
  mine.companyNumber = '22222222';
  const p = await planOf(isdoc(), { companies: [mine], invoices: [] });
  assert.equal(p.groups[0].received, true);
  assert.equal(p.likelyReceived, true);
  const fresh = await planOf([isdoc({ number: '1' }), isdoc({ number: '2', supplier: { name: 'Třetí s.r.o.', ico: '66666666' } })]);
  assert.equal(fresh.likelyReceived, true, 'several issuers, one customer, nothing here yet');
  const normal = await planOf([isdoc({ number: '1' }), isdoc({ number: '2' })]);
  assert.equal(normal.likelyReceived, false);
});

test('one customer invoiced by two of the companies in the files is added once', async function () {
  const p = await planOf([isdoc({ number: '1' }), isdoc({ number: '2', supplier: { name: 'Třetí s.r.o.', ico: '66666666' }, customer: Object.assign({}, CUSTOMER) }),
    isdoc({ number: '3', customer: { name: 'Další', ico: '77777777' } })]);
  const customers = p.companies.filter(function (c) { return c.kind === 'customer'; });
  assert.equal(customers.filter(function (c) { return c.companyNumber === '22222222'; }).length, 1);
  const ids = {};
  p.invoices.forEach(function (d) { if (d.customer.companyNumber === '22222222') ids[d.customerId] = true; });
  assert.equal(Object.keys(ids).length, 1);
  assert.ok(customers.some(function (c) { return ids[c.id]; }));
});

test('the next number continues from the imported ones', async function () {
  const p = await planOf([isdoc({ number: '2026-0007', issue: '2026-05-05', payment: { due: '2026-05-19' } }), isdoc({ number: '2026-0003' })]);
  const supplier = p.companies.filter(function (c) { return c.kind === 'supplier'; })[0];
  const next = C.newInvoice(supplier, { today: TODAY, existing: p.invoices });
  assert.equal(next.number, '2026-0008');
});

test('what an import makes survives the same clean-up as any stored document', async function () {
  const p = await planOf(isdoc({ vat: true, lines: [{ qty: 1, net: '100.00', gross: '121.00', unitNet: '100', unitGross: '121', rate: 21 }], totals: { net: '100.00', gross: '121.00', payable: '121.00' } }));
  const again = C.normalizeInvoice(JSON.parse(JSON.stringify(p.invoices[0])));
  assert.deepEqual(again, p.invoices[0]);
});
