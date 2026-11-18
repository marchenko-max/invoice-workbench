# Invoice Workbench

Issue Czech invoices, quotations, proformas and corrective documents in the browser: saved companies and customers,
a live A4 preview, QR Platba and SEPA payment codes, ten document languages, and a PDF download.

It also adds your income up by month, quarter and year (**Overview**), and it can take over the invoices you issued
in another service.

## Moving from FakturaOnline, Fakturoid or another service

**Backup → Move here from another service** reads ISDOC, the Czech e-invoice format, which both services export
with every line of every invoice:

- FakturaOnline: Exporty → Export faktur → ISDOC
- Fakturoid: Faktury → Export → ISDOC (ZIP)

Choose the exported `.isdoc` files, an `.isdocx`, or the whole ZIP. PDF invoices made by those services work too,
because they carry the same ISDOC file inside. Each invoice comes in with its lines, customer, dates and payment
details; your company and your customers are added with them; an invoice that is already here is left as it is.
ISDOC does not say whether an invoice was paid, so the import asks how to read that. Spreadsheet exports
(XLSX, CSV) have no invoice lines and are not read.

## Companies outside the Czech Republic

A company's country decides what its documents say. Set it in the company profile:

- **Ukraine**: ПДВ at 20, 14, 7 or 0 %, the company's ЄДРПОУ (or a person's РНОКПП) and ІПН under their own names,
  and an IBAN. A new Ukrainian company starts in hryvnias and in Ukrainian.
- **United States**: there is no VAT, so the invoice has a subtotal, one sales tax line at the rate you set, and a
  total; the EIN is printed as an EIN; the bank account is a routing number and an account number, with a SWIFT
  code for payments from abroad.
- **Slovakia**: VAT at 23, 19, 5 or 0 %, and an IBAN.
- **Anywhere else**: VAT at the rate you type and an IBAN. If the tax is called something else, such as GST, give
  it that name in the company profile and the documents use it.

The kind of account (Czech number, IBAN, or US routing and account number) can be chosen apart from the country,
for a Czech company with a dollar account, for example. A payment QR code is printed for Czech accounts and for
euro payments to an IBAN in the SEPA area; nowhere else is there a code a banking app would understand.

## Signing

**Any document.** The **Sign** tab opens a PDF, or a photo or scan of a page (JPG, PNG), and lets you put your
signature, a date or a line of text anywhere on it: drag to move, pull the corner to resize, then download the
signed copy. The file is opened, signed and saved in your browser and is not uploaded anywhere. A Word document
has to be saved as PDF first. A signature placed this way is a simple electronic signature: fine for everyday
agreements, orders and handover records, not for the cases where the law asks for a qualified or officially
verified one.

**Your invoices.** A Czech invoice needs no signature. If you want one on your documents, add a picture of it to
your company, or draw it there with a mouse, a finger or a pen; it is printed where a stamp and signature go.

## Your data stays with you

There is no server and there are no accounts. Everything you enter is kept on your own device:

- in the browser's own storage, or
- as plain JSON files in a folder you choose (Chrome and Edge), one file per company and per document, with a copy
  of every PDF you download. Put that folder in iCloud Drive or Dropbox if you want it on several computers.

Nothing is uploaded. The only request that carries anything you typed is the optional company lookup, which sends
the IČO you ask about to the public ARES register.

Use **Backup → Export a backup file** now and then if you keep your data in the browser: clearing the browser's
site data removes it.

## Running it

Open the published site, or open `docs/index.html` from disk. No install and no build are needed to use it.

## Working on it

Plain HTML, CSS and JavaScript, with no dependencies to install.

| File | What it is |
|---|---|
| `index.html` | Markup and styles |
| `app.js` | The screens |
| `store.js` | Where data is kept (browser storage, a folder, or a claude.ai Artifact database) |
| `core.js` | The rules: VAT maths, numbering, IBAN, payment codes, formatting, the income overview |
| `import.js` | Reads ISDOC invoices from other services: the XML, ZIP archives and PDFs they arrive in |
| `sign.js` | The Sign tab: shows a PDF with pdf.js, writes the signed copy with pdf-lib (both loaded from cdnjs on first use) |
| `render.js` | Page layout, the SVG preview and the PDF |
| `i18n.js`, `i18n-extra.js` | What a document says in each language |
| `fonts.js` | The embedded typeface |

```
node tools/build.js          # writes docs/ (the website) and dist/ (for the tests)
node --test test/*.test.js   # unit tests
node test/app-smoke.js       # drives the page in headless Chrome (macOS path to Chrome in test/cdp.js)
```

The other `test/*.js` scripts run the same way: `hosted-smoke.js`, `folder-smoke.js`, `folder-regress.js`,
`review-regress.js`, `redesign-check.js`, `import-smoke.js`, `signature-check.js`, `overview-check.js`, `sign-check.js`,
`countries-check.js`.

## Credits

The embedded typeface is Montserrat, © The Montserrat Project Authors, under the SIL Open Font License 1.1
(`licenses/Montserrat-OFL.txt`). PDFs are made with jsPDF and QR codes with qrcode-generator; the Sign tab uses
pdf.js and pdf-lib. All four are loaded from cdnjs.
