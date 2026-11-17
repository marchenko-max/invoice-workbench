'use strict';
// The import's edges: what a review found it got wrong, and the behaviours no other test would notice breaking.
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const C = require('../core.js');
const I = require('../import.js');
const { isdoc, bytes, zip, pdf, SUPPLIER, CUSTOMER } = require('./import-fixtures.js');

const TODAY = '2026-11-17';
const NOW = '2026-11-17T10:00:00.000Z';
const EMPTY = { companies: [], invoices: [] };

async function read(files) { return I.readFiles(files.map(function (f) { return { name: f[0], bytes: typeof f[1] === 'string' ? bytes(f[1]) : f[1] }; })); }
async function planOf(xml, have, opts) {
  const r = await read([].concat(xml).map(function (x, i) { return ['f' + i + '.isdoc', x]; }));
  const p = I.plan(r.found, have || EMPTY, Object.assign({ today: TODAY, now: NOW }, opts || {}));
  p.read = r;
  return p;
}
const totals = function (inv) { return C.computeTotals(inv); };

// ----------------------------------------------------------- numbering

test('an imported document is as old as its issue date, and was changed now', async function () {
  const p = await planOf(isdoc({ issue: '2025-06-03', payment: { due: '2025-06-17' } }));
  assert.equal(p.invoices[0].createdAt, '2025-06-03T00:00:00.000Z');
  assert.equal(p.invoices[0].updatedAt, NOW);
  const future = await planOf(isdoc({ issue: '2027-01-05', payment: { due: '2027-01-19' } }));
  assert.equal(future.invoices[0].createdAt, NOW, 'never newer than the moment of the import');
});

test('importing last year’s invoices does not restart this year’s numbering', async function () {
  const mine = C.newCompany('supplier');
  mine.name = SUPPLIER.name;
  mine.companyNumber = SUPPLIER.ico;
  const current = C.newInvoice(mine, { today: '2026-05-01' });
  current.number = '20260007';
  current.status = 'issued';
  current.items[0].price = 100;
  current.createdAt = current.updatedAt = '2026-05-01T09:00:00.000Z';
  const p = await planOf(isdoc({ number: '20250005', issue: '2025-03-02', payment: { due: '2025-03-16' } }), { companies: [mine], invoices: [current] });
  assert.equal(p.invoices.length, 1);
  const next = C.newInvoice(mine, { today: TODAY, existing: [current].concat(p.invoices) });
  assert.equal(next.number, '20260008');
});

// ------------------------------------------------------------- parties

test('company numbers with letters are compared whole', async function () {
  const p = await planOf([
    isdoc({ number: '1', customer: { name: 'Alpha GmbH', ico: 'HRB 12345', country: 'DE' } }),
    isdoc({ number: '2', customer: { name: 'Beta GmbH', ico: 'HRA 12345', country: 'DE' } }),
    isdoc({ number: '3', customer: { name: 'Alpha GmbH', ico: 'hrb12345', country: 'DE' } })
  ]);
  const customers = p.companies.filter(function (c) { return c.kind === 'customer'; });
  assert.deepEqual(customers.map(function (c) { return c.name; }).sort(), ['Alpha GmbH', 'Beta GmbH']);
  const idOf = {};
  p.invoices.forEach(function (d) { idOf[d.number] = d.customerId; });
  assert.equal(idOf['1'], idOf['3']);
  assert.notEqual(idOf['1'], idOf['2']);
});

test('a Czech company number that lost its leading zero is the same company, a foreign one is not', async function () {
  const czech = await planOf([
    isdoc({ number: '1', supplier: { name: 'Nula s.r.o.', ico: '01234567' } }),
    isdoc({ number: '2', supplier: { name: 'Nula s.r.o.', ico: '1234567' } })
  ]);
  assert.equal(czech.groups.length, 1);
  assert.equal(czech.invoices.length, 2);
  const foreign = await planOf([
    isdoc({ number: '1', customer: { name: 'Eins', ico: '01234567', country: 'DE' } }),
    isdoc({ number: '2', customer: { name: 'Zwei', ico: '1234567', country: 'DE' } })
  ]);
  assert.equal(foreign.companies.filter(function (c) { return c.kind === 'customer'; }).length, 2);
});

