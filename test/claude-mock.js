/*
 * A stand-in for the claude.ai host, for tests only: window.claude.use() with a db that enforces the real
 * path rules (even segments for a document, odd for a collection, 256 KiB per document, plain objects only),
 * a user with an id, and a downloads capability that records what the page offered to save.
 * Documents persist in localStorage under "mock-db" so a reload can be tested.
 */
(function () {
  'use strict';
  var docs = {};
  try { docs = JSON.parse(localStorage.getItem('mock-db') || '{}'); } catch (e) { docs = {}; }
  function persist() { localStorage.setItem('mock-db', JSON.stringify(docs)); }
  function delay() { return new Promise(function (r) { setTimeout(r, 15); }); }
  function segments(path) {
    var s = String(path).split('/');
    s.forEach(function (seg) { if (!/^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(seg) || seg === '.' || seg === '..') throw new TypeError('bad path segment "' + seg + '" in ' + path); });
    if (s.length > 16) throw new TypeError('path too deep: ' + path);
    return s;
  }
  function snapshot(path) {
    var exists = Object.prototype.hasOwnProperty.call(docs, path);
    var body = exists ? Object.freeze(JSON.parse(JSON.stringify(docs[path]))) : undefined;
    return { id: path.split('/').pop(), exists: exists, data: function () { return body; }, metadata: { fromCache: false, hasPendingWrites: false } };
  }
  function checkBody(d) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw { code: 'invalid_argument', message: 'body must be a plain object' };
    if (JSON.stringify(d).length > 256 * 1024) throw { code: 'invalid_argument', message: 'document over 256 KiB' };
  }
  function doc(path) {
    if (segments(path).length % 2 !== 0) throw new TypeError('a document path needs an even number of segments: ' + path);
    window.__mock.writesInFlight = window.__mock.writesInFlight || {};
    return {
      id: path.split('/').pop(), path: path,
      get: function () { return delay().then(function () { return snapshot(path); }); },
      set: function (d) {
        checkBody(d);
        // a test can make every write fail: window.__mock.fail = { code: 'quota_exceeded' }
        if (window.__mock.fail) { var refusal = window.__mock.fail; return delay().then(function () { throw refusal; }); }
        var body = JSON.parse(JSON.stringify(d));
        if (window.__mock.writesInFlight[path]) window.__mock.overlaps.push(path);
        window.__mock.writesInFlight[path] = true;
        return delay().then(function () { docs[path] = body; persist(); window.__mock.sets.push(path); window.__mock.writesInFlight[path] = false; });
      },
      update: function (d) { checkBody(d); return delay().then(function () { if (!docs[path]) throw { code: 'invalid_argument' }; Object.assign(docs[path], JSON.parse(JSON.stringify(d))); persist(); }); },
      delete: function () { return delay().then(function () { delete docs[path]; persist(); window.__mock.deletes.push(path); }); },
      collection: function (p) { return collection(path + '/' + p); }
    };
  }
  function collection(path) {
    if (segments(path).length % 2 !== 1) throw new TypeError('a collection path needs an odd number of segments: ' + path);
    var q = {
      path: path,
      doc: function (id) { return doc(path + '/' + (id || 'auto' + Math.floor(Math.random() * 1e9))); },
      limit: function (n) { if (!(n >= 1 && n <= 1000)) throw { code: 'invalid_argument' }; return q; },
      get: function () {
        return delay().then(function () {
          var prefix = path + '/';
          var found = Object.keys(docs).filter(function (k) { return k.indexOf(prefix) === 0 && k.slice(prefix.length).indexOf('/') === -1; }).sort();
          return { docs: found.map(snapshot), size: found.length, empty: !found.length, metadata: { fromCache: false, hasPendingWrites: false } };
        });
      }
    };
    return q;
  }
  window.__mock = { docs: docs, sets: [], deletes: [], saved: [], overlaps: [] };
  var caps = {
    db: Object.freeze({ doc: doc, collection: collection }),
    user: Object.freeze({ id: function () { return Promise.resolve('u_testuser'); } }),
    downloads: Object.freeze({
      save: function (req) {
        if (!req || typeof req.filename !== 'string' || !req.data) return Promise.reject({ code: 'bad_request' });
        if (!/\.(pdf|json|csv)$/.test(req.filename)) return Promise.reject({ code: 'rejected_extension' });
        window.__mock.saved.push({ filename: req.filename, size: req.data.size != null ? req.data.size : req.data.length, type: req.data.type || '' });
        return Promise.resolve({ status: 'saved' });
      }
    })
  };
  window.claude = { use: function (name) { return new Promise(function (r) { setTimeout(function () { r(caps[name] || null); }, 20); }); } };
})();
