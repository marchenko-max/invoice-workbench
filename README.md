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

## Signing

A Czech invoice needs no signature. If you want one on your documents, add a picture of it to your company, or
draw it there with a mouse, a finger or a pen; it is printed where a stamp and signature go.

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
| `render.js` | Page layout, the SVG preview and the PDF |
| `i18n.js`, `i18n-extra.js` | What a document says in each language |
| `fonts.js` | The embedded typeface |

```
node tools/build.js          # writes docs/ (the website) and dist/ (for the tests)
node --test test/*.test.js   # unit tests
node test/app-smoke.js       # drives the page in headless Chrome (macOS path to Chrome in test/cdp.js)
```

The other `test/*.js` scripts run the same way: `hosted-smoke.js`, `folder-smoke.js`, `folder-regress.js`,
`review-regress.js`, `redesign-check.js`, `import-smoke.js`, `signature-check.js`.

## Credits

The embedded typeface is Montserrat, © The Montserrat Project Authors, under the SIL Open Font License 1.1
(`licenses/Montserrat-OFL.txt`). PDFs are made with jsPDF and QR codes with qrcode-generator, both loaded from cdnjs.
