/*
 * Folder storage, driven through the real page with a real directory handle.   node test/folder-smoke.js
 *
 * The browser's folder picker cannot be clicked by a script, so the test answers it with a directory from the
 * browser's private file system: the same kind of handle, the same read and write calls, real files.
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { launch } = require('./cdp.js');
const ROOT = path.resolve(__dirname, '..');
require('node:child_process').execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build.js')]);
const DIST = path.join(ROOT, 'dist');
const LOCAL = 'file://' + path.join(DIST, 'index.html');
// the same page, but the browser says "ask first" for the remembered folder, as it does on a real later visit
const GATE = path.join(DIST, 'folder-gate-test.html');
fs.writeFileSync(GATE, fs.readFileSync(path.join(DIST, 'index.html'), 'utf8').replace('<body>',
  '<body><script>(function(){var P=FileSystemDirectoryHandle.prototype,ok=false;' +
  'P.queryPermission=function(){return Promise.resolve(ok?"granted":"prompt")};' +
  'P.requestPermission=function(){ok=true;return Promise.resolve("granted")};})();</script>'));
const year = new Date().getFullYear();
let failures = 0;
function ok(cond, what, detail) {
  if (cond) console.log('  ok   ' + what);
  else { failures++; console.log('  FAIL ' + what + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}
const LS = 'localStorage.getItem("invoice-workbench:v1")';
// what is in the test folder: { 'documents/x.json': parsed, 'PDF/y.pdf': '%PDF-' ... }
const TREE = `(async function () {
  var root = await navigator.storage.getDirectory();
  var dir = await root.getDirectoryHandle('inv-test');
  var out = {};
  async function walk(d, prefix) {
    for await (var e of d.values()) {
      if (e.kind === 'directory') { await walk(e, prefix + e.name + '/'); continue; }
      var f = await e.getFile();
      if (/\\.json$/.test(e.name)) { var t = await f.text(); try { out[prefix + e.name] = JSON.parse(t); } catch (x) { out[prefix + e.name] = 'UNREADABLE'; } }
      else out[prefix + e.name] = (await f.slice(0, 5).text());
    }
  }
  await walk(dir, '');
  return out;
})()`;
const keys = (tree, prefix) => Object.keys(tree).filter((k) => k.indexOf(prefix) === 0).sort();

(async () => {
  const profile = path.join(__dirname, '.chrome-folder');
  fs.rmSync(profile, { recursive: true, force: true });
  const b = await launch({ width: 1360, height: 1000, profile });
  try {
    console.log('1. data starts in the browser');
    await b.goto(LOCAL, 2300);
    await b.clickText('button', 'Add my company');
    await b.waitFor('document.querySelector("#dialog").open');
    await b.fill('#co-name', 'Složka s.r.o.'); await b.fill('#co-ico', '27082440'); await b.fill('#co-dic', 'CZ27082440');
    await b.check('#co-vat', true); await b.fill('#co-account', '19-2000145399/0800');
    await b.clickText('#dialog button', 'Save');
    await b.waitFor('!document.querySelector("#dialog").open'); await b.wait(300);
    await b.fill('#to-name', 'Klient a.s.');
    const itemId = await b.eval('document.querySelector(".item").id');
    await b.fill('#' + itemId + '-desc', 'Práce'); await b.fill('#' + itemId + '-price', '1000');
    await b.wait(1500);
    ok(/Saved in this browser/.test(await b.text('#storage-state')), 'the page starts in browser storage');
    ok(JSON.parse(await b.eval(LS)).invoices && Object.keys(JSON.parse(await b.eval(LS)).invoices).length === 1, 'one document in localStorage');

    console.log('2. choosing a folder moves everything into files');
    await b.eval(`(async function () {
      var root = await navigator.storage.getDirectory();
      try { await root.removeEntry('inv-test', { recursive: true }); } catch (e) {}
      var dir = await root.getDirectoryHandle('inv-test', { create: true });
      window.showDirectoryPicker = function () { return Promise.resolve(dir); };
    })()`);
    await b.eval('location.hash = "#backup"'); await b.wait(400);
    ok(/Choose a folder/.test(await b.text('#folder-section')), 'the Backup tab offers a folder');
    await b.click('#folder-choose'); await b.wait(1500);
    ok(/Saved in the folder .inv-test./.test(await b.text('#storage-state')), 'the top bar names the folder', await b.text('#storage-state'));
    let tree = await b.eval(TREE);
    const companyFiles = keys(tree, 'companies/');
    const docFiles = keys(tree, 'documents/');
    ok(companyFiles.length === 1 && /^companies\/Slozka-s\.r\.o__[a-z0-9]{16}\.json$/.test(companyFiles[0]), 'the company is one readable file', companyFiles);
    ok(docFiles.length === 1 && new RegExp('^documents/' + year + '0001__[a-z0-9]{16}\\.json$').test(docFiles[0]), 'the document is one file named by its number', docFiles);
    ok(tree[companyFiles[0]].name === 'Složka s.r.o.' && tree[docFiles[0]].customer.name === 'Klient a.s.' && tree[docFiles[0]].items[0].price === 1000, 'the files hold the records');
    ok((await b.eval(LS)) === null, 'the browser copy is emptied once the folder has everything');
    ok(/moved/.test(await b.text('#toasts')), 'the page says what it moved', await b.text('#toasts'));

    console.log('3. a new number renames the file; a PDF is copied in');
    await b.eval('location.hash = "#documents"'); await b.wait(400);
    await b.eval('document.querySelector(".ledger tbody tr").click()'); await b.wait(500);
    await b.fill('#f-number', 'FV-' + year + '-001'); await b.wait(1600);
    tree = await b.eval(TREE);
    ok(keys(tree, 'documents/').length === 1 && keys(tree, 'documents/')[0].indexOf('documents/FV-' + year + '-001__') === 0, 'the file follows the new number and the old one is gone', keys(tree, 'documents/'));
    await b.clickText('button', 'Download PDF'); await b.wait(2000);
    tree = await b.eval(TREE);
    const pdfs = keys(tree, 'PDF/');
    ok(pdfs.length === 1 && pdfs[0] === 'PDF/Faktura-danovy-doklad-FV-' + year + '-001.pdf' && tree[pdfs[0]] === '%PDF-', 'a copy of the PDF is in PDF/', pdfs);
    ok(tree[keys(tree, 'documents/')[0]].status === 'issued', 'the file shows the document as issued');
    ok(!!tree['settings.json'], 'settings.json is written');

    console.log('4. the next visit reads the folder');
    await b.goto(LOCAL + '#documents', 2300);
    ok((await b.eval('document.querySelectorAll(".ledger tbody tr").length')) === 1 && /FV-/.test(await b.text('.ledger tbody')), 'the document is listed from the folder');
    ok(/Saved in the folder/.test(await b.text('#storage-state')), 'still in folder mode');

    console.log('5. foreign and duplicate files are left alone, and a deleted record does not come back');
    const docName = keys(tree, 'documents/')[0].slice('documents/'.length);
    const docId = tree['documents/' + docName].id;
    await b.eval(`(async function () {
      var root = await navigator.storage.getDirectory();
      var dir = await (await root.getDirectoryHandle('inv-test')).getDirectoryHandle('documents');
      async function put(name, text) { var f = await dir.getFileHandle(name, { create: true }); var w = await f.createWritable(); await w.write(text); await w.close(); }
      await put('notes.json', 'this is not json');
      await put('conflict copy__${docId}.json', JSON.stringify({ id: '${docId}', number: 'OLD', updatedAt: '2000-01-01T00:00:00.000Z', customer: { name: 'Old copy' }, items: [] }));
    })()`);
    await b.eval('location.hash = "#backup"'); await b.wait(400);
    await b.click('#folder-reload'); await b.wait(1000);
    ok(/2 files in the folder were not loaded/.test(await b.text('#folder-section')), 'the Backup tab names the files it skipped', (await b.text('#folder-section')).slice(0, 300));
    await b.eval('location.hash = "#documents"'); await b.wait(400);
    ok((await b.eval('document.querySelectorAll(".ledger tbody tr").length')) === 1 && /FV-/.test(await b.text('.ledger tbody')) && !/OLD/.test(await b.text('.ledger tbody')), 'the newer copy of the record is the one shown');
    tree = await b.eval(TREE);
    ok(tree['documents/notes.json'] === 'UNREADABLE' && !!tree['documents/conflict copy__' + docId + '.json'], 'both stray files are untouched');
    await b.clickText('.ledger button', 'Delete'); await b.wait(150);
    await b.clickText('.ledger button', 'Yes, delete'); await b.wait(900);
    tree = await b.eval(TREE);
    ok(keys(tree, 'documents/').join() === 'documents/notes.json', 'deleting removes the record and its older copy, and nothing else', keys(tree, 'documents/'));
    await b.goto(LOCAL + '#documents', 2300);
    ok((await b.eval('document.querySelectorAll(".ledger tbody tr").length')) === 0, 'after a reload the deleted document is still gone');

    console.log('6. a later visit: nothing is shown until the folder is connected');
    await b.goto('file://' + GATE + '#documents', 2300);
    ok(/Your data is in the folder .inv-test./.test(await b.text('#view')), 'the page asks for the folder first', (await b.text('#view')).slice(0, 120));
    ok(/Folder not connected/.test(await b.text('#storage-state')), 'the top bar says the folder is not connected');
    ok((await b.eval('document.querySelectorAll(".ledger, #form").length')) === 0, 'no data and no editor behind the question');
    await b.eval('location.hash = "#companies"'); await b.wait(300);
    ok(/Your data is in the folder/.test(await b.text('#view')), 'every tab asks the same');
    await b.click('#folder-reconnect'); await b.wait(1500);
    ok(/Saved in the folder/.test(await b.text('#storage-state')), 'connecting opens the folder', await b.text('#storage-state'));
    await b.eval('location.hash = "#companies"'); await b.wait(400);
    ok(/Složka s\.r\.o\./.test(await b.text('#view')), 'and the company is there');

    console.log('7. work done in the browser while the folder was closed is moved in on connecting, not lost');
    await b.goto('file://' + GATE + '#documents', 2300);
    await b.click('#folder-skip'); await b.wait(500);
    ok(/Saved in this browser/.test(await b.text('#storage-state')), 'working in the browser instead is possible');
    await b.clickText('button', 'Add my company');
    await b.waitFor('document.querySelector("#dialog").open');
    await b.fill('#co-name', 'Druhá firma'); await b.clickText('#dialog button', 'Save');
    await b.waitFor('!document.querySelector("#dialog").open'); await b.wait(400);
    await b.fill('#to-name', 'Typed while closed'); await b.wait(100);
    await b.eval('location.hash = "#backup"'); await b.wait(500);
    await b.click('#folder-reconnect'); await b.wait(1800);
    tree = await b.eval(TREE);
    ok(keys(tree, 'companies/').length === 3 && keys(tree, 'companies/').some((k) => /Druha-firma__/.test(k)) && keys(tree, 'companies/').some((k) => /Klient-a\.s__/.test(k)), 'the company made meanwhile is now a file', keys(tree, 'companies/'));
    ok(keys(tree, 'documents/').some((k) => tree[k] && tree[k].customer && tree[k].customer.name === 'Typed while closed'), 'and so is the document, even one typed a moment before', keys(tree, 'documents/'));
    ok((await b.eval(LS)) === null, 'the browser copy is emptied again');

    console.log('8. stopping keeps the files and carries the records back to the browser');
    await b.eval('location.hash = "#backup"'); await b.wait(400);
    const before = keys(await b.eval(TREE), '').length;
    await b.click('#folder-leave'); await b.wait(1200);
    ok(/Saved in this browser/.test(await b.text('#storage-state')), 'back in browser storage', await b.text('#storage-state'));
    const ls = JSON.parse(await b.eval(LS));
    ok(Object.keys(ls.companies).length === 3, 'the records are in the browser again', Object.keys(ls.companies).length);
    ok(keys(await b.eval(TREE), '').length === before, 'no file in the folder was touched');
    await b.goto(LOCAL + '#companies', 2300);
    ok(/Saved in this browser/.test(await b.text('#storage-state')) && /Druhá firma/.test(await b.text('#view')), 'the next visit no longer asks for a folder');
    ok(b.errors.length === 0, 'no exceptions or console errors', b.errors.slice(0, 5));
  } catch (e) {
    failures++;
    console.log('  FAIL (threw) ' + e.message + '  errors: ' + JSON.stringify(b.errors.slice(0, 5)));
  }
  await b.close();
  fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(GATE, { force: true });
  console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})();
