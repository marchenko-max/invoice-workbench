/*
 * Drives the real page in headless Chrome through the main flows and fails loudly on anything wrong.
 * Run from the project folder:  node test/app-smoke.js
 * Screenshots land in test/out/smoke-*.png.
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { launch } = require('./cdp.js');

const ROOT = path.resolve(__dirname, '..');
require('node:child_process').execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build.js')]);
const URL = 'file://' + path.join(ROOT, 'dist', 'index.html');
const OUT = path.join(__dirname, 'out');
const profile = path.join(__dirname, '.chrome-smoke');

let failures = 0;
function ok(cond, what, detail) {
  if (cond) console.log('  ok   ' + what);
  else { failures++; console.log('  FAIL ' + what + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}

(async () => {
  fs.rmSync(profile, { recursive: true, force: true });
  let b = await launch({ width: 1360, height: 1000, profile });
  try {
    console.log('1. first visit shows the example');
    await b.goto(URL, 2500);
    ok((await b.text('#doc-title')) === 'Invoice ' + new Date().getFullYear() + '0001', 'example title', await b.text('#doc-title'));
    ok(/28,082\.40/.test(await b.text('#totals dd.grand')), 'example total 28,082.40', await b.text('#totals dd.grand'));
    ok((await b.eval('document.querySelectorAll("#preview-host .sheet svg").length')) === 1, 'one preview page');
    ok((await b.eval('document.querySelector("#checks-section").hidden')) === true, 'example has no warnings', await b.text('#checks'));
    await b.screenshot(path.join(OUT, 'smoke-1-example-light.png'), { full: true });

    console.log('2. add my company');
    await b.clickText('button', 'Add my company');
    await b.waitFor('document.querySelector("#dialog").open');
    await b.fill('#co-ico', '27082440');
    await b.fill('#co-dic', 'CZ27082440');
    await b.fill('#co-name', 'Zkušební s.r.o.');
    await b.fill('#co-street', 'Dlouhá 1');
    await b.fill('#co-zip', '110 00');
    await b.fill('#co-city', 'Praha');
    await b.check('#co-vat', true);
    await b.fill('#co-account', '19-2000145399/0800');
    await b.screenshot(path.join(OUT, 'smoke-2-dialog.png'));
    await b.clickText('#dialog button', 'Save');
    await b.waitFor('!document.querySelector("#dialog").open');
    await b.wait(300);
    const year = new Date().getFullYear();
    ok((await b.eval('document.querySelector("#f-number").value')) === year + '0001', 'new document gets the first number', await b.eval('document.querySelector("#f-number").value'));
    ok(/Zkušební/.test(await b.text('.party-card .name')), 'supplier card shows the company');
    ok((await b.eval('document.querySelector("#f-kind").value')) === 'invoice_vat', 'a VAT payer starts with a VAT invoice');

    console.log('3. fill the document');
    await b.fill('#to-name', 'Odběratel & syn <test> a.s.');
    await b.fill('#to-ico', '27082440');
    const itemId = await b.eval('document.querySelector(".item").id');
    await b.fill('#' + itemId + '-desc', 'Práce na projektu\ndruhý řádek');
    await b.fill('#' + itemId + '-qty', '3');
    await b.fill('#' + itemId + '-price', '1 210,00');
    await b.wait(400);
    ok(/4,392\.30/.test(await b.text('#totals dd.grand')), 'net mode: 3 x 1210 at 21% = 4,392.30', await b.text('#totals dd.grand'));
    await b.clickText('.seg button', 'Prices with VAT');
    await b.wait(200);
    ok(/3,630\.00/.test(await b.text('#totals dd.grand')), 'gross mode: 3,630.00', await b.text('#totals dd.grand'));
    await b.clickText('.seg button', 'Prices without VAT');
    await b.clickText('#' + itemId + ' button', 'Discount');
    await b.fill('#' + itemId + '-dv', '10');
    await b.wait(300);
    ok(/3,953\.07/.test(await b.text('#totals dd.grand')), 'with a 10% item discount: 3,953.07', await b.text('#totals dd.grand'));
    ok(/QR Platba/.test(await b.text('#qr-hint')), 'QR hint says a code is printed', await b.text('#qr-hint'));
    await b.check('#f-bank-hidden', true);
    await b.wait(250);
    ok(/hidden/.test(await b.text('#checks')) && /Not printed/.test(await b.text('#qr-hint')), 'hiding the bank account is called out, with the way back', [await b.text('#checks'), await b.text('#qr-hint')]);
    ok((await b.eval('document.querySelector("#preview-host").textContent.indexOf("19-2000145399")')) === -1, 'a hidden account is not printed');
    await b.check('#f-bank-hidden', false);
    await b.wait(250);
    ok((await b.eval('document.querySelector("#preview-host").textContent.indexOf("19-2000145399")')) !== -1 && /QR Platba/.test(await b.text('#preview-host')), 'shown again, the account and the QR code are printed');
    await b.wait(1600);
    ok(/Saved/.test(await b.text('#save-state')), 'autosaved', await b.text('#save-state'));
    const svg = await b.eval('document.querySelector("#preview-host").innerHTML');
    ok(svg.indexOf('Odběratel &amp; syn &lt;test&gt;') !== -1, 'preview escapes < and &');
    ok((await b.eval('document.querySelectorAll("#preview-host script, #preview-host test").length')) === 0, 'typed markup did not become elements');
    await b.screenshot(path.join(OUT, 'smoke-3-editor-light.png'), { full: true });

    console.log('4. the PDF');
    const pdf = await b.eval(`(async function(){
      var r = window.InvoiceRender, C = window.InvoiceCore, I = window.InvoiceI18n;
      var raw = JSON.parse(localStorage.getItem('invoice-workbench:v1'));
      var doc = Object.values(raw.invoices)[0];
      var vm = C.buildViewModel(doc, { labels: I.get(doc.language), countryName: function (c) { return c; }, images: {} });
      var blob = await Promise.resolve(r.pdf(r.layout(vm), vm.meta));
      var buf = new Uint8Array(await blob.arrayBuffer());
      var head = String.fromCharCode.apply(null, buf.slice(0, 5));
      var bin = ''; for (var i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
      return { head: head, size: buf.length, type: blob.type, name: vm.meta.fileName, b64: btoa(bin) };
    })()`);
    ok(pdf.head === '%PDF-', 'PDF starts with %PDF-', pdf.head);
    ok(pdf.type === 'application/pdf', 'PDF blob type', pdf.type);
    ok(pdf.size > 20000 && pdf.size < 900000, 'PDF size is sane', pdf.size);
    ok(/^Faktura-danovy-doklad-\d+\.pdf$/.test(pdf.name), 'PDF file name', pdf.name);
    fs.writeFileSync(path.join(OUT, 'smoke-4.pdf'), Buffer.from(pdf.b64, 'base64'));

    console.log('5. customers and the list');
    await b.clickText('button', 'Save to my customers');
    await b.wait(300);
    await b.eval('location.hash = "#companies"');
    await b.wait(400);
    ok(/Odběratel & syn <test> a\.s\./.test(await b.text('#view')), 'customer is in the address book');
    await b.screenshot(path.join(OUT, 'smoke-5-companies.png'), { full: true });
    await b.eval('location.hash = "#documents"');
    await b.wait(400);
    ok((await b.eval('document.querySelectorAll(".ledger tbody tr").length')) === 1, 'one document listed');
    ok(/Draft/.test(await b.text('.ledger tbody')), 'it is a draft');
    await b.screenshot(path.join(OUT, 'smoke-5-documents.png'), { full: true });

    console.log('6. a second document continues the numbering and offers the customer');
    await b.clickText('button', 'New document');
    await b.wait(400);
    ok((await b.eval('document.querySelector("#f-number").value')) === year + '0002', 'second number', await b.eval('document.querySelector("#f-number").value'));
    ok((await b.eval('document.querySelectorAll("#f-customer option").length')) === 2, 'saved customer can be picked');
    const custId = await b.eval('document.querySelector("#f-customer").options[1].value');
    await b.fill('#f-customer', custId);
    await b.wait(300);
    ok((await b.eval('document.querySelector("#to-name").value')) === 'Odběratel & syn <test> a.s.', 'picking fills the customer in');
    await b.fill('#f-kind', 'invoice_novat');
    await b.wait(300);
    ok((await b.eval('document.querySelector(".item").classList.contains("no-vat")')) === true, 'non-VAT invoice hides the VAT field');
    await b.fill('#f-kind', 'quote_vat');
    await b.wait(300);
    ok((await b.eval('!!document.querySelector("#f-method")')) === false, 'a quotation has no payment section');
    await b.wait(1500);

    console.log('7. reload keeps everything');
    await b.goto(URL + '#documents', 2500);
    ok((await b.eval('document.querySelectorAll(".ledger tbody tr").length')) === 2, 'two documents after reload', await b.eval('document.querySelectorAll(".ledger tbody tr").length'));
    ok(/Saved in this browser/.test(await b.text('#storage-state')), 'storage chip', await b.text('#storage-state'));

    console.log('8. phone width, both themes');
    await b.setViewport(390, 800, true);
    await b.eval('document.querySelector(".ledger tbody tr").click()');
    await b.wait(600);
    ok((await b.eval('document.documentElement.scrollWidth <= window.innerWidth')) === true, 'editor does not scroll sideways on a phone', await b.eval('[document.documentElement.scrollWidth, window.innerWidth]'));
    await b.screenshot(path.join(OUT, 'smoke-8-phone-edit.png'), { full: true, maxHeight: 4200 });
    await b.clickText('.mobile-switch button', 'Preview');
    await b.wait(400);
    await b.screenshot(path.join(OUT, 'smoke-8-phone-preview.png'), { full: true });
    await b.eval('location.hash = "#documents"');
    await b.wait(400);
    ok((await b.eval('document.documentElement.scrollWidth <= window.innerWidth')) === true, 'list does not scroll sideways on a phone');
    await b.screenshot(path.join(OUT, 'smoke-8-phone-documents.png'), { full: true });
    await b.setDark(true);
    await b.setViewport(1360, 1000, false);
    await b.eval('document.querySelector(".ledger tbody tr").click()');
    await b.wait(600);
    await b.screenshot(path.join(OUT, 'smoke-8-editor-dark.png'), { full: true });
    await b.eval('location.hash = "#backup"');
    await b.wait(300);
    await b.screenshot(path.join(OUT, 'smoke-8-backup-dark.png'), { full: true });

    console.log('8b. the appearance switch');
    await b.setDark(true);
    await b.eval('location.hash = "#documents"'); await b.wait(300);
    const bg = () => b.eval('getComputedStyle(document.body).backgroundColor');
    ok((await bg()) === 'rgb(18, 18, 20)', 'with a dark system the page starts dark', await bg());
    await b.fill('#theme-select', 'light'); await b.wait(200);
    ok((await bg()) === 'rgb(245, 245, 247)', 'choosing light makes it light at once', await bg());
    await b.goto(URL + '#documents', 2000);
    ok((await bg()) === 'rgb(245, 245, 247)' && (await b.eval('document.querySelector("#theme-select").value')) === 'light', 'and it is still light after a reload', await bg());
    await b.fill('#theme-select', ''); await b.wait(200);
    ok((await bg()) === 'rgb(18, 18, 20)', 'auto follows the system again', await bg());
    await b.setDark(false);

    console.log('9. no script errors');
    ok(b.errors.length === 0, 'no exceptions or console errors', b.errors.slice(0, 5));
  } catch (e) {
    failures++;
    console.log('  FAIL (threw) ' + e.message);
    console.log('  errors so far: ' + JSON.stringify(b.errors.slice(0, 5)));
  }
  await b.close();
  fs.rmSync(profile, { recursive: true, force: true });
  console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})();
