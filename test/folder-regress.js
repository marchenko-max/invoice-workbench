/*
 * One check per defect the review of folder storage confirmed.   node test/folder-regress.js
 * Same technique as folder-smoke.js: the folder picker is answered with a real directory of the browser's private
 * file system, and failures are produced by making the browser's own file calls throw at a chosen moment.
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { launch } = require('./cdp.js');
const ROOT = path.resolve(__dirname, '..');
require('node:child_process').execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build.js')]);
const LOCAL = 'file://' + path.join(ROOT, 'dist', 'index.html');
let failures = 0;
function ok(cond, what, detail) {
  if (cond) console.log('  ok   ' + what);
  else { failures++; console.log('  FAIL ' + what + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}
const LS = 'localStorage.getItem("invoice-workbench:v1")';

(async () => {
  const profile = path.join(__dirname, '.chrome-folder-regress');
  fs.rmSync(profile, { recursive: true, force: true });
  const b = await launch({ width: 1360, height: 1000, profile });

  // every scenario starts from nothing: no browser data, no remembered folder, no files
  async function fresh() {
    await b.goto(LOCAL, 1200);
    await b.eval(`(async function () {
      localStorage.clear();
      await new Promise(function (r) { var q = indexedDB.deleteDatabase('invoice-workbench'); q.onsuccess = q.onerror = q.onblocked = function () { r(); }; });
      var root = await navigator.storage.getDirectory();
      for (var name of ['inv-a', 'inv-b']) { try { await root.removeEntry(name, { recursive: true }); } catch (e) {} }
    })()`);
    await b.goto(LOCAL, 2200);
  }
  const pick = (name) => b.eval(`(async function () {
    var dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('${name}', { create: true });
    window.showDirectoryPicker = function () { return Promise.resolve(dir); };
  })()`);
  const tree = (name) => b.eval(`(async function () {
    var out = {};
    var dir;
    try { dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('${name}'); } catch (e) { return out; }
    async function walk(d, prefix) {
      for await (var e of d.values()) {
        if (e.kind === 'directory') { await walk(e, prefix + e.name + '/'); continue; }
        var text = await (await e.getFile()).text();
        try { out[prefix + e.name] = JSON.parse(text); } catch (x) { out[prefix + e.name] = text.length ? 'TEXT:' + text.slice(0, 40) : 'EMPTY'; }
      }
    }
    await walk(dir, '');
    return out;
  })()`);
  const docs = (t) => Object.keys(t).filter((k) => k.indexOf('documents/') === 0).sort();
  async function firstCompany(name) {
    await b.clickText('button', 'Add my company');
    await b.waitFor('document.querySelector("#dialog").open');
    await b.fill('#co-name', name);
    await b.clickText('#dialog button', 'Save');
    await b.waitFor('!document.querySelector("#dialog").open'); await b.wait(300);
  }
  async function newDocument(customer) {
    await b.eval('location.hash = "#documents"'); await b.wait(300);
    await b.clickText('button', 'New document'); await b.wait(400);
    await b.fill('#to-name', customer); await b.wait(1400);
  }
  async function connect(name) {
    await pick(name);
    await b.eval('location.hash = "#backup"'); await b.wait(400);
    await b.click('#folder-choose'); await b.wait(1500);
  }
  const rows = () => b.eval('document.querySelectorAll(".ledger tbody tr").length');

  try {
    console.log('A. an edit made in the browser after leaving the folder is not thrown away on coming back');
    await fresh();
    await firstCompany('Firma A');
    await b.fill('#to-name', 'Original customer'); await b.wait(1400);
    await connect('inv-a');
    await b.click('#folder-leave'); await b.wait(1000);
    await b.eval('location.hash = "#documents"'); await b.wait(300);
    await b.eval('document.querySelector(".ledger tbody tr").click()'); await b.wait(500);
    await b.fill('#to-name', 'EDITED IN BROWSER'); await b.wait(1400);
    await connect('inv-a');
    let t = await tree('inv-a');
    ok(docs(t).length === 1 && t[docs(t)[0]].customer.name === 'EDITED IN BROWSER', 'the folder now holds the newer version', docs(t).map((k) => t[k].customer.name));
    ok((await b.eval(LS)) === null, 'and only then is the browser copy emptied');

    console.log('B. choosing another folder does not copy the first folder into it');
    await connect('inv-b');
    t = await tree('inv-b');
    ok(Object.keys(t).filter((k) => /^(companies|documents)\//.test(k)).length === 0, 'the second folder stays empty', Object.keys(t));
    const lastToast = await b.eval('(function(){var all=document.querySelectorAll("#toasts .toast");return all.length?all[all.length-1].textContent:"";})()');
    ok(lastToast === 'Connected to the folder.', 'and nothing is reported as moved', lastToast);
    ok(Object.keys(await tree('inv-a')).filter((k) => /^documents\//.test(k)).length === 1, 'the first folder is untouched');

    console.log('C. a move that fails part-way keeps the leftovers visible, in the browser, and finishes later');
    await fresh();
    await firstCompany('Firma C');
    await b.fill('#to-name', 'Fits fine'); await b.wait(1400);
    await newDocument('FAILME customer');
    await b.eval(`(function () {
      var P = FileSystemWritableFileStream.prototype; window.__write = P.write;
      P.write = function (data) { if (typeof data === 'string' && data.indexOf('FAILME') !== -1) return Promise.reject(new DOMException('full', 'QuotaExceededError')); return window.__write.call(this, data); };
    })()`);
    await connect('inv-a');
    t = await tree('inv-a');
    ok(docs(t).length === 1 && t[docs(t)[0]].customer.name === 'Fits fine', 'what could be written is in the folder, and no empty file is left for the rest', docs(t).map((k) => t[k] && t[k].customer ? t[k].customer.name : t[k]));
    ok(/still only in this browser/.test(await b.text('#storage-state')), 'the top bar does not claim everything is in the folder', await b.text('#storage-state'));
    ok(JSON.parse(await b.eval(LS)).invoices && Object.keys(JSON.parse(await b.eval(LS)).invoices).length === 2, 'the browser copy is kept');
    await b.eval('location.hash = "#documents"'); await b.wait(300);
    ok((await rows()) === 2, 'both documents are still shown');
    await b.eval('location.hash = "#backup"'); await b.wait(400);
    ok(/still only in this browser/.test(await b.text('#folder-section')), 'the Backup tab explains and offers to try again');
    // the disk has room again
    await b.eval('FileSystemWritableFileStream.prototype.write = window.__write');
    await b.click('#folder-retry-move'); await b.wait(1500);
    t = await tree('inv-a');
    ok(docs(t).length === 2, 'trying again moves the rest', docs(t));
    ok((await b.eval(LS)) === null && /Saved in the folder/.test(await b.text('#storage-state')), 'and then the browser copy is emptied and the top bar is calm', await b.text('#storage-state'));

    console.log('C2. without pressing anything, the next visit finishes the move by itself');
    await fresh();
    await firstCompany('Firma C2');
    await b.fill('#to-name', 'FAILME again'); await b.wait(1400);
    await b.eval(`(function () {
      var P = FileSystemWritableFileStream.prototype; var real = P.write;
      P.write = function (data) { if (typeof data === 'string' && data.indexOf('FAILME') !== -1) return Promise.reject(new DOMException('full', 'QuotaExceededError')); return real.call(this, data); };
    })()`);
    await connect('inv-a');
    ok(docs(await tree('inv-a')).length === 0 && (await b.eval(LS)) !== null, 'the document is not in the folder yet and is kept in the browser');
    await b.goto(LOCAL + '#documents', 2600);   // a fresh load: the disk is no longer full
    ok(docs(await tree('inv-a')).length === 1 && (await b.eval(LS)) === null && (await rows()) === 1 && /Saved in the folder/.test(await b.text('#storage-state')), 'on the next visit it is moved in, shown, and the browser copy emptied', [docs(await tree('inv-a')), await b.text('#storage-state')]);
    await newDocument('Second one');

    console.log('D. a rename that could not remove its old file does not bring a deleted document back');
    await b.eval('location.hash = "#documents"'); await b.wait(300);
    await b.eval('document.querySelector(".ledger tbody tr").click()'); await b.wait(500);
    const before = docs(await tree('inv-a'));
    await b.eval(`(function () {
      var P = FileSystemDirectoryHandle.prototype; window.__remove = P.removeEntry;
      P.removeEntry = function () { return Promise.reject(new DOMException('busy', 'InvalidModificationError')); };
    })()`);
    await b.fill('#f-number', 'X1'); await b.wait(1600);
    await b.eval('FileSystemDirectoryHandle.prototype.removeEntry = window.__remove');
    ok(docs(await tree('inv-a')).length === before.length + 1, 'the old file was left behind by the failed removal');
    await b.eval('location.hash = "#documents"'); await b.wait(300);
    await b.eval('(function(){var r=document.querySelectorAll(".ledger tbody tr");for(var i=0;i<r.length;i++){if(/X1/.test(r[i].textContent)){var bs=r[i].querySelectorAll("button");for(var j=0;j<bs.length;j++){if(bs[j].textContent==="Delete"){bs[j].click();return;}}}}})()');
    await b.wait(150);
    await b.clickText('.ledger button', 'Yes, delete'); await b.wait(900);
    ok(docs(await tree('inv-a')).length === before.length - 1, 'deleting removes both files', docs(await tree('inv-a')));
    await b.goto(LOCAL + '#documents', 2300);
    ok((await rows()) === 1, 'and the document does not return on the next visit', await rows());

    console.log('E. after stopping, the browser holds exactly what was on screen');
    await b.eval('location.hash = "#backup"'); await b.wait(400);
    await b.click('#folder-leave'); await b.wait(1000);
    ok(Object.keys(JSON.parse(await b.eval(LS)).invoices).length === 1, 'one document in the browser, not the deleted one too');
    await b.goto(LOCAL + '#documents', 2300);
    ok((await rows()) === 1 && /Saved in this browser/.test(await b.text('#storage-state')), 'and it stays that way after a reload');

    console.log('F. a settings.json the app cannot read is listed and never written over');
    await connect('inv-a');
    await b.eval(`(async function () {
      var dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('inv-a');
      var f = await dir.getFileHandle('settings.json', { create: true }); var w = await f.createWritable(); await w.write('not json at all'); await w.close();
    })()`);
    await b.eval('location.hash = "#backup"'); await b.wait(300);
    await b.click('#folder-reload'); await b.wait(1000);
    ok(/settings\.json/.test(await b.text('#folder-section')), 'it is named among the files left untouched');
    await newDocument('After settings');
    ok((await tree('inv-a'))['settings.json'] === 'TEXT:not json at all', 'and it still holds what it held', (await tree('inv-a'))['settings.json']);

    console.log('G. when the folder cannot be read, every way out is on the screen');
    await b.eval(`(function () {
      var P = FileSystemDirectoryHandle.prototype; window.__get = P.getDirectoryHandle;
      P.getDirectoryHandle = function () { return Promise.reject(new DOMException('no', 'NotAllowedError')); };
    })()`);
    await b.eval('location.hash = "#backup"'); await b.wait(300);
    await b.click('#folder-reload'); await b.wait(1000);
    ok(/could not be opened/.test(await b.text('#view')), 'the page says the data could not be opened');
    ok((await b.eval('["#load-retry","#folder-reconnect","#folder-choose","#folder-leave"].every(function (s) { return !!document.querySelector(s); })')) === true, 'with Try again, Connect, Choose another and Stop using');
    await b.eval('FileSystemDirectoryHandle.prototype.getDirectoryHandle = window.__get');
    await b.click('#load-retry'); await b.wait(1200);
    ok(/Saved in the folder/.test(await b.text('#storage-state')), 'Try again recovers once the folder is readable', await b.text('#storage-state'));
    ok((await b.eval('document.activeElement !== document.body')) === true, 'and the keyboard is not left on nothing');
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
