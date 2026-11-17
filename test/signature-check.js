/*
 * Drives drawing a signature in the company profile: the pad, Clear, Cancel, the trimmed ink it keeps, and the
 * signature on the printed page.   node test/signature-check.js
 * Screenshots land in test/out/sign-*.png.
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { launch } = require('./cdp.js');

const ROOT = path.resolve(__dirname, '..');
require('node:child_process').execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build.js')]);
const URL = 'file://' + path.join(ROOT, 'dist', 'index.html');
const OUT = path.join(__dirname, 'out');
const profile = path.join(__dirname, '.chrome-sign');

let failures = 0;
function ok(cond, what, detail) {
  if (cond) console.log('  ok   ' + what);
  else { failures++; console.log('  FAIL ' + what + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}

/** One stroke across the pad, as pointer events at fractions of its box: [[fx, fy], ...]. */
function stroke(points, type) {
  return '(function(){var c=document.querySelector("#sign-pad");var r=c.getBoundingClientRect();var pts=' + JSON.stringify(points) + ';' +
    'function ev(name,p){c.dispatchEvent(new PointerEvent(name,{bubbles:true,cancelable:true,pointerId:7,pointerType:' + JSON.stringify(type || 'mouse') + ',button:0,buttons:1,pressure:0.5,clientX:r.left+p[0]*r.width,clientY:r.top+p[1]*r.height}));}' +
    'ev("pointerdown",pts[0]);for(var i=1;i<pts.length;i++)ev("pointermove",pts[i]);ev("pointerup",pts[pts.length-1]);return true;})()';
}

const SCRIBBLE = [[0.30, 0.60], [0.34, 0.40], [0.38, 0.66], [0.43, 0.38], [0.48, 0.64], [0.55, 0.50], [0.62, 0.58]];
const inked = '(function(){var c=document.querySelector("#sign-pad");var d=c.getContext("2d").getImageData(0,0,c.width,c.height).data;var n=0;for(var i=3;i<d.length;i+=4)if(d[i]>8)n++;return n;})()';