test('the company is added as the newest document describes it', async function () {
  const p = await planOf([
    isdoc({ number: '1', issue: '2025-01-10', payment: { due: '2025-01-24', id: '111', bank: '0100' }, supplier: Object.assign({}, SUPPLIER, { street: 'Stará', no: '5' }) }),
    isdoc({ number: '2', issue: '2026-01-10', payment: { due: '2026-01-24', id: '222', bank: '0300' }, supplier: Object.assign({}, SUPPLIER, { street: 'Nová', no: '9' }) })
  ]);
  const supplier = p.companies.filter(function (c) { return c.kind === 'supplier'; })[0];
  assert.equal(supplier.street, 'Nová 9');
  assert.equal(supplier.bank.account, '222/0300');
  const old = p.invoices.filter(function (d) { return d.number === '1'; })[0];
  assert.equal(old.supplier.street, 'Stará 5', 'each document keeps the address it was issued with');
  assert.equal(old.bank.account, '111/0100');
});

// --------------------------------------------------------------- money

test('a foreign-currency invoice with no amounts in that currency is left out, not imported as nothing', async function () {
  const p = await planOf(isdoc({ foreign: 'EUR', rate: 25, lines: [{ qty: 2, net: '100.00', unitNet: '50' }], totals: { net: '100', gross: '100', payable: '100' } }));
  assert.equal(p.invoices.length, 0);
  assert.match(p.read.skipped[0].reason, /in EUR, but the file gives no amounts in that currency/);
});

test('a rate quoted per hundred units is brought to one unit', async function () {
  const p = await planOf(isdoc({
    foreign: 'JPY', rate: '16.50', per: 100,
    lines: [{ qty: 1, netCurr: '5000', net: '825.00', grossCurr: '5000', gross: '825.00' }],
    totals: { netCurr: '5000', grossCurr: '5000', payableCurr: '5000', net: '825.00', gross: '825.00', payable: '825.00' }
  }));
  assert.equal(p.invoices[0].exchangeRate, '0.165');
  assert.equal(totals(p.invoices[0]).payable, 500000);
});

test('a reverse-charge line next to a taxed one carries no VAT', async function () {
  const p = await planOf(isdoc({
    vat: true,
    lines: [
      { qty: 1, net: '1000.00', gross: '1210.00', vat: '210.00', unitNet: '1000', unitGross: '1210', rate: 21 },
      { qty: 1, net: '500.00', gross: '500.00', unitNet: '500', unitGross: '500', rate: 21, reverse: true }
    ],
    totals: { net: '1500.00', gross: '1710.00', payable: '1710.00' }
  }));
  const t = totals(p.invoices[0]);
  assert.equal(p.invoices[0].kind, 'invoice_vat');
  assert.deepEqual([t.net, t.vat, t.payable], [150000, 21000, 171000]);
  assert.deepEqual(p.notes, []);
});

test('a total that fits with the VAT far from the file’s is said', async function () {
  const p = await planOf(isdoc({
    vat: true,
    lines: [{ qty: 1, net: '1000.00', gross: '1000.00', unitNet: '1000', unitGross: '1000', rate: 21 }],
    totals: { net: '1000.00', gross: '1000.00', payable: '1000.00' }
  }));
  assert.equal(totals(p.invoices[0]).payable, 100000);
  assert.match(p.notes[0].text, /173\.55 CZK of VAT here, 0 CZK in the file/);
});

test('a total that only rounds down to nothing is not read as paid', async function () {
  const small = isdoc({ number: 'R', issue: '2026-11-10', payment: { due: '2026-11-24' }, lines: [{ qty: 1, net: '0.35', unitNet: '0.35' }], totals: { net: '0.35', gross: '0.35', rounding: '-0.35', payable: '0' } });
  const p = await planOf(small, EMPTY, { paid: 'none' });
  assert.equal(p.invoices[0].status, 'issued');
  assert.equal(totals(p.invoices[0]).payable, 0);
  assert.equal(p.invoices[0].rounding, '1');
});

