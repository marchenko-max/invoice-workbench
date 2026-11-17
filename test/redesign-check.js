/*
 * Checks for what the review of the restyle found, measured in the real page.   node test/redesign-check.js
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { launch } = require('./cdp.js');
const ROOT = path.resolve(__dirname, '..');
require('node:child_process').execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build.js')]);
const URL = 'file://' + path.join(ROOT, 'dist', 'index.html');
let failures = 0;
function ok(cond, what, detail) {
  if (cond) console.log('  ok   ' + what);
  else { failures++; console.log('  FAIL ' + what + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}
const tabsFit = `(function(){var bad=[];document.querySelectorAll('.tab').forEach(function(t){var r=document.createRange();r.selectNodeContents(t);var tr=r.getBoundingClientRect(),b=t.getBoundingClientRect();if(tr.left<b.left-0.5||tr.right>b.right+0.5)bad.push(t.textContent);});return bad;})()`;
const noSideScroll = 'document.documentElement.scrollWidth <= window.innerWidth';
(async () => {
  const profile = path.join(__dirname, '.chrome-redesign');
  fs.rmSync(profile, { recursive: true, force: true });
  const b = await launch({ width: 1360, height: 900, profile });
  try {
    await b.goto(URL, 2300);
    console.log('desktop');
    ok((await b.eval('getComputedStyle(document.querySelector(".tab[aria-current=page]")).fontWeight')) === '600', 'the selected tab is heavier, not only another colour');
    ok(/brightness\(0\.9/.test(await b.eval('(function(){var s="";for(var i=0;i<document.styleSheets.length;i++){try{var r=document.styleSheets[i].cssRules;for(var j=0;j<r.length;j++){if(r[j].selectorText===".btn.primary:hover")s=r[j].style.filter;}}catch(e){}}return s;})()')), 'the primary button darkens on hover (its label stays readable)');
    const rings = await b.eval('(function(){var sel=document.querySelector(".swatch[aria-pressed=true]");var cs=getComputedStyle(sel);return {ring:cs.boxShadow, fg:getComputedStyle(document.body).color, accent:getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()};})()');
    ok(rings.ring.indexOf(rings.fg) !== -1, 'the chosen swatch wears the neutral ring, leaving the accent ring to focus', rings);
    await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-contrast', value: 'more' }] });
    await b.eval('window.scrollTo(0, 600)'); await b.wait(500);
    const edge = await b.eval('[getComputedStyle(document.querySelector(".editor-bar"), "::before").borderBottomColor, getComputedStyle(document.body).color, getComputedStyle(document.querySelector(".editor-bar"), "::before").backdropFilter]');
    ok(edge[0] === edge[1] && edge[2] === 'none', 'with more contrast the scrolled bar is solid and its edge is drawn in the text colour', edge);
    await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
    await b.wait(300);
    // the hairline token, resolved by the browser in whichever theme the emulation left the page in
    const edge2 = await b.eval('(function(){var p=document.createElement("i");p.style.color="var(--line)";document.body.appendChild(p);var line=getComputedStyle(p).color;p.remove();var cs=getComputedStyle(document.querySelector(".editor-bar"), "::before");return [cs.borderBottomColor, cs.backdropFilter, line];})()');
    ok(edge2[0] === edge2[2] && edge2[1] === 'none', 'with reduced transparency the scrolled bar is solid with a drawn edge', edge2);
    await b.send('Emulation.setEmulatedMedia', { features: [] });
    await b.eval('window.scrollTo(0, 0)');

    console.log('phone');
    await b.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    for (const [w, root] of [[390, ''], [320, ''], [390, '20px'], [390, '24px'], [320, '24px']]) {
      await b.setViewport(w, 800, true);
      await b.eval('document.documentElement.style.fontSize = ' + JSON.stringify(root));
      for (const view of ['documents', 'editor', 'companies', 'backup']) {
        await b.eval('location.hash = "#' + view + '"'); await b.wait(350);
        const bad = await b.eval(tabsFit);
        const side = await b.eval(noSideScroll);
        if (bad.length || !side) ok(false, 'tabs fit and nothing scrolls sideways at ' + w + ' px, root ' + (root || '16px') + ', ' + view, { bad, side });
      }
      ok(true, 'checked ' + w + ' px, root ' + (root || '16px') + ' on all four screens');
    }
    await b.eval('document.documentElement.style.fontSize = ""');
    await b.setViewport(390, 800, true);
    await b.eval('location.hash = "#editor"'); await b.wait(500);
    const coarse = await b.eval('matchMedia("(pointer: coarse)").matches');
    const sizes = await b.eval(`(function(){var out={};function h(sel){var m=1e9;document.querySelectorAll(sel).forEach(function(e){var r=e.getBoundingClientRect();if(r.height>0)m=Math.min(m,r.height);});return m===1e9?null:Math.round(m);}
      out.tab=h('.tab');out.seg=h('.seg button');out.check=h('label.check');out.swatch=h('.swatch');out.color=h('input[type=color]');out.btn=h('.btn:not(.small)');out.small=h('.btn.small');out.field=h('input[type=text]');return out;})()`);
    ok(coarse === true, 'the test really runs with a coarse pointer');
    ok(sizes.tab >= 38 && sizes.seg >= 38 && sizes.check >= 38 && sizes.swatch >= 36 && sizes.color >= 36 && sizes.btn >= 44 && sizes.small >= 38 && sizes.field >= 44, 'touch targets are large enough', sizes);
    await b.setViewport(320, 800, true);
    await b.eval('location.hash = "#companies"'); await b.wait(300);
    await b.click('#add-company');
    await b.waitFor('document.querySelector("#dialog").open'); await b.wait(500);
    await b.fill('#co-dic', 'CZ27082440');
    const dic = await b.eval('(function(){var e=document.querySelector("#co-dic");return [e.scrollWidth, e.clientWidth, document.querySelector("#dialog").scrollWidth <= document.querySelector("#dialog").clientWidth + 1];})()');
    ok(dic[0] <= dic[1] && dic[2], 'at 320 px the DIČ field shows its whole value and the dialog does not scroll sideways', dic);
    ok(b.errors.length === 0, 'no exceptions or console errors', b.errors.slice(0, 5));
  } catch (e) {
    failures++;
    console.log('  FAIL (threw) ' + e.message + '  errors: ' + JSON.stringify(b.errors.slice(0, 5)));
  }
  await b.close();
  fs.rmSync(profile, { recursive: true, force: true });
  console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})();
