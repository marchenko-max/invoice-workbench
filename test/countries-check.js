/*
 * Drives a company outside the Czech Republic through the page: an American one (sales tax, EIN, routing and
 * account number) and a Ukrainian one (ПДВ, ЄДРПОУ, IBAN), and a tax with a name of its own.
 * Run from the project folder:  node test/countries-check.js      Screenshots land in test/out/countries-*.png.
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { launch } = require('./cdp.js');

const ROOT = path.resolve(__dirname, '..');
require('node:child_process').execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build.js')]);
const URL = 'file://' + path.join(ROOT, 'dist', 'index.html');
const OUT = path.join(__dirname, 'out');
const profile = path.join(__dirname, '.chrome-countries');

let failures = 0;
function ok(cond, what, detail) {
  if (cond) console.log('  ok   ' + what);
  else { failures++; console.log('  FAIL ' + what + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}
const plain = function (s) { return String(s == null ? '' : s).replace(/ /g, ' '); };
const labelOf = function (id) { return '(function(){var l=document.querySelector("label[for=' + id + ']");return l?l.textContent:null})()'; };
const dialogOpen = 'document.querySelector("#dialog").open';
const preview = 'document.querySelector("#preview-host").textContent';

(async () => {
  fs.rmSync(profile, { recursive: true, force: true });
  const b = await launch({ width: 1360, height: 1000, profile });
  try {
    console.log('1. the company dialog follows the country: an American company');
    await b.goto(URL + '#documents', 2400);
    await b.clickText('button', 'Add my company');
    await b.waitFor(dialogOpen);
    ok((await b.eval(labelOf('co-ico'))) === 'IČO (company number)' && (await b.eval(labelOf('co-dic'))) === 'DIČ (VAT number)', 'a Czech company is asked for its IČO and DIČ');
    ok((await b.eval('document.querySelector("#co-bank-kind").value')) === 'cz' && (await b.eval('!!document.querySelector("#co-account")')) === true, 'and a Czech account');
    const firstField = await b.eval('(function(){var f=document.querySelector("#dialog .dialog-body .field");return {label:f.querySelector("label").textContent,id:f.querySelector("select,input").id,hint:(f.querySelector(".hint")||{}).textContent}})()');
    ok(firstField.label === 'Country' && firstField.id === 'co-country' && /how the bank account is written/.test(firstField.hint || ''), 'the country is the first thing asked, and says what it decides', firstField);
    await b.fill('#co-name', 'Made-up Studio LLC');
    await b.fill('#co-country', 'US');
    ok((await b.eval(labelOf('co-ico'))) === 'EIN (tax ID)', 'choosing the United States asks for an EIN', await b.eval(labelOf('co-ico')));
    ok((await b.eval('document.activeElement && document.activeElement.id')) === 'co-country', 'the keyboard stays on the country');
    ok((await b.text('label.check:has(#co-vat)')).indexOf('This company charges sales tax') === 0, 'the tax is sales tax', await b.text('label.check:has(#co-vat)'));
    ok((await b.eval('(function(){var l=[].filter.call(document.querySelectorAll("#dialog button"),function(x){return x.textContent==="Look up in ARES"})[0];return !l||l.closest(".field").hidden})()')) === true, 'the Czech register lookup is gone');
    ok((await b.eval('document.querySelector("#co-bank-kind").value')) === 'us' && (await b.eval('!!document.querySelector("#co-routing")')) === true && (await b.eval('!!document.querySelector("#co-iban")')) === false, 'the account is a routing number and an account number');
    ok((await b.eval('document.querySelector("#co-name").value')) === 'Made-up Studio LLC', 'what was typed is kept');
    await b.fill('#co-ico', '12-3456789');
    await b.check('#co-vat', true);
    await b.fill('#co-tax-rate', '8.25');
    await b.fill('#co-tax-rate', 'eight');
    await b.clickText('#dialog button', 'Save');
    await b.wait(300);
    ok((await b.eval(dialogOpen)) === true && /usual rate is a number/.test(await b.text('#dialog .toasts')), 'a usual rate that is not a number is refused and said', await b.text('#dialog .toasts'));
    ok((await b.eval('document.activeElement && document.activeElement.id')) === 'co-tax-rate', 'with the keyboard on it');
    await b.fill('#co-tax-rate', '8,25 %');
    await b.fill('#co-bank-name', 'First Made-up Bank');
    await b.fill('#co-routing', '021000022');
    ok(/Not a valid routing number/.test(await b.text('#co-routing-hint')), 'a routing number with a wrong digit is said to be wrong', await b.text('#co-routing-hint'));
    await b.fill('#co-routing', '021000021');
    ok((await b.text('#co-routing-hint')) === 'Valid routing number', 'and a right one right');
    await b.fill('#co-account', '000123456789');
    await b.screenshot(path.join(OUT, 'countries-1-us-dialog.png'));
    await b.clickText('#dialog button', 'Save');
    await b.waitFor('!' + dialogOpen);
    await b.waitFor('document.querySelector("#doc-title")');
    await b.wait(900);

    console.log('2. its invoice: a subtotal, sales tax, a total, and no word of VAT');
    ok((await b.eval('document.querySelector("#f-language").value')) === 'en' && (await b.eval('document.querySelector("#f-currency").value')) === 'USD', 'in English and in dollars');
    const kinds = await b.eval('[].map.call(document.querySelectorAll("#f-kind option"),function(o){return o.textContent})');
    ok(kinds.indexOf('Invoice with sales tax') !== -1 && kinds.indexOf('Invoice with no tax') !== -1 && !kinds.some(function (k) { return /VAT payer/.test(k); }), 'the kinds of document speak of sales tax', kinds);
    ok(!kinds.some(function (k) { return /Reverse-charge/.test(k); }) && kinds.indexOf('Corrective invoice') !== -1, 'with no reverse charge, and a corrective invoice in place of a corrective tax document', kinds);
    const rateField = await b.eval('(function(){var i=document.querySelector("[id$=-vat]");return i?{label:document.querySelector("label[for="+i.id+"]").textContent,value:i.value,id:i.id}:null})()');
    ok(rateField && rateField.label === 'Sales tax %' && rateField.value === '8.25', 'a line starts at the company’s usual 8.25 %', rateField);
    await b.eval('(function(){var p=document.querySelector("[id$=-price]");p.focus();p.value="1000";p.dispatchEvent(new Event("input",{bubbles:true}));var d=document.querySelector("[id$=-desc], textarea[id*=desc]");if(d){d.value="Design work";d.dispatchEvent(new Event("input",{bubbles:true}));}})()');
    await b.wait(1200);
    const page = plain(await b.eval(preview));
    ok(/Subtotal/.test(page) && /Sales tax/.test(page) && /\$1,082\.50/.test(page), 'the page shows Subtotal, Sales tax and $1,082.50', page.slice(0, 400));
    ok(/EIN/.test(page) && /12-3456789/.test(page), 'the EIN under its own name');
    ok(/ABA routing no\./.test(page) && /021000021/.test(page) && /000123456789/.test(page) && /First Made-up Bank/.test(page), 'the bank, its routing number and the account');
    ok(!/VAT/.test(page) && !/DPH/.test(page), 'and nowhere the word VAT', page.match(/.{20}(VAT|DPH).{20}/));
    ok((await b.eval('document.querySelector("#f-bank-kind").value')) === 'us' && (await b.eval('!!document.querySelector("#f-routing")')) === true, 'the Payment section has the same kind of account');
    ok(/needs an IBAN/.test(await b.text('#qr-hint')), 'and says why there is no payment code', await b.text('#qr-hint'));
    const checks = await b.text('#checks');
    ok(!/Czech form|CZK|check digits/.test(checks), 'no warnings meant for a Czech account or a Czech tax document', checks);
    ok((await b.eval('!!document.querySelector("#f-rate")')) === false, 'no crown exchange rate is asked for');
    const form = plain(await b.text('#form, form, #view'));
    ok(/EIN 12-3456789/.test(form) && !/IČO 12-3456789/.test(form), 'the form shows the EIN as an EIN');
    ok((await b.eval('!!document.querySelector("#f-tax")')) === false, 'there is no date of taxable supply to fill in');
    ok(/Prices before tax/.test(form) && !/Prices without VAT/.test(form), 'prices are typed before tax, not "without VAT"');
    ok(/Subtotal/.test(plain(await b.text('#totals'))) && /Sales tax 8\.25%/.test(plain(await b.text('#totals'))) && !/VAT/.test(await b.text('#totals')), 'the totals box says Subtotal and Sales tax 8.25%', await b.text('#totals'));
    ok(!/Variable symbol/.test(page) && (await b.eval('!!document.querySelector("#f-vs")')) === false, 'no Czech variable symbol on the page or in the form');
    ok(!/VAT payer|DIČ/.test(checks), 'and no warning about a VAT number', checks);
    await b.screenshot(path.join(OUT, 'countries-2-us-invoice.png'), { full: true });

    console.log('3. the kind of account can be changed on a document');
    await b.fill('#f-bank-kind', 'iban');
    ok((await b.eval('!!document.querySelector("#f-iban")')) === true && (await b.eval('!!document.querySelector("#f-routing")')) === false, 'an IBAN is asked for instead');
    await b.fill('#f-iban', 'UA21 3223 1300 0002 6007 2335 6600 1');
    ok((await b.text('#f-iban-hint')) === 'Valid IBAN', 'a Ukrainian IBAN is recognised', await b.text('#f-iban-hint'));
    await b.fill('#f-iban', 'UA21 3223 1300 0002 6007 2335 6600 2');
    ok((await b.text('#f-iban-hint')) === 'Not a valid IBAN', 'and one with a wrong digit is not');
    await b.fill('#f-bank-kind', 'us');
    await b.wait(1200);
    ok((await b.eval('document.querySelector("#f-routing").value')) === '021000021', 'going back keeps the routing number');

    console.log('4. a Ukrainian company');
    await b.goto(URL + '#companies', 1800);
    await b.clickText('button', 'Add my company');
    await b.waitFor(dialogOpen);
    await b.fill('#co-name', 'Вигадана студія');
    await b.fill('#co-country', 'UA');
    ok((await b.eval(labelOf('co-ico'))) === 'ЄДРПОУ or РНОКПП (company code)' && (await b.eval(labelOf('co-dic'))) === 'ІПН (VAT number)', 'its numbers by their own names', await b.eval(labelOf('co-ico')));
    ok((await b.text('label.check:has(#co-vat)')).indexOf('This company is a VAT payer') === 0, 'its tax is VAT');
    ok((await b.eval('document.querySelector("#co-bank-kind").value')) === 'iban' && (await b.eval('document.querySelector("#co-tax-rate").placeholder')) === '20', 'an IBAN, and 20 % as the usual rate');
    await b.fill('#co-ico', '12345678');
    await b.fill('#co-dic', '123456789012');
    await b.check('#co-vat', true);
    await b.fill('#co-iban', 'UA213223130000026007233566001');
    ok((await b.text('#co-iban-hint')) === 'Valid IBAN', 'its IBAN is checked', await b.text('#co-iban-hint'));
    await b.clickText('#dialog button', 'Save');
    await b.waitFor('!' + dialogOpen);
    await b.wait(600);
    const rows = plain(await b.text('#view'));
    ok(/Charges sales tax/.test(rows) && /VAT payer/.test(rows), 'the list says which company charges what', rows.slice(0, 300));
    const stored = await b.eval('(function(){var d=JSON.parse(localStorage.getItem("invoice-workbench:v1"));return Object.keys(d.companies).map(function(k){var c=d.companies[k];return {country:c.country,cur:c.defaults.currency,lang:c.defaults.language,rate:c.defaults.taxRate,kind:c.bank.kind,routing:c.bank.routing,iban:c.bank.iban}}).sort(function(a,b){return a.country<b.country?-1:1})})()');
    ok(JSON.stringify(stored) === JSON.stringify([{ country: 'UA', cur: 'UAH', lang: 'uk', rate: '', kind: 'iban', routing: '', iban: 'UA213223130000026007233566001' }, { country: 'US', cur: 'USD', lang: 'en', rate: '8.25', kind: 'us', routing: '021000021', iban: '' }]), 'both are saved with their country’s currency and language', stored);

    console.log('4b. an account number typed before its routing number stays an American account');
    await b.clickText('button', 'Add my company');
    await b.waitFor(dialogOpen);
    await b.fill('#co-name', 'Half-filled Inc');
    await b.fill('#co-country', 'US');
    await b.fill('#co-account', '55501234');
    await b.clickText('#dialog button', 'Save');
    await b.waitFor('!' + dialogOpen);
    await b.wait(500);
    await b.eval('(function(){var rows=document.querySelectorAll("#view tr");for(var i=0;i<rows.length;i++)if(/Half-filled/.test(rows[i].textContent)){[].filter.call(rows[i].querySelectorAll("button"),function(x){return x.textContent==="Edit"})[0].click();return}})()');
    await b.waitFor(dialogOpen);
    ok((await b.eval('document.querySelector("#co-bank-kind").value')) === 'us' && (await b.eval('document.querySelector("#co-account").value')) === '55501234' && (await b.eval('!!document.querySelector("#co-routing")')) === true, 'reopened, it is still a US account waiting for its routing number', await b.eval('document.querySelector("#co-bank-kind").value'));
    await b.fill('#co-country', 'DE');
    await b.fill('#co-country', 'UA');
    ok((await b.eval('document.querySelector("#co-bank-kind").value')) === 'us', 'and a filled-in account keeps its kind when the country is changed');
    await b.clickText('#dialog button', 'Cancel');
    await b.waitFor('!' + dialogOpen);

    console.log('4c. a company being added follows its country through one that says nothing');
    await b.clickText('button', 'Add my company');
    await b.waitFor(dialogOpen);
    await b.fill('#co-name', 'Wanderer');
    for (const c of ['US', 'DE', 'UA', 'DE', 'CZ']) await b.fill('#co-country', c);
    const back = await b.eval('(function(){var d=document.querySelector("#dialog");var cur=[].filter.call(d.querySelectorAll("select"),function(x){return [].some.call(x.options,function(o){return o.value==="UAH"})})[0];return {currency:cur?cur.value:null,kind:document.querySelector("#co-bank-kind").value,name:document.querySelector("#co-name").value}})()');
    ok(back.currency === 'CZK' && back.kind === 'cz' && back.name === 'Wanderer', 'back in the Czech Republic it is in crowns with a Czech account again', back);
    await b.clickText('#dialog button', 'Cancel');
    await b.waitFor('!' + dialogOpen);

    console.log('5. its invoice: ПДВ at 20 %, ЄДРПОУ, IBAN');
    await b.goto(URL + '#documents', 1500);
    await b.clickText('button', 'New document');
    await b.waitFor('document.querySelector("#doc-title")');
    await b.wait(600);
    await b.eval('(function(){var s=document.querySelector("#f-supplier");var o=[].filter.call(s.options,function(x){return /Вигадана/.test(x.textContent)})[0];s.value=o.value;s.dispatchEvent(new Event("change",{bubbles:true}));})()');
    await b.wait(900);
    ok((await b.eval('document.querySelector("#f-language").value')) === 'uk' && (await b.eval('document.querySelector("#f-currency").value')) === 'UAH', 'in Ukrainian and in hryvnias');
    const uaRate = await b.eval('(function(){var i=document.querySelector("[id$=-vat]");return {label:document.querySelector("label[for="+i.id+"]").textContent,value:i.value}})()');
    ok(uaRate.label === 'VAT %' && uaRate.value === '20', 'a line starts at 20 %', uaRate);
    ok(JSON.stringify(await b.eval('[].map.call(document.querySelectorAll("#vat-list option"),function(o){return o.value})')) === '["20","14","7","0"]', 'with Ukraine’s rates on offer');
    await b.eval('(function(){var p=document.querySelector("[id$=-price]");p.focus();p.value="1000";p.dispatchEvent(new Event("input",{bubbles:true}));})()');
    await b.wait(1200);
    const ua = plain(await b.eval(preview));
    // a 29-character IBAN is written over two lines of the payment column, so it is looked for without its spaces
    ok(/ЄДРПОУ/.test(ua) && /ІПН/.test(ua) && /ПДВ/.test(ua) && /UA213223130000026007233566001/.test(ua.replace(/ /g, '')), 'the page shows ЄДРПОУ, ІПН, ПДВ and the IBAN', ua.slice(0, 300));
    ok(/1 200,00/.test(ua), 'and 1 200,00 to pay', ua.match(/.{0,30}200,00.{0,10}/));
    ok(!/Призначення платежу/.test(ua) && (await b.eval('!!document.querySelector("#f-vs")')) === false, 'with no Czech payment symbol on the page or in the form');
    await b.screenshot(path.join(OUT, 'countries-3-ua-invoice.png'), { full: true });

    console.log('6. a tax with a name of its own');
    await b.goto(URL + '#companies', 1800);
    await b.eval('(function(){var rows=document.querySelectorAll("#view tr");for(var i=0;i<rows.length;i++)if(/Made-up Studio/.test(rows[i].textContent)){var e=[].filter.call(rows[i].querySelectorAll("button"),function(x){return x.textContent==="Edit"})[0];e.click();return}})()');
    await b.waitFor(dialogOpen);
    await b.fill('#co-tax-name', 'GST');
    await b.fill('#co-tax-rate', '');
    await b.clickText('#dialog button', 'Save');
    await b.waitFor('!' + dialogOpen);
    await b.wait(500);
    ok(/Charges GST/.test(await b.text('#view')), 'the list calls it GST');
    await b.goto(URL + '#documents', 1500);
    await b.clickText('button', 'New document');
    await b.waitFor('document.querySelector("#doc-title")');
    await b.wait(600);
    await b.eval('(function(){var s=document.querySelector("#f-supplier");var o=[].filter.call(s.options,function(x){return /Made-up Studio/.test(x.textContent)})[0];s.value=o.value;s.dispatchEvent(new Event("change",{bubbles:true}));})()');
    await b.wait(900);
    await b.eval('(function(){var v=document.querySelector("[id$=-vat]");v.focus();v.value="10";v.dispatchEvent(new Event("input",{bubbles:true}));var p=document.querySelector("[id$=-price]");p.value="200";p.dispatchEvent(new Event("input",{bubbles:true}));})()');
    await b.wait(1200);
    const gst = plain(await b.eval(preview));
    ok(/GST/.test(gst) && /Subtotal/.test(gst) && /\$220\.00/.test(gst) && !/Sales tax/.test(gst), 'the document says GST and adds it up', gst.slice(0, 300));
    ok((await b.eval('(function(){var i=document.querySelector("[id$=-vat]");return document.querySelector("label[for="+i.id+"]").textContent})()')) === 'GST %', 'and so does the form');

    console.log('7. on a phone the American account fits');
    await b.setViewport(390, 800, true);
    await b.goto(URL + '#companies', 1800);
    await b.eval('(function(){var e=[].filter.call(document.querySelectorAll("#view button"),function(x){return x.textContent==="Edit"})[0];e.click();})()');
    await b.waitFor(dialogOpen);
    ok((await b.eval('(function(){var d=document.querySelector("#dialog .dialog-body");return d.scrollWidth<=d.clientWidth+1})()')) === true, 'the dialog does not scroll sideways');
    await b.eval('document.querySelector("#co-bank-kind").scrollIntoView({block:"start"})');
    await b.screenshot(path.join(OUT, 'countries-4-phone.png'));

    console.log('8. no script errors');
    ok(b.errors.length === 0, 'no exceptions or console errors', b.errors);
  } catch (e) {
    failures++;
    console.log('  FAIL the run stopped: ' + (e && e.stack || e));
    try { await b.screenshot(path.join(OUT, 'countries-crash.png')); } catch (ignored) { /* nothing to show */ }
  } finally {
    await b.close();
  }
  console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})();
