/*
 * Builds the page for the three places it runs.   node tools/build.js
 *
 *   docs/   the website (GitHub Pages serves this folder): a complete HTML document and the scripts, nothing else.
 *   dist/   the same page as claude.ai serves it once published, for opening from disk and for the tests. A published
 *           Artifact page is wrapped in a small document skeleton; index.html is written without one, so this adds
 *           the same skeleton. dist/ also gets hosted-test.html, the page behind a stand-in for the claude.ai host.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const SCRIPTS = ['fonts.js', 'core.js', 'import.js', 'i18n.js', 'i18n-extra.js', 'render.js', 'store.js', 'app.js'];
const RESET = ':root{color-scheme:light;padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}';
const page = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// ---- dist/: the Artifact skeleton, byte for byte the shape the host uses
const SKELETON = '<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">' +
  '<style>' + RESET + '</style></head><body>';
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'index.html'), SKELETON + page + '</body></html>\n');
for (const f of SCRIPTS) fs.copyFileSync(path.join(root, f), path.join(dist, f));
// the same page with a stand-in for the claude.ai host in front of it, for the storage and download tests
fs.copyFileSync(path.join(root, 'test', 'claude-mock.js'), path.join(dist, 'claude-mock.js'));
fs.writeFileSync(path.join(dist, 'hosted-test.html'), SKELETON + '<script src="claude-mock.js"></script>' + page + '</body></html>\n');

// ---- docs/: an ordinary web page. The title moves into the head, and the line meant only for the Artifact host goes.
const titleMatch = /<title>([^<]*)<\/title>\n?/.exec(page);
const title = titleMatch ? titleMatch[1] : 'Invoice Workbench';
// the page's own stylesheet belongs in the head of a real document
const styleMatch = /<style>[\s\S]*?<\/style>\n?/.exec(page);
const pageStyle = styleMatch ? styleMatch[0] : '';
const body = page.replace(/<title>[^<]*<\/title>\n?/, '').replace(/<meta name="claude:viewport-fit-sides"[^>]*>\n?/, '').replace(pageStyle, '');
const ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect x='6' y='3' width='20' height='26' rx='5' fill='%230071e3'/%3E%3Cpath d='M11 11h10M11 16h10M11 21h10' stroke='white' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E";
const HEAD = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n' +
  // a tool passed from friend to friend, not something to be found by a search engine
  '<meta name="robots" content="noindex">\n' +
  '<meta name="description" content="Issue Czech invoices, quotations and proformas in your browser. Your companies and documents stay on your own device.">\n' +
  '<title>' + title + '</title>\n' +
  '<link rel="icon" href="' + ICON + '">\n' +
  '<style>' + RESET + '</style>\n' + pageStyle + '</head>\n<body>\n';
const docs = path.join(root, 'docs');
fs.rmSync(docs, { recursive: true, force: true });
fs.mkdirSync(docs, { recursive: true });
fs.writeFileSync(path.join(docs, 'index.html'), HEAD + body + '</body>\n</html>\n');
for (const f of SCRIPTS) fs.copyFileSync(path.join(root, f), path.join(docs, f));
fs.writeFileSync(path.join(docs, '.nojekyll'), '');   // serve the files as they are

console.log('dist/ and docs/ built');
