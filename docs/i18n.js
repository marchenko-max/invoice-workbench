/*
 * InvoiceI18n: what a document says, per language. The app's own screens are English only.
 * Browser: window.InvoiceI18n. Node: module.exports.
 * Czech and English are here; i18n-extra.js registers the other languages with the same keys.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.InvoiceI18n = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var tables = {};
  var order = [];

  function register(code, table) {
    if (!tables[code]) order.push(code);
    tables[code] = table;
  }

  /** The table of a language, Czech when the code is unknown. */
  function get(code) { return tables[code] || tables.cs; }

  function list() {
    return order.map(function (code) { return { code: code, name: tables[code].languageName }; });
  }

  register('cs', {
    languageName: 'Čeština',
    docTitle: {
      invoice_vat: 'Faktura - daňový doklad', invoice_novat: 'Faktura', corrective: 'Opravný daňový doklad',
      reverse_charge: 'Faktura - daňový doklad', quote_vat: 'Cenová nabídka', quote_novat: 'Cenová nabídka',
      proforma: 'Proforma faktura', advance: 'Zálohová faktura'
    },
    numberAbbr: 'č.',
    recordNumber: 'Evidenční č.',
    supplier: 'Dodavatel',
    customer: 'Odběratel',
    companyNumber: 'IČO',
    taxNumber: 'DIČ',
    vatPayer: 'Plátce DPH',
    nonVatPayer: 'Neplátce DPH',
    paymentDetails: 'Platební údaje',
    bankAccount: 'Bankovní účet',
    iban: 'IBAN',
    swift: 'SWIFT',
    paymentMethod: 'Forma úhrady',
    paymentMethods: { cash: 'Hotově', transfer: 'Převodem', cod: 'Na dobírku', card: 'Platební kartou', paypal: 'PayPal', offset: 'Vzájemným zápočtem' },
    variableSymbol: 'Variabilní symbol',
    constantSymbol: 'Konstantní symbol',
    specificSymbol: 'Specifický symbol',
    orderNumber: 'Číslo objednávky',
    issueDate: 'Datum vystavení',
    dueDate: 'Datum splatnosti',
    taxDate: 'Datum zdan. plnění',
    validUntil: 'Platnost do',
    qrPayment: 'QR Platba',
    col: { qty: 'Počet', description: 'Popis', unitPrice: 'Cena za jedn.', vatRate: 'Sazba DPH', net: 'Bez DPH', vat: 'DPH', total: 'Celkem' },
    summary: { rate: 'Sazba DPH', base: 'Základ daně', vat: 'DPH', total: 'Celkem' },
    totalNet: 'Celkem bez DPH',
    totalVat: 'DPH',
    totalGross: 'Celkem s DPH',
    total: 'Celkem',
    rounding: 'Zaokrouhlení',
    totalDue: 'Celkem k úhradě',
    discount: 'Sleva',
    documentDiscount: 'Sleva na celý doklad',
    notes: {
      reverseCharge: 'Daň odvede zákazník.',
      nonVatPayer: 'Dodavatel není plátcem DPH.',
      notTaxDocument: 'Toto není daňový doklad.',
      correctiveFor: 'K původnímu dokladu č. {number}',
      correctionReason: 'Důvod opravy: {reason}',
      czkRate: 'Přepočet kurzem {rate} CZK/{currency}:',
      czkLine: 'sazba {vatRate}: základ daně {base}, DPH {vat}'
    },
    issuedBy: 'Vystavil(a):',
    stampAndSignature: 'Razítko a podpis',
    page: 'Strana {page} z {pages}',
    units: { pcs: 'ks', hour: 'hod.', day: 'den', litre: 'l', kg: 'kg', g: 'g', m: 'm', km: 'km', m2: 'm²', m3: 'm³', pack: 'bal.' },
    format: { date: 'DD. MM. YYYY', decimal: ',', group: ' ', percent: '{n} %', prefixSymbols: [] }
  });

  register('en', {
    languageName: 'English',
    docTitle: {
      invoice_vat: 'Invoice - tax document', invoice_novat: 'Invoice', corrective: 'Corrective tax document',
      reverse_charge: 'Invoice - tax document', quote_vat: 'Quotation', quote_novat: 'Quotation',
      proforma: 'Proforma invoice', advance: 'Advance invoice'
    },
    numberAbbr: 'No.',
    recordNumber: 'Record no.',
    supplier: 'Supplier',
    customer: 'Customer',
    companyNumber: 'Company ID',
    taxNumber: 'VAT ID',
    vatPayer: 'VAT payer',
    nonVatPayer: 'Not a VAT payer',
    paymentDetails: 'Payment details',
    bankAccount: 'Bank account',
    iban: 'IBAN',
    swift: 'SWIFT/BIC',
    paymentMethod: 'Payment method',
    paymentMethods: { cash: 'Cash', transfer: 'Bank transfer', cod: 'Cash on delivery', card: 'Card', paypal: 'PayPal', offset: 'Mutual offset' },
    variableSymbol: 'Variable symbol',
    constantSymbol: 'Constant symbol',
    specificSymbol: 'Specific symbol',
    orderNumber: 'Order no.',
    issueDate: 'Issue date',
    dueDate: 'Due date',
    taxDate: 'Date of taxable supply',
    validUntil: 'Valid until',
    qrPayment: 'Scan to pay',
    col: { qty: 'Qty', description: 'Description', unitPrice: 'Unit price', vatRate: 'VAT rate', net: 'Net', vat: 'VAT', total: 'Total' },
    summary: { rate: 'VAT rate', base: 'Tax base', vat: 'VAT', total: 'Total' },
    totalNet: 'Total excl. VAT',
    totalVat: 'VAT',
    totalGross: 'Total incl. VAT',
    total: 'Total',
    rounding: 'Rounding',
    totalDue: 'Total due',
    discount: 'Discount',
    documentDiscount: 'Discount on the whole document',
    notes: {
      reverseCharge: 'Reverse charge: the customer accounts for the VAT.',
      nonVatPayer: 'The supplier is not a VAT payer.',
      notTaxDocument: 'This is not a tax document.',
      correctiveFor: 'Corrects document no. {number}',
      correctionReason: 'Reason for the correction: {reason}',
      czkRate: 'Converted at {rate} CZK/{currency}:',
      czkLine: 'rate {vatRate}: tax base {base}, VAT {vat}'
    },
    issuedBy: 'Issued by:',
    stampAndSignature: 'Stamp and signature',
    page: 'Page {page} of {pages}',
    units: { pcs: 'pcs', hour: 'h', day: 'day', litre: 'l', kg: 'kg', g: 'g', m: 'm', km: 'km', m2: 'm²', m3: 'm³', pack: 'pack' },
    format: {
      date: 'D MMM YYYY', months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
      decimal: '.', group: ',', percent: '{n}%', prefixSymbols: ['$', '£', '€']
    }
  });

  return { register: register, get: get, list: list, tables: tables };
});
