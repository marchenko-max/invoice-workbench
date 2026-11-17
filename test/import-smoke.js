/*
 * Drives the import from another service in headless Chrome: files in, the dialog, the documents it makes,
 * the Overview that adds them up, and the cases that must bring nothing in.
 * Run from the project folder:  node test/import-smoke.js
 * Screenshots land in test/out/import-*.png.
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { launch } = require('./cdp.js');
const { isdoc, zip, pdf } = require('./import-fixtures.js');

const ROOT = path.resolve(__dirname, '..');
require('node:child_process').execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build.js')]);
const URL = 'file://' + path.join(ROOT, 'dist', 'index.html');
const OUT = path.join(__dirname, 'out');
const profile = path.join(__dirname, '.chrome-import');

let failures = 0;
function ok(cond, what, detail) {
  if (cond) console.log('  ok   ' + what);
  else { failures++; console.log('  FAIL ' + what + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}

const vatLines = [
  { qty: 2, net: '2000.00', gross: '2420.00', vat: '420.00', unitNet: '1000', unitGross: '1210', rate: 21, text: 'Konzultace' },
  { qty: 1, net: '499.90', gross: '559.89', vat: '59.99', unitNet: '499.90', unitGross: '559.89', rate: 12, text: 'Kniha' }
];

/** Puts files into the import's file input the way a person's pick does. `files`: [[name, string | Uint8Array]]. */
async function pick(b, files) {
  const list = files.map(function (f) { return [f[0], Buffer.from(f[1]).toString('base64')]; });
  await b.eval('(function(){var dt=new DataTransfer();' + JSON.stringify(list) + '.forEach(function(f){var s=atob(f[1]);var a=new Uint8Array(s.length);for(var i=0;i<s.length;i++)a[i]=s.charCodeAt(i);dt.items.add(new File([a],f[0]));});' +
    'var el=document.querySelector("#migrate-files");el.files=dt.files;el.dispatchEvent(new Event("change",{bubbles:true}));})()');
}

const dialogOpen = 'document.querySelector("#dialog").open';
// amounts are written with a no-break space before the currency
const plain = function (s) { return String(s == null ? '' : s).replace(/\u00A0/g, ' '); };

