/*
 * InvoiceRender: view model -> A4 page layout -> SVG preview and PDF.
 * Browser: window.InvoiceRender. Node: module.exports (layout works there with approximate text widths).
 *
 * One layout, two painters. layout() decides every position and every line break once and returns a display
 * list in millimetres; svg() and pdf() only paint it. Text ops are always start-anchored (the layout has
 * already worked out where each string begins), so the two painters cannot disagree about alignment.
 *
 * Ops (all in mm, y of text is the baseline):
 *   { t:'text',  x, y, s, pt, wt (400|600), c }
 *   { t:'rect',  x, y, w, h, r, fill|null, stroke|null, sw }
 *   { t:'line',  x1, y1, x2, y2, c, w }
 *   { t:'image', x, y, w, h, src }
 *   { t:'qr',    x, y, size, n, rows:[ '0101...' ], c }
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.InvoiceRender = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var FAMILY = 'InvMontserrat';
  var MM_PT = 25.4 / 72;

  var PAGE_W = 210, PAGE_H = 297;
  var MX = 14;                       // side margin
  var MT = 14;                       // top margin
  var CW = PAGE_W - 2 * MX;          // content width, 182
  var BODY_BOTTOM = 275;             // nothing but the footer goes below this
  var FOOT_RULE = 280;
  var FOOT_BASE = 284.5;
  var NOTE_INDENT = 3.6;
  var RUN_H = 11;                    // running header of the pages after the first

  var INK = '#16181d', MUTED = '#5a6372', HAIR = '#d8dce3', FAINT = '#9aa3b2', WHITE = '#ffffff';

  // ------------------------------------------------------------ colours

  function hexToRgb(h) {
    var m = /^#?([0-9a-f]{6})$/i.exec(h || '');
    if (!m) return [29, 78, 137];
    var n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbToHex(c) {
    return '#' + c.map(function (v) { v = Math.max(0, Math.min(255, Math.round(v))); return (v < 16 ? '0' : '') + v.toString(16); }).join('');
  }
  /** t of `other` mixed into `hex`. */
  function mix(hex, other, t) {
    var a = hexToRgb(hex), b = hexToRgb(other);
    return rgbToHex([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
  }
  function lum(hex) {
    var c = hexToRgb(hex).map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrast(a, b) {
    var l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  /** The accent darkened until it reads as text on white. */
  function textAccent(hex) {
    var c = hex, n = 0;
    while (contrast(c, WHITE) < 4.5 && n++ < 20) c = mix(c, '#000000', 0.1);
    return c;
  }
  /** White or ink, whichever reads better on `hex`. */
  function onColor(hex) { return contrast(hex, WHITE) >= contrast(hex, INK) ? WHITE : INK; }

  // ---------------------------------------------------------- measuring

  var ctx2d = null, ctxTried = false, widthCache = {}, ctxFont = '';

  function getCtx() {
    if (ctx2d || ctxTried) return ctx2d;
    ctxTried = true;
    try {
      if (typeof document !== 'undefined') {
        ctx2d = document.createElement('canvas').getContext('2d');
        ctx2d.fontKerning = 'none';
        try { ctx2d.letterSpacing = '0.01px'; } catch (e) { /* older engines */ }
        try { ctx2d.textRendering = 'geometricPrecision'; } catch (e2) { /* older engines */ }
      }
    } catch (e3) { ctx2d = null; }
    return ctx2d;
  }

  /** Strings are drawn with U+00A0 and its thin relatives as an ordinary space. */
  function clean(s) { return String(s == null ? '' : s).replace(/[   ]/g, ' '); }

  function approxAdvance(str) {
    var w = 0;
    for (var i = 0; i < str.length; i++) {
      var ch = str.charAt(i);
      if (ch === ' ') w += 0.28;
      else if (/[0-9]/.test(ch)) w += 0.66;
      else if (/[A-ZÀ-ÞĀ-Ž]/.test(ch)) w += 0.74;
      else if (/[ilj.,:;|'!]/.test(ch)) w += 0.3;
      else if (/[mwMW]/.test(ch)) w += 0.9;
      else w += 0.6;
    }
    return w;
  }

  /** Advance of a string in em, kerning off. */
  function adv(str, wt) {
    var key = wt + '|' + str;
    var hit = widthCache[key];
    if (hit !== undefined) return hit;
    var c = getCtx(), w;
    if (c) {
      var f = wt + ' 100px "' + FAMILY + '", sans-serif';
      if (f !== ctxFont) { c.font = f; ctxFont = f; }
      w = c.measureText(str).width / 100;
    } else {
      w = approxAdvance(str);
    }
    widthCache[key] = w;
    return w;
  }

  function textW(s, pt, wt) { return adv(clean(s), wt) * pt * MM_PT; }

  function breakWord(word, maxW, pt, wt) {
    var parts = [], cur = '';
    var chars = Array.from(word);
    for (var i = 0; i < chars.length; i++) {
      if (cur && textW(cur + chars[i], pt, wt) > maxW) { parts.push(cur); cur = chars[i]; }
      else cur += chars[i];
    }
    parts.push(cur);
    return parts;
  }

  /** Lines of `text` that fit maxW; \n is a line break; a word wider than maxW is cut by character. */
  function wrap(text, maxW, pt, wt) {
    var out = [];
    String(text == null ? '' : text).split(/\r\n|\r|\n/).forEach(function (par) {
      var words = par.replace(/\t/g, ' ').split(' ').filter(Boolean);
      if (!words.length) { out.push(''); return; }
      var line = '';
      words.forEach(function (w) {
        var cand = line ? line + ' ' + w : w;
        if (textW(cand, pt, wt) <= maxW) { line = cand; return; }
        if (line) { out.push(line); line = ''; }
        if (textW(w, pt, wt) <= maxW) { line = w; return; }
        var parts = breakWord(w, maxW, pt, wt);
        for (var i = 0; i < parts.length - 1; i++) out.push(parts[i]);
        line = parts[parts.length - 1];
      });
      out.push(line);
    });
    while (out.length > 1 && out[out.length - 1] === '') out.pop();
    return out;
  }

  function ellipsize(s, maxW, pt, wt) {
    if (textW(s, pt, wt) <= maxW) return s;
    var chars = Array.from(s);
    while (chars.length > 1 && textW(chars.join('') + '…', pt, wt) > maxW) chars.pop();
    return chars.join('').replace(/\s+$/, '') + '…';
  }

  // ---------------------------------------------------------------- ops

  function lineBase(top, lh, pt) { return top + lh / 2 + 0.35 * pt * MM_PT; }
  function lhOf(pt, k) { return pt * MM_PT * (k || 1.4); }

  function T(x, y, s, pt, wt, c) { return { t: 'text', x: x, y: y, s: clean(s), pt: pt, wt: wt, c: c }; }
  function R(x, y, w, h, o) {
    o = o || {};
    return { t: 'rect', x: x, y: y, w: w, h: h, r: o.r || 0, fill: o.fill || null, stroke: o.stroke || null, sw: o.sw || 0.2 };
  }
  function L(x1, y1, x2, y2, c, w) { return { t: 'line', x1: x1, y1: y1, x2: x2, y2: y2, c: c, w: w || 0.2 }; }

  function shift(ops, dx, dy) {
    return ops.map(function (o) {
      var n = {};
      for (var k in o) n[k] = o[k];
      if (n.t === 'line') { n.x1 += dx; n.x2 += dx; n.y1 += dy; n.y2 += dy; }
      else { n.x += dx; n.y += dy; }
      return n;
    });
  }

  /** Draws wrapped lines top-down; returns the height used. */
  function textLines(ops, lines, x, top, pt, wt, c, lh) {
    for (var i = 0; i < lines.length; i++) {
      if (lines[i] !== '') ops.push(T(x, lineBase(top + i * lh, lh, pt), lines[i], pt, wt, c));
    }
    return lines.length * lh;
  }

  function makeQr(text) {
    var f = root && root.qrcode;
    if (typeof f !== 'function') return null;
    try {
      var q = f(0, 'M');
      q.addData(String(text), 'Byte');
      q.make();
      var n = q.getModuleCount(), rows = [];
      for (var r = 0; r < n; r++) {
        var s = '';
        for (var c = 0; c < n; c++) s += q.isDark(r, c) ? '1' : '0';
        rows.push(s);
      }
      return { n: n, rows: rows };
    } catch (e) { return null; }
  }

  // ---------------------------------------------------------- the style

  function makeStyle(vm) {
    var tpl = vm.style && vm.style.template === 'simple' ? 'simple' : 'modern';
    var accent = vm.style && /^#[0-9a-f]{6}$/i.test(vm.style.color || '') ? vm.style.color : '#1d4e89';
    return {
      tpl: tpl, modern: tpl === 'modern', accent: accent,
      ink: textAccent(accent),           // the accent as text
      onAccent: onColor(accent),
      tint: mix(accent, WHITE, 0.93),    // card fill
      tintHead: mix(accent, WHITE, 0.86) // summary head
    };
  }

  // -------------------------------------------------------------- header

  function headerBlock(vm, st) {
    var ops = [];
    var h = vm.header || {};
    var logo = h.logo && h.logo.src && h.logo.w > 0 && h.logo.h > 0 ? h.logo : null;
    var lw = 0, lh = 0;
    if (logo) {
      var k = Math.min(60 / logo.w, 24 / logo.h);
      lw = logo.w * k; lh = logo.h * k;
      ops.push({ t: 'image', x: CW - lw, y: 0, w: lw, h: lh, src: logo.src });
    }
    var titleW = CW - (logo ? lw + 8 : 0);
    var title = h.title || '';
    var pt = 18;
    while (pt > 12 && textW(title, pt, 600) > titleW) pt -= 0.5;
    var lines = wrap(title, titleW, pt, 600);
    var y = textLines(ops, lines, 0, 0, pt, 600, st.ink, lhOf(pt, 1.25));
    if (h.number) {
      y += 1.2;
      y += textLines(ops, wrap(h.number, titleW, 11, 600), 0, y, 11, 600, INK, lhOf(11, 1.3));
    }
    (h.sub || []).forEach(function (s, i) {
      if (i === 0) y += 0.8;
      y += textLines(ops, wrap(s, titleW, 8.5, 400), 0, y, 8.5, 400, MUTED, lhOf(8.5, 1.45));
    });
    return { ops: ops, h: Math.max(y, lh) };
  }

  // ------------------------------------------------------------- parties

  function pillRow(items, x0, top, maxW, st) {
    var ops = [], x = 0, y = 0, ph = 4.6, gap = 1.8;
    items.forEach(function (s) {
      var w = textW(s, 7.5, 600) + 4.4;
      if (x > 0 && x + w > maxW) { x = 0; y += ph + 1.4; }
      var o = st.modern ? { r: ph / 2, fill: mix(st.accent, WHITE, 0.85) } : { r: ph / 2, stroke: HAIR, sw: 0.25 };
      ops.push(R(x0 + x, top + y, w, ph, o));
      ops.push(T(x0 + x + 2.2, lineBase(top + y, ph, 7.5), s, 7.5, 600, st.modern ? st.ink : MUTED));
      x += w + gap;
    });
    return { ops: ops, h: y + ph };
  }

  function partyBlock(p, w, st) {
    var ops = [];
    var pad = st.modern ? 4.2 : 0;
    var inner = w - 2 * pad;
    var y = st.modern ? 3.8 : 3.4;
    if (!st.modern) ops.push(L(0, 0, w, 0, HAIR, 0.25));
    ops.push(T(pad, lineBase(y, 3.6, 7.5), p.heading || '', 7.5, 600, st.modern ? st.ink : MUTED));
    y += 3.6 + 1.6;

    var address = (p.address || []).slice(), ids = p.ids || [], badges = (p.badges || []).filter(Boolean);
    var extra = p.extra || [], contacts = p.contacts || [];
    // a party whose only line is the country the core defaults to is an empty party
    var any = p.name || address.length > 1 || ids.length || extra.length || contacts.length || badges.length;
    if (!any && address.length === 1 && !/\d/.test(address[0])) { address = []; }
    any = any || address.length;
    if (p.name) {
      y += textLines(ops, wrap(p.name, inner, 10.5, 600), pad, y, 10.5, 600, INK, lhOf(10.5, 1.32));
      y += 0.5;
    } else if (!any) {
      ops.push(T(pad, lineBase(y, 5, 10.5), '—', 10.5, 400, FAINT));
      y += 5;
    }
    address.forEach(function (a) { y += textLines(ops, wrap(a, inner, 9, 400), pad, y, 9, 400, INK, lhOf(9, 1.42)); });
    if (ids.length) {
      y += 1.6;
      var idLh = lhOf(8.5, 1.45), idGap = 5, ix = 0, rowOpen = false;
      ids.forEach(function (id) {
        var lab = id.label || '', val = id.value || '';
        var lw = lab ? textW(lab, 8, 400) + 1.8 : 0;
        var sw = lw + textW(val, 8.5, 600);
        if (sw > inner) {
          if (rowOpen) { y += idLh; ix = 0; rowOpen = false; }
          y += textLines(ops, wrap((lab ? lab + ' ' : '') + val, inner, 8.5, 400), pad, y, 8.5, 400, INK, idLh);
          return;
        }
        if (rowOpen && ix + sw > inner) { y += idLh; ix = 0; }
        if (lab) ops.push(T(pad + ix, lineBase(y, idLh, 8), lab, 8, 400, MUTED));
        ops.push(T(pad + ix + lw, lineBase(y, idLh, 8.5), val, 8.5, 600, INK));
        ix += sw + idGap; rowOpen = true;
      });
      if (rowOpen) y += idLh;
    }
    if (badges.length) {
      y += 2.4;
      var pr = pillRow(badges, pad, y, inner, st);
      ops = ops.concat(pr.ops);
      y += pr.h;
    }
    extra.forEach(function (e, i) {
      y += i === 0 ? 2.2 : 0.6;
      y += textLines(ops, wrap(e, inner, 8, 400), pad, y, 8, 400, MUTED, lhOf(8, 1.45));
    });
    if (contacts.length) {
      y += 2.2;
      var cLh = lhOf(8.5, 1.5), cx = 0, cOpen = false;
      contacts.forEach(function (c) {
        var cw = textW(c, 8.5, 400);
        if (cw > inner) {
          if (cOpen) { y += cLh; cx = 0; cOpen = false; }
          y += textLines(ops, wrap(c, inner, 8.5, 400), pad, y, 8.5, 400, MUTED, cLh);
          return;
        }
        if (cOpen && cx + cw > inner) { y += cLh; cx = 0; }
        ops.push(T(pad + cx, lineBase(y, cLh, 8.5), c, 8.5, 400, MUTED));
        cx += cw + 5; cOpen = true;
      });
      if (cOpen) y += cLh;
    }
    return { ops: ops, h: y + (st.modern ? 4.2 : 0.5) };
  }

  // --------------------------------------------------------- payment band

  function sectionRule(ops, x, w, st) {
    ops.push(L(x, 0, x + w, 0, HAIR, 0.25));
    if (st.modern) ops.push(L(x, 0, x + 14, 0, st.accent, 0.7));
  }

  function paymentBlock(pay, w, st) {
    var ops = [];
    sectionRule(ops, 0, w, st);
    ops.push(T(0, lineBase(2.6, 3.6, 7.5), pay.heading || '', 7.5, 600, st.modern ? st.ink : MUTED));
    var y = 8.4;
    var rows = pay.rows || [];
    var labelW = 0;
    rows.forEach(function (r) { labelW = Math.max(labelW, textW(r.label || '', 8, 400)); });
    labelW = Math.min(36, labelW + 3);
    var valW = w - labelW;
    rows.forEach(function (r, i) {
      var vl = wrap(r.value || '', valW, 9, i === 0 ? 600 : 400);
      var ll = wrap(r.label || '', labelW - 2, 8, 400);
      var vh = lhOf(9, 1.42), lh = lhOf(8, 1.5);
      textLines(ops, ll, 0, y, 8, 400, MUTED, vh > lh ? vh : lh);
      textLines(ops, vl, labelW, y, 9, i === 0 ? 600 : 400, INK, vh);
      y += Math.max(vl.length * vh, ll.length * (vh > lh ? vh : lh)) + 1.3;
    });
    return { ops: ops, h: y };
  }

  function datesBlock(rows, w, cols, topPad, st, withRule, ruleX) {
    var ops = [];
    var gap = 4;
    var colW = (w - (cols - 1) * gap) / cols;
    var y = topPad;
    for (var i = 0; i < rows.length; i += cols) {
      var rowH = 0, parts = [];
      for (var c = 0; c < cols && i + c < rows.length; c++) {
        var d = rows[i + c];
        var ll = wrap(d.label || '', colW, 7.5, 400), vl = wrap(d.value || '', colW, 9.5, 600);
        var lh = lhOf(7.5, 1.5), vh = lhOf(9.5, 1.4);
        parts.push({ x: c * (colW + gap), ll: ll, vl: vl, lh: lh, vh: vh });
        rowH = Math.max(rowH, ll.length * lh + vl.length * vh);
      }
      parts.forEach(function (p) {
        var yy = y;
        yy += textLines(ops, p.ll, p.x, yy, 7.5, 400, MUTED, p.lh);
        textLines(ops, p.vl, p.x, yy, 9.5, 600, INK, p.vh);
      });
      y += rowH + 2.6;
    }
    return { ops: ops, h: y - 2.6 };
  }

  function bandBlock(vm, st, qrData) {
    var ops = [];
    var colW = (CW - 8) / 2, rightX = colW + 8;
    var pay = vm.payment ? paymentBlock(vm.payment, colW, st) : null;
    var dates = vm.dates || [];
    var h = 0;
    if (pay) {
      ops = ops.concat(pay.ops);
      h = pay.h;
      var qrZone = qrData ? 30 + 6 : 0;
      var dw = colW - qrZone;
      var cols = qrData ? 1 : (dw >= 80 && dates.length > 2 ? 2 : 1);
      var rule = [];
      sectionRule(rule, rightX, colW, st);
      ops = ops.concat(rule);
      if (dates.length) {
        var db = datesBlock(dates, dw, cols, 3.4, st);
        ops = ops.concat(shift(db.ops, rightX, 0));
        h = Math.max(h, db.h);
      }
      if (qrData) {
        var qx = CW - 30, qy = 3.4;
        ops.push({ t: 'qr', x: qx, y: qy, size: 30, n: qrData.n, rows: qrData.rows, c: '#000000' });
        var cap = vm.qr && vm.qr.caption ? vm.qr.caption : '';
        var capEnd = qy + 30;
        if (cap) {
          // at most two lines, centred under the code, never wider than the code's own zone and never past the margin
          var capW = 34, capPt = 7.5, capLh = lhOf(7.5, 1.3);
          var cl = wrap(cap, capW, capPt, 400);
          if (cl.length > 2) { cl = cl.slice(0, 2); cl[1] = ellipsize(cl[1] + ' …', capW, capPt, 400); }
          cl = cl.map(function (t) { return ellipsize(t, capW, capPt, 400); });
          cl.forEach(function (t, i) {
            var tw = textW(t, capPt, 400);
            var cx = Math.min(CW - 15 - tw / 2, CW - tw);
            ops.push(T(cx, lineBase(qy + 30 + 2.2 + i * capLh, capLh, capPt), t, capPt, 400, MUTED));
          });
          capEnd += 2.2 + cl.length * capLh;
        }
        h = Math.max(h, capEnd);
      }
    } else if (dates.length) {
      var cols2 = Math.min(4, dates.length);
      var rule2 = [];
      sectionRule(rule2, 0, CW, st);
      ops = ops.concat(rule2);
      var db2 = datesBlock(dates, CW, cols2, 3.4, st);
      ops = ops.concat(db2.ops);
      h = db2.h;
    }
    return { ops: ops, h: h };
  }

  // --------------------------------------------------------- items table

  /** Column geometry and every row's lines, for one table font size. */
  function tableModel(items, st) {
    var cols = items.columns || [];
    var rows = items.rows || [];
    var model = null;
    var sizes = [8.5, 8, 7.5];
    for (var si = 0; si < sizes.length; si++) {
      var pt = sizes[si];
      var padX = si === sizes.length - 1 ? 1.6 : 2.2;
      var hpt = 7.5;
      var total = CW;
      var widths = {}, used = 0;
      cols.forEach(function (c) {
        if (c.key === 'description') return;
        var cell = 0;
        rows.forEach(function (r) {
          var v = r.cells && r.cells[c.key];
          if (v) cell = Math.max(cell, textW(v, pt, 400));
        });
        var longest = 0;
        String(c.label || '').split(/\s+/).forEach(function (wd) { longest = Math.max(longest, textW(wd, hpt, 600)); });
        widths[c.key] = Math.max(cell, longest) + 2 * padX;
        used += widths[c.key];
      });
      // widen headers to one line while the description keeps plenty of room
      cols.forEach(function (c) {
        if (c.key === 'description') return;
        var full = textW(c.label || '', hpt, 600) + 2 * padX;
        if (full > widths[c.key] && total - used - (full - widths[c.key]) >= 62) {
          used += full - widths[c.key];
          widths[c.key] = full;
        }
      });
      var descW = total - used;
      model = { pt: pt, padX: padX, hpt: hpt, widths: widths, descW: descW };
      if (descW >= 46 || si === sizes.length - 1) break;
    }
    var x = 0;
    model.cols = cols.map(function (c) {
      var w = c.key === 'description' ? Math.max(model.descW, 18) : model.widths[c.key];
      var col = { key: c.key, label: c.label || '', align: c.align === 'right' ? 'right' : 'left', x: x, w: w };
      x += w;
      return col;
    });
    model.width = x;

    // head
    var headLines = 1, hlh = lhOf(model.hpt, 1.35);
    model.cols.forEach(function (c) {
      // the column was sized from this very heading; the hair of slack keeps float rounding from splitting a word
      c.headLines = wrap(c.label, c.w - 2 * model.padX + 0.05, model.hpt, 600);
      headLines = Math.max(headLines, c.headLines.length);
    });
    model.headLh = hlh;
    model.headH = headLines * hlh + 4.4;

    // rows
    var lh = lhOf(model.pt, 1.42);
    var desc = model.cols.filter(function (c) { return c.key === 'description'; })[0];
    var maxLines = Math.max(2, Math.floor((BODY_BOTTOM - (MT + RUN_H) - model.headH - 6) / lh));
    model.rows = [];
    rows.forEach(function (r) {
      var isDisc = r.kind === 'discount';
      var rowPt = isDisc ? model.pt - 0.5 : model.pt;
      var lines = [];
      if (desc) {
        var paras = String((r.cells && r.cells.description) || '').split(/\r\n|\r|\n/);
        if (isDisc) paras = paras.slice(0, 1); // a discount names its item on one paragraph; the item's details are not repeated
        paras.forEach(function (para, pi) {
          var muted = isDisc || pi > 0;
          var ptl = pi > 0 ? model.pt - 0.5 : rowPt;
          wrap(para, desc.w - 2 * model.padX, ptl, 400).forEach(function (s) { lines.push({ s: s, muted: muted, pt: ptl }); });
        });
        while (lines.length > 1 && lines[lines.length - 1].s === '') lines.pop();
      }
      var padTop = isDisc ? 0.8 : 2.2, padBot = isDisc ? 1.8 : 2.2;
      // a row taller than a whole page is the one case where its description has to continue on the next page
      var first = lines.slice(0, maxLines), rest = lines.slice(maxLines);
      model.rows.push({
        kind: isDisc ? 'discount' : 'item', cells: r.cells || {}, lines: first, lh: lh, rowPt: rowPt,
        padTop: padTop, padBot: padBot, h: padTop + Math.max(1, first.length) * lh + padBot, noRule: rest.length > 0
      });
      while (rest.length) {
        var part = rest.slice(0, maxLines);
        rest = rest.slice(maxLines);
        model.rows.push({
          kind: 'item', cells: {}, lines: part, lh: lh, rowPt: rowPt,
          padTop: 0.4, padBot: padBot, h: 0.4 + part.length * lh + padBot, noRule: rest.length > 0
        });
      }
    });
    return model;
  }

  function headOps(model, st) {
    var ops = [];
    var w = model.width;
    if (st.modern) ops.push(R(0, 0, w, model.headH, { r: 1.2, fill: st.accent }));
    else ops.push(L(0, model.headH, w, model.headH, INK, 0.4));
    var col = st.modern ? st.onAccent : INK;
    model.cols.forEach(function (c) {
      var lines = c.headLines;
      var n = lines.length;
      var top = (model.headH - n * model.headLh) / 2;
      lines.forEach(function (s, i) {
        if (!s) return;
        var tw = textW(s, model.hpt, 600);
        var x = c.align === 'right' ? c.x + c.w - model.padX - tw : c.x + model.padX;
        ops.push(T(x, lineBase(top + i * model.headLh, model.headLh, model.hpt), s, model.hpt, 600, col));
      });
    });
    return ops;
  }

  function rowOps(model, row, nextIsDiscount, isLast) {
    var ops = [];
    var base0 = row.padTop;
    model.cols.forEach(function (c) {
      if (c.key === 'description') {
        row.lines.forEach(function (ln, i) {
          if (ln.s !== '') ops.push(T(c.x + model.padX, lineBase(base0 + i * row.lh, row.lh, ln.pt), ln.s, ln.pt, 400, ln.muted ? MUTED : INK));
        });
        return;
      }
      var v = row.cells[c.key];
      if (!v) return;
      var tw = textW(v, row.rowPt, 400);
      var x = c.align === 'right' ? c.x + c.w - model.padX - tw : c.x + model.padX;
      ops.push(T(x, lineBase(base0, row.lh, row.rowPt), v, row.rowPt, 400, row.kind === 'discount' ? MUTED : INK));
    });
    if ((!nextIsDiscount || isLast) && !row.noRule) ops.push(L(0, row.h, model.width, row.h, HAIR, 0.2));
    return ops;
  }

  // ------------------------------------------------------------- totals

  function summaryNatural(vs, st) {
    var cols = vs.columns || [];
    var padX = 2.6, widths = [];
    cols.forEach(function (c) {
      var w = textW(c.label || '', 7.5, 600);
      (vs.rows || []).forEach(function (r) { w = Math.max(w, textW((r.cells || {})[c.key] || '', 8.5, 400)); });
      if (vs.footer) w = Math.max(w, textW((vs.footer.cells || {})[c.key] || '', 8.5, 600));
      widths.push(w + 2 * padX);
    });
    return { widths: widths, padX: padX, total: widths.reduce(function (a, b) { return a + b; }, 0) };
  }

  function summaryBlock(vs, sw, nat, st) {
    var ops = [];
    var cols = vs.columns || [];
    var extra = Math.max(0, sw - nat.total);
    var nNum = cols.filter(function (c) { return c.align === 'right'; }).length || 1;
    var xs = [], ws = [], x = 0;
    cols.forEach(function (c, i) {
      var w = nat.widths[i] + (c.align === 'right' ? extra / nNum : 0);
      ws.push(w); xs.push(x); x += w;
    });
    var headH = 6.6, rowH = 6.2, y = 0;
    if (st.modern) ops.push(R(0, 0, sw, headH, { r: 1.2, fill: st.tintHead }));
    else ops.push(L(0, headH, sw, headH, INK, 0.3));
    function put(c, i, s, pt, wt, col, top, h) {
      var tw = textW(s, pt, wt);
      var px = c.align === 'right' ? xs[i] + ws[i] - nat.padX - tw : xs[i] + nat.padX;
      ops.push(T(px, lineBase(top, h, pt), s, pt, wt, col));
    }
    cols.forEach(function (c, i) { put(c, i, c.label || '', 7.5, 600, st.modern ? st.ink : INK, 0, headH); });
    y = headH;
    (vs.rows || []).forEach(function (r) {
      cols.forEach(function (c, i) { put(c, i, (r.cells || {})[c.key] || '', 8.5, 400, INK, y, rowH); });
      y += rowH;
      ops.push(L(0, y, sw, y, HAIR, 0.2));
    });
    if (vs.footer) {
      cols.forEach(function (c, i) { put(c, i, (vs.footer.cells || {})[c.key] || '', 8.5, 600, INK, y, rowH); });
      y += rowH;
      ops.push(L(0, y, sw, y, st.modern ? st.accent : INK, 0.4));
    }
    return { ops: ops, h: y };
  }

  function totalsSection(vm, st) {
    var ops = [];
    var rows = vm.totals || [];
    var gt = vm.grandTotal || { label: '', value: '' };
    var rowPt = 9, rowH = 6.4, inset = 5;
    var rowsW = 0;
    rows.forEach(function (r) { rowsW = Math.max(rowsW, textW(r.label, rowPt, 400) + textW(r.value, rowPt, 600) + 8 + 2 * inset); });
    var gtPt = 15;
    var gtLabW = textW(gt.label, 9, 600);
    while (gtPt > 11 && gtLabW + textW(gt.value, gtPt, 600) + 2 * inset + 8 > CW) gtPt -= 0.5;
    var boxW = Math.min(CW, Math.max(84, rowsW, gtLabW + textW(gt.value, gtPt, 600) + 2 * inset + 8));
    var vs = vm.vatSummary && vm.vatSummary.rows && vm.vatSummary.rows.length ? vm.vatSummary : null;
    var nat = vs ? summaryNatural(vs, st) : null;
    var side = vs && nat.total <= CW - boxW - 10;
    if (vs && !side) boxW = Math.min(CW, Math.max(nat.total, boxW)); // stacked: one right edge, one width
    var rx = CW - boxW;

    // right column: rows, then the grand total
    var ry = 0;
    var rops = [];
    rows.forEach(function (r, i) {
      rops.push(T(inset, lineBase(ry, rowH, rowPt), r.label, rowPt, 400, MUTED));
      var vw = textW(r.value, rowPt, 600);
      rops.push(T(boxW - inset - vw, lineBase(ry, rowH, rowPt), r.value, rowPt, 600, INK));
      ry += rowH;
      rops.push(L(0, ry, boxW, ry, HAIR, 0.2));
    });
    if (rows.length) ry += 2.6;
    var gh = 13.5;
    var gbase = ry + gh / 2 + 0.35 * gtPt * MM_PT;
    if (st.modern) {
      rops.push(R(0, ry, boxW, gh, { r: 2, fill: st.accent }));
    } else {
      rops.push(L(0, ry, boxW, ry, INK, 0.6));
      rops.push(L(0, ry + gh, boxW, ry + gh, HAIR, 0.25));
    }
    var gcol = st.modern ? st.onAccent : INK;
    rops.push(T(inset, gbase, gt.label, 9, 600, gcol));
    var gvw = textW(gt.value, gtPt, 600);
    rops.push(T(boxW - inset - gvw, gbase, gt.value, gtPt, 600, st.modern ? st.onAccent : st.ink));
    ry += gh;

    var h = ry;
    if (vs) {
      if (side) {
        var sb = summaryBlock(vs, CW - boxW - 10, nat, st);
        ops = ops.concat(sb.ops);
        h = Math.max(h, sb.h);
        ops = ops.concat(shift(rops, rx, 0));
      } else {
        var sw = Math.min(CW, Math.max(nat.total, boxW));
        var sb2 = summaryBlock(vs, sw, nat, st);
        ops = ops.concat(shift(sb2.ops, CW - sw, 0));
        ops = ops.concat(shift(rops, rx, sb2.h + 5));
        h = sb2.h + 5 + ry;
      }
    } else {
      ops = ops.concat(shift(rops, rx, 0));
    }
    return { ops: ops, h: h };
  }

  // -------------------------------------------------------- notes, signature

  function noteItems(notes, w, st) {
    var items = [];
    notes.forEach(function (n, ni) {
      wrap(n, w - NOTE_INDENT, 8.5, 400).forEach(function (s, li) { items.push({ s: s, gap: li === 0 && ni > 0 ? 1.8 : 0 }); });
    });
    return items;
  }

  function notesBlock(items, w, st) {
    var ops = [];
    var indent = NOTE_INDENT, lh = lhOf(8.5, 1.5);
    var y = 0;
    items.forEach(function (it) {
      y += it.gap;
      if (it.s !== '') ops.push(T(indent, lineBase(y, lh, 8.5), it.s, 8.5, 400, INK));
      y += lh;
    });
    ops.push(R(0, 0.4, 0.8, Math.max(0.5, y - 0.8), { fill: st.modern ? st.accent : HAIR }));
    return { ops: ops, h: y };
  }

  function signatureBlock(sig, w, st) {
    var ops = [];
    var stamp = sig && sig.stamp && sig.stamp.src && sig.stamp.w > 0 && sig.stamp.h > 0 ? sig.stamp : null;
    var area = 19;
    if (stamp) {
      var k = Math.min(50 / stamp.w, 28 / stamp.h);
      var sw = stamp.w * k, sh = stamp.h * k;
      area = Math.max(area, sh + 4);
      ops.push({ t: 'image', x: (w - sw) / 2, y: area - sh - 1, w: sw, h: sh, src: stamp.src });
    }
    ops.push(L(0, area, w, area, MUTED, 0.3));
    var label = (sig && sig.label) || '';
    var lw = textW(label, 7.5, 400);
    if (label) ops.push(T((w - lw) / 2, lineBase(area + 1.4, 3.6, 7.5), ellipsize(label, w, 7.5, 400), 7.5, 400, MUTED));
    return { ops: ops, h: area + 1.4 + 3.6 };
  }

  // -------------------------------------------------------------- layout

  function layout(vm) {
    vm = vm || {};
    var st = makeStyle(vm);
    var pages = [];
    var cur = null, y = 0;

    function startPage() {
      cur = { ops: [] };
      pages.push(cur);
      if (st.modern) cur.ops.push(R(0, 0, PAGE_W, 4, { fill: st.accent }));
      y = MT;
      if (pages.length > 1) {
        var title = (vm.meta && vm.meta.title) || '';
        cur.ops.push(T(MX, MT + 3.4, ellipsize(title, CW, 7.5, 400), 7.5, 400, MUTED));
        cur.ops.push(L(MX, MT + 6.4, MX + CW, MT + 6.4, HAIR, 0.25));
        y = MT + RUN_H;
      }
    }
    function put(ops, dy) { cur.ops = cur.ops.concat(shift(ops, MX, dy)); }
    function fits(h) { return y + h <= BODY_BOTTOM + 0.001; }

    startPage();

    // header
    var hb = headerBlock(vm, st);
    put(hb.ops, y);
    y += hb.h;
    if (st.modern) y += 7;
    else { y += 4.5; cur.ops.push(L(MX, y, MX + CW, y, INK, 0.4)); y += 5.5; }

    // parties
    var pw = (CW - 8) / 2;
    var parts = vm.parties || [];
    var pbs = [partyBlock(parts[0] || { heading: '' }, pw, st), partyBlock(parts[1] || { heading: '' }, pw, st)];
    var ph = Math.max(pbs[0].h, pbs[1].h);
    pbs.forEach(function (pb, i) {
      var ox = i * (pw + 8);
      if (st.modern) cur.ops.push(R(MX + ox, y, pw, ph, { r: 1.8, fill: st.tint }));
      cur.ops = cur.ops.concat(shift(pb.ops, MX + ox, y));
    });
    y += ph + 6;

    // payment, dates, QR
    var qrData = vm.qr && vm.qr.text ? makeQr(vm.qr.text) : null;
    var band = bandBlock(vm, st, qrData);
    if (band.ops.length) { put(band.ops, y); y += band.h + 7; }

    // items table
    var model = tableModel(vm.items || { columns: [], rows: [] }, st);
    var headTop;
    function drawHead() { headTop = y; put(headOps(model, st), y); y += model.headH; }
    drawHead();
    if (!model.rows.length) {
      var ph0 = 11;
      var dc = model.cols.filter(function (c) { return c.key === 'description'; })[0];
      if (dc) put([T(dc.x + model.padX, lineBase(0, ph0, model.pt), '—', model.pt, 400, FAINT), L(0, ph0, model.width, ph0, HAIR, 0.2)], y);
      y += ph0;
    }
    var groups = [];
    model.rows.forEach(function (r, i) {
      if (r.kind === 'discount' && groups.length) groups[groups.length - 1].push(i);
      else groups.push([i]);
    });
    groups.forEach(function (g) {
      var gh = g.reduce(function (s, i) { return s + model.rows[i].h; }, 0);
      if (!fits(gh) && y > MT + RUN_H + model.headH + 1) { startPage(); drawHead(); }
      g.forEach(function (i) {
        var r = model.rows[i];
        put(rowOps(model, r, i + 1 < model.rows.length && model.rows[i + 1].kind === 'discount', i + 1 >= model.rows.length), y);
        y += r.h;
      });
    });
    y += 6;

    // closing block: summary and totals, notes, signature
    var A = totalsSection(vm, st);
    var notes = (vm.notes || []).filter(function (n) { return String(n).trim() !== ''; });
    var sigW = 64;
    var sig = signatureBlock(vm.signature, sigW, st);
    var gapAN = 5;
    var narrowItems = notes.length ? noteItems(notes, CW - sigW - 10, st) : [];
    var narrow = notes.length ? notesBlock(narrowItems, CW - sigW - 10, st) : null;
    var side = notes.length > 0 && narrow.h <= 58;
    var fullItems = notes.length && !side ? noteItems(notes, CW, st) : null;
    var N = notes.length ? (side ? narrow : notesBlock(fullItems, CW, st)) : null;
    var lower = N ? (side ? Math.max(N.h, sig.h) : N.h + 7 + sig.h) : sig.h;
    var blockH = A.h + gapAN + lower;
    var fresh = BODY_BOTTOM - (MT + RUN_H);

    function placeLower(top) {
      if (!N) { put(shift(sig.ops, CW - sigW, 0), top); return top + sig.h; }
      if (side) {
        put(N.ops, top);
        put(shift(sig.ops, CW - sigW, 0), top);
        return top + lower;
      }
      put(N.ops, top);
      put(shift(sig.ops, CW - sigW, 0), top + N.h + 7);
      return top + lower;
    }

    if (!fits(blockH) && blockH <= fresh) startPage();
    if (fits(blockH)) {
      put(A.ops, y);
      y += A.h + gapAN;
      y = placeLower(y);
    } else {
      // taller than a page: totals whole, notes line by line, signature whole
      if (!fits(A.h)) startPage();
      put(A.ops, y);
      y += A.h + gapAN;
      var items = noteItems(notes, CW, st);
      var lhn = lhOf(8.5, 1.5);
      while (items.length) {
        var room = BODY_BOTTOM - y, take = 0, used = 0;
        while (take < items.length && used + items[take].gap + lhn <= room) { used += items[take].gap + lhn; take++; }
        if (take === 0) { startPage(); continue; }
        var chunk = items.slice(0, take);
        chunk[0] = { s: chunk[0].s, gap: 0 };
        var nb = notesBlock(chunk, CW, st);
        put(nb.ops, y);
        y += nb.h;
        items = items.slice(take);
        if (items.length) startPage();
      }
      y += 7;
      if (!fits(sig.h)) startPage();
      put(shift(sig.ops, CW - sigW, 0), y);
      y += sig.h;
    }

    // footers
    var total = pages.length;
    var footer = vm.footer || {};
    pages.forEach(function (pg, i) {
      var label = String(footer.pageTemplate || '{page} / {pages}').replace('{page}', String(i + 1)).replace('{pages}', String(total));
      var lw = textW(label, 7.5, 400);
      pg.ops.push(L(MX, FOOT_RULE, MX + CW, FOOT_RULE, HAIR, 0.25));
      if (footer.left) {
        var left = String(footer.left).replace(/\s*[\r\n]+\s*/g, ' ');
        pg.ops.push(T(MX, FOOT_BASE, ellipsize(left, CW - lw - 8, 7.5, 400), 7.5, 400, MUTED));
      }
      pg.ops.push(T(MX + CW - lw, FOOT_BASE, label, 7.5, 400, MUTED));
    });

    return { width: PAGE_W, height: PAGE_H, pages: pages };
  }

  // ---------------------------------------------------------------- SVG

  function n3(v) { return String(Math.round(v * 1000) / 1000); }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** Horizontal runs of dark modules, each slightly overlapped so no seam shows between neighbours. */
  function qrRects(op) {
    var m = op.size / op.n, out = [], ov = 0.015;
    for (var r = 0; r < op.n; r++) {
      var row = op.rows[r], c = 0;
      while (c < op.n) {
        if (row.charAt(c) !== '1') { c++; continue; }
        var s = c;
        while (c < op.n && row.charAt(c) === '1') c++;
        out.push({ x: op.x + s * m, y: op.y + r * m, w: (c - s) * m + ov, h: m + ov });
      }
    }
    return out;
  }

  function svg(lay, pageIndex) {
    var page = lay.pages[pageIndex || 0];
    var out = [];
    out.push('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ' + lay.width + ' ' + lay.height +
      '" preserveAspectRatio="xMidYMid meet" style="display:block;width:100%;height:auto">');
    out.push('<rect x="0" y="0" width="' + lay.width + '" height="' + lay.height + '" fill="#ffffff"/>');
    out.push('<g font-family="' + FAMILY + ', Montserrat, sans-serif" xml:space="preserve" style="font-kerning:none;font-variant-ligatures:none;text-rendering:geometricPrecision">');
    if (page) page.ops.forEach(function (o) {
      if (o.t === 'text') {
        out.push('<text x="' + n3(o.x) + '" y="' + n3(o.y) + '" font-size="' + n3(o.pt * MM_PT) + '" font-weight="' + o.wt + '" fill="' + o.c + '">' + esc(o.s) + '</text>');
      } else if (o.t === 'rect') {
        out.push('<rect x="' + n3(o.x) + '" y="' + n3(o.y) + '" width="' + n3(o.w) + '" height="' + n3(o.h) + '"' + (o.r ? ' rx="' + n3(o.r) + '"' : '') +
          ' fill="' + (o.fill || 'none') + '"' + (o.stroke ? ' stroke="' + o.stroke + '" stroke-width="' + n3(o.sw) + '"' : '') + '/>');
      } else if (o.t === 'line') {
        out.push('<line x1="' + n3(o.x1) + '" y1="' + n3(o.y1) + '" x2="' + n3(o.x2) + '" y2="' + n3(o.y2) + '" stroke="' + o.c + '" stroke-width="' + n3(o.w) + '"/>');
      } else if (o.t === 'image') {
        out.push('<image x="' + n3(o.x) + '" y="' + n3(o.y) + '" width="' + n3(o.w) + '" height="' + n3(o.h) + '" preserveAspectRatio="xMidYMid meet" href="' + esc(o.src) + '" xlink:href="' + esc(o.src) + '"/>');
      } else if (o.t === 'qr') {
        var d = qrRects(o).map(function (r) { return 'M' + n3(r.x) + ' ' + n3(r.y) + 'h' + n3(r.w) + 'v' + n3(r.h) + 'h-' + n3(r.w) + 'z'; }).join('');
        out.push('<path d="' + d + '" fill="' + o.c + '"/>');
      }
    });
    out.push('</g></svg>');
    return out.join('');
  }

  // ----------------------------------------------------------------- PDF

  function pdf(lay, meta) {
    var lib = root && root.jspdf;
    if (!lib || !lib.jsPDF) throw new Error('pdf-unavailable');
    var F = root.InvoiceFonts;
    if (!F) throw new Error('pdf-unavailable');
    meta = meta || {};
    var doc = new lib.jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
    doc.addFileToVFS('Montserrat-Regular.ttf', F.regular);
    doc.addFont('Montserrat-Regular.ttf', FAMILY, 'normal', 'Identity-H');
    doc.addFileToVFS('Montserrat-SemiBold.ttf', F.bold);
    doc.addFont('Montserrat-SemiBold.ttf', FAMILY, 'bold', 'Identity-H');
    doc.setProperties({ title: meta.title || '', author: meta.author || '', creator: 'Invoice' });
    lay.pages.forEach(function (page, pi) {
      if (pi > 0) doc.addPage('a4', 'portrait');
      page.ops.forEach(function (o) {
        if (o.t === 'text') {
          doc.setFont(FAMILY, o.wt >= 600 ? 'bold' : 'normal');
          doc.setFontSize(o.pt);
          doc.setTextColor(o.c);
          doc.text(o.s, o.x, o.y, { baseline: 'alphabetic' });
        } else if (o.t === 'rect') {
          var style = o.fill && o.stroke ? 'FD' : (o.fill ? 'F' : 'S');
          if (o.fill) doc.setFillColor(o.fill);
          if (o.stroke) { doc.setDrawColor(o.stroke); doc.setLineWidth(o.sw); }
          if (o.r) doc.roundedRect(o.x, o.y, o.w, o.h, o.r, o.r, style);
          else doc.rect(o.x, o.y, o.w, o.h, style);
        } else if (o.t === 'line') {
          doc.setDrawColor(o.c);
          doc.setLineWidth(o.w);
          doc.line(o.x1, o.y1, o.x2, o.y2);
        } else if (o.t === 'image') {
          var m = /^data:image\/([a-z0-9.+-]+)/i.exec(o.src || '');
          var fmt = m ? m[1].toUpperCase() : 'PNG';
          if (fmt === 'JPG') fmt = 'JPEG';
          try { doc.addImage(o.src, fmt, o.x, o.y, o.w, o.h, undefined, 'FAST'); } catch (e) { /* an image the PDF cannot read is left out */ }
        } else if (o.t === 'qr') {
          doc.setFillColor(o.c);
          qrRects(o).forEach(function (r) { doc.rect(r.x, r.y, r.w, r.h, 'F'); });
        }
      });
    });
    return doc.output('blob');
  }

  // --------------------------------------------------------------- ready

  var readyPromise = null;

  function b64ToBuffer(b64) {
    var bin = atob(b64), len = bin.length, bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  function ready() {
    if (readyPromise) return readyPromise;
    var F = root && root.InvoiceFonts;
    if (!F || typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) {
      readyPromise = Promise.resolve();
      return readyPromise;
    }
    var loads = [[F.regular, '400'], [F.bold, '600']].map(function (p) {
      var face = new FontFace(FAMILY, b64ToBuffer(p[0]), { weight: p[1], style: 'normal' });
      document.fonts.add(face);
      return face.load();
    });
    loads.push(document.fonts.load('400 100px "' + FAMILY + '"', 'Aě'), document.fonts.load('600 100px "' + FAMILY + '"', 'Aě'));
    readyPromise = Promise.all(loads).then(function () {
      widthCache = {};
      ctxFont = '';
    }, function () {
      widthCache = {};
      ctxFont = '';
    });
    return readyPromise;
  }

  return { ready: ready, layout: layout, svg: svg, pdf: pdf, _textWidth: textW, _wrap: wrap };
});
