/*
 * One check per defect the review confirmed, so none of them comes back unnoticed.   node test/review-regress.js
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { launch } = require('./cdp.js');
const ROOT = path.resolve(__dirname, '..');
require('node:child_process').execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build.js')]);
const LOCAL = 'file://' + path.join(ROOT, 'dist', 'index.html');
const HOSTED = 'file://' + path.join(ROOT, 'dist', 'hosted-test.html');
const year = new Date().getFullYear();
let failures = 0;
function ok(cond, what, detail) {
  if (cond) console.log('  ok   ' + what);
  else { failures++; console.log('  FAIL ' + what + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}
async function addCompany(b, name, opts) {
  await b.waitFor('document.querySelector("#dialog").open');
  await b.fill('#co-name', name);
  await b.fill('#co-ico', '27082440');
  if (opts && opts.vat) { await b.check('#co-vat', true); await b.fill('#co-dic', 'CZ27082440'); }
  await b.fill('#co-account', '19-2000145399/0800');
  await b.clickText('#dialog button', 'Save');
  await b.waitFor('!document.querySelector("#dialog").open');
  await b.wait(250);
}
const stored = (b) => b.eval('JSON.parse(localStorage.getItem("invoice-workbench:v1") || "{}")');

(async () => {
  const profile = path.join(__dirname, '.chrome-regress');
  fs.rmSync(profile, { recursive: true, force: true });
  let b = await launch({ width: 1360, height: 1000, profile });
  try {
    console.log('#1 the example ends when a company is added from Companies');
    await b.goto(LOCAL + '#companies', 2200);
    await b.click('#add-company');
    await addCompany(b, 'Alfa s.r.o.', { vat: true });
    ok((await b.eval('document.activeElement && document.activeElement.id')) === 'add-company', '#17 focus returns to the button that opened the dialog', await b.eval('document.activeElement && document.activeElement.id'));
    await b.eval('location.hash = "#editor"');
    await b.wait(400);
    ok(!/Example/.test(await b.text('.editor-bar') || ''), 'editor no longer shows the example', await b.text('.editor-bar'));

    console.log('#2 #6 #27 numbering and symbols');
    await b.eval('location.hash = "#documents"'); await b.wait(300);
    await b.clickText('button', 'New document'); await b.wait(400);
    await b.fill('#to-name', 'Beta a.s.');
    await b.wait(1400);
    ok((await b.eval('document.querySelector("#f-number").value')) === year + '0001', 'first number');
    await b.fill('#f-kind', 'invoice_novat'); await b.wait(300);
    ok((await b.eval('document.querySelector("#f-number").value')) === year + '0001', '#2 same series keeps the number', await b.eval('document.querySelector("#f-number").value'));
    await b.fill('#f-kind', 'quote_vat'); await b.wait(300);
    ok((await b.eval('document.querySelector("#f-number").value')) === year + '0001', 'a quotation starts its own series at 0001');
    await b.fill('#f-kind', 'invoice_vat'); await b.wait(300);
    await b.fill('#f-issue', (year + 1) + '-01-05'); await b.wait(300);
    ok((await b.eval('document.querySelector("#f-number").value')) === (year + 1) + '0001', '#6 a draft moves into the new year with its date', await b.eval('document.querySelector("#f-number").value'));
    await b.fill('#f-issue', year + '-11-17'); await b.wait(300);
    await b.eval('Array.prototype.forEach.call(document.querySelectorAll("details.more"), function (d) { d.open = true; })');
    await b.fill('#f-vs', 'AB12-34 567890123');
    ok((await b.eval('document.querySelector("#f-vs").value')) === '1234567890', '#27 a symbol keeps digits only, ten at most', await b.eval('document.querySelector("#f-vs").value'));

    console.log('#23 CZK amounts on a foreign-currency VAT document');
    const itemId = await b.eval('document.querySelector(".item").id');
    await b.fill('#' + itemId + '-qty', '2'); await b.fill('#' + itemId + '-price', '100'); await b.fill('#' + itemId + '-desc', 'Service');
    await b.fill('#f-currency', 'EUR'); await b.wait(300);
    ok(/exchange rate/i.test(await b.text('#checks')), 'warns while the rate is missing', await b.text('#checks'));
    await b.fill('#f-rate', '25,25'); await b.wait(400);
    const preview = await b.text('#preview-host');
    ok(/25,25 CZK\/EUR/.test(preview) && /5\s?050,00\sKč/.test(preview.replace(/ /g, ' ')) && /1\s?060,50\sKč/.test(preview.replace(/ /g, ' ')), 'prints the rate, the base and the VAT in CZK', (preview.match(/Přepočet[^]*?Kč[^]*?Kč/) || [preview.slice(0, 200)])[0]);
    ok(!/exchange rate/i.test(await b.text('#checks')), 'warning gone once the rate is set');
    await b.fill('#f-currency', 'CZK'); await b.wait(300);

    console.log('#3 #5 customers');
    await b.fill('#f-status', 'issued'); await b.wait(1500);
    let s = await stored(b);
    ok(Object.values(s.companies).filter((c) => c.kind === 'customer' && c.name === 'Beta a.s.').length === 1, 'issuing saves the typed customer once');
    await b.eval('location.hash = "#documents"'); await b.wait(300);
    await b.clickText('button', 'New document'); await b.wait(400);
    await b.fill('#f-customer', ''); await b.wait(200);
    await b.fill('#to-name', 'beta a.s.'); await b.wait(200);
    await b.fill('#f-status', 'issued'); await b.wait(1500);
    s = await stored(b);
    ok(Object.values(s.companies).filter((c) => c.kind === 'customer').length === 1, '#5 the same customer typed again is not saved twice', Object.values(s.companies).map((c) => c.name));

    console.log('#7 an issued document stays with its company');
    await b.eval('location.hash = "#companies"'); await b.wait(300);
    await b.click('#add-company');
    await addCompany(b, 'Gama s.r.o.');
    await b.eval('location.hash = "#editor"'); await b.wait(400);
    ok((await b.eval('document.querySelector("#f-supplier") && document.querySelector("#f-supplier").disabled')) === true, 'supplier select is disabled on an issued document');

    console.log('#4 an unsaved open document goes with its deleted company');
    await b.eval('location.hash = "#companies"'); await b.wait(300);
    await b.eval('(function(){var rows=document.querySelectorAll(".ledger tbody tr");for(var i=0;i<rows.length;i++){if(/Gama/.test(rows[i].textContent)){var bs=rows[i].querySelectorAll("button");for(var j=0;j<bs.length;j++){if(bs[j].textContent==="New document"){bs[j].click();return;}}}}})()');
    await b.wait(400);
    ok(/Gama/.test(await b.text('.party-card .name')), 'a new, untouched document for Gama is open');
    await b.eval('location.hash = "#companies"'); await b.wait(300);
    await b.eval('(function(){var rows=document.querySelectorAll(".ledger tbody tr");for(var i=0;i<rows.length;i++){if(/Gama/.test(rows[i].textContent)){var bs=rows[i].querySelectorAll("button");for(var j=0;j<bs.length;j++){if(bs[j].textContent==="Delete"){bs[j].focus();bs[j].click();return;}}}}})()');
    await b.wait(150);
    ok((await b.eval('document.activeElement && document.activeElement.textContent')) === 'Keep', '#16 the confirmation takes the focus (on Keep)', await b.eval('document.activeElement && document.activeElement.textContent'));
    await b.clickText('button', 'Yes, delete'); await b.wait(300);
    ok((await b.eval('document.activeElement !== document.body')) === true, '#16 focus is not dropped after deleting');
    await b.eval('location.hash = "#editor"'); await b.wait(400);
    ok(!/Gama/.test((await b.text('#view')) || ''), 'the editor does not keep a document of the deleted company', ((await b.text('.party-card .name')) || ''));
    s = await stored(b);
    ok(Object.values(s.invoices).every((d) => Object.keys(s.companies).indexOf(d.supplierId) !== -1), 'no stored document points at a deleted company');

    console.log('#13 #12 a hostile backup');
    const hostile = {
      app: 'invoice-workbench', version: 1, companies: [
        { id: '__proto__', kind: 'customer', name: 'Proto' },
        { id: 'evil000000000001', kind: 'supplier', name: 'Evil <img src=x onerror=window.__pwned=1>', logo: { src: 'https://example.invalid/track.png', w: 10, h: 10 }, stamp: { src: 'data:image/svg+xml;base64,PHN2Zy8+', w: 10, h: 10 }, bank: {}, defaults: {} }
      ], invoices: []
    };
    await b.eval('location.hash = "#backup"'); await b.wait(300);
    await b.eval('(function(){var f=new File([' + JSON.stringify(JSON.stringify(hostile)) + '],"b.json",{type:"application/json"});var dt=new DataTransfer();dt.items.add(f);var i=document.querySelector("#import-file");i.files=dt.files;i.dispatchEvent(new Event("change",{bubbles:true}));})()');
    await b.wait(900);
    s = await stored(b);
    ok(!Object.prototype.hasOwnProperty.call(s.companies, '__proto__') && !Object.values(s.companies).some((c) => c.name === 'Proto'), '#13 a record called __proto__ is refused');
    const evil = Object.values(s.companies).find((c) => c.id === 'evil000000000001');
    ok(evil && evil.logo === null && evil.stamp === null, '#12 a remote or SVG image is dropped on import', evil && { logo: evil.logo, stamp: evil.stamp });
    await b.eval('location.hash = "#companies"'); await b.wait(300);
    ok((await b.eval('window.__pwned')) === undefined && (await b.eval('document.querySelectorAll("#view img").length')) === 0, 'typed markup in a name stays text');

    console.log('#34 #36 #35 the documents themselves');
    const out = await b.eval(`(function(){
      var C = window.InvoiceCore, I = window.InvoiceI18n, R = window.InvoiceRender;
      var sup = C.newCompany('supplier'); sup.name = 'X'; sup.vatPayer = true;
      var res = {};
      ['de', 'nl', 'pl', 'uk', 'fr', 'es', 'sk', 'sr', 'en', 'cs'].forEach(function (lang) {
        ['invoice_vat', 'invoice_novat', 'reverse_charge'].forEach(function (kind) {
          var inv = C.newInvoice(sup, { today: '2026-11-17', kind: kind }); inv.language = lang;
          inv.items[0].description = 'A'; inv.items[0].price = 10;
          var vm = C.buildViewModel(inv, { labels: I.get(lang), countryName: function (c) { return c; }, images: {} });
          var words = {}; vm.items.columns.forEach(function (c) { String(c.label).split(/\\s+/).forEach(function (w) { words[w] = 1; }); });
          var texts = {}; R.layout(vm).pages[0].ops.forEach(function (o) { if (o.s != null) texts[String(o.s)] = 1; });
          vm.items.columns.forEach(function (c) {
            String(c.label).split(/\\s+/).forEach(function (w) {
              var whole = Object.keys(texts).some(function (t) { return t.split(/\\s+/).indexOf(w) !== -1; });
              if (!whole) (res.split = res.split || []).push(lang + '/' + kind + ':' + w);
            });
          });
          if (lang === 'uk' && kind === 'invoice_vat') res.ukFile = vm.meta.fileName;
          if (lang === 'pl' && kind === 'invoice_novat') res.plTotal = vm.items.columns[vm.items.columns.length - 1].label;
        });
      });
      return res;
    })()`);
    ok(!out.split, '#34 no column heading is split inside a word in any language', out.split);
    ok(/^Invoice-\d+\.pdf$/.test(out.ukFile), '#36 a Ukrainian document still gets a readable file name', out.ukFile);
    ok(out.plTotal === 'Wartość', '#35 Polish non-VAT total column is not called Brutto', out.plTotal);
    ok(b.errors.length === 0, 'no exceptions or console errors', b.errors.slice(0, 5));
  } catch (e) {
    failures++;
    console.log('  FAIL (threw) ' + e.message + '  errors: ' + JSON.stringify(b.errors.slice(0, 5)));
  }
  await b.close();

  console.log('second round: what the check of the fixes found');
  {
    const C = require(path.join(ROOT, 'core.js'));
    const I = require(path.join(ROOT, 'i18n.js'));
    const sup = C.newCompany('supplier'); sup.vatPayer = true;
    const inv = C.newInvoice(sup, { today: '2026-11-17' });
    inv.currency = 'EUR'; inv.exchangeRate = 25.1234;
    inv.items[0].qty = 1; inv.items[0].price = 333.33; inv.items[0].vatRate = 12;
    const note = C.buildViewModel(inv, { labels: I.get('cs'), countryName: (c) => c, images: {} }).notes.join(' ').replace(/ /g, ' ');
    ok(/8 374,38 Kč/.test(note) && /1 004,93 Kč/.test(note), 'the CZK tax follows from the CZK base (8 374,38 at 12 % is 1 004,93)', note);
    ok(C.duplicateInvoice(inv, { today: '2026-12-01' }).exchangeRate === '', 'a copy does not carry the old exchange rate');
  }
  fs.rmSync(profile, { recursive: true, force: true });
  b = await launch({ width: 1360, height: 1000, profile });
  try {
    await b.goto(LOCAL + '#companies', 2200);
    await b.click('#add-company');
    await b.waitFor('document.querySelector("#dialog").open');
    await b.clickText('#dialog button', 'Save');
    await b.wait(200);
    ok((await b.eval('document.querySelector("#co-name").getAttribute("aria-invalid")')) === 'true', 'an empty name marks the field invalid');
    const slot = await b.eval('(function(){var t=document.querySelector("#dialog .toasts"),h=document.querySelector("#dialog .dialog-head");return {text:t?t.textContent:"",top:t?t.getBoundingClientRect().top:0,headBottom:h.getBoundingClientRect().bottom};})()');
    ok(/name/.test(slot.text) && slot.top >= slot.headBottom - 1, 'the message sits under the dialog heading, not over it', slot);
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await b.wait(300);
    ok((await b.eval('document.querySelector("#dialog").open')) === false && (await b.eval('document.activeElement && document.activeElement.id')) === 'add-company', 'Escape closes the dialog and focus returns to its opener', await b.eval('document.activeElement && document.activeElement.id'));

    await b.click('#add-company');
    await addCompany(b, 'Epsilon s.r.o.', { vat: true });
    for (let i = 0; i < 2; i++) {
      await b.click('#add-customer');
      await b.waitFor('document.querySelector("#dialog").open');
      await b.fill('#co-name', 'Twin');
      if (i === 0) await b.fill('#co-ico', '00006947');
      await b.clickText('#dialog button', 'Save');
      await b.waitFor('!document.querySelector("#dialog").open');
      await b.wait(200);
    }
    await b.eval('location.hash = "#documents"'); await b.wait(300);
    await b.clickText('button', 'New document'); await b.wait(400);
    await b.fill('#to-name', 'twin'); await b.wait(200);
    await b.click('#f-save-customer'); await b.wait(400);
    let s = await stored(b);
    ok(Object.values(s.companies).filter((c) => c.kind === 'customer').length === 3, 'a name shared by two customers is not linked to either: a new one is saved', Object.values(s.companies).map((c) => c.name));

    await b.eval('Array.prototype.forEach.call(document.querySelectorAll("details.more"), function (d) { d.open = true; })');
    ok((await b.eval('document.querySelector("#f-vs").hasAttribute("maxlength")')) === false, 'symbol fields no longer cut a paste short');
    await b.fill('#f-vs', '12345');
    // real typing, through the browser's own input path, so the caret behaves as it does for a person
    await b.eval('(function(){var el=document.querySelector("#f-vs");el.focus();el.setSelectionRange(2,2);})()');
    await b.send('Input.insertText', { text: 'x' });
    ok((await b.eval('document.querySelector("#f-vs").selectionStart')) === 2 && (await b.eval('document.querySelector("#f-vs").value')) === '12345', 'a refused character leaves the caret where it was', await b.eval('[document.querySelector("#f-vs").value, document.querySelector("#f-vs").selectionStart]'));
    await b.send('Input.insertText', { text: '9' });
    ok((await b.eval('document.querySelector("#f-vs").value')) === '129345', 'and the next digit goes in at the caret', await b.eval('document.querySelector("#f-vs").value'));
    await b.eval('(function(){var el=document.querySelector("#f-ks");el.focus();el.select();})()');
    await b.send('Input.insertText', { text: 'VS 123-456-7890' });
    ok((await b.eval('document.querySelector("#f-ks").value')) === '1234567890', 'a paste with separators keeps all ten digits', await b.eval('document.querySelector("#f-ks").value'));

    await b.fill('#f-issue', ''); await b.wait(100);
    await b.fill('#f-issue', (year + 2) + '-02-03'); await b.wait(300);
    ok((await b.eval('document.querySelector("#f-number").value')) === (year + 2) + '0001', 'a date cleared and picked again still moves the draft number', await b.eval('document.querySelector("#f-number").value'));

    await b.fill('#f-customer', await b.eval('(function(){var o=document.querySelector("#f-customer").options;for(var i=0;i<o.length;i++){if(/00006947/.test(o[i].textContent))return o[i].value;}return "";})()'));
    await b.wait(1500);
    await b.eval('location.hash = "#documents"'); await b.wait(400);
    await b.eval('window.__blobs=[];(function(){var o=URL.createObjectURL;URL.createObjectURL=function(x){window.__blobs.push(x);return o.call(URL,x);};})()');
    await b.click('#export-csv'); await b.wait(500);
    const csv = await b.eval('window.__blobs.length ? window.__blobs[0].text() : ""');
    const bom = await b.eval('window.__blobs.length ? window.__blobs[0].arrayBuffer().then(function (a) { return Array.prototype.slice.call(new Uint8Array(a, 0, 3)); }) : []');
    ok(bom.join(',') === '239,187,191', 'the CSV starts with a UTF-8 byte order mark', bom);
    ok(/;"=""00006947""";/.test(csv), 'the CSV keeps the leading zeros of an IČO', csv.slice(0, 400));
    ok(b.errors.length === 0, 'no exceptions or console errors', b.errors.slice(0, 5));
  } catch (e) {
    failures++;
    console.log('  FAIL (threw) ' + e.message + '  errors: ' + JSON.stringify(b.errors.slice(0, 5)));
  }
  await b.close();

  console.log('#9 a refused save is kept and retried (hosted stand-in)');
  fs.rmSync(profile, { recursive: true, force: true });
  b = await launch({ width: 1360, height: 1000, profile });
  try {
    await b.goto(HOSTED, 2200);
    await b.clickText('button', 'Add my company');
    await addCompany(b, 'Delta s.r.o.');
    await b.eval('window.__mock.fail = { code: "quota_exceeded", message: "full" }');
    await b.fill('#to-name', 'Kupec a.s.');
    await b.wait(1600);
    ok(/Not saved/.test(await b.text('#save-state')), 'the editor says it was not saved', await b.text('#save-state'));
    ok(/Not saved/.test(await b.text('#storage-state')), 'and so does the top bar', await b.text('#storage-state'));
    await b.eval('window.__mock.fail = null');
    await b.eval('location.hash = "#documents"'); await b.wait(900);
    const written = await b.eval('Object.keys(window.__mock.docs).filter(function (p) { return /invoices/.test(p); }).length');
    ok(written === 1, 'leaving the editor retries, and the document reaches storage', written);
    ok(/Saved to your account/.test(await b.text('#storage-state')), 'the top bar clears', await b.text('#storage-state'));
    await b.clickText('button', 'Export this list (CSV)'); await b.wait(500);
    const saved = await b.eval('window.__mock.saved');
    ok(saved.length === 1 && /^documents-\d{4}-\d{2}-\d{2}\.csv$/.test(saved[0].filename), 'the list exports as CSV through downloads', saved);
    ok(b.errors.length === 0, 'no exceptions or console errors', b.errors.slice(0, 5));
  } catch (e) {
    failures++;
    console.log('  FAIL (threw) ' + e.message + '  errors: ' + JSON.stringify(b.errors.slice(0, 5)));
  }
  await b.close();
  fs.rmSync(profile, { recursive: true, force: true });
  console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})();
