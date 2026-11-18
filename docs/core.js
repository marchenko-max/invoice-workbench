/*
 * InvoiceCore: the invoice rules with no DOM in them.
 * Browser: window.InvoiceCore. Node: module.exports (used by the tests).
 *
 * Money is kept in integer cents everywhere in this file. Quantities and unit
 * prices are scaled by 10^4. Every rounding is half away from zero and is done
 * on integers (BigInt for the products), never on binary floats.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.InvoiceCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------------------------------------------------------------- data

  // vat: how VAT is treated. 'supplier' = follows invoice.vatApplies.
  // series: documents of one series share a number sequence.
  var KINDS = {
    invoice_vat: { vat: 'vat', series: 'invoice', taxDocument: true, payable: true },
    invoice_novat: { vat: 'none', series: 'invoice', taxDocument: false, payable: true },
    reverse_charge: { vat: 'reverse', series: 'invoice', taxDocument: true, payable: true },
    corrective: { vat: 'vat', series: 'corrective', taxDocument: true, payable: true },
    quote_vat: { vat: 'vat', series: 'quote', taxDocument: false, payable: false },
    quote_novat: { vat: 'none', series: 'quote', taxDocument: false, payable: false },
    proforma: { vat: 'supplier', series: 'proforma', taxDocument: false, payable: true },
    advance: { vat: 'supplier', series: 'advance', taxDocument: false, payable: true }
  };
  var KIND_ORDER = ['invoice_vat', 'invoice_novat', 'corrective', 'reverse_charge', 'quote_vat', 'quote_novat', 'proforma', 'advance'];

  // the word a PDF's file name starts with when the document's own title has no Latin letters to offer
  var FILE_WORD = {
    invoice_vat: 'Invoice', invoice_novat: 'Invoice', reverse_charge: 'Invoice', corrective: 'Corrective-document',
    quote_vat: 'Quotation', quote_novat: 'Quotation', proforma: 'Proforma-invoice', advance: 'Advance-invoice'
  };

  var PAYMENT_METHODS = ['transfer', 'cash', 'card', 'cod', 'paypal', 'offset'];
  var DUE_OPTIONS = [0, 1, 7, 10, 14, 15, 21, 30, 45, 60, 90];
  var VAT_RATES = [21, 12, 0];
  var ROUNDING_STEPS = { none: 0, '0.1': 10, '0.5': 50, '1': 100 };
  var UNIT_KEYS = ['pcs', 'hour', 'day', 'litre', 'kg', 'g', 'm', 'km', 'm2', 'm3', 'pack'];

  // symbol only where the embedded face has the glyph and the sign is not shared by several currencies
  var CURRENCIES = [
    { code: 'CZK', symbol: 'Kč' }, { code: 'EUR', symbol: '€' }, { code: 'USD', symbol: '$' }, { code: 'GBP', symbol: '£' },
    { code: 'PLN', symbol: 'zł' }, { code: 'HUF', symbol: 'Ft' }, { code: 'UAH', symbol: '₴' }, { code: 'CHF', symbol: 'CHF' },
    { code: 'AED' }, { code: 'AUD' }, { code: 'BAM' }, { code: 'BGN' }, { code: 'CAD' }, { code: 'CNY' }, { code: 'DKK' },
    { code: 'HKD' }, { code: 'ILS' }, { code: 'INR' }, { code: 'ISK' }, { code: 'JPY' }, { code: 'MXN' }, { code: 'NOK' },
    { code: 'NZD' }, { code: 'PHP' }, { code: 'RON' }, { code: 'RSD' }, { code: 'RUB' }, { code: 'SAR' }, { code: 'SDG' },
    { code: 'SEK' }, { code: 'SGD' }, { code: 'TRY' }, { code: 'ZAR' }
  ];

  var QTY_DIGITS = 4;
  var PRICE_DIGITS = 4;

  // ------------------------------------------------------------ countries

  /**
   * What differs from one country to the next on an invoice: what the tax on a sale is called and at what
   * rates, and how a bank account is written. `tax` is 'vat' where the document's own language has the words for
   * it, and 'sales' for a tax that is one line under a subtotal, as in the United States, which has no VAT. A
   * country that is not listed gets VAT with no rates on offer and an IBAN: the person types their own rate.
   */
  var COUNTRIES = {
    CZ: { tax: 'vat', rates: [21, 12, 0], bank: 'cz', currency: 'CZK', language: 'cs' },
    SK: { tax: 'vat', rates: [23, 19, 5, 0], bank: 'iban', currency: 'EUR', language: 'sk' },
    UA: { tax: 'vat', rates: [20, 14, 7, 0], bank: 'iban', currency: 'UAH', language: 'uk' },
    US: { tax: 'sales', rates: [], bank: 'us', currency: 'USD', language: 'en' }
  };
  var OTHER_COUNTRY = { tax: 'vat', rates: [], bank: 'iban', currency: '', language: '' };
  // 'cz': number/bank code. 'iban': an IBAN is the account. 'us': a routing number and an account number.
  var BANK_KINDS = ['cz', 'iban', 'us'];
  // where an IBAN takes a SEPA credit transfer, which is what an EPC payment code asks a banking app to make
  var SEPA = {
    AT: 1, BE: 1, BG: 1, HR: 1, CY: 1, CZ: 1, DK: 1, EE: 1, FI: 1, FR: 1, DE: 1, GR: 1, HU: 1, IS: 1, IE: 1, IT: 1,
    LV: 1, LI: 1, LT: 1, LU: 1, MT: 1, NL: 1, NO: 1, PL: 1, PT: 1, RO: 1, SK: 1, SI: 1, ES: 1, SE: 1, CH: 1, GB: 1,
    MC: 1, SM: 1, AD: 1, VA: 1, AL: 1, MD: 1, ME: 1, MK: 1, RS: 1
  };

  /** The profile of a country code; an empty one is the Czech Republic, which is where every older record is from. */
  function countryProfile(code) {
    var c = String(code == null ? '' : code).toUpperCase() || 'CZ';
    return has(COUNTRIES, c) ? COUNTRIES[c] : OTHER_COUNTRY;
  }

  /**
   * How a document names its tax: { generic, word }. Not generic: VAT, in the words of the document's language.
   * Generic: a subtotal, one tax line called `word` (the name the company gave its tax, or '' for the language's
   * "sales tax"), and a total.
   */
  function taxRegime(invoice) {
    var name = String((invoice && invoice.taxName) || '').trim();
    if (name) return { generic: true, word: name };
    var profile = countryProfile(invoice && invoice.supplier && invoice.supplier.country);
    return { generic: profile.tax === 'sales', word: '' };
  }

  function taxRatesFor(country) { return countryProfile(country).rates.slice(); }

  /** The rate a new line on this company's documents starts with: its own usual rate, else its country's standard one. */
  function defaultTaxRate(supplier) {
    var own = supplier && supplier.defaults ? supplier.defaults.taxRate : null;
    if (own != null && String(own).trim() !== '' && parseNumber(own) >= 0) return parseNumber(own);
    var rates = countryProfile(supplier && supplier.country).rates;
    return rates.length ? rates[0] : 0;
  }

  /** Which way a bank account is written. One saved before there was a choice is read from what it holds. */
  function bankKind(bank, country) {
    var k = bank && bank.kind;
    if (BANK_KINDS.indexOf(k) !== -1) return k;
    if (bank && String(bank.account || '').trim()) return String(bank.routing || '').trim() ? 'us' : 'cz';
    if (bank && cleanIban(bank.iban)) return 'iban';
    return countryProfile(country).bank;
  }

  /**
   * Variable, constant and specific symbols are how a Czech or Slovak bank transfer says what it pays for. They
   * are printed for a Czech account and for a company in those two countries, and nowhere else.
   */
  function usesPaymentSymbols(invoice) {
    var country = String((invoice && invoice.supplier && invoice.supplier.country) || 'CZ').toUpperCase();
    return country === 'CZ' || country === 'SK' || bankKind(invoice && invoice.bank, country) === 'cz';
  }

  /** A US bank routing number: nine digits whose sum weighted 3, 7, 1 is a multiple of ten. */
  function validateRouting(value) {
    var s = String(value == null ? '' : value).replace(/[\s-]/g, '');
    if (!/^\d{9}$/.test(s) || s === '000000000') return false;
    var sum = 0, weights = [3, 7, 1];
    for (var i = 0; i < 9; i++) sum += Number(s.charAt(i)) * weights[i % 3];
    return sum % 10 === 0;
  }

  // ------------------------------------------------------------- numbers

  function has(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }

  function repeat(ch, n) { var s = ''; while (n-- > 0) s += ch; return s; }

  /** "1 210,50" | "1,210.50" | "1210.5" | "−3" -> "1210.50"-style plain string, or '' when it is not a number. */
  function normalizeDecimalString(input) {
    var s = String(input == null ? '' : input).trim()
      .replace(/[\s  ']/g, '')
      .replace(/[−–]/g, '-');
    if (s === '') return '';
    var neg = s.charAt(0) === '-';
    if (neg) s = s.slice(1);
    var commas = s.split(',').length - 1;
    var dots = s.split('.').length - 1;
    if (commas && dots) {
      // the last separator is the decimal mark; the other one may only group the integer part in threes
      var decSep = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
      var grpSep = decSep === ',' ? '.' : ',';
      if ((decSep === ',' ? commas : dots) > 1) return '';
      var di = s.lastIndexOf(decSep);
      var ip = s.slice(0, di);
      if (!new RegExp('^\\d{1,3}(?:\\' + grpSep + '\\d{3})+$').test(ip)) return '';
      s = ip.split(grpSep).join('') + '.' + s.slice(di + 1);
    } else if (commas || dots) {
      var sep = commas ? ',' : '.';
      if (commas + dots > 1) {
        if (!new RegExp('^\\d{1,3}(?:\\' + sep + '\\d{3})+$').test(s)) return '';
        s = s.split(sep).join('');
      } else if (sep === ',') {
        s = s.replace(',', '.');
      }
    }
    return /^(\d+\.?\d*|\.\d+)$/.test(s) ? (neg ? '-' : '') + s : '';
  }

  /** What a person typed -> Number, or NaN. */
  function parseNumber(input) {
    if (typeof input === 'number') return input;
    var s = normalizeDecimalString(input);
    return s === '' ? NaN : Number(s);
  }

  /** Decimal value -> integer scaled by 10^digits, half away from zero, read from the decimal digits (no float maths). */
  function decToInt(value, digits) {
    var s;
    if (typeof value === 'number') {
      if (!isFinite(value)) return 0;
      s = String(value);
      if (s.indexOf('e') !== -1) s = value.toFixed(Math.min(20, digits + 4));
    } else {
      s = normalizeDecimalString(value);
    }
    var m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
    if (!m || (m[2] === '' && !m[3])) return 0;
    var frac = m[3] || '';
    var kept = (frac + repeat('0', digits)).slice(0, digits);
    var n = Number((m[2] || '0') + kept);
    if (frac.length > digits && frac.charCodeAt(digits) - 48 >= 5) n += 1;
    return n === 0 ? 0 : (m[1] === '-' ? -n : n);
  }

  /** round(a * b / d) on integers, half away from zero. */
  function mulDiv(a, b, d) {
    if (!isFinite(a) || !isFinite(b) || !isFinite(d)) return 0;
    var n = BigInt(Math.trunc(a)) * BigInt(Math.trunc(b));
    var D = BigInt(Math.trunc(d));
    if (D === 0n) return 0;
    if (D < 0n) { D = -D; n = -n; }
    var neg = n < 0n;
    if (neg) n = -n;
    var q = (n * 2n + D) / (D * 2n);
    return Number(neg ? -q : q);
  }

  function roundToStep(cents, step) {
    if (!step) return cents;
    return mulDiv(cents, 1, step) * step;
  }

  // --------------------------------------------------------------- dates

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function isIsoDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var d = new Date(s + 'T00:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }

  function addDays(iso, days) {
    if (!isIsoDate(iso)) return '';
    var d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + Math.round(Number(days) || 0));
    if (isNaN(d.getTime()) || d.getUTCFullYear() < 0 || d.getUTCFullYear() > 9999) return '';
    return d.toISOString().slice(0, 10);
  }

  function daysBetween(fromIso, toIso) {
    if (!isIsoDate(fromIso) || !isIsoDate(toIso)) return NaN;
    return Math.round((new Date(toIso + 'T00:00:00Z') - new Date(fromIso + 'T00:00:00Z')) / 86400000);
  }

  /** The phone's or computer's own calendar day, as YYYY-MM-DD. */
  function localToday(now) {
    var d = now || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  // ---------------------------------------------------------- formatting

  var DEFAULT_FORMAT = { date: 'DD. MM. YYYY', decimal: ',', group: ' ', percent: '{n} %', prefixSymbols: [] };

  function fmtOf(format) {
    var f = {};
    var k;
    for (k in DEFAULT_FORMAT) f[k] = DEFAULT_FORMAT[k];
    if (format) for (k in format) if (format[k] != null) f[k] = format[k];
    return f;
  }

  function groupDigits(intStr, sep) {
    return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  }

  /** Integer scaled by 10^scale -> text with between minDec and maxDec decimals. */
  function formatScaled(intValue, scale, minDec, maxDec, format) {
    var f = fmtOf(format);
    var neg = intValue < 0;
    var v = Math.abs(Math.trunc(intValue));
    if (maxDec < scale) { v = mulDiv(v, 1, Math.pow(10, scale - maxDec)); scale = maxDec; }
    var s = String(v);
    if (s.length <= scale) s = repeat('0', scale - s.length + 1) + s;
    var intPart = scale ? s.slice(0, s.length - scale) : s;
    var frac = scale ? s.slice(s.length - scale) : '';
    while (frac.length > minDec && frac.charAt(frac.length - 1) === '0') frac = frac.slice(0, -1);
    while (frac.length < minDec) frac += '0';
    var out = groupDigits(intPart, f.group) + (frac ? f.decimal + frac : '');
    return (neg && /[1-9]/.test(out) ? '-' : '') + out;
  }

  function formatAmount(cents, format) { return formatScaled(cents, 2, 2, 2, format); }

  function currencySymbol(code) {
    for (var i = 0; i < CURRENCIES.length; i++) if (CURRENCIES[i].code === code) return CURRENCIES[i].symbol || code;
    return code || '';
  }

  function formatMoney(cents, currency, format) {
    var f = fmtOf(format);
    var sym = currencySymbol(currency);
    var amount = formatAmount(cents, f);
    if (f.prefixSymbols && f.prefixSymbols.indexOf(sym) !== -1) {
      return amount.charAt(0) === '-' ? '-' + sym + amount.slice(1) : sym + amount;
    }
    return amount + ' ' + sym;
  }

  function formatQty(qty, format) { return formatScaled(decToInt(qty, QTY_DIGITS), QTY_DIGITS, 0, QTY_DIGITS, format); }

  function formatPercent(value, format) {
    var f = fmtOf(format);
    return f.percent.replace('{n}', formatScaled(decToInt(value, 2), 2, 0, 2, f));
  }

  function formatDate(iso, format) {
    if (!isIsoDate(iso)) return '';
    var f = fmtOf(format);
    var y = iso.slice(0, 4), m = Number(iso.slice(5, 7)), d = Number(iso.slice(8, 10));
    return f.date.replace(/YYYY|MMM|MM|M|DD|D/g, function (t) {
      if (t === 'YYYY') return y;
      if (t === 'MMM') return (f.months && f.months[m - 1]) || pad2(m);
      if (t === 'MM') return pad2(m);
      if (t === 'M') return String(m);
      if (t === 'DD') return pad2(d);
      return String(d);
    });
  }

  // ------------------------------------------------- company identifiers

  function digitsOnly(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }

  /** Czech company number (IČO): 8 digits, the last is a mod 11 check digit. */
  function validateIco(value) {
    var s = String(value == null ? '' : value).replace(/\s/g, '');
    if (!/^\d{1,8}$/.test(s)) return false;
    s = repeat('0', 8 - s.length) + s;
    var sum = 0;
    for (var i = 0; i < 7; i++) sum += Number(s.charAt(i)) * (8 - i);
    return (11 - (sum % 11)) % 10 === Number(s.charAt(7));
  }

  // ------------------------------------------------------------- banking

  function mod97(numeric) {
    var rem = 0;
    for (var i = 0; i < numeric.length; i++) rem = (rem * 10 + (numeric.charCodeAt(i) - 48)) % 97;
    return rem;
  }

  function cleanIban(value) { return String(value == null ? '' : value).replace(/[\s -]/g, '').toUpperCase(); }

  // total IBAN length per country (ISO 13616 registry)
  var IBAN_LENGTHS = {
    AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24,
    DE: 22, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28,
    HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20,
    LV: 21, MC: 27, MD: 24, ME: 22, MK: 19, MR: 27, MT: 31, MU: 30, NL: 18, NO: 15, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29,
    RO: 24, RS: 22, SA: 24, SC: 31, SE: 24, SI: 19, SK: 24, SM: 27, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22,
    VG: 24, XK: 20
  };

  function validateIban(value) {
    var s = cleanIban(value);
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
    var cc = s.slice(0, 2);
    if (has(IBAN_LENGTHS, cc) && s.length !== IBAN_LENGTHS[cc]) return false;
    var moved = s.slice(4) + s.slice(0, 4);
    var numeric = '';
    for (var i = 0; i < moved.length; i++) {
      var c = moved.charCodeAt(i);
      numeric += c >= 65 ? String(c - 55) : moved.charAt(i);
    }
    return mod97(numeric) === 1;
  }

  function formatIban(value) { return cleanIban(value).replace(/(.{4})(?=.)/g, '$1 '); }

  /** "19-2000145399/0800" | "2000145399/0800" -> its parts, or null when it is not a Czech account number. */
  function parseCzAccount(value) {
    var s = String(value == null ? '' : value).replace(/[\s ]/g, '');
    var m = /^(?:(\d{1,6})-)?(\d{1,10})\/(\d{4})$/.exec(s);
    if (!m) return null;
    return { prefix: m[1] || '', number: m[2], bank: m[3] };
  }

  function weightedMod11(digits, weights) {
    var sum = 0;
    var offset = weights.length - digits.length;
    for (var i = 0; i < digits.length; i++) sum += Number(digits.charAt(i)) * weights[offset + i];
    return sum % 11 === 0;
  }

  /** The Czech National Bank's mod 11 check of both halves of an account number. */
  function validateCzAccount(value) {
    var a = parseCzAccount(value);
    if (!a) return false;
    if (Number(a.number) === 0) return false;
    return weightedMod11(a.prefix, [10, 5, 8, 4, 2, 1]) && weightedMod11(a.number, [6, 3, 7, 9, 10, 5, 8, 4, 2, 1]);
  }

  /** Czech account number -> IBAN, or '' when the number cannot be read. */
  function czAccountToIban(value) {
    var a = parseCzAccount(value);
    if (!a) return '';
    var bban = a.bank + repeat('0', 6 - a.prefix.length) + a.prefix + repeat('0', 10 - a.number.length) + a.number;
    var check = 98 - mod97(bban + '123500');
    return 'CZ' + pad2(check) + bban;
  }

  /** The IBAN a payment should go to: the one typed, else the one derived from a Czech account number. */
  function resolveIban(bank) {
    if (!bank || bank.kind === 'us') return '';
    var typed = cleanIban(bank.iban);
    if (typed && validateIban(typed)) return typed;
    if (bank.kind === 'iban') return '';
    // an account number that fails the CNB check is a typo: a QR for it would pay somebody else
    if (!validateCzAccount(bank.account)) return '';
    var derived = czAccountToIban(bank.account);
    return derived && validateIban(derived) ? derived : '';
  }

  function stripDiacritics(s) {
    return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  /**
   * ASCII, upper case, no asterisks, cut to `max` and never ending with a space. A percent sign is the escape
   * character of the SPAYD format, so it is sent as %25 (and counted as three characters).
   */
  function qrText(s, max) {
    var clean = stripDiacritics(s).toUpperCase().replace(/[^A-Z0-9 $%+\-./:,]/g, ' ').replace(/\s+/g, ' ').trim();
    var out = '';
    for (var i = 0; i < clean.length; i++) {
      var unit = clean.charAt(i) === '%' ? '%25' : clean.charAt(i);
      if (out.length + unit.length > max) break;
      out += unit;
    }
    return out.replace(/\s+$/, '');
  }

  /** Czech "QR Platba" payload (Short Payment Descriptor 1.0), fields in alphabetical order after ACC. */
  function spayd(o) {
    var iban = cleanIban(o.iban);
    if (!validateIban(iban)) return '';
    var parts = ['SPD', '1.0', 'ACC:' + iban];
    if (o.amountCents > 0) {
      var am = formatScaled(o.amountCents, 2, 2, 2, { decimal: '.', group: '' });
      if (am.length > 10) return ''; // the standard allows 10 characters: it cannot be encoded
      parts.push('AM:' + am);
    }
    if (o.currency) parts.push('CC:' + String(o.currency).toUpperCase());
    if (isIsoDate(o.dueDate)) parts.push('DT:' + o.dueDate.replace(/-/g, ''));
    var msg = qrText(o.message, 60);
    if (msg) parts.push('MSG:' + msg);
    var name = qrText(o.recipient, 35);
    if (name) parts.push('RN:' + name);
    var ks = digitsOnly(o.constantSymbol).slice(0, 10);
    var ss = digitsOnly(o.specificSymbol).slice(0, 10);
    var vs = digitsOnly(o.variableSymbol).slice(0, 10);
    if (ks) parts.push('X-KS:' + ks);
    if (ss) parts.push('X-SS:' + ss);
    if (vs) parts.push('X-VS:' + vs);
    return parts.join('*');
  }

  /** SEPA credit transfer QR (EPC069-12, version 002), euro only. */
  function epcQr(o) {
    var iban = cleanIban(o.iban);
    if (!validateIban(iban) || !(o.amountCents > 0) || o.amountCents > 99999999999) return '';
    var name = stripDiacritics(o.recipient).replace(/[\r\n]+/g, ' ').slice(0, 70).trim();
    if (!name) return '';
    var bic = String(o.bic || '').replace(/\s/g, '').toUpperCase();
    if (!/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic)) bic = '';
    var remittance = stripDiacritics(o.message).replace(/[\r\n]+/g, ' ').slice(0, 140).trim();
    var text = ['BCD', '002', '1', 'SCT', bic, name, iban,
      'EUR' + formatScaled(o.amountCents, 2, 2, 2, { decimal: '.', group: '' }), '', '', remittance].join('\n');
    // trailing elements are optional in EPC069-12: leave them out when there is no remittance text
    return remittance ? text : text.replace(/\n+$/, '');
  }

  // ----------------------------------------------------------- numbering

  function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /**
   * Splits a pattern into literals and tokens. Only ONE run of N is the sequence: the last one that is not a letter
   * inside a word (the N of INV or NAB is text). Any other N is literal.
   */
  function tokenizePattern(pattern) {
    var out = [];
    var re = /YYYY|YY|MM|N+/g;
    var last = 0;
    var m;
    while ((m = re.exec(pattern))) {
      if (m.index > last) out.push({ lit: pattern.slice(last, m.index) });
      var before = m.index > 0 ? pattern.charAt(m.index - 1) : '';
      var after = pattern.charAt(m.index + m[0].length);
      var isRun = m[0].charAt(0) === 'N';
      out.push(isRun
        ? { tok: 'N', len: m[0].length, text: m[0], inWord: /[A-Za-z]/.test(before) && /[A-Za-z]/.test(after) }
        : { tok: m[0], len: m[0].length });
      last = m.index + m[0].length;
    }
    if (last < pattern.length) out.push({ lit: pattern.slice(last) });
    var seq = -1;
    out.forEach(function (t, i) { if (t.tok === 'N' && !t.inWord) seq = i; });
    return out.map(function (t, i) {
      if (t.tok === 'N' && i !== seq) return { lit: t.text };
      return t;
    });
  }

  function hasSequence(pattern) {
    return tokenizePattern(pattern).some(function (t) { return t.tok === 'N'; });
  }

  function normalizePattern(pattern) {
    var p = String(pattern == null ? '' : pattern).trim();
    if (!hasSequence(p)) p = p ? p + 'NNNN' : 'YYYYNNNN';
    return p;
  }

  /** 'YYYYNNNN' + 2026-11-17 + 3 -> '20260003'. Tokens: YYYY, YY, MM and a run of N for the sequence (a number, BigInt or digit string). */
  function formatPattern(pattern, iso, seq) {
    var date = isIsoDate(iso) ? iso : localToday();
    return tokenizePattern(normalizePattern(pattern)).map(function (t) {
      if (t.lit != null) return t.lit;
      if (t.tok === 'YYYY') return date.slice(0, 4);
      if (t.tok === 'YY') return date.slice(2, 4);
      if (t.tok === 'MM') return date.slice(5, 7);
      var s;
      if (typeof seq === 'number') s = isFinite(seq) ? BigInt(Math.trunc(seq)).toString() : '0';
      else s = String(seq);
      return s.length < t.len ? repeat('0', t.len - s.length) + s : s;
    }).join('');
  }

  /** Reads a number back through its pattern: {year, month, seq} or null when it has another shape. seq is a digit string only when it is past 2^53. */
  function matchPattern(pattern, number) {
    var tokens = tokenizePattern(normalizePattern(pattern));
    var names = [];
    var src = tokens.map(function (t) {
      if (t.lit != null) return escapeRegExp(t.lit);
      names.push(t.tok);
      if (t.tok === 'YYYY') return '(\\d{4})';
      if (t.tok === 'YY' || t.tok === 'MM') return '(\\d{2})';
      return '(\\d{' + t.len + ',})';
    }).join('');
    var m = new RegExp('^' + src + '$').exec(String(number == null ? '' : number));
    if (!m) return null;
    var out = { year: null, month: null, seq: null };
    for (var i = 0; i < names.length; i++) {
      var v = m[i + 1];
      if (names[i] === 'YYYY') out.year = v;
      else if (names[i] === 'YY') out.year = out.year || v;
      else if (names[i] === 'MM') out.month = v;
      else if (out.seq == null) {
        var digits = v.replace(/^0+(?=\d)/, '');
        out.seq = digits.length <= 15 ? Number(digits) : digits;
      }
    }
    return out.seq == null ? null : out;
  }

  function incrementTrailingDigits(number) {
    var m = /^(.*?)(\d+)(\D*)$/.exec(number);
    if (!m) return number + '2';
    var next = String(BigInt(m[2]) + 1n);
    if (next.length < m[2].length) next = repeat('0', m[2].length - next.length) + next;
    return m[1] + next + m[3];
  }

  /**
   * The number after `last` for a document issued on `issueDate`.
   * A number that fits the pattern continues it and starts again at 1 when the year (or the month, where the
   * pattern has MM) changes. A number the person wrote in a shape of their own keeps that shape: its last run of
   * digits goes up by one.
   */
  function nextNumber(pattern, last, issueDate) {
    var date = isIsoDate(issueDate) ? issueDate : localToday();
    var p = normalizePattern(pattern);
    if (!last || !last.number) return formatPattern(p, date, 1);
    var hit = matchPattern(p, last.number);
    if (hit) {
      var tokens = tokenizePattern(p);
      var hasYear = tokens.some(function (t) { return t.tok === 'YYYY' || t.tok === 'YY'; });
      var hasMonth = tokens.some(function (t) { return t.tok === 'MM'; });
      var yearNow = tokens.some(function (t) { return t.tok === 'YYYY'; }) ? date.slice(0, 4) : date.slice(2, 4);
      var same = (!hasYear || hit.year === yearNow) && (!hasMonth || hit.month === date.slice(5, 7));
      return formatPattern(p, date, same ? BigInt(hit.seq) + 1n : 1);
    }
    var lastYear = isIsoDate(last.issueDate) ? last.issueDate.slice(0, 4) : '';
    var year = date.slice(0, 4);
    if (lastYear && lastYear !== year) {
      var m = /^(.*?)(\d+)(\D*)$/.exec(last.number);
      if (m && m[1].indexOf(lastYear) !== -1) {
        return m[1].replace(lastYear, year) + repeat('0', Math.max(0, m[2].length - 1)) + '1' + m[3];
      }
    }
    return incrementTrailingDigits(String(last.number));
  }

  /**
   * A free number for a new document. `existing` is the supplier's documents of the same series:
   * [{number, issueDate, createdAt}]. The newest one is continued, and a number already taken is skipped.
   */
  function suggestNumber(pattern, existing, issueDate) {
    var list = (existing || []).filter(function (d) { return d && d.number; });
    // a document dated after the new one (issued ahead, or imported from a later period) is not what it follows
    var date = isIsoDate(issueDate) ? issueDate : localToday();
    var earlier = list.filter(function (d) { return !isIsoDate(d.issueDate) || d.issueDate <= date; });
    var pool = earlier.length ? earlier : list;
    var last = null;
    // the newest by creation time; when that does not tell them apart, by issue date, then by the higher sequence
    function seqOf(d) {
      var hit = matchPattern(pattern, d.number);
      return hit ? BigInt(hit.seq) : -1n;
    }
    function newer(a, b) {
      var ca = String(a.createdAt || ''), cb = String(b.createdAt || '');
      if (ca !== cb) return ca > cb;
      var ia = String(a.issueDate || ''), ib = String(b.issueDate || '');
      if (ia !== ib) return ia > ib;
      return seqOf(a) > seqOf(b);
    }
    pool.forEach(function (d) {
      if (!last || newer(d, last)) last = d;
    });
    var taken = {};
    list.forEach(function (d) { taken[String(d.number)] = true; });
    var candidate = nextNumber(pattern, last, issueDate);
    var guard = 0;
    while (taken[candidate] && guard++ < 10000) {
      candidate = nextNumber(pattern, { number: candidate, issueDate: issueDate }, issueDate);
    }
    return candidate;
  }

  function defaultVariableSymbol(number) { return digitsOnly(number).slice(-10); }

  // -------------------------------------------------------------- totals

  function kindOf(invoice) { return invoice && has(KINDS, invoice.kind) ? KINDS[invoice.kind] : KINDS.invoice_vat; }

  /** 'vat' (VAT is charged), 'none' (the supplier is not a VAT payer) or 'reverse' (the customer accounts for it). */
  function vatModeOf(invoice) {
    var k = kindOf(invoice);
    if (k.vat === 'supplier') return invoice.vatApplies ? 'vat' : 'none';
    return k.vat;
  }

  /** Prices are entered with VAT ('gross') only where VAT is charged; everywhere else a price is the price. */
  function priceModeOf(invoice) {
    return vatModeOf(invoice) === 'vat' && invoice.priceMode === 'gross' ? 'gross' : 'net';
  }

  function split(basis, rateBp, vatMode, priceMode) {
    if (vatMode !== 'vat') return { net: basis, vat: 0, gross: basis };
    if (priceMode === 'gross') {
      var net = mulDiv(basis, 10000, 10000 + rateBp);
      return { net: net, vat: basis - net, gross: basis };
    }
    var vat = mulDiv(basis, rateBp, 10000);
    return { net: basis, vat: vat, gross: basis + vat };
  }

  function rateBpOf(item, vatMode) {
    if (vatMode === 'none') return 0;
    var bp = decToInt(item.vatRate, 2);
    return bp < 0 ? 0 : bp;
  }

  function discountOf(d) {
    if (!d) return null;
    var type = d.type === 'amount' ? 'amount' : 'percent';
    var value = parseNumber(d.value);
    if (!(value > 0)) return null;
    if (type === 'percent' && value > 100) value = 100;
    return { type: type, value: value };
  }

  /**
   * Every amount of a document, in cents.
   * VAT is worked out line by line and the lines are added up, so the columns of the table always sum to the totals.
   * Returns { vatMode, priceMode, lines, byRate, net, vat, gross, rounding, payable }.
   */
  function computeTotals(invoice) {
    var vatMode = vatModeOf(invoice);
    var priceMode = priceModeOf(invoice);
    var lines = [];
    var groups = {};
    var groupOrder = [];

    var groupNet = {}, groupVat = {};

    function addToGroup(rateBp, basis, parts) {
      if (!(rateBp in groups)) { groups[rateBp] = 0; groupNet[rateBp] = 0; groupVat[rateBp] = 0; groupOrder.push(rateBp); }
      groups[rateBp] += basis;
      groupNet[rateBp] += parts.net;
      groupVat[rateBp] += parts.vat;
    }

    // The parts of a discount of `off` (signed, in the typed price basis) taken from something that stands at
    // {net, vat, basis} now. What remains is split again as a whole (with prices typed with VAT that is also what
    // gives the net), so a fully discounted line or rate leaves exactly 0 / 0 / 0, and a part discounted one has
    // the VAT of what remains, never a rounding cent more or less.
    function discountParts(now, off, rateBp) {
      var after = split(now.basis + off, rateBp, vatMode, priceMode);
      return { net: after.net - now.net, vat: after.vat - now.vat, gross: after.gross - (now.net + now.vat) };
    }

    (invoice.items || []).forEach(function (item) {
      var qtyInt = decToInt(item.qty, QTY_DIGITS);
      var priceInt = decToInt(item.price, PRICE_DIGITS);
      var rateBp = rateBpOf(item, vatMode);
      var basis = mulDiv(qtyInt, priceInt, Math.pow(10, QTY_DIGITS + PRICE_DIGITS - 2));
      var parts = split(basis, rateBp, vatMode, priceMode);
      // with prices entered with VAT, the unit price shown is the line's net amount per unit, so quantity times it is the line
      var unitNet = priceInt;
      if (vatMode === 'vat' && priceMode === 'gross') {
        unitNet = qtyInt !== 0 ? mulDiv(parts.net * 100, Math.pow(10, QTY_DIGITS), qtyInt) : mulDiv(priceInt, 10000, 10000 + rateBp);
      }
      lines.push({
        kind: 'item', itemId: item.id, description: String(item.description || ''), qty: qtyInt, unit: String(item.unit || ''),
        rateBp: rateBp, unitNet: unitNet, basis: basis, net: parts.net, vat: parts.vat, gross: parts.gross
      });
      addToGroup(rateBp, basis, parts);

      // a discount takes from the size of the line, whatever its sign: a credit line is reduced towards zero
      var d = discountOf(item.discount);
      if (d && basis !== 0) {
        var sign = basis < 0 ? -1 : 1;
        var size = Math.abs(basis);
        var cut = d.type === 'percent' ? mulDiv(size, decToInt(d.value, 2), 10000) : Math.min(decToInt(d.value, 2), size);
        if (cut > 0) {
          var off = -sign * cut;
          var dp = discountParts({ net: parts.net, vat: parts.vat, basis: basis }, off, rateBp);
          lines.push({
            kind: 'item_discount', itemId: item.id, description: String(item.description || ''), qty: null, unit: '',
            rateBp: rateBp, unitNet: dp.net * 100, basis: off, net: dp.net, vat: dp.vat, gross: dp.gross, discount: d
          });
          addToGroup(rateBp, off, dp);
        }
      }
    });

    var dd = discountOf(invoice.documentDiscount);
    if (dd) {
      // the discount follows the sign of the document: rates with a positive total, or, when none has one, the negative ones
      var picked = groupOrder.filter(function (bp) { return groups[bp] > 0; });
      var dsign = 1;
      if (!picked.length) {
        picked = groupOrder.filter(function (bp) { return groups[bp] < 0; });
        dsign = -1;
      }
      var totalBasis = picked.reduce(function (sum, bp) { return sum + Math.abs(groups[bp]); }, 0);
      if (totalBasis > 0) {
        var shares = {};
        if (dd.type === 'percent') {
          picked.forEach(function (bp) { shares[bp] = mulDiv(Math.abs(groups[bp]), decToInt(dd.value, 2), 10000); });
        } else {
          var target = Math.min(decToInt(dd.value, 2), totalBasis);
          var given = 0;
          var largest = picked[0];
          picked.forEach(function (bp) {
            shares[bp] = Math.min(Math.abs(groups[bp]), mulDiv(target, Math.abs(groups[bp]), totalBasis));
            given += shares[bp];
            if (Math.abs(groups[bp]) > Math.abs(groups[largest])) largest = bp;
          });
          shares[largest] += target - given;
        }
        picked.forEach(function (bp) {
          var cut = shares[bp];
          if (!(cut > 0)) return;
          var off = -dsign * cut;
          var parts = discountParts({ net: groupNet[bp], vat: groupVat[bp], basis: groups[bp] }, off, bp);
          lines.push({
            kind: 'doc_discount', itemId: null, description: '', qty: null, unit: '',
            rateBp: bp, unitNet: parts.net * 100, basis: off, net: parts.net, vat: parts.vat, gross: parts.gross, discount: dd
          });
        });
      }
    }

    var byRateMap = {};
    var net = 0, vat = 0, gross = 0;
    lines.forEach(function (l) {
      var r = byRateMap[l.rateBp] || (byRateMap[l.rateBp] = { rateBp: l.rateBp, net: 0, vat: 0, gross: 0 });
      r.net += l.net; r.vat += l.vat; r.gross += l.gross;
      net += l.net; vat += l.vat; gross += l.gross;
    });
    var byRate = Object.keys(byRateMap).map(function (k) { return byRateMap[k]; })
      .sort(function (a, b) { return b.rateBp - a.rateBp; });

    var payable = roundToStep(gross, (has(ROUNDING_STEPS, invoice.rounding) ? ROUNDING_STEPS[invoice.rounding] : 0));
    return {
      vatMode: vatMode, priceMode: priceMode, lines: lines, byRate: byRate,
      net: net, vat: vat, gross: gross, rounding: payable - gross, payable: payable
    };
  }

  // ----------------------------------------------------- document status

  /** 'draft' | 'issued' | 'overdue' | 'paid'. A quote is never overdue. */
  function statusOf(invoice, today) {
    invoice = invoice || {};
    if (invoice.status === 'paid') return 'paid';
    if (invoice.status !== 'issued') return 'draft';
    if (kindOf(invoice).payable && isIsoDate(invoice.dueDate) && isIsoDate(today) && invoice.dueDate < today) return 'overdue';
    return 'issued';
  }

  // ------------------------------------------------------------- overview

  // What counts as income: invoices, advance invoices and corrective documents. Quotations and proformas do not:
  // a quotation is not a claim, and a proforma is followed by the invoice that would count the same money twice.
  var INCOME_SERIES = { invoice: true, advance: true, corrective: true };

  function countsAsIncome(invoice) { return !!INCOME_SERIES[kindOf(invoice).series]; }

  /** '2026-11-17' -> '2026-11' | '2026-Q4' | '2026'. '' for anything that is not a date. */
  function periodKey(iso, granularity) {
    if (!isIsoDate(iso)) return '';
    if (granularity === 'year') return iso.slice(0, 4);
    if (granularity === 'quarter') return iso.slice(0, 4) + '-Q' + (Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1);
    return iso.slice(0, 7);
  }

  /**
   * The periods an overview shows, oldest first, ending with the one `today` is in: the same month a year ago
   * through to this month (13), the last eight quarters, or up to six years starting no earlier than `firstYear`.
   */
  function periodKeys(today, granularity, firstYear) {
    var day = isIsoDate(today) ? today : localToday();
    var y = Number(day.slice(0, 4)), m = Number(day.slice(5, 7));
    var keys = [];
    if (granularity === 'year') {
      var from = Math.max(y - 5, Math.min(y, Number(firstYear) || y));
      for (var yy = from; yy <= y; yy++) keys.push(String(yy));
      return keys;
    }
    if (granularity === 'quarter') {
      var q = Math.floor((m - 1) / 3);
      for (var i = 7; i >= 0; i--) {
        var qi = y * 4 + q - i;
        keys.push(Math.floor(qi / 4) + '-Q' + (qi % 4 + 1));
      }
      return keys;
    }
    for (var j = 12; j >= 0; j--) {
      var mi = y * 12 + (m - 1) - j;
      keys.push(Math.floor(mi / 12) + '-' + pad2(mi % 12 + 1));
    }
    return keys;
  }

  /**
   * What was invoiced, or received, period by period.
   * opts: { today, granularity: 'month' | 'quarter' | 'year', measure: 'issued' | 'paid', currency, supplierId }.
   * Returns { currency, currencies, granularity, measure, periods: [{ key, amount, net, vat, count }],
   *   total: { amount, net, vat, count }, statuses: { paid, waiting, overdue, draft } each { amount, count },
   *   customers: [{ name, amount, count }] }.
   * Amounts are cents of what each document asks to be paid, VAT included. A draft is counted only among the drafts.
   * "Issued" places a document in the period of its issue date; "paid" places a paid document in the period it was
   * paid in (its due date, then its issue date, when no payment date was recorded). The statuses always describe the
   * documents issued in the periods shown. Currencies are never added together: one is shown at a time.
   */
  function overview(invoices, opts) {
    opts = opts || {};
    var today = isIsoDate(opts.today) ? opts.today : localToday();
    var granularity = opts.granularity === 'quarter' || opts.granularity === 'year' ? opts.granularity : 'month';
    var measure = opts.measure === 'paid' ? 'paid' : 'issued';
    var docs = (invoices || []).filter(function (d) {
      return d && countsAsIncome(d) && (!opts.supplierId || d.supplierId === opts.supplierId);
    });
    // where a document stands on the time axis: its issue date, or under "paid" the day it was paid; '' when it has no place there
    function placeOf(d, status) {
      if (status === 'draft') return '';
      if (measure !== 'paid') return d.issueDate;
      if (status !== 'paid') return '';
      return isIsoDate(d.paidDate) ? d.paidDate : (isIsoDate(d.dueDate) ? d.dueDate : d.issueDate);
    }
    function oldestYear(list) {
      var year = Number(today.slice(0, 4));
      list.forEach(function (d) { if (isIsoDate(d.issueDate)) year = Math.min(year, Number(d.issueDate.slice(0, 4))); });
      return year;
    }

    // The currency shown when none is asked for is the one with the most documents in the periods on screen, so
    // the page never opens on a currency last used years ago; with nothing on screen at all, the most used one.
    var perCurrency = Object.create(null);
    var onScreen = Object.create(null);
    var shownKeys = Object.create(null);
    periodKeys(today, granularity, oldestYear(docs)).forEach(function (key) { shownKeys[key] = true; });
    docs.forEach(function (d) {
      var code = String(d.currency || 'CZK');
      perCurrency[code] = (perCurrency[code] || 0) + 1;
      if (shownKeys[periodKey(placeOf(d, statusOf(d, today)), granularity)]) onScreen[code] = (onScreen[code] || 0) + 1;
    });
    var currencies = Object.keys(perCurrency).sort(function (a, b) { return perCurrency[b] - perCurrency[a] || (a < b ? -1 : 1); });
    var favourite = currencies.slice().sort(function (a, b) { return (onScreen[b] || 0) - (onScreen[a] || 0); })[0];
    var currency = opts.currency && perCurrency[opts.currency] ? opts.currency : (favourite || 'CZK');
    docs = docs.filter(function (d) { return String(d.currency || 'CZK') === currency; });

    var firstYear = oldestYear(docs);
    var index = Object.create(null);
    var periods = periodKeys(today, granularity, firstYear).map(function (key, i) {
      index[key] = i;
      return { key: key, amount: 0, net: 0, vat: 0, count: 0 };
    });
    var total = { amount: 0, net: 0, vat: 0, count: 0 };
    var statuses = { paid: { amount: 0, count: 0 }, waiting: { amount: 0, count: 0 }, overdue: { amount: 0, count: 0 }, draft: { amount: 0, count: 0 } };
    var byCustomer = Object.create(null);

    docs.forEach(function (d) {
      var t = computeTotals(d);
      var status = statusOf(d, today);
      if (index[periodKey(d.issueDate, granularity)] !== undefined) {
        var slot = status === 'issued' ? statuses.waiting : statuses[status];
        // a credit is not money someone owes us: it is never "waiting" or "overdue", it stands with what is settled
        if (t.payable < 0 && (status === 'issued' || status === 'overdue')) slot = statuses.paid;
        slot.amount += t.payable;
        slot.count += 1;
      }
      var when = placeOf(d, status);
      if (!when) return;
      var at = index[periodKey(when, granularity)];
      if (at === undefined) return;
      var p = periods[at];
      p.amount += t.payable; p.net += t.net; p.vat += t.vat; p.count += 1;
      total.amount += t.payable; total.net += t.net; total.vat += t.vat; total.count += 1;
      var name = String((d.customer && d.customer.name) || '').trim();
      var c = byCustomer[name] || (byCustomer[name] = { name: name, amount: 0, count: 0 });
      c.amount += t.payable;
      c.count += 1;
    });
    var customers = Object.keys(byCustomer).map(function (k) { return byCustomer[k]; })
      .sort(function (a, b) { return b.amount - a.amount || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
    return {
      currency: currency, currencies: currencies, granularity: granularity, measure: measure,
      periods: periods, total: total, statuses: statuses, customers: customers
    };
  }

  // ------------------------------------------------------------ creation

  function uid() {
    var s = '';
    var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var cryptoObj = typeof crypto !== 'undefined' ? crypto : null;
    if (cryptoObj && cryptoObj.getRandomValues) {
      var buf = new Uint8Array(16);
      cryptoObj.getRandomValues(buf);
      for (var i = 0; i < buf.length; i++) s += chars.charAt(buf[i] % chars.length);
    } else {
      for (var j = 0; j < 16; j++) s += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return s;
  }

  function emptyParty() {
    return { name: '', companyNumber: '', taxNumber: '', street: '', city: '', postcode: '', country: 'CZ', email: '', phone: '', web: '' };
  }

  function emptyBank() { return { kind: '', account: '', accountName: '', iban: '', swift: '', routing: '', bankName: '', showIban: false, hidden: false }; }

  var SUPPLIER_DEFAULTS = {
    dueDays: 14, currency: 'CZK', language: 'cs', paymentMethod: 'transfer', rounding: 'none', template: 'modern',
    color: '#1d4e89', numberPattern: 'YYYYNNNN', issuedBy: '', note: '', priceMode: 'net', showQr: true, signatureLine: false, taxRate: ''
  };

  function partySnapshot(company) {
    var out = emptyParty();
    if (company) for (var k in out) if (company[k] != null) out[k] = String(company[k]);
    return out;
  }

  function newCompany(kind) {
    var c = emptyParty();
    c.id = uid();
    c.kind = kind === 'customer' ? 'customer' : 'supplier';
    if (c.kind === 'supplier') {
      c.vatPayer = false;
      c.taxName = '';              // what the tax is called on documents; '' is VAT (or the country's own tax)
      c.registerNote = '';
      c.bank = emptyBank();
      c.logo = null;
      c.stamp = null;
      c.defaults = JSON.parse(JSON.stringify(SUPPLIER_DEFAULTS));
    }
    return c;
  }

  /**
   * A company whose country was just changed from `before`: its usual currency and document language follow, as
   * long as they were still what the old country gave it. What the person chose themselves is left alone.
   */
  function followCountry(company, before) {
    if (!company || !company.defaults) return company;
    var was = countryProfile(before), now = countryProfile(company.country);
    if (now.currency && company.defaults.currency === (was.currency || SUPPLIER_DEFAULTS.currency)) company.defaults.currency = now.currency;
    if (now.language && company.defaults.language === (was.language || SUPPLIER_DEFAULTS.language)) company.defaults.language = now.language;
    return company;
  }

  function newItem(vatRate) {
    return { id: uid(), qty: 1, unit: '', description: '', vatRate: vatRate == null ? 0 : vatRate, price: 0, discount: null };
  }

  /**
   * A new document for a supplier. `opts`: { today, kind, existing } where existing is every saved document
   * (the ones of this supplier and series are read for the next number).
   */
  function newInvoice(supplier, opts) {
    opts = opts || {};
    var today = isIsoDate(opts.today) ? opts.today : localToday();
    var d = {};
    var k;
    for (k in SUPPLIER_DEFAULTS) d[k] = SUPPLIER_DEFAULTS[k];
    if (supplier && supplier.defaults) for (k in supplier.defaults) if (supplier.defaults[k] != null) d[k] = supplier.defaults[k];
    var vatPayer = !!(supplier && supplier.vatPayer);
    var kind = has(KINDS, opts.kind) ? opts.kind : (vatPayer ? 'invoice_vat' : 'invoice_novat');
    var series = KINDS[kind].series;
    var existing = (opts.existing || []).filter(function (x) {
      return x && supplier && x.supplierId === supplier.id && kindOf(x).series === series;
    });
    var number = suggestNumber(d.numberPattern, existing, today);
    var bank = emptyBank();
    if (supplier && supplier.bank) for (k in bank) if (supplier.bank[k] != null) bank[k] = supplier.bank[k];
    var dueDays = Number(d.dueDays);
    if (!(dueDays >= 0)) dueDays = 14;
    return {
      id: uid(), supplierId: supplier ? supplier.id : null, customerId: null, kind: kind, vatApplies: vatPayer,
      taxName: (supplier && supplier.taxName) || '',
      number: number, recordNumber: '', variableSymbol: defaultVariableSymbol(number), constantSymbol: '', specificSymbol: '',
      orderNumber: '', issuedBy: d.issuedBy || '',
      issueDate: today, taxDate: today, dueIn: dueDays, dueDate: addDays(today, dueDays),
      paymentMethod: d.paymentMethod, bank: bank,
      language: d.language, currency: d.currency, registerNote: (supplier && supplier.registerNote) || '',
      showQr: d.showQr !== false, showSignature: !!d.signatureLine, rounding: d.rounding, template: d.template, color: d.color,
      supplier: partySnapshot(supplier), customer: emptyParty(),
      priceMode: d.priceMode === 'gross' ? 'gross' : 'net',
      items: [newItem(vatPayer ? defaultTaxRate(supplier) : 0)], documentDiscount: null, note: d.note || '',
      correctedNumber: '', correctionReason: '', exchangeRate: '',
      status: 'draft', paidDate: '', createdAt: '', updatedAt: ''
    };
  }

  /** Fills whatever a stored document is missing, so older or imported data never breaks a screen. */
  function normalizeInvoice(inv) {
    var base = newInvoice(null, { today: (inv && isIsoDate(inv.issueDate)) ? inv.issueDate : undefined });
    var out = {};
    var k;
    for (k in base) out[k] = base[k];
    if (inv) for (k in inv) if (inv[k] != null) out[k] = inv[k];
    if (!has(KINDS, out.kind)) out.kind = 'invoice_vat';
    out.supplier = Object.assign(emptyParty(), out.supplier || {});
    out.customer = Object.assign(emptyParty(), out.customer || {});
    out.bank = Object.assign(emptyBank(), out.bank || {});
    out.items = Array.isArray(out.items) ? out.items.map(function (it) {
      var item = Object.assign(newItem(0), it || {});
      if (!item.id) item.id = uid();
      return item;
    }) : [];
    if (out.status !== 'issued' && out.status !== 'paid') out.status = 'draft';
    if (!has(ROUNDING_STEPS, out.rounding)) out.rounding = 'none';
    if (PAYMENT_METHODS.indexOf(out.paymentMethod) === -1) out.paymentMethod = 'transfer';
    return out;
  }

  /** A copy to issue again: a new id and number, today's dates, and a draft. */
  function duplicateInvoice(inv, opts) {
    inv = inv || {};
    opts = opts || {};
    var today = isIsoDate(opts.today) ? opts.today : localToday();
    var copy = normalizeInvoice(JSON.parse(JSON.stringify(inv)));
    copy.id = uid();
    copy.items.forEach(function (it) { it.id = uid(); });
    var series = kindOf(copy).series;
    var existing = (opts.existing || []).filter(function (x) {
      return x && x.supplierId === copy.supplierId && kindOf(x).series === series;
    });
    copy.number = suggestNumber(opts.pattern || SUPPLIER_DEFAULTS.numberPattern, existing, today);
    copy.recordNumber = '';
    copy.variableSymbol = defaultVariableSymbol(copy.number);
    copy.issueDate = today;
    copy.taxDate = today;
    var dueIn = copy.dueIn === 'custom' ? daysBetween(inv.issueDate, inv.dueDate) : Number(copy.dueIn);
    if (!(dueIn >= 0)) dueIn = 14;
    copy.dueDate = addDays(today, dueIn);
    copy.status = 'draft';
    copy.paidDate = '';
    copy.exchangeRate = '';      // a rate belongs to a day: the copy is dated today and asks for today's
    copy.createdAt = '';
    copy.updatedAt = '';
    return copy;
  }

  // ---------------------------------------------------------- view model

  function fill(template, values) {
    return String(template == null ? '' : template).replace(/\{(\w+)\}/g, function (_, k) { return values[k] == null ? '' : values[k]; });
  }

  /**
   * What a party's two numbers are called. In most countries the document's language has the words; where a
   * country has names of its own that a reader there looks for, those are used.
   */
  function idLabels(party, L, language, otherTax) {
    var country = String(party.country || '').toUpperCase();
    var taxId = (L.sales && L.sales.taxId) || 'Tax ID';
    if (country === 'UA') {
      var cyrillic = language === 'uk';
      // a company has an eight-digit code in the state register; a person in business has a ten-digit tax number
      var person = digitsOnly(party.companyNumber).length === 10;
      return {
        company: person ? (cyrillic ? 'РНОКПП' : 'Tax no. (RNOKPP)') : (cyrillic ? 'ЄДРПОУ' : 'EDRPOU'),
        tax: cyrillic ? 'ІПН' : 'VAT no. (IPN)'
      };
    }
    if (country === 'US') return { company: 'EIN', tax: taxId };
    // a company whose tax is not VAT has a tax number, not a VAT number
    return { company: L.companyNumber, tax: otherTax ? taxId : L.taxNumber };
  }

  function partyBlock(role, party, L, countryName, extra, language, otherTax) {
    var address = [];
    if (party.street) address.push(party.street);
    var cityLine = [party.postcode, party.city].filter(Boolean).join(' ');
    if (cityLine) address.push(cityLine);
    var ids = [];
    var names = idLabels(party, L, language, otherTax);
    if (party.companyNumber) ids.push({ label: names.company, value: party.companyNumber });
    if (party.taxNumber) ids.push({ label: names.tax, value: party.taxNumber });
    // a country alone says nothing: it is printed only under a party that has something else filled in
    if (party.country && (party.name || address.length || ids.length)) address.push(countryName(party.country));
    var contacts = [party.phone, party.email, party.web].filter(Boolean);
    return {
      role: role, heading: role === 'supplier' ? L.supplier : L.customer, name: party.name || '',
      address: address, ids: ids, badges: (extra && extra.badges) || [], extra: (extra && extra.extra) || [], contacts: contacts
    };
  }

  /** Which payment QR a document carries: {type: 'spayd'|'epc', text} or null. */
  function paymentQr(invoice, totals) {
    var kind = kindOf(invoice);
    if (!kind.payable || !invoice.showQr || invoice.paymentMethod !== 'transfer') return null;
    if (invoice.bank && invoice.bank.hidden) return null;
    if (!(totals.payable > 0)) return null;
    var iban = resolveIban(invoice.bank);
    if (!iban) return null;
    var currency = String(invoice.currency || 'CZK').toUpperCase();
    var message = invoice.number ? String(invoice.number) : '';
    var foreignCustomer = invoice.customer && invoice.customer.country && invoice.customer.country !== 'CZ';
    if (currency === 'EUR' && has(SEPA, iban.slice(0, 2)) && (iban.slice(0, 2) !== 'CZ' || foreignCustomer)) {
      var epc = epcQr({ iban: iban, bic: invoice.bank.swift, amountCents: totals.payable, recipient: invoice.supplier && invoice.supplier.name, message: message });
      if (epc) return { type: 'epc', text: epc };
    }
    if (iban.slice(0, 2) !== 'CZ') return null;
    var text = spayd({
      iban: iban, amountCents: totals.payable, currency: currency,
      variableSymbol: invoice.variableSymbol, constantSymbol: invoice.constantSymbol, specificSymbol: invoice.specificSymbol,
      dueDate: invoice.dueDate, message: message,
      // the name a banking app shows for the payee: the supplier, not whatever the app calls the account
      recipient: invoice.supplier && invoice.supplier.name
    });
    return text ? { type: 'spayd', text: text } : null;
  }

  /** A logo or stamp is a PNG or JPEG data URL with a real size; anything else (a remote address, SVG, script) is dropped. */
  function normalizeImage(img) {
    if (!img || typeof img !== 'object' || typeof img.src !== 'string') return null;
    if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(img.src)) return null;
    var w = Number(img.w), h = Number(img.h);
    if (!(w > 0) || !(h > 0) || !isFinite(w) || !isFinite(h)) return null;
    return { src: img.src, w: w, h: h };
  }

  function safeFileName(s) {
    return stripDiacritics(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  }

  /**
   * Everything the page of a document says, already in the document's language and number format.
   * ctx: { labels (one language of InvoiceI18n), countryName(code) -> string, images: { logo, stamp } each {src, w, h} or null }.
   * The shape is the contract with render.js; see SPEC.md.
   */
  function buildViewModel(invoiceInput, ctx) {
    var invoice = normalizeInvoice(invoiceInput);
    var L = ctx.labels;
    var F = L.format;
    var countryName = ctx.countryName || function (code) { return code; };
    var images = ctx.images || {};
    var kind = kindOf(invoice);
    var totals = computeTotals(invoice);
    var vatMode = totals.vatMode;
    var currency = invoice.currency || 'CZK';
    var money = function (c) { return formatMoney(c, currency, F); };
    var amount = function (c) { return formatAmount(c, F); };

    // A tax that is not VAT: a subtotal, one tax line and a total, and none of what only a VAT document carries.
    var regime = taxRegime(invoice);
    var sales = L.sales || {};
    var taxWord = regime.word || sales.tax || 'Sales tax';
    var titleKind = invoice.kind;
    if (regime.generic && titleKind === 'invoice_vat') titleKind = 'invoice_novat';
    if (regime.generic && titleKind === 'quote_vat') titleKind = 'quote_novat';
    if (regime.generic && titleKind === 'reverse_charge') titleKind = 'invoice_novat';
    var docTitle = (L.docTitle && L.docTitle[titleKind]) || '';
    if (regime.generic && titleKind === 'corrective' && sales.corrective) docTitle = sales.corrective;
    var sub = [];
    if (invoice.recordNumber && invoice.recordNumber !== invoice.number) sub.push(L.recordNumber + ' ' + invoice.recordNumber);
    if (invoice.kind === 'corrective' && invoice.correctedNumber) sub.push(fill(L.notes.correctiveFor, { number: invoice.correctedNumber }));

    var supplierBadges = [];
    if (regime.generic) supplierBadges = [];
    else if (vatMode === 'none' && kind.series !== 'quote') supplierBadges.push(L.nonVatPayer);
    else if (vatMode !== 'none') supplierBadges.push(L.vatPayer);
    var parties = [
      partyBlock('supplier', invoice.supplier, L, countryName, {
        badges: supplierBadges,
        extra: invoice.registerNote ? [invoice.registerNote] : []
      }, invoice.language, regime.generic),
      partyBlock('customer', invoice.customer, L, countryName, null, invoice.language)
    ];

    var payment = null;
    if (kind.payable) {
      var rows = [];
      var bank = invoice.bank || {};
      if (invoice.paymentMethod === 'transfer' && !bank.hidden) {
        var holder = bank.accountName ? ' (' + bank.accountName + ')' : '';
        var bankName = String(bank.bankName || '').trim();
        var written = bankKind(bank, invoice.supplier.country);
        if (written === 'us') {
          // a transfer inside the United States names the bank by its routing number; a wire from abroad by its SWIFT code
          if (bankName) rows.push({ label: L.bankName || 'Bank', value: bankName });
          if (String(bank.routing || '').trim()) rows.push({ label: L.routing || 'ABA routing no.', value: String(bank.routing).replace(/[\s-]/g, '') });
          if (bank.account) rows.push({ label: L.bankAccount, value: bank.account + holder });
          if (bank.swift) rows.push({ label: L.swift, value: String(bank.swift).toUpperCase() });
        } else if (written === 'iban') {
          var only = cleanIban(bank.iban);
          // an account read as an IBAN only because nothing else was filled in prints as it always did, without the holder
          if (only) rows.push({ label: L.iban, value: formatIban(only) + (bank.kind === 'iban' ? holder : '') });
          if (bank.swift) rows.push({ label: L.swift, value: String(bank.swift).toUpperCase() });
          if (bankName) rows.push({ label: L.bankName || 'Bank', value: bankName });
        } else {
          if (bank.account) rows.push({ label: L.bankAccount, value: bank.account + holder });
          var typedIban = cleanIban(bank.iban);
          var iban = typedIban || (bank.showIban ? czAccountToIban(bank.account) : '');
          if (iban && (bank.showIban || !bank.account)) rows.push({ label: L.iban, value: formatIban(iban) });
          if (bank.swift && (bank.showIban || !bank.account)) rows.push({ label: L.swift, value: String(bank.swift).toUpperCase() });
        }
      }
      rows.push({ label: L.paymentMethod, value: (L.paymentMethods && L.paymentMethods[invoice.paymentMethod]) || invoice.paymentMethod });
      // a payment symbol is digits only and at most ten of them: print exactly what the QR code carries.
      // A transfer to a US account has no such thing: the invoice number goes in its memo.
      var symbols = usesPaymentSymbols(invoice);
      var symVs = symbols ? digitsOnly(invoice.variableSymbol).slice(0, 10) : '';
      var symKs = symbols ? digitsOnly(invoice.constantSymbol).slice(0, 10) : '';
      var symSs = symbols ? digitsOnly(invoice.specificSymbol).slice(0, 10) : '';
      if (symVs) rows.push({ label: L.variableSymbol, value: symVs });
      if (symKs) rows.push({ label: L.constantSymbol, value: symKs });
      if (symSs) rows.push({ label: L.specificSymbol, value: symSs });
      payment = { heading: L.paymentDetails, rows: rows };
    }

    var dates = [{ label: L.issueDate, value: formatDate(invoice.issueDate, F) }];
    if (invoice.dueDate) dates.push({ label: kind.payable ? L.dueDate : L.validUntil, value: formatDate(invoice.dueDate, F) });
    if (kind.taxDocument && invoice.taxDate && !regime.generic) dates.push({ label: L.taxDate, value: formatDate(invoice.taxDate, F) });
    if (invoice.orderNumber) dates.push({ label: L.orderNumber, value: invoice.orderNumber });

    var qr = paymentQr(invoice, totals);

    var rateLabel = regime.generic ? (sales.taxRate || 'Tax rate') : L.col.vatRate;
    var columns;
    if (vatMode === 'vat') {
      columns = [
        { key: 'qty', label: L.col.qty, align: 'right' }, { key: 'description', label: L.col.description, align: 'left' },
        { key: 'unitPrice', label: L.col.unitPrice, align: 'right' }, { key: 'vatRate', label: rateLabel, align: 'right' },
        { key: 'net', label: regime.generic ? (sales.net || 'Net') : L.col.net, align: 'right' }, { key: 'vat', label: regime.generic ? taxWord : L.col.vat, align: 'right' },
        { key: 'total', label: L.col.total, align: 'right' }
      ];
    } else if (vatMode === 'reverse') {
      columns = [
        { key: 'qty', label: L.col.qty, align: 'right' }, { key: 'description', label: L.col.description, align: 'left' },
        { key: 'unitPrice', label: L.col.unitPrice, align: 'right' }, { key: 'vatRate', label: rateLabel, align: 'right' },
        { key: 'total', label: L.col.total, align: 'right' }
      ];
    } else {
      columns = [
        { key: 'qty', label: L.col.qty, align: 'right' }, { key: 'description', label: L.col.description, align: 'left' },
        { key: 'unitPrice', label: L.col.unitPrice, align: 'right' }, { key: 'total', label: L.col.total, align: 'right' }
      ];
    }

    var rowsOut = totals.lines.map(function (l) {
      var description = l.description;
      // a discount row names its item by the first line only, not by the whole description again
      var firstLine = String(l.description || '').split('\n')[0].trim();
      if (l.kind === 'item_discount') {
        description = L.discount + (l.discount.type === 'percent' ? ' ' + formatPercent(l.discount.value, F) : '') + (firstLine ? ' – ' + firstLine : '');
      } else if (l.kind === 'doc_discount') {
        description = L.documentDiscount + (l.discount.type === 'percent' ? ' ' + formatPercent(l.discount.value, F) : '');
      }
      var qty = l.qty == null ? '' : formatScaled(l.qty, QTY_DIGITS, 0, QTY_DIGITS, F) + (l.unit ? ' ' + (L.units && has(L.units, l.unit) && typeof L.units[l.unit] === 'string' ? L.units[l.unit] : l.unit) : '');
      return {
        kind: l.kind === 'item' ? 'item' : 'discount',
        cells: {
          qty: qty, description: description,
          unitPrice: formatScaled(l.unitNet, PRICE_DIGITS, 2, PRICE_DIGITS, F),
          vatRate: formatPercent(l.rateBp / 100, F),
          net: amount(l.net), vat: amount(l.vat), total: amount(vatMode === 'vat' ? l.gross : l.net)
        }
      };
    });

    var vatSummary = null;
    if (vatMode === 'vat' && totals.byRate.length) {
      vatSummary = {
        columns: [
          { key: 'rate', label: regime.generic ? rateLabel : L.summary.rate, align: 'left' },
          { key: 'base', label: regime.generic ? (sales.taxable || 'Taxable amount') : L.summary.base, align: 'right' },
          { key: 'vat', label: regime.generic ? taxWord : L.summary.vat, align: 'right' }, { key: 'total', label: L.summary.total, align: 'right' }
        ],
        rows: totals.byRate.map(function (r) {
          return { cells: { rate: formatPercent(r.rateBp / 100, F), base: amount(r.net), vat: amount(r.vat), total: amount(r.gross) } };
        }),
        footer: { cells: { rate: L.total, base: amount(totals.net), vat: amount(totals.vat), total: amount(totals.gross) } }
      };
    }

    var totalRows = [];
    if (vatMode === 'vat') {
      totalRows.push({ label: regime.generic ? (sales.subtotal || 'Subtotal') : L.totalNet, value: money(totals.net) });
      totalRows.push({ label: regime.generic ? taxWord : L.totalVat, value: money(totals.vat) });
    }
    if (totals.rounding !== 0) totalRows.push({ label: L.rounding, value: money(totals.rounding) });
    var grandLabel = L.totalDue;
    if (!kind.payable) grandLabel = vatMode === 'vat' && !regime.generic ? L.totalGross : L.total;
    else if (totals.payable < 0) grandLabel = L.total;

    var notes = [];
    // the sentences of VAT law are for VAT documents; another tax has no such thing to say
    if (vatMode === 'reverse' && !regime.generic) notes.push(L.notes.reverseCharge);
    if (vatMode === 'none' && kind.series !== 'quote' && !regime.generic) notes.push(L.notes.nonVatPayer);
    if (!kind.taxDocument && kind.payable && kind.series !== 'invoice' && !regime.generic) notes.push(L.notes.notTaxDocument);
    if (invoice.kind === 'corrective' && invoice.correctionReason) notes.push(fill(L.notes.correctionReason, { reason: invoice.correctionReason }));
    // a Czech tax document in another currency also states the tax base and the tax in CZK (VAT Act, section 29)
    var czkRate = decToInt(invoice.exchangeRate, 4);
    // only a Czech tax document has to say its tax in crowns
    if (vatMode === 'vat' && kind.taxDocument && !regime.generic && countryProfile(invoice.supplier.country) === COUNTRIES.CZ &&
        String(currency).toUpperCase() !== 'CZK' && czkRate > 0 && L.notes.czkRate && L.notes.czkLine) {
      var czkLines = [fill(L.notes.czkRate, { rate: formatScaled(czkRate, 4, 2, 4, F), currency: currency })];
      totals.byRate.forEach(function (r) {
        // convert the amount the prices were typed in, then take the tax from it exactly as in the document's own
        // currency, so the CZK tax always follows from the CZK base printed beside it
        var inCzk = split(mulDiv(totals.priceMode === 'gross' ? r.gross : r.net, czkRate, 10000), r.rateBp, 'vat', totals.priceMode);
        czkLines.push(fill(L.notes.czkLine, {
          vatRate: formatPercent(r.rateBp / 100, F),
          base: formatMoney(inCzk.net, 'CZK', F),
          vat: formatMoney(inCzk.vat, 'CZK', F)
        }));
      });
      notes.push(czkLines.join('\n'));
    }
    if (invoice.note && String(invoice.note).trim()) notes.push(String(invoice.note).trim());

    var plainTitle = docTitle + (invoice.number ? ' ' + invoice.number : '');
    return {
      meta: {
        title: plainTitle, lang: invoice.language, author: invoice.supplier.name || '',
        fileName: (safeFileName(docTitle) || FILE_WORD[has(FILE_WORD, invoice.kind) ? invoice.kind : 'invoice_vat']) +
          (safeFileName(invoice.number) ? '-' + safeFileName(invoice.number) : '') + '.pdf'
      },
      style: { template: invoice.template === 'simple' ? 'simple' : 'modern', color: /^#[0-9a-fA-F]{6}$/.test(invoice.color || '') ? invoice.color : '#1d4e89' },
      header: { title: docTitle.toUpperCase(), number: invoice.number ? L.numberAbbr + ' ' + invoice.number : '', sub: sub, logo: normalizeImage(images.logo) },
      parties: parties, payment: payment, dates: dates,
      qr: qr ? { text: qr.text, caption: L.qrPayment } : null,
      items: { columns: columns, rows: rowsOut },
      vatSummary: vatSummary,
      totals: totalRows,
      grandTotal: { label: grandLabel, value: money(totals.payable) },
      notes: notes,
      // a stamp or signature image is printed whenever the company has one; an empty line for signing by hand only on request
      signature: (normalizeImage(images.stamp) || invoice.showSignature) ? { label: L.stampAndSignature, stamp: normalizeImage(images.stamp) } : null,
      footer: { left: invoice.issuedBy ? L.issuedBy + ' ' + invoice.issuedBy : '', pageTemplate: L.page }
    };
  }

  return {
    KINDS: KINDS, KIND_ORDER: KIND_ORDER, PAYMENT_METHODS: PAYMENT_METHODS, DUE_OPTIONS: DUE_OPTIONS, VAT_RATES: VAT_RATES,
    ROUNDING_STEPS: ROUNDING_STEPS, UNIT_KEYS: UNIT_KEYS, CURRENCIES: CURRENCIES, SUPPLIER_DEFAULTS: SUPPLIER_DEFAULTS,
    normalizeDecimalString: normalizeDecimalString, parseNumber: parseNumber, decToInt: decToInt, mulDiv: mulDiv, roundToStep: roundToStep,
    isIsoDate: isIsoDate, addDays: addDays, daysBetween: daysBetween, localToday: localToday,
    formatScaled: formatScaled, formatAmount: formatAmount, formatMoney: formatMoney, formatQty: formatQty,
    formatPercent: formatPercent, formatDate: formatDate, currencySymbol: currencySymbol,
    digitsOnly: digitsOnly, validateIco: validateIco,
    cleanIban: cleanIban, validateIban: validateIban, formatIban: formatIban, parseCzAccount: parseCzAccount,
    validateCzAccount: validateCzAccount, czAccountToIban: czAccountToIban, resolveIban: resolveIban,
    spayd: spayd, epcQr: epcQr, paymentQr: paymentQr,
    formatPattern: formatPattern, matchPattern: matchPattern, nextNumber: nextNumber, suggestNumber: suggestNumber,
    defaultVariableSymbol: defaultVariableSymbol,
    kindOf: kindOf, vatModeOf: vatModeOf, priceModeOf: priceModeOf, computeTotals: computeTotals, statusOf: statusOf,
    uid: uid, emptyParty: emptyParty, emptyBank: emptyBank, partySnapshot: partySnapshot,
    newCompany: newCompany, newItem: newItem, newInvoice: newInvoice, normalizeInvoice: normalizeInvoice, duplicateInvoice: duplicateInvoice,
    normalizeImage: normalizeImage, buildViewModel: buildViewModel,
    countsAsIncome: countsAsIncome, periodKey: periodKey, periodKeys: periodKeys, overview: overview,
    BANK_KINDS: BANK_KINDS, countryProfile: countryProfile, taxRegime: taxRegime, taxRatesFor: taxRatesFor, defaultTaxRate: defaultTaxRate,
    bankKind: bankKind, validateRouting: validateRouting, followCountry: followCountry, usesPaymentSymbols: usesPaymentSymbols
  };
});