(async () => {
  fs.rmSync(profile, { recursive: true, force: true });
  const b = await launch({ width: 1360, height: 1000, profile });
  try {
    console.log('1. the company profile offers to draw a signature');
    await b.goto(URL + '#documents', 2400);
    await b.clickText('button', 'Add my company');
    await b.waitFor('document.querySelector("#dialog").open');
    await b.fill('#co-name', 'Ukázka s.r.o.');
    ok((await b.text('#co-stamp-draw')) === 'Draw a signature', 'a button next to the stamp picture', await b.text('#co-stamp-draw'));
    ok(/valid without a signature/.test(await b.text('#dialog')), 'and a line that says a signature is not required');
    await b.click('#co-stamp-draw');
    await b.waitFor('document.querySelector("#sign-pad")');
    ok((await b.eval('document.activeElement && document.activeElement.id')) === 'sign-pad', 'the keyboard is on the pad');
    ok((await b.eval('document.querySelector("#sign-use").disabled')) === true, 'nothing to use before any ink');
    ok((await b.eval('getComputedStyle(document.querySelector("#sign-pad")).touchAction')) === 'none', 'a finger on the pad draws, it does not scroll');

    console.log('2. ink appears with the press, and Clear takes it away');
    await b.eval('(function(){var c=document.querySelector("#sign-pad");var r=c.getBoundingClientRect();c.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,cancelable:true,pointerId:7,pointerType:"mouse",button:0,clientX:r.left+r.width*0.2,clientY:r.top+r.height*0.5}));return 1})()');
    ok((await b.eval(inked)) > 0, 'a dot is there before the pointer moves', await b.eval(inked));
    await b.eval('(function(){var c=document.querySelector("#sign-pad");var r=c.getBoundingClientRect();c.dispatchEvent(new PointerEvent("pointerup",{bubbles:true,pointerId:7,pointerType:"mouse",clientX:r.left+r.width*0.2,clientY:r.top+r.height*0.5}));return 1})()');
    ok((await b.eval('document.querySelector("#sign-use").disabled')) === false, 'the signature can be used now');
    await b.click('#sign-clear');
    ok((await b.eval(inked)) === 0 && (await b.eval('document.querySelector("#sign-use").disabled')) === true, 'Clear empties the pad');

    console.log('3. a second pointer does not join the stroke, and a right button draws nothing');
    await b.eval('(function(){var c=document.querySelector("#sign-pad");var r=c.getBoundingClientRect();c.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,cancelable:true,pointerId:9,pointerType:"mouse",button:2,clientX:r.left+50,clientY:r.top+50}));return 1})()');
    ok((await b.eval(inked)) === 0, 'the right button leaves no ink');

    console.log('4. Cancel keeps what was there: nothing');
    await b.eval(stroke(SCRIBBLE));
    await b.click('#sign-cancel');
    ok((await b.eval('!!document.querySelector("#sign-pad")')) === false, 'the pad is gone');
    ok((await b.eval('!!document.querySelector(".image-slot .thumb img[alt^=\\"Stamp\\"]")')) === false, 'and no signature was set');
    ok((await b.eval('document.activeElement && document.activeElement.id')) === 'co-stamp-draw', 'focus is back on the button');

    console.log('5. a drawn signature is kept as ink alone, cut to its own size');
    await b.click('#co-stamp-draw');
    await b.eval(stroke(SCRIBBLE));
    await b.setDark(true);
    await b.screenshot(path.join(OUT, 'sign-1-pad-dark.png'));
    await b.setDark(false);
    await b.screenshot(path.join(OUT, 'sign-1-pad.png'));
    await b.click('#sign-use');
    const kept = await b.eval('(async function(){var img=document.querySelector(".image-slot .thumb img[alt^=\\"Stamp\\"]");if(!img)return null;var i=new Image();i.src=img.src;await i.decode();var c=document.createElement("canvas");c.width=i.naturalWidth;c.height=i.naturalHeight;var x=c.getContext("2d");x.drawImage(i,0,0);var d=x.getImageData(0,0,c.width,c.height).data;var clear=0,ink=0;for(var k=3;k<d.length;k+=4){if(d[k]===0)clear++;else if(d[k]>200)ink++;}return {png:img.src.slice(0,22),w:c.width,h:c.height,clear:clear,ink:ink,corner:d[3]};})()');
    ok(kept && kept.png === 'data:image/png;base64,', 'it is a PNG', kept);
    ok(kept && kept.w <= 600 && kept.h <= 340 && kept.w < 500 && kept.h < 200, 'cut to the ink, not the whole pad', kept);
    ok(kept && kept.corner === 0 && kept.clear > kept.ink && kept.ink > 100, 'see-through wherever there is no ink', kept);
    ok((await b.text('#co-stamp-draw')) === 'Draw a new signature', 'the button now offers a new one');
    ok((await b.eval('document.activeElement && document.activeElement.id')) === 'co-stamp-draw', 'focus is back on the button');

    console.log('6. it is printed on the document, and survives a reload');
    await b.clickText('#dialog button', 'Save');
    await b.waitFor('!document.querySelector("#dialog").open');
    await b.waitFor('document.querySelector("#doc-title")');
    await b.wait(1200);
    const onPage = await b.eval('(function(){var imgs=document.querySelectorAll("#preview-host .sheet svg image");var out=[];for(var i=0;i<imgs.length;i++){var h=imgs[i].getAttribute("href")||imgs[i].getAttributeNS("http://www.w3.org/1999/xlink","href")||"";out.push(h.slice(0,22));}return out;})()');
    ok(onPage.length === 1 && onPage[0] === 'data:image/png;base64,', 'the page shows one picture: the signature', onPage);
    ok(/Razítko a podpis/.test(await b.eval('document.querySelector("#preview-host").textContent')), 'under its label');
    await b.screenshot(path.join(OUT, 'sign-2-document.png'), { full: true });
    await b.wait(1400);
    await b.goto(URL + '#companies', 2000);
    const stored = await b.eval('(function(){var d=JSON.parse(localStorage.getItem("invoice-workbench:v1")||"{}");var c=Object.keys(d.companies||{}).map(function(k){return d.companies[k]})[0];return c&&c.stamp?{png:c.stamp.src.slice(0,22),w:c.stamp.w,h:c.stamp.h}:null})()');
    ok(stored && stored.png === 'data:image/png;base64,' && stored.w === kept.w && stored.h === kept.h, 'the company keeps it', stored);

    console.log('6b. Save keeps a signature that was drawn but not yet taken');
    await b.clickText('button', 'Edit');
    await b.waitFor('document.querySelector("#dialog").open');
    await b.clickText('#dialog button', 'Remove');
    ok((await b.eval('!!document.querySelector(".image-slot .thumb img[alt^=\\"Stamp\\"]")')) === false, 'the old signature is removed in the dialog');
    await b.click('#co-stamp-draw');
    ok((await b.eval('document.querySelector("#sign-pad").getAttribute("aria-describedby")')) === 'sign-hint' && /keyboard alone/.test(await b.text('#sign-hint')), 'the pad says what a keyboard user can do instead');
    await b.eval(stroke([[0.2, 0.3], [0.5, 0.7], [0.8, 0.3]]));
    await b.clickText('#dialog button', 'Save');
    await b.waitFor('!document.querySelector("#dialog").open');
    await b.wait(400);
    const resaved = await b.eval('(function(){var d=JSON.parse(localStorage.getItem("invoice-workbench:v1")||"{}");var c=Object.keys(d.companies||{}).map(function(k){return d.companies[k]})[0];return c&&c.stamp?{png:c.stamp.src.slice(0,22),w:c.stamp.w,len:c.stamp.src.length}:null})()');
    ok(resaved && resaved.png === 'data:image/png;base64,' && resaved.w !== stored.w, 'the new ink was saved with the company', resaved);
    ok(resaved && resaved.len <= 90000, 'within the size limit for pictures', resaved && resaved.len);

    console.log('6c. a Save that is refused takes no ink, so Cancel still means cancel');
    await b.clickText('button', 'Edit');
    await b.waitFor('document.querySelector("#dialog").open');
    const thumbBefore = await b.eval('document.querySelector(".image-slot .thumb img[alt^=\\"Stamp\\"]").src.length');
    await b.click('#co-stamp-draw');
    await b.eval(stroke(SCRIBBLE));
    await b.fill('#co-name', '');
    await b.clickText('#dialog button', 'Save');
    await b.wait(300);
    ok((await b.eval('document.querySelector("#dialog").open')) === true, 'a company with no name is not saved');
    ok((await b.eval('!!document.querySelector("#sign-pad")')) === true, 'and the pad is still open with its ink');
    await b.click('#sign-cancel');
    ok((await b.eval('document.querySelector(".image-slot .thumb img[alt^=\\"Stamp\\"]").src.length')) === thumbBefore, 'Cancel brings back the signature that was there', thumbBefore);
    await b.fill('#co-name', 'Ukázka s.r.o.');
    await b.clickText('#dialog button', 'Save');
    await b.waitFor('!document.querySelector("#dialog").open');
    await b.wait(400);
    ok((await b.eval('(function(){var d=JSON.parse(localStorage.getItem("invoice-workbench:v1"));var c=Object.keys(d.companies).map(function(k){return d.companies[k]})[0];return c.stamp.src.length})()')) === resaved.len, 'and that is the one that stays saved');

    console.log('7. on a phone the pad fits and a finger draws');
    await b.setViewport(390, 800, true);
    await b.goto(URL + '#companies', 2000);
    await b.clickText('button', 'Edit');
    await b.waitFor('document.querySelector("#dialog").open');
    await b.click('#co-stamp-draw');
    await b.eval(stroke(SCRIBBLE, 'touch'));
    ok((await b.eval(inked)) > 0, 'a touch stroke leaves ink');
    ok((await b.eval('(function(){var d=document.querySelector("#dialog .dialog-body");return d.scrollWidth<=d.clientWidth+1})()')) === true, 'the dialog does not scroll sideways');
    ok((await b.eval('(function(){var r=document.querySelector("#sign-pad").getBoundingClientRect();return r.width>250&&r.height>90})()')) === true, 'the pad is large enough to sign in');
    await b.eval('document.querySelector("#sign-pad").scrollIntoView({block:"center"})');
    await b.screenshot(path.join(OUT, 'sign-3-phone.png'));
    await b.click('#sign-cancel');
    ok((await b.eval('!!document.querySelector(".image-slot .thumb img[alt^=\\"Stamp\\"]")')) === true, 'Cancel keeps the signature that was there');

    console.log('8. no script errors');
    ok(b.errors.length === 0, 'no exceptions or console errors', b.errors);
  } catch (e) {
    failures++;
    console.log('  FAIL the run stopped: ' + (e && e.stack || e));
    try { await b.screenshot(path.join(OUT, 'sign-crash.png')); } catch (ignored) { /* nothing to show */ }
  } finally {
    await b.close();
  }
  console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})();
