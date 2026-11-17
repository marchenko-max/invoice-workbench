/*
 * The same page with a stand-in for the claude.ai host: checks that data goes to the viewer's private subtree
 * through valid paths, one write at a time per document, that a PDF is offered through the downloads capability,
 * and that a reload reads everything back.   node test/hosted-smoke.js
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { launch } = require('./cdp.js');
const ROOT = path.resolve(__dirname, '..');
require('node:child_process').execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build.js')]);
const URL = 'file://' + path.join(ROOT, 'dist', 'hosted-test.html');
const profile = path.join(__dirname, '.chrome-hosted');
let failures = 0;
function ok(cond, what, detail) {
  if (cond) console.log('  ok   ' + what);
  else { failures++; console.log('  FAIL ' + what + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}
(async () => {
  fs.rmSync(profile, { recursive: true, force: true });
  const b = await launch({ width: 1360, height: 1000, profile });
  try {
    await b.goto(URL, 2500);
    ok(/Saved to your account/.test(await b.text('#storage-state')), 'storage chip says the account', await b.text('#storage-state'));
    ok((await b.eval('!!document.querySelector("#doc-title")')) === true, 'first visit opens the example');
    ok((await b.eval('Array.prototype.some.call(document.querySelectorAll("button"), function (x) { return /ARES/.test(x.textContent); })')) === false, 'no register lookup inside the host frame');
    await b.clickText('button', 'Add my company');
    await b.waitFor('document.querySelector("#dialog").open');
    await b.fill('#co-name', 'Hostovaná s.r.o.');
    await b.fill('#co-ico', '27082440');
    await b.fill('#co-account', '19-2000145399/0800');
    await b.clickText('#dialog button', 'Save');
    await b.waitFor('!document.querySelector("#dialog").open');
    await b.wait(400);
    await b.fill('#to-name', 'Zákazník a.s.');
    const itemId = await b.eval('document.querySelector(".item").id');
    for (const ch of ['1', '12', '120', '1200']) { await b.fill('#' + itemId + '-price', ch); await b.wait(30); }
    await b.fill('#' + itemId + '-desc', 'Služby');
    await b.wait(1800);
    const paths = await b.eval('Object.keys(window.__mock.docs)');
    ok(paths.some((p) => /^data\/users\/u_testuser\/app\/companies\/[a-z0-9]{16}$/.test(p)), 'company saved under the private subtree', paths);
    ok(paths.some((p) => /^data\/users\/u_testuser\/app\/invoices\/[a-z0-9]{16}$/.test(p)), 'document saved under the private subtree', paths);
    ok(paths.every((p) => p.indexOf('data/users/u_testuser/') === 0), 'nothing written outside the private subtree', paths);
    ok((await b.eval('window.__mock.overlaps.length')) === 0, 'never two writes to one document at once', await b.eval('window.__mock.overlaps'));
    const invoiceSets = await b.eval('window.__mock.sets.filter(function (p) { return /invoices/.test(p); }).length');
    ok(invoiceSets >= 1 && invoiceSets <= 3, 'typing is coalesced into few writes', invoiceSets);
    ok(/Saved/.test(await b.text('#save-state')), 'editor says Saved', await b.text('#save-state'));

    await b.clickText('button', 'Download PDF');
    await b.wait(1500);
    const saved = await b.eval('window.__mock.saved');
    ok(saved.length === 1 && /^Faktura-\d+\.pdf$/.test(saved[0].filename) && saved[0].size > 20000 && saved[0].type === 'application/pdf', 'PDF offered through downloads', saved);
    ok((await b.eval('document.querySelector("#f-status").value')) === 'issued', 'document marked as issued after the download');
    await b.wait(1200);
    const customerSaved = await b.eval('Object.values(window.__mock.docs).some(function (d) { return d.kind === "customer" && d.name === "Zákazník a.s."; })');
    ok(customerSaved, 'customer joined the address book when the document went out');

    await b.eval('location.hash = "#backup"');
    await b.wait(300);
    await b.clickText('button', 'Export a backup file');
    await b.wait(600);
    const saved2 = await b.eval('window.__mock.saved');
    ok(saved2.length === 2 && /^invoice-workbench-backup-\d{4}-\d{2}-\d{2}\.json$/.test(saved2[1].filename), 'backup offered through downloads', saved2);

    await b.goto(URL + '#documents', 2500);
    ok((await b.eval('document.querySelectorAll(".ledger tbody tr").length')) === 1, 'reload reads the document back', await b.text('#view'));
    ok(/Issued/.test(await b.text('.ledger tbody')), 'and it is still issued');
    await b.eval('location.hash = "#companies"');
    await b.wait(300);
    ok(/Hostovaná s\.r\.o\./.test(await b.text('#view')) && /Zákazník a\.s\./.test(await b.text('#view')), 'both companies read back');
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