test('a line no price to four places can reproduce keeps its amount and says the quantity', async function () {
  const p = await planOf(isdoc({ lines: [{ qty: 1000, unit: 'ks', net: '0.05', unitNet: '0.00005', text: 'Drobnost' }], totals: { net: '0.05', gross: '0.05', payable: '0.05' } }));
  const item = p.invoices[0].items[0];
  assert.deepEqual([item.qty, item.unit, item.price, item.description], [1, '', 0.05, '1000 ks × Drobnost']);
  assert.equal(totals(p.invoices[0]).payable, 5);
});

// ---------------------------------------------------- dates and payment

test('paid where due: an invoice due today is still waiting', async function () {
  const p = await planOf([isdoc({ number: 'T', issue: '2026-11-03', payment: { due: TODAY } }), isdoc({ number: 'Y', issue: '2026-11-02', payment: { due: '2026-11-16' } })]);
  const status = {};
  p.invoices.forEach(function (d) { status[d.number] = d.status; });
  assert.deepEqual(status, { T: 'issued', Y: 'paid' });
});

test('a due date before the issue date is brought up to it, and the tax date is kept', async function () {
  const p = await planOf(isdoc({ issue: '2026-03-10', tax: '2026-02-28', payment: { due: '2026-03-01' } }));
  assert.equal(p.invoices[0].dueDate, '2026-03-10');
  assert.equal(p.invoices[0].dueIn, 0);
  assert.equal(p.invoices[0].taxDate, '2026-02-28');
});

test('a due date that is no standard term is a custom one', async function () {
  const p = await planOf(isdoc({ issue: '2026-03-02', payment: { due: '2026-03-25' } }));
  assert.equal(p.invoices[0].dueIn, 'custom');
});

test('how it was to be paid is read from the payment code', async function () {
  const codes = { 10: 'cash', 42: 'transfer', 48: 'card', 50: 'cod', 97: 'offset', 99: 'transfer' };
  for (const code of Object.keys(codes)) {
    const p = await planOf(isdoc({ payment: { code: code } }));
    assert.equal(p.invoices[0].paymentMethod, codes[code], 'code ' + code);
  }
});

test('a credit note for a payment received is left out like the payment document', async function () {
  const p = await planOf(isdoc({ type: 6, number: 'DZ1' }));
  assert.equal(p.invoices.length, 0);
  assert.equal(p.skipped.length, 1);
});

// ----------------------------------------------------------- duplicates

test('the same number in another year is another document; the same one with spaces is not', async function () {
  const p = await planOf([
    isdoc({ number: '001', issue: '2025-02-01', payment: { due: '2025-02-15' } }),
    isdoc({ number: '001', issue: '2026-02-01', payment: { due: '2026-02-15' }, lines: [{ qty: 1, net: '500.00', unitNet: '500' }], totals: { net: '500', gross: '500', payable: '500' } })
  ]);
  assert.equal(p.invoices.length, 2);
  assert.equal(p.duplicates, 0);
  const again = await planOf(isdoc({ number: '0 0 1', issue: '2026-05-05', payment: { due: '2026-05-19' } }), { companies: p.companies, invoices: p.invoices });
  assert.equal(again.duplicates, 1);
  assert.equal(again.invoices.length, 0);
});

test('an invoice with no number is left out and said, not stored without one', async function () {
  const blank = isdoc({ number: 'X' }).replace('<ID>X</ID>', '<ID>  </ID>');
  const p = await planOf([blank, blank]);
  assert.equal(p.invoices.length, 0);
  assert.equal(p.duplicates, 0);
  assert.equal(p.skipped.length, 2);
  assert.match(p.skipped[0].reason, /no number/);
});

test('an empty draft that took the next number does not keep the real invoice out', async function () {
  const first = await planOf(isdoc({ number: '20260001' }));
  const supplier = first.companies.filter(function (c) { return c.kind === 'supplier'; })[0];
  const draft = C.newInvoice(supplier, { today: TODAY, existing: first.invoices });
  assert.equal(draft.number, '20260002');
  const have = { companies: first.companies, invoices: first.invoices.concat([draft]) };
  const p = await planOf(isdoc({ number: '20260002', issue: '2026-04-01', payment: { due: '2026-04-15' } }), have);
  assert.equal(p.invoices.length, 1);
  draft.items[0].price = 250;
  const worked = await planOf(isdoc({ number: '20260002', issue: '2026-04-01', payment: { due: '2026-04-15' } }), have);
  assert.equal(worked.invoices.length, 0, 'a draft someone has worked on is a document like any other');
});

