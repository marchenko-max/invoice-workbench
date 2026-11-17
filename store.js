/*
 * InvoiceStore: where companies and documents are kept. There are four places, and the screens never see the
 * difference: they call the same functions.
 *
 *   cloud   inside a claude.ai Artifact with the `db` and `user` capabilities: the viewer's own private subtree,
 *           data/users/<id>/app, which nobody else who opens the page can read.
 *   folder  the page opened from disk in Chrome or Edge, after the person picked a folder: one JSON file per
 *           company in companies/, one per document in documents/, settings.json, and a copy of every downloaded
 *           PDF in PDF/. The folder's handle is remembered in IndexedDB; the browser asks for permission again on
 *           each visit, and until it is given nothing is read or written there.
 *   local   the page opened from disk with no folder: this browser's localStorage.
 *   memory  when even that is blocked: nothing survives the page.
 */
(function (root) {
  'use strict';

  var LS_KEY = 'invoice-workbench:v1';
  var LOAD_TIMEOUT_MS = 10000;
  var IDB_NAME = 'invoice-workbench';
  var IDB_STORE = 'kv';
  var IDB_KEY = 'folder';
  var DIR_OF = { companies: 'companies', invoices: 'documents' };

  var mode = 'memory';          // 'cloud' | 'folder' | 'local' | 'memory'
  var base = null;              // DocumentReference of data/users/<id>/app
  var local = { companies: Object.create(null), invoices: Object.create(null), settings: {} };
  var folder = emptyFolder();
  var queues = {};              // path -> { waiting, running }
  var active = 0;
  var lastError = null;
  var listeners = [];

  function emptyFolder() {
    return {
      handle: null,             // FileSystemDirectoryHandle of the chosen folder
      granted: false,           // the browser lets us read and write it right now
      dirs: null,               // { companies, invoices } sub-folder handles
      names: { companies: Object.create(null), invoices: Object.create(null) },   // id -> file name
      copies: { companies: Object.create(null), invoices: Object.create(null) },  // id -> other files holding the same record
      skipped: [],              // files that were found and left alone
      settingsLocked: false     // settings.json exists but is not ours to read: it is never overwritten
    };
  }

  function noop() {}

  function clone(value) { return JSON.parse(JSON.stringify(value)); }

  /** A map with no prototype, so a record called "__proto__" or "constructor" is only ever a record. */
  function bare(source) {
    var out = Object.create(null);
    if (source && typeof source === 'object' && !Array.isArray(source)) Object.keys(source).forEach(function (k) { out[k] = source[k]; });
    return out;
  }

  function values(map) { return Object.keys(map).map(function (k) { return map[k]; }); }

  function idOk(id) {
    return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) && ['__proto__', 'constructor', 'prototype'].indexOf(id) === -1;
  }

  function emit() {
    var status = { saving: active > 0, error: lastError };
    listeners.forEach(function (fn) { try { fn(status); } catch (e) { /* a listener must never break a save */ } });
  }

  function onStatus(fn) { listeners.push(fn); }

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject({ code: 'timeout', message: 'The saved data did not answer in time.' }); }, ms);
      promise.then(function (v) { clearTimeout(timer); resolve(v); }, function (e) { clearTimeout(timer); reject(e); });
    });
  }

  // ------------------------------------------------------ this browser's own storage

  function readLocal() {
    try {
      var raw = root.localStorage.getItem(LS_KEY);
      if (!raw) return true;
      var data = JSON.parse(raw);
      if (data && typeof data === 'object') {
        local.companies = bare(data.companies);
        local.invoices = bare(data.invoices);
        local.settings = data.settings && typeof data.settings === 'object' ? data.settings : {};
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function localUsable() {
    try {
      var probe = LS_KEY + ':probe';
      root.localStorage.setItem(probe, '1');
      root.localStorage.removeItem(probe);
      return true;
    } catch (e) {
      return false;
    }
  }

  function writeLocal() {
    if (mode !== 'local') return;
    try {
      root.localStorage.setItem(LS_KEY, JSON.stringify(local));
    } catch (e) {
      throw { code: 'quota_exceeded', message: 'This browser has no room left for the saved data.' };
    }
  }

  /** Empties this browser's own copy, once its records live somewhere else. */
  function clearBrowserCopy() {
    local = { companies: Object.create(null), invoices: Object.create(null), settings: {} };
    try { root.localStorage.removeItem(LS_KEY); } catch (e) { /* nothing was stored then */ }
  }

  /** What this browser's own storage holds right now, whichever place the page is saving to. */
  function browserCopy() {
    var out = { companies: [], invoices: [], settings: {} };
    try {
      var raw = root.localStorage.getItem(LS_KEY);
      if (!raw) return out;
      var data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return out;
      var usable = function (rec) { return rec && typeof rec === 'object' && !Array.isArray(rec) && idOk(rec.id); };
      out.companies = clone(values(bare(data.companies)).filter(usable));
      out.invoices = clone(values(bare(data.invoices)).filter(usable));
      if (data.settings && typeof data.settings === 'object' && !Array.isArray(data.settings)) out.settings = clone(data.settings);
    } catch (e) { /* unreadable: there is nothing to offer */ }
    return out;
  }

  /**
   * With a folder connected, the browser's copy may only hold what is not safely in the folder yet. So the moment a
   * record is written there, or deleted, its entry here goes: a record can then never be re-created from an old copy.
   */
  function dropFromBrowserCopy(collection, id) {
    try {
      var raw = root.localStorage.getItem(LS_KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      var map = data && typeof data === 'object' ? data[collection] : null;
      if (!map || typeof map !== 'object' || !Object.prototype.hasOwnProperty.call(map, id)) return;
      delete map[id];
      root.localStorage.setItem(LS_KEY, JSON.stringify(data));
    } catch (e) { /* unreadable or unwritable: there is nothing here that could come back */ }
  }

  /** How many records this browser still holds on its own. */
  function browserCopyCount() {
    var held = browserCopy();
    return held.companies.length + held.invoices.length;
  }

  // ------------------------------------------------------------------ the folder

  /** Only a page opened on its own in Chrome or Edge may pick a folder; inside claude.ai the frame is not allowed to. */
  function folderSupported() {
    return !root.claude && typeof root.showDirectoryPicker === 'function' && !!root.indexedDB;
  }

  function idb(txMode, work) {
    return new Promise(function (resolve, reject) {
      var open;
      try { open = root.indexedDB.open(IDB_NAME, 1); } catch (e) { reject(e); return; }
      open.onupgradeneeded = function () { open.result.createObjectStore(IDB_STORE); };
      open.onerror = function () { reject(open.error); };
      open.onsuccess = function () {
        var db = open.result;
        var req;
        try {
          var tx = db.transaction(IDB_STORE, txMode);
          req = work(tx.objectStore(IDB_STORE));
          tx.oncomplete = function () { db.close(); resolve(req ? req.result : undefined); };
          tx.onerror = tx.onabort = function () { db.close(); reject(tx.error); };
        } catch (e) { db.close(); reject(e); }
      };
    });
  }

  function rememberHandle(handle) { return idb('readwrite', function (s) { return s.put(handle, IDB_KEY); }).catch(noop); }
  function recallHandle() { return idb('readonly', function (s) { return s.get(IDB_KEY); }).catch(function () { return null; }); }
  function forgetHandle() { return idb('readwrite', function (s) { return s.delete(IDB_KEY); }).catch(noop); }

  /** What a file-system failure means, in words a person can act on. */
  function fsError(e) {
    if (e && e.code && !e.name) return e;
    var name = e && e.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') return { code: 'folder_access', message: 'The browser no longer has permission to use the folder. Press \u201cConnect the folder\u201d on the Backup tab.' };
    if (name === 'NotFoundError') return { code: 'folder_missing', message: 'The folder, or a file in it, was moved or deleted.' };
    if (name === 'QuotaExceededError') return { code: 'quota_exceeded', message: 'The disk is full.' };
    if (name === 'NoModificationAllowedError' || name === 'InvalidModificationError' || name === 'InvalidStateError') {
      return { code: 'folder_locked', message: 'A file in the folder is locked or was changed by another program. Try again.' };
    }
    return { code: 'folder_error', message: (e && e.message) || 'The folder could not be read or written.' };
  }

  async function openFolder() {
    folder.dirs = {
      companies: await folder.handle.getDirectoryHandle(DIR_OF.companies, { create: true }),
      invoices: await folder.handle.getDirectoryHandle(DIR_OF.invoices, { create: true })
    };
    folder.granted = true;
  }

  function slug(text) {
    return String(text == null ? '' : text).normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 48);
  }

  /** "Alza-cz-a-s__k3j2….json": readable in a file manager, and unique because the id is part of it. */
  function fileNameFor(collection, rec) {
    var taken = folder.names[collection];
    var current = taken[rec.id];
    var label = slug(collection === 'companies' ? rec.name : rec.number) || (collection === 'companies' ? 'company' : 'document');
    var stem = label + '__' + rec.id;
    var name = stem + '.json';
    // on a Mac "A.json" and "a.json" are one file: a name that differs from the current one only by case is not a rename
    if (current && current.toLowerCase() === name.toLowerCase()) return current;
    var n = 2;
    var clash = function (candidate) {
      return Object.keys(taken).some(function (id) { return id !== rec.id && taken[id].toLowerCase() === candidate.toLowerCase(); });
    };
    while (clash(name)) name = stem + '~' + (n++) + '.json';
    return name;
  }

  /** Writes through the browser's swap file: the old content stays until the new one is complete. */
  async function writeFile(dir, name, data) {
    var existed = true;
    try { await dir.getFileHandle(name); } catch (e) { existed = false; }
    var file = await dir.getFileHandle(name, { create: true });
    try {
      var writer = await file.createWritable();
      try {
        await writer.write(data);
        await writer.close();
      } catch (e) {
        try { await writer.abort(); } catch (x) { /* already closed */ }
        throw e;
      }
    } catch (e) {
      // a file that was only just created and never got its content must not stay behind empty
      if (!existed) { try { await dir.removeEntry(name); } catch (x) { /* nothing to remove */ } }
      throw e;
    }
  }

  async function loadFolder() {
    await openFolder();
    var out = { companies: [], invoices: [], settings: {}, truncated: false, skipped: [] };
    var names = { companies: Object.create(null), invoices: Object.create(null) };
    var copies = { companies: Object.create(null), invoices: Object.create(null) };
    var collections = ['companies', 'invoices'];
    for (var c = 0; c < collections.length; c++) {
      var collection = collections[c];
      var seen = Object.create(null);
      for await (var entry of folder.dirs[collection].values()) {
        if (entry.kind !== 'file' || entry.name.charAt(0) === '.' || !/\.json$/i.test(entry.name)) continue;
        var where = DIR_OF[collection] + '/' + entry.name;
        var rec = null;
        try { rec = JSON.parse(await (await entry.getFile()).text()); } catch (e) { rec = null; }
        if (!rec || typeof rec !== 'object' || Array.isArray(rec) || !idOk(rec.id)) { out.skipped.push(where); continue; }
        var earlier = seen[rec.id];
        if (earlier) {
          // the same record twice (a rename that was cut short, or a sync tool's conflict copy):
          // the newer one is used and the other is left where it is, untouched
          var loser = entry.name;
          if (String(rec.updatedAt || '') > String(earlier.rec.updatedAt || '')) {
            loser = earlier.name;
            seen[rec.id] = { rec: rec, name: entry.name };
          }
          out.skipped.push(DIR_OF[collection] + '/' + loser);
          (copies[collection][rec.id] || (copies[collection][rec.id] = [])).push(loser);
          continue;
        }
        seen[rec.id] = { rec: rec, name: entry.name };
      }
      Object.keys(seen).forEach(function (id) {
        out[collection].push(seen[id].rec);
        names[collection][id] = seen[id].name;
      });
    }
    var locked = false;
    try {
      var settingsFile = await folder.handle.getFileHandle('settings.json');
      var settingsText = await (await settingsFile.getFile()).text();
      if (settingsText.trim() !== '') {
        try {
          var parsed = JSON.parse(settingsText);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) out.settings = parsed;
          else locked = true;
        } catch (e) { locked = true; }
      }
    } catch (e) { /* no settings.json yet: the defaults do */ }
    // a settings.json that is not ours is treated like any other stray file: listed, and never written over
    if (locked) out.skipped.push('settings.json');
    folder.settingsLocked = locked;
    folder.names = names;
    folder.copies = copies;
    folder.skipped = out.skipped.slice();
    return out;
  }

  async function folderPut(collection, rec) {
    if (!folder.dirs) await openFolder();
    var dir = folder.dirs[collection];
    var name = fileNameFor(collection, rec);
    var old = folder.names[collection][rec.id];
    await writeFile(dir, name, JSON.stringify(rec, null, 2) + '\n');
    folder.names[collection][rec.id] = name;
    if (old && old !== name) {
      // the record was renamed (a new number or company name). The new file is complete, so the old one can go;
      // if this fails the old file is only skipped as an older copy on the next read
      try {
        await dir.removeEntry(old);
      } catch (e) {
        // remembered as an older copy, so that deleting the record later removes this file too
        var left = folder.copies[collection][rec.id] || (folder.copies[collection][rec.id] = []);
        if (left.indexOf(old) === -1) left.push(old);
      }
    }
  }

  async function folderRemove(collection, id) {
    if (!folder.dirs) await openFolder();
    // every file that holds this record goes, the older copies too: a deleted record must not come back on the next read
    var files = (folder.names[collection][id] ? [folder.names[collection][id]] : []).concat(folder.copies[collection][id] || []);
    for (var i = 0; i < files.length; i++) {
      try {
        await folder.dirs[collection].removeEntry(files[i]);
      } catch (e) {
        if (!e || e.name !== 'NotFoundError') throw e;
      }
    }
    delete folder.names[collection][id];
    delete folder.copies[collection][id];
    // a file that is gone is no longer one that was "left untouched"
    folder.skipped = folder.skipped.filter(function (entry) {
      return files.every(function (name) { return entry !== DIR_OF[collection] + '/' + name; });
    });
  }

  /** Where the folder stands: { supported, configured, granted, name, skipped }. */
  function folderState() {
    return {
      supported: folderSupported(),
      configured: !!folder.handle,
      granted: mode === 'folder' && folder.granted,
      name: folder.handle ? String(folder.handle.name || '') : '',
      skipped: folder.skipped.slice()
    };
  }

  /** Makes `handle` the place where data lives, and remembers it for the next visit. */
  async function useDirectoryHandle(handle) {
    await flush();
    var before = folder;
    folder = emptyFolder();
    folder.handle = handle;
    try {
      await openFolder();
    } catch (e) {
      folder = before;
      throw fsError(e);
    }
    mode = 'folder';
    lastError = null;
    await rememberHandle(handle);
    emit();
    return folderState();
  }

  /**
   * Opens the browser's folder picker and resolves the folder's handle. It only asks: nothing changes until
   * useDirectoryHandle is called with the answer. Must be called straight from a click, before anything is awaited,
   * or the browser refuses to open the picker. Rejects {code: 'declined'} when the person cancels.
   */
  async function pickFolderHandle() {
    if (!folderSupported()) throw { code: 'unsupported', message: 'This browser cannot write to a folder. Use Chrome or Edge on a computer.' };
    try {
      return await root.showDirectoryPicker({ id: 'invoice-workbench', mode: 'readwrite' });
    } catch (e) {
      if (e && e.name === 'AbortError') throw { code: 'declined', message: 'No folder was chosen.' };
      if (e && e.name === 'SecurityError') throw { code: 'folder_error', message: 'The browser did not open the folder picker. Press the button again.' };
      throw fsError(e);
    }
  }

  /**
   * Asks the browser for permission to the remembered folder again. It only asks: nothing changes until
   * openRememberedFolder. Must be called straight from a click, before anything is awaited.
   */
  async function askFolderPermission() {
    if (!folder.handle) throw { code: 'folder_missing', message: 'No folder has been chosen yet.' };
    var state;
    try {
      state = await folder.handle.requestPermission({ mode: 'readwrite' });
    } catch (e) {
      if (e && e.name === 'SecurityError') throw { code: 'folder_error', message: 'The browser did not ask for permission. Press the button again.' };
      throw fsError(e);
    }
    if (state !== 'granted') throw { code: 'declined', message: 'The browser was not allowed to use the folder.' };
    return true;
  }

  /** Makes the remembered folder the place where data lives, once the browser has allowed it. */
  async function openRememberedFolder() {
    if (!folder.handle) throw { code: 'folder_missing', message: 'No folder has been chosen yet.' };
    await flush();
    try {
      await openFolder();
    } catch (e) {
      folder.granted = false;
      throw fsError(e);
    }
    mode = 'folder';
    lastError = null;
    emit();
    return folderState();
  }

  /** Stops using the folder. Its files are left exactly as they are. */
  async function forgetFolder(options) {
    await flush();
    await forgetHandle();
    folder = emptyFolder();
    mode = localUsable() ? 'local' : 'memory';
    // Normally the screens carry their records over and write them afresh, so the browser's copy starts empty:
    // reading back what it held before would bring back records deleted while the folder was in use.
    // Only when the folder could not be read at all is the browser's own copy what there is to go on.
    local = { companies: Object.create(null), invoices: Object.create(null), settings: {} };
    if (mode === 'local' && options && options.keepBrowserCopy) readLocal();
    lastError = null;
    emit();
    return mode;
  }

  /** Keeps a copy of a downloaded PDF beside the data. Resolves the path inside the folder, or '' when there is no folder. */
  async function savePdfCopy(fileName, blob) {
    if (mode !== 'folder' || !folder.handle) return '';
    var safe = String(fileName || 'document.pdf').normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 120) || 'document.pdf';
    if (!/\.pdf$/i.test(safe)) safe += '.pdf';
    try {
      var dir = await folder.handle.getDirectoryHandle('PDF', { create: true });
      await writeFile(dir, safe, blob);
    } catch (e) {
      throw fsError(e);
    }
    return 'PDF/' + safe;
  }

  // ---------------------------------------------------------------- start and read

  /** Picks where data lives. Resolves 'cloud', 'folder', 'local' or 'memory'. */
  async function init() {
    var claude = root.claude;
    if (claude && typeof claude.use === 'function') {
      try {
        var found = await Promise.all([claude.use('db'), claude.use('user')]);
        var db = found[0];
        var id = found[1] ? await found[1].id() : null;
        if (db && id) {
          base = db.doc('data/users/' + id + '/app');
          mode = 'cloud';
          return mode;
        }
      } catch (e) { /* fall through to the browser's own storage */ }
    }
    if (localUsable() && readLocal()) mode = 'local';
    else mode = 'memory';
    if (folderSupported()) {
      var handle = await recallHandle();
      if (handle && typeof handle.queryPermission === 'function') {
        folder.handle = handle;
        var state = 'prompt';
        try { state = await handle.queryPermission({ mode: 'readwrite' }); } catch (e) { state = 'prompt'; }
        if (state === 'granted') {
          try {
            await openFolder();
            mode = 'folder';
          } catch (e) {
            folder.granted = false;   // the folder is gone or unreadable: the screens ask what to do
          }
        }
      }
    }
    return mode;
  }

  /** Everything saved: { companies: [], invoices: [], settings: {} }. Rejects with {code, message} when it cannot be read. */
  async function load() {
    if (mode === 'folder') {
      try {
        return await loadFolder();
      } catch (e) {
        throw fsError(e);
      }
    }
    if (mode !== 'cloud') {
      return { companies: clone(values(local.companies)), invoices: clone(values(local.invoices)), settings: clone(local.settings || {}), truncated: false };
    }
    var res = await withTimeout(Promise.all([
      base.get(),
      base.collection('companies').limit(1000).get(),
      base.collection('invoices').limit(1000).get()
    ]), LOAD_TIMEOUT_MS);
    var body = res[0].exists ? (res[0].data() || {}) : {};
    return {
      // one read returns at most 1000 records; more than that are stored but not loaded, and the screens say so
      truncated: res[1].size >= 1000 || res[2].size >= 1000,
      settings: clone(body.settings || {}),
      companies: res[1].docs.map(function (d) { return clone(d.data()); }),
      invoices: res[2].docs.map(function (d) { return clone(d.data()); })
    };
  }

  // ------------------------------------------------------------------------ writes

  function pump(path) {
    var q = queues[path];
    if (!q || q.running || !q.waiting) return;
    var w = q.waiting;
    q.waiting = null;
    q.running = w;
    active++;
    emit();
    var attempt = function () { return Promise.resolve().then(w.job); };
    attempt()
      .catch(function (e) {
        // a transient platform hiccup gets one more try, after a short random pause
        if (e && e.code === 'unavailable') {
          return new Promise(function (r) { setTimeout(r, 400 + Math.floor(Math.random() * 600)); }).then(attempt);
        }
        throw e;
      })
      .then(function (v) { lastError = null; w.resolve(v); }, function (e) { lastError = e || { code: 'unknown' }; w.reject(lastError); })
      .then(function () {
        q.running = null;
        active--;
        emit();
        pump(path);
      });
  }

  /** One write at a time per document. A write still waiting when a newer one arrives is dropped: the newer one has newer data. */
  function enqueue(path, job) {
    var q = queues[path] || (queues[path] = { waiting: null, running: null });
    return new Promise(function (resolve, reject) {
      if (q.waiting) q.waiting.resolve('superseded');
      q.waiting = { job: job, resolve: resolve, reject: reject };
      pump(path);
    });
  }

  function put(collection, doc) {
    if (!doc || !idOk(doc.id)) return Promise.reject({ code: 'invalid_argument', message: 'A record needs an id.' });
    var body = clone(doc);
    return enqueue(collection + '/' + doc.id, function () {
      if (mode === 'cloud') return base.collection(collection).doc(doc.id).set(body);
      if (mode === 'folder') {
        return folderPut(collection, body).then(function () { dropFromBrowserCopy(collection, doc.id); }, function (e) { throw fsError(e); });
      }
      local[collection][doc.id] = body;
      writeLocal();
      return undefined;
    });
  }

  function remove(collection, id) {
    return enqueue(collection + '/' + id, function () {
      if (mode === 'cloud') return base.collection(collection).doc(id).delete();
      if (mode === 'folder') {
        return folderRemove(collection, id).then(function () { dropFromBrowserCopy(collection, id); }, function (e) { throw fsError(e); });
      }
      delete local[collection][id];
      writeLocal();
      return undefined;
    });
  }

  function putSettings(settings) {
    var body = clone(settings || {});
    return enqueue('settings', function () {
      if (mode === 'cloud') return base.set({ settings: body });
      if (mode === 'folder') {
        if (folder.settingsLocked) return undefined;
        return writeFile(folder.handle, 'settings.json', JSON.stringify(body, null, 2) + '\n').catch(function (e) { throw fsError(e); });
      }
      local.settings = body;
      writeLocal();
      return undefined;
    });
  }

  /** Resolves when nothing is waiting to be written. */
  function flush() {
    return new Promise(function (resolve) {
      (function check() {
        if (active === 0) resolve();
        else setTimeout(check, 60);
      })();
    });
  }

  root.InvoiceStore = {
    init: init,
    load: load,
    putCompany: function (doc) { return put('companies', doc); },
    removeCompany: function (id) { return remove('companies', id); },
    putInvoice: function (doc) { return put('invoices', doc); },
    removeInvoice: function (id) { return remove('invoices', id); },
    putSettings: putSettings,
    flush: flush,
    onStatus: onStatus,
    getMode: function () { return mode; },
    folderState: folderState,
    pickFolderHandle: pickFolderHandle,
    useDirectoryHandle: useDirectoryHandle,
    askFolderPermission: askFolderPermission,
    openRememberedFolder: openRememberedFolder,
    forgetFolder: forgetFolder,
    clearBrowserCopy: clearBrowserCopy,
    browserCopy: browserCopy,
    browserCopyCount: browserCopyCount,
    dropFromBrowserCopy: dropFromBrowserCopy,
    savePdfCopy: savePdfCopy
  };
})(typeof window !== 'undefined' ? window : globalThis);
