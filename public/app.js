// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

(() => {
  const $ = (sel) => document.querySelector(sel);
  const form = $('#queryForm');
  const nameInput = $('#name');
  const typeSelect = $('#type');
  const serverInput = $('#server');
  const customBox = $('#customBox');
  const chipsEl = $('#chips');
  const datalist = $('#serverHistory');
  const submitBtn = $('#submitBtn');
  const resultsEl = $('#results');
  const outputEl = $('#output');
  const toastEl = $('#toast');

  const MAX_HISTORY = 5;
  const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

  let config = { defaultServer: '', types: ['A'], allTypes: [] };
  let last = null; // { name, type, server, data }

  // ---------------------------------------------------------------- cookies
  function getCookie(key) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + key + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function setCookie(key, value) {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${key}=${encodeURIComponent(value)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
  }
  function getHistory() {
    try {
      const list = JSON.parse(getCookie('dnsServers') || '[]');
      return Array.isArray(list) ? list.filter((s) => typeof s === 'string').slice(0, MAX_HISTORY) : [];
    } catch {
      return [];
    }
  }
  function saveHistory(list) {
    setCookie('dnsServers', JSON.stringify(list.slice(0, MAX_HISTORY)));
    renderHistory();
  }
  function addToHistory(server) {
    saveHistory([server, ...getHistory().filter((s) => s !== server)]);
  }
  function removeFromHistory(server) {
    saveHistory(getHistory().filter((s) => s !== server));
  }

  // ---------------------------------------------------------------- theme
  const themeBtn = $('#themeBtn');
  function currentTheme() {
    return document.documentElement.dataset.theme || 'auto';
  }
  function applyThemeButton() {
    const mode = currentTheme();
    themeBtn.dataset.mode = mode;
    const label = `Theme: ${mode}`;
    themeBtn.setAttribute('aria-label', label);
    themeBtn.title = label;
  }
  themeBtn.addEventListener('click', () => {
    const next = { auto: 'light', light: 'dark', dark: 'auto' }[currentTheme()];
    if (next === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
    try {
      if (next === 'auto') localStorage.removeItem('theme');
      else localStorage.setItem('theme', next);
    } catch { /* ignore */ }
    applyThemeButton();
  });
  applyThemeButton();

  // ---------------------------------------------------------------- UI helpers
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : String(c));
    }
    return node;
  }

  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2200);
  }

  function getMode() {
    return form.querySelector('input[name="mode"]:checked').value;
  }
  function setMode(mode) {
    form.querySelector(`input[name="mode"][value="${mode}"]`).checked = true;
    customBox.hidden = mode !== 'custom';
  }
  function getView() {
    return document.querySelector('input[name="view"]:checked').value;
  }
  function setView(view) {
    const input = document.querySelector(`input[name="view"][value="${view === 'dig' ? 'dig' : 'summary'}"]`);
    input.checked = true;
  }

  function renderHistory() {
    const list = getHistory();
    datalist.replaceChildren(...list.map((s) => el('option', { value: s })));
    chipsEl.replaceChildren(...list.map((s) =>
      el('span', { class: 'chip' + (s === serverInput.value.trim() ? ' active' : '') },
        el('button', { type: 'button', class: 'chip-use', title: `Use ${s}`, onclick: () => {
          serverInput.value = s;
          serverInput.classList.remove('invalid');
          renderHistory();
        } }, s),
        el('button', { type: 'button', class: 'chip-del', 'aria-label': `Remove ${s}`, title: 'Remove', onclick: () => {
          removeFromHistory(s);
        } }, '×'))));
  }

  // ---------------------------------------------------------------- URL state
  function updateUrl() {
    if (!last) return;
    const p = new URLSearchParams();
    p.set('name', last.name);
    p.set('type', last.type);
    if (last.server) p.set('server', last.server);
    if (getView() === 'dig') p.set('view', 'dig');
    history.replaceState(null, '', '?' + p.toString());
  }

  // ---------------------------------------------------------------- rendering
  function rcodeClass(rcode) {
    if (rcode === 'NOERROR') return 'ok';
    if (rcode === 'NXDOMAIN') return 'warn';
    return 'err';
  }

  function recordTable(records) {
    return el('table', { class: 'records' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'Name'), el('th', {}, 'TTL'), el('th', {}, 'Type'), el('th', {}, 'Value'))),
      el('tbody', {}, ...records.map((r) => el('tr', {},
        el('td', { class: 'name' }, r.name),
        el('td', { class: 'ttl' }, formatTtl(r.ttl)),
        el('td', { class: 'rtype' }, el('span', { class: 'badge type' }, r.type)),
        el('td', { class: 'val' }, r.value)))));
  }

  function formatTtl(ttl) {
    if (ttl < 60) return `${ttl}s`;
    const parts = [];
    let t = ttl;
    for (const [unit, sec] of [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]]) {
      if (t >= sec) { parts.push(Math.floor(t / sec) + unit); t %= sec; }
    }
    return parts.slice(0, 2).join(' ');
  }

  function summaryCard(type, r) {
    const head = el('div', { class: 'result-head' },
      el('h2', {}, type),
      r.error ? el('span', { class: 'badge err' }, 'ERROR') : el('span', { class: 'badge ' + rcodeClass(r.rcode) }, r.rcode),
      !r.error && el('span', { class: 'meta' }, `${r.answers.length} record${r.answers.length === 1 ? '' : 's'}`),
      el('span', { class: 'meta meta-right' },
        r.error ? r.server : `${r.server} · ${r.transport.toUpperCase()} · ${r.timeMs} ms`));

    const body = [];
    if (r.error) {
      body.push(el('div', { class: 'error-msg' }, r.error));
    } else if (r.answers.length) {
      body.push(recordTable(r.answers));
    } else {
      body.push(el('div', { class: 'empty' },
        r.rcode === 'NXDOMAIN' ? 'Domain does not exist.' : `No ${type} records found.`));
      if (r.authorities.length) {
        body.push(el('div', { class: 'subhead' }, 'Authority'), recordTable(r.authorities));
      }
    }
    return el('div', { class: 'result' }, head, ...body);
  }

  function digText(type, r, name) {
    const q = r.question && r.question[0];
    const lines = [];
    lines.push(`; <<>> WebDNSChecker <<>> @${r.server} ${q ? q.name : name} ${type}`);
    if (r.error) {
      lines.push(`;; ${r.error}`);
      return lines.join('\n');
    }
    const f = r.flags;
    const flags = ['qr', 'aa', 'tc', 'rd', 'ra', 'ad', 'cd'].filter((k) => f[k]).join(' ');
    lines.push(';; Got answer:');
    lines.push(`;; ->>HEADER<<- opcode: ${r.opcode}, status: ${r.rcode}, id: ${r.id}`);
    lines.push(`;; flags: ${flags}; QUERY: ${r.question.length}, ANSWER: ${r.answers.length}, ` +
      `AUTHORITY: ${r.authorities.length}, ADDITIONAL: ${r.additionals.length + (r.edns ? 1 : 0)}`);
    if (r.edns) {
      lines.push('', ';; OPT PSEUDOSECTION:');
      lines.push(`; EDNS: version: ${r.edns.version}, flags:${r.edns.do ? ' do' : ''}; udp: ${r.edns.udpPayloadSize}`);
    }
    lines.push('', ';; QUESTION SECTION:');
    for (const qq of r.question) lines.push(`;${qq.name}\t\t\t${qq.class}\t${qq.type}`);
    const section = (title, recs) => {
      if (!recs.length) return;
      lines.push('', `;; ${title} SECTION:`);
      for (const rr of recs) lines.push(`${rr.name}\t\t${rr.ttl}\t${rr.class}\t${rr.type}\t${rr.value}`);
    };
    section('ANSWER', r.answers);
    section('AUTHORITY', r.authorities);
    section('ADDITIONAL', r.additionals);
    lines.push('');
    lines.push(`;; Query time: ${Math.round(r.timeMs)} msec`);
    const [host, port] = splitServer(r.server);
    lines.push(`;; SERVER: ${host}#${port}(${host}) (${r.transport.toUpperCase()})`);
    lines.push(`;; WHEN: ${new Date(last.at).toString()}`);
    lines.push(`;; MSG SIZE  rcvd: ${r.msgSize}`);
    return lines.join('\n');
  }

  function splitServer(s) {
    let m = s.match(/^\[(.+)\]:(\d+)$/);
    if (m) return [m[1], m[2]];
    m = s.match(/^([^:]+):(\d+)$/);
    if (m) return [m[1], m[2]];
    return [s, '53'];
  }

  function resultEntries() {
    if (!last) return [];
    const d = last.data;
    if (d.results) return Object.entries(d.results);
    return [[last.type, d]];
  }

  function render() {
    if (!last) return;
    resultsEl.hidden = false;
    const entries = resultEntries();
    if (getView() === 'dig') {
      const text = entries.map(([t, r]) => digText(t, r, last.name)).join('\n\n');
      outputEl.replaceChildren(el('pre', { class: 'dig' }, text));
    } else {
      outputEl.replaceChildren(...entries.map(([t, r]) => summaryCard(t, r)));
    }
  }

  function renderError(message) {
    resultsEl.hidden = false;
    outputEl.replaceChildren(el('div', { class: 'result' }, el('div', { class: 'error-msg' }, message)));
  }

  function copyText() {
    if (!last) return '';
    const entries = resultEntries();
    if (getView() === 'dig') return entries.map(([t, r]) => digText(t, r, last.name)).join('\n\n');
    return entries.map(([t, r]) => {
      if (r.error) return `${t}: ERROR ${r.error}`;
      const recs = r.answers.length ? r.answers : [];
      return [`${t} (${r.rcode}) @${r.server}`, ...recs.map((x) => `${x.name}\t${x.ttl}\t${x.type}\t${x.value}`)].join('\n');
    }).join('\n\n');
  }

  async function copy(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMsg);
    } catch {
      // Clipboard API needs a secure context (https/localhost); fall back.
      const ta = el('textarea', { readonly: '' });
      ta.value = text;
      ta.className = 'offscreen';
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
      toast(ok ? okMsg : 'Copy failed');
    }
  }

  // ---------------------------------------------------------------- query
  async function runQuery() {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.classList.add('invalid');
      nameInput.focus();
      return;
    }
    const type = typeSelect.value;
    const mode = getMode();
    const server = mode === 'custom' ? serverInput.value.trim() : '';
    if (mode === 'custom' && !server) {
      serverInput.classList.add('invalid');
      serverInput.focus();
      return;
    }
    setCookie('dnsMode', mode);

    const params = new URLSearchParams({ name, type });
    if (server) params.set('server', server);

    submitBtn.disabled = true;
    submitBtn.classList.add('loading');
    try {
      const res = await fetch('/api/query?' + params.toString(), { headers: { Accept: 'application/json' } });
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (!res.ok && !data.results) {
        if (res.status === 400 && server && /server/i.test(data.error || '')) serverInput.classList.add('invalid');
        renderError(data.error || `Request failed (HTTP ${res.status})`);
        return;
      }
      last = { name, type, server, data, at: Date.now() };
      // Remember a custom server only once it has actually answered.
      const answered = data.results ? Object.values(data.results).some((r) => !r.error) : !data.error;
      if (server && answered) addToHistory(server);
      render();
      updateUrl();
    } catch (err) {
      renderError('Could not reach the server: ' + err.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.classList.remove('loading');
    }
  }

  // ---------------------------------------------------------------- events
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    runQuery();
  });
  form.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', () => {
    setMode(getMode());
    setCookie('dnsMode', getMode());
    if (getMode() === 'custom' && !serverInput.value) {
      serverInput.value = getHistory()[0] || '';
      renderHistory();
      if (!serverInput.value) serverInput.focus();
    }
  }));
  nameInput.addEventListener('input', () => nameInput.classList.remove('invalid'));
  serverInput.addEventListener('input', () => {
    serverInput.classList.remove('invalid');
    renderHistory();
  });
  document.querySelectorAll('input[name="view"]').forEach((r) => r.addEventListener('change', () => {
    render();
    updateUrl();
  }));
  $('#copyBtn').addEventListener('click', () => copy(copyText(), 'Results copied'));
  $('#shareBtn').addEventListener('click', () => copy(location.href, 'Link copied'));

  // ---------------------------------------------------------------- init
  async function init() {
    try {
      const res = await fetch('/api/config');
      config = await res.json();
    } catch { /* keep defaults */ }

    typeSelect.replaceChildren(
      el('option', { value: 'ALL' }, 'All common'),
      ...config.types.map((t) => el('option', { value: t }, t)));
    typeSelect.value = 'A';
    $('#defaultServerLabel').textContent = config.defaultServer ? `(${config.defaultServer})` : '';

    // Restore from cookies first, then let URL params override.
    const history = getHistory();
    setMode(getCookie('dnsMode') === 'custom' ? 'custom' : 'default');
    serverInput.value = history[0] || '';

    const p = new URLSearchParams(location.search);
    if (p.get('type')) {
      const t = p.get('type').toUpperCase();
      if ([...typeSelect.options].some((o) => o.value === t)) typeSelect.value = t;
    }
    if (p.get('server')) {
      setMode('custom');
      serverInput.value = p.get('server');
    } else if (p.get('name')) {
      setMode('default'); // a shared link without a server means "default"
    }
    setView(p.get('view'));
    renderHistory();

    if (p.get('name')) {
      nameInput.value = p.get('name');
      runQuery();
    } else if (matchMedia('(pointer: fine)').matches) {
      nameInput.focus(); // don't pop the keyboard on touch devices
    }
  }

  init();
})();
