/*
 * A very small driver for headless Chrome over the DevTools protocol, with no dependencies (Node 22+ has WebSocket).
 *
 *   const { launch } = require('./cdp.js');
 *   const b = await launch({ width: 1360, height: 900, dark: false });
 *   await b.goto('file:///.../index.html');
 *   await b.fill('#to-name', 'Acme');          // sets the value and fires `input`
 *   await b.click('#some-button');             // element.click()
 *   await b.clickText('button', 'New document');
 *   const v = await b.eval('document.title');  // any expression; promises are awaited
 *   await b.screenshot('/abs/out.png', { full: true });
 *   console.log(b.errors);                     // uncaught exceptions and console.error lines
 *   await b.close();
 */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function launch(opts = {}) {
  const width = opts.width || 1360;
  const height = opts.height || 900;
  const profile = opts.profile || path.join(__dirname, '.chrome-cdp-' + process.pid + '-' + Math.floor(Math.random() * 1e6));
  const port = opts.port || 9300 + Math.floor(Math.random() * 600);
  const child = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--allow-file-access-from-files', '--user-data-dir=' + profile, '--remote-debugging-port=' + port,
    '--window-size=' + width + ',' + height, 'about:blank'
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    await sleep(150);
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      target = list.find((t) => t.type === 'page');
    } catch (e) { /* not up yet */ }
  }
  if (!target) { child.kill(); throw new Error('Chrome did not start'); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let nextId = 1;
  const pending = new Map();
  const errors = [];
  const logs = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push('EXCEPTION ' + ((d.exception && d.exception.description) || d.text));
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map((a) => (a.value !== undefined ? String(a.value) : a.description || '')).join(' ');
      (msg.params.type === 'error' ? errors : logs).push('console.' + msg.params.type + ' ' + text);
    } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      errors.push('LOG ' + msg.params.entry.text + ' ' + (msg.params.entry.url || ''));
    }
  };
  function send(method, params) {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: opts.scale || 1, mobile: !!opts.mobile });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: opts.dark ? 'dark' : 'light' }] });

  async function evaluate(expression) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error('eval failed: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result.value;
  }

  const b = {
    errors, logs, send, eval: evaluate,
    async goto(url, waitMs) {
      // a URL that differs from the current one only by its #hash would not load the page again, and a test that
      // means "reload" would silently test nothing: leave the page first, so every goto is a real load
      await send('Page.navigate', { url: 'about:blank' });
      await sleep(120);
      await send('Page.navigate', { url });
      await sleep(waitMs == null ? 1500 : waitMs);
    },
    async wait(ms) { await sleep(ms); },
    async waitFor(expression, timeoutMs) {
      const end = Date.now() + (timeoutMs || 8000);
      while (Date.now() < end) {
        if (await evaluate('!!(' + expression + ')')) return true;
        await sleep(100);
      }
      throw new Error('waitFor timed out: ' + expression);
    },
    async click(selector) {
      const ok = await evaluate('(function(){var el=document.querySelector(' + JSON.stringify(selector) + ');if(!el)return false;el.click();return true;})()');
      if (!ok) throw new Error('click: nothing matches ' + selector);
      await sleep(60);
    },
    /** Clicks the first element matching `selector` whose trimmed text is exactly `text`. */
    async clickText(selector, text) {
      const ok = await evaluate('(function(){var els=document.querySelectorAll(' + JSON.stringify(selector) + ');for(var i=0;i<els.length;i++){if(els[i].textContent.trim()===' + JSON.stringify(text) + '){els[i].click();return true;}}return false;})()');
      if (!ok) throw new Error('clickText: no ' + selector + ' with text ' + text);
      await sleep(60);
    },
    /** Sets a text input, textarea or select and fires the event the page listens to. */
    async fill(selector, value) {
      const ok = await evaluate('(function(){var el=document.querySelector(' + JSON.stringify(selector) + ');if(!el)return false;el.focus();el.value=' + JSON.stringify(String(value)) + ';el.dispatchEvent(new Event(el.tagName==="SELECT"?"change":"input",{bubbles:true}));return true;})()');
      if (!ok) throw new Error('fill: nothing matches ' + selector);
      await sleep(40);
    },
    async check(selector, on) {
      const ok = await evaluate('(function(){var el=document.querySelector(' + JSON.stringify(selector) + ');if(!el)return false;if(el.checked!==' + (on ? 'true' : 'false') + ')el.click();return true;})()');
      if (!ok) throw new Error('check: nothing matches ' + selector);
      await sleep(40);
    },
    async text(selector) {
      return evaluate('(function(){var el=document.querySelector(' + JSON.stringify(selector) + ');return el?el.textContent:null;})()');
    },
    async setViewport(w, h, mobile) {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: !!mobile });
      await sleep(150);
    },
    async setDark(dark) {
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
      await sleep(100);
    },
    async screenshot(file, o) {
      const params = { format: 'png' };
      if (o && o.full) params.captureBeyondViewport = true;
      if (o && o.full) {
        const m = await send('Page.getLayoutMetrics');
        const s = m.cssContentSize || m.contentSize;
        params.clip = { x: 0, y: 0, width: Math.ceil(s.width), height: Math.min(Math.ceil(s.height), o.maxHeight || 6000), scale: 1 };
      }
      const r = await send('Page.captureScreenshot', params);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      return file;
    },
    async close() {
      try { ws.close(); } catch (e) { /* already closed */ }
      child.kill();
      await sleep(200);
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* leave it */ }
    }
  };
  return b;
}

module.exports = { launch, sleep };
