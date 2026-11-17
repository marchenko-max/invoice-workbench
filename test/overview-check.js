/*
 * Drives the Overview screen in headless Chrome with a year of made-up documents: the headline figure, the chart,
 * the status tiles, the customers, the filters, and the cases with nothing to draw.
 * Run from the project folder:  node test/overview-check.js
 * Screenshots land in test/out/overview-*.png.
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { launch } = require('./cdp.js');

const ROOT = path.resolve(__dirname, '..');
require('node:child_process').execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build.js')]);
const URL = 'file://' + path.join(ROOT, 'dist', 'index.html');
const OUT = path.join(__dirname, 'out');
const profile = path.join(__dirname, '.chrome-overview');

let failures = 0;
function ok(cond, what, detail) {
  if (cond) console.log('  ok   ' + what);
  else { failures++; console.log('  FAIL ' + what + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}
const plain = function (s) { return String(s == null ? '' : s).replace(/ /g, ' '); };

// [issue date relative to today in months back, day, amount, status, customer, currency]
// Dates are built in the page from its own "today", so the test does not go stale.
const SEED = `(function(){
  var C = InvoiceCore;
  var today = C.localToday();
  function monthsBack(n, day) {
    var y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7)) - 1 - n;
    while (m < 0) { m += 12; y -= 1; }
    var d = String(Math.min(day, 28));
    return y + '-' + String(m + 1).padStart(2, '0') + '-' + d.padStart(2, '0');
  }
  var sup = C.newCompany('supplier'); sup.name = 'Ukázka s.r.o.';
  var second = C.newCompany('supplier'); second.name = 'Druhá firma s.r.o.';
  var data = { companies: {}, invoices: {}, settings: {} };
  data.companies[sup.id] = sup; data.companies[second.id] = second;
  var rows = [
    [11, 12, 132000, 'paid', 'Alfa s.r.o.', 'CZK', sup], [10, 10, 139500, 'paid', 'Alfa s.r.o.', 'CZK', sup],
    [8, 2, 71500, 'paid', 'Alfa s.r.o.', 'CZK', sup], [8, 27, 155098.89, 'paid', 'Beta a.s.', 'CZK', sup],
    [3, 5, 30782.89, 'issued', 'Gama s.r.o.', 'CZK', sup], [0, 1, 48000, 'issued', 'Delta k.s.', 'CZK', sup],
    [0, 1, 12000, 'draft', 'Delta k.s.', 'CZK', sup], [2, 9, 1000, 'paid', 'Epsilon GmbH', 'EUR', sup],
    [1, 3, 20000, 'paid', 'Alfa s.r.o.', 'CZK', second], [30, 3, 99000, 'paid', 'Stará a.s.', 'CZK', sup]
  ];
  rows.forEach(function (r, i) {
    var issue = monthsBack(r[0], r[1]);
    var d = C.newInvoice(r[6], { today: issue });
    d.number = 'T' + (i + 1); d.items[0].price = r[2]; d.items[0].description = 'Práce'; d.status = r[3];
    d.customer.name = r[4]; d.currency = r[5];
    d.dueDate = r[3] === 'issued' && r[0] > 1 ? C.addDays(issue, 14) : C.addDays(today, 10);
    d.paidDate = r[3] === 'paid' ? issue : '';
    d.createdAt = d.updatedAt = issue + 'T10:00:00.000Z';
    data.invoices[d.id] = d;
  });
  var q = C.newInvoice(sup, { today: today, kind: 'quote_novat' });
  q.number = 'N1'; q.items[0].price = 500000; q.status = 'issued'; q.customer.name = 'Jen nabídka'; data.invoices[q.id] = q;
  localStorage.setItem('invoice-workbench:v1', JSON.stringify(data));
  return sup.id;
})()`;

(async () => {
  fs.rmSync(profile, { recursive: true, force: true });
  const b = await launch({ width: 1360, height: 1000, profile });
  try {
    console.log('1. with nothing issued the Overview says what it will show');
    await b.goto(URL + '#overview', 2400);
    ok((await b.text('#view h1')) === 'Overview', 'the tab opens');
    ok(/month by month/.test(await b.text('#view .empty')), 'an empty state, not an empty chart', await b.text('#view .empty'));
    ok((await b.eval('!!document.querySelector("#income-chart")')) === false, 'no chart is drawn');
    ok((await b.eval('document.querySelector("#tab-overview").getAttribute("aria-current")')) === 'page', 'the tab is marked as the current one', await b.eval('document.querySelector("#tab-overview").outerHTML'));

    console.log('2. a year of documents');
    const supId = await b.eval(SEED);
    await b.goto(URL + '#overview', 2400);
    ok(plain(await b.text('#ov-total')) === '596,881.78 Kč', 'invoiced in CZK over the 13 months: 596,881.78 Kč', await b.text('#ov-total'));
    ok(/7 documents/.test(await b.text('.hero .sub')), 'seven documents counted: no draft, no quotation, no EUR, none 30 months old', await b.text('.hero .sub'));
    ok(/Where the documents issued in these months stand/.test(await b.text('#view')), 'the tiles say they go by issue date');
    ok((await b.eval('document.querySelectorAll("#income-chart .col").length')) === 13, 'thirteen columns, one per month');
    ok((await b.eval('document.querySelectorAll("#income-chart .bar").length')) === 6, 'six months have something in them', await b.eval('document.querySelectorAll("#income-chart .bar").length'));
    const widths = await b.eval('[].map.call(document.querySelectorAll("#income-chart .bar"),function(p){return Math.round(p.getBBox().width)})');
    ok(widths.every(function (w) { return w <= 24 && w >= 4; }), 'no column is wider than 24 px', widths);
    const tiles = await b.eval('[].map.call(document.querySelectorAll(".tile"),function(t){return t.id+": "+t.querySelector(".value").textContent+" / "+t.querySelector(".count").textContent})');
    ok(plain(tiles.join(' | ')) === 'ov-paid: 518,098.89 Kč / 5 documents | ov-waiting: 48,000.00 Kč / 1 document | ov-overdue: 30,782.89 Kč / 1 document | ov-draft: 12,000.00 Kč / 1 document', 'the four tiles', tiles);
    const customers = plain(await b.text('#ov-customers tbody'));
    ok(/Alfa s\.r\.o\..*363,000\.00 Kč/.test(customers) && !/Jen nabídka/.test(customers) && !/Epsilon/.test(customers), 'customers by what they were invoiced, quotations and other currencies left out', customers);
    await b.screenshot(path.join(OUT, 'overview-1-light.png'), { full: true });

    console.log('3. the table says what the chart draws');
    const table = await b.eval('[].map.call(document.querySelectorAll("#ov-table tbody tr"),function(tr){return tr.children[1].textContent})');
    ok(table.length === 13, 'thirteen rows', table.length);
    const drawn = await b.eval('[].map.call(document.querySelectorAll("#income-chart .col"),function(g){return g.getAttribute("aria-label")})');
    ok(drawn.length === 13 && plain(drawn[drawn.length - 1]).indexOf(plain(table[0])) !== -1, 'the newest column and the first row agree', [drawn[drawn.length - 1], table[0]]);

    console.log('4. every column answers to the keyboard and the pointer');
    // headless Chrome's window never has the focus, so focus() moves the active element without firing the event
    await b.eval('(function(){var c=document.querySelectorAll("#income-chart .col")[12];c.focus();c.dispatchEvent(new FocusEvent("focus"));})()');
    ok((await b.eval('document.activeElement===document.querySelectorAll("#income-chart .col")[12]')) === true, 'a column takes the keyboard focus');
    ok((await b.eval('document.querySelector(".chart-tip").hidden')) === false, 'focus shows the figure');
    ok(/48,000\.00/.test(plain(await b.text('.chart-tip'))), 'this month: 48,000.00', await b.text('.chart-tip'));
    const inside = await b.eval('(function(){var t=document.querySelector(".chart-tip").getBoundingClientRect();var c=document.querySelector("#income-chart").getBoundingClientRect();return t.left>=c.left-1&&t.right<=c.right+1})()');
    ok(inside === true, 'and the figure stays inside the chart at its right edge');
    await b.eval('(function(){var c=document.querySelectorAll("#income-chart .col")[12];c.blur();c.dispatchEvent(new FocusEvent("blur"));})()');
    ok((await b.eval('document.querySelector(".chart-tip").hidden')) === true, 'and leaves with the focus');

    console.log('5. received, quarters and years');
    await b.click('#ov-paid');
    ok(plain(await b.text('#ov-total')) === '518,098.89 Kč', 'received: 518,098.89 Kč', await b.text('#ov-total'));
    ok((await b.eval('document.activeElement && document.activeElement.id')) === 'ov-paid', 'focus stays on the pressed segment', await b.eval('document.activeElement && document.activeElement.id'));
    ok((await b.eval('document.querySelector("#ov-paid").getAttribute("aria-pressed")')) === 'true' && (await b.eval('document.querySelector("#ov-issued").getAttribute("aria-pressed")')) === 'false', 'and says it is pressed');
    ok((await b.eval('getComputedStyle(document.querySelector("#income-chart .bar")).fill')) !== (await b.eval('(function(){document.querySelector("#ov-issued").click();var f=getComputedStyle(document.querySelector("#income-chart .bar")).fill;return f})()')), 'received and invoiced are drawn in different colours');
    await b.click('#ov-quarter');
    ok((await b.eval('document.querySelectorAll("#income-chart .col").length')) === 8, 'eight quarters');
    await b.click('#ov-year');
    const years = await b.eval('document.querySelectorAll("#income-chart .col").length');
    ok(years >= 3 && years <= 6, 'years reach back to the oldest document, six at most', years);
    ok(/99,000\.00/.test(plain(await b.text('#ov-table'))), 'the 30-month-old invoice is in its year', await b.text('#ov-table'));
    await b.click('#ov-month');

    console.log('6. one company, another currency');
    ok((await b.eval('!!document.querySelector("#ov-supplier")')) === true && (await b.eval('!!document.querySelector("#ov-currency")')) === true, 'both filters are offered when there is a choice');
    await b.fill('#ov-supplier', supId);
    ok(plain(await b.text('#ov-total')) === '576,881.78 Kč', 'the first company alone: 576,881.78 Kč', await b.text('#ov-total'));
    ok((await b.eval('document.activeElement && document.activeElement.id')) === 'ov-supplier', 'the keyboard stays on the company list after choosing', await b.eval('document.activeElement && document.activeElement.id'));
    await b.fill('#ov-currency', 'EUR');
    ok(/^1,000\.00/.test(plain(await b.text('#ov-total'))) && /€|EUR/.test(await b.text('#ov-total')), 'its euros are counted on their own', await b.text('#ov-total'));
    ok(/Epsilon GmbH/.test(await b.text('#ov-customers')), 'with their customer');
    ok((await b.eval('document.activeElement && document.activeElement.id')) === 'ov-currency', 'and on the currency list after choosing');
    await b.fill('#ov-supplier', '');
    await b.fill('#ov-currency', 'CZK');

    console.log('7. dark, and narrow');
    await b.setDark(true);
    await b.screenshot(path.join(OUT, 'overview-2-dark.png'), { full: true });
    await b.setDark(false);
    for (const w of [768, 390, 320]) {
      await b.setViewport(w, 800, true);
      await b.wait(500);
      ok((await b.eval('document.documentElement.scrollWidth<=innerWidth')) === true, 'no sideways scroll at ' + w + ' px', await b.eval('document.documentElement.scrollWidth'));
      const overlap = await b.eval('(function(){var t=[].filter.call(document.querySelectorAll("#income-chart svg text.tick"),function(x){return x.getAttribute("text-anchor")==="middle"}).map(function(x){return x.getBoundingClientRect()});for(var i=0;i<t.length;i++)for(var j=i+1;j<t.length;j++){var a=t[i],c=t[j];if(Math.abs(a.top-c.top)<2&&a.left<c.right-1&&c.left<a.right-1)return [i,j];}return null})()');
      ok(overlap === null, 'the month labels do not run into each other at ' + w + ' px', overlap);
      const fits = await b.eval('(function(){var s=document.querySelector("#income-chart svg").getBoundingClientRect();var c=document.querySelector("#income-chart").getBoundingClientRect();return s.width<=c.width+1})()');
      ok(fits === true, 'the chart was redrawn to the new width at ' + w + ' px');
      const tabs = await b.eval('(function(){var t=[].slice.call(document.querySelectorAll(".tabs .tab"));var strip=document.querySelector(".tabs").getBoundingClientRect();var cur=document.querySelector(".tab[aria-current=page]").getBoundingClientRect();return {rows:t.map(function(x){return Math.round(x.getBoundingClientRect().top)}).filter(function(v,i,a){return a.indexOf(v)===i}).length,count:t.length,curIn:cur.left>=strip.left-1&&cur.right<=strip.right+1,bar:Math.round(document.querySelector(".topbar").getBoundingClientRect().height)}})()');
      ok(tabs.count === 6 && tabs.rows === 1, 'the six tabs are one row at ' + w + ' px', tabs);
      ok(tabs.curIn === true, 'and the current tab is in view', tabs);
      const whole = await b.eval('(function(){var bad=[];[].forEach.call(document.querySelectorAll(".hero .value, .tile .value"),function(el){var r=document.createRange();r.selectNodeContents(el);if(r.getClientRects().length>1)bad.push(el.textContent)});return bad})()');
      ok(whole.length === 0, 'no figure is broken across lines at ' + w + ' px', whole);
    }
    await b.goto(URL + '#backup', 1500);
    const last = await b.eval('(function(){var strip=document.querySelector(".tabs").getBoundingClientRect();var cur=document.querySelector(".tab[aria-current=page]").getBoundingClientRect();return {id:document.querySelector(".tab[aria-current=page]").id,curIn:cur.left>=strip.left-1&&cur.right<=strip.right+1}})()');
    ok(last.id === 'tab-backup' && last.curIn === true, 'the last tab is scrolled into view when it is the current one', last);
    await b.goto(URL + '#overview', 1500);
    await b.screenshot(path.join(OUT, 'overview-3-phone.png'), { full: true });

    console.log('8. no script errors');
    ok(b.errors.length === 0, 'no exceptions or console errors', b.errors);
  } catch (e) {
    failures++;
    console.log('  FAIL the run stopped: ' + (e && e.stack || e));
    try { await b.screenshot(path.join(OUT, 'overview-crash.png')); } catch (ignored) { /* nothing to show */ }
  } finally {
    await b.close();
  }
  console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})();
