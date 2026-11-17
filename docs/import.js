/*
 * InvoiceImport: reads invoices exported by another invoicing service. No DOM in it.
 * Browser: window.InvoiceImport. Node: module.exports (used by the tests).
 *
 * The one format it reads is ISDOC, the Czech e-invoice standard (isdoc.cz), because FakturaOnline and Fakturoid
 * both export it with every line of every invoice. It arrives as a .isdoc file, a .isdocx archive, a ZIP of either,
 * or a PDF made by those services, which carries the same ISDOC file inside.
 *
 * Nothing here trusts the file: sizes are capped, XML entities are never expanded beyond the five built-in ones,
 * and every string is cut to a sane length before it becomes part of a document.
 */
(function (root, factory) {
  var node = typeof module === 'object' && module.exports;
  var api = factory(node ? require('./core.js') : root.InvoiceCore);
  if (node) module.exports = api;
  if (root) root.InvoiceImport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C) {
  'use strict';

  var XML_LIMIT = 8 * 1024 * 1024;        // characters of one XML document
  var ENTRY_LIMIT = 24 * 1024 * 1024;     // bytes of one unpacked ZIP entry or PDF stream
  var TOTAL_LIMIT = 300 * 1024 * 1024;    // bytes unpacked from one picked file
  var MAX_ENTRIES = 20000;                // entries looked at in one ZIP
  var MAX_DOCUMENTS = 5000;               // invoices taken from one import
  var MAX_DEPTH = 200;                    // nesting of XML elements
  var MAX_TAG = 1024 * 1024;              // characters of one start tag
  var PDF_LIMIT = 48 * 1024 * 1024;       // bytes unpacked while looking through one PDF
  var MAX_SKIPPED = 500;                  // reasons kept for files that were left out

  function fail(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  // ------------------------------------------------------------------ XML

  var ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

  function decodeEntities(s) {
    if (s.indexOf('&') === -1) return s;
    return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]+);/g, function (all, name) {
      if (name.charAt(0) === '#') {
        var code = name.charAt(1) === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        if (!(code > 0) || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return '';
        return String.fromCodePoint(code);
      }
      return Object.prototype.hasOwnProperty.call(ENTITIES, name) ? ENTITIES[name] : all;
    });
  }

  function localName(name) {
    var at = name.indexOf(':');
    return at === -1 ? name : name.slice(at + 1);
  }

  /**
   * A small reader for well-formed XML: elements, attributes, text and CDATA. Namespace prefixes are dropped, so a
   * node's `name` is its local name. Comments, processing instructions and a DOCTYPE are skipped; an entity a
   * DOCTYPE declares is never expanded. Returns the root { name, attrs, children, text }; throws on anything torn.
   */
  function parseXml(text) {
    text = String(text == null ? '' : text);
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    if (text.length > XML_LIMIT) throw fail('too_large', 'The file is too large to be one invoice.');
    var n = text.length;
    var holder = { name: '', attrs: {}, children: [], text: '' };
    var stack = [holder];
    var i = 0;
    while (i < n) {
      var lt = text.indexOf('<', i);
      var top = stack[stack.length - 1];
      if (lt === -1) { top.text += decodeEntities(text.slice(i)); break; }
      if (lt > i) top.text += decodeEntities(text.slice(i, lt));
      var end;
      if (text.startsWith('<!--', lt)) {
        end = text.indexOf('-->', lt + 4);
        if (end === -1) throw fail('xml', 'The file is cut off inside a comment.');
        i = end + 3;
      } else if (text.startsWith('<![CDATA[', lt)) {
        end = text.indexOf(']]>', lt + 9);
        if (end === -1) throw fail('xml', 'The file is cut off inside a text block.');
        top.text += text.slice(lt + 9, end);
        i = end + 3;
      } else if (text.startsWith('<?', lt)) {
        end = text.indexOf('?>', lt + 2);
        if (end === -1) throw fail('xml', 'The file is cut off.');
        i = end + 2;
      } else if (text.startsWith('<!', lt)) {
        // a DOCTYPE, with or without an internal subset in [ ]
        var depth = 0;
        var j = lt + 2;
        for (; j < n; j++) {
          var ch = text.charCodeAt(j);
          if (ch === 91) depth++;
          else if (ch === 93) depth--;
          else if (ch === 62 && depth <= 0) break;
        }
        if (j >= n) throw fail('xml', 'The file is cut off.');
        i = j + 1;
      } else if (text.charCodeAt(lt + 1) === 47) {
        end = text.indexOf('>', lt);
        if (end === -1) throw fail('xml', 'The file is cut off.');
        var closing = localName(text.slice(lt + 2, end).trim());
        if (stack.length < 2 || top.name !== closing) throw fail('xml', 'The file is not well-formed XML.');
        stack.pop();
        i = end + 1;
      } else {
        var k = lt + 1;
        var quote = 0;
        for (; k < n; k++) {
          var c = text.charCodeAt(k);
          if (quote) { if (c === quote) quote = 0; }
          else if (c === 34 || c === 39) quote = c;
          else if (c === 62) break;
        }
        if (k >= n) throw fail('xml', 'The file is cut off.');
        if (k - lt > MAX_TAG) throw fail('xml', 'The file is not an invoice: one of its tags is far too long.');
        var raw = text.slice(lt + 1, k);
        var selfClosing = raw.charCodeAt(raw.length - 1) === 47;
        if (selfClosing) raw = raw.slice(0, -1);
        var m = /^([^\s\/>=]+)/.exec(raw);
        if (!m) throw fail('xml', 'The file is not well-formed XML.');
        var node = { name: localName(m[1]), attrs: Object.create(null), children: [], text: '' };
        // sticky: each attribute is matched where the last one ended, so a tag is read in one pass whatever is in it
        var attrRe = /\s+([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
        var rest = raw.slice(m[1].length);
        var a;
        while ((a = attrRe.exec(rest))) {
          if (a[1] === 'xmlns' || a[1].slice(0, 6) === 'xmlns:') continue;
          node.attrs[localName(a[1])] = decodeEntities(a[2] != null ? a[2] : a[3]);
        }
        top.children.push(node);
        if (!selfClosing) {
          if (stack.length > MAX_DEPTH) throw fail('xml', 'The file is nested too deeply to be an invoice.');
          stack.push(node);
        }
        i = k + 1;
      }
    }
    if (stack.length !== 1) throw fail('xml', 'The file is cut off.');
    if (holder.children.length !== 1) throw fail('xml', 'The file is not an XML document.');
    return holder.children[0];
  }

  function kid(node, name) {
    if (!node) return null;
    for (var i = 0; i < node.children.length; i++) if (node.children[i].name === name) return node.children[i];
    return null;
  }

  function kids(node, name) {
    return node ? node.children.filter(function (c) { return c.name === name; }) : [];
  }

  /** The trimmed text at a path of child names under `node`, or ''. */
  function txt(node) {
    for (var i = 1; i < arguments.length && node; i++) node = kid(node, arguments[i]);
    return node ? node.text.replace(/\s+/g, ' ').trim() : '';
  }

  // -------------------------------------------------------------- numbers

  /** "25.10" | ".5" | "+3" | "-1200.00" -> a plain decimal string ("25.10", "0.5", "3", "-1200.00"), or '' for anything else. */
  function dec(s) {
    s = String(s == null ? '' : s).trim();
    var m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s);
    if (!m || (m[2] === '' && !m[3])) return '';
    if (m[2].length > 15 || (m[3] || '').length > 12) return '';
    return (m[1] === '-' ? '-' : '') + (m[2] || '0') + (m[3] ? '.' + m[3] : '');
  }

  /** A decimal string -> an integer scaled by 10^digits, half away from zero. */
  function scaled(s, digits) {
    var m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(s);
    if (!m) return 0;
    var frac = m[3] || '';
    var kept = (frac + '000000000000').slice(0, digits);
    var value = Number(m[2] + kept);
    if (frac.length > digits && frac.charCodeAt(digits) - 48 >= 5) value += 1;
    return value === 0 ? 0 : (m[1] ? -value : value);
  }

  /** The money at a path, in cents, or null when the element is missing or is not a number. */
  function cents(node) {
    var s = dec(txt.apply(null, arguments));
    return s === '' ? null : scaled(s, 2);
  }

  function roundDiv(numer, denom) {
    if (denom === 0n) return 0;
    if (denom < 0n) { denom = -denom; numer = -numer; }
    var neg = numer < 0n;
    if (neg) numer = -numer;
    var q = (numer * 2n + denom) / (denom * 2n);
    return Number(neg ? -q : q);
  }

  /** quantity x unit price, in cents, rounded the way the totals round it. */
  function lineAmount(qty, price) {
    return roundDiv(BigInt(scaled(qty, 4)) * BigInt(scaled(price, 4)), 1000000n);
  }

  /** An integer scaled by 10^digits -> a decimal string with no trailing zeros. */
  function unscale(value, digits) {
    var neg = value < 0;
    var s = String(Math.abs(value));
    while (s.length <= digits) s = '0' + s;
    var out = s.slice(0, s.length - digits) + '.' + s.slice(s.length - digits);
    out = out.replace(/0+$/, '').replace(/\.$/, '');
    return (neg ? '-' : '') + out;
  }

  function clip(s, max) {
    s = String(s == null ? '' : s);
    return s.length > max ? s.slice(0, max) : s;
  }

  function isoDate(s) {
    var m = /^(\d{4}-\d{2}-\d{2})/.exec(String(s || '').trim());
    return m && C.isIsoDate(m[1]) ? m[1] : '';
  }

  // ---------------------------------------------------------------- ISDOC

  // UN/EDIFACT payment means codes as the ISDOC standard lists them
  var PAYMENT_CODES = { '10': 'cash', '20': 'transfer', '31': 'transfer', '42': 'transfer', '48': 'card', '49': 'transfer', '50': 'cod', '97': 'offset' };

  function party(node) {
    var out = C.emptyParty();
    out.name = clip(txt(node, 'PartyName', 'Name'), 300);
    out.companyNumber = clip(txt(node, 'PartyIdentification', 'ID'), 40);
    var vat = '';
    kids(node, 'PartyTaxScheme').forEach(function (scheme) {
      var id = txt(scheme, 'CompanyID');
      if (id && (!vat || txt(scheme, 'TaxScheme').toUpperCase() === 'VAT')) vat = id;
    });
    out.taxNumber = clip(vat, 40);
    var address = kid(node, 'PostalAddress');
    out.street = clip([txt(address, 'StreetName'), txt(address, 'BuildingNumber')].filter(Boolean).join(' '), 300);
    out.city = clip(txt(address, 'CityName'), 200);
    out.postcode = clip(txt(address, 'PostalZone'), 20);
    var country = txt(address, 'Country', 'IdentificationCode').toUpperCase();
    out.country = /^[A-Z]{2}$/.test(country) ? country : 'CZ';
    var contact = kid(node, 'Contact');
    out.email = clip(txt(contact, 'ElectronicMail'), 200);
    out.phone = clip(txt(contact, 'Telephone'), 60);
    return out;
  }

  /**
   * One ISDOC document as plain data, nothing decided yet about where it goes. Money is in cents of the invoice's
   * own currency (the elements ending in Curr when the invoice is in a foreign one). Throws `not_isdoc` for XML
   * that is something else, with a message that says what it is when that can be told.
   */
  function parseIsdoc(text) {
    var root = parseXml(text);
    if (root.name !== 'Invoice' || !kid(root, 'ID')) {
      var what = root.name.toLowerCase();
      if (what === 'datapack') throw fail('not_isdoc', 'This is an export for Pohoda. Export the invoices as ISDOC instead.');
      if (what === 'moneydata') throw fail('not_isdoc', 'This is an export for Money S3. Export the invoices as ISDOC instead.');
      if (what === 'invoices' || what === 'invoice') throw fail('not_isdoc', 'This is a service’s own XML, not ISDOC. Choose ISDOC in its export instead.');
      if (what === 'commondocument') throw fail('not_isdoc', 'This ISDOC file is a general document, not an invoice.');
      throw fail('not_isdoc', 'This XML file is not an ISDOC invoice.');
    }
    var foreignCode = txt(root, 'ForeignCurrencyCode').toUpperCase();
    var localCode = txt(root, 'LocalCurrencyCode').toUpperCase();
    var foreign = /^[A-Z]{3}$/.test(foreignCode) && foreignCode !== localCode;
    var currency = foreign ? foreignCode : (/^[A-Z]{3}$/.test(localCode) ? localCode : 'CZK');
    var curr = function (name) { return foreign ? name + 'Curr' : name; };

    var rate = '';
    if (foreign) {
      var r = dec(txt(root, 'CurrRate'));
      var per = dec(txt(root, 'RefCurrRate')) || '1';
      if (r && scaled(r, 6) > 0 && scaled(per, 6) > 0) {
        rate = unscale(roundDiv(BigInt(scaled(r, 6)) * 1000000n, BigInt(scaled(per, 6))), 6);
      }
    }

    var lines = kids(kid(root, 'InvoiceLines'), 'InvoiceLine').slice(0, 2000).map(function (line) {
      var quantity = kid(line, 'InvoicedQuantity');
      var description = txt(line, 'Item', 'Description');
      var note = txt(line, 'Note');
      if (!description) description = note;
      else if (note && note !== description) description += ' (' + note + ')';
      var tax = kid(line, 'ClassifiedTaxCategory');
      return {
        qty: dec(quantity ? quantity.text : '') || '1',
        unit: clip(quantity && quantity.attrs.unitCode != null ? String(quantity.attrs.unitCode).trim() : '', 20),
        description: clip(description, 1000),
        rate: dec(txt(tax, 'Percent')) || '0',
        reverse: txt(tax, 'LocalReverseChargeFlag') === 'true',
        net: cents(line, curr('LineExtensionAmount')),
        gross: cents(line, curr('LineExtensionAmountTaxInclusive')),
        // unit prices are in the local currency by the standard; a foreign invoice gets its own from the line amounts
        unitNet: foreign ? '' : dec(txt(line, 'UnitPrice')),
        unitGross: foreign ? '' : dec(txt(line, 'UnitPriceTaxInclusive'))
      };
    });

    // Advances already paid come off the total in two places: those a tax document was issued for
    // (AlreadyClaimed...) and those paid on a proforma alone (PaidDepositsAmount, written as a negative).
    var total = kid(root, 'LegalMonetaryTotal');
    var deposits = Math.abs(cents(total, curr('PaidDepositsAmount')) || 0) + Math.abs(cents(total, curr('AlreadyClaimedTaxInclusiveAmount')) || 0);

    // the payment that says how the invoice is to be paid: the one with a due date, else the first
    var payments = kids(kid(root, 'PaymentMeans'), 'Payment');
    var payment = payments.filter(function (p) { return txt(p, 'Details', 'PaymentDueDate'); })[0] || payments[0] || null;
    var details = kid(payment, 'Details');
    var accountId = txt(details, 'ID');
    var bankCode = txt(details, 'BankCode');
    var account = accountId && bankCode ? accountId + '/' + bankCode : '';

    if (foreign && lines.length && cents(total, curr('PayableAmount')) == null && cents(total, curr('TaxInclusiveAmount')) == null &&
        lines.every(function (l) { return l.net == null && l.gross == null; })) {
      throw fail('unreadable', 'The invoice is in ' + currency + ', but the file gives no amounts in that currency.');
    }

    var supplierParty = kid(kid(root, 'AccountingSupplierParty'), 'Party');
    var register = kid(supplierParty, 'RegisterIdentification');
    var type = Number(txt(root, 'DocumentType'));
    return {
      type: type >= 1 && type <= 7 ? type : 1,
      number: clip(txt(root, 'ID'), 60),
      issueDate: isoDate(txt(root, 'IssueDate')),
      taxDate: isoDate(txt(root, 'TaxPointDate')),
      // an older file without the element is read as a VAT payer's when any line carries a rate
      vatApplicable: kid(root, 'VATApplicable') ? txt(root, 'VATApplicable') === 'true' : lines.some(function (l) { return scaled(l.rate, 2) > 0; }),
      note: clip(kid(root, 'Note') ? kid(root, 'Note').text.trim() : '', 4000),
      currency: currency,
      exchangeRate: rate,
      supplier: party(supplierParty),
      customer: party(kid(kid(root, 'AccountingCustomerParty'), 'Party')),
      registerNote: clip([txt(register, 'RegisterKeptAt'), txt(register, 'RegisterFileRef')].filter(Boolean).join(', '), 300),
      issuedBy: clip(txt(supplierParty, 'Contact', 'Name'), 120),
      lines: lines,
      totals: {
        net: cents(total, curr('TaxExclusiveAmount')),
        gross: cents(total, curr('TaxInclusiveAmount')),
        payable: cents(total, curr('PayableAmount')),
        rounding: cents(total, curr('PayableRoundingAmount')) || 0,
        deposits: deposits
      },
      payment: {
        method: PAYMENT_CODES[txt(payment, 'PaymentMeansCode')] || 'transfer',
        dueDate: isoDate(txt(details, 'PaymentDueDate')),
        account: clip(C.parseCzAccount(account) ? account : '', 40),
        iban: clip(C.cleanIban(txt(details, 'IBAN')), 40),
        swift: clip(txt(details, 'BIC').toUpperCase(), 20),
        variableSymbol: clip(txt(details, 'VariableSymbol').replace(/\D/g, ''), 10),
        constantSymbol: clip(txt(details, 'ConstantSymbol').replace(/\D/g, ''), 10),
        specificSymbol: clip(txt(details, 'SpecificSymbol').replace(/\D/g, ''), 10)
      },
      orderNumber: clip(txt(root, 'OrderReferences', 'OrderReference', 'ExternalOrderID') || txt(root, 'OrderReferences', 'OrderReference', 'SalesOrderID'), 60),
      correctedNumber: clip(txt(root, 'OriginalDocumentReferences', 'OriginalDocumentReference', 'ID'), 60),
      system: clip(txt(root, 'IssuingSystem'), 80)
    };
  }

  // ------------------------------------------------------- unpacking files

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  function concat(chunks, total) {
    if (chunks.length === 1) return chunks[0];
    var out = new Uint8Array(total);
    var at = 0;
    chunks.forEach(function (c) { out.set(c, at); at += c.length; });
    return out;
  }

  /**
   * Unpacks deflate data ('deflate-raw' in a ZIP, 'deflate' in a PDF). `lenient` keeps what came out before a
   * stream turned out to be torn or followed by other bytes, which is what a PDF stream cut at "endstream" is.
   */
  async function inflate(data, format, limit, lenient) {
    if (typeof DecompressionStream !== 'function') throw fail('no_inflate', 'This browser cannot unpack compressed files. Unpack the ZIP yourself and choose the .isdoc files.');
    var stream = new DecompressionStream(format);
    var writer = stream.writable.getWriter();
    var writing = writer.write(data).then(function () { return writer.close(); }).catch(function () {});
    var reader = stream.readable.getReader();
    var chunks = [];
    var total = 0;
    try {
      for (;;) {
        var step = await reader.read();
        if (step.done) break;
        total += step.value.length;
        if (total > limit) throw fail('too_large', 'A file inside is too large to be an invoice.');
        chunks.push(step.value);
      }
    } catch (e) {
      try { await reader.cancel(); } catch (ignored) { /* already closed */ }
      if (e && e.code === 'too_large') throw e;
      if (!lenient || !chunks.length) throw fail('damaged', 'A compressed part of the file is damaged.');
    }
    await writing;
    return concat(chunks, total);
  }

  function decodeBytes(bytes, label) {
    try { return new TextDecoder(label || 'utf-8').decode(bytes); } catch (e) { return new TextDecoder('utf-8').decode(bytes); }
  }

  /** The text of an XML file: UTF-8 unless its first line says otherwise. */
  function xmlText(bytes) {
    // UTF-16 says so in its first two bytes: a byte-order mark, or "<" with a zero beside it
    if ((bytes[0] === 0xFF && bytes[1] === 0xFE) || (bytes[0] === 0x3C && bytes[1] === 0)) return decodeBytes(bytes, 'utf-16le');
    if ((bytes[0] === 0xFE && bytes[1] === 0xFF) || (bytes[0] === 0 && bytes[1] === 0x3C)) return decodeBytes(bytes, 'utf-16be');
    var head = decodeBytes(bytes.subarray(0, 200), 'utf-8');
    var m = /^﻿?<\?xml[^>]*encoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(head);
    var label = m ? m[1].toLowerCase() : 'utf-8';
    return decodeBytes(bytes, label === 'utf8' ? 'utf-8' : label);
  }

  /** The entries of a ZIP, from its central directory: [{ name, method, size, packed, offset, encrypted }]. */
  function zipEntries(bytes) {
    var n = bytes.length;
    var eocd = -1;
    for (var i = n - 22; i >= 0 && i >= n - 22 - 65535; i--) {
      if (bytes[i] === 0x50 && u32(bytes, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw fail('zip', 'The archive is damaged or is not a ZIP.');
    var count = u16(bytes, eocd + 10);
    var at = u32(bytes, eocd + 16);
    if (count === 0xFFFF || at === 0xFFFFFFFF) throw fail('zip', 'The archive is too large. Export a shorter period, or unpack it and choose the files.');
    var out = [];
    for (var k = 0; k < count && k < MAX_ENTRIES; k++) {
      if (at + 46 > n || u32(bytes, at) !== 0x02014b50) throw fail('zip', 'The archive is damaged.');
      var flags = u16(bytes, at + 8);
      var nameLength = u16(bytes, at + 28);
      out.push({
        name: decodeBytes(bytes.subarray(at + 46, at + 46 + nameLength), 'utf-8'),
        method: u16(bytes, at + 10), packed: u32(bytes, at + 20), size: u32(bytes, at + 24),
        offset: u32(bytes, at + 42), encrypted: (flags & 1) === 1
      });
      at += 46 + nameLength + u16(bytes, at + 30) + u16(bytes, at + 32);
    }
    out.more = Math.max(0, count - MAX_ENTRIES);     // entries that were not looked at
    return out;
  }

  async function zipRead(bytes, entry) {
    var o = entry.offset;
    if (entry.encrypted) throw fail('zip', 'The archive is protected by a password.');
    if (entry.size > ENTRY_LIMIT || entry.packed > ENTRY_LIMIT) throw fail('too_large', 'A file inside is too large to be an invoice.');
    if (o + 30 > bytes.length || u32(bytes, o) !== 0x04034b50) throw fail('zip', 'The archive is damaged.');
    var start = o + 30 + u16(bytes, o + 26) + u16(bytes, o + 28);
    if (start + entry.packed > bytes.length) throw fail('zip', 'The archive is cut off.');
    var data = bytes.subarray(start, start + entry.packed);
    if (entry.method === 0) return data;
    if (entry.method === 8) return inflate(data, 'deflate-raw', ENTRY_LIMIT, false);
    throw fail('zip', 'The archive uses a compression this page cannot unpack.');
  }

  function looksLikeIsdoc(bytes) {
    var head = decodeBytes(bytes.subarray(0, 1200), 'utf-8');
    return /<(?:[A-Za-z_][\w.-]*:)?Invoice[\s>]/.test(head) && head.indexOf('isdoc.cz/namespace') !== -1;
  }

  /**
   * The ISDOC file a PDF carries, as bytes, or null. FakturaOnline and Fakturoid attach one to every PDF they
   * make. Streams are found by their keywords and tried one by one, attachments first, so no map of the PDF's
   * objects is needed; a PDF that is encrypted or has no attachment simply yields nothing.
   */
  async function isdocFromPdf(bytes) {
    var left = PDF_LIMIT;                      // an invoice's PDF is small; one that unpacks to more than this is not one
    var s = decodeBytes(bytes, 'latin1');     // one character per byte, so offsets are byte offsets
    var re = /stream(\r\n|\n)/g;
    var found = [];
    var m;
    while ((m = re.exec(s)) && found.length < 4000) {
      if (s.slice(m.index - 3, m.index) === 'end') continue;
      var start = m.index + m[0].length;
      var head = s.slice(Math.max(0, m.index - 800), m.index);
      var obj = head.lastIndexOf(' obj');
      if (obj !== -1) head = head.slice(obj);
      if (/\/(ASCIIHexDecode|ASCII85Decode|LZWDecode|DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode|RunLengthDecode|Crypt)\b/.test(head)) continue;
      var end = -1;
      var len = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(head);
      if (len && /^\s*endstream/.test(s.slice(start + Number(len[1]), start + Number(len[1]) + 16))) end = start + Number(len[1]);
      if (end === -1) {
        end = s.indexOf('endstream', start);
        if (end === -1) break;
        while (end > start && (s.charCodeAt(end - 1) === 10 || s.charCodeAt(end - 1) === 13)) end--;
      }
      if (end - start > 16 && end - start <= ENTRY_LIMIT) {
        found.push({ start: start, end: end, flate: /\/FlateDecode\b|\/Fl\b/.test(head), attached: /\/EmbeddedFile\b/.test(head) });
      }
      re.lastIndex = end;
    }
    found.sort(function (a, b) { return (b.attached ? 1 : 0) - (a.attached ? 1 : 0); });
    for (var i = 0; i < found.length && left > 0; i++) {
      var part = bytes.subarray(found[i].start, found[i].end);
      var data = part;
      if (found[i].flate) {
        try { data = await inflate(part, 'deflate', Math.min(XML_LIMIT, left), true); } catch (e) {
          if (e && e.code === 'no_inflate') throw e;
          left -= e && e.code === 'too_large' ? XML_LIMIT : part.length;
          continue;
        }
        left -= data.length;
      }
      if (looksLikeIsdoc(data)) return data;
    }
    return null;
  }

  function extension(name) {
    var m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }

  function baseName(name) { return String(name || '').replace(/^.*[\\/]/, ''); }

  var SPREADSHEETS = { xlsx: true, xls: true, csv: true, ods: true };
  var NOT_INVOICES = { vcf: true, json: true, txt: true, png: true, jpg: true, jpeg: true, bmp: true, gif: true, doc: true, docx: true };

  /**
   * Everything that can be read as an invoice in the files a person picked: [{ name, bytes: Uint8Array }].
   * Resolves { found: [{ source, data }], skipped: [{ source, reason }] }; it never rejects for one bad file.
   */
  async function readFiles(files) {
    var found = [];
    var skipped = [];
    var budget = { left: TOTAL_LIMIT, entries: MAX_ENTRIES * 2 };

    function skip(source, reason) {
      if (skipped.length < MAX_SKIPPED) skipped.push({ source: source, reason: reason });
      else if (skipped.length === MAX_SKIPPED) skipped.push({ source: '\u2026', reason: 'More files were left out than are listed here.' });
    }

    function take(source, bytes) {
      if (found.length >= MAX_DOCUMENTS) { skip(source, 'Left out: one import takes at most ' + MAX_DOCUMENTS + ' documents.'); return; }
      try {
        found.push({ source: source, data: parseIsdoc(xmlText(bytes)) });
      } catch (e) {
        skip(source, e && e.code ? e.message : 'The file could not be read.');
      }
    }

    async function pdf(source, bytes) {
      var inside = await isdocFromPdf(bytes);
      if (inside) take(source, inside);
      else skip(source, 'This PDF carries no invoice data inside. Export the invoices as ISDOC instead.');
    }

    async function archive(source, bytes, depth) {
      var all = zipEntries(bytes);
      if (all.more) skip(source, 'Only the first ' + MAX_ENTRIES + ' files of the archive were looked at; ' + all.more + ' more were not.');
      var entries = all.filter(function (e) { return e.name && e.name.slice(-1) !== '/'; });
      // an .isdocx names its one invoice in manifest.xml; its other files are attachments
      var manifest = entries.filter(function (e) { return e.name.toLowerCase() === 'manifest.xml'; })[0];
      var main = '';
      if (manifest) {
        try {
          var doc = parseXml(xmlText(await zipRead(bytes, manifest)));
          var named = kid(doc, 'maindocument');
          if (named && named.attrs.filename) {
            main = String(named.attrs.filename);
            try { main = decodeURIComponent(main); } catch (e) { /* keep it as written */ }
          }
        } catch (e) { /* a torn manifest: fall back to the files themselves */ }
      }
      if (main) {
        var picked = entries.filter(function (e) { return e.name === main; });
        if (picked.length) entries = picked;
      }
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        var ext = extension(entry.name);
        var label = source + ' › ' + baseName(entry.name);
        if (entry.name.toLowerCase() === 'manifest.xml' || NOT_INVOICES[ext]) continue;
        if (SPREADSHEETS[ext]) { skip(label, 'A spreadsheet has no invoice lines to import. Export the invoices as ISDOC instead.'); continue; }
        if (ext !== 'isdoc' && ext !== 'xml' && ext !== 'pdf' && ext !== 'isdocx' && ext !== 'zip') continue;
        if (found.length >= MAX_DOCUMENTS) { skip(label, 'Left out: one import takes at most ' + MAX_DOCUMENTS + ' documents.'); break; }
        if (--budget.entries < 0) { skip(source, 'The rest of the archive was not read: it holds more files than this page will look through.'); break; }
        try {
          if (entry.size > budget.left) throw fail('too_large', 'The archive unpacks to more than this page will read at once. Export a shorter period.');
          var data = await zipRead(bytes, entry);
          budget.left -= data.length;
          if (ext === 'pdf') await pdf(label, data);
          else if (ext === 'isdocx' || ext === 'zip') {
            if (depth >= 2) skip(label, 'An archive inside an archive inside an archive is not opened.');
            else await archive(label, data, depth + 1);
          } else take(label, data);
        } catch (e) {
          skip(label, e && e.code ? e.message : 'The file could not be read.');
          if (e && (e.code === 'no_inflate')) break;
        }
      }
    }

    for (var i = 0; i < (files || []).length; i++) {
      var file = files[i];
      var name = baseName(file && file.name) || 'file';
      var bytes = file && file.bytes;
      try {
        if (!bytes || !bytes.length) { skip(name, 'The file is empty.'); continue; }
        var ext = extension(name);
        var zip = bytes[0] === 0x50 && bytes[1] === 0x4B;
        var isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
        if (zip && (ext === 'xlsx' || ext === 'ods')) skip(name, 'A spreadsheet has no invoice lines to import. Export the invoices as ISDOC instead.');
        else if (zip) await archive(name, bytes, 0);
        else if (isPdf) await pdf(name, bytes);
        else if (SPREADSHEETS[ext]) skip(name, 'A spreadsheet has no invoice lines to import. Export the invoices as ISDOC instead.');
        else if (ext === 'vcf') skip(name, 'Contacts are not imported on their own: every customer on an imported invoice is added with it.');
        else if (bytes.length > XML_LIMIT) skip(name, 'The file is too large to be one invoice.');
        else take(name, bytes);
      } catch (e) {
        skip(name, e && e.code ? e.message : 'The file could not be read.');
      }
    }
    return { found: found, skipped: skipped };
  }

  // ---------------------------------------------------- into the workbench

  /**
   * A company number as it is compared: no spaces, upper case. Letters are part of it ("HRB 12345" is not
   * "HRA 12345"). A Czech IČO is eight digits, and some exports drop its leading zero, so a short all-digit
   * number of a Czech party is padded back.
   */
  function numberKey(p) {
    var raw = String(p && p.companyNumber != null ? p.companyNumber : '').replace(/[\s.\-\/]+/g, '').toUpperCase();
    if (!p.country || p.country === 'CZ') {
      // typed by hand it is often "CZ12345678" or "IČO: 12345678"; the eight digits are the number
      var bare = raw.replace(/^(?:CZ|I[ČC]O?:?)(?=\d)/, '');
      if (/^\d{1,8}$/.test(bare)) raw = ('00000000' + bare).slice(-8);
    }
    return /^0*$/.test(raw) ? '' : raw;            // "0" or "00000000" is a blank someone filled in, not a number
  }

  function nameKey(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim(); }

  /** What tells two parties apart: the company number when there is one, else the name. */
  function partyKey(p) {
    var number = numberKey(p);
    if (number) return 'n:' + number;
    var name = nameKey(p && p.name);
    return name ? 't:' + name : '';
  }

  function findCompany(companies, kind, p) {
    var number = numberKey(p);
    var name = nameKey(p.name);
    var byName = null;
    for (var i = 0; i < companies.length; i++) {
      var c = companies[i];
      if (!c || c.kind !== kind) continue;
      var theirs = numberKey(c);
      if (number && theirs) { if (number === theirs) return c; continue; }
      if (name && nameKey(c.name) === name && !byName) byName = c;
    }
    return byName;
  }

  function kindFor(data) {
    if (data.type === 2 || data.type === 3) return 'corrective';
    if (data.type === 4) return 'advance';
    if (data.vatApplicable && data.lines.length && data.lines.every(function (l) { return l.reverse; })) return 'reverse_charge';
    return data.vatApplicable ? 'invoice_vat' : 'invoice_novat';
  }

  /** One line as an item whose quantity times price is the line's amount, to the cent. */
  function itemFor(line, mode) {
    var amount = mode === 'gross' ? line.gross : line.net;
    var unit = mode === 'gross' ? line.unitGross : line.unitNet;
    // a reverse-charge line has a rate on paper and no VAT in the price: the customer accounts for it
    var item = C.newItem(line.reverse ? 0 : Number(line.rate));
    item.qty = Number(line.qty);
    item.unit = line.unit;
    item.description = line.description;
    if (amount == null) {
      item.price = Number(unit || '0');
    } else if (unit && lineAmount(line.qty, unit) === amount) {
      item.price = Number(unit);
    } else {
      var qty4 = scaled(line.qty, 4);
      var derived = qty4 !== 0 ? unscale(roundDiv(BigInt(amount) * 1000000n, BigInt(qty4)), 4) : '';
      if (derived && lineAmount(line.qty, derived) === amount) {
        item.price = Number(derived);
      } else {
        // no price to four places gives this amount for this quantity: keep the amount, and say the quantity in words
        item.qty = 1;
        item.unit = '';
        item.price = Number(unscale(amount, 2));
        if (scaled(line.qty, 4) !== 10000) item.description = clip(line.qty + (line.unit ? ' ' + line.unit : '') + ' × ' + line.description, 1000);
      }
    }
    return item;
  }

  var ROUNDINGS = ['none', '1', '0.5', '0.1'];

  /**
   * "Left to pay: 0" on an invoice that charges something and deducts no advance means it was paid when the file
   * was made. A total that only rounds down to nothing is not that.
   */
  function settled(t) {
    return t.payable === 0 && t.deposits === 0 && !!t.gross && t.gross + t.rounding !== 0;
  }

  /**
   * Sets the items, the price mode and the rounding of `inv` so that its total is the file's, and returns what a
   * person should know about it: [] when it simply fits. The file's own amounts win over ours: where no way of
   * adding the lines up gives the file's total, a rounding line makes up a difference under one unit of currency,
   * and a larger one is reported.
   */
  function fitTotals(inv, data) {
    var notes = [];
    var t = data.totals;
    var modes = C.vatModeOf(inv) === 'vat' ? ['net', 'gross'] : ['net'];
    var items = {};
    modes.forEach(function (mode) {
      items[mode] = data.lines.map(function (l) { return itemFor(l, mode); });
      if (t.deposits > 0) {
        var deposit = C.newItem(0);
        deposit.description = 'Uhrazená záloha';
        deposit.price = Number(unscale(-t.deposits, 2));
        items[mode].push(deposit);
      }
    });
    if (t.deposits > 0) notes.push('deducts an advance already paid, imported as a line of its own');

    function attempt(mode, rounding, extra) {
      inv.priceMode = mode;
      inv.rounding = rounding;
      inv.items = extra ? items[mode].concat([extra]) : items[mode];
      return C.computeTotals(inv).payable;
    }

    var expected = t.payable;
    // a paid invoice says "left to pay: 0"; its total is still what it was issued for
    if (settled(t)) expected = t.gross + t.rounding;
    if (expected == null && t.gross != null) expected = t.gross - t.deposits;
    if (expected == null) { attempt('net', 'none'); return notes; }

    // the total can come out right with the VAT wrong (prices read with VAT that had none in them): say so
    function vatChecked() {
      if (t.net == null || t.gross == null || t.deposits > 0 || C.vatModeOf(inv) !== 'vat') return notes;
      var ours = C.computeTotals(inv).vat;
      var theirs = t.gross - t.net;
      if (Math.abs(ours - theirs) >= 100) notes.push('has ' + unscale(ours, 2) + ' ' + data.currency + ' of VAT here, ' + unscale(theirs, 2) + ' ' + data.currency + ' in the file');
      return notes;
    }

    for (var r = 0; r < ROUNDINGS.length; r++) {
      for (var m = 0; m < modes.length; m++) {
        if (attempt(modes[m], ROUNDINGS[r]) === expected) return vatChecked();
      }
    }
    var best = modes[0];
    var gap = expected - attempt(modes[0], 'none');
    if (modes.length > 1) {
      var other = expected - attempt(modes[1], 'none');
      if (Math.abs(other) < Math.abs(gap)) { gap = other; best = modes[1]; }
    }
    if (Math.abs(gap) < 100) {
      var rounding = C.newItem(0);
      rounding.description = 'Zaokrouhlení';
      rounding.price = Number(unscale(gap, 2));
      if (attempt(best, 'none', rounding) === expected) {
        notes.push('takes a rounding line of ' + unscale(gap, 2) + ' ' + data.currency + ' to match the total in the file');
        return notes;
      }
    }
    attempt(best, 'none');
    notes.push('adds up to ' + unscale(expected - gap, 2) + ' ' + data.currency + ' here, ' + unscale(expected, 2) + ' ' + data.currency + ' in the file');
    return notes;
  }

  function seriesOf(kind) { return C.KINDS[kind].series; }

  /**
   * What makes two documents of one company the same one: series and number, compared without spaces or case. A
   * number with no year in it ("001") belongs to the year it was issued in, because such a series starts again
   * every January; a number that carries a year ("2026-001") is the same document whatever date the file gives.
   */
  function documentKey(series, number, issueDate) {
    var n = String(number == null ? '' : number).replace(/\s+/g, '').toUpperCase();
    var year = /(?:19|20)\d\d/.test(n) ? '' : String(issueDate || '').slice(0, 4);
    return series + '\n' + n + '\n' + year;
  }

  /**
   * What importing `found` (from readFiles) would do to `have` = { companies, invoices }, without doing it.
   * opts: { today, now (ISO timestamp), paid: 'due' | 'all' | 'none', leaveOut: { groupKey: true } }.
   *
   * Returns {
   *   groups: one per company the invoices were issued by:
   *           [{ key, name, companyNumber, isNew, received, selected, count, duplicates, from, to, totals: [{ currency, amount }] }],
   *   companies: the new companies to save (suppliers and customers of the selected groups),
   *   invoices: the new documents to save,
   *   duplicates: how many were left out because the same number of the same company is already here,
   *   notes: [{ number, text }] about documents that came in differently from the file,
   *   skipped: [{ source, reason }] documents that are not imported at all,
   *   likelyReceived: true when the files look like invoices the person received, not issued
   * }
   */
  function plan(found, have, opts) {
    opts = opts || {};
    have = have || {};
    var today = C.isIsoDate(opts.today) ? opts.today : C.localToday();
    var now = opts.now || '';
    var paid = opts.paid === 'all' || opts.paid === 'none' ? opts.paid : 'due';
    var leaveOut = opts.leaveOut || {};
    var companies = (have.companies || []).slice();
    var existing = have.invoices || [];
    var mine = companies.filter(function (c) { return c && c.kind === 'supplier'; });

    var out = { groups: [], companies: [], invoices: [], duplicates: 0, notes: [], skipped: [], likelyReceived: false };
    var groups = {};
    var customerKeys = {};

    var list = (found || []).slice().sort(function (a, b) {
      return a.data.issueDate < b.data.issueDate ? -1 : a.data.issueDate > b.data.issueDate ? 1 : 0;
    });

    list.forEach(function (entry) {
      var data = entry.data;
      if (data.type === 5 || data.type === 6) {
        out.skipped.push({ source: entry.source, reason: 'A tax document for a payment received is not imported: the advance invoice and the final invoice already carry that money.' });
        return;
      }
      if (!data.number.trim()) { out.skipped.push({ source: entry.source, reason: 'The invoice has no number.' }); return; }
      var key = partyKey(data.supplier);
      if (!key) { out.skipped.push({ source: entry.source, reason: 'The file does not say who issued the invoice.' }); return; }
      var group = groups[key];
      if (!group) {
        var company = findCompany(companies, 'supplier', data.supplier);
        group = groups[key] = {
          key: key, name: data.supplier.name || data.supplier.companyNumber, companyNumber: data.supplier.companyNumber,
          company: company, isNew: !company, received: false, selected: !leaveOut[key],
          count: 0, duplicates: 0, from: '', to: '', totals: {}, entries: [], taken: {}
        };
        out.groups.push(group);
      }
      // one of my own companies is the customer: this is an invoice I received
      if (mine.length && findCompany(mine, 'supplier', data.customer) && !group.company) group.received = true;
      var ck = partyKey(data.customer);
      if (ck) customerKeys[ck] = true;
      group.entries.push(entry);
    });

    out.likelyReceived = out.groups.some(function (g) { return g.received; }) ||
      (out.groups.length > 1 && Object.keys(customerKeys).length === 1 && out.groups.every(function (g) { return !g.company; }));

    out.groups.forEach(function (group) {
      // the company the documents hang on: the one already here, or a new one made from the newest document
      var supplier = group.company;
      var newest = group.entries[group.entries.length - 1].data;
      if (!supplier) {
        supplier = C.newCompany('supplier');
        var snapshot = newest.supplier;
        Object.keys(snapshot).forEach(function (k) { supplier[k] = snapshot[k]; });
        supplier.vatPayer = newest.vatApplicable;
        supplier.registerNote = newest.registerNote;
        for (var b = group.entries.length - 1; b >= 0; b--) {
          var pay = group.entries[b].data.payment;
          if (pay.account || pay.iban) {
            supplier.bank.account = pay.account;
            supplier.bank.iban = pay.iban;
            supplier.bank.swift = pay.swift;
            supplier.bank.showIban = !pay.account && !!pay.iban;
            break;
          }
        }
        if (newest.issuedBy) supplier.defaults.issuedBy = newest.issuedBy;
        supplier.createdAt = supplier.updatedAt = now;
      }
      // The same document: the same series, number and year of this company. The year is part of it because a
      // series that starts again every January reuses its numbers. A draft with nothing on it does not count:
      // it only took the next free number.
      var known = {};
      existing.forEach(function (d) {
        if (!d || d.supplierId !== supplier.id) return;
        if (d.status !== 'issued' && d.status !== 'paid' && C.computeTotals(d).payable === 0) return;
        known[documentKey(C.kindOf(d).series, d.number, d.issueDate)] = true;
      });

      var made = [];
      var customersMade = [];
      group.entries.forEach(function (entry) {
        var data = entry.data;
        var kind = kindFor(data);
        var issue = data.issueDate || today;
        var id = documentKey(seriesOf(kind), data.number, issue);
        if (known[id] || group.taken[id]) { group.duplicates++; return; }
        group.taken[id] = true;

        var inv = C.newInvoice(supplier, { today: issue, kind: kind });
        inv.vatApplies = data.vatApplicable;
        inv.number = data.number;
        inv.variableSymbol = data.payment.variableSymbol || C.defaultVariableSymbol(data.number);
        inv.constantSymbol = data.payment.constantSymbol;
        inv.specificSymbol = data.payment.specificSymbol;
        inv.orderNumber = data.orderNumber;
        inv.issuedBy = data.issuedBy || inv.issuedBy;
        inv.issueDate = issue;
        inv.taxDate = data.taxDate || issue;
        inv.dueDate = data.payment.dueDate && data.payment.dueDate >= issue ? data.payment.dueDate : issue;
        var days = C.daysBetween(inv.issueDate, inv.dueDate);
        inv.dueIn = C.DUE_OPTIONS.indexOf(days) !== -1 ? days : 'custom';
        inv.paymentMethod = data.payment.method;
        if (data.payment.account || data.payment.iban) {
          inv.bank = C.emptyBank();
          inv.bank.account = data.payment.account;
          inv.bank.iban = data.payment.iban;
          inv.bank.swift = data.payment.swift;
          inv.bank.showIban = (!data.payment.account && !!data.payment.iban) || (data.currency !== 'CZK' && !!data.payment.iban);
        }
        inv.currency = data.currency;
        inv.exchangeRate = data.exchangeRate;
        inv.registerNote = data.registerNote || inv.registerNote;
        inv.supplier = Object.assign(C.emptyParty(), data.supplier);
        inv.customer = Object.assign(C.emptyParty(), data.customer);
        inv.note = data.note;
        inv.correctedNumber = data.correctedNumber;
        inv.documentDiscount = null;

        fitTotals(inv, data).forEach(function (text) { out.notes.push({ number: data.number, text: text }); });

        // ISDOC has no "paid on": the person says how to read old invoices, and "nothing left to pay" speaks for itself
        var isPaid = settled(data.totals) || paid === 'all' || (paid === 'due' && inv.dueDate < today);
        inv.status = isPaid ? 'paid' : 'issued';
        inv.paidDate = isPaid ? (inv.dueDate <= today ? inv.dueDate : (inv.issueDate <= today ? inv.issueDate : today)) : '';
        // as old as its issue date: the next number continues from the newest document, not from the last one imported
        var born = issue + 'T00:00:00.000Z';
        inv.createdAt = now && born > now ? now : born;
        inv.updatedAt = now || born;

        // the customer: one already here, one made earlier in this import, or a new one
        var ck = partyKey(data.customer);
        if (ck) {
          var customer = findCompany(companies, 'customer', data.customer) || findCompany(customersMade, 'customer', data.customer);
          if (!customer) {
            customer = C.newCompany('customer');
            Object.keys(data.customer).forEach(function (k) { customer[k] = data.customer[k]; });
            customer.createdAt = customer.updatedAt = now;
            customersMade.push(customer);
          }
          inv.customerId = customer.id;
        }

        made.push(C.normalizeInvoice(inv));
        var amount = C.computeTotals(inv).payable;
        group.totals[inv.currency] = (group.totals[inv.currency] || 0) + amount;
        if (!group.from || inv.issueDate < group.from) group.from = inv.issueDate;
        if (!group.to || inv.issueDate > group.to) group.to = inv.issueDate;
      });

      group.count = made.length;
      out.duplicates += group.duplicates;
      if (group.selected && made.length) {
        if (group.isNew) out.companies.push(supplier);
        // a customer is added once, even when two of the companies issuing here both invoiced them
        customersMade.forEach(function (c) {
          var twin = findCompany(out.companies, 'customer', c);
          if (twin) made.forEach(function (d) { if (d.customerId === c.id) d.customerId = twin.id; });
          else out.companies.push(c);
        });
        out.invoices = out.invoices.concat(made);
      }
      group.totals = Object.keys(group.totals).sort().map(function (code) { return { currency: code, amount: group.totals[code] }; });
      delete group.entries;
      delete group.taken;
      delete group.company;
    });

    // notes only about what is going in
    var going = {};
    out.invoices.forEach(function (d) { going[d.number] = true; });
    out.notes = out.notes.filter(function (n) { return going[n.number]; });
    return out;
  }

  return {
    parseXml: parseXml, parseIsdoc: parseIsdoc, zipEntries: zipEntries, isdocFromPdf: isdocFromPdf,
    readFiles: readFiles, plan: plan, MAX_DOCUMENTS: MAX_DOCUMENTS
  };
});
