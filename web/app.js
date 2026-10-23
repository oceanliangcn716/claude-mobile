'use strict';
(() => {
  // ---------- 小工具 ----------
  const $ = s => document.querySelector(s);
  const MB = 1024 * 1024;

  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) n.append(kid instanceof Node ? kid : String(kid));
    return n;
  }

  // http 局域网地址不是“安全上下文”，没有 crypto.randomUUID 和 navigator.clipboard，自己实现。
  function uuid() {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const x = [...b].map(v => v.toString(16).padStart(2, '0')).join('');
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(() => toast('已复制'), () => fallbackCopy(text));
    } else fallbackCopy(text);
  }

  function fallbackCopy(text) {
    const ta = h('textarea', { style: 'position:fixed;top:0;left:0;opacity:0;font-size:16px', readonly: true });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    toast(ok ? '已复制' : '复制失败，请长按选择文字');
  }

  function hash(str) {
    let x = 5381;
    for (let i = 0; i < str.length; i++) x = ((x << 5) + x + str.charCodeAt(i)) | 0;
    return (x >>> 0).toString(36) + str.length.toString(36);
  }

  let toastTimer;
  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  function pad(n) { return String(n).padStart(2, '0'); }
  function hm(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
  function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  function relTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const sec = (now - d) / 1000;
    if (sec < 60) return '刚刚';
    if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
    if (sameDay(d, now)) return `今天 ${hm(d)}`;
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (sameDay(d, y)) return `昨天 ${hm(d)}`;
    if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  }
  function dayGroup(ts) {
    const d = new Date(ts || 0);
    const now = new Date();
    if (sameDay(d, now)) return '今天';
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (sameDay(d, y)) return '昨天';
    if (now - d < 7 * 86400000) return '最近 7 天';
    if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1} 月`;
    return `${d.getFullYear()} 年`;
  }
  function duration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  }

  const URL_RE = /(https?:\/\/[^\s<>"'）)】」]+)/g;
  function linkified(text) {
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(URL_RE)) {
      if (m.index > last) frag.append(text.slice(last, m.index));
      frag.append(h('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer' }, m[0]));
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.append(text.slice(last));
    return frag;
  }

  marked.setOptions({ gfm: true, breaks: true });
  function markdown(text) {
    const div = h('div', { class: 'md' });
    div.innerHTML = DOMPurify.sanitize(marked.parse(text || ''));
    for (const pre of div.querySelectorAll('pre')) {
      const code = pre.querySelector('code');
      const lang = (/language-([\w+#.-]+)/.exec(code?.className || '') || [])[1] || '';
      const wrap = h('div', { class: 'code-wrap' }, h('div', { class: 'code-head' }, h('span', {}, lang || '代码'), h('button', { 'data-act': 'copy-code' }, '复制')));
      pre.replaceWith(wrap);
      wrap.append(pre);
    }
    for (const t of div.querySelectorAll('table')) {
      const w = h('div', { class: 'table-wrap' });
      t.replaceWith(w);
      w.append(t);
    }
    for (const a of div.querySelectorAll('a[href]')) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    return div;
  }

  const ICON = {
    check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    error: '<svg viewBox="0 0 24 24"><path d="M12 7v6M12 17h.01"/></svg>',
    dot: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2.5" class="fill"/></svg>',
    chev: '<svg viewBox="0 0 24 24" class="chev"><path d="M9 6l6 6-6 6"/></svg>',
    file: '<svg viewBox="0 0 24 24" style="width:16px;height:16px"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
    info: '<svg viewBox="0 0 24 24" style="width:16px;height:16px;flex:none;margin-top:2px"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  };

  // ---------- 状态 ----------
  const MODE_LABEL = { auto: '自动审批', default: '每次询问', acceptEdits: '自动接受编辑', plan: '计划模式', bypassPermissions: '完全放行', dontAsk: '不询问' };
  const MODE_DESC = {
    auto: '安全分类器判断：安全操作直接执行，拿不准再问你（和电脑默认一致）',
    default: '可能有影响的操作都先问你',
    acceptEdits: '改文件不用问，运行命令等还会问',
    plan: '先只读分析、给出计划，你批准后再动手',
    bypassPermissions: '所有操作都不询问，风险最高',
  };
  const EFFORT_LABEL = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高' };
  const SOURCE_LABEL = { desktop: '电脑', mobile: '手机', terminal: '终端', sdk: 'SDK' };

  const S = {
    boot: null,
    clientId: sessionStorage.getItem('cm.client') || uuid(),
    es: null,
    everConnected: false,
    engine: new Map(),
    list: { rows: new Map(), order: [], total: 0, q: '', source: '', loading: false, dirty: false },
    cur: null,
    openToken: 0,
    draft: null,
    sessionSettings: new Map(),
    atts: [],
    optimistic: [],
    expanded: new Set(),
    full: new Map(),
    answering: new Set(),
    prefs: (() => { try { return JSON.parse(localStorage.getItem('cm.prefs') || '{}'); } catch { return {}; } })(),
  };
  sessionStorage.setItem('cm.client', S.clientId);

  class ApiError extends Error {
    constructor(status, message, data) {
      super(message);
      this.status = status;
      this.data = data;
    }
  }

  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} };
    if (opts.body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    let r;
    try {
      r = await fetch(path, init);
    } catch {
      throw new ApiError(0, '连不上 Mac，检查网络或 Tailscale');
    }
    let data = null;
    try { data = await r.json(); } catch {}
    if (r.status === 401) {
      showPair();
      throw new ApiError(401, '需要重新配对', data);
    }
    if (!r.ok) throw new ApiError(r.status, data?.error || `请求失败（${r.status}）`, data);
    return data;
  }

  // ---------- 配对 ----------
  function secretFrom(text) {
    const s = String(text || '').trim();
    const m = /[#&?]pair=([\w-]+)/.exec(s);
    if (m) return m[1];
    return /^[\w-]{32,}$/.test(s) ? s : null;
  }

  function showPair(msg) {
    $('#pair').hidden = false;
    $('#pair-error').textContent = msg || '';
  }

  async function pair(secret) {
    await api('/api/pair', { method: 'POST', body: { secret } });
  }

  async function onPairClick() {
    const secret = secretFrom($('#pair-input').value);
    if (!secret) {
      $('#pair-error').textContent = '没找到配对密钥，请粘贴完整的配对链接';
      return;
    }
    $('#pair-btn').disabled = true;
    try {
      await pair(secret);
      $('#pair-input').value = '';
      $('#pair').hidden = true;
      if (!S.boot) await start();
      else {
        connect();
        resync();
      }
    } catch (e) {
      $('#pair-error').textContent = e.message;
    } finally {
      $('#pair-btn').disabled = false;
    }
  }

  // ---------- 启动 ----------
  async function boot() {
    fitViewport();
    bindUI();
    const fromHash = secretFrom(location.hash);
    if (fromHash) {
      history.replaceState(null, '', location.pathname);
      try {
        await pair(fromHash);
      } catch (e) {
        showPair(e.message);
        return;
      }
    }
    let ping;
    try {
      ping = await api('/api/ping');
    } catch (e) {
      $('#conn').hidden = false;
      $('#conn').textContent = `${e.message}，3 秒后重试…`;
      setTimeout(boot, 3000);
      return;
    }
    if (!ping.paired) return showPair();
    await start();
  }

  async function start() {
    $('#pair').hidden = true;
    S.boot = await api('/api/state');
    for (const e of S.boot.engine) S.engine.set(e.sessionId, e);
    const d = S.boot.defaults;
    S.draft = { cwd: expandHome(d.cwd), model: d.model, effort: d.effort, permissionMode: d.permissionMode };
    connect();
    loadList(true);
    const last = localStorage.getItem('cm.last');
    if (last) openSession(last).catch(() => showNew());
    else showNew();
    setInterval(tick, 1000);
  }

  function expandHome(p) {
    if (!p || p === '~') return S.boot.home;
    return p.startsWith('~/') ? S.boot.home + p.slice(1) : p;
  }

  function displayPath(p) {
    if (!p) return '';
    const home = S.boot?.home;
    return home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p;
  }

  function projectName(cwd) {
    const p = S.boot?.projects.find(x => x.cwd === cwd);
    if (p) return p.name;
    if (cwd === S.boot?.home) return '主目录';
    return (cwd || '').split('/').filter(Boolean).pop() || cwd;
  }

  // ---------- 实时连接 ----------
  function connect() {
    S.es?.close();
    const es = new EventSource(`/api/events?client=${encodeURIComponent(S.clientId)}`);
    S.es = es;
    es.addEventListener('hello', () => {
      const again = S.everConnected;
      S.everConnected = true;
      setConn(true);
      if (S.cur?.id) api('/api/subscribe', { method: 'POST', body: { client: S.clientId, sessionId: S.cur.id } }).catch(() => {});
      if (again) resync();
    });
    es.addEventListener('engine', e => onEngine(JSON.parse(e.data)));
    es.addEventListener('partial', e => onPartial(JSON.parse(e.data)));
    es.addEventListener('transcript', e => onTranscript(JSON.parse(e.data)));
    es.addEventListener('sessions', e => onSessions(JSON.parse(e.data)));
    es.onerror = () => {
      setConn(false);
      if (es.readyState === EventSource.CLOSED) setTimeout(recheck, 2000);
    };
  }

  async function recheck() {
    try {
      const p = await api('/api/ping');
      if (!p.paired) return showPair();
      connect();
    } catch {
      setTimeout(recheck, 3000);
    }
  }

  let connTimer;
  function setConn(ok) {
    clearTimeout(connTimer);
    if (ok) {
      $('#conn').hidden = true;
      renderFoot();
      return;
    }
    // 短暂断线（切后台、换网络）不立刻提示
    connTimer = setTimeout(() => {
      $('#conn').hidden = false;
      $('#conn').textContent = '正在重新连接 Mac…';
    }, 1500);
  }

  async function resync() {
    try {
      const st = await api('/api/state');
      S.boot = { ...S.boot, ...st };
      S.engine = new Map(st.engine.map(e => [e.sessionId, e]));
    } catch {}
    loadList(true);
    if (S.cur?.id) reloadCurrent();
    else renderAll();
  }

  function onEngine({ sessionId, state }) {
    if (state) S.engine.set(sessionId, state);
    else S.engine.delete(sessionId);
    const row = S.list.rows.get(sessionId);
    if (row) {
      row.engine = state ? { state: state.state, busy: state.busy, pending: state.pending.length } : null;
      renderListSoon();
    }
    if (S.cur?.id === sessionId) {
      if (!state?.busy) S.cur.partial = null;
      renderHeader();
      renderCards();
      renderLive();
      renderComposer();
      renderMessagesSoon();
    }
  }

  function onPartial({ sessionId, blocks }) {
    if (S.cur?.id !== sessionId) return;
    S.cur.partial = blocks;
    renderLiveSoon();
  }

  function onTranscript(d) {
    const c = S.cur;
    if (!c || c.id !== d.sessionId || c.loading) return;
    if (d.version <= c.version) return;
    if (d.prevVersion !== c.version) return reloadCurrent();
    if (d.order) {
      const first = c.order[0];
      const idx = first ? d.order.indexOf(first) : 0;
      if (idx < 0) return reloadCurrent();
      c.start = idx;
      c.order = d.order.slice(idx);
      const keep = new Set(c.order);
      for (const id of [...c.items.keys()]) if (!keep.has(id)) c.items.delete(id);
    }
    const known = new Set(c.order);
    for (const it of d.upserts.sort((a, b) => a.seq - b.seq)) {
      if (it.seq < c.start) continue;
      c.items.set(it.id, it);
      if (!known.has(it.id)) {
        c.order.push(it.id);
        known.add(it.id);
      }
    }
    c.version = d.version;
    c.total = d.total;
    S.optimistic = S.optimistic.filter(o => !c.items.has(o.id));
    renderMessages();
    renderLive();
  }

  function onSessions({ rows }) {
    const L = S.list;
    for (const row of rows) {
      L.rows.set(row.id, row);
      if (!L.order.includes(row.id) && matchesFilter(row)) L.order.push(row.id);
      if (S.cur?.id === row.id) {
        S.cur.meta = row;
        renderHeader();
        renderBanner();
        renderComposer();
      }
    }
    L.order.sort((a, b) => (L.rows.get(b)?.lastModified || 0) - (L.rows.get(a)?.lastModified || 0));
    renderListSoon();
  }

  function matchesFilter(row) {
    const L = S.list;
    if (L.source && row.source !== L.source) return false;
    if (L.q && !`${row.title}\n${row.cwd || ''}`.toLowerCase().includes(L.q.toLowerCase())) return false;
    return true;
  }

  // ---------- 对话列表 ----------
  async function loadList(reset) {
    const L = S.list;
    if (L.loading && !reset) return;
    L.loading = true;
    const token = (L.token = (L.token || 0) + 1);
    const offset = reset ? 0 : L.order.length;
    try {
      const r = await api(`/api/sessions?limit=50&offset=${offset}&q=${encodeURIComponent(L.q)}&source=${encodeURIComponent(L.source)}`);
      if (token !== L.token) return;
      if (reset) L.order = [];
      for (const row of r.rows) {
        L.rows.set(row.id, row);
        if (!L.order.includes(row.id)) L.order.push(row.id);
      }
      L.total = r.total;
    } catch (e) {
      if (e.status !== 401) toast(e.message);
    } finally {
      if (token === L.token) L.loading = false;
    }
    renderList();
    if (S.cur?.id && L.rows.has(S.cur.id) && !S.cur.meta) {
      S.cur.meta = L.rows.get(S.cur.id);
      renderHeader();
    }
  }

  function rowBadges(row) {
    const out = [];
    const eng = S.engine.get(row.id);
    const busy = eng ? eng.busy : row.live?.status === 'busy';
    const pending = eng ? eng.pending.length : 0;
    if (pending) out.push(h('span', { class: 'badge wait' }, '待确认'));
    else if (busy) out.push(h('span', { class: 'badge run' }, h('i', { class: 'dot pulse' }), '运行中'));
    if (SOURCE_LABEL[row.source]) out.push(h('span', { class: `badge ${row.source}` }, SOURCE_LABEL[row.source]));
    return out;
  }

  let listTimer;
  function renderListSoon() {
    if ($('#drawer').hidden) {
      S.list.dirty = true;
      return;
    }
    clearTimeout(listTimer);
    listTimer = setTimeout(renderList, 150);
  }

  function renderList() {
    S.list.dirty = false;
    const box = $('#session-list');
    const L = S.list;
    const rows = L.order.map(id => L.rows.get(id)).filter(Boolean).filter(matchesFilter);
    box.replaceChildren();
    if (!rows.length) {
      box.append(h('div', { class: 'list-empty' }, L.loading ? '加载中…' : L.q ? '没有找到' : '还没有对话'));
      return;
    }
    let group = null;
    for (const row of rows) {
      const g = dayGroup(row.lastModified);
      if (g !== group) {
        group = g;
        box.append(h('div', { class: 'group-label' }, g));
      }
      box.append(h('button', { class: `srow${S.cur?.id === row.id ? ' on' : ''}`, 'data-id': row.id },
        h('div', { class: 't' }, row.title || '未命名对话'),
        h('div', { class: 'm' }, ...rowBadges(row), h('span', { class: 'p' }, `${row.project || ''} · ${relTime(row.lastModified)}`))));
    }
    if (L.order.length < L.total) box.append(h('button', { class: 'ghost-btn list-more', 'data-act': 'more-sessions' }, L.loading ? '加载中…' : '加载更多'));
  }

  function renderFoot() {
    const b = S.boot;
    if (!b) return;
    const addr = b.addresses?.length ? b.addresses.map(a => `${a}:${b.port}`).join('、') : `端口 ${b.port}`;
    $('#drawer-foot').textContent = `Mac：${addr} · v${b.version}${S.es?.readyState === 1 ? ' · 实时连接中' : ''}`;
  }

  function openDrawer() {
    $('#drawer').hidden = false;
    $('#drawer-mask').hidden = false;
    renderFoot();
    renderList();
    loadList(true);
  }

  function closeDrawer() {
    $('#drawer').hidden = true;
    $('#drawer-mask').hidden = true;
    $('#search').blur();
  }

  // ---------- 打开对话 ----------
  function showNew() {
    S.openToken++;
    S.cur = { isNew: true, id: null, items: new Map(), order: [], start: 0, version: 0, meta: null, partial: null };
    localStorage.removeItem('cm.last');
    if (S.es?.readyState === 1) api('/api/subscribe', { method: 'POST', body: { client: S.clientId, sessionId: null } }).catch(() => {});
    restoreDraft();
    renderAll();
  }

  async function openSession(id, opts = {}) {
    closeDrawer();
    saveDraft();
    const token = ++S.openToken;
    S.cur = { id, loading: true, items: new Map(), order: [], start: 0, version: 0, meta: S.list.rows.get(id) || null, partial: null };
    if (!opts.keepOptimistic) S.optimistic = [];
    restoreDraft(id);
    renderAll();
    let r;
    try {
      r = await api(`/api/session?id=${encodeURIComponent(id)}&client=${encodeURIComponent(S.clientId)}`);
    } catch (e) {
      if (token === S.openToken) {
        if (e.status === 404) localStorage.removeItem('cm.last');
        toast(e.message);
        S.cur.loading = false;
        renderAll();
      }
      throw e;
    }
    if (token !== S.openToken) return;
    Object.assign(S.cur, { loading: false, meta: r.meta, version: r.version, start: r.start, total: r.total, partial: r.partial || null });
    for (const it of r.items) {
      S.cur.items.set(it.id, it);
      S.cur.order.push(it.id);
    }
    if (r.engine) S.engine.set(id, r.engine);
    S.optimistic = S.optimistic.filter(o => !S.cur.items.has(o.id));
    localStorage.setItem('cm.last', id);
    renderAll();
    scrollToBottom(true);
  }

  async function reloadCurrent() {
    const c = S.cur;
    if (!c?.id) return;
    const stick = nearBottom();
    const token = S.openToken;
    let r;
    try {
      r = await api(`/api/session?id=${encodeURIComponent(c.id)}&client=${encodeURIComponent(S.clientId)}`);
    } catch {
      return;
    }
    if (token !== S.openToken || S.cur !== c) return;
    c.items = new Map(r.items.map(it => [it.id, it]));
    c.order = r.items.map(it => it.id);
    Object.assign(c, { meta: r.meta, version: r.version, start: r.start, total: r.total, partial: r.partial || null });
    if (r.engine) S.engine.set(c.id, r.engine);
    else S.engine.delete(c.id);
    S.optimistic = S.optimistic.filter(o => !c.items.has(o.id));
    renderAll();
    if (stick) scrollToBottom(true);
  }

  async function loadOlder() {
    const c = S.cur;
    if (!c?.id || !c.start) return;
    const sc = $('#scroller');
    const before = sc.scrollHeight - sc.scrollTop;
    const btn = $('#btn-older');
    btn.disabled = true;
    btn.textContent = '加载中…';
    try {
      const r = await api(`/api/session/older?id=${encodeURIComponent(c.id)}&before=${c.start}`);
      if (S.cur !== c) return;
      if (r.version !== c.version) return reloadCurrent();
      for (const it of r.items) c.items.set(it.id, it);
      c.order = [...r.items.map(it => it.id), ...c.order];
      c.start = r.start;
      renderMessages(false);
      sc.scrollTop = sc.scrollHeight - before;
    } catch (e) {
      toast(e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '加载更早的消息';
      renderOlder();
    }
  }

  // ---------- 渲染：顶栏 / 横幅 ----------
  function isForeign(meta) {
    return !!meta && !S.engine.has(meta.id) && (meta.source === 'desktop' || meta.live?.by === 'desktop' || meta.live?.by === 'terminal');
  }

  function curBusy() {
    const c = S.cur;
    if (!c?.id) return false;
    const eng = S.engine.get(c.id);
    return eng ? eng.busy : c.meta?.live?.status === 'busy';
  }

  function renderHeader() {
    const c = S.cur;
    $('#title').textContent = c?.isNew ? '新对话' : c?.meta?.title || (c?.loading ? '加载中…' : 'Claude');
    const sub = $('#subtitle');
    sub.replaceChildren();
    if (c?.isNew) {
      sub.append(projectName(S.draft.cwd));
      return;
    }
    const m = c?.meta;
    if (!m) return;
    const eng = S.engine.get(m.id);
    if (eng?.pending.length) sub.append(h('span', { class: 'badge wait' }, '等你确认'));
    else if (curBusy()) sub.append(h('span', { class: 'badge run' }, h('i', { class: 'dot pulse' }), m.source === 'desktop' && !eng ? '电脑运行中' : '运行中'));
    if (SOURCE_LABEL[m.source]) sub.append(h('span', { class: `badge ${m.source}` }, SOURCE_LABEL[m.source]));
    sub.append(h('span', {}, m.project || ''));
  }

  function renderBanner() {
    const b = $('#banner');
    const m = S.cur?.meta;
    b.replaceChildren();
    b.hidden = true;
    if (!m || S.cur.isNew) return;
    let text = null;
    if (isForeign(m)) {
      const where = m.source === 'terminal' || m.live?.by === 'terminal' ? '终端' : '电脑 Claude 应用';
      text = `这是${where}里的对话，${m.live ? '正在实时同步显示' : '内容和电脑一致'}。手机发的消息会直接接在这条对话后面。电脑 App 里已经打开的这条对话不会自动刷新出手机的新内容，最好别两边同时发。`;
    } else if (m.forkedFrom) {
      text = '这条对话是从电脑上的对话复制过来的，之后的内容只在手机这边（电脑浏览器打开这个网页也能看到）。';
    }
    if (!text) return;
    b.hidden = false;
    b.className = 'banner';
    b.innerHTML = ICON.info;
    b.append(h('span', {}, text));
  }

  function renderOlder() {
    const c = S.cur;
    $('#older-wrap').hidden = !(c && !c.loading && c.start > 0);
  }

  function renderEmpty() {
    const c = S.cur;
    const e = $('#empty');
    const show = c?.isNew || (c && !c.loading && !c.order.length && !S.optimistic.length && !curBusy());
    e.hidden = !show;
    if (!show) return;
    e.replaceChildren(
      h('img', { src: '/icons/icon-192.png', alt: '' }),
      h('h2', {}, c.isNew ? '新对话' : '这条对话还没有内容'),
      h('p', {}, c.isNew ? `会在「${projectName(S.draft.cwd)}」里运行，用的是这台 Mac 上的 Claude Code。` : '发一条消息开始。'),
      c.isNew ? h('button', { class: 'chip-btn', 'data-act': 'new-sheet' }, `目录：${displayPath(S.draft.cwd)} ›`) : null,
      c.isNew ? h('p', { style: 'margin-top:18px;font-size:13px;color:var(--text-3)' }, '电脑上的对话在左上角列表里，打开后实时同步显示。') : null,
    );
  }

  // ---------- 渲染：消息 ----------
  const sc = () => $('#scroller');
  function nearBottom() {
    const s = sc();
    return s.scrollHeight - s.scrollTop - s.clientHeight < 140;
  }

  function scrollToBottom(force) {
    const s = sc();
    requestAnimationFrame(() => {
      s.scrollTop = s.scrollHeight;
      if (force) setTimeout(() => { s.scrollTop = s.scrollHeight; }, 80);
    });
    $('#jump').hidden = true;
    $('#jump').classList.remove('new');
  }

  function isStep(it) {
    return (it.kind === 'tool' && it.name !== 'mcp__ccd_turn__wrap_up') || it.kind === 'thinking';
  }

  function buildUnits(c) {
    const units = [];
    let group = null;
    for (const id of c.order) {
      const it = c.items.get(id);
      if (!it) continue;
      if (isStep(it)) {
        if (!group) {
          group = { key: `g:${it.id}`, kind: 'steps', items: [] };
          units.push(group);
        }
        group.items.push(it);
      } else {
        group = null;
        units.push({ key: it.id, kind: it.kind === 'tool' ? 'recap' : it.kind, item: it });
      }
    }
    return units;
  }

  function unitSig(u, busy) {
    if (u.kind !== 'steps') return hash(JSON.stringify(u.item));
    const parts = u.items.map(it => `${it.id}|${it.status || ''}|${it.resultLength || 0}|${(it.text || it.summary || '').length}|${S.expanded.has(`s:${it.id}`) ? 1 : 0}|${S.full.has(it.toolUseId) ? 1 : 0}`);
    return hash(`${parts.join(',')}#${S.expanded.has(u.key) ? 1 : 0}#${busy ? 1 : 0}`);
  }

  function statusIcon(it, busy) {
    if (it.kind === 'thinking') return h('span', { class: 'status-ico pending', html: ICON.dot });
    if (it.status === 'error') return h('span', { class: 'status-ico error', html: ICON.error });
    if (it.status === 'pending') return busy ? h('span', { class: 'status-ico' }, h('span', { class: 'spinner' })) : h('span', { class: 'status-ico pending', html: ICON.dot });
    return h('span', { class: 'status-ico done', html: ICON.check });
  }

  function thumbs(images, cls) {
    return h('div', { class: cls }, images.map(img => h('img', { src: img.src, alt: '', loading: 'lazy', 'data-full': img.src })));
  }

  function renderUser(it) {
    const n = h('div', { class: 'msg user' });
    if (it.images?.length) n.append(thumbs(it.images, 'thumbs'));
    for (const f of it.files || []) n.append(f.url ? h('a', { class: 'file-chip', href: f.url, target: '_blank', rel: 'noopener', html: ICON.file }, f.name) : h('span', { class: 'file-chip', html: ICON.file }, f.name));
    if (it.text) n.append(h('div', { class: 'bubble' }, linkified(it.text)));
    if (it.ts) n.append(h('div', { class: 'msg-meta' }, relTime(it.ts)));
    return n;
  }

  function stepDetail(it) {
    const d = h('div', { class: 'step-detail' });
    if (it.kind === 'thinking') {
      d.append(h('div', { class: 'thinking-text' }, it.text));
      return d;
    }
    if (it.detail) d.append(h('div', { class: 'k' }, it.detail));
    if (it.code) d.append(h('div', { class: 'k' }, it.name === 'Bash' ? '命令' : '内容'), h('pre', { class: 'pre' }, it.code));
    if (it.diff) d.append(h('div', { class: 'k' }, '修改前'), h('pre', { class: 'pre diff-old' }, it.diff.old || ''), h('div', { class: 'k' }, '修改后'), h('pre', { class: 'pre diff-new' }, it.diff.new || ''));
    if (it.todos) d.append(todoList(it.todos));
    if (it.questions) for (const q of it.questions) d.append(h('div', { class: 'k' }, q.header || '问题'), h('div', {}, q.question), h('div', { class: 'k' }, q.options.map(o => o.label).join(' / ')));
    if (it.plan) d.append(markdown(it.plan));
    if (it.note) d.append(h('div', { style: 'white-space:pre-wrap' }, it.note));
    const full = S.full.get(it.toolUseId);
    if (full || it.result) {
      d.append(h('div', { class: 'k' }, it.status === 'error' ? '出错' : '输出'), h('pre', { class: `pre${it.status === 'error' ? ' err' : ''}` }, full || it.result));
      if (!full && it.resultTruncated) d.append(h('button', { class: 'more-btn', 'data-act': 'full', 'data-tool': it.toolUseId }, `显示全部输出（共 ${it.resultLength} 字）`));
    }
    if (it.images?.length) d.append(thumbs(it.images, 'tool-images'));
    if (d.childElementCount === 0) d.append(h('div', { class: 'k' }, it.status === 'pending' ? '还没有结果' : '没有输出'));
    return d;
  }

  function todoList(todos) {
    return h('ul', { class: 'todos' }, todos.map(t => h('li', { class: t.status }, h('span', { class: 'box' }), h('span', {}, t.text))));
  }

  function renderSteps(u, busy) {
    const open = S.expanded.has(u.key);
    const last = u.items[u.items.length - 1];
    const tools = u.items.filter(it => it.kind === 'tool');
    const anyErr = tools.some(it => it.status === 'error');
    const running = busy && tools.some(it => it.status === 'pending');
    const headIco = running ? h('span', { class: 'status-ico' }, h('span', { class: 'spinner' })) : anyErr ? h('span', { class: 'status-ico error', html: ICON.error }) : h('span', { class: 'status-ico done', html: ICON.check });
    const lastText = last.kind === 'thinking' ? '思考' : `${last.label}${last.summary ? ` · ${last.summary}` : ''}`;
    const n = h('div', { class: `steps${open ? ' open' : ''}` },
      h('button', { class: 'steps-head', 'data-act': 'toggle', 'data-key': u.key, html: ICON.chev },
        headIco,
        h('span', { class: 'count' }, tools.length ? `${tools.length} 个步骤` : '思考'),
        h('span', { class: 'last' }, lastText)));
    if (open) {
      const body = h('div', { class: 'steps-body' });
      for (const it of u.items) {
        const key = `s:${it.id}`;
        const sopen = S.expanded.has(key);
        body.append(h('div', { class: 'step' },
          h('button', { class: 'step-row', 'data-act': 'toggle', 'data-key': key },
            statusIcon(it, busy),
            h('span', { class: 'label' }, it.kind === 'thinking' ? '思考' : it.label),
            h('span', { class: 'sum' }, it.kind === 'thinking' ? (it.text || '').split('\n')[0] : it.summary || '')),
          sopen ? stepDetail(it) : null));
      }
      n.append(body);
    }
    return n;
  }

  function renderUnit(u, busy) {
    const it = u.item;
    switch (u.kind) {
      case 'user': return renderUser(it);
      case 'assistant':
        return h('div', { class: 'msg assistant' }, markdown(it.text), h('div', { class: 'msg-actions' }, h('button', { 'data-act': 'copy', 'data-id': it.id }, '复制')));
      case 'notice': {
        const collapsed = it.collapsed && !S.expanded.has(it.id);
        return h('div', { class: `notice${it.mono ? ' mono' : ''}${collapsed ? ' collapsed' : ''}`, 'data-act': it.collapsed ? 'toggle' : null, 'data-key': it.collapsed ? it.id : null }, h('span', {}, it.text));
      }
      case 'command': return h('div', { class: 'command' }, it.text);
      case 'recap': return h('div', { class: 'recap' }, h('div', { class: 'k' }, it.label || '小结'), it.note || it.summary || '');
      case 'steps': return renderSteps(u, busy);
      default: return h('div', { class: 'notice' }, h('span', {}, it?.text || ''));
    }
  }

  let msgRaf = null;
  function renderMessagesSoon() {
    if (msgRaf) return;
    msgRaf = requestAnimationFrame(() => {
      msgRaf = null;
      renderMessages();
    });
  }

  function renderMessages(autoScroll = true) {
    const c = S.cur;
    const box = $('#messages');
    const stick = autoScroll && nearBottom();
    const busy = curBusy();
    const units = c && !c.isNew ? buildUnits(c) : [];
    const existing = new Map([...box.children].map(n => [n.dataset.key, n]));
    let prev = null;
    let added = false;
    for (const u of units) {
      const sig = unitSig(u, busy);
      let node = existing.get(u.key);
      if (!node || node.dataset.sig !== sig) {
        const fresh = renderUnit(u, busy);
        fresh.dataset.key = u.key;
        fresh.dataset.sig = sig;
        if (node) node.replaceWith(fresh);
        else added = true;
        node = fresh;
      }
      existing.delete(u.key);
      const want = prev ? prev.nextSibling : box.firstChild;
      if (node !== want) box.insertBefore(node, want);
      prev = node;
    }
    for (const n of existing.values()) n.remove();
    renderOlder();
    renderEmpty();
    if (stick) scrollToBottom();
    else if (added && autoScroll) {
      $('#jump').hidden = false;
      $('#jump').classList.add('new');
    }
  }

  // ---------- 渲染：正在进行 ----------
  let liveRaf = null;
  function renderLiveSoon() {
    if (liveRaf) return;
    liveRaf = setTimeout(() => {
      liveRaf = null;
      renderLive();
    }, 90);
  }

  function renderLive() {
    const c = S.cur;
    const box = $('#live');
    const stick = nearBottom();
    box.replaceChildren();
    if (!c) return;
    for (const o of S.optimistic) {
      if (o.sessionId !== (c.id || null)) continue;
      const n = h('div', { class: 'msg user optimistic' });
      if (o.images.length) n.append(thumbs(o.images.map(src => ({ src })), 'thumbs'));
      for (const f of o.files) n.append(h('span', { class: 'file-chip', html: ICON.file }, f));
      if (o.text) n.append(h('div', { class: 'bubble' }, o.text));
      n.append(h('div', { class: 'msg-meta' }, '发送中…'));
      box.append(n);
    }
    const eng = c.id ? S.engine.get(c.id) : null;
    const busy = curBusy() || S.optimistic.some(o => o.sessionId === (c.id || null));
    if (!busy) {
      if (stick) scrollToBottom();
      return;
    }
    let showedText = false;
    for (const b of c.partial || []) {
      if (b.type === 'text' && b.text) {
        box.append(h('div', { class: 'msg assistant' }, markdown(b.text)));
        showedText = true;
      } else if (b.type === 'thinking' && b.text) {
        box.append(h('div', { class: 'live-thinking' }, b.text.slice(-400)));
      } else if (b.type === 'tool') {
        box.append(h('div', { class: 'live-tool' }, h('span', { class: 'spinner' }), h('span', {}, `准备 ${b.name || '工具'}`), h('code', {}, (b.text || '').slice(-120))));
      }
    }
    if (!showedText && !eng?.pending.length) {
      let label = 'Claude 正在思考';
      if (!eng && c.meta?.live?.status === 'busy') label = '电脑上的 Claude 正在工作';
      else if (eng?.status === 'compacting') label = '正在压缩上下文';
      else if (eng?.retry) label = `${eng.retry.error}，第 ${eng.retry.attempt} 次重试`;
      else if (eng?.toolProgress) label = `${eng.toolProgress.name} 已运行 ${duration(eng.toolProgress.seconds * 1000)}`;
      box.append(h('div', { class: 'typing' }, h('span', { class: 'dots' }, h('i'), h('i'), h('i')), h('span', {}, label)));
    }
    if (stick) scrollToBottom();
  }

  // ---------- 待处理：权限 / 提问 / 计划 ----------
  function renderCards() {
    const box = $('#cards');
    const c = S.cur;
    const eng = c?.id ? S.engine.get(c.id) : null;
    const pending = eng?.pending || [];
    const ids = new Set(pending.map(p => p.id));
    for (const n of [...box.children]) if (!ids.has(n.dataset.req)) n.remove();
    for (const p of pending) {
      if (box.querySelector(`[data-req="${CSS.escape(p.id)}"]`)) continue;
      box.append(p.kind === 'question' ? questionCard(p) : p.kind === 'plan' ? planCard(p) : permissionCard(p));
    }
  }

  async function answer(card, p, body) {
    if (S.answering.has(p.id)) return;
    S.answering.add(p.id);
    for (const b of card.querySelectorAll('button')) b.disabled = true;
    try {
      await api('/api/answer', { method: 'POST', body: { sessionId: S.cur.id, requestId: p.id, ...body } });
      card.remove();
    } catch (e) {
      toast(e.message);
      for (const b of card.querySelectorAll('button')) b.disabled = false;
    } finally {
      S.answering.delete(p.id);
    }
  }

  function preview(p) {
    const out = [];
    if (p.code) out.push(h('pre', { class: 'pre' }, p.code));
    if (p.diff) out.push(h('pre', { class: 'pre diff-old' }, p.diff.old || ''), h('pre', { class: 'pre diff-new', style: 'margin-top:4px' }, p.diff.new || ''));
    return out;
  }

  function permissionCard(p) {
    const card = h('div', { class: 'card', 'data-req': p.id });
    const title = p.title || `允许 Claude ${p.label || p.displayName || p.toolName}？`;
    const sub = [p.summary, p.blockedPath && `涉及：${p.blockedPath}`, p.reason, p.description].filter(Boolean).join(' · ');
    const reason = h('input', { type: 'text', placeholder: '拒绝理由（可选，会告诉 Claude）', hidden: true });
    const yes = h('button', { class: p.defaultToNo ? '' : 'yes', onclick: () => answer(card, p, { decision: 'allow' }) }, '允许');
    const always = p.canAlways ? h('button', { onclick: () => answer(card, p, { decision: 'always' }) }, '本次会话都允许') : null;
    const no = h('button', { class: 'no', onclick: () => {
      if (reason.hidden) {
        reason.hidden = false;
        no.textContent = '确认拒绝';
        reason.focus();
        return;
      }
      answer(card, p, { decision: 'deny', message: reason.value });
    } }, '拒绝');
    card.append(h('div', { class: 'card-title' }, title), sub ? h('div', { class: 'card-sub' }, sub) : null, ...preview(p), reason,
      h('div', { class: 'card-actions' }, ...(p.defaultToNo ? [no, yes, always] : [yes, always, no])));
    return card;
  }

  function questionCard(p) {
    const card = h('div', { class: 'card', 'data-req': p.id });
    const picks = p.questions.map(() => new Set());
    const others = [];
    card.append(h('div', { class: 'card-title' }, 'Claude 想问你'));
    p.questions.forEach((q, qi) => {
      const block = h('div', { class: 'q-block' }, q.header ? h('div', { class: 'q-head' }, q.header) : null, h('div', { class: 'q-text' }, q.question));
      const optNodes = q.options.map((o, oi) => {
        const n = h('button', { class: `q-opt${q.multiSelect ? ' multi' : ''}`, onclick: () => {
          const set = picks[qi];
          if (q.multiSelect) set.has(oi) ? set.delete(oi) : set.add(oi);
          else {
            set.clear();
            set.add(oi);
            others[qi].value = '';
          }
          optNodes.forEach((x, k) => x.classList.toggle('on', set.has(k)));
        } }, h('span', { class: 'mark' }), h('span', {}, h('div', {}, o.label), o.description ? h('div', { class: 'd' }, o.description) : null));
        return n;
      });
      const other = h('input', { type: 'text', placeholder: '其他（自己填写）', oninput: () => {
        if (!q.multiSelect && other.value) {
          picks[qi].clear();
          optNodes.forEach(x => x.classList.remove('on'));
        }
      } });
      others[qi] = other;
      block.append(...optNodes, other);
      card.append(block);
    });
    card.append(h('div', { class: 'card-actions' },
      h('button', { class: 'yes', onclick: () => {
        const answers = {};
        p.questions.forEach((q, qi) => {
          const chosen = [...picks[qi]].sort().map(i => q.options[i].label);
          if (others[qi].value.trim()) chosen.push(others[qi].value.trim());
          if (chosen.length) answers[q.question] = chosen.join(', ');
        });
        if (Object.keys(answers).length < p.questions.length) return toast('还有问题没回答');
        answer(card, p, { decision: 'allow', answers });
      } }, '提交回答'),
      h('button', { onclick: () => answer(card, p, { decision: 'deny' }) }, '跳过')));
    return card;
  }

  function planCard(p) {
    const card = h('div', { class: 'card', 'data-req': p.id });
    let mode = 'auto';
    const seg = h('div', { class: 'efforts', style: 'margin-top:8px' });
    const modes = [['auto', '自动审批'], ['acceptEdits', '接受编辑'], ['default', '每次询问']];
    const paint = () => [...seg.children].forEach((b, i) => b.classList.toggle('on', modes[i][0] === mode));
    for (const [k, label] of modes) seg.append(h('button', { onclick: () => { mode = k; paint(); } }, label));
    paint();
    const fb = h('textarea', { rows: 2, placeholder: '想怎么改？（会发给 Claude）', hidden: true });
    const revise = h('button', { onclick: () => {
      if (fb.hidden) {
        fb.hidden = false;
        revise.textContent = '发送修改意见';
        fb.focus();
        return;
      }
      answer(card, p, { decision: 'deny', message: fb.value });
    } }, '继续修改');
    card.append(h('div', { class: 'card-title' }, 'Claude 写好了计划，批准后开始执行'),
      p.plan ? h('div', { class: 'card-plan' }, markdown(p.plan)) : null,
      h('div', { class: 'card-sub', style: 'margin:10px 0 0' }, '批准后的权限：'), seg, fb,
      h('div', { class: 'card-actions' }, h('button', { class: 'yes', onclick: () => answer(card, p, { decision: 'allow', mode }) }, '批准并开始'), revise));
    return card;
  }

  // ---------- 输入框 ----------
  function settingsFor(c) {
    const eng = c?.id ? S.engine.get(c.id) : null;
    if (eng) return { model: eng.model, effort: eng.effort, permissionMode: eng.permissionMode };
    return { ...S.draft, ...(c?.id ? S.sessionSettings.get(c.id) || {} : {}) };
  }

  function modelLabel(v) {
    return S.boot?.models.find(m => m.value === v)?.label || v || '默认模型';
  }

  function renderComposer() {
    const c = S.cur;
    const eng = c?.id ? S.engine.get(c.id) : null;
    const input = $('#input');
    input.placeholder = c?.isNew ? `新对话 · ${projectName(S.draft.cwd)}` : eng?.busy ? '补充要求，Claude 会接着看到' : '给 Claude 发消息';
    $('#btn-stop').hidden = !eng?.busy;
    updateSend();
    renderStatus();
  }

  function renderStatus() {
    const c = S.cur;
    const line = $('#statusline');
    const eng = c?.id ? S.engine.get(c.id) : null;
    const st = settingsFor(c);
    const parts = [`模型 ${modelLabel(st.model)}`, `思考强度 ${EFFORT_LABEL[st.effort] || st.effort || '默认'}`, MODE_LABEL[st.permissionMode] || st.permissionMode];
    line.replaceChildren(parts.join(' · '));
    if (eng?.error && !eng.busy) line.append(' · ', h('span', { class: 'err' }, eng.error));
    else if (eng?.retry && eng.busy) line.append(' · ', h('span', { class: 'warn' }, `${eng.retry.error}，重试中`));
    else if (eng?.busy && eng.turnStartedAt) line.append(` · 已运行 ${duration(Date.now() - eng.turnStartedAt)}`);
    else if (eng?.lastResult && !eng.busy && eng.lastResult.cost) line.append(` · 上一轮 $${eng.lastResult.cost.toFixed(3)}`);
  }

  function tick() {
    const eng = S.cur?.id ? S.engine.get(S.cur.id) : null;
    if (eng?.busy) renderStatus();
  }

  function updateSend() {
    const hasText = $('#input').value.trim().length > 0;
    const ready = S.atts.some(a => a.status === 'ready');
    const uploading = S.atts.some(a => a.status === 'uploading');
    $('#btn-send').disabled = uploading || (!hasText && !ready);
  }

  function autosize() {
    const t = $('#input');
    t.style.height = 'auto';
    t.style.height = `${Math.min(t.scrollHeight, 168)}px`;
  }

  function draftKey(id) {
    return `cm.draft.${id || 'new'}`;
  }

  function saveDraft() {
    const key = draftKey(S.cur?.id);
    const v = $('#input').value;
    if (v) sessionStorage.setItem(key, v);
    else sessionStorage.removeItem(key);
  }

  function restoreDraft(id) {
    $('#input').value = sessionStorage.getItem(draftKey(id)) || '';
    autosize();
    updateSend();
  }

  function renderAtts() {
    const box = $('#attach-list');
    box.hidden = !S.atts.length;
    box.replaceChildren(...S.atts.map(a => h('div', { class: `att${a.status === 'error' ? ' error' : ''}` },
      a.preview ? h('img', { src: a.preview, alt: '' }) : h('div', { class: 'name' }, a.name),
      a.status === 'uploading' ? h('div', { class: 'bar', style: `width:${Math.round((a.progress || 0) * 100)}%` }) : null,
      h('button', { class: 'x', 'aria-label': '移除', onclick: () => removeAtt(a) }, '×'))));
  }

  function removeAtt(a) {
    a.xhr?.abort();
    if (a.preview) URL.revokeObjectURL(a.preview);
    S.atts = S.atts.filter(x => x !== a);
    renderAtts();
    updateSend();
  }

  function addFiles(files) {
    for (const f of files) {
      if (S.atts.length >= 8) {
        toast('每条消息最多 8 个附件');
        break;
      }
      if (f.size > 16 * MB) {
        toast(`${f.name} 超过 16 MB`);
        continue;
      }
      const total = S.atts.reduce((n, a) => n + (a.size || 0), 0) + f.size;
      if (total > 40 * MB) {
        toast('附件总共不能超过 40 MB');
        break;
      }
      const isImg = /^image\//.test(f.type);
      const a = { name: f.name || (isImg ? 'photo.jpg' : 'file'), size: f.size, kind: isImg ? 'image' : 'file', status: 'uploading', progress: 0, preview: isImg ? URL.createObjectURL(f) : null };
      S.atts.push(a);
      upload(a, f);
    }
    renderAtts();
    updateSend();
  }

  function upload(a, f) {
    const xhr = new XMLHttpRequest();
    a.xhr = xhr;
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('x-file-name', encodeURIComponent(a.name));
    xhr.setRequestHeader('content-type', f.type || 'application/octet-stream');
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) {
        a.progress = e.loaded / e.total;
        const bar = $('#attach-list').children[S.atts.indexOf(a)]?.querySelector('.bar');
        if (bar) bar.style.width = `${Math.round(a.progress * 100)}%`;
      }
    };
    xhr.onload = () => {
      let j = null;
      try { j = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 200 && j?.id) Object.assign(a, { id: j.id, status: 'ready', kind: j.kind, url: j.url, name: j.name });
      else {
        a.status = 'error';
        if (xhr.status === 401) showPair();
        toast(j?.error || `上传失败（${xhr.status}）`);
      }
      a.xhr = null;
      renderAtts();
      updateSend();
    };
    xhr.onerror = () => {
      a.status = 'error';
      a.xhr = null;
      toast('上传失败，检查网络');
      renderAtts();
      updateSend();
    };
    xhr.send(f);
  }

  async function send(extra = {}) {
    if (S.atts.some(a => a.status === 'uploading')) return toast('附件还在上传…');
    const input = $('#input');
    const text = input.value;
    const atts = S.atts.filter(a => a.status === 'ready');
    if (!text.trim() && !atts.length) return;
    const c = S.cur;
    const body = { text, attachments: atts.map(a => a.id), clientMessageId: uuid(), ...settingsFor(c), ...extra };
    if (c?.id) body.sessionId = c.id;
    else body.cwd = S.draft.cwd;
    const opt = {
      id: body.clientMessageId,
      sessionId: extra.fork ? null : c?.id || null,
      text: text.trim(),
      images: atts.filter(a => a.kind === 'image').map(a => a.url),
      files: atts.filter(a => a.kind !== 'image').map(a => a.name),
    };
    const keepAtts = S.atts;
    S.optimistic.push(opt);
    input.value = '';
    sessionStorage.removeItem(draftKey(c?.id));
    S.atts = [];
    autosize();
    renderAtts();
    updateSend();
    renderLive();
    renderEmpty();
    scrollToBottom();
    try {
      const r = await api('/api/send', { method: 'POST', body });
      if (!c?.id || r.sessionId !== c.id) {
        opt.sessionId = r.sessionId;
        await openSession(r.sessionId, { keepOptimistic: true });
        loadList(true);
      }
    } catch (e) {
      S.optimistic = S.optimistic.filter(o => o !== opt);
      if (!input.value) input.value = text;
      if (!S.atts.length) S.atts = keepAtts;
      autosize();
      renderAtts();
      updateSend();
      renderLive();
      renderEmpty();
      if (e.status === 409 && e.data?.code === 'fork_required') return confirmFork();
      toast(e.message, 4000);
    }
  }

  function confirmFork() {
    const m = S.cur?.meta;
    const where = m?.source === 'terminal' || m?.live?.by === 'terminal' ? '终端' : '电脑 Claude 应用';
    openSheet([
      h('h3', {}, '在手机上继续这条对话？'),
      h('p', { class: 'note' }, `这条对话在${where}里，由电脑那边的 Claude 进程负责，手机不能直接往里插话。`),
      h('p', { class: 'note' }, '继续的话，会复制完整历史开一条新的手机对话（标题后面带“（手机）”），Claude 记得之前的所有内容。电脑上的原对话不受影响；之后两边各走各的。'),
      h('button', { class: 'primary-btn', onclick: () => { closeSheet(); send({ fork: true }); } }, '复制并继续'),
      h('button', { class: 'secondary-btn', onclick: closeSheet }, '取消'),
    ]);
  }

  async function stop() {
    const c = S.cur;
    if (!c?.id) return;
    $('#btn-stop').disabled = true;
    try {
      await api('/api/stop', { method: 'POST', body: { sessionId: c.id } });
    } catch (e) {
      toast(e.message);
    } finally {
      $('#btn-stop').disabled = false;
    }
  }

  // ---------- 底部面板 ----------
  function openSheet(children) {
    const s = $('#sheet');
    s.replaceChildren(h('div', { class: 'sheet-grip' }), ...children);
    s.hidden = false;
    $('#sheet-mask').hidden = false;
    s.scrollTop = 0;
  }

  function closeSheet() {
    $('#sheet').hidden = true;
    $('#sheet-mask').hidden = true;
  }

  function optList(items, current, onPick) {
    return h('div', { class: 'opt-list' }, items.map(it => h('button', { class: `opt${it.value === current ? ' on' : ''}`, onclick: () => onPick(it.value) },
      h('div', { class: 'main' }, h('div', { class: 'n' }, it.label), it.note ? h('div', { class: 'd' }, it.note) : null),
      h('span', { class: 'tick', html: ICON.check }))));
  }

  function openSettings() {
    const c = S.cur;
    const eng = c?.id ? S.engine.get(c.id) : null;
    const foreign = isForeign(c?.meta);
    const st = settingsFor(c);
    let saveDefault = false;
    const apply = async patch => {
      const next = { ...st, ...patch };
      Object.assign(st, patch);
      try {
        if (eng) {
          const r = await api('/api/configure', { method: 'POST', body: { sessionId: c.id, ...next, saveDefault } });
          if (r.engine) S.engine.set(c.id, r.engine);
        } else if (c?.id && !c.isNew) {
          S.sessionSettings.set(c.id, next);
          if (saveDefault) await api('/api/configure', { method: 'POST', body: { ...next } });
        } else {
          Object.assign(S.draft, patch);
          if (saveDefault) await api('/api/configure', { method: 'POST', body: { ...S.draft } });
        }
        if (saveDefault) S.boot.defaults = { ...S.boot.defaults, ...next };
      } catch (e) {
        toast(e.message);
      }
      renderComposer();
      openSettings.redraw();
    };
    const draw = () => {
      const kids = [h('h3', {}, c?.isNew ? '新对话设置' : '对话设置')];
      if (c?.meta && !c.isNew) {
        const m = c.meta;
        kids.push(h('div', { class: 'kv' },
          h('div', {}, m.title),
          h('div', {}, `${SOURCE_LABEL[m.source] || '其他'}对话 · ${m.project} · ${displayPath(m.cwd)}`),
          m.live ? h('div', {}, `电脑上${m.live.status === 'busy' ? '正在运行' : '开着'}`) : null,
          h('div', {}, `更新于 ${relTime(m.lastModified)}`)));
        if (m.source === 'mobile') kids.push(h('button', { class: 'secondary-btn', onclick: rename }, '重命名'));
      }
      if (foreign) kids.push(h('p', { class: 'note' }, '这是电脑上的对话。下面的设置会用在你从手机继续时复制出的新对话上。'));
      kids.push(h('div', { class: 'sec' }, '模型'), optList(S.boot.models.map(m => ({ value: m.value, label: m.label, note: m.note })), st.model, v => apply({ model: v })));
      kids.push(h('div', { class: 'sec' }, '思考深度'), h('div', { class: 'efforts' }, S.boot.efforts.map(e => h('button', { class: e === st.effort ? 'on' : '', onclick: () => apply({ effort: e }) }, EFFORT_LABEL[e] || e))));
      kids.push(h('div', { class: 'sec' }, '权限'), optList(S.boot.modes.map(v => ({ value: v, label: MODE_LABEL[v] || v, note: MODE_DESC[v] })), st.permissionMode, v => apply({ permissionMode: v })));
      const sw = h('input', { type: 'checkbox', onchange: () => { saveDefault = sw.checked; if (saveDefault) apply({}); } });
      sw.checked = saveDefault;
      kids.push(h('div', { class: 'sec' }, '默认值'), h('label', { class: 'row-toggle' }, h('span', {}, '以后的新对话也用这些设置'), h('span', { class: 'switch' }, sw, h('span'))));
      const exp = h('input', { type: 'checkbox', onchange: () => { S.prefs.expandSteps = exp.checked; localStorage.setItem('cm.prefs', JSON.stringify(S.prefs)); } });
      exp.checked = !!S.prefs.expandSteps;
      kids.push(h('div', { class: 'sec' }, '显示'), h('label', { class: 'row-toggle' }, h('span', {}, '新的工具步骤默认展开'), h('span', { class: 'switch' }, exp, h('span'))));
      kids.push(h('div', { class: 'sec' }, '连接'), h('div', { class: 'kv' },
        h('div', {}, `Mac 地址：${(S.boot.addresses || []).map(a => `http://${a}:${S.boot.port}/`).join('  ') || '仅本机'}`),
        h('div', {}, `版本 ${S.boot.version} · ${S.es?.readyState === 1 ? '实时连接正常' : '正在重连'}`)));
      kids.push(h('button', { class: 'secondary-btn', onclick: closeSheet }, '完成'));
      openSheet(kids);
    };
    openSettings.redraw = draw;
    draw();
  }

  async function rename() {
    const c = S.cur;
    const title = prompt('新的对话标题', c?.meta?.title || '');
    if (!title || !title.trim()) return;
    try {
      await api('/api/rename', { method: 'POST', body: { sessionId: c.id, title: title.trim() } });
      c.meta.title = title.trim();
      renderHeader();
      closeSheet();
    } catch (e) {
      toast(e.message);
    }
  }

  function openNewSheet() {
    let custom = null;
    const pick = cwd => {
      S.draft.cwd = cwd;
      closeSheet();
      closeDrawer();
      saveDraft();
      showNew();
      $('#input').focus();
    };
    const kids = [h('h3', {}, '新对话'), h('div', { class: 'sec' }, '在哪个目录里工作')];
    kids.push(optList(S.boot.projects.map(p => ({ value: p.cwd, label: p.name, note: p.display })), S.cur?.isNew ? S.draft.cwd : null, pick));
    custom = h('input', { type: 'text', placeholder: '其他目录，例如 ~/Projects/app', autocapitalize: 'off', spellcheck: 'false' });
    kids.push(h('div', { class: 'sec' }, '其他目录'), custom,
      h('button', { class: 'primary-btn', onclick: () => {
        const v = custom.value.trim();
        if (v) {
          const p = v.startsWith('~') ? expandHome(v) : v;
          if (!p.startsWith('/')) return toast('请输入完整路径（以 / 或 ~ 开头）');
          return pick(p);
        }
        pick(S.draft.cwd);
      } }, '开始新对话'),
      h('button', { class: 'secondary-btn', onclick: closeSheet }, '取消'));
    openSheet(kids);
  }

  // ---------- 整体 ----------
  function renderAll() {
    renderHeader();
    renderBanner();
    renderMessages();
    renderLive();
    renderCards();
    renderComposer();
    renderEmpty();
    renderOlder();
    if (!$('#drawer').hidden) renderList();
  }

  function fitViewport() {
    const vv = window.visualViewport;
    const height = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-h', `${height}px`);
    document.body.classList.toggle('kb-open', !!vv && window.innerHeight - vv.height > 120);
    if (window.scrollY) window.scrollTo(0, 0);
  }

  function bindUI() {
    if (bindUI.done) return;
    bindUI.done = true;
    window.visualViewport?.addEventListener('resize', () => {
      const stick = nearBottom();
      fitViewport();
      if (stick) scrollToBottom();
    });
    window.visualViewport?.addEventListener('scroll', fitViewport);
    window.addEventListener('resize', fitViewport);

    $('#btn-menu').onclick = openDrawer;
    $('#drawer-mask').onclick = closeDrawer;
    $('#sheet-mask').onclick = closeSheet;
    $('#btn-new').onclick = openNewSheet;
    $('#btn-drawer-new').onclick = openNewSheet;
    $('#btn-more').onclick = openSettings;
    $('#title-wrap').onclick = openSettings;
    $('#statusline').onclick = openSettings;
    $('#btn-older').onclick = loadOlder;
    $('#jump').onclick = () => scrollToBottom(true);
    $('#btn-send').onclick = () => send();
    $('#btn-stop').onclick = stop;
    $('#btn-attach').onclick = () => $('#file-input').click();
    $('#file-input').onchange = e => {
      addFiles([...e.target.files]);
      e.target.value = '';
    };
    $('#pair-btn').onclick = onPairClick;
    $('#pair-input').addEventListener('keydown', e => { if (e.key === 'Enter') onPairClick(); });
    $('#lightbox').onclick = () => { $('#lightbox').hidden = true; };

    const input = $('#input');
    let draftTimer;
    input.addEventListener('input', () => {
      autosize();
      updateSend();
      clearTimeout(draftTimer);
      draftTimer = setTimeout(saveDraft, 400);
    });
    // 回车换行；电脑键盘 Cmd/Ctrl + Enter 发送
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        send();
      }
    });
    input.addEventListener('paste', e => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.length) {
        e.preventDefault();
        addFiles(files);
      }
    });
    document.addEventListener('dragover', e => e.preventDefault());
    document.addEventListener('drop', e => {
      e.preventDefault();
      if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]);
    });

    let searchTimer;
    $('#search').addEventListener('input', e => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        S.list.q = e.target.value.trim();
        loadList(true);
      }, 250);
    });
    $('#source-filter').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      S.list.source = b.dataset.source;
      for (const x of $('#source-filter').children) x.classList.toggle('on', x === b);
      loadList(true);
    });
    $('#session-list').addEventListener('click', e => {
      const row = e.target.closest('.srow');
      if (row) openSession(row.dataset.id).catch(() => {});
      else if (e.target.closest('[data-act="more-sessions"]')) loadList(false);
    });

    const scroller = $('#scroller');
    scroller.addEventListener('scroll', () => {
      document.querySelector('.topbar').classList.toggle('scrolled', scroller.scrollTop > 4);
      if (nearBottom()) {
        $('#jump').hidden = true;
        $('#jump').classList.remove('new');
      } else if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 600) $('#jump').hidden = false;
    }, { passive: true });

    scroller.addEventListener('click', async e => {
      const img = e.target.closest('img[data-full]');
      if (img) {
        $('#lightbox img').src = img.dataset.full;
        $('#lightbox').hidden = false;
        return;
      }
      const t = e.target.closest('[data-act]');
      if (!t) return;
      const act = t.dataset.act;
      if (act === 'toggle') {
        const key = t.dataset.key;
        if (S.expanded.has(key)) S.expanded.delete(key);
        else {
          S.expanded.add(key);
          if (key.startsWith('g:') && S.prefs.expandSteps) {
            const c = S.cur;
            const unit = buildUnits(c).find(u => u.key === key);
            for (const it of unit?.items || []) S.expanded.add(`s:${it.id}`);
          }
        }
        renderMessages(false);
      } else if (act === 'copy') {
        const it = S.cur?.items.get(t.dataset.id);
        if (it) copyText(it.text);
      } else if (act === 'copy-code') {
        copyText(t.closest('.code-wrap')?.querySelector('pre')?.innerText || '');
      } else if (act === 'full') {
        t.disabled = true;
        t.textContent = '加载中…';
        try {
          const r = await api(`/api/tool-output?id=${encodeURIComponent(S.cur.id)}&tool=${encodeURIComponent(t.dataset.tool)}`);
          S.full.set(t.dataset.tool, r.text);
          renderMessages(false);
        } catch (err) {
          toast(err.message);
          t.disabled = false;
          t.textContent = '显示全部输出';
        }
      } else if (act === 'new-sheet') openNewSheet();
    });

    // iPhone 切到后台再回来时，连接可能已经被系统断开，回来后补一次同步
    let hiddenAt = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        hiddenAt = Date.now();
        saveDraft();
        return;
      }
      if (!S.boot) return;
      if (!S.es || S.es.readyState === EventSource.CLOSED) connect();
      if (Date.now() - hiddenAt > 5000) resync();
    });
  }

  boot();
})();
