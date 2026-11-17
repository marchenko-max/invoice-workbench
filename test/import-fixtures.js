/*
 * Made-up ISDOC documents, ZIP archives and PDFs for the import tests. Every company, number and amount here is
 * invented; nothing comes from a real invoice.
 */
'use strict';
const zlib = require('node:zlib');

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

function line(l, i) {
  return '<InvoiceLine><ID>' + (i + 1) + '</ID>' +
    '<InvoicedQuantity unitCode="' + (l.unit == null ? 'ks' : l.unit) + '">' + (l.qty == null ? 1 : l.qty) + '</InvoicedQuantity>' +
    (l.netCurr != null ? '<LineExtensionAmountCurr>' + l.netCurr + '</LineExtensionAmountCurr>' : '') +
    '<LineExtensionAmount>' + l.net + '</LineExtensionAmount>' +
    (l.grossCurr != null ? '<LineExtensionAmountTaxInclusiveCurr>' + l.grossCurr + '</LineExtensionAmountTaxInclusiveCurr>' : '') +
    '<LineExtensionAmountTaxInclusive>' + (l.gross == null ? l.net : l.gross) + '</LineExtensionAmountTaxInclusive>' +
    '<LineExtensionTaxAmount>' + (l.vat == null ? 0 : l.vat) + '</LineExtensionTaxAmount>' +
    '<UnitPrice>' + (l.unitNet == null ? l.net : l.unitNet) + '</UnitPrice>' +
    '<UnitPriceTaxInclusive>' + (l.unitGross == null ? (l.gross == null ? l.net : l.gross) : l.unitGross) + '</UnitPriceTaxInclusive>' +
    '<ClassifiedTaxCategory><Percent>' + (l.rate == null ? 0 : l.rate) + '</Percent><VATCalculationMethod>0</VATCalculationMethod>' +
    (l.reverse ? '<LocalReverseChargeFlag>true</LocalReverseChargeFlag>' : '') + '</ClassifiedTaxCategory>' +
    (l.note ? '<Note>' + esc(l.note) + '</Note>' : '') +
    '<Item><Description>' + esc(l.text == null ? 'Práce' : l.text) + '</Description></Item></InvoiceLine>';
}

function party(p) {
  return '<Party><PartyIdentification><ID>' + (p.ico || '') + '</ID></PartyIdentification>' +
    '<PartyName><Name>' + esc(p.name) + '</Name></PartyName>' +
    '<PostalAddress><StreetName>' + esc(p.street || '') + '</StreetName><BuildingNumber>' + (p.no || '') + '</BuildingNumber>' +
    '<CityName>' + esc(p.city || '') + '</CityName><PostalZone>' + (p.zip || '') + '</PostalZone>' +
    '<Country><IdentificationCode>' + (p.country || 'CZ') + '</IdentificationCode><Name/></Country></PostalAddress>' +
    (p.dic ? '<PartyTaxScheme><CompanyID>' + p.dic + '</CompanyID><TaxScheme>VAT</TaxScheme></PartyTaxScheme>' : '') +
    (p.email || p.person ? '<Contact>' + (p.person ? '<Name>' + esc(p.person) + '</Name>' : '') + (p.email ? '<ElectronicMail>' + p.email + '</ElectronicMail>' : '') + '</Contact>' : '') +
    '</Party>';
}

const SUPPLIER = { name: 'Ukázka s.r.o.', ico: '11111111', street: 'Dlouhá', no: '1', city: 'Praha', zip: '11000', person: 'Jana Vzorová' };
const CUSTOMER = { name: 'Odběratel a.s.', ico: '22222222', dic: 'CZ22222222', street: 'Krátká', no: '2', city: 'Brno', zip: '60200', email: 'fakturace@odberatel.example' };

/**
 * An ISDOC invoice. Everything has a default: a non-VAT payer's invoice for 10 hours at 1,500 Kč, due in 14 days.
 * `vat`: true | false | null (null leaves the VATApplicable element out, as files older than 5.3 do).
 * `totals`: { net, gross, claimed, rounding, deposits, payable } and the same with a Curr suffix for a foreign invoice.
 */