(async () => {
  fs.rmSync(profile, { recursive: true, force: true });
  const b = await launch({ width: 1360, height: 1000, profile });
  try {
    console.log('1. the Backup tab offers the move, and the empty Documents list points to it');
    await b.goto(URL + '#documents', 2400);
    ok((await b.text('#docs-import-link')) === 'Bring your invoices with you', 'the empty list links to the import');
    await b.click('#docs-import-link');
    await b.waitFor('document.querySelector("#migrate-files")');
    ok(/FakturaOnline/.test(await b.text('#migrate')) && /Fakturoid/.test(await b.text('#migrate')), 'both services are named with where their export is');

    console.log('2. three invoices in three shapes, and one file that is not one');
    const archive = zip([{ name: 'faktury/20260002.isdoc', data: isdoc({ number: '20260002', issue: '2026-04-01', payment: { due: '2026-04-15' } }) }]);
    await pick(b, [
      ['20260001.isdoc', isdoc({ number: '20260001' })],
      ['export.zip', archive],
      ['20260003-isdoc.pdf', pdf(isdoc({ number: '20260003', issue: '2026-11-10', payment: { due: '2026-11-24' } }))],
      ['prehled.csv', 'cislo;castka']
    ]);
    await b.waitFor(dialogOpen, 8000);
    ok(/^3 documents were found/.test(await b.text('#imp-summary')), 'the summary counts three', await b.text('#imp-summary'));
    const group = plain(await b.text('.imp-group'));
    ok(/Ukázka s\.r\.o\./.test(group) && /IČO 11111111/.test(group), 'the issuing company is named', group);
    ok(/3 documents/.test(group) && /45,000\.00 Kč/.test(group) && /added to your companies/.test(group), 'with its count, total and what happens to it', group);
    ok(/1 file is left out/.test(await b.text('#imp-skipped summary')), 'the spreadsheet is listed as left out', await b.text('#imp-skipped'));
    ok(/spreadsheet/.test(await b.text('#imp-skipped')), 'and says why');
    ok((await b.text('#imp-go')) === 'Import 3 documents', 'the button says what it will do', await b.text('#imp-go'));
    ok((await b.eval('document.activeElement && document.activeElement.id')) === 'imp-go', 'the keyboard starts on the button');
    await b.screenshot(path.join(OUT, 'import-1-dialog.png'));

    console.log('3. changing how "paid" is read keeps the dialog and the place in it');
    await b.fill('#imp-paid', 'none');
    ok((await b.eval(dialogOpen)) === true, 'the dialog stays open');
    ok((await b.eval('document.activeElement && document.activeElement.id')) === 'imp-paid', 'focus stays on the choice');
    ok((await b.eval('document.querySelector("#imp-paid").value')) === 'none', 'and the choice is kept');
    await b.fill('#imp-paid', 'due');

    console.log('4. importing lists the documents, paid where they were due');
    await b.click('#imp-go');
    await b.waitFor('!' + dialogOpen);
    await b.wait(500);
    ok((await b.eval('location.hash')) === '#documents', 'the Documents list opens', await b.eval('location.hash'));
    const rows = await b.eval('[].map.call(document.querySelectorAll("table.ledger tbody tr"),function(tr){return tr.querySelector("td").textContent.slice(0,8)+" "+tr.querySelector(".chip").textContent})');
    ok(rows.length === 3, 'three rows', rows);
    ok(JSON.stringify(rows.slice().sort()) === JSON.stringify(['20260001 Paid', '20260002 Paid', '20260003 Issued']), 'two paid and the one not yet due is waiting', rows);
    ok(/Imported 3 documents, 1 customer and 1 company of yours\./.test(await b.text('#toasts')), 'a message says what came in', await b.text('#toasts'));
    ok((await b.eval('document.activeElement && document.activeElement.tagName')) === 'H1', 'the keyboard is on the Documents heading', await b.eval('document.activeElement && document.activeElement.tagName'));
    await b.screenshot(path.join(OUT, 'import-2-documents.png'), { full: true });

    console.log('5. the companies are there, and the Overview adds the money up');
    await b.goto(URL + '#companies', 1800);
    const companies = await b.text('#view');
    ok(/Ukázka s\.r\.o\./.test(companies) && /Odběratel a\.s\./.test(companies), 'the company and its customer are listed');
    await b.goto(URL + '#overview', 1800);
    ok(plain(await b.text('#ov-total')) === '45,000.00 Kč', 'invoiced: 45,000.00 Kč', await b.text('#ov-total'));
    await b.click('#ov-paid');
    ok(plain(await b.text('#ov-total')) === '30,000.00 Kč', 'received: the two paid ones', await b.text('#ov-total'));
    ok(/Odběratel a\.s\./.test(await b.text('#ov-customers')), 'the customer is in "Who it came from"');
    await b.screenshot(path.join(OUT, 'import-3-overview.png'), { full: true });

    console.log('6. an imported document opens, prints and continues the numbering');
    await b.goto(URL + '#documents', 1800);
    await b.eval('(function(){var trs=document.querySelectorAll("table.ledger tbody tr");for(var i=0;i<trs.length;i++)if(/20260001/.test(trs[i].textContent)){trs[i].click();return}})()');
    await b.waitFor('document.querySelector("#doc-title")');
    await b.wait(900);
    ok(/20260001/.test(await b.text('#doc-title')), 'the editor shows it', await b.text('#doc-title'));
    ok(/15,000\.00/.test(await b.text('#totals dd.grand')), 'with its total', await b.text('#totals dd.grand'));
    ok((await b.eval('document.querySelectorAll("#preview-host .sheet svg").length')) === 1, 'and a one-page preview');
    ok(/Vývoj aplikace/.test(await b.eval('document.querySelector("#preview-host").textContent')), 'the line is on the page');
    await b.goto(URL + '#documents', 1500);
    await b.clickText('button', 'New document');
    await b.waitFor('document.querySelector("#doc-title")');
    await b.wait(700);
    ok(/20260004/.test(await b.text('#doc-title')), 'a new document is number 20260004', await b.text('#doc-title'));

    console.log('7. the same files again bring nothing in');
    await b.goto(URL + '#backup', 1800);
    await pick(b, [['20260001.isdoc', isdoc({ number: '20260001' })], ['export.zip', archive]]);
    await b.waitFor(dialogOpen, 8000);
    ok(/2 are already here/.test(await b.text('#imp-summary')), 'the summary says they are already here', await b.text('#imp-summary'));
    ok((await b.eval('document.querySelector("#imp-go").disabled')) === true && (await b.text('#imp-go')) === 'Nothing to import', 'and there is nothing to press');
    ok((await b.eval('document.querySelector(".imp-group input").disabled')) === true, 'the company cannot be ticked');
    await b.clickText('#dialog button', 'Cancel');
    await b.waitFor('!' + dialogOpen);
    ok((await b.eval('document.activeElement && document.activeElement.id')) === 'migrate-files', 'Cancel returns to the file field');
    ok((await b.eval('JSON.parse(localStorage.getItem("invoice-workbench:v1")).invoices ? Object.keys(JSON.parse(localStorage.getItem("invoice-workbench:v1")).invoices).length : -1')) === 3, 'still three documents stored');

    console.log('8. an invoice my company received starts unticked');
    const received = isdoc({ number: 'PF-77', supplier: { name: 'Dodavatel energie a.s.', ico: '88888888' }, customer: { name: 'Ukázka s.r.o.', ico: '11111111' } });
    await pick(b, [['prijata.isdoc', received]]);
    await b.waitFor(dialogOpen, 8000);
    ok(/look like invoices you received/.test(await b.text('#dialog')), 'a warning says so');
    ok((await b.eval('document.querySelector(".imp-group input").checked')) === false, 'its sender is not ticked');
    ok((await b.eval('document.querySelector("#imp-go").disabled')) === true, 'so nothing would be imported');
    await b.check('.imp-group input', true);
    ok((await b.text('#imp-go')) === 'Import 1 document', 'ticking it is still the person’s call', await b.text('#imp-go'));
    await b.setDark(true);
    await b.screenshot(path.join(OUT, 'import-4-received-dark.png'));
    await b.setDark(false);
    await b.clickText('#dialog button', 'Cancel');
    await b.waitFor('!' + dialogOpen);

    console.log('9. a pick with no invoice in it says so on the page');
    await pick(b, [['prehled.csv', 'cislo;castka'], ['sken.pdf', pdf(null)]]);
    await b.waitFor('document.querySelector("#migrate-status .notice")', 8000);
    const status = await b.text('#migrate-status');
    ok(/No invoice was found/.test(status) && /spreadsheet/.test(status) && /carries no invoice data/.test(status), 'with the reason for each file', status);
    ok((await b.eval(dialogOpen)) === false, 'and no dialog opens');

    console.log('9b. leaving the Backup tab while files are read brings up no dialog');
    await b.eval('(function(){var dt=new DataTransfer();dt.items.add(new File([' + JSON.stringify(isdoc({ number: 'LATE-1' })) + '],"late.isdoc"));var el=document.querySelector("#migrate-files");el.files=dt.files;el.dispatchEvent(new Event("change",{bubbles:true}));location.hash="#documents";})()');
    await b.wait(1500);
    ok((await b.eval(dialogOpen)) === false, 'no dialog over the Documents list');
    ok(/Choose them again on the Backup tab/.test(await b.text('#toasts')), 'a message says where to pick them up', await b.text('#toasts'));
    ok((await b.eval('Object.keys(JSON.parse(localStorage.getItem("invoice-workbench:v1")).invoices).length')) === 3, 'and nothing was brought in');

    console.log('9c. a long company name wraps inside the dialog');
    await b.setViewport(320, 700, true);
    await b.goto(URL + '#backup', 1800);
    await pick(b, [['long.isdoc', isdoc({ number: 'LONG-1', supplier: { name: 'N'.repeat(280), ico: '12121212' } })]]);
    await b.waitFor(dialogOpen, 8000);
    ok((await b.eval('(function(){var d=document.querySelector("#dialog").getBoundingClientRect();return [].every.call(document.querySelectorAll(".imp-group span"),function(s){var r=s.getBoundingClientRect();return r.right<=d.right+1})})()')) === true, 'the name, the count and the total all stay inside it');
    await b.clickText('#dialog button', 'Cancel');
    await b.waitFor('!' + dialogOpen);

    console.log('10. a VAT payer’s invoices from a second company, on a phone');
    await b.setViewport(390, 800, true);
    await b.goto(URL + '#backup', 1800);
    await pick(b, [['dph.isdoc', isdoc({ number: 'FV-1', vat: true, supplier: { name: 'Plátce DPH s.r.o.', ico: '99999999', dic: 'CZ99999999' }, lines: vatLines, totals: { net: '2499.90', gross: '2979.89', payable: '2979.89' } })]]);
    await b.waitFor(dialogOpen, 8000);
    ok((await b.eval('(function(){var d=document.querySelector("#dialog .dialog-body");return d.scrollWidth<=d.clientWidth+1})()')) === true, 'the dialog does not scroll sideways');
    ok((await b.eval('document.documentElement.scrollWidth<=innerWidth')) === true, 'nor does the page');
    await b.screenshot(path.join(OUT, 'import-5-phone.png'));
    await b.click('#imp-go');
    await b.waitFor('!' + dialogOpen);
    await b.wait(500);
    const stored = await b.eval('(function(){var d=JSON.parse(localStorage.getItem("invoice-workbench:v1"));var inv=Object.keys(d.invoices).map(function(k){return d.invoices[k]}).filter(function(x){return x.number==="FV-1"})[0];var sup=d.companies[inv.supplierId];return {kind:inv.kind,mode:inv.priceMode,rates:inv.items.map(function(i){return i.vatRate}),vatPayer:sup.vatPayer,tax:sup.taxNumber,count:Object.keys(d.invoices).length}})()');
    ok(stored.kind === 'invoice_vat' && stored.vatPayer === true && stored.tax === 'CZ99999999', 'stored as a VAT payer’s invoice of a VAT-paying company', stored);
    ok(JSON.stringify(stored.rates) === '[21,12]' && stored.count === 4, 'with both rates, as the fourth document', stored);

    console.log('11. no script errors');
    ok(b.errors.length === 0, 'no exceptions or console errors', b.errors);
  } catch (e) {
    failures++;
    console.log('  FAIL the run stopped: ' + (e && e.stack || e));
    try { await b.screenshot(path.join(OUT, 'import-crash.png')); } catch (ignored) { /* nothing to show */ }
  } finally {
    await b.close();
  }
  console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})();