// -------------------------------------------------------------- hostile

test('a tag made to be slow is read in one pass, and one beyond any invoice is refused', async function () {
  const started = process.hrtime.bigint();
  const junk = await read([['slow.isdoc', '<Invoice ' + 'a'.repeat(900000) + '>']]);
  const medium = await read([['slow2.isdoc', '<Invoice ' + 'a'.repeat(60000) + '><ID>1</ID></Invoice>']]);
  const huge = await read([['huge.isdoc', '<Invoice ' + 'a'.repeat(1200000) + '><ID>1</ID></Invoice>']]);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(junk.found.length, 0);
  assert.match(junk.skipped[0].reason, /cut off/);
  assert.equal(medium.found.length, 1, 'a run of attribute junk is skipped over, not chewed on');
  assert.match(huge.skipped[0].reason, /far too long/);
  assert.ok(ms < 1500, 'took ' + Math.round(ms) + ' ms');
});

test('a long attribute in an extension does not cost the invoice', async function () {
  const xml = isdoc({ number: 'EXT' }).replace('<InvoiceLines>', '<Extensions><e:Blob xmlns:e="urn:x" data="' + 'Q'.repeat(70000) + '"/></Extensions><InvoiceLines>');
  const r = await read([['ext.isdoc', xml]]);
  assert.equal(r.found.length, 1, JSON.stringify(r.skipped));
});

test('attributes are read wherever they stand in the tag', function () {
  const root = I.parseXml('<r  a="1"\n\tb=\'2\' xmlns:x="u" x:c = "3"/>');
  assert.deepEqual([root.attrs.a, root.attrs.b, root.attrs.c], ['1', '2', '3']);
});

test('a UTF-16 file is read as one', async function () {
  const xml = isdoc({ declaration: '<?xml version="1.0" encoding="UTF-16"?>\n', supplier: Object.assign({}, SUPPLIER, { name: 'Šestnáct s.r.o.' }) });
  const le = new Uint8Array(Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(xml, 'utf16le')]));
  const r = await I.readFiles([{ name: 'u16.isdoc', bytes: le }]);
  assert.equal(r.found.length, 1, JSON.stringify(r.skipped));
  assert.equal(r.found[0].data.supplier.name, 'Šestnáct s.r.o.');
});

test('an archive with more files than are looked at says how many were not', async function () {
  const many = [];
  for (let i = 0; i < 20003; i++) many.push({ name: 'n' + i + '.txt', data: '', store: true });
  many.push({ name: 'last.isdoc', data: isdoc({ number: 'LAST' }), store: true });
  const r = await read([['big.zip', zip(many)]]);
  assert.equal(r.found.length, 0);
  assert.ok(r.skipped.some(function (s) { return /Only the first 20000 files .* 4 more were not/.test(s.reason); }), JSON.stringify(r.skipped));
});

test('the reasons for files left out are capped', async function () {
  const junk = [];
  for (let i = 0; i < 700; i++) junk.push(['bad' + i + '.isdoc', '<nope/>']);
  const r = await read(junk);
  assert.equal(r.skipped.length, 501);
  assert.match(r.skipped[500].reason, /More files were left out/);
});

test('a PDF stuffed with streams that unpack to megabytes is given up on quickly', async function () {
  const zeros = zlib.deflateSync(Buffer.alloc(12 * 1024 * 1024));
  const chunks = [Buffer.from('%PDF-1.7\n', 'latin1')];
  for (let i = 0; i < 300; i++) {
    chunks.push(Buffer.from((i + 10) + ' 0 obj\n<< /Filter /FlateDecode /Length ' + zeros.length + ' >>\nstream\n', 'latin1'), zeros, Buffer.from('\nendstream\nendobj\n', 'latin1'));
  }
  chunks.push(Buffer.from('%%EOF\n', 'latin1'));
  const started = process.hrtime.bigint();
  const r = await I.readFiles([{ name: 'stuffed.pdf', bytes: new Uint8Array(Buffer.concat(chunks)) }]);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(r.found.length, 0);
  assert.match(r.skipped[0].reason, /carries no invoice data/);
  assert.ok(ms < 1500, 'took ' + Math.round(ms) + ' ms');
});

