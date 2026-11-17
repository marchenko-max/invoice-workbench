/*
 * The screens of Invoice Workbench: the document list, the editor with its live preview, the companies and the backup.
 * Rules live in core.js, labels of a document in i18n.js, drawing in render.js, storage in store.js.
 * Everything a person types reaches the page through textContent or an input's value, never through innerHTML;
 * the one innerHTML here takes the SVG that render.js builds, which escapes its own text.
 */
(function () {
  'use strict';

  var C = window.InvoiceCore;
  var I18N = window.InvoiceI18n;
  var Store = window.InvoiceStore;
  function renderer() { return window.InvoiceRender || null; }

  // how the app's own screens write numbers and dates (the documents follow their own language)
  var UI = {
    date: 'D MMM YYYY', months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    decimal: '.', group: ',', percent: '{n}%', prefixSymbols: []
  };

  var KIND_LABEL = {
    invoice_vat: 'Invoice with VAT (I am a VAT payer)', invoice_novat: 'Invoice without VAT (I am not a VAT payer)',
    corrective: 'Corrective tax document', reverse_charge: 'Reverse-charge invoice',
    quote_vat: 'Quotation with VAT', quote_novat: 'Quotation without VAT',
    proforma: 'Proforma invoice', advance: 'Advance invoice'
  };
  var KIND_SHORT = {
    invoice_vat: 'Invoice', invoice_novat: 'Invoice', corrective: 'Corrective document', reverse_charge: 'Reverse-charge invoice',
    quote_vat: 'Quotation', quote_novat: 'Quotation', proforma: 'Proforma', advance: 'Advance invoice'
  };
  var PAYMENT_LABEL = { transfer: 'Bank transfer', cash: 'Cash', card: 'Card', cod: 'Cash on delivery', paypal: 'PayPal', offset: 'Mutual offset' };
  var ROUNDING_LABEL = { none: 'No rounding', '0.1': 'To the nearest 0.10', '0.5': 'To the nearest 0.50', '1': 'To whole units' };
  var STATUS_LABEL = { draft: 'Draft', issued: 'Issued', overdue: 'Overdue', paid: 'Paid' };
  var COLORS = ['#1d4e89', '#0f766e', '#b45309', '#6d28d9', '#b91c1c', '#1f2937'];
  var LAST_DOC_KEY = 'invoice-workbench:last-document';
  var MAX_IMAGE_CHARS = 90000;

  var COUNTRY_CODES = ('CZ SK DE AT PL HU AD AE AF AG AI AL AM AO AQ AR AS AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
    'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN ' +
    'GP GQ GR GS GT GU GW GY HK HM HN HR HT ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU ' +
    'LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PM PN PR ' +
    'PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA ' +
    'UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW').split(' ');

  var S = {
    mode: 'memory',
    loaded: false,
    loadError: '',
    companies: [],
    invoices: [],
    settings: {},
    view: '',
    doc: null,          // the document open in the editor (the same object that sits in S.invoices once saved)
    example: false,     // the open document is the made-up example: nothing about it is ever saved
    exampleSupplier: null,
    dirty: false,
    pane: 'edit',
    filters: { q: '', supplier: '', status: '' },
    newFor: '',
    folderGate: false,  // a folder is chosen but the browser has not let us into it yet: show nothing, save nothing
    moveIncomplete: 0,  // records that could not be written into the folder yet and are still only in this browser
    absorbed: null      // what the last read moved in from the browser: { moved, complete, clashes }
  };

  var saveTimer = null;
  var previewTimer = null;
  var saveState = 'idle';
  var storeStatus = { saving: false, error: null };

  // ------------------------------------------------------------------ dom

  function $(sel) { return document.querySelector(sel); }

  function append(el, child) {
    if (child == null || child === false || child === true) return;
    if (Array.isArray(child)) child.forEach(function (c) { append(el, c); });
    else if (child.nodeType) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }

  /** h('div', {class: 'x', onclick: fn}, child, [children]) -> element. Strings become text nodes. */
  function h(tag, attrs) {
    var el = document.createElement(tag);
    var late = null;
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'dataset') Object.keys(v).forEach(function (d) { el.dataset[d] = v[d]; });
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'value') late = v;
        else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'selected' || k === 'open') el[k] = !!v;
        else el.setAttribute(k, v === true ? '' : String(v));
      });
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    if (late != null) el.value = late;
    return el;
  }

  function field(label, control, opts) {
    opts = opts || {};
    var wrap = h('div', { class: 'field' + (opts.cls ? ' ' + opts.cls : '') }, h('label', { class: 'label', for: control.id, text: label }), control);
    if (opts.hint) wrap.appendChild(typeof opts.hint === 'string' ? h('span', { class: 'hint', text: opts.hint }) : opts.hint);
    return wrap;
  }

  function button(label, onclick, cls, attrs) {
    var a = { type: 'button', class: 'btn' + (cls ? ' ' + cls : ''), onclick: onclick };
    if (attrs) Object.keys(attrs).forEach(function (k) { a[k] = attrs[k]; });
    return h('button', a, label);
  }

  /** A destructive button that asks once more in place (the frame has no confirm()). */
  function confirmButton(label, question, onYes, cls) {
    var wrap = h('span', { class: 'row', style: 'display:inline-flex' });
    function idle(focus) {
      wrap.textContent = '';
      var first = button(label, ask, cls || 'small quiet');
      wrap.appendChild(first);
      if (focus) first.focus();
    }
    function ask(ev) {
      if (ev) ev.stopPropagation();
      wrap.textContent = '';
      wrap.appendChild(h('span', { class: 'hint warn', role: 'alert', text: question }));
      wrap.appendChild(button('Yes, delete', function (e) {
        e.stopPropagation();
        onYes();
        // the row is gone: put the keyboard somewhere sensible instead of leaving it on nothing
        if (!document.activeElement || document.activeElement === document.body) {
          var next = document.querySelector('#view .btn.primary, #view a.btn');
          if (next && next.focus) next.focus();
        }
      }, 'small danger'));
      var keep = button('Keep', function (e) { e.stopPropagation(); idle(true); }, 'small');
      wrap.appendChild(keep);
      keep.focus();
    }
    idle();
    return wrap;
  }

  function toast(message, kind) {
    var host = $('#toasts');
    var dlg = $('#dialog');
    // an open dialog sits above the page, so its messages live in the slot under its heading
    if (dlg && dlg.open && dlg.querySelector('.toasts')) host = dlg.querySelector('.toasts');
    if (!host) return;
    var el = h('div', { class: 'toast' + (kind === 'bad' ? ' bad' : ''), text: message });
    host.appendChild(el);
    setTimeout(function () {
      el.classList.add('leaving');      // it leaves the way it came
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
    }, kind === 'bad' ? 7000 : 3500);
  }

  function errorText(e) {
    if (!e) return 'Something went wrong.';
    if (e.code === 'quota_exceeded') return S.mode === 'folder' ? 'The disk is full. Free some space, then change anything to save again.' : 'The storage is full. Delete documents you no longer need, or remove a large logo.';
    if (e.code === 'timeout') return 'The saved data did not answer in time.';
    if (e.code === 'revoked' || e.code === 'not_granted') return 'This view may no longer save. Reopen the page.';
    if (e.code === 'invalid_argument') return 'This could not be saved here. A logo or stamp may be too large, or this view is read-only.';
    return e.message || 'Something went wrong.';
  }

  // -------------------------------------------------------------- lookups

  function suppliers() { return S.companies.filter(function (c) { return c.kind === 'supplier'; }).sort(byName); }
  function customers() { return S.companies.filter(function (c) { return c.kind === 'customer'; }).sort(byName); }
  function byName(a, b) { return String(a.name || '').localeCompare(String(b.name || '')); }
  function companyById(id) {
    if (!id) return null;
    if (S.exampleSupplier && S.exampleSupplier.id === id) return S.exampleSupplier;
    for (var i = 0; i < S.companies.length; i++) if (S.companies[i].id === id) return S.companies[i];
    return null;
  }
  function isSaved(doc) { return S.invoices.indexOf(doc) !== -1; }
  function today() { return C.localToday(); }

  var displayNames = {};
  function countryName(code, lang) {
    if (!code) return '';
    var locale = lang === 'sr' ? 'sr-Latn' : (lang || 'en');
    try {
      if (!displayNames[locale]) displayNames[locale] = new Intl.DisplayNames([locale], { type: 'region' });
      return displayNames[locale].of(code) || code;
    } catch (e) {
      return code;
    }
  }

  var countryOptionsCache = null;
  function countryOptions() {
    if (countryOptionsCache) return countryOptionsCache;
    var head = COUNTRY_CODES.slice(0, 6).map(function (c) { return { value: c, label: countryName(c, 'en') }; });
    var rest = COUNTRY_CODES.slice(6).map(function (c) { return { value: c, label: countryName(c, 'en') }; })
      .sort(function (a, b) { return a.label.localeCompare(b.label); });
    countryOptionsCache = head.concat(rest);
    return countryOptionsCache;
  }

  function addressLine(p) {
    return [p.street, [p.postcode, p.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  }

  function money(cents, currency) { return C.formatMoney(cents, currency || 'CZK', UI); }

  // ------------------------------------------------------ bound controls

  function bindText(obj, key, id, opts) {
    opts = opts || {};
    var el = h(opts.multiline ? 'textarea' : 'input', {
      id: id, type: opts.multiline ? null : (opts.type || 'text'), placeholder: opts.placeholder, autocomplete: 'off',
      rows: opts.multiline ? (opts.rows || 2) : null, inputmode: opts.inputmode, list: opts.list, maxlength: opts.maxlength,
      class: opts.cls
    });
    el.value = obj[key] == null ? '' : String(obj[key]);
    if (opts.multiline) el.dataset.autosize = '1';
    el.addEventListener('input', function () {
      var before = obj[key];
      if (opts.filter) {
        var typed = el.value;
        var kept = opts.filter(typed);
        if (kept !== typed) {
          // put the caret back after what survived to its left, not at the end of the field
          var caret = typeof el.selectionStart === 'number' ? opts.filter(typed.slice(0, el.selectionStart)).length : kept.length;
          el.value = kept;
          try { el.setSelectionRange(caret, caret); } catch (e) { /* not a text field */ }
        }
      }
      obj[key] = el.value;
      if (opts.multiline) autosize(el);
      if (opts.after) opts.after(el.value, before);
      (opts.changed || touch)();
    });
    return el;
  }

  /** A text area as tall as what is typed in it, so a second line is never cut off. */
  function autosize(el) {
    el.style.height = 'auto';
    el.style.height = (el.scrollHeight + 2) + 'px';
  }

  function autosizeAll(host) {
    if (!host) return;
    Array.prototype.forEach.call(host.querySelectorAll('textarea[data-autosize]'), autosize);
  }

  function bindNumber(obj, key, id, opts) {
    opts = opts || {};
    var el = h('input', { id: id, type: 'text', inputmode: 'decimal', class: 'num', autocomplete: 'off', placeholder: opts.placeholder, list: opts.list });
    el.value = obj[key] == null || obj[key] === '' ? '' : String(obj[key]);
    el.addEventListener('input', function () {
      var n = C.parseNumber(el.value);
      var bad = el.value.trim() !== '' && isNaN(n);
      if (bad) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid');
      obj[key] = isNaN(n) ? 0 : n;
      (opts.changed || touch)();
    });
    return el;
  }

  /** A payment symbol is digits only, ten at most. */
  function digits10(value) { return C.digitsOnly(value).slice(0, 10); }

  function bindSelect(obj, key, id, options, opts) {
    opts = opts || {};
    var el = h('select', { id: id }, options.map(function (o) { return h('option', { value: String(o.value), text: o.label }); }));
    el.value = String(obj[key] == null ? '' : obj[key]);
    el.addEventListener('change', function () {
      var raw = el.value;
      obj[key] = opts.cast ? opts.cast(raw) : raw;
      if (opts.after) opts.after(obj[key]);
      (opts.changed || touch)();
      if (opts.rebuild) rebuildForm();
    });
    return el;
  }

  function bindCheck(obj, key, id, label, opts) {
    opts = opts || {};
    var box = h('input', { id: id, type: 'checkbox' });
    box.checked = !!obj[key];
    box.addEventListener('change', function () {
      obj[key] = box.checked;
      if (opts.after) opts.after(box.checked);
      (opts.changed || touch)();
      if (opts.rebuild) rebuildForm();
    });
    return h('label', { class: 'check' }, box, h('span', null, label, opts.hint ? h('span', { class: 'hint', text: ' ' + opts.hint }) : null));
  }

  // ---------------------------------------------------------------- shell

  function setTab(view) {
    ['documents', 'editor', 'companies', 'backup'].forEach(function (v) {
      var el = $('#tab-' + v);
      if (!el) return;
      if (v === view) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
    });
  }

  function renderStorageState() {
    var el = $('#storage-state');
    if (!el) return;
    var dot = 'dot', text;
    if (!S.loaded && !S.loadError) { dot = 'dot warn'; text = 'Opening your saved data…'; }
    else if (S.loadError) { dot = 'dot bad'; text = 'Saved data unreachable'; }
    else if (storeStatus.error) { dot = 'dot bad'; text = 'Not saved: ' + errorText(storeStatus.error); }
    else if (storeStatus.saving) { dot = 'dot warn'; text = 'Saving…'; }
    else if (S.folderGate) { dot = 'dot warn'; text = 'Folder not connected'; }
    else if (S.mode === 'folder' && S.moveIncomplete) { dot = 'dot warn'; text = 'Some records are still only in this browser'; }
    else if (S.mode === 'folder') text = 'Saved in the folder \u201c' + Store.folderState().name + '\u201d';
    else if (S.mode === 'cloud') text = 'Saved to your account';
    else if (S.mode === 'local') text = 'Saved in this browser';
    else { dot = 'dot warn'; text = 'Nothing is saved in this view'; }
    el.textContent = '';
    el.appendChild(h('span', { class: dot, 'aria-hidden': 'true' }));
    el.appendChild(h('span', { text: text }));
  }

  // -------------------------------------------------------------- loading

  /** A logo or stamp that is not a plain PNG or JPEG data URL never reaches a screen or a PDF. */
  function cleanCompany(c) {
    if (c.kind === 'supplier') {
      c.logo = C.normalizeImage(c.logo);
      c.stamp = C.normalizeImage(c.stamp);
    }
    return c;
  }

  function truncatedNotice() {
    return h('div', { class: 'notice warn' }, h('p', null, h('strong', { text: 'Only the first 1,000 records were loaded. ' }),
      'The rest are still stored, but this page does not show them. Export a backup and delete documents you no longer need.'));
  }

  async function loadData() {
    S.loadError = '';
    S.loaded = false;
    renderStorageState();
    try {
      var data = await Store.load();
      S.companies = (data.companies || []).filter(function (c) { return c && c.id; }).map(cleanCompany);
      S.truncated = !!data.truncated;
      S.invoices = (data.invoices || []).filter(function (d) { return d && d.id; }).map(C.normalizeInvoice);
      S.settings = data.settings || {};
      S.loaded = true;
      S.absorbed = await absorbBrowserCopy();
    } catch (e) {
      S.loadError = errorText(e);
    }
    renderStorageState();
  }

  var lastPressedId = '';
  var THEME_KEY = 'invoice-workbench:theme';

  /** The copy opened from disk can be told to stay light or dark; inside claude.ai the app around the page decides. */
  function setUpAppearance() {
    var select = $('#theme-select');
    if (!select || window.claude) return;
    var stored = '';
    try { stored = localStorage.getItem(THEME_KEY) || ''; } catch (e) { stored = ''; }
    select.value = stored === 'light' || stored === 'dark' ? stored : '';
    select.hidden = false;
    select.addEventListener('change', function () {
      var choice = select.value;
      if (choice === 'light' || choice === 'dark') document.documentElement.setAttribute('data-theme', choice);
      else document.documentElement.removeAttribute('data-theme');
      try {
        if (choice) localStorage.setItem(THEME_KEY, choice);
        else localStorage.removeItem(THEME_KEY);
      } catch (e) { /* the choice then lasts for this visit only */ }
    });
  }

  async function boot() {
    setUpAppearance();
    document.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('button[id], a[id]') : null;
      lastPressedId = t ? t.id : '';
    }, true);
    Store.onStatus(function (st) { storeStatus = st; renderStorageState(); renderSaveState(); });
    document.body.appendChild(h('datalist', { id: 'vat-list' }, C.VAT_RATES.map(function (r) { return h('option', { value: String(r) }); })));
    var r = renderer();
    if (r && r.ready) { try { await r.ready(); } catch (e) { /* the preview says so itself */ } }
    S.mode = await Store.init();
    var folderNow = Store.folderState();
    S.folderGate = folderNow.configured && !folderNow.granted;
    await loadData();
    window.addEventListener('hashchange', route);
    // the floating bar draws its edge only once content has scrolled under it
    window.addEventListener('scroll', function () {
      document.documentElement.classList.toggle('scrolled', window.scrollY > 4);
    }, { passive: true });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') saveNow(); });
    window.addEventListener('pagehide', saveNow);
    route();
  }

  function route() {
    var view = (location.hash || '').replace(/^#/, '');
    if (['documents', 'editor', 'companies', 'backup'].indexOf(view) === -1) view = '';
    if (S.loadError) { setTab(view || 'documents'); renderLoadError(); return; }
    if (S.folderGate) { setTab(view || 'documents'); renderFolderGate(); return; }
    if (!view) view = suppliers().length ? 'documents' : 'editor';
    if (S.view === 'editor' && view !== 'editor') saveNow();
    S.view = view;
    setTab(view);
    if (view === 'editor') {
      if (S.example && suppliers().length) leaveExample();
      if (!S.doc) restoreOpenDocument();
      renderEditor();
    } else if (view === 'companies') renderCompanies();
    else if (view === 'backup') renderBackup();
    else renderDocuments();
    // the new screen fades in over the old ground: a cross-fade, never a slide
    var host = $('#view');
    if (host) { host.classList.remove('entering'); void host.offsetWidth; host.classList.add('entering'); }
    window.scrollTo(0, 0);
  }

  function go(view) {
    if (location.hash === '#' + view) route();
    else location.hash = '#' + view;
  }

  // ------------------------------------------------------------- the folder

  /** After a press redrew the screen, the keyboard goes to the same control if it is still there, else to the heading. */
  function focusPage() {
    var again = lastPressedId ? document.getElementById(lastPressedId) : null;
    var target = again || $('#view h1') || $('#view strong');
    if (!target) return;
    if (!again) target.setAttribute('tabindex', '-1');
    try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); }
  }

  function showView(view) {
    try { if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view); } catch (e) { location.hash = '#' + view; }
    route();
  }

  /** The folder is chosen but closed to us: nothing is shown and nothing is saved until the person decides. */
  function renderFolderGate() {
    var state = Store.folderState();
    var view = $('#view');
    view.textContent = '';
    view.appendChild(h('div', { class: 'wrap page' }, h('div', { class: 'panel empty' },
      h('strong', { text: 'Your data is in the folder \u201c' + state.name + '\u201d' }),
      h('span', { text: 'The browser asks again on every visit before this page may read and write that folder. Nothing is shown until it is connected, so that nothing gets saved in the wrong place.' }),
      h('div', { class: 'row' },
        button('Connect the folder', reconnectFolder, 'primary', { id: 'folder-reconnect' }),
        button('Choose another folder', pickFolder, '', { id: 'folder-choose' }),
        button('Work in this browser instead', function () { S.folderGate = false; renderStorageState(); route(); focusPage(); }, 'quiet', { id: 'folder-skip' })))));
  }

  /** Anything typed in the last second is saved where the page saves now, before that place changes. */
  async function settleBeforeSwitch() {
    try { await saveNow(); } catch (e) { /* the save state already says so */ }
    await Store.flush();
  }

  async function reconnectFolder() {
    await settleBeforeSwitch();
    try {
      await Store.reconnectFolder();
    } catch (e) {
      toast(e && e.code === 'declined' ? 'The folder was not connected.' : 'The folder could not be opened. ' + errorText(e), 'bad');
      return;
    }
    await enterFolder();
  }

  async function pickFolder() {
    await settleBeforeSwitch();
    try {
      await Store.chooseFolder();
    } catch (e) {
      if (!(e && e.code === 'declined')) toast('The folder could not be used. ' + errorText(e), 'bad');
      return;
    }
    await enterFolder();
  }

  /** The folder is open: read it. Reading also moves in whatever this browser still holds on its own. */
  async function enterFolder() {
    var wasGate = S.folderGate;
    clearTimeout(saveTimer);
    S.dirty = false;
    S.doc = null;
    leaveExample();
    rememberOpen(null);
    S.mode = Store.getMode();
    S.folderGate = false;
    await loadData();
    renderStorageState();
    if (S.loadError) { route(); return; }
    if (wasGate || S.view !== 'backup') showView('documents'); else route();
    focusPage();
    if (S.absorbed && !S.absorbed.complete) return;   // its own message is already on screen
    var moved = S.absorbed ? S.absorbed.moved : 0;
    toast(moved ? 'Connected. ' + moved + (moved === 1 ? ' record was' : ' records were') + ' moved from this browser into the folder.' : 'Connected to the folder.');
  }

  /**
   * With a folder connected, the folder is the one truth. Whatever this browser still holds on its own is moved in:
   * a record the folder lacks, or a newer version of one it has. The browser's copy is emptied only when every
   * write succeeded. Until then the leftovers stay there, are tried again on every read, and the screens say so.
   */
  async function absorbBrowserCopy() {
    var result = { moved: 0, complete: true, clashes: [] };
    if (S.mode !== 'folder') { S.moveIncomplete = 0; return result; }
    var held = Store.browserCopy();
    var heldSettings = held.settings || {};
    if (!held.companies.length && !held.invoices.length && !Object.keys(heldSettings).length) { S.moveIncomplete = 0; return result; }
    var jobs = [];
    var movedInvoices = [];
    function merge(list, incoming, put, remember) {
      var at = Object.create(null);
      list.forEach(function (rec, i) { at[rec.id] = i; });
      incoming.forEach(function (rec) {
        var i = at[rec.id];
        if (i === undefined) { list.push(rec); at[rec.id] = list.length - 1; }
        else if (String(rec.updatedAt || '') > String(list[i].updatedAt || '')) list[i] = rec;   // the browser's version is the newer one
        else return;
        jobs.push(put(rec));
        if (remember) remember.push(rec);
      });
    }
    merge(S.companies, held.companies.filter(function (c) { return c.kind === 'supplier' || c.kind === 'customer'; }).map(cleanCompany), Store.putCompany, null);
    merge(S.invoices, held.invoices.map(C.normalizeInvoice), Store.putInvoice, movedInvoices);
    result.moved = jobs.length;
    var settingsChanged = false;
    Object.keys(heldSettings).forEach(function (k) {
      if (S.settings[k] === undefined) { S.settings[k] = heldSettings[k]; settingsChanged = true; }
    });
    if (settingsChanged) jobs.push(Store.putSettings(S.settings));
    var outcomes = await Promise.all(jobs.map(function (job) {
      return job.then(function () { return true; }, function () { return false; });
    }));
    var failedCount = outcomes.filter(function (fine) { return !fine; }).length;
    result.complete = failedCount === 0;
    S.moveIncomplete = failedCount;
    if (result.complete) Store.clearBrowserCopy();
    else toast(failedCount + (failedCount === 1 ? ' record is' : ' records are') + ' still only in this browser, because the folder could not be written. Open the Backup tab to try again.', 'bad');
    // two documents of one company and one series must not share a number
    movedInvoices.forEach(function (d) {
      var number = String(d.number || '');
      if (!number || result.clashes.indexOf(number) !== -1) return;
      var twin = S.invoices.some(function (x) {
        return x !== d && x.supplierId === d.supplierId && C.kindOf(x).series === C.kindOf(d).series && String(x.number) === number;
      });
      if (twin) result.clashes.push(number);
    });
    if (result.clashes.length) toast('Two documents now share the number ' + result.clashes.join(', ') + '. Change one of them.', 'bad');
    return result;
  }

  /** Back to this browser's own storage, with the same records. The files stay in the folder as they are. */
  async function leaveFolder() {
    var unreadable = !!S.loadError;
    if (!unreadable) await settleBeforeSwitch();
    await Store.forgetFolder({ keepBrowserCopy: unreadable });
    S.mode = Store.getMode();
    S.folderGate = false;
    S.moveIncomplete = 0;
    if (unreadable) {
      // the folder could not be read, so there is nothing to carry over: the page goes on with what the browser holds
      S.doc = null;
      rememberOpen(null);
      await loadData();
      renderStorageState();
      route();
      focusPage();
      toast('The folder is no longer used.');
      return;
    }
    var jobs = S.companies.map(function (c) { return Store.putCompany(c); })
      .concat(S.invoices.map(function (d) { return Store.putInvoice(d); }));
    jobs.push(Store.putSettings(S.settings));
    try {
      await Promise.all(jobs);
      toast('The folder is no longer used. Its files were left as they are.');
    } catch (e) {
      toast('Not everything fitted into this browser\u2019s storage. ' + errorText(e), 'bad');
    }
    renderStorageState();
    route();
    focusPage();
  }

  function folderSection(state) {
    var sec = h('section', { class: 'section', id: 'folder-section' }, h('header', null, h('h2', { text: 'Keep the data in a folder' })));
    if (!state.supported) {
      sec.appendChild(h('p', { class: 'muted', text: 'This browser cannot write to a folder. Open this page in Chrome or Edge on a computer to keep your data as files you own.' }));
      return sec;
    }
    if (S.mode === 'folder') {
      sec.appendChild(h('p', { class: 'muted', text: 'Connected to \u201c' + state.name + '\u201d. Every change is written to its files as you work: companies, documents, settings.json, and a copy of each PDF you download in PDF.' }));
      if (S.moveIncomplete) {
        sec.appendChild(h('div', { class: 'notice bad' },
          h('p', { text: S.moveIncomplete + (S.moveIncomplete === 1 ? ' record is' : ' records are') + ' still only in this browser, because the folder could not be written. Nothing is lost: they are shown here and kept in the browser until they are in the folder.' }),
          button('Try again', async function () { await loadData(); route(); focusPage(); }, 'primary', { id: 'folder-retry-move' })));
      }
      if (state.skipped.length) {
        sec.appendChild(h('div', { class: 'notice warn' }, h('p', {
          text: state.skipped.length + (state.skipped.length === 1 ? ' file in the folder was' : ' files in the folder were') +
            ' not loaded and left untouched (not a record of this app, or an older copy of one): ' +
            state.skipped.slice(0, 8).join(', ') + (state.skipped.length > 8 ? ' and more.' : '.')
        })));
      }
      var lostAccess = storeStatus.error && (storeStatus.error.code === 'folder_access' || storeStatus.error.code === 'folder_missing');
      sec.appendChild(h('div', { class: 'row' },
        lostAccess ? button('Connect the folder', reconnectFolder, 'primary', { id: 'folder-reconnect' }) : null,
        button('Read the folder again', async function () {
          await settleBeforeSwitch();
          S.doc = null;
          rememberOpen(null);
          await loadData();
          route();
          focusPage();
          if (!S.loadError) toast('Read again from the folder.');
        }, '', { id: 'folder-reload' }),
        button('Choose another folder', pickFolder, '', { id: 'folder-choose' }),
        button('Stop using the folder', leaveFolder, 'quiet', { id: 'folder-leave' })));
      return sec;
    }
    sec.appendChild(h('p', { class: 'muted', text: 'Pick a folder on this computer, for example one in iCloud Drive. Every company and document becomes a JSON file in it, and each PDF you download is copied there too. What this browser holds now is moved into the folder. The browser asks for permission again each time you open this page.' }));
    var row = h('div', { class: 'row' });
    if (state.configured) row.appendChild(button('Connect the folder \u201c' + state.name + '\u201d', reconnectFolder, 'primary', { id: 'folder-reconnect' }));
    row.appendChild(button(state.configured ? 'Choose another folder' : 'Choose a folder', pickFolder, state.configured ? '' : 'primary', { id: 'folder-choose' }));
    sec.appendChild(row);
    return sec;
  }

  function renderLoadError() {
    var view = $('#view');
    view.textContent = '';
    var actions = h('div', { class: 'row' }, button('Try again', async function () { await loadData(); route(); focusPage(); }, 'primary', { id: 'load-retry' }));
    if (Store.folderState().configured) {
      // the data is in a folder that cannot be read just now: every way out is offered here, because no other tab is
      actions.appendChild(button('Connect the folder', reconnectFolder, '', { id: 'folder-reconnect' }));
      actions.appendChild(button('Choose another folder', pickFolder, '', { id: 'folder-choose' }));
      actions.appendChild(button('Stop using the folder', leaveFolder, 'quiet', { id: 'folder-leave' }));
    }
    view.appendChild(h('div', { class: 'wrap page' },
      h('div', { class: 'notice bad' },
        h('p', null, h('strong', { text: 'Your saved data could not be opened. ' }), S.loadError + ' Nothing was lost: it is still stored, this view just could not read it.'),
        actions)));
  }

  // ------------------------------------------------------------- example

  function makeExample() {
    var sup = C.newCompany('supplier');
    Object.assign(sup, {
      name: 'Vzorová dílna s.r.o.', companyNumber: '12345679', taxNumber: 'CZ12345679', street: 'Ukázková 12', city: 'Praha 1',
      postcode: '110 00', country: 'CZ', email: 'fakturace@vzorova-dilna.example', phone: '+420 600 000 000', web: 'vzorova-dilna.example',
      vatPayer: true, registerNote: 'Společnost je zapsána v obchodním rejstříku (ukázkový údaj).'
    });
    sup.bank.account = '1234567899/9999';
    sup.defaults.issuedBy = 'Jana Vzorová';
    var doc = C.newInvoice(sup, { today: today() });
    Object.assign(doc.customer, {
      name: 'Ukázkový odběratel a.s.', companyNumber: '87654326', taxNumber: 'CZ87654326', street: 'Příkladná 7', city: 'Brno',
      postcode: '602 00', country: 'CZ'
    });
    doc.items = [
      Object.assign(C.newItem(21), { qty: 12, unit: 'hod.', description: 'Návrh a programování webu', price: 1500 }),
      Object.assign(C.newItem(21), { qty: 1, unit: 'ks', description: 'Správa obsahu, měsíční paušál', price: 4800, discount: { type: 'percent', value: 10 } }),
      Object.assign(C.newItem(12), { qty: 3, unit: 'ks', description: 'Tištěná příručka pro redaktory', price: 320 })
    ];
    doc.note = 'Ukázkový doklad. Děkujeme za spolupráci.';
    S.exampleSupplier = sup;
    S.example = true;
    S.doc = doc;
    S.dirty = false;
  }

  function leaveExample() {
    S.example = false;
    S.exampleSupplier = null;
    S.doc = null;
  }

  // --------------------------------------------------- opening documents

  function rememberOpen(id) {
    try { if (id) localStorage.setItem(LAST_DOC_KEY, id); else localStorage.removeItem(LAST_DOC_KEY); } catch (e) { /* a convenience only */ }
  }

  /** The company the last document was issued by is the one the next New document starts with. */
  function rememberSupplier(id) {
    if (S.settings.lastSupplierId === id) return;
    S.settings.lastSupplierId = id;
    Store.putSettings(S.settings).catch(function () { /* a convenience only */ });
  }

  function restoreOpenDocument() {
    var id = null;
    try { id = localStorage.getItem(LAST_DOC_KEY); } catch (e) { id = null; }
    var found = id ? S.invoices.filter(function (d) { return d.id === id; })[0] : null;
    if (found) { S.doc = found; S.example = false; S.dirty = false; return; }
    if (!suppliers().length) makeExample();
  }

  function openDocument(doc) {
    saveNow();
    leaveExample();
    S.doc = doc;
    S.dirty = false;
    S.pane = 'edit';
    rememberOpen(doc.id);
    go('editor');
  }

  function newDocument(supplier, opts) {
    opts = opts || {};
    saveNow();
    leaveExample();
    var doc = C.newInvoice(supplier, { today: today(), existing: S.invoices, kind: opts.kind });
    if (opts.customer) {
      doc.customerId = opts.customer.id;
      doc.customer = C.partySnapshot(opts.customer);
    }
    S.doc = doc;
    S.dirty = false;
    S.pane = 'edit';
    rememberOpen(null);
    rememberSupplier(supplier.id);
    go('editor');
  }

  function startNewDocument(opts) {
    var list = suppliers();
    if (!list.length) { openCompanyDialog(C.newCompany('supplier'), { isNew: true, then: function (c) { newDocument(c, opts); } }); return; }
    var chosen = companyById(S.newFor) || companyById(S.settings.lastSupplierId) || list[0];
    if (!chosen || chosen.kind !== 'supplier') chosen = list[0];
    newDocument(chosen, opts);
  }

  function duplicateDocument(doc) {
    var sup = companyById(doc.supplierId);
    var copy = C.duplicateInvoice(doc, {
      today: today(), existing: S.invoices,
      pattern: sup && sup.defaults ? sup.defaults.numberPattern : undefined
    });
    saveNow();
    leaveExample();
    S.doc = copy;
    S.dirty = true;
    S.pane = 'edit';
    go('editor');
    scheduleSave();
    toast('Copied as ' + copy.number + '. Check the dates and items.');
  }

  // ---------------------------------------------------------------- saving

  function setSaveState(state) { saveState = state; renderSaveState(); }

  function renderSaveState() {
    var el = $('#save-state');
    if (!el) return;
    var text = '';
    var cls = 'save-state';
    if (S.example) text = 'Example: nothing here is saved';
    else if (storeStatus.error && saveState === 'error') { text = 'Not saved: ' + errorText(storeStatus.error); cls += ' error'; }
    else if (saveState === 'pending' || saveState === 'saving') text = 'Saving…';
    else if (saveState === 'saved') text = S.mode === 'memory' ? 'Kept until you close this page' : 'Saved';
    else if (S.doc && !isSaved(S.doc)) text = 'New: saved once you change something';
    el.className = cls;
    el.textContent = text;
  }

  /** The person changed the open document. */
  function touch() {
    refreshComputed();
    if (S.example || !S.doc) return;
    S.dirty = true;
    setSaveState('pending');
    scheduleSave();
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 900);
  }

  function saveNow() {
    clearTimeout(saveTimer);
    var doc = S.doc;
    if (failedDocs.length) {
      var again = failedDocs.indexOf(doc);
      if (again !== -1 && !S.example) { failedDocs.splice(again, 1); S.dirty = true; }
      retryFailed();
    }
    if (!doc || S.example || !S.dirty) return Promise.resolve();
    var now = new Date().toISOString();
    if (!doc.createdAt) doc.createdAt = now;
    doc.updatedAt = now;
    if (!isSaved(doc)) { S.invoices.push(doc); rememberOpen(doc.id); }
    S.dirty = false;
    setSaveState('saving');
    return Store.putInvoice(doc).then(function () {
      saveFailures = 0;
      if (!S.dirty) setSaveState('saved');
    }, function (e) {
      // nothing reached storage. The document is remembered as unsaved, so leaving the editor, hiding the page
      // or the next change tries again, and a passing hiccup gets a few tries of its own.
      if (failedDocs.indexOf(doc) === -1) failedDocs.push(doc);
      setSaveState('error');
      var passing = !e || ['quota_exceeded', 'invalid_argument', 'revoked', 'not_granted'].indexOf(e.code) === -1;
      if (passing && saveFailures++ < 3) setTimeout(saveNow, 8000);
    });
  }

  var failedDocs = [];
  var saveFailures = 0;

  function retryFailed() {
    var list = failedDocs;
    failedDocs = [];
    list.forEach(function (d) {
      if (!isSaved(d)) return;
      Store.putInvoice(d).then(function () {
        if (d === S.doc && !S.dirty) setSaveState('saved');
      }, function () {
        if (failedDocs.indexOf(d) === -1) failedDocs.push(d);
      });
    });
  }

  function saveCompany(company) {
    var now = new Date().toISOString();
    if (!company.createdAt) company.createdAt = now;
    company.updatedAt = now;
    if (S.companies.indexOf(company) === -1) {
      var at = -1;
      S.companies.forEach(function (c, i) { if (c.id === company.id) at = i; });
      if (at === -1) S.companies.push(company); else S.companies[at] = company;
    }
    return Store.putCompany(company).catch(function (e) { toast('The company was not saved. ' + errorText(e), 'bad'); });
  }

  // ---------------------------------------------------------- view model

  function buildVm(doc) {
    var sup = companyById(doc.supplierId);
    return C.buildViewModel(doc, {
      labels: I18N.get(doc.language),
      countryName: function (code) { return countryName(code, doc.language); },
      images: { logo: (sup && sup.logo) || null, stamp: (sup && sup.stamp) || null }
    });
  }

  async function saveFile(blob, fileName) {
    var claude = window.claude;
    if (claude && typeof claude.use === 'function') {
      var downloads = await claude.use('downloads');
      if (!downloads) throw { code: 'unavailable', message: 'This view cannot save files. Open the page in claude.ai or the Claude app.' };
      await downloads.save({ filename: fileName, data: blob });
      return;
    }
    var url = URL.createObjectURL(blob);
    var a = h('a', { href: url, download: fileName });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 15000);
  }

  async function downloadPdf(doc) {
    var r = renderer();
    if (!r) { toast('The page did not load completely, so the PDF cannot be built. Reload it.', 'bad'); return false; }
    var vm, blob;
    try {
      vm = buildVm(doc);
      blob = await Promise.resolve(r.pdf(r.layout(vm), vm.meta));
    } catch (e) {
      toast(e && e.message === 'pdf-unavailable'
        ? 'The PDF library did not load. Check the connection and reload the page.'
        : 'The PDF could not be built. ' + ((e && e.message) || ''), 'bad');
      return false;
    }
    try {
      await saveFile(blob, vm.meta.fileName);
    } catch (e) {
      if (e && e.code === 'declined') return false;
      toast(e && e.code === 'rate_limited' ? 'Another save is still open. Answer it first.' : 'The PDF was not saved. ' + errorText(e), 'bad');
      return false;
    }
    // with a folder connected, the PDF is also kept beside the data it was made from
    if (S.mode === 'folder' && !S.example) {
      Store.savePdfCopy(vm.meta.fileName, blob).catch(function (e) {
        toast('The PDF was downloaded, but its copy in the folder could not be written. ' + errorText(e), 'bad');
      });
    }
    return true;
  }

  // ------------------------------------------------------------ documents

  function renderDocuments() {
    var view = $('#view');
    view.textContent = '';
    var page = h('div', { class: 'wrap page' });
    view.appendChild(page);
    var sups = suppliers();

    var head = h('div', { class: 'page-head' }, h('h1', { text: 'Documents' }), h('span', { class: 'spacer' }));
    if (sups.length > 1) {
      var pick = h('select', { id: 'new-for', 'aria-label': 'Company the new document is issued by', style: 'width:auto;max-width:220px' },
        sups.map(function (c) { return h('option', { value: c.id, text: c.name || 'Unnamed company' }); }));
      pick.value = (companyById(S.newFor) || companyById(S.settings.lastSupplierId) || sups[0]).id;
      S.newFor = pick.value;
      pick.addEventListener('change', function () { S.newFor = pick.value; });
      head.appendChild(pick);
    }
    head.appendChild(button('New document', function () { startNewDocument(); }, 'primary'));
    page.appendChild(head);

    if (S.truncated) page.appendChild(truncatedNotice());

    if (!sups.length) {
      page.appendChild(h('div', { class: 'panel empty' },
        h('strong', { text: 'Start with your own company' }),
        h('span', { text: 'Its name, IČO, address and bank account are saved once and go on every document you issue. Customers are saved the same way, so the next invoice for the same company takes a few seconds.' + (S.mode === 'cloud' ? '' : ' Everything stays on this device; nothing is uploaded.') }),
        h('div', { class: 'row' },
          button('Add my company', function () { openCompanyDialog(C.newCompany('supplier'), { isNew: true, then: function (c) { newDocument(c); } }); }, 'primary'),
          button('See an example document', function () { leaveExample(); makeExample(); go('editor'); }))));
      return;
    }

    var filters = h('div', { class: 'filters' });
    var search = h('input', { id: 'filter-q', type: 'search', placeholder: 'Search by number or customer', 'aria-label': 'Search documents' });
    search.value = S.filters.q;
    search.addEventListener('input', function () { S.filters.q = search.value; drawRows(); });
    filters.appendChild(search);
    if (sups.length > 1) {
      var fs = h('select', { id: 'filter-supplier', 'aria-label': 'Filter by company' },
        [h('option', { value: '', text: 'All my companies' })].concat(sups.map(function (c) { return h('option', { value: c.id, text: c.name || 'Unnamed company' }); })));
      fs.value = S.filters.supplier;
      fs.addEventListener('change', function () { S.filters.supplier = fs.value; drawRows(); });
      filters.appendChild(fs);
    }
    var fst = h('select', { id: 'filter-status', 'aria-label': 'Filter by status' },
      [h('option', { value: '', text: 'Any status' })].concat(['draft', 'issued', 'overdue', 'paid'].map(function (s) { return h('option', { value: s, text: STATUS_LABEL[s] }); })));
    fst.value = S.filters.status;
    fst.addEventListener('change', function () { S.filters.status = fst.value; drawRows(); });
    filters.appendChild(fst);
    filters.appendChild(h('span', { class: 'spacer' }));
    filters.appendChild(button('Export this list (CSV)', function () { exportCsv(shown); }, 'small quiet', { id: 'export-csv' }));
    page.appendChild(filters);
    var shown = [];

    var tally = h('div', { class: 'tally', id: 'tally' });
    page.appendChild(tally);
    var panel = h('div', { class: 'panel' });
    page.appendChild(panel);

    function drawRows() {
      var t = today();
      var q = S.filters.q.trim().toLowerCase();
      var rows = S.invoices.filter(function (d) {
        if (S.filters.supplier && d.supplierId !== S.filters.supplier) return false;
        if (S.filters.status && C.statusOf(d, t) !== S.filters.status) return false;
        if (q && (String(d.number) + ' ' + String(d.customer.name) + ' ' + String(d.orderNumber)).toLowerCase().indexOf(q) === -1) return false;
        return true;
      }).sort(function (a, b) {
        return String(b.issueDate).localeCompare(String(a.issueDate)) || String(b.createdAt).localeCompare(String(a.createdAt));
      });

      shown = rows;
      var unpaid = {}, overdue = 0;
      rows.forEach(function (d) {
        var st = C.statusOf(d, t);
        if ((st === 'issued' || st === 'overdue') && C.kindOf(d).payable) {
          unpaid[d.currency] = (unpaid[d.currency] || 0) + C.computeTotals(d).payable;
          if (st === 'overdue') overdue++;
        }
      });
      tally.textContent = '';
      tally.appendChild(h('span', null, h('b', { text: String(rows.length) }), rows.length === 1 ? ' document' : ' documents'));
      Object.keys(unpaid).forEach(function (cur) { tally.appendChild(h('span', null, 'Waiting to be paid ', h('b', { text: money(unpaid[cur], cur) }))); });
      if (overdue) tally.appendChild(h('span', null, h('b', { text: String(overdue) }), ' overdue'));

      panel.textContent = '';
      if (!rows.length) {
        panel.appendChild(h('div', { class: 'empty' },
          h('strong', { text: S.invoices.length ? 'No document matches' : 'No documents yet' }),
          h('span', { text: S.invoices.length ? 'Clear the search or the filters to see them all.' : 'Issue the first one with New document. It is saved as you type and listed here.' })));
        return;
      }
      var multi = sups.length > 1;
      var tbody = h('tbody');
      rows.forEach(function (d) {
        var st = C.statusOf(d, t);
        var totals = C.computeTotals(d);
        var sup = companyById(d.supplierId);
        var tr = h('tr', { class: 'open', tabindex: '0' },
          h('td', { class: 'wide' }, h('div', { class: 'title num', text: d.number || 'No number' }), h('div', { class: 'sub', text: KIND_SHORT[d.kind] || '' })),
          h('td', { class: 'wide' }, h('div', { text: d.customer.name || 'No customer yet' }),
            multi ? h('div', { class: 'sub', text: 'from ' + ((sup && sup.name) || d.supplier.name || 'a deleted company') }) : null),
          h('td', { 'data-label': 'Issued', text: C.formatDate(d.issueDate, UI) }),
          h('td', { 'data-label': C.kindOf(d).payable ? 'Due' : 'Valid until', text: C.formatDate(d.dueDate, UI) }),
          h('td', { class: 'r num', text: money(totals.payable, d.currency) }),
          h('td', null, h('span', { class: 'chip ' + st, text: STATUS_LABEL[st] })));
        var actions = h('td', { class: 'actions' });
        actions.appendChild(button('PDF', async function (e) {
          e.stopPropagation();
          if (await downloadPdf(d)) markIssuedAfterDownload(d, drawRows);
        }, 'small quiet'));
        actions.appendChild(button('Copy', function (e) { e.stopPropagation(); duplicateDocument(d); }, 'small quiet'));
        if (C.kindOf(d).payable && d.status !== 'draft') {
          actions.appendChild(button(d.status === 'paid' ? 'Unpaid' : 'Paid', function (e) {
            e.stopPropagation();
            setStatus(d, d.status === 'paid' ? 'issued' : 'paid');
            drawRows();
          }, 'small quiet'));
        }
        actions.appendChild(confirmButton('Delete', 'Delete ' + (d.number || 'this document') + '?', function () { deleteDocument(d); drawRows(); }));
        tr.appendChild(actions);
        tr.addEventListener('click', function () { openDocument(d); });
        tr.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target === tr) openDocument(d); });
        tbody.appendChild(tr);
      });
      panel.appendChild(h('div', { class: 'table-scroll' }, h('table', { class: 'ledger' },
        h('thead', null, h('tr', null,
          h('th', { text: 'Number' }), h('th', { text: 'Customer' }), h('th', { text: 'Issued' }), h('th', { text: 'Due' }),
          h('th', { class: 'r', text: 'Total' }), h('th', { text: 'Status' }), h('th', { class: 'r', text: '' }))),
        tbody)));
    }
    drawRows();
  }

  /** The list as a spreadsheet for the accountant: semicolons and decimal commas, as Czech spreadsheets expect. */
  async function exportCsv(rows) {
    if (!rows.length) { toast('There is nothing in the list to export.', 'bad'); return; }
    var plain = { decimal: ',', group: '' };
    var text = function (v) {
      v = String(v == null ? '' : v);
      if (/^0\d+$/.test(v)) v = '="' + v + '"';       // digits with leading zeros (an IČO, a number): keep the zeros
      else if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;  // never let a spreadsheet read typed text as a formula
      return /[";\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    var num = function (cents) { return C.formatAmount(cents, plain); };
    var t = today();
    var lines = [['Number', 'Type', 'Status', 'Issued by', 'Customer', 'Customer ICO', 'Customer DIC', 'Issue date', 'Taxable supply',
      'Due date', 'Paid on', 'Currency', 'Without VAT', 'VAT', 'Total', 'To pay'].join(';')];
    rows.forEach(function (d) {
      var totals = C.computeTotals(d);
      lines.push([
        text(d.number), text(KIND_SHORT[d.kind]), text(STATUS_LABEL[C.statusOf(d, t)]), text(d.supplier.name), text(d.customer.name),
        text(d.customer.companyNumber), text(d.customer.taxNumber), text(d.issueDate), text(C.kindOf(d).taxDocument ? d.taxDate : ''),
        text(d.dueDate), text(d.paidDate), text(d.currency), num(totals.net), num(totals.vat), num(totals.gross), num(totals.payable)
      ].join(';'));
    });
    try {
      await saveFile(new Blob(['\ufeff' + lines.join('\r\n') + '\r\n'], { type: 'text/csv' }), 'documents-' + t + '.csv');
      toast('List exported.');
    } catch (e) {
      if (!(e && e.code === 'declined')) toast('The list was not exported. ' + errorText(e), 'bad');
    }
  }

  function setStatus(doc, status) {
    doc.status = status;
    doc.paidDate = status === 'paid' ? today() : '';
    persistDocument(doc);
  }

  function persistDocument(doc) {
    doc.updatedAt = new Date().toISOString();
    if (!doc.createdAt) doc.createdAt = doc.updatedAt;
    if (!isSaved(doc)) S.invoices.push(doc);
    Store.putInvoice(doc).catch(function (e) { toast('The change was not saved. ' + errorText(e), 'bad'); });
  }

  function deleteDocument(doc) {
    var i = S.invoices.indexOf(doc);
    if (i !== -1) S.invoices.splice(i, 1);
    if (S.doc === doc) { S.doc = null; S.dirty = false; rememberOpen(null); }
    Store.removeInvoice(doc.id).catch(function (e) { toast('The document was not deleted. ' + errorText(e), 'bad'); });
  }

  function markIssuedAfterDownload(doc, redraw) {
    if (S.example) return;
    var changed = false;
    if (doc.status === 'draft') { doc.status = 'issued'; changed = true; }
    if (rememberCustomer(doc)) changed = true;
    if (changed) {
      if (S.doc === doc) { S.dirty = true; saveNow(); }
      else persistDocument(doc);
      toast('PDF saved. The document is now marked as issued.');
    }
    if (redraw) redraw();
  }

  /** A customer typed straight into a document joins the address book when the document goes out. */
  function rememberCustomer(doc) {
    var name = String(doc.customer.name || '').trim();
    var linked = companyById(doc.customerId);
    if ((linked && linked.kind === 'customer') || !name) return false;
    // the same company typed on another document is the same customer, not a second entry
    var ico = String(doc.customer.companyNumber || '').replace(/\s/g, '');
    var matches = customers().filter(function (x) {
      return ico ? String(x.companyNumber || '').replace(/\s/g, '') === ico : String(x.name || '').trim().toLowerCase() === name.toLowerCase();
    });
    // the same IČO is the same company; the same name alone counts only when exactly one customer has it
    if (matches.length && (ico || matches.length === 1)) { doc.customerId = matches[0].id; return 'linked'; }
    var c = C.newCompany('customer');
    Object.assign(c, C.partySnapshot(doc.customer));
    doc.customerId = c.id;
    saveCompany(c);
    return 'created';
  }

  // --------------------------------------------------------------- editor

  function renderEditor() {
    var view = $('#view');
    view.textContent = '';
    var doc = S.doc;
    if (!doc) {
      view.appendChild(h('div', { class: 'wrap page' }, h('div', { class: 'panel empty' },
        h('strong', { text: 'No document is open' }),
        h('span', { text: 'Open one from Documents, or start a new one.' }),
        h('div', { class: 'row' }, button('New document', function () { startNewDocument(); }, 'primary'), h('a', { class: 'btn', href: '#documents', text: 'Documents' })))));
      return;
    }

    var bar = h('div', { class: 'editor-bar' }, h('div', { class: 'wrap' },
      h('a', { class: 'btn quiet', href: '#documents', text: '← Documents' }),
      h('h1', { id: 'doc-title', text: '' }),
      S.example ? h('span', { class: 'chip draft', text: 'Example' }) : statusSelect(doc),
      h('span', { class: 'save-state', id: 'save-state' }),
      h('span', { class: 'spacer' }),
      paneSwitch(),
      h('div', { class: 'editor-actions' },
      S.example ? null : button('Copy', function () { duplicateDocument(doc); }, 'quiet'),
      button('Download PDF', async function () {
        await saveNow();
        if (await downloadPdf(doc)) {
          if (S.example) toast('PDF saved.');
          else { markIssuedAfterDownload(doc); var sel = $('#f-status'); if (sel) sel.value = doc.status; rebuildForm(); }
        }
      }, 'primary'))));
    view.appendChild(bar);

    var body = h('div', { class: 'wrap' });
    view.appendChild(body);
    if (S.example) {
      body.appendChild(h('div', { class: 'notice', style: 'margin-top:16px' },
        h('p', null, h('strong', { text: 'This is an example for a made-up company. ' }), S.mode === 'cloud'
          ? 'Change anything to see the document follow. Nothing here is saved.'
          : 'Change anything to see the document follow; nothing in it is saved. Once you add your own company, everything you enter stays on this device. Nothing is uploaded.'),
        button('Add my company', function () {
          openCompanyDialog(C.newCompany('supplier'), { isNew: true, then: function (c) { newDocument(c); } });
        }, 'primary')));
    }
    var form = h('div', { class: 'form', id: 'form' });
    var grid = h('div', { class: 'editor', id: 'editor', dataset: { pane: S.pane } }, form, previewPane());
    body.appendChild(grid);
    buildForm(form, doc);
    autosizeAll(form);
    refreshComputed(true);
    renderSaveState();
  }

  function statusSelect(doc) {
    var options = C.kindOf(doc).payable ? ['draft', 'issued', 'paid'] : ['draft', 'issued'];
    var sel = h('select', { id: 'f-status', 'aria-label': 'Status', style: 'width:auto' },
      options.map(function (s) { return h('option', { value: s, text: STATUS_LABEL[s] }); }));
    sel.value = options.indexOf(doc.status) === -1 ? 'issued' : doc.status;
    sel.addEventListener('change', function () {
      doc.status = sel.value;
      doc.paidDate = sel.value === 'paid' ? today() : '';
      if (sel.value !== 'draft') rememberCustomer(doc);
      touch();
      rebuildForm();
    });
    return sel;
  }

  function paneSwitch() {
    var seg = h('div', { class: 'seg mobile-switch', role: 'group', 'aria-label': 'Show' });
    ['edit', 'preview'].forEach(function (p) {
      seg.appendChild(h('button', {
        type: 'button', 'aria-pressed': String(S.pane === p), text: p === 'edit' ? 'Edit' : 'Preview',
        onclick: function () {
          S.pane = p;
          var ed = $('#editor');
          if (ed) ed.dataset.pane = p;
          Array.prototype.forEach.call(seg.children, function (b, i) { b.setAttribute('aria-pressed', String((i === 0) === (p === 'edit'))); });
          if (p === 'preview') refreshPreview();
        }
      }));
    });
    return seg;
  }

  function previewPane() {
    return h('aside', { class: 'preview', 'aria-label': 'Preview of the document' },
      h('div', { class: 'preview-head' }, h('h3', { text: 'Preview' }), h('span', { class: 'hint', id: 'preview-pages' })),
      h('div', { class: 'preview-scroll', id: 'preview-host' }));
  }

  function rebuildForm() {
    var form = $('#form');
    if (!form || !S.doc) return;
    var active = document.activeElement && document.activeElement.id;
    var y = window.scrollY;
    form.textContent = '';
    buildForm(form, S.doc);
    autosizeAll(form);
    refreshComputed(true);
    if (active) { var el = document.getElementById(active); if (el && el.focus) { try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); } } }
    window.scrollTo(0, y);
  }

  function buildForm(form, doc) {
    var kind = C.kindOf(doc);
    fillUnits();
    form.appendChild(sectionFrom(doc));
    form.appendChild(sectionTo(doc));
    form.appendChild(sectionDocument(doc, kind));
    if (kind.payable) form.appendChild(sectionPayment(doc));
    form.appendChild(sectionItems(doc));
    form.appendChild(sectionLook(doc));
    form.appendChild(h('section', { class: 'section', id: 'checks-section', hidden: true },
      h('header', null, h('h2', { text: 'Before you send it' })), h('ul', { class: 'checks', id: 'checks' })));
  }

  // --- From

  function supplierDiffers(doc, company) {
    if (!company) return false;
    var snap = C.partySnapshot(company);
    for (var k in snap) if (String(snap[k] || '') !== String(doc.supplier[k] || '')) return true;
    var bank = Object.assign(C.emptyBank(), company.bank || {});
    for (var b in bank) if (b !== 'hidden' && String(bank[b] || '') !== String((doc.bank || {})[b] || '')) return true;
    return String(company.registerNote || '') !== String(doc.registerNote || '');
  }

  function useCompanyDetails(doc, company) {
    doc.supplier = C.partySnapshot(company);
    var hidden = !!(doc.bank && doc.bank.hidden);
    doc.bank = Object.assign(C.emptyBank(), company.bank || {});
    doc.bank.hidden = hidden;
    doc.registerNote = company.registerNote || '';
  }

  function switchSupplier(doc, company) {
    var series = C.kindOf(doc).series;
    var kind = doc.kind;
    if (series === 'invoice' && doc.kind !== 'reverse_charge') kind = company.vatPayer ? 'invoice_vat' : 'invoice_novat';
    else if (series === 'quote') kind = company.vatPayer ? 'quote_vat' : 'quote_novat';
    else if (doc.kind === 'reverse_charge' && !company.vatPayer) kind = 'invoice_novat';
    var fresh = C.newInvoice(company, {
      today: C.isIsoDate(doc.issueDate) ? doc.issueDate : today(), kind: kind,
      existing: S.invoices.filter(function (x) { return x !== doc; })
    });
    ['id', 'createdAt', 'status', 'paidDate', 'customer', 'customerId', 'items', 'documentDiscount', 'orderNumber',
      'taxDate', 'correctedNumber', 'correctionReason'].forEach(function (k) { fresh[k] = doc[k]; });
    if (String(doc.note || '').trim()) fresh.note = doc.note;
    Object.keys(fresh).forEach(function (k) { doc[k] = fresh[k]; });
  }

  function sectionFrom(doc) {
    var company = companyById(doc.supplierId);
    var sec = h('section', { class: 'section' });
    var head = h('header', null, h('h2', { text: 'From' }));
    if (!S.example && company) {
      head.appendChild(button('Edit company', function () {
        openCompanyDialog(company, { then: function (c) { useCompanyDetails(doc, c); touch(); rebuildForm(); } });
      }, 'small quiet', { id: 'f-edit-company' }));
    }
    sec.appendChild(head);
    var sups = suppliers();
    if (!S.example && (sups.length > 1 || !company)) {
      var options = sups.map(function (c) { return { value: c.id, label: c.name || 'Unnamed company' }; });
      if (!company) options.unshift({ value: '', label: 'Choose one of your companies' });
      var sel = h('select', { id: 'f-supplier' }, options.map(function (o) { return h('option', { value: o.value, text: o.label }); }));
      sel.value = company ? company.id : '';
      sel.addEventListener('change', function () {
        var chosen = companyById(sel.value);
        if (!chosen) return;
        switchSupplier(doc, chosen);
        rememberSupplier(chosen.id);
        touch();
        rebuildForm();
      });
      var settled = isSaved(doc) && doc.status !== 'draft';
      sel.disabled = settled;
      sec.appendChild(field('Company', sel, settled ? { hint: 'An issued document stays with its company. Set it back to Draft to move it.' } : null));
    }
    var p = doc.supplier;
    sec.appendChild(h('div', { class: 'party-card' },
      h('span', { class: 'name', text: p.name || 'No company chosen' }),
      h('span', { class: 'muted', text: addressLine(p) }),
      h('span', { class: 'muted num', text: [p.companyNumber ? 'IČO ' + p.companyNumber : '', p.taxNumber ? 'DIČ ' + p.taxNumber : ''].filter(Boolean).join('  ·  ') })));
    if (!S.example && company && supplierDiffers(doc, company)) {
      sec.appendChild(h('div', { class: 'row' },
        h('span', { class: 'hint warn', text: 'The company profile has changed since this document was written.' }),
        button('Use the current details', function () { useCompanyDetails(doc, company); touch(); rebuildForm(); }, 'small')));
    }
    return sec;
  }

  // --- To

  var canLookup = !window.claude && typeof fetch === 'function';

  async function aresLookup(ico) {
    var res = await fetch('https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/' + encodeURIComponent(ico),
      { headers: { accept: 'application/json' } });
    if (res.status === 404) throw { code: 'not_found' };
    if (!res.ok) throw { code: 'http' };
    var j = await res.json();
    var s = j.sidlo || {};
    var house = [s.cisloDomovni, s.cisloOrientacni != null ? String(s.cisloOrientacni) + (s.cisloOrientacniPismeno || '') : null]
      .filter(function (v) { return v != null && v !== ''; }).join('/');
    var street = ((s.nazevUlice || s.nazevCastiObce || s.nazevObce || '') + ' ' + house).trim();
    if (s.nazevUlice && s.nazevCastiObce && s.nazevCastiObce !== s.nazevObce) street += ', ' + s.nazevCastiObce;
    var psc = s.psc != null ? ('00000' + String(s.psc)).slice(-5) : '';
    return {
      name: j.obchodniJmeno || '', taxNumber: j.dic || '', street: street, city: s.nazevObce || '',
      postcode: psc ? psc.slice(0, 3) + ' ' + psc.slice(3) : '', country: s.kodStatu || 'CZ'
    };
  }

  function icoHint(party) {
    var el = h('span', { class: 'hint' });
    function update() {
      var v = String(party.companyNumber || '').trim();
      el.className = 'hint';
      if (!v || (party.country && party.country !== 'CZ')) { el.textContent = ''; return; }
      if (C.validateIco(v)) { el.textContent = 'Valid IČO'; el.className = 'hint ok'; }
      else { el.textContent = 'Not a valid IČO (check the digits)'; el.className = 'hint warn'; }
    }
    update();
    el.update = update;
    return el;
  }

  /** The fields of a company, bound to `party`. `prefix` keeps the ids apart; `changed` runs after every edit. */
  function partyFields(party, prefix, changed, refill) {
    var hint = icoHint(party);
    var ico = bindText(party, 'companyNumber', prefix + '-ico', { inputmode: 'numeric', cls: 'mono', changed: function () { hint.update(); changed(); } });
    var icoField = field('IČO (company number)', ico, { cls: 'c4 half-sm', hint: hint });
    var grid = h('div', { class: 'grid' }, icoField,
      field('DIČ (VAT number)', bindText(party, 'taxNumber', prefix + '-dic', { changed: changed, cls: 'mono' }), { cls: 'c4 half-sm' }));
    if (canLookup) {
      var look = button('Look up in ARES', async function () {
        var v = String(party.companyNumber || '').replace(/\s/g, '');
        if (!C.validateIco(v)) { toast('Type a valid 8-digit IČO first.', 'bad'); return; }
        look.disabled = true;
        try {
          var found = await aresLookup(v);
          Object.keys(found).forEach(function (k) { if (found[k]) party[k] = found[k]; });
          changed();
          refill();
          toast('Filled in from the ARES register.');
        } catch (e) {
          toast(e && e.code === 'not_found' ? 'ARES has no company with this IČO.' : 'ARES did not answer. Fill the details in by hand.', 'bad');
        }
        look.disabled = false;
      }, 'small');
      grid.appendChild(h('div', { class: 'field c4', style: 'justify-content:flex-end' }, look));
    }
    append(grid, [
      field('Name', bindText(party, 'name', prefix + '-name', { changed: changed }), { cls: 'c12' }),
      field('Street and number', bindText(party, 'street', prefix + '-street', { changed: changed }), { cls: 'c12' }),
      field('Postcode', bindText(party, 'postcode', prefix + '-zip', { changed: changed }), { cls: 'c3 half-sm' }),
      field('City', bindText(party, 'city', prefix + '-city', { changed: changed }), { cls: 'c4 half-sm' }),
      field('Country', bindSelect(party, 'country', prefix + '-country', countryOptions(), { changed: function () { hint.update(); changed(); } }), { cls: 'c4' })
    ]);
    var contact = h('details', { class: 'more', open: !!(party.email || party.phone || party.web) },
      h('summary', { text: 'E-mail, phone and web' }),
      h('div', { class: 'grid' },
        field('E-mail', bindText(party, 'email', prefix + '-email', { changed: changed, type: 'email' }), { cls: 'c6' }),
        field('Phone', bindText(party, 'phone', prefix + '-phone', { changed: changed }), { cls: 'c6' }),
        field('Web', bindText(party, 'web', prefix + '-web', { changed: changed }), { cls: 'c12' })));
    return [grid, contact];
  }

  function customerDiffers(doc, saved) {
    var snap = C.partySnapshot(saved);
    for (var k in snap) if (String(snap[k] || '') !== String(doc.customer[k] || '')) return true;
    return false;
  }

  function sectionTo(doc) {
    var sec = h('section', { class: 'section' });
    sec.appendChild(h('header', null, h('h2', { text: 'To' })));
    var saved = customers();
    var linked = companyById(doc.customerId);
    if (linked && linked.kind !== 'customer') linked = null;
    if (saved.length) {
      var sel = h('select', { id: 'f-customer' },
        [h('option', { value: '', text: 'A new customer (fill in below)' })].concat(saved.map(function (c) {
          return h('option', { value: c.id, text: (c.name || 'Unnamed customer') + (c.companyNumber ? '  ·  ' + c.companyNumber : '') });
        })));
      sel.value = linked ? linked.id : '';
      sel.addEventListener('change', function () {
        var chosen = companyById(sel.value);
        if (chosen) { doc.customerId = chosen.id; doc.customer = C.partySnapshot(chosen); }
        else { doc.customerId = null; doc.customer = C.emptyParty(); }
        touch();
        rebuildForm();
      });
      sec.appendChild(field('Customer', sel));
    }
    var actions = h('div', { class: 'row', id: 'customer-actions' });
    function drawActions() {
      actions.textContent = '';
      if (S.example) return;
      var link = companyById(doc.customerId);
      if (!link && String(doc.customer.name || '').trim()) {
        actions.appendChild(button('Save to my customers', function () {
          var how = rememberCustomer(doc);
          if (!how) return;
          touch();
          rebuildForm();
          toast(how === 'linked' ? 'Linked to the customer you already saved.' : 'Customer saved.');
        }, 'small', { id: 'f-save-customer' }));
        actions.appendChild(h('span', { class: 'hint', text: 'Saved customers can be picked next time.' }));
      } else if (link && customerDiffers(doc, link)) {
        actions.appendChild(button('Update the saved customer', function () {
          Object.assign(link, C.partySnapshot(doc.customer));
          saveCompany(link);
          drawActions();
          toast('Customer updated.');
        }, 'small'));
        actions.appendChild(h('span', { class: 'hint', text: 'So far the change is on this document only.' }));
      }
    }
    append(sec, partyFields(doc.customer, 'to', function () { drawActions(); touch(); }, rebuildForm));
    sec.appendChild(actions);
    drawActions();
    return sec;
  }

  // --- Document

  function sectionDocument(doc, kind) {
    var sec = h('section', { class: 'section' });
    sec.appendChild(h('header', null, h('h2', { text: 'Document' })));
    var grid = h('div', { class: 'grid' });
    sec.appendChild(grid);

    grid.appendChild(field('Type', bindSelect(doc, 'kind', 'f-kind', C.KIND_ORDER.map(function (k) { return { value: k, label: KIND_LABEL[k] }; }), {
      rebuild: true,
      after: function () {
        var k = C.kindOf(doc);
        if (!k.payable && doc.status === 'paid') doc.status = 'issued';
        if (k.series !== kind.series && (!isSaved(doc) || doc.status === 'draft')) renumber(doc);
        var sel = $('#f-status');
        if (sel && sel.parentNode) sel.parentNode.replaceChild(statusSelect(doc), sel);
      }
    }), { cls: 'c12' }));

    if (kind.vat === 'supplier') {
      grid.appendChild(h('div', { class: 'c12' }, bindCheck(doc, 'vatApplies', 'f-vat-applies', 'Show VAT on this document', { rebuild: true, hint: '(for a VAT payer)' })));
    }

    var number = bindText(doc, 'number', 'f-number', {
      cls: 'mono',
      after: function (value, before) {
        if (doc.variableSymbol === C.defaultVariableSymbol(before)) {
          doc.variableSymbol = C.defaultVariableSymbol(value);
          var vs = $('#f-vs');
          if (vs) vs.value = doc.variableSymbol;
        }
      }
    });
    grid.appendChild(field('Number', number, { cls: 'c6' }));
    grid.appendChild(field('Issued by', bindText(doc, 'issuedBy', 'f-issued-by', { placeholder: 'Name on the document' }), { cls: 'c6' }));

    var more = h('details', { class: 'more c12', open: !!(doc.recordNumber || doc.constantSymbol || doc.specificSymbol || doc.orderNumber) },
      h('summary', { text: 'Variable symbol, other symbols and order number' }),
      h('div', { class: 'grid' },
        kind.payable ? field('Variable symbol', bindText(doc, 'variableSymbol', 'f-vs', { cls: 'mono', inputmode: 'numeric', filter: digits10 }), { cls: 'c4 half-sm', hint: 'Follows the number' }) : null,
        kind.payable ? field('Constant symbol', bindText(doc, 'constantSymbol', 'f-ks', { cls: 'mono', inputmode: 'numeric', filter: digits10 }), { cls: 'c4 half-sm' }) : null,
        kind.payable ? field('Specific symbol', bindText(doc, 'specificSymbol', 'f-ss', { cls: 'mono', inputmode: 'numeric', filter: digits10 }), { cls: 'c4 half-sm' }) : null,
        field('Record number', bindText(doc, 'recordNumber', 'f-record', { cls: 'mono' }), { cls: 'c6', hint: 'Only when it differs from the number' }),
        field('Order number', bindText(doc, 'orderNumber', 'f-order', { cls: 'mono' }), { cls: 'c6' })));
    grid.appendChild(more);

    if (doc.kind === 'corrective') {
      grid.appendChild(field('Corrects document no.', bindText(doc, 'correctedNumber', 'f-corrected', { cls: 'mono' }), { cls: 'c4' }));
      grid.appendChild(field('Reason for the correction', bindText(doc, 'correctionReason', 'f-reason'), { cls: 'c8' }));
    }

    var lastRealIssue = C.isIsoDate(doc.issueDate) ? doc.issueDate : '';
    var issue = bindText(doc, 'issueDate', 'f-issue', {
      type: 'date',
      after: function (value, before) {
        if (doc.taxDate === before) { doc.taxDate = value; var t = $('#f-tax'); if (t) t.value = value; }
        if (doc.dueIn !== 'custom') doc.dueDate = C.addDays(value, Number(doc.dueIn));
        // a draft whose number still follows the company's numbering moves with its date into the new year or month
        var previous = lastRealIssue;
        if (C.isIsoDate(value)) lastRealIssue = value;
        if ((!isSaved(doc) || doc.status === 'draft') && C.isIsoDate(value) && previous) {
          var owner = companyById(doc.supplierId);
          var pattern = owner && owner.defaults ? owner.defaults.numberPattern : 'YYYYNNNN';
          var moved = value.slice(0, 4) !== previous.slice(0, 4) || (/MM/.test(String(pattern)) && value.slice(0, 7) !== previous.slice(0, 7));
          if (moved && C.matchPattern(pattern, doc.number)) {
            renumber(doc);
            var numberInput = $('#f-number');
            if (numberInput) numberInput.value = doc.number;
            var vsInput = $('#f-vs');
            if (vsInput) vsInput.value = doc.variableSymbol;
          }
        }
      }
    });
    grid.appendChild(field('Issue date', issue, { cls: kind.taxDocument ? 'c6' : 'c12' }));
    if (kind.taxDocument) grid.appendChild(field('Date of taxable supply', bindText(doc, 'taxDate', 'f-tax', { type: 'date' }), { cls: 'c6' }));

    var dueOptions = C.DUE_OPTIONS.slice();
    if (doc.dueIn !== 'custom' && dueOptions.indexOf(Number(doc.dueIn)) === -1) dueOptions.push(Number(doc.dueIn));
    dueOptions.sort(function (a, b) { return a - b; });
    var dueSelect = bindSelect(doc, 'dueIn', 'f-due-in',
      dueOptions.map(function (n) { return { value: n, label: n === 0 ? (kind.payable ? 'Immediately' : 'Today only') : n === 1 ? '1 day' : n + ' days' }; })
        .concat([{ value: 'custom', label: 'A date I choose' }]),
      {
        rebuild: true,
        cast: function (raw) { return raw === 'custom' ? 'custom' : Number(raw); },
        after: function (v) { if (v !== 'custom') doc.dueDate = C.addDays(doc.issueDate, v); }
      });
    grid.appendChild(field(kind.payable ? 'Due in' : 'Valid for', dueSelect, { cls: 'c6' }));
    if (doc.dueIn === 'custom') {
      grid.appendChild(field(kind.payable ? 'Due date' : 'Valid until', bindText(doc, 'dueDate', 'f-due', { type: 'date' }), { cls: 'c6' }));
    } else {
      grid.appendChild(h('div', { class: 'field c6' }, h('span', { class: 'label', text: kind.payable ? 'Due date' : 'Valid until' }),
        h('span', { class: 'num', id: 'due-text', style: 'min-height:2.25rem;display:flex;align-items:center' })));
    }
    return sec;
  }

  function renumber(doc) {
    var sup = companyById(doc.supplierId);
    var series = C.kindOf(doc).series;
    var existing = S.invoices.filter(function (x) { return x !== doc && x.supplierId === doc.supplierId && C.kindOf(x).series === series; });
    var before = doc.number;
    doc.number = C.suggestNumber(sup && sup.defaults ? sup.defaults.numberPattern : 'YYYYNNNN', existing, doc.issueDate);
    if (doc.variableSymbol === C.defaultVariableSymbol(before)) doc.variableSymbol = C.defaultVariableSymbol(doc.number);
  }

  // --- Payment

  function sectionPayment(doc) {
    var sec = h('section', { class: 'section' });
    sec.appendChild(h('header', null, h('h2', { text: 'Payment' })));
    var grid = h('div', { class: 'grid' });
    sec.appendChild(grid);
    grid.appendChild(field('Paid by', bindSelect(doc, 'paymentMethod', 'f-method',
      C.PAYMENT_METHODS.map(function (m) { return { value: m, label: PAYMENT_LABEL[m] }; }), { rebuild: true }), { cls: 'c6' }));
    if (doc.paymentMethod === 'transfer') {
      var bank = doc.bank;
      grid.appendChild(field('Account number', bindText(bank, 'account', 'f-account', { cls: 'mono', placeholder: '123456789/0100' }),
        { cls: 'c6', hint: h('span', { class: 'hint', id: 'account-hint' }) }));
      grid.appendChild(field('Name of the account', bindText(bank, 'accountName', 'f-account-name', { placeholder: 'Optional' }), { cls: 'c6' }));
      grid.appendChild(h('div', { class: 'c6', style: 'align-self:end' }, bindCheck(bank, 'showIban', 'f-show-iban', 'Print the IBAN and SWIFT too', { rebuild: true })));
      if (bank.showIban) {
        grid.appendChild(field('IBAN', bindText(bank, 'iban', 'f-iban', { cls: 'mono', placeholder: C.formatIban(C.czAccountToIban(bank.account)) || 'CZ..' }),
          { cls: 'c8', hint: h('span', { class: 'hint', id: 'iban-hint' }) }));
        grid.appendChild(field('SWIFT / BIC', bindText(bank, 'swift', 'f-swift', { cls: 'mono' }), { cls: 'c4' }));
      }
      grid.appendChild(h('div', { class: 'c12' }, bindCheck(bank, 'hidden', 'f-bank-hidden', 'Hide the bank account on this document', { hint: '(the customer will not see where to pay)' })));
      grid.appendChild(h('div', { class: 'c12' }, bindCheck(doc, 'showQr', 'f-qr', 'Print a payment QR code'), h('span', { class: 'hint', id: 'qr-hint', style: 'display:block;margin-left:calc(var(--check) + 9px)' })));
    }
    return sec;
  }

  // --- Items

  function sectionItems(doc) {
    var vatMode = C.vatModeOf(doc);
    var sec = h('section', { class: 'section' });
    var head = h('header', null, h('h2', { text: 'Items' }));
    if (vatMode === 'vat') {
      var seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Prices are typed' });
      [['net', 'Prices without VAT'], ['gross', 'Prices with VAT']].forEach(function (pair) {
        seg.appendChild(h('button', {
          type: 'button', 'aria-pressed': String(C.priceModeOf(doc) === pair[0]), text: pair[1],
          onclick: function () { doc.priceMode = pair[0]; touch(); rebuildForm(); }
        }));
      });
      head.appendChild(seg);
    }
    sec.appendChild(head);

    var list = h('div', { class: 'items' });
    sec.appendChild(list);
    doc.items.forEach(function (item, index) { list.appendChild(itemRow(doc, item, index, vatMode)); });
    if (!doc.items.length) list.appendChild(h('p', { class: 'muted', text: 'No items yet. Add what you are charging for.' }));

    var dd = doc.documentDiscount;
    var tools = h('div', { class: 'row' },
      button('Add an item', function () {
        var last = doc.items[doc.items.length - 1];
        var item = C.newItem(vatMode === 'none' ? 0 : (last ? last.vatRate : C.VAT_RATES[0]));
        if (last) item.unit = last.unit;
        doc.items.push(item);
        touch();
        rebuildForm();
        var el = document.getElementById('i-' + item.id + '-desc');
        if (el) el.focus();
      }),
      dd ? null : button('Discount on the whole document', function () { doc.documentDiscount = { type: 'percent', value: 0 }; touch(); rebuildForm(); }, 'quiet'));
    sec.appendChild(tools);

    if (dd) {
      sec.appendChild(h('div', { class: 'grid' },
        field('Discount on the whole document', bindNumber(dd, 'value', 'f-dd-value'), { cls: 'c4 half-sm' }),
        field('As', bindSelect(dd, 'type', 'f-dd-type', [{ value: 'percent', label: 'Percent' }, { value: 'amount', label: 'An amount in ' + doc.currency }]), { cls: 'c4 half-sm' }),
        h('div', { class: 'field c4', style: 'justify-content:flex-end' }, button('Remove the discount', function () { doc.documentDiscount = null; touch(); rebuildForm(); }, 'small quiet'))));
    }

    sec.appendChild(field('Note on the document', bindText(doc, 'note', 'f-note', { multiline: true, rows: 2, placeholder: 'For example a thank-you, or what the invoice is for' })));
    sec.appendChild(h('dl', { class: 'totals', id: 'totals' }));
    return sec;
  }

  function itemRow(doc, item, index, vatMode) {
    var id = 'i-' + item.id;
    var row = h('div', { class: 'item' + (vatMode === 'none' ? ' no-vat' : ''), id: id });
    row.appendChild(field('Description', bindText(item, 'description', id + '-desc', { multiline: true, rows: 1 }), { cls: 'desc' }));
    row.appendChild(field('Quantity', bindNumber(item, 'qty', id + '-qty')));
    row.appendChild(field('Unit', bindText(item, 'unit', id + '-unit', { list: 'unit-list', placeholder: 'ks' })));
    if (vatMode !== 'none') row.appendChild(field('VAT %', bindNumber(item, 'vatRate', id + '-vat', { list: 'vat-list' })));
    row.appendChild(field('Unit price', bindNumber(item, 'price', id + '-price')));

    var foot = h('div', { class: 'foot' });
    if (!item.discount) foot.appendChild(button('Discount', function () { item.discount = { type: 'percent', value: 0 }; touch(); rebuildForm(); }, 'small quiet'));
    foot.appendChild(button('Copy', function () {
      var copy = JSON.parse(JSON.stringify(item));
      copy.id = C.uid();
      doc.items.splice(index + 1, 0, copy);
      touch();
      rebuildForm();
    }, 'small quiet'));
    if (index > 0) foot.appendChild(button('Up', function () { doc.items.splice(index - 1, 0, doc.items.splice(index, 1)[0]); touch(); rebuildForm(); }, 'small quiet', { 'aria-label': 'Move the item up' }));
    if (index < doc.items.length - 1) foot.appendChild(button('Down', function () { doc.items.splice(index + 1, 0, doc.items.splice(index, 1)[0]); touch(); rebuildForm(); }, 'small quiet', { 'aria-label': 'Move the item down' }));
    foot.appendChild(button('Remove', function () { doc.items.splice(index, 1); touch(); rebuildForm(); }, 'small quiet'));
    foot.appendChild(h('output', { class: 'line-total', id: id + '-total', 'aria-label': 'Line total' }));
    row.appendChild(foot);

    if (item.discount) {
      row.appendChild(h('div', { class: 'discount' },
        field('Discount', bindNumber(item.discount, 'value', id + '-dv')),
        field('As', bindSelect(item.discount, 'type', id + '-dt', [{ value: 'percent', label: 'Percent' }, { value: 'amount', label: 'An amount in ' + doc.currency }])),
        button('Remove the discount', function () { item.discount = null; touch(); rebuildForm(); }, 'small quiet'),
        h('output', { class: 'line-total', id: id + '-off', 'aria-label': 'Discount' })));
    }
    return row;
  }

  // --- Look

  function sectionLook(doc) {
    var company = companyById(doc.supplierId);
    var sec = h('section', { class: 'section' });
    sec.appendChild(h('header', null, h('h2', { text: 'Language and look' })));
    var grid = h('div', { class: 'grid' });
    sec.appendChild(grid);
    grid.appendChild(field('Language of the document', bindSelect(doc, 'language', 'f-language',
      I18N.list().map(function (l) { return { value: l.code, label: l.name }; }), { after: fillUnits }), { cls: 'c6' }));
    grid.appendChild(field('Currency', bindSelect(doc, 'currency', 'f-currency',
      C.CURRENCIES.map(function (c) { return { value: c.code, label: c.code + (c.symbol && c.symbol !== c.code ? '  (' + c.symbol + ')' : '') }; }), { rebuild: true }), { cls: 'c6' }));
    if (doc.currency !== 'CZK' && C.vatModeOf(doc) === 'vat' && C.kindOf(doc).taxDocument) {
      grid.appendChild(field('Exchange rate: CZK for 1 ' + doc.currency, bindNumber(doc, 'exchangeRate', 'f-rate', { placeholder: 'for example 25.250' }),
        { cls: 'c6', hint: 'Printed with the tax base and VAT in CZK, as a Czech tax document requires.' }));
    }
    grid.appendChild(field('Rounding of the total', bindSelect(doc, 'rounding', 'f-rounding',
      Object.keys(C.ROUNDING_STEPS).map(function (k) { return { value: k, label: ROUNDING_LABEL[k] }; })), { cls: 'c6' }));
    grid.appendChild(field('Layout', bindSelect(doc, 'template', 'f-template',
      [{ value: 'modern', label: 'Modern' }, { value: 'simple', label: 'Simple' }]), { cls: 'c6' }));

    var swatches = h('div', { class: 'swatches', role: 'group', 'aria-label': 'Accent colour' });
    function drawSwatches() {
      swatches.textContent = '';
      COLORS.forEach(function (c) {
        swatches.appendChild(h('button', {
          type: 'button', class: 'swatch', style: 'background:' + c, 'aria-label': 'Colour ' + c,
          'aria-pressed': String(String(doc.color).toLowerCase() === c),
          onclick: function () { doc.color = c; touch(); drawSwatches(); }
        }));
      });
      var custom = h('input', { type: 'color', id: 'f-color', 'aria-label': 'Another colour' });
      custom.value = /^#[0-9a-fA-F]{6}$/.test(doc.color || '') ? doc.color : COLORS[0];
      custom.addEventListener('input', function () {
        doc.color = custom.value;
        touch();
        Array.prototype.forEach.call(swatches.querySelectorAll('.swatch'), function (b) { b.setAttribute('aria-pressed', 'false'); });
      });
      swatches.appendChild(custom);
    }
    drawSwatches();
    grid.appendChild(h('div', { class: 'field c12' }, h('span', { class: 'label', text: 'Accent colour' }), swatches));

    grid.appendChild(field('Register entry printed under the supplier', bindText(doc, 'registerNote', 'f-register', { multiline: true, rows: 2, placeholder: 'For example where the company is registered' }), { cls: 'c12' }));

    if (!S.example && company) {
      grid.appendChild(h('div', { class: 'c12 row' },
        h('span', { class: 'hint', text: (company.logo ? 'Logo set. ' : 'No logo. ') + (company.stamp ? 'Stamp set.' : 'No stamp or signature.') + ' Both belong to the company profile.' }),
        button('Edit company', function () {
          openCompanyDialog(company, { then: function (c) { useCompanyDetails(doc, c); touch(); rebuildForm(); } });
        }, 'small quiet', { id: 'f-edit-company-look' })));
    }
    return sec;
  }

  function fillUnits() {
    var list = $('#unit-list');
    if (!list || !S.doc) return;
    var units = I18N.get(S.doc.language).units || {};
    list.textContent = '';
    C.UNIT_KEYS.forEach(function (k) { if (units[k]) list.appendChild(h('option', { value: units[k] })); });
  }

  // --- computed parts of the editor

  function collectChecks(doc, totals) {
    var out = [];
    var kind = C.kindOf(doc);
    if (!String(doc.customer.name || '').trim()) out.push('The customer has no name yet.');
    if (!doc.items.length || totals.gross === 0) out.push('There is nothing to pay for yet: no item has a price.');
    if (!String(doc.number || '').trim()) out.push('The document has no number.');
    else if (S.invoices.some(function (x) {
      return x !== doc && x.supplierId === doc.supplierId && C.kindOf(x).series === kind.series && String(x.number) === String(doc.number);
    })) out.push('Number ' + doc.number + ' is already used by another document of this company.');
    if (doc.customer.country === 'CZ' && doc.customer.companyNumber && !C.validateIco(doc.customer.companyNumber)) out.push("The customer's IČO is not valid.");
    if (totals.vatMode !== 'none' && !String(doc.supplier.taxNumber || '').trim()) out.push('A VAT payer has to print their DIČ. Add it to the company profile.');
    if (totals.vatMode === 'reverse' && !String(doc.customer.taxNumber || '').trim()) out.push("Reverse charge needs the customer's DIČ.");
    if (kind.payable && C.isIsoDate(doc.dueDate) && C.isIsoDate(doc.issueDate) && doc.dueDate < doc.issueDate) out.push('The due date is before the issue date.');
    if (kind.payable && doc.paymentMethod === 'transfer' && doc.bank.hidden) {
      out.push('The bank account is hidden on this document, so the customer will not see where to pay. Untick "Hide the bank account" under Payment.');
    }
    if (kind.payable && doc.paymentMethod === 'transfer' && !doc.bank.hidden) {
      var account = String(doc.bank.account || '').trim();
      var iban = C.cleanIban(doc.bank.iban);
      if (!account && !iban) out.push('There is no bank account, so the customer has nowhere to pay.');
      if (account && !C.parseCzAccount(account)) out.push('The account number is not in the Czech form, such as 19-123456789/0100.');
      else if (account && !C.validateCzAccount(account)) out.push('The account number fails its check digits. Look for a typo.');
      if (iban && !C.validateIban(iban)) out.push('The IBAN is not valid.');
    }
    if (doc.kind === 'corrective' && !String(doc.correctedNumber || '').trim()) out.push('A corrective document names the document it corrects.');
    if (doc.kind === 'corrective' && !String(doc.correctionReason || '').trim()) out.push('A corrective document states the reason for the correction.');
    if (totals.vatMode === 'vat' && kind.taxDocument && doc.currency !== 'CZK' && !(C.parseNumber(doc.exchangeRate) > 0)) {
      out.push('A VAT document in ' + doc.currency + ' also has to state the tax in CZK. Fill in the exchange rate under Language and look.');
    }
    return out;
  }

  function refreshComputed(now) {
    var doc = S.doc;
    if (!doc || S.view !== 'editor') return;
    var totals = C.computeTotals(doc);
    var cur = doc.currency;

    var title = $('#doc-title');
    if (title) title.textContent = (KIND_SHORT[doc.kind] || 'Document') + (doc.number ? ' ' + doc.number : '');

    var byItem = {}, offByItem = {};
    totals.lines.forEach(function (l) {
      var shown = totals.vatMode === 'vat' ? l.gross : l.net;
      if (l.kind === 'item') byItem[l.itemId] = shown;
      else if (l.kind === 'item_discount') offByItem[l.itemId] = shown;
    });
    doc.items.forEach(function (item) {
      var out = document.getElementById('i-' + item.id + '-total');
      if (out) out.textContent = money(byItem[item.id] || 0, cur);
      var off = document.getElementById('i-' + item.id + '-off');
      if (off) off.textContent = offByItem[item.id] ? money(offByItem[item.id], cur) : '';
    });

    var box = $('#totals');
    if (box) {
      box.textContent = '';
      var add = function (label, value, cls) {
        box.appendChild(h('dt', { class: cls, text: label }));
        box.appendChild(h('dd', { class: cls, text: value }));
      };
      if (totals.vatMode === 'vat') {
        add('Total without VAT', money(totals.net, cur));
        totals.byRate.forEach(function (r) { add('VAT ' + C.formatPercent(r.rateBp / 100, UI), money(r.vat, cur)); });
      }
      if (totals.rounding !== 0) add('Rounding', money(totals.rounding, cur));
      add(C.kindOf(doc).payable ? 'To pay' : 'Total', money(totals.payable, cur), 'grand');
    }

    var due = $('#due-text');
    if (due) due.textContent = C.formatDate(doc.dueDate, UI);

    var accountHint = $('#account-hint');
    if (accountHint) {
      var account = String(doc.bank.account || '').trim();
      accountHint.className = 'hint';
      if (!account) accountHint.textContent = 'Czech form: prefix-number/bank code';
      else if (C.validateCzAccount(account)) { accountHint.textContent = 'IBAN ' + C.formatIban(C.czAccountToIban(account)); accountHint.className = 'hint ok'; }
      else { accountHint.textContent = C.parseCzAccount(account) ? 'The check digits do not add up' : 'Expected a form like 19-123456789/0100'; accountHint.className = 'hint warn'; }
    }
    var ibanHint = $('#iban-hint');
    if (ibanHint) {
      var typed = C.cleanIban(doc.bank.iban);
      ibanHint.className = 'hint';
      if (!typed) ibanHint.textContent = 'Left empty, it is worked out from the account number';
      else if (C.validateIban(typed)) { ibanHint.textContent = 'Valid IBAN'; ibanHint.className = 'hint ok'; }
      else { ibanHint.textContent = 'Not a valid IBAN'; ibanHint.className = 'hint warn'; }
    }
    var qrHint = $('#qr-hint');
    if (qrHint) {
      var qr = C.paymentQr(doc, totals);
      if (qr) qrHint.textContent = qr.type === 'epc' ? 'A SEPA payment code will be printed.' : 'A QR Platba code will be printed.';
      else if (!doc.showQr) qrHint.textContent = 'Tick it so the customer can scan the code in a banking app and pay.';
      else if (doc.bank.hidden) qrHint.textContent = 'Not printed while the bank account is hidden. Untick "Hide the bank account" above.';
      else if (!(totals.payable > 0)) qrHint.textContent = 'Printed once there is an amount to pay.';
      else if (!C.resolveIban(doc.bank)) qrHint.textContent = 'Needs a valid account number or IBAN.';
      else qrHint.textContent = 'Printed for a Czech account, or for a euro payment to any IBAN.';
    }

    var checks = $('#checks');
    var section = $('#checks-section');
    if (checks && section) {
      var problems = collectChecks(doc, totals);
      checks.textContent = '';
      problems.forEach(function (p) { checks.appendChild(h('li', { text: p })); });
      section.hidden = !problems.length;
    }

    clearTimeout(previewTimer);
    if (now) refreshPreview();
    else previewTimer = setTimeout(refreshPreview, 140);
  }

  function refreshPreview() {
    var host = $('#preview-host');
    var doc = S.doc;
    if (!host || !doc) return;
    var pagesLabel = $('#preview-pages');
    var r = renderer();
    if (!r) {
      host.textContent = '';
      host.appendChild(h('div', { class: 'preview-empty', text: 'The preview could not load. Reload the page.' }));
      return;
    }
    try {
      var layout = r.layout(buildVm(doc));
      var html = '';
      for (var i = 0; i < layout.pages.length; i++) html += '<div class="sheet">' + r.svg(layout, i) + '</div>';
      host.innerHTML = html;
      if (pagesLabel) pagesLabel.textContent = layout.pages.length === 1 ? 'A4, 1 page' : 'A4, ' + layout.pages.length + ' pages';
    } catch (e) {
      host.textContent = '';
      host.appendChild(h('div', { class: 'preview-empty', text: 'The preview could not be drawn. ' + ((e && e.message) || '') }));
    }
  }

  // ------------------------------------------------------------ companies

  function renderCompanies() {
    var view = $('#view');
    view.textContent = '';
    var page = h('div', { class: 'wrap page' });
    view.appendChild(page);

    page.appendChild(h('div', { class: 'page-head' }, h('h1', { text: 'Companies' }), h('span', { class: 'spacer' }),
      button('Add a customer', function () { openCompanyDialog(C.newCompany('customer'), { isNew: true, then: renderCompanies }); }, '', { id: 'add-customer' }),
      button('Add my company', function () { openCompanyDialog(C.newCompany('supplier'), { isNew: true, then: renderCompanies }); }, 'primary', { id: 'add-company' }),
      h('p', { class: 'lede', text: 'Your own companies issue documents; customers receive them. A document keeps the details it was issued with, so changing a company here never rewrites an invoice you already sent.' })));

    function table(title, list, isSupplier) {
      var panel = h('div', { class: 'panel' });
      page.appendChild(h('h3', { text: title }));
      page.appendChild(panel);
      if (!list.length) {
        panel.appendChild(h('div', { class: 'empty' },
          h('strong', { text: isSupplier ? 'No company of yours yet' : 'No customers yet' }),
          h('span', { text: isSupplier ? 'Add the company or the trade licence you invoice under.' : 'A customer is saved here the first time you issue a document for them, or add one now.' })));
        return;
      }
      var tbody = h('tbody');
      list.forEach(function (c) {
        var count = S.invoices.filter(function (d) { return isSupplier ? d.supplierId === c.id : d.customerId === c.id; }).length;
        var tr = h('tr', null,
          h('td', { class: 'wide' }, h('div', { class: 'title', text: c.name || 'Unnamed' }), h('div', { class: 'sub', text: addressLine(c) })),
          h('td', { class: 'num', 'data-label': 'IČO', text: c.companyNumber || '' }),
          h('td', { class: 'num', 'data-label': 'DIČ', text: c.taxNumber || '' }),
          h('td', { 'data-label': 'Documents', text: String(count) }),
          isSupplier ? h('td', null, h('span', { class: 'chip ' + (c.vatPayer ? 'issued' : ''), text: c.vatPayer ? 'VAT payer' : 'Not a VAT payer' })) : null);
        var actions = h('td', { class: 'actions' });
        actions.appendChild(button('New document', function () {
          if (isSupplier) newDocument(c);
          else startNewDocument({ customer: c });
        }, 'small quiet'));
        actions.appendChild(button('Edit', function () { openCompanyDialog(c, { then: renderCompanies }); }, 'small quiet', { id: 'edit-' + c.id }));
        if (isSupplier && count) {
          actions.appendChild(button('Delete', function () { toast('This company has ' + count + ' document' + (count === 1 ? '' : 's') + '. Delete those first.', 'bad'); }, 'small quiet'));
        } else {
          actions.appendChild(confirmButton('Delete', 'Delete ' + (c.name || 'it') + '?', function () {
            var i = S.companies.indexOf(c);
            if (i !== -1) S.companies.splice(i, 1);
            // a document that was only open, never saved, goes with its company
            if (S.doc && !S.example && S.doc.supplierId === c.id && !isSaved(S.doc)) { S.doc = null; S.dirty = false; rememberOpen(null); }
            Store.removeCompany(c.id).catch(function (e) { toast('It was not deleted. ' + errorText(e), 'bad'); });
            renderCompanies();
          }));
        }
        tr.appendChild(actions);
        tbody.appendChild(tr);
      });
      panel.appendChild(h('div', { class: 'table-scroll' }, h('table', { class: 'ledger' },
        h('thead', null, h('tr', null, h('th', { text: 'Name' }), h('th', { text: 'IČO' }), h('th', { text: 'DIČ' }), h('th', { text: 'Documents' }),
          isSupplier ? h('th', { text: 'VAT' }) : null, h('th', { text: '' }))),
        tbody)));
    }
    table('My companies', suppliers(), true);
    table('Customers', customers(), false);
  }

  // ------------------------------------------------------ company dialog

  function readImage(file, maxW, maxH) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type)) { reject(new Error('Choose a picture: PNG, JPG, GIF, WebP or SVG.')); return; }
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('The file could not be read.')); };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error('The picture could not be opened.')); };
        img.onload = function () {
          var w = img.naturalWidth || img.width || maxW;
          var hgt = img.naturalHeight || img.height || maxH;
          var scale = Math.min(1, maxW / w, maxH / hgt);
          for (var attempt = 0; attempt < 6; attempt++) {
            var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(hgt * scale));
            var canvas = document.createElement('canvas');
            canvas.width = cw;
            canvas.height = ch;
            var ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, cw, ch);
            var src = canvas.toDataURL('image/png');
            if (src.length > MAX_IMAGE_CHARS) {
              // a photo: flatten onto white and keep it as a JPEG
              ctx.globalCompositeOperation = 'destination-over';
              ctx.fillStyle = '#ffffff';
              ctx.fillRect(0, 0, cw, ch);
              src = canvas.toDataURL('image/jpeg', 0.85);
            }
            if (src.length <= MAX_IMAGE_CHARS) { resolve({ src: src, w: cw, h: ch }); return; }
            scale *= 0.7;
          }
          reject(new Error('The picture is too detailed to store. Use a simpler or smaller one.'));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function imageSlot(work, key, label, maxW, maxH) {
    var slot = h('div', { class: 'image-slot' });
    function draw() {
      slot.textContent = '';
      var thumb = h('div', { class: 'thumb' });
      if (work[key] && work[key].src) thumb.appendChild(h('img', { src: work[key].src, alt: label }));
      else thumb.textContent = 'None';
      var input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml', id: 'co-' + key, style: 'max-width:230px' });
      input.addEventListener('change', async function () {
        try {
          work[key] = await readImage(input.files && input.files[0], maxW, maxH);
          draw();
        } catch (e) { toast(e.message || 'The picture could not be used.', 'bad'); }
      });
      slot.appendChild(thumb);
      slot.appendChild(h('div', { class: 'field' }, h('label', { class: 'label', for: 'co-' + key, text: label }), input));
      if (work[key]) slot.appendChild(button('Remove', function () { work[key] = null; draw(); }, 'small quiet'));
    }
    draw();
    return slot;
  }

  /** Create or edit a company. Works on a copy; the saved company changes only when Save is pressed. */
  function openCompanyDialog(company, opts) {
    opts = opts || {};
    var dlg = $('#dialog');
    // what opened the dialog: the button just pressed (a click does not focus a button in every browser), else the focused element
    var openerId = lastPressedId || (document.activeElement && document.activeElement.id) || '';
    function restoreFocus() {
      var el = openerId ? document.getElementById(openerId) : null;
      if (el && el.focus) el.focus();
    }
    // 'close' fires after Save, Cancel and Escape alike, and after the screen behind has been redrawn
    dlg.addEventListener('close', restoreFocus, { once: true });
    var isSupplier = company.kind === 'supplier';
    var work = JSON.parse(JSON.stringify(company));
    if (isSupplier) {
      work.bank = Object.assign(C.emptyBank(), work.bank || {});
      work.defaults = Object.assign({}, C.SUPPLIER_DEFAULTS, work.defaults || {});
    }
    var noop = function () {};

    function build() {
      dlg.textContent = '';
      var body = h('div', { class: 'dialog-body' });
      var identity = h('fieldset', null, h('legend', { text: isSupplier ? 'Your company' : 'Customer' }));
      append(identity, partyFields(work, 'co', noop, build));
      if (isSupplier) {
        identity.appendChild(bindCheck(work, 'vatPayer', 'co-vat', 'This company is a VAT payer', { changed: noop, hint: '(new documents start as invoices with VAT)' }));
      }
      body.appendChild(identity);

      if (isSupplier) {
        var accountHint = h('span', { class: 'hint' });
        var updateAccount = function () {
          var a = String(work.bank.account || '').trim();
          accountHint.className = 'hint';
          if (!a) accountHint.textContent = 'Czech form: prefix-number/bank code';
          else if (C.validateCzAccount(a)) { accountHint.textContent = 'IBAN ' + C.formatIban(C.czAccountToIban(a)); accountHint.className = 'hint ok'; }
          else { accountHint.textContent = 'Check the number: it should look like 19-123456789/0100'; accountHint.className = 'hint warn'; }
        };
        updateAccount();
        body.appendChild(h('fieldset', null, h('legend', { text: 'Bank account' }),
          h('div', { class: 'grid' },
            field('Account number', bindText(work.bank, 'account', 'co-account', { cls: 'mono', changed: updateAccount, placeholder: '123456789/0100' }), { cls: 'c6', hint: accountHint }),
            field('Name of the account', bindText(work.bank, 'accountName', 'co-account-name', { changed: noop, placeholder: 'Optional' }), { cls: 'c6' }),
            field('IBAN', bindText(work.bank, 'iban', 'co-iban', { cls: 'mono', changed: noop, placeholder: 'Only for a foreign account' }), { cls: 'c8' }),
            field('SWIFT / BIC', bindText(work.bank, 'swift', 'co-swift', { cls: 'mono', changed: noop }), { cls: 'c4' }),
            h('div', { class: 'c12' }, bindCheck(work.bank, 'showIban', 'co-show-iban', 'Print the IBAN and SWIFT on documents', { changed: noop })))));

        var d = work.defaults;
        var patternHint = h('span', { class: 'hint' });
        var updatePattern = function () { patternHint.textContent = 'First number this year: ' + C.formatPattern(d.numberPattern, today(), 1) + '. YYYY, YY and MM are the date, a run of N is the counter.'; };
        updatePattern();
        body.appendChild(h('fieldset', null, h('legend', { text: 'What a new document starts with' }),
          h('div', { class: 'grid' },
            field('Numbering', bindText(d, 'numberPattern', 'co-pattern', { cls: 'mono', changed: updatePattern }), { cls: 'c6', hint: patternHint }),
            field('Issued by', bindText(d, 'issuedBy', 'co-issued-by', { changed: noop, placeholder: 'Name printed on documents' }), { cls: 'c6' }),
            field('Due in (days)', bindNumber(d, 'dueDays', 'co-due', { changed: noop }), { cls: 'c3 half-sm' }),
            field('Currency', bindSelect(d, 'currency', 'co-currency', C.CURRENCIES.map(function (c) { return { value: c.code, label: c.code }; }), { changed: noop }), { cls: 'c3 half-sm' }),
            field('Language', bindSelect(d, 'language', 'co-language', I18N.list().map(function (l) { return { value: l.code, label: l.name }; }), { changed: noop }), { cls: 'c3 half-sm' }),
            field('Paid by', bindSelect(d, 'paymentMethod', 'co-method', C.PAYMENT_METHODS.map(function (m) { return { value: m, label: PAYMENT_LABEL[m] }; }), { changed: noop }), { cls: 'c3 half-sm' }),
            field('Prices are typed', bindSelect(d, 'priceMode', 'co-price-mode', [{ value: 'net', label: 'Without VAT' }, { value: 'gross', label: 'With VAT' }], { changed: noop }), { cls: 'c4 half-sm' }),
            field('Rounding', bindSelect(d, 'rounding', 'co-rounding', Object.keys(C.ROUNDING_STEPS).map(function (k) { return { value: k, label: ROUNDING_LABEL[k] }; }), { changed: noop }), { cls: 'c4 half-sm' }),
            field('Layout', bindSelect(d, 'template', 'co-template', [{ value: 'modern', label: 'Modern' }, { value: 'simple', label: 'Simple' }], { changed: noop }), { cls: 'c4' }),
            field('Note printed on every document', bindText(d, 'note', 'co-note', { multiline: true, rows: 2, changed: noop }), { cls: 'c12' }),
            field('Register entry', bindText(work, 'registerNote', 'co-register', { multiline: true, rows: 2, changed: noop, placeholder: 'For example: Zapsáno v obchodním rejstříku u Městského soudu v Praze, oddíl C, vložka 12345' }), { cls: 'c12' }))));

        body.appendChild(h('fieldset', null, h('legend', { text: 'Logo and stamp' }),
          imageSlot(work, 'logo', 'Logo, printed at the top', 720, 300),
          imageSlot(work, 'stamp', 'Stamp or signature, printed at the bottom', 600, 340)));
      }

      var form = h('form', { class: 'dialog-form', method: 'dialog' },
        h('div', { class: 'dialog-head' }, h('h2', { id: 'dialog-title', text: opts.isNew ? (isSupplier ? 'Add my company' : 'Add a customer') : 'Edit ' + (company.name || 'company') }),
          h('span', { class: 'spacer' })),
        h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }),
        body,
        h('div', { class: 'dialog-foot' },
          button('Cancel', function () { dlg.close(); }),
          h('button', { type: 'submit', class: 'btn primary', text: 'Save' })));
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!String(work.name || '').trim()) {
          toast('Give it a name first.', 'bad');
          var n = document.getElementById('co-name');
          if (n) {
            n.setAttribute('aria-invalid', 'true');
            n.addEventListener('input', function () { n.removeAttribute('aria-invalid'); }, { once: true });
            n.focus();
          }
          return;
        }
        if (isSupplier) {
          var days = Number(work.defaults.dueDays);
          work.defaults.dueDays = days >= 0 && days <= 3650 ? Math.round(days) : 14;
          if (!/N/.test(String(work.defaults.numberPattern || ''))) work.defaults.numberPattern = 'YYYYNNNN';
        }
        Object.keys(company).forEach(function (k) { delete company[k]; });
        Object.assign(company, work);
        saveCompany(company);
        var wasExample = S.example;
        // once a real company exists the made-up example has done its job
        if (wasExample && isSupplier) leaveExample();
        dlg.close();
        if (wasExample && isSupplier && !opts.then) { newDocument(company); return; }
        if (opts.then) opts.then(company);
      });
      dlg.appendChild(form);
      autosizeAll(dlg);
    }
    build();
    if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); }
    else dlg.setAttribute('open', '');
    autosizeAll(dlg);
    var first = document.getElementById(canLookup ? 'co-ico' : 'co-name');
    if (first) first.focus();
  }

  // --------------------------------------------------------------- backup

  function renderBackup() {
    var view = $('#view');
    view.textContent = '';
    var page = h('div', { class: 'wrap page' });
    view.appendChild(page);
    page.appendChild(h('div', { class: 'page-head' }, h('h1', { text: 'Backup' })));

    var where = S.mode === 'cloud'
      ? 'Your companies and documents are saved to your Claude account, in a part of this page\'s storage that only you can read. They are there on any device where you open this page signed in.'
      : S.mode === 'folder'
        ? 'Your companies and documents are files in the folder \u201c' + Store.folderState().name + '\u201d on this computer. Back that folder up, or keep it in iCloud Drive, as you would any other documents.'
        : S.mode === 'local'
          ? 'Your companies and documents are saved in this browser on this device only. Clearing the browser\'s site data removes them, so ' + (Store.folderState().supported ? 'keep them in a folder (below) or ' : '') + 'export a backup now and then.'
          : 'This view cannot store anything. What you enter is lost when the page closes; export a backup before you leave.';
    page.appendChild(h('div', { class: 'notice' + (S.mode === 'cloud' || S.mode === 'folder' ? '' : ' warn') }, h('p', { text: where })));
    if (!window.claude) page.appendChild(folderSection(Store.folderState()));

    var counts = h('p', { class: 'muted', text: suppliers().length + ' of your companies, ' + customers().length + ' customers, ' + S.invoices.length + ' documents.' });
    var exportBtn = button('Export a backup file', async function () {
      await saveNow();
      var data = { app: 'invoice-workbench', version: 1, exportedAt: new Date().toISOString(), companies: S.companies, invoices: S.invoices, settings: S.settings };
      try {
        await saveFile(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }), 'invoice-workbench-backup-' + today() + '.json');
        toast('Backup saved.');
      } catch (e) {
        if (!(e && e.code === 'declined')) toast('The backup was not saved. ' + errorText(e), 'bad');
      }
    }, 'primary');

    var file = h('input', { type: 'file', accept: 'application/json,.json', id: 'import-file', style: 'max-width:280px' });
    file.addEventListener('change', function () {
      var f = file.files && file.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () { importBackup(String(reader.result || '')); file.value = ''; };
      reader.onerror = function () { toast('The file could not be read.', 'bad'); };
      reader.readAsText(f);
    });

    page.appendChild(h('section', { class: 'section' },
      h('header', null, h('h2', { text: 'Export' })), counts,
      h('p', { class: 'muted', text: 'One JSON file with everything, logos included. Keep it somewhere safe; it can be imported here or on another device.' }),
      h('div', { class: 'row' }, exportBtn)));
    page.appendChild(h('section', { class: 'section' },
      h('header', null, h('h2', { text: 'Import' })),
      h('p', { class: 'muted', text: 'Adds the companies and documents of a backup file to what is here. A record that is already here is replaced by the one in the file.' }),
      h('div', { class: 'field' }, h('label', { class: 'label', for: 'import-file', text: 'Backup file' }), file)));
    page.appendChild(h('section', { class: 'section' },
      h('header', null, h('h2', { text: 'Delete everything' })),
      h('p', { class: 'muted', text: 'Removes every company and document stored for you by this page. It cannot be undone, so export a backup first.' }),
      h('div', { class: 'row' }, confirmButton('Delete all my data', 'Delete every company and document?', function () {
        var jobs = S.invoices.map(function (d) { return Store.removeInvoice(d.id); }).concat(S.companies.map(function (c) { return Store.removeCompany(c.id); }));
        S.invoices = [];
        S.companies = [];
        S.doc = null;
        S.dirty = false;
        rememberOpen(null);
        Promise.all(jobs).then(function () { toast('Everything was deleted.'); }, function (e) { toast('Some records were not deleted. ' + errorText(e), 'bad'); });
        renderBackup();
      }, 'danger'))));
  }

  function importBackup(text) {
    var data;
    try { data = JSON.parse(text); } catch (e) { toast('This is not a backup file (it is not valid JSON).', 'bad'); return; }
    if (!data || data.app !== 'invoice-workbench' || !Array.isArray(data.companies) || !Array.isArray(data.invoices)) {
      toast('This file was not exported by Invoice Workbench.', 'bad');
      return;
    }
    saveNow();
    var idOk = function (id) {
      return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) && ['__proto__', 'constructor', 'prototype'].indexOf(id) === -1;
    };
    var companies = data.companies.filter(function (c) { return c && idOk(c.id) && (c.kind === 'supplier' || c.kind === 'customer'); }).map(cleanCompany);
    var invoices = data.invoices.filter(function (d) { return d && idOk(d.id); }).map(C.normalizeInvoice);
    var jobs = [];
    companies.forEach(function (c) {
      var at = -1;
      S.companies.forEach(function (x, i) { if (x.id === c.id) at = i; });
      if (at === -1) S.companies.push(c); else S.companies[at] = c;
      jobs.push(Store.putCompany(c));
    });
    invoices.forEach(function (d) {
      var at = -1;
      S.invoices.forEach(function (x, i) { if (x.id === d.id) at = i; });
      if (at === -1) S.invoices.push(d); else S.invoices[at] = d;
      jobs.push(Store.putInvoice(d));
    });
    S.doc = null;
    S.dirty = false;
    leaveExample();
    Promise.all(jobs).then(function () {
      toast('Imported ' + companies.length + ' companies and ' + invoices.length + ' documents.');
    }, function (e) { toast('Part of the backup was not saved. ' + errorText(e), 'bad'); });
    renderBackup();
  }

  // ----------------------------------------------------------------- start

  boot();
})();