function isdoc(o) {
  o = o || {};
  const lines = o.lines || [{ qty: 10, unit: 'hod', net: '15000.00', unitNet: '1500', text: 'Vývoj aplikace' }];
  const t = Object.assign({ net: '15000.00', gross: '15000.00', payable: '15000.00' }, o.totals || {});
  const pay = Object.assign({ code: 42, due: '2026-03-16', id: '123456789', bank: '0800', iban: '', bic: '', vs: '20260001' }, o.payment || {});
  const amount = function (name, value) { return value == null ? '' : '<' + name + '>' + value + '</' + name + '>'; };
  return (o.declaration == null ? '<?xml version="1.0" encoding="UTF-8"?>\n' : o.declaration) +
    '<Invoice xmlns="http://isdoc.cz/namespace/2013" version="6.0.2">' +
    '<DocumentType>' + (o.type || 1) + '</DocumentType><ID>' + esc(o.number || '20260001') + '</ID>' +
    '<UUID>00000000-0000-4000-8000-000000000001</UUID>' +
    '<IssuingSystem>Zkušební systém</IssuingSystem>' +
    '<IssueDate>' + (o.issue || '2026-03-02') + '</IssueDate><TaxPointDate>' + (o.tax || o.issue || '2026-03-02') + '</TaxPointDate>' +
    (o.vat === null ? '' : '<VATApplicable>' + (o.vat === true) + '</VATApplicable>') +
    '<ElectronicPossibilityAgreementReference/>' +
    '<Note>' + esc(o.note || '') + '</Note><LocalCurrencyCode>CZK</LocalCurrencyCode>' +
    (o.foreign ? '<ForeignCurrencyCode>' + o.foreign + '</ForeignCurrencyCode>' : '') +
    '<CurrRate>' + (o.rate || 1) + '</CurrRate><RefCurrRate>' + (o.per || 1) + '</RefCurrRate>' +
    '<AccountingSupplierParty>' + party(o.supplier || SUPPLIER) + '</AccountingSupplierParty>' +
    '<AccountingCustomerParty>' + party(o.customer || CUSTOMER) + '</AccountingCustomerParty>' +
    (o.order ? '<OrderReferences><OrderReference><SalesOrderID>1</SalesOrderID><ExternalOrderID>' + o.order + '</ExternalOrderID></OrderReference></OrderReferences>' : '') +
    (o.corrects ? '<OriginalDocumentReferences><OriginalDocumentReference><ID>' + o.corrects + '</ID></OriginalDocumentReference></OriginalDocumentReferences>' : '') +
    '<InvoiceLines>' + lines.map(line).join('') + '</InvoiceLines>' +
    '<TaxTotal><TaxAmount>' + (t.vat || 0) + '</TaxAmount></TaxTotal>' +
    (o.noTotals ? '' : '<LegalMonetaryTotal>' +
      amount('TaxExclusiveAmount', t.net) + amount('TaxExclusiveAmountCurr', t.netCurr) +
      amount('TaxInclusiveAmount', t.gross) + amount('TaxInclusiveAmountCurr', t.grossCurr) +
      amount('AlreadyClaimedTaxExclusiveAmount', t.claimedNet == null ? 0 : t.claimedNet) +
      amount('AlreadyClaimedTaxInclusiveAmount', t.claimed == null ? 0 : t.claimed) + amount('AlreadyClaimedTaxInclusiveAmountCurr', t.claimedCurr) +
      amount('DifferenceTaxExclusiveAmount', t.net) + amount('DifferenceTaxInclusiveAmount', t.gross) +
      amount('PayableRoundingAmount', t.rounding) +
      amount('PaidDepositsAmount', t.deposits == null ? 0 : t.deposits) + amount('PaidDepositsAmountCurr', t.depositsCurr) +
      amount('PayableAmount', t.payable) + amount('PayableAmountCurr', t.payableCurr) +
      '</LegalMonetaryTotal>') +
    '<PaymentMeans><Payment><PaidAmount>0</PaidAmount><PaymentMeansCode>' + pay.code + '</PaymentMeansCode><Details>' +
    '<PaymentDueDate>' + pay.due + '</PaymentDueDate><ID>' + pay.id + '</ID><BankCode>' + pay.bank + '</BankCode><Name/>' +
    '<IBAN>' + pay.iban + '</IBAN><BIC>' + pay.bic + '</BIC><VariableSymbol>' + pay.vs + '</VariableSymbol>' +
    '<ConstantSymbol>' + (pay.ks || '') + '</ConstantSymbol><SpecificSymbol/></Details></Payment></PaymentMeans>' +
    '</Invoice>\n';
}

function bytes(text) { return new Uint8Array(Buffer.from(text, 'utf8')); }

/** A ZIP of [{ name, data, store?, encrypted?, claims? }]; `claims` lies about the unpacked size. */
function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  files.forEach(function (f) {
    const name = Buffer.from(f.name, 'utf8');
    const raw = Buffer.from(f.data);
    const body = f.store ? raw : zlib.deflateRawSync(raw);
    const flags = 0x800 | (f.encrypted ? 1 : 0);
    const size = f.claims || raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(f.store ? 0 : 8, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(flags, 8);
    c.writeUInt16LE(f.store ? 0 : 8, 10);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(size, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + body.length;
  });
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat(parts.concat([directory, end])));
}

/** A PDF-shaped file with `xml` attached the way ISDOC.PDF attaches it. `indirect` writes the length as a reference. */
function pdf(xml, o) {
  o = o || {};
  const packed = xml == null ? null : zlib.deflateSync(Buffer.from(xml, 'utf8'));
  const head = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
    '5 0 obj\n<< /Length 11 >>\nstream\nhello world\nendstream\nendobj\n';
  const chunks = [Buffer.from(head, 'latin1')];
  if (packed) {
    chunks.push(Buffer.from('7 0 obj\n<< /Type /EmbeddedFile /Subtype /text#2Fxml /Filter /FlateDecode /Length ' +
      (o.indirect ? '8 0 R' : packed.length) + ' >>\nstream\r\n', 'latin1'), packed, Buffer.from('\r\nendstream\nendobj\n', 'latin1'));
  }
  chunks.push(Buffer.from('trailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'));
  return new Uint8Array(Buffer.concat(chunks));
}

module.exports = { isdoc: isdoc, bytes: bytes, zip: zip, pdf: pdf, SUPPLIER: SUPPLIER, CUSTOMER: CUSTOMER };