test('a real attachment is still found behind other streams', async function () {
  const noise = zlib.deflateSync(Buffer.alloc(200000, 7));
  const head = '%PDF-1.7\n3 0 obj\n<< /Filter /FlateDecode /Length ' + noise.length + ' >>\nstream\n';
  const real = pdf(isdoc({ number: 'BEHIND' }));
  const whole = new Uint8Array(Buffer.concat([Buffer.from(head, 'latin1'), noise, Buffer.from('\nendstream\nendobj\n', 'latin1'), Buffer.from(real)]));
  const r = await I.readFiles([{ name: 'mixed.pdf', bytes: whole }]);
  assert.equal(r.found[0].data.number, 'BEHIND');
});

// ------------------------------------------------- second review round

test('a company number typed with CZ, I\u010CO or separators is the same number; a blank one is none', async function () {
  for (const typed of ['CZ11111111', 'cz 11111111', 'I\u010CO 11111111', 'I\u010CO: 111 11 111', '111-11-111']) {
    const mine = C.newCompany('supplier');
    mine.name = 'Jin\u00FD n\u00E1zev';
    mine.companyNumber = typed;
    const p = await planOf(isdoc(), { companies: [mine], invoices: [] });
    assert.equal(p.groups[0].isNew, false, typed);
  }
  const blanks = await planOf([
    isdoc({ number: '1', customer: { name: 'Anna', ico: '0' } }),
    isdoc({ number: '2', customer: { name: 'Bob', ico: '00000000' } })
  ]);
  assert.deepEqual(blanks.companies.filter(function (c) { return c.kind === 'customer'; }).map(function (c) { return c.name; }).sort(), ['Anna', 'Bob']);
});

test('two parties with different numbers are different, whatever their names', async function () {
  const theirs = C.newCompany('customer');
  theirs.name = CUSTOMER.name;
  theirs.companyNumber = '99999999';
  const p = await planOf(isdoc(), { companies: [theirs], invoices: [] });
  const made = p.companies.filter(function (c) { return c.kind === 'customer'; });
  assert.equal(made.length, 1);
  assert.notEqual(p.invoices[0].customerId, theirs.id);
});

test('a number that carries its year is the same document under any date, in any case', async function () {
  const first = await planOf(isdoc({ number: 'fa-20261230', issue: '2026-12-30', payment: { due: '2027-01-13' } }), EMPTY, { today: '2027-02-01' });
  const have = { companies: first.companies, invoices: first.invoices };
  const again = await planOf(isdoc({ number: 'FA-20261230', issue: '2027-01-02', payment: { due: '2027-01-16' } }), have, { today: '2027-02-01' });
  assert.equal(again.duplicates, 1);
  assert.equal(again.invoices.length, 0);
});

test('an issued document for nothing still holds its number', async function () {
  const first = await planOf(isdoc({ number: 'Z-1', lines: [{ qty: 1, net: '0.00', unitNet: '0' }], totals: { net: '0', gross: '0', payable: '0' } }));
  assert.equal(first.invoices.length, 1);
  assert.notEqual(first.invoices[0].status, 'draft');
  const again = await planOf(isdoc({ number: 'Z-1' }), { companies: first.companies, invoices: first.invoices });
  assert.equal(again.duplicates, 1);
});

test('importing an invoice dated ahead does not restart today\u2019s numbering', async function () {
  const mine = C.newCompany('supplier');
  mine.name = SUPPLIER.name;
  mine.companyNumber = SUPPLIER.ico;
  const current = C.newInvoice(mine, { today: '2026-11-01' });
  current.number = '20260010';
  current.status = 'issued';
  current.items[0].price = 100;
  current.createdAt = current.updatedAt = '2026-11-01T09:00:00.000Z';
  const p = await planOf([
    isdoc({ number: '20270001', issue: '2027-01-05', payment: { due: '2027-01-19' } }),
    isdoc({ number: '20260011', issue: '2026-11-10', payment: { due: '2026-11-24' } })
  ], { companies: [mine], invoices: [current] });
  const all = [current].concat(p.invoices);
  assert.equal(C.newInvoice(mine, { today: TODAY, existing: all }).number, '20260012');
  assert.equal(C.newInvoice(mine, { today: '2027-01-20', existing: all }).number, '20270002');
});

