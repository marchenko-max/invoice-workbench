/*
 * Drives the Sign screen in headless Chrome: opening a PDF and a picture, drawing a signature, placing, moving and
 * resizing it with a pointer and with the keyboard, and the signed copy: read back and checked pixel by pixel that
 * the ink is where it was put, on upright and on turned pages.   node test/sign-check.js
 * Screenshots land in test/out/signdoc-*.png. Every document here is made up in the test.
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { launch } = require('./cdp.js');

const ROOT = path.resolve(__dirname, '..');
require('node:child_process').execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build.js')]);
const URL = 'file://' + path.join(ROOT, 'dist', 'index.html');
const OUT = path.join(__dirname, 'out');
const profile = path.join(__dirname, '.chrome-signdoc');

let failures = 0;
function ok(cond, what, detail) {
  if (cond) console.log('  ok   ' + what);
  else { failures++; console.log('  FAIL ' + what + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}
const near = function (a, b, tol) { return Math.abs(a - b) <= tol; };

// helpers that live in the page
const PAGE = `
window.T = {
  // a made-up PDF: pages of [width, height, rotation], each with a red line of text near its top
  async makePdf(pages) {
    var L = await InvoiceSign._libs();
    var doc = await L.PDFLib.PDFDocument.create();
    var font = await doc.embedFont(L.PDFLib.StandardFonts.Helvetica);
    pages.forEach(function (p, i) {
      var page = doc.addPage([p[0], p[1]]);
      if (p[2]) page.setRotation(L.PDFLib.degrees(p[2]));
      page.drawText('Made-up agreement, page ' + (i + 1), { x: 40, y: p[1] - 60, size: 16, font: font, color: L.PDFLib.rgb(1, 0, 0) });
    });
    return doc.save({ useObjectStreams: false });
  },
  give(bytes, name, type) {
    var dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type: type || '' }));
    var el = document.querySelector('#sign-file');
    el.files = dt.files;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  },
  async openPdf(pages, name) { T.give(await T.makePdf(pages), name || 'agreement.pdf', 'application/pdf'); },
  // where the dark-blue ink of a signature or of placed text is on a page of a PDF, as fractions of the page as shown
  async inkBox(bytes, pageNumber) {
    var L = await InvoiceSign._libs();
    var pdf = await L.pdfjs.getDocument({ data: bytes.slice() }).promise;
    var page = await pdf.getPage(pageNumber);
    var vp = page.getViewport({ scale: 2 });
    var c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    var d = ctx.getImageData(0, 0, c.width, c.height).data;
    var x0 = c.width, y0 = c.height, x1 = -1, y1 = -1, n = 0, red = 0;
    for (var y = 0; y < c.height; y++) for (var x = 0; x < c.width; x++) {
      var i = (y * c.width + x) * 4;
      if (d[i] > 200 && d[i + 1] < 80 && d[i + 2] < 80) red++;
      if (d[i] < 70 && d[i + 1] < 80 && d[i + 2] < 120 && d[i + 2] > d[i]) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    return { pages: pdf.numPages, w: vp.width / 2, h: vp.height / 2, ink: n, red: red,
      left: n ? x0 / c.width : null, top: n ? y0 / c.height : null, right: n ? (x1 + 1) / c.width : null, bottom: n ? (y1 + 1) / c.height : null };
  },
  item(i) { var it = InvoiceSign._state.doc.items[i]; return it ? { page: it.page, kind: it.kind, fx: it.fx, fy: it.fy, fw: it.fw, fh: it.fh, text: it.text } : null; },
  rect(sel) { var r = document.querySelector(sel).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; },
  drag(sel, dx, dy, type) {
    var el = document.querySelector(sel); var r = el.getBoundingClientRect();
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    var target = el.closest('.sign-item');
    function ev(name, px, py, t) { (t || target).dispatchEvent(new PointerEvent(name, { bubbles: true, cancelable: true, pointerId: 5, pointerType: type || 'mouse', button: 0, buttons: 1, clientX: px, clientY: py })); }
    ev('pointerdown', x, y, el);
    for (var k = 1; k <= 5; k++) ev('pointermove', x + dx * k / 5, y + dy * k / 5);
    ev('pointerup', x + dx, y + dy);
  },
  key(sel, key, shift) { document.querySelector(sel).dispatchEvent(new KeyboardEvent('keydown', { key: key, shiftKey: !!shift, bubbles: true, cancelable: true })); },
  stroke(points) {
    var c = document.querySelector('#sign-pad'); var r = c.getBoundingClientRect();
    function ev(name, p) { c.dispatchEvent(new PointerEvent(name, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', button: 0, buttons: 1, pressure: 0.5, clientX: r.left + p[0] * r.width, clientY: r.top + p[1] * r.height })); }
    ev('pointerdown', points[0]); for (var i = 1; i < points.length; i++) ev('pointermove', points[i]); ev('pointerup', points[points.length - 1]);
  },
  // leaves the open document, answering the question it asks when things are placed
  leave() { var c = document.querySelector('#sign-close'); if (c) c.click(); var y = document.querySelector('#sign-close-yes'); if (y) y.click(); },
  // a PDF that carries a signature field, as a digitally signed one does
  async signedPdf() {
    var L = await InvoiceSign._libs(); var P = L.PDFLib;
    var doc = await P.PDFDocument.create(); var page = doc.addPage([300, 300]);
    var field = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: P.PDFString.of('Signature1'), Rect: [0, 0, 0, 0], P: page.ref }));
    doc.catalog.set(P.PDFName.of('AcroForm'), doc.context.obj({ Fields: [field], SigFlags: 3 }));
    return doc.save({ useObjectStreams: false });
  },
  async noPages() { var L = await InvoiceSign._libs(); var doc = await L.PDFLib.PDFDocument.create(); return doc.save({ addDefaultPage: false, useObjectStreams: false }); },
  // a picture: white or see-through ground with a dark scribble, as a PNG blob
  async scribble(w, h, ground) {
    var c = document.createElement('canvas'); c.width = w; c.height = h; var x = c.getContext('2d');
    if (ground) { x.fillStyle = ground; x.fillRect(0, 0, w, h); }
    x.strokeStyle = '#1a1a40'; x.lineWidth = Math.max(4, h / 30); x.lineCap = 'round'; x.beginPath();
    x.moveTo(w * 0.15, h * 0.6); x.bezierCurveTo(w * 0.3, h * 0.1, w * 0.4, h * 0.95, w * 0.55, h * 0.45); x.bezierCurveTo(w * 0.65, h * 0.2, w * 0.75, h * 0.8, w * 0.88, h * 0.5); x.stroke();
    return new Promise(function (r) { c.toBlob(r, 'image/png'); });
  },
  async givePicture(blob, name) { var dt = new DataTransfer(); dt.items.add(new File([blob], name, { type: blob.type })); var el = document.querySelector('#sign-picture'); el.files = dt.files; el.dispatchEvent(new Event('change', { bubbles: true })); },
  async alphaOf(src) { var i = new Image(); i.src = src; await i.decode(); var c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight; var x = c.getContext('2d'); x.drawImage(i, 0, 0); var d = x.getImageData(0, 0, c.width, c.height).data; var clear = 0, solid = 0; for (var k = 3; k < d.length; k += 4) { if (d[k] < 16) clear++; else if (d[k] > 200) solid++; } return { corner: d[3], clear: clear, solid: solid, type: src.slice(0, 15) }; },
  // red pixels (the made-up document's own text) inside a box of fractions of page 1
  async redIn(bytes, box) {
    var L = await InvoiceSign._libs(); var pdf = await L.pdfjs.getDocument({ data: bytes.slice() }).promise; var page = await pdf.getPage(1);
    var vp = page.getViewport({ scale: 2 }); var c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    var ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); await page.render({ canvasContext: ctx, viewport: vp }).promise;
    var x0 = Math.floor(box.fx * c.width), y0 = Math.floor(box.fy * c.height), w = Math.ceil(box.fw * c.width), h = Math.ceil(box.fh * c.height);
    var d = ctx.getImageData(x0, y0, w, h).data; var red = 0; for (var i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 90 && d[i + 2] < 90) red++; return red;
  },
  saved: [],
  // only what is handed to the person as a PDF: pdf.js makes object URLs of its own for its worker
  hookSaves() { var make = URL.createObjectURL; URL.createObjectURL = function (b) { if (b && b.type === 'application/pdf') T.saved.push(b); return make.call(URL, b); }; },
  async lastSaved() { var b = T.saved[T.saved.length - 1]; return b ? new Uint8Array(await b.arrayBuffer()) : null; }
};
T.hookSaves();
true`;

const SCRIBBLE = [[0.30, 0.60], [0.34, 0.40], [0.38, 0.66], [0.43, 0.38], [0.48, 0.64], [0.55, 0.50], [0.62, 0.58]];
const pagesShown = 'document.querySelectorAll("#sign-doc .sign-page").length';
// every page drawn: a page's canvas is marked once pdf.js has finished it (a fresh canvas is 300 px wide, so its width proves nothing)
const painted = '(function(){var c=document.querySelectorAll("#sign-doc .sign-page canvas");if(!c.length)return false;for(var i=0;i<c.length;i++)if(!c[i].hasAttribute("data-painted"))return false;return true})()';

(async () => {
  fs.rmSync(profile, { recursive: true, force: true });
  const b = await launch({ width: 1360, height: 1000, profile });
  try {
    console.log('1. the Sign tab opens on an invitation, not on an empty page');
    await b.goto(URL + '#sign', 2400);
    ok((await b.text('#view h1')) === 'Sign a document', 'the screen opens', await b.text('#view h1'));
    ok((await b.eval('document.querySelector("#tab-sign").getAttribute("aria-current")')) === 'page', 'its tab is the current one');
    ok(/not uploaded anywhere/.test(await b.text('#sign-drop')), 'it says the file stays on the device');
    ok(/simple electronic signature/.test(await b.text('#view')), 'and what such a signature is worth');
    await b.eval(PAGE);

    console.log('2. a two-page PDF is shown as it is');
    await b.eval('T.openPdf([[595, 842, 0], [595, 842, 0]])');
    await b.waitFor(pagesShown + ' === 2', 20000);
    await b.waitFor(painted, 20000);
    ok((await b.text('#sign-name')) === 'agreement.pdf', 'under its name', await b.text('#sign-name'));
    ok((await b.eval('document.querySelector("#sign-download").disabled')) === true, 'nothing to download before anything is placed');
    ok(/Nothing is placed yet/.test(await b.text('#sign-count')), 'and it says so');
    const drawn = await b.eval('(function(){var c=document.querySelector("#sign-doc .sign-page canvas");var d=c.getContext("2d").getImageData(0,0,c.width,c.height).data;var red=0;for(var i=0;i<d.length;i+=4)if(d[i]>200&&d[i+1]<80&&d[i+2]<80)red++;return red})()');
    ok(drawn > 50, 'the page’s own text is drawn', drawn);

    console.log('3. a signature is needed first, and can be drawn here');
    await b.click('#sign-add-signature');
    ok(/Draw or choose your signature first/.test(await b.text('#toasts')), 'asking for one before any exists', await b.text('#toasts'));
    await b.click('#sign-draw');
    await b.waitFor('document.querySelector("#sign-pad")');
    await b.eval('T.stroke(' + JSON.stringify(SCRIBBLE) + ')');
    await b.click('#sign-use');
    ok((await b.eval('!!document.querySelector("#sign-signature .thumb img")')) === true, 'the drawn signature is shown');
    ok((await b.eval('(function(){var d=JSON.parse(localStorage.getItem("invoice-workbench:v1")||"{}");return !!(d.settings&&d.settings.signature&&/^data:image\\/png/.test(d.settings.signature.src))})()')) === true, 'and kept for the next visit');

    console.log('4. it lands on the page in view and follows the pointer one to one');
    await b.click('#sign-add-signature');
    ok((await b.eval('document.querySelectorAll(".sign-item").length')) === 1, 'one signature on the page');
    ok((await b.eval('document.activeElement && document.activeElement.classList.contains("sign-item")')) === true, 'with the keyboard on it');
    const it0 = await b.eval('T.item(0)');
    ok(it0.page === 0 && near(it0.fw, 0.3, 0.001) && near(it0.fx, 0.35, 0.001), 'on page 1, a third of the page wide, centred', it0);
    const r0 = await b.eval('T.rect(".sign-item")');
    await b.eval('T.drag(".sign-item img", 120, 60)');
    const r1 = await b.eval('T.rect(".sign-item")');
    ok(near(r1.x - r0.x, 120, 1.5) && near(r1.y - r0.y, 60, 1.5), 'a drag of 120 by 60 moves it 120 by 60', [r1.x - r0.x, r1.y - r0.y]);
    await b.eval('T.drag(".sign-item img", 5000, 5000)');
    const page0 = await b.eval('T.rect(".sign-page")');
    const r2 = await b.eval('T.rect(".sign-item")');
    ok(r2.x + r2.w <= page0.x + page0.w + 1 && r2.y + r2.h <= page0.y + page0.h + 1, 'and it cannot leave the page', [r2, page0]);
    await b.eval('T.drag(".sign-item img", -400, -700)');

    console.log('5. the corner resizes it, keeping its shape');
    const s0 = await b.eval('T.rect(".sign-item")');
    await b.eval('T.drag(".sign-item .sign-grip", 80, 0)');
    const s1 = await b.eval('T.rect(".sign-item")');
    ok(near(s1.w - s0.w, 80, 1.5), 'pulling the corner 80 widens it by 80', s1.w - s0.w);
    ok(near(s1.w / s1.h, s0.w / s0.h, 0.02), 'the shape is kept', [s0.w / s0.h, s1.w / s1.h]);
    ok(near(s1.x, s0.x, 0.6) && near(s1.y, s0.y, 0.6), 'and its top left corner stays where it was');

    console.log('6. the keyboard moves, resizes and removes it');
    const k0 = await b.eval('T.item(0)');
    await b.eval('T.key(".sign-item","ArrowRight");T.key(".sign-item","ArrowDown",true);');
    const k1 = await b.eval('T.item(0)');
    ok(near((k1.fx - k0.fx) * 595, 2, 0.01) && near((k1.fy - k0.fy) * 842, 10, 0.01), 'an arrow moves it 2 points, with Shift 10', [(k1.fx - k0.fx) * 595, (k1.fy - k0.fy) * 842]);
    await b.eval('T.key(".sign-item","+")');
    ok((await b.eval('T.item(0).fw')) > k1.fw, 'plus makes it larger');
    await b.eval('T.key(".sign-item","-")');
    ok(near(await b.eval('T.item(0).fw'), k1.fw, 0.0005), 'minus brings it back');
    ok(/Arrow keys move it/.test(await b.eval('document.querySelector(".sign-item").getAttribute("aria-label")')), 'and it says so to a screen reader');

    console.log('7. a date and a line of text, in any letters');
    await b.click('#sign-add-date');
    const d = new Date();
    const todayText = d.getDate() + '. ' + (d.getMonth() + 1) + '. ' + d.getFullYear();
    ok((await b.eval('T.item(1).text')) === todayText, 'today’s date: ' + todayText, await b.eval('T.item(1)'));
    await b.fill('#sign-text', 'Žaneta Řeháková, Plzeň');
    await b.click('#sign-add-text');
    ok((await b.eval('T.item(2).text')) === 'Žaneta Řeháková, Plzeň', 'a name with every Czech accent', await b.eval('T.item(2)'));
    ok((await b.eval('document.querySelectorAll(".sign-item").length')) === 3 && /3 things placed/.test(await b.text('#sign-count')), 'three things placed');
    const overlap = await b.eval('(function(){var s=InvoiceSign._state.doc.items,hit=[];for(var i=0;i<s.length;i++)for(var j=i+1;j<s.length;j++){var a=s[i],c=s[j];if(a.page===c.page&&a.fx<c.fx+c.fw&&c.fx<a.fx+a.fw&&a.fy<c.fy+c.fh&&c.fy<a.fy+a.fh)hit.push([i,j]);}return hit})()');
    ok(overlap.length === 0, 'nothing that was added lies on top of anything else', overlap);
    await b.eval('window.scrollTo(0, 1500)');
    await b.wait(300);
    const tools = await b.eval('T.rect(".sign-tools")');
    ok(tools.y >= -1 && tools.y < 5, 'the tools stay at the top of the window while the pages scroll', tools.y);
    await b.click('#sign-add-date');
    ok((await b.eval('T.item(3).page')) === 1, 'and what is added then lands on the page in view, page 2', await b.eval('T.item(3)'));
    await b.eval('(function(){InvoiceSign._state.doc.items.pop();window.scrollTo(0,0);})()');
    await b.screenshot(path.join(OUT, 'signdoc-1-placed.png'), { full: true, maxHeight: 2400 });
    // put the date and the name on page 2 by hand, where the check below looks for them
    await b.eval('(function(){var s=InvoiceSign._state.doc.items;s[1].page=1;s[1].fx=0.1;s[1].fy=0.5;s[2].page=1;s[2].fx=0.1;s[2].fy=0.6;})()');

    console.log('8. the signed copy has the ink where it was put, and the file itself is untouched');
    const placed = await b.eval('T.item(0)');
    await b.click('#sign-download');
    await b.waitFor('T.saved.length === 1', 20000);
    ok(/Saved as agreement-signed\.pdf/.test(await b.text('#toasts')), 'saved as agreement-signed.pdf', await b.text('#toasts'));
    const out1 = await b.eval('T.lastSaved().then(function(bytes){return T.inkBox(bytes,1)})');
    ok(out1.pages === 2 && out1.red > 50, 'two pages, with their own text still there', out1);
    ok(out1.ink > 200, 'page 1 carries the signature’s ink', out1.ink);
    ok(out1.left >= placed.fx - 0.004 && out1.right <= placed.fx + placed.fw + 0.004 && out1.top >= placed.fy - 0.004 && out1.bottom <= placed.fy + placed.fh + 0.004,
      'inside the box it was placed in', { box: placed, ink: out1 });
    ok(out1.right - out1.left > placed.fw * 0.6, 'and filling most of its width', [out1.right - out1.left, placed.fw]);
    const out2 = await b.eval('T.lastSaved().then(function(bytes){return T.inkBox(bytes,2)})');
    ok(out2.ink > 100 && out2.left >= 0.095 && out2.top >= 0.495 && out2.bottom <= 0.64, 'page 2 carries the date and the name where they were put', out2);
    const original = await b.eval('T.inkBox(InvoiceSign._state.doc.bytes,1)');
    ok(original.ink === 0, 'the document that was opened has no ink in it', original.ink);

    console.log('8b. the handles: out of the way until the thing is held, then they work');
    await b.eval('T.leave()');
    await b.wait(150);
    await b.eval('T.openPdf([[595, 842, 0], [595, 842, 0]], "handles.pdf")');
    await b.waitFor(pagesShown + ' === 2 && document.querySelector("#sign-name").textContent === "handles.pdf"', 20000);
    await b.waitFor(painted, 20000);
    ok((await b.eval('document.activeElement && document.activeElement.id')) === 'sign-add-signature', 'after a file opens the keyboard is on Add signature', await b.eval('document.activeElement && document.activeElement.id'));
    await b.click('#sign-add-date');
    ok(near((await b.eval('T.item(0).fh')) * 842, 15, 0.05), 'a date starts at the size of ordinary print, 15 points high', (await b.eval('T.item(0).fh')) * 842);
    ok((await b.eval('getComputedStyle(document.querySelector(".sign-remove")).pointerEvents')) === 'auto', 'the remove button works while the thing has the keyboard');
    await b.eval('document.activeElement.blur()');
    ok((await b.eval('getComputedStyle(document.querySelector(".sign-remove")).pointerEvents')) === 'none', 'and cannot be hit by accident once it does not');
    await b.eval('document.querySelector(".sign-item").focus()');
    await b.eval('T.key(".sign-item","Delete")');
    ok((await b.eval('InvoiceSign._state.doc.items.length')) === 0 && (await b.eval('document.querySelectorAll(".sign-item").length')) === 0, 'Delete removes it');
    await b.click('#sign-add-signature');
    await b.eval('document.querySelector(".sign-remove").click()');
    ok((await b.eval('InvoiceSign._state.doc.items.length')) === 0, 'and so does its remove button');
    ok((await b.eval('document.querySelector("#sign-download").disabled')) === true, 'with nothing left to download');
    await b.click('#sign-add-signature');
    await b.eval('T.drag(".sign-item .sign-grip", 5000, 0)');
    const grown = await b.eval('T.rect(".sign-item")');
    const sheet = await b.eval('T.rect(".sign-page")');
    ok(grown.x + grown.w <= sheet.x + sheet.w + 1 && grown.y + grown.h <= sheet.y + sheet.h + 1, 'pulled far past the edge it grows only as far as the page', [grown, sheet]);
    await b.eval('T.drag(".sign-item .sign-grip", -5000, 0)');
    ok(near((await b.eval('T.item(0).fw')) * 595, 28, 0.5), 'and shrinks no smaller than a centimetre', (await b.eval('T.item(0).fw')) * 595);
    for (let i = 0; i < 13; i++) await b.click('#sign-add-signature');
    const piled = await b.eval('(function(){var s=InvoiceSign._state.doc.items,hit=0;for(var i=0;i<s.length;i++)for(var j=i+1;j<s.length;j++){var a=s[i],c=s[j];if(a.page===c.page&&a.fx<c.fx+c.fw&&c.fx<a.fx+a.fw&&a.fy<c.fy+c.fh&&c.fy<a.fy+a.fh)hit++;}return {n:s.length,hit:hit}})()');
    ok(piled.n === 14 && piled.hit === 0, 'fourteen added in a row: none on top of another', piled);

    console.log('8c. a thing held while the page scrolls stays under the pointer');
    await b.eval('window.scrollTo(0, 0)');
    await b.eval('(function(){var el=document.querySelector(".sign-item");var r=el.getBoundingClientRect();window.__hold={x:r.left+r.width/2,y:r.top+r.height/2};el.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,cancelable:true,pointerId:5,pointerType:"mouse",button:0,buttons:1,clientX:__hold.x,clientY:__hold.y}));window.scrollBy(0,180);})()');
    await b.wait(250);
    const held = await b.eval('(function(){var el=document.querySelector(".sign-item");var r=el.getBoundingClientRect();var out={dx:r.left+r.width/2-__hold.x,dy:r.top+r.height/2-__hold.y,scrolled:window.scrollY};el.dispatchEvent(new PointerEvent("pointerup",{bubbles:true,pointerId:5,pointerType:"mouse",clientX:__hold.x,clientY:__hold.y}));return out})()');
    ok(held.scrolled > 100 && near(held.dx, 0, 1.5) && near(held.dy, 0, 1.5), 'after the page scrolled 180 it is still under the pointer', held);

    console.log('8d. leaving a document with things on it asks first');
    await b.click('#sign-close');
    ok(/Leave without downloading/.test(await b.text('#sign-close-slot')) && (await b.eval(pagesShown)) === 2, 'a question, and the document is still there', await b.text('#sign-close-slot'));
    await b.click('#sign-close-no');
    ok((await b.eval('InvoiceSign._state.doc.items.length')) === 14 && (await b.eval('!!document.querySelector("#sign-close")')) === true, 'Stay keeps everything');
    await b.click('#sign-close');
    await b.click('#sign-close-yes');
    ok((await b.eval('!!document.querySelector("#sign-drop")')) === true && (await b.eval('document.activeElement && document.activeElement.id')) === 'sign-file', 'Leave it goes back to choosing a file');

    console.log('8e. a photo of a signature on paper becomes ink; a see-through picture stays one');
    await b.eval('T.openPdf([[595, 842, 0]], "ink.pdf")');
    await b.waitFor(pagesShown + ' === 1 && document.querySelector("#sign-name").textContent === "ink.pdf"', 20000);
    const before = await b.eval('InvoiceSign._state.signature.src.length');
    await b.eval('T.scribble(900, 400, "#f6f3ea").then(function(blob){return T.givePicture(blob, "photo-of-signature.png")})');
    await b.waitFor('InvoiceSign._state.signature.src.length !== ' + before, 10000);
    const photo = await b.eval('T.alphaOf(InvoiceSign._state.signature.src)');
    ok(photo.type === 'data:image/png;' && photo.corner === 0 && photo.clear > photo.solid && photo.solid > 300, 'the paper is see-through and the ink is solid', photo);
    await b.click('#sign-add-signature');
    await b.eval('(function(){var it=InvoiceSign._state.doc.items[0];it.fx=0.05;it.fy=0.045;})()');
    const overText = await b.eval('(async function(){var box=T.item(0);var was=await T.redIn(InvoiceSign._state.doc.bytes,box);var bytes=await InvoiceSign._signedCopy();return {was:was,now:await T.redIn(bytes,box),ink:(await T.inkBox(bytes,1)).ink}})()');
    ok(overText.was > 200 && overText.now > overText.was * 0.75 && overText.ink > 200, 'placed over a line of the document, it leaves the line readable', overText);
    await b.eval('(async function(){var c=document.createElement("canvas");c.width=1200;c.height=680;var x=c.getContext("2d");for(var i=0;i<9000;i++){x.fillStyle="rgba("+(i%50)+",20,"+(60+i%90)+","+(0.25+(i%7)/12)+")";x.beginPath();x.arc(60+(i*37)%1080,60+(i*91)%560,3+(i%5),0,7);x.fill();}var blob=await new Promise(function(r){c.toBlob(r,"image/png")});window.__big=blob.size;return T.givePicture(blob,"soft.png")})()');
    await b.waitFor('InvoiceSign._state.signature.w < 600 || /^data:image\\/jpeg/.test(InvoiceSign._state.signature.src)', 15000).catch(function () {});
    const soft = await b.eval('T.alphaOf(InvoiceSign._state.signature.src).then(function(a){a.len=InvoiceSign._state.signature.src.length;a.big=__big;return a})');
    ok(soft.big > 200000 && soft.type === 'data:image/png;' && soft.clear > 1000 && soft.len <= 90000, 'a large see-through picture is made smaller, not flattened onto white', soft);
    await b.eval('T.leave()');
    await b.wait(150);

    console.log('8f. a digitally signed PDF says what adding to it does; one with no pages is refused');
    await b.eval('T.signedPdf().then(function(bytes){T.give(bytes,"signed-already.pdf","application/pdf")})');
    await b.waitFor('document.querySelector("#sign-name") && document.querySelector("#sign-name").textContent === "signed-already.pdf"', 20000);
    ok(/carries a digital signature/.test(await b.text('#sign-digital')), 'the warning is shown', await b.eval('(document.querySelector("#sign-digital")||{}).textContent'));
    await b.eval('T.leave()');
    await b.wait(150);
    await b.eval('T.noPages().then(function(bytes){T.give(bytes,"nothing.pdf","application/pdf")})');
    await b.waitFor('document.querySelector("#sign-problem")', 20000);
    ok(/no pages|damaged|unusual/.test(await b.text('#sign-problem')) && (await b.eval('!!document.querySelector("#sign-bar")')) === false, 'no empty screen with dead buttons', await b.text('#sign-problem'));
    ok((await b.eval('document.activeElement && document.activeElement.id')) === 'sign-file', 'and the keyboard is on the file field');
    await b.eval('T.openPdf([[595, 842, 0]], "before-turned.pdf")');
    await b.waitFor(pagesShown + ' === 1 && document.querySelector("#sign-name").textContent === "before-turned.pdf"', 20000);

    console.log('8g. a file that finishes opening after the person moved on does not take over their screen');
    await b.eval('(async function(){var bytes=await T.makePdf([[595,842,0],[595,842,0],[595,842,0]]);T.leave();T.give(bytes,"late.pdf","application/pdf");location.hash="#companies";})()');
    await b.wait(1800);
    ok((await b.text('#view h1')) !== 'Sign a document' && (await b.eval('document.querySelector("#tab-companies").getAttribute("aria-current")')) === 'page', 'the Companies screen stays the Companies screen', await b.text('#view h1'));
    await b.eval('location.hash="#sign"');
    await b.waitFor(pagesShown + ' === 3', 20000);
    ok((await b.text('#sign-name')) === 'late.pdf', 'and the document is there on coming back');

    console.log('9. pages that are turned in the file: the signature stands upright where it was put');
    for (const turn of [90, 180, 270]) {
      await b.eval('T.leave()');
    await b.wait(150);
      await b.eval('T.openPdf([[400, 600, ' + turn + ']], "turned' + turn + '.pdf")');
      await b.waitFor(pagesShown + ' === 1 && document.querySelector("#sign-name").textContent === "turned' + turn + '.pdf"', 20000);
      await b.waitFor(painted, 20000);
      await b.click('#sign-add-signature');
      await b.eval('(function(){var it=InvoiceSign._state.doc.items[0];it.fx=0.12;it.fy=0.62;})()');
      const want = await b.eval('T.item(0)');
      const got = await b.eval('InvoiceSign._signedCopy().then(function(bytes){return T.inkBox(bytes,1)})');
      const shown = turn === 180 ? [400, 600] : [600, 400];
      ok(near(got.w, shown[0], 1) && near(got.h, shown[1], 1), 'turned ' + turn + ': the page is shown ' + shown[0] + ' by ' + shown[1], [got.w, got.h]);
      ok(got.ink > 200 && got.left >= want.fx - 0.006 && got.right <= want.fx + want.fw + 0.006 && got.top >= want.fy - 0.006 && got.bottom <= want.fy + want.fh + 0.006,
        'turned ' + turn + ': the ink is inside the box it was placed in', { box: want, ink: got });
      ok(got.right - got.left > got.bottom - got.top, 'turned ' + turn + ': and lies along the reading direction, not on its side', [got.right - got.left, got.bottom - got.top]);
    }
    await b.screenshot(path.join(OUT, 'signdoc-2-turned.png'));

    console.log('10. a photo of a page becomes a page');
    await b.eval('T.leave()');
    await b.wait(150);
    await b.eval('(async function(){var c=document.createElement("canvas");c.width=900;c.height=1200;var x=c.getContext("2d");x.fillStyle="#f4f1e8";x.fillRect(0,0,900,1200);x.fillStyle="#c00";x.font="40px sans-serif";x.fillText("A photographed page",80,160);var blob=await new Promise(function(r){c.toBlob(r,"image/png")});T.give(blob,"photo.png","image/png");})()');
    await b.waitFor(pagesShown + ' === 1 && document.querySelector("#sign-name").textContent === "photo.pdf"', 20000);
    await b.waitFor(painted, 20000);
    const shape = await b.eval('T.rect(".sign-page")');
    ok(near(shape.w / shape.h, 0.75, 0.01), 'with the picture’s own shape', shape.w / shape.h);
    const wide = await b.eval('(async function(){T.leave();var blob=await T.scribble(1600,800,null);T.give(blob,"wide.png","image/png");return 1})()');
    await b.waitFor(pagesShown + ' === 1 && document.querySelector("#sign-name").textContent === "wide.pdf"', 20000);
    await b.waitFor(painted, 20000);
    const wideDoc = await b.eval('(function(){var p=InvoiceSign._state.doc.pages[0];var c=document.querySelector("#sign-doc .sign-page canvas");var d=c.getContext("2d").getImageData(2,2,1,1).data;return {w:p.w,h:p.h,corner:[d[0],d[1],d[2]]}})()');
    ok(near(wideDoc.w, 841.89, 0.1) && near(wideDoc.h, 420.945, 0.1), 'a picture lying on its side gets a page as wide as A4 is long', wideDoc);
    ok(wideDoc.corner[0] > 240 && wideDoc.corner[1] > 240 && wideDoc.corner[2] > 240, 'and a see-through picture is a page on white paper, not on black', wideDoc.corner);
    await b.click('#sign-add-signature');
    const photoOut = await b.eval('InvoiceSign._signedCopy().then(function(bytes){return T.inkBox(bytes,1)})');
    ok(photoOut.pages === 1 && photoOut.ink > 200, 'and it can be signed like any other', photoOut);

    console.log('11. what cannot be signed says why');
    await b.eval('T.leave()');
    await b.wait(150);
    await b.eval('T.give(new Uint8Array([80,75,3,4,1,2,3]), "smlouva.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")');
    await b.waitFor('document.querySelector("#sign-problem")', 10000);
    ok(/save or export it as PDF/.test(await b.text('#sign-problem')), 'a Word file: save it as PDF first', await b.text('#sign-problem'));
    await b.eval('(async function(){var bytes=await T.makePdf([[300,300,0]]);var s="";for(var i=0;i<bytes.length;i++)s+=String.fromCharCode(bytes[i]);var at=s.lastIndexOf("trailer");s=s.slice(0,at)+s.slice(at).replace("<<","<< /Encrypt 1 0 R ");var out=new Uint8Array(s.length);for(var k=0;k<s.length;k++)out[k]=s.charCodeAt(k);T.give(out,"locked.pdf","application/pdf");})()');
    await b.waitFor('/protected/.test((document.querySelector("#sign-problem")||{}).textContent||"")', 10000);
    ok(/protected against changes/.test(await b.text('#sign-problem')), 'a protected PDF: nothing can be added', await b.text('#sign-problem'));
    await b.eval('T.give(new Uint8Array(0), "empty.pdf", "application/pdf")');
    await b.waitFor('/empty/.test((document.querySelector("#sign-problem")||{}).textContent||"")', 10000);
    ok(/The file is empty/.test(await b.text('#sign-problem')), 'an empty file: said so');
    ok((await b.eval('!!document.querySelector("#sign-file")')) === true, 'and another file can be chosen straight away');

    console.log('12. the work survives a look at another tab, and a narrow screen');
    await b.eval('T.openPdf([[595, 842, 0]], "back.pdf")');
    await b.waitFor(pagesShown + ' === 1 && document.querySelector("#sign-name").textContent === "back.pdf"', 20000);
    await b.click('#sign-add-signature');
    await b.goto(URL + '#sign', 1800);
    ok((await b.eval('!!document.querySelector("#sign-drop")')) === true && (await b.eval(pagesShown)) === 0, 'a reload starts afresh: the document was never stored anywhere');
    await b.eval(PAGE);
    await b.eval('T.openPdf([[595, 842, 0]], "tabs.pdf")');
    await b.waitFor(pagesShown + ' === 1', 20000);
    ok((await b.eval('!!document.querySelector("#sign-signature .thumb img")')) === true, 'the signature drawn earlier is offered again after a reload');
    await b.click('#sign-add-signature');
    await b.eval('location.hash="#companies"');
    await b.wait(500);
    await b.eval('location.hash="#sign"');
    await b.wait(700);
    ok((await b.eval('document.querySelectorAll(".sign-item").length')) === 1 && (await b.text('#sign-name')) === 'tabs.pdf', 'switching tabs and back keeps the document and what is on it');
    await b.setViewport(390, 800, true);
    await b.wait(900);
    ok((await b.eval('document.documentElement.scrollWidth<=innerWidth')) === true, 'no sideways scroll on a phone');
    const narrow = await b.eval('T.rect(".sign-page")');
    ok(narrow.w <= 390 && narrow.w > 300, 'the page fits the screen', narrow.w);
    const bar = await b.eval('T.rect(".sign-tools")');
    ok(bar.h <= 112, 'the tools are two rows at most on a phone', bar.h);
    ok((await b.eval('getComputedStyle(document.querySelector("#sign-download .short")).display')) !== 'none' && (await b.eval('document.querySelector("#sign-download").getAttribute("aria-label")')) === 'Download signed PDF', 'with Download in short, and in full for a screen reader');
    const t0 = await b.eval('T.rect(".sign-item")');
    await b.eval('T.drag(".sign-item img", 30, 40, "touch")');
    const t1 = await b.eval('T.rect(".sign-item")');
    ok(near(t1.x - t0.x, 30, 1.5) && near(t1.y - t0.y, 40, 1.5), 'a finger drags it as a mouse does', [t1.x - t0.x, t1.y - t0.y]);
    ok((await b.eval('getComputedStyle(document.querySelector(".sign-item")).touchAction')) === 'none', 'without scrolling the page under it');
    await b.screenshot(path.join(OUT, 'signdoc-3-phone.png'));

    console.log('13. no script errors');
    ok(b.errors.length === 0, 'no exceptions or console errors', b.errors);
  } catch (e) {
    failures++;
    console.log('  FAIL the run stopped: ' + (e && e.stack || e));
    try { await b.screenshot(path.join(OUT, 'signdoc-crash.png')); } catch (ignored) { /* nothing to show */ }
  } finally {
    await b.close();
  }
  console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})();
