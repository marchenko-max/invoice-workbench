/*
 * InvoiceSign: put a signature, a date or a line of text on any PDF or picture of a document, in the browser.
 * window.InvoiceSign.render(host, env) draws the screen into `host`; env is what the app lends it:
 *   { h, button, toast, errorText, saveFile, signaturePad, readImage, isCurrent(),
 *     companySignatures(), getSignature(), setSignature(img) }
 *
 * The file never leaves the device. pdf.js draws its pages and pdf-lib writes the signed copy; both are fetched
 * from cdnjs the first time a file is opened here, so the invoice screens never wait for them.
 *
 * What is placed on a page is kept as fractions of that page as it is shown (already turned the way a reader sees
 * it), so it stays put when the window changes size, and is turned back into the page's own coordinates only
 * when the signed copy is written.
 */
(function () {
  'use strict';

  var PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  var PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  var PDFLIB = 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js';
  var MAX_BYTES = 60 * 1024 * 1024;
  var MAX_PAGES = 60;                 // pages drawn; the rest stay in the file untouched
  var MAX_ITEMS = 200;
  var MAX_PICTURE_CHARS = 90000;      // the app's own limit for a stored picture
  var PAGE_WIDTH = 880;               // the widest a page is drawn, in CSS pixels
  var LEAST_WIDTH = 28;               // points: nothing placed is made smaller than about a centimetre

  // doc: { name, bytes, pdf, pages: [{ page, w, h, rotation, toPdf }], count, items: [...], digitallySigned, nodes, nextId }
  var state = { doc: null, signature: null, busy: '', problem: '', run: 0, signing: false, leaving: false };
  var env = null;
  var host = null;

  // ------------------------------------------------------------ libraries

  var loading = null;

  function script(src) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = src;
      el.async = true;
      el.onload = function () { resolve(); };
      el.onerror = function () { el.remove(); reject(new Error('A part of this screen could not be loaded. Check the internet connection and try again.')); };
      document.head.appendChild(el);
    });
  }

  function pdfjsGlobal() { return window.pdfjsLib || window['pdfjs-dist/build/pdf'] || null; }

  function libs() {
    if (!loading) {
      loading = Promise.all([pdfjsGlobal() ? null : script(PDFJS), window.PDFLib ? null : script(PDFLIB)]).then(function () {
        var pdfjs = pdfjsGlobal();
        if (!pdfjs || !window.PDFLib) throw new Error('A part of this screen could not be loaded. Reload the page and try again.');
        pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
        return { pdfjs: pdfjs, PDFLib: window.PDFLib };
      });
      loading.catch(function () { loading = null; });       // a failed fetch is tried again on the next file
    }
    return loading;
  }

  // -------------------------------------------------------------- opening

  function isPdf(bytes) {
    // "%PDF" within the first kilobyte: some writers put a few bytes in front of it
    var n = Math.min(bytes.length - 4, 1024);
    for (var i = 0; i <= n; i++) if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46) return true;
    return false;
  }

  /** A photo or scan as a one-page PDF: the page has the picture's shape, as wide as A4 is in that direction. */
  async function pictureToPdf(L, file) {
    var bitmap;
    try { bitmap = await createImageBitmap(file); } catch (e) { throw new Error('The picture could not be opened. Choose a PDF, a JPG or a PNG.'); }
    var scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';                               // a see-through picture is a page on white paper
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (bitmap.close) bitmap.close();
    var out = await L.PDFLib.PDFDocument.create();
    var picture = await out.embedJpg(canvas.toDataURL('image/jpeg', 0.9));
    var width = canvas.width >= canvas.height ? 841.89 : 595.28;
    var height = width * canvas.height / canvas.width;
    out.addPage([width, height]).drawImage(picture, { x: 0, y: 0, width: width, height: height });
    return out.save();
  }

  function refusal(name) {
    if (/\.(docx?|odt|rtf|pages)$/i.test(name)) return 'This is a text document, not a PDF. Open it in its own app, save or export it as PDF, and choose that file.';
    if (/\.(xlsx?|ods|numbers|csv)$/i.test(name)) return 'This is a spreadsheet, not a PDF. Export it as PDF and choose that file.';
    return 'Choose a PDF or a picture of the document (JPG or PNG).';
  }

  /** Lets go of a document's pdf.js side: its worker and the copy of the file it holds. */
  function release(doc) {
    if (doc && doc.pdf) { try { doc.pdf.destroy(); } catch (e) { /* already gone */ } doc.pdf = null; }
  }

  async function open(file) {
    var run = ++state.run;
    var pdf = null;
    state.problem = '';
    state.leaving = false;
    state.busy = 'Opening ' + (file.name || 'the file') + '…';
    draw();
    try {
      if (file.size > MAX_BYTES) throw new Error('The file is larger than 60 MB, which is more than this page will open.');
      var name = file.name || 'document.pdf';
      var bytes = new Uint8Array(await file.arrayBuffer());
      if (!bytes.length) throw new Error('The file is empty.');
      var L = await libs();
      if (!isPdf(bytes)) {
        if (!/^image\//.test(file.type || '') && !/\.(png|jpe?g|webp|gif|bmp|heic)$/i.test(name)) throw new Error(refusal(name));
        bytes = await pictureToPdf(L, file);
        name = name.replace(/\.[A-Za-z0-9]+$/, '') + '.pdf';
      }
      // nothing is placed on a file the signed copy could not be written from
      var probe;
      try {
        probe = await L.PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
      } catch (e) {
        throw new Error(/encrypt/i.test(String(e && e.message))
          ? 'This PDF is protected against changes, so nothing can be added to it. Ask for an unprotected copy.'
          : 'This PDF cannot be changed here: the file is damaged or built in an unusual way.');
      }
      var digitallySigned = false;
      try { digitallySigned = probe.getForm().getFields().some(function (f) { return f instanceof L.PDFLib.PDFSignature; }); } catch (e) { digitallySigned = false; }

      try {
        pdf = await L.pdfjs.getDocument({ data: bytes.slice() }).promise;        // pdf.js takes the buffer for itself: give it a copy
      } catch (e) {
        throw new Error(e && e.name === 'PasswordException' ? 'This PDF opens only with a password, so it cannot be signed here.' : 'This PDF could not be opened: the file is damaged.');
      }
      var pages = [];
      for (var i = 1; i <= Math.min(pdf.numPages, MAX_PAGES); i++) {
        var page = await pdf.getPage(i);
        pages.push(pageEntry(page));
      }
      if (!pages.length) throw new Error('This PDF has no pages, so there is nothing to sign.');
      if (run !== state.run) return;
      release(state.doc);
      state.doc = { name: name, bytes: bytes, pdf: pdf, pages: pages, count: pdf.numPages, items: [], digitallySigned: digitallySigned, nodes: null, nextId: 1 };
      pdf = null;                                               // the document owns it now
    } catch (e) {
      if (run === state.run) state.problem = (e && e.message) || 'The file could not be opened.';
    } finally {
      if (pdf) { try { pdf.destroy(); } catch (e) { /* already gone */ } }
      if (run === state.run) {
        state.busy = '';
        // drawn only while this screen is the one on show; otherwise the state waits for the person to come back
        if (draw()) {
          var next = document.getElementById(state.doc && !state.problem ? (state.signature ? 'sign-add-signature' : 'sign-draw') : 'sign-file');
          if (next) next.focus();
        }
      }
    }
  }

  function pageEntry(page) {
    var vp = page.getViewport({ scale: 1 });
    return {
      page: page, w: vp.width, h: vp.height, rotation: ((vp.rotation % 360) + 360) % 360,
      // a point of the page as shown (left, top, in points) -> the page's own coordinates
      toPdf: function (x, y) { return vp.convertToPdfPoint(x, y); }
    };
  }

  // ------------------------------------------------------------- pictures

  function today() {
    var d = new Date();
    return d.getDate() + '. ' + (d.getMonth() + 1) + '. ' + d.getFullYear();
  }

  /** A line of text as a picture, so any letter of any language prints as it is typed. */
  function textPicture(text) {
    var size = 54;
    var font = '500 ' + size + 'px -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext('2d');
    ctx.font = font;
    canvas.width = Math.min(4000, Math.ceil(ctx.measureText(text).width) + 12);
    canvas.height = Math.ceil(size * 1.35);
    ctx = canvas.getContext('2d');
    ctx.font = font;
    ctx.fillStyle = '#14213d';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 6, canvas.height / 2);
    return { src: canvas.toDataURL('image/png'), w: canvas.width, h: canvas.height };
  }

  /**
   * A picture of a signature as ink alone. One that already has see-through parts is kept as it is. A photo or
   * scan of a signature on paper has its paper made see-through: how light the edge of the picture is says what
   * paper looks like, and every pixel is as solid as it is darker than that. Without this the paper would print
   * as a white box over whatever the signature is placed on.
   */
  function inkOnly(picture) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onerror = function () { resolve(picture); };
      img.onload = function () {
        var w = img.naturalWidth, hgt = img.naturalHeight;
        if (!w || !hgt) { resolve(picture); return; }
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = hgt;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        var data = ctx.getImageData(0, 0, w, hgt);
        var d = data.data;
        var i;
        for (i = 3; i < d.length; i += 4) if (d[i] < 250) { resolve(picture); return; }       // see-through already
        function light(at) { return 0.299 * d[at] + 0.587 * d[at + 1] + 0.114 * d[at + 2]; }
        var edge = [];
        var stepX = Math.max(1, Math.floor(w / 60)), stepY = Math.max(1, Math.floor(hgt / 60));
        var x, y;
        for (x = 0; x < w; x += stepX) { edge.push(light(x * 4)); edge.push(light(((hgt - 1) * w + x) * 4)); }
        for (y = 0; y < hgt; y += stepY) { edge.push(light(y * w * 4)); edge.push(light((y * w + w - 1) * 4)); }
        edge.sort(function (a, b) { return a - b; });
        var paper = edge[Math.floor(edge.length / 2)];
        if (paper < 120) { resolve(picture); return; }            // dark all round: not ink on paper, leave it alone
        var span = Math.max(50, paper * 0.45);
        var inked = 0;
        for (i = 0; i < d.length; i += 4) {
          var a = (paper - 14 - light(i)) / span;
          a = a <= 0 ? 0 : a >= 1 ? 1 : a;
          d[i + 3] = Math.round(a * 255);
          if (a > 0.5) inked++;
        }
        if (inked < 20) { resolve(picture); return; }            // nothing darker than the paper: nothing to keep
        ctx.putImageData(data, 0, 0);
        var out = canvas, scale = 1;
        for (var attempt = 0; attempt < 8; attempt++) {
          var src = out.toDataURL('image/png');
          if (src.length <= MAX_PICTURE_CHARS) { resolve({ src: src, w: out.width, h: out.height }); return; }
          scale *= 0.75;
          out = document.createElement('canvas');
          out.width = Math.max(1, Math.round(w * scale));
          out.height = Math.max(1, Math.round(hgt * scale));
          out.getContext('2d').drawImage(canvas, 0, 0, out.width, out.height);
        }
        resolve(picture);
      };
      img.src = picture.src;
    });
  }

  // ---------------------------------------------------------------- items

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /** The page that fills most of the window right now, and how far down it the middle of the window is. */
  function spotInView() {
    var doc = state.doc;
    var best = 0, bestArea = -1, at = 0.4;
    (doc.nodes || []).forEach(function (node, i) {
      var r = node.box.getBoundingClientRect();
      var top = Math.max(r.top, 0), bottom = Math.min(r.bottom, window.innerHeight);
      if (bottom - top > bestArea) {
        bestArea = bottom - top;
        best = i;
        at = r.height ? clamp(((top + bottom) / 2 - r.top) / r.height, 0.05, 0.95) : 0.4;
      }
    });
    return { page: best, at: at };
  }

  function overlaps(a, b) {
    return a.fx < b.fx + b.fw && b.fx < a.fx + a.fw && a.fy < b.fy + b.fh && b.fy < a.fy + a.fh;
  }

  /** kind: 'signature' | 'date' | 'text'. picture: { src, w, h }. Lands in the middle of what is on screen. */
  function addItem(kind, picture, text) {
    var doc = state.doc;
    if (!doc || doc.items.length >= MAX_ITEMS) return null;
    var spot = spotInView();
    var entry = doc.pages[spot.page];
    var ratio = picture.w / picture.h;
    // a signature starts a third of the page wide; a line of text starts at the size of ordinary print
    var widthPt = kind === 'signature' ? entry.w * 0.3 : 15 * ratio;
    widthPt = Math.min(widthPt, entry.w * 0.9);
    var fw = widthPt / entry.w;
    var fh = widthPt / ratio / entry.h;
    if (fh > 0.9) { fh = 0.9; fw = fh * entry.h * ratio / entry.w; }
    var item = {
      id: doc.nextId++, page: spot.page, kind: kind, src: picture.src, ratio: ratio, text: text || '',
      fx: (1 - fw) / 2, fy: clamp(spot.at - fh / 2, 0, 1 - fh), fw: fw, fh: fh
    };
    // Never on top of something already there. It goes under it, as lines of writing do; with no room left
    // below, the free place nearest the top of the page; and only on a page that is full, where it was aimed.
    var others = doc.items.filter(function (x) { return x.page === item.page; });
    var free = function (fy) { var probe = { fx: item.fx, fy: fy, fw: fw, fh: fh }; return !others.some(function (x) { return overlaps(probe, x); }); };
    if (!free(item.fy)) {
      var step = fh + 0.012, found = null, y;
      for (y = item.fy + step; y <= 1 - fh && found == null; y += step) if (free(y)) found = y;
      for (y = 0; y <= 1 - fh && found == null; y += step) if (free(y)) found = y;
      if (found != null) item.fy = found;
    }
    doc.items.push(item);
    return item;
  }

  function removeItem(item) {
    var doc = state.doc;
    doc.items = doc.items.filter(function (x) { return x !== item; });
  }

  function place(el, item) {
    el.style.left = (item.fx * 100) + '%';
    el.style.top = (item.fy * 100) + '%';
    el.style.width = (item.fw * 100) + '%';
    el.style.height = (item.fh * 100) + '%';
  }

  /** Sets the width (a fraction of the page) keeping the picture's shape and keeping it on the page. */
  function resize(item, fw) {
    var entry = state.doc.pages[item.page];
    var shape = entry.w / entry.h / item.ratio;            // height fraction per width fraction
    var least = Math.min(0.5, LEAST_WIDTH / entry.w);
    var most = Math.min(1 - item.fx, (1 - item.fy) / shape);
    item.fw = clamp(fw, Math.min(least, most), most);
    item.fh = item.fw * shape;
  }

  /** Scrolls a placed thing out from under the tools that stay at the top of the window. */
  function uncover(el) {
    var tools = document.querySelector('.sign-tools');
    if (!tools) return;
    var edge = tools.getBoundingClientRect().bottom + 24;     // room for the remove button above it
    var top = el.getBoundingClientRect().top;
    if (top < edge) window.scrollBy(0, top - edge);
  }

  var KIND_NAME = { signature: 'Signature', date: 'Date', text: 'Text' };

  function itemNode(item, box) {
    var h = env.h;
    var label = KIND_NAME[item.kind] + (item.text ? ' “' + item.text + '”' : '') + ' on page ' + (item.page + 1) +
      '. Arrow keys move it, plus and minus change its size, Delete removes it.';
    var el = h('div', { class: 'sign-item', tabindex: 0, role: 'group', 'aria-label': label, 'data-kind': item.kind, id: 'sign-item-' + item.id });
    el.appendChild(h('img', { src: item.src, alt: '', draggable: 'false' }));
    el.appendChild(h('button', { type: 'button', class: 'sign-remove', 'aria-label': 'Remove this ' + KIND_NAME[item.kind].toLowerCase(), text: '×',
      onclick: function () { removeItem(item); drawItems(); drawBar(); focusBar(); } }));
    el.appendChild(h('span', { class: 'sign-grip', 'aria-hidden': 'true' }));
    place(el, item);
    el.addEventListener('focus', function () { uncover(el); });

    el.addEventListener('pointerdown', function (e) {
      if ((e.button != null && e.button > 0) || (e.target.closest && e.target.closest('.sign-remove'))) return;
      var resizing = !!(e.target.closest && e.target.closest('.sign-grip'));
      e.preventDefault();
      try { el.focus({ preventScroll: true }); } catch (ignored) { el.focus(); }
      try { el.setPointerCapture(e.pointerId); } catch (ignored) { /* the drag still works while the pointer stays on it */ }
      var rect = box.getBoundingClientRect();
      // Where on the thing it was taken hold of, as fractions of the page. The page's place in the window is
      // read again at every step, so the thing stays under the pointer while the page scrolls beneath it.
      var hold = {
        id: e.pointerId, x: e.clientX, y: e.clientY,
        gx: (e.clientX - rect.left) / (rect.width || 1) - item.fx,
        gy: (e.clientY - rect.top) / (rect.height || 1) - item.fy,
        gw: item.fx + item.fw - (e.clientX - rect.left) / (rect.width || 1)
      };
      el.classList.add('moving');
      function follow() {
        var r = box.getBoundingClientRect();
        var px = (hold.x - r.left) / (r.width || 1), py = (hold.y - r.top) / (r.height || 1);
        if (resizing) resize(item, px + hold.gw - item.fx);
        else {
          item.fx = clamp(px - hold.gx, 0, 1 - item.fw);
          item.fy = clamp(py - hold.gy, 0, 1 - item.fh);
        }
        place(el, item);
      }
      function move(ev) {
        if (ev.pointerId !== hold.id) return;
        hold.x = ev.clientX;
        hold.y = ev.clientY;
        follow();
      }
      function done(ev) {
        if (ev.pointerId !== hold.id) return;
        el.classList.remove('moving');
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', done);
        el.removeEventListener('pointercancel', done);
        window.removeEventListener('scroll', follow, true);
      }
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', done);
      el.addEventListener('pointercancel', done);
      window.addEventListener('scroll', follow, true);
    });

    el.addEventListener('keydown', function (e) {
      if (e.target !== el) return;
      var entry = state.doc.pages[item.page];
      var step = (e.shiftKey ? 10 : 2);                       // points
      var handled = true;
      if (e.key === 'ArrowLeft') item.fx = clamp(item.fx - step / entry.w, 0, 1 - item.fw);
      else if (e.key === 'ArrowRight') item.fx = clamp(item.fx + step / entry.w, 0, 1 - item.fw);
      else if (e.key === 'ArrowUp') item.fy = clamp(item.fy - step / entry.h, 0, 1 - item.fh);
      else if (e.key === 'ArrowDown') item.fy = clamp(item.fy + step / entry.h, 0, 1 - item.fh);
      else if (e.key === '+' || e.key === '=') resize(item, item.fw * 1.08);
      else if (e.key === '-' || e.key === '_') resize(item, item.fw / 1.08);
      else if (e.key === 'Delete' || e.key === 'Backspace') { removeItem(item); drawItems(); drawBar(); focusBar(); }
      else handled = false;
      if (handled) { e.preventDefault(); if (el.isConnected) { place(el, item); uncover(el); } }
    });
    return el;
  }

  // ---------------------------------------------------------- the signed copy

  /** The file with everything placed on it drawn in: resolves the bytes of the new PDF. */
  async function signedCopy() {
    var doc = state.doc;
    var L = await libs();
    var out = await L.PDFLib.PDFDocument.load(doc.bytes, { updateMetadata: false });
    var pictures = {};
    for (var i = 0; i < doc.items.length; i++) {
      var item = doc.items[i];
      var entry = doc.pages[item.page];
      if (!pictures[item.src]) pictures[item.src] = await (item.src.indexOf('data:image/png') === 0 ? out.embedPng(item.src) : out.embedJpg(item.src));
      // the picture's lower left corner as the reader sees it, in the page's own coordinates; the picture is then
      // turned by the page's rotation so it stands upright for the reader
      var corner = entry.toPdf(item.fx * entry.w, (item.fy + item.fh) * entry.h);
      out.getPage(item.page).drawImage(pictures[item.src], {
        x: corner[0], y: corner[1], width: item.fw * entry.w, height: item.fh * entry.h, rotate: L.PDFLib.degrees(entry.rotation)
      });
    }
    return out.save();
  }

  async function download() {
    var doc = state.doc;
    if (!doc || !doc.items.length || state.signing) return;
    state.signing = true;
    drawBar();
    try {
      var bytes;
      try { bytes = await signedCopy(); }
      catch (e) { env.toast('The signed copy could not be made. ' + env.errorText(e), 'bad'); return; }
      var name = doc.name.replace(/\.pdf$/i, '') + '-signed.pdf';
      try {
        await env.saveFile(new Blob([bytes], { type: 'application/pdf' }), name);
        env.toast('Saved as ' + name + '. The file you opened is unchanged.', 'long');
      } catch (e) {
        // declined is the person's own choice; anything else is said, and what was placed stays as it is
        if (e && e.code === 'declined') return;
        env.toast(e && e.code === 'rate_limited' ? 'Another save is still open. Answer it first.' : 'The signed copy was made but could not be saved. ' + env.errorText(e), 'bad');
      }
    } finally {
      state.signing = false;
      drawBar();
      focusBar('sign-download');
    }
  }

  // --------------------------------------------------------------- screen

  function focusBar(id) {
    var el = document.getElementById(id || 'sign-add-signature');
    if (el && !el.disabled) el.focus();
  }

  function paint(node, entry) {
    var width = Math.max(120, Math.round(node.box.clientWidth || PAGE_WIDTH));
    if (node.painted === width) return Promise.resolve();
    node.painted = width;
    if (node.task) { try { node.task.cancel(); } catch (e) { /* already finished */ } }
    var ratio = Math.min(2, window.devicePixelRatio || 1);
    var vp = entry.page.getViewport({ scale: width / entry.w * ratio });
    var canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    canvas.setAttribute('aria-hidden', 'true');
    node.task = entry.page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
    return node.task.promise.then(function () {
      // swapped in whole, so a page is never seen half drawn
      canvas.setAttribute('data-painted', String(width));
      if (node.canvas.parentNode) node.canvas.parentNode.replaceChild(canvas, node.canvas);
      node.canvas = canvas;
    }, function () { /* cancelled by a newer size */ });
  }

  async function paintAll() {
    var doc = state.doc;
    if (!doc || !doc.nodes) return;
    for (var i = 0; i < doc.nodes.length; i++) {
      if (state.doc !== doc) return;
      await paint(doc.nodes[i], doc.pages[i]);
    }
  }

  function buildPages() {
    var h = env.h;
    var doc = state.doc;
    doc.nodes = doc.pages.map(function (entry, i) {
      var canvas = h('canvas', { 'aria-hidden': 'true' });
      var layer = h('div', { class: 'sign-layer' });
      var box = h('div', { class: 'sign-page', style: 'aspect-ratio:' + entry.w + ' / ' + entry.h, 'data-page': i + 1 }, canvas, layer);
      var wrap = h('div', { class: 'sign-sheet' }, h('span', { class: 'hint', text: 'Page ' + (i + 1) + ' of ' + doc.count }), box);
      return { wrap: wrap, box: box, canvas: canvas, layer: layer, painted: 0, task: null };
    });
  }

  function drawItems() {
    var doc = state.doc;
    if (!doc || !doc.nodes) return;
    doc.nodes.forEach(function (node, i) {
      node.layer.textContent = '';
      doc.items.filter(function (x) { return x.page === i; }).forEach(function (item) { node.layer.appendChild(itemNode(item, node.box)); });
    });
  }

  function added(item) {
    if (!item) { env.toast('That is as many as one document takes here.', 'bad'); return; }
    state.leaving = false;
    drawItems();
    drawBar();
    var el = document.getElementById('sign-item-' + item.id);
    if (el) el.focus();
  }

  function drawSignature() {
    var h = env.h, button = env.button;
    var slot = document.getElementById('sign-signature');
    if (!slot) return;
    slot.textContent = '';
    var sig = state.signature;
    var thumb = h('div', { class: 'thumb' });
    if (sig) thumb.appendChild(h('img', { src: sig.src, alt: 'Your signature' }));
    else thumb.textContent = 'None yet';

    function use(img) {
      state.signature = img;
      env.setSignature(img);
      drawSignature();
      drawBar();
      focusBar();
    }
    var picture = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', id: 'sign-picture', style: 'max-width:230px', 'aria-describedby': 'sign-picture-hint' });
    picture.addEventListener('change', async function () {
      try { use(await inkOnly(await env.readImage(picture.files && picture.files[0], 600, 340))); }
      catch (e) { env.toast((e && e.message) || 'The picture could not be used.', 'bad'); }
    });
    var row = h('div', { class: 'image-slot' }, thumb,
      button(sig ? 'Draw a new one' : 'Draw your signature', function () {
        slot.textContent = '';
        slot.appendChild(env.signaturePad(600, 340, use, function () { drawSignature(); var again = document.getElementById('sign-draw'); if (again) again.focus(); }));
        var pad = document.getElementById('sign-pad');
        if (pad) pad.focus();
      }, 'small', { id: 'sign-draw' }),
      h('div', { class: 'field' }, h('label', { class: 'label', for: 'sign-picture', text: 'or use a picture of it' }), picture,
        h('span', { class: 'hint', id: 'sign-picture-hint', text: 'A photo of your signature on white paper works: the paper is made see-through.' })));
    var saved = env.companySignatures();
    if (saved.length) {
      var pick = h('select', { id: 'sign-from-company', 'aria-label': 'Use a company’s signature' },
        [h('option', { value: '', text: 'or take the one saved with…' })].concat(saved.map(function (c, i) { return h('option', { value: String(i), text: c.name }); })));
      pick.addEventListener('change', function () { if (pick.value !== '') use(saved[Number(pick.value)].picture); });
      row.appendChild(pick);
    }
    slot.appendChild(row);
  }

  /** Leaves the open document. With things placed on it and not downloaded, it asks once, in place. */
  function drawClose() {
    var h = env.h, button = env.button;
    var slot = document.getElementById('sign-close-slot');
    var doc = state.doc;
    if (!slot || !doc) return;
    slot.textContent = '';
    function leave() {
      state.run++;
      release(state.doc);
      state.doc = null;
      state.problem = '';
      state.leaving = false;
      draw();
      var f = document.getElementById('sign-file');
      if (f) f.focus();
    }
    if (state.leaving && doc.items.length) {
      var n = doc.items.length;
      slot.appendChild(h('span', { class: 'hint', text: 'Leave without downloading? ' + n + (n === 1 ? ' thing you placed is' : ' things you placed are') + ' dropped.' }));
      slot.appendChild(button('Leave it', leave, 'small danger', { id: 'sign-close-yes' }));
      slot.appendChild(button('Stay', function () { state.leaving = false; drawClose(); var b = document.getElementById('sign-close'); if (b) b.focus(); }, 'small', { id: 'sign-close-no' }));
      var stay = document.getElementById('sign-close-no');
      if (stay) stay.focus();
      return;
    }
    slot.appendChild(button('Open another', function () {
      if (doc.items.length) { state.leaving = true; drawClose(); }
      else leave();
    }, 'small quiet', { id: 'sign-close' }));
  }

  function drawBar() {
    var h = env.h, button = env.button;
    var bar = document.getElementById('sign-bar');
    var doc = state.doc;
    if (!bar || !doc) return;
    bar.textContent = '';
    var n = doc.items.length;
    bar.appendChild(button('Add signature', function () {
      if (!state.signature) { env.toast('Draw or choose your signature first.', 'bad'); var d = document.getElementById('sign-draw'); if (d) d.focus(); return; }
      added(addItem('signature', state.signature));
    }, '', { id: 'sign-add-signature' }));
    bar.appendChild(button('Add date', function () { var t = today(); added(addItem('date', textPicture(t), t)); }, '', { id: 'sign-add-date' }));
    var text = h('input', { type: 'text', id: 'sign-text', maxlength: 120, placeholder: 'Your name, a place…', 'aria-label': 'Text to add' });
    var addText = function () {
      var value = text.value.trim();
      if (!value) { text.focus(); return; }
      added(addItem('text', textPicture(value), value));
    };
    text.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addText(); } });
    bar.appendChild(h('span', { class: 'sign-textrow' }, text, button('Add text', addText, '', { id: 'sign-add-text' })));
    bar.appendChild(h('span', { class: 'spacer' }));
    // the short word is what a phone shows, so the three actions share one row
    var save = h('button', { type: 'button', class: 'btn primary', id: 'sign-download', 'aria-label': state.signing ? 'Saving' : 'Download signed PDF', onclick: download },
      h('span', { class: 'long', text: state.signing ? 'Saving…' : 'Download signed PDF' }), h('span', { class: 'short', text: state.signing ? 'Saving…' : 'Download' }));
    save.disabled = !n || state.signing;
    bar.appendChild(save);
    var status = document.getElementById('sign-count');
    if (status) status.textContent = n ? n + (n === 1 ? ' thing' : ' things') + ' placed. Drag to move, pull the round corner to resize.' : 'Nothing is placed yet. Add your signature, then drag it where it belongs.';
    if (!n) state.leaving = false;
    drawClose();
  }

  var resizeTimer = null;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { if (state.doc && host && host.isConnected && env && env.isCurrent()) paintAll(); }, 180);
  }

  function chooser(label) {
    var h = env.h;
    var input = h('input', { type: 'file', accept: 'application/pdf,.pdf,image/png,image/jpeg,image/webp', id: 'sign-file', style: 'max-width:280px' });
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      input.value = '';
      if (file) open(file);
    });
    return h('div', { class: 'field' }, h('label', { class: 'label', for: 'sign-file', text: label }), input);
  }

  /** Draws the screen as the state says. Returns false, and draws nothing, while another screen is on show. */
  function draw() {
    if (!host || !env || !env.isCurrent()) return false;
    var h = env.h;
    host.textContent = '';
    var page = h('div', { class: 'wrap page' });
    host.appendChild(page);
    page.appendChild(h('div', { class: 'page-head' }, h('h1', { text: 'Sign a document' })));
    if (state.problem) page.appendChild(h('div', { class: 'notice bad', id: 'sign-problem', role: 'alert' }, h('p', { text: state.problem })));
    if (state.busy) {
      page.appendChild(h('div', { class: 'panel empty', role: 'status' }, h('strong', { text: state.busy })));
      return true;
    }
    var doc = state.doc;
    if (!doc) {
      var drop = h('div', { class: 'panel empty', id: 'sign-drop' },
        h('strong', { text: 'Open the document you want to sign' }),
        h('span', { text: 'A PDF, or a photo or scan of a page (JPG, PNG). Put your signature, a date or your name anywhere on it and download the signed copy. The file stays on this device: it is opened, signed and saved here in your browser, and is not uploaded anywhere.' }),
        chooser('Document to sign'));
      drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('over'); });
      drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
      drop.addEventListener('drop', function (e) {
        e.preventDefault();
        drop.classList.remove('over');
        var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (file) open(file);
      });
      page.appendChild(drop);
      page.appendChild(h('p', { class: 'overview-foot', text: 'A signature placed this way is a simple electronic signature. It is fine for everyday agreements, orders and handover records. Where the law asks for a qualified or officially verified signature, as with a land registry or some dealings with authorities, it is not enough.' }));
      return true;
    }

    page.classList.add('sign-top');
    page.appendChild(h('section', { class: 'section' },
      h('header', null, h('h2', { id: 'sign-name', text: doc.name }), h('span', { class: 'spacer' }), h('span', { class: 'row', id: 'sign-close-slot' })),
      doc.digitallySigned ? h('div', { class: 'notice warn', id: 'sign-digital' }, h('p', null, h('strong', { text: 'This PDF carries a digital signature. ' }), 'Adding anything to it makes that signature show as broken. Sign a copy only if the other side expects that.')) : null,
      doc.count > doc.pages.length ? h('div', { class: 'notice' }, h('p', { text: 'The first ' + doc.pages.length + ' of ' + doc.count + ' pages are shown. The rest stay in the signed copy unchanged.' })) : null,
      h('div', { id: 'sign-signature' }),
      h('p', { class: 'hint', id: 'sign-count', role: 'status', 'aria-live': 'polite' })));

    // the tools stay at the top of the window while the pages scroll under them: what is added lands on the page in view
    host.appendChild(h('div', { class: 'sign-tools' }, h('div', { class: 'wrap', id: 'sign-bar' })));

    if (!doc.nodes) buildPages();
    var sheets = h('div', { class: 'sign-doc', id: 'sign-doc' });
    doc.nodes.forEach(function (node) { sheets.appendChild(node.wrap); });
    host.appendChild(h('div', { class: 'wrap page' }, sheets));
    drawSignature();
    drawItems();
    drawBar();
    paintAll();
    return true;
  }

  /** Draws the screen. The document that is open and what is placed on it are kept while the page lives. */
  function render(target, lent) {
    host = target;
    env = lent;
    if (!state.signature) state.signature = env.getSignature() || null;
    window.removeEventListener('resize', onResize);
    window.addEventListener('resize', onResize);
    draw();
  }

  window.InvoiceSign = {
    render: render,
    // for the tests: what is placed, and the signed copy without the download
    _state: state, _signedCopy: signedCopy, _libs: libs
  };
})();