test('files in any order: the newest document describes the company, and the documents come in by date', async function () {
  const p = await planOf([
    isdoc({ number: '3', issue: '2026-03-10', payment: { due: '2026-03-24' }, supplier: Object.assign({}, SUPPLIER, { street: 'Nov\u00E1', no: '9' }) }),
    isdoc({ number: '1', issue: '2025-01-10', payment: { due: '2025-01-24' }, supplier: Object.assign({}, SUPPLIER, { street: 'Star\u00E1', no: '5' }) }),
    isdoc({ number: '2', issue: '2025-06-10', payment: { due: '2025-06-24' } })
  ]);
  assert.deepEqual(p.invoices.map(function (d) { return d.number; }), ['1', '2', '3']);
  assert.equal(p.companies.filter(function (c) { return c.kind === 'supplier'; })[0].street, 'Nov\u00E1 9');
});

test('a foreign invoice with its amounts in only one place is still read', async function () {
  const onlyLines = await planOf(isdoc({ foreign: 'EUR', rate: 25, lines: [{ qty: 2, netCurr: '100.00', grossCurr: '100.00', net: '2500.00' }], totals: { net: '2500', gross: '2500', payable: '2500' } }));
  assert.equal(onlyLines.invoices.length, 1);
  assert.equal(totals(onlyLines.invoices[0]).payable, 10000);
  const onlyTotals = await planOf(isdoc({ foreign: 'EUR', rate: 25, lines: [{ qty: 2, net: '2500.00' }], totals: { net: '2500', gross: '2500', payable: '2500', grossCurr: '100.00', payableCurr: '100.00' } }));
  assert.equal(onlyTotals.invoices.length, 1);
  assert.match(onlyTotals.notes[0].text, /adds up to 0 EUR here, 100 EUR in the file/);
});

test('a cent of VAT between the file and the lines is not worth a note', async function () {
  const three = [0, 1, 2].map(function () { return { qty: 1, net: '1.02', gross: '1.23', vat: '0.21', unitNet: '1.02', unitGross: '1.23', rate: 21 }; });
  const p = await planOf(isdoc({ vat: true, lines: three, totals: { net: '3.06', gross: '3.70', payable: '3.70' } }));
  assert.equal(totals(p.invoices[0]).payable, 370);
  assert.deepEqual(p.notes, []);
});

test('a difference of whole units is never papered over with a rounding line', async function () {
  const p = await planOf(isdoc({ totals: { net: '15000.00', gross: '15000.00', payable: '15005.00' } }));
  assert.equal(p.invoices[0].items.length, 1);
  assert.match(p.notes[0].text, /adds up to 15000 CZK here, 15005 CZK in the file/);
});

test('nothing left to pay because an advance covered it is not "paid" by itself', async function () {
  const covered = isdoc({ number: 'C', vat: true, issue: '2026-11-10', payment: { due: '2026-11-24' },
    lines: [{ qty: 1, net: '10000.00', gross: '12100.00', vat: '2100.00', unitNet: '10000', unitGross: '12100', rate: 21 }],
    totals: { net: '10000.00', gross: '12100.00', claimed: '12100.00', payable: '0' } });
  const p = await planOf(covered, EMPTY, { paid: 'none' });
  assert.equal(p.invoices[0].status, 'issued');
  assert.equal(totals(p.invoices[0]).payable, 0);
});

test('a paid invoice whose total was rounded comes in at the rounded total', async function () {
  const p = await planOf(isdoc({ issue: '2026-11-10', payment: { due: '2026-11-24' }, lines: [{ qty: 1, net: '1000.40', unitNet: '1000.40' }], totals: { net: '1000.40', gross: '1000.40', rounding: '-0.40', payable: '0' } }), EMPTY, { paid: 'none' });
  assert.equal(p.invoices[0].status, 'paid');
  assert.equal(totals(p.invoices[0]).payable, 100000);
});
