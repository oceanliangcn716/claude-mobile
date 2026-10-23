import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSessions, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { normalizeTranscript, displayPath } from './transcript.mjs';
import { readLiveRegistry, liveOwner } from './live.mjs';
import { sha1, readJsonFile, writeFileAtomic } from './util.mjs';

const PAGE = 120;
const HOME = os.homedir();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function isSessionId(id) {
  return typeof id === 'string' && UUID.test(id);
}

function isScratch(cwd) {
  return /\/Library\/Application Support\/Claude[^/]*\/scratch-workspaces\//.test(cwd || '');
}

// 负责“看”：对话列表、对话内容、文件变化后实时推送给所有打开的页面。
// 不管对话是电脑桌面 App、终端还是手机引擎写的，都从 ~/.claude/projects 里同一份记录读取。
export class Hub {
  constructor({ claudeDir, privateDir, workspaceDir, engine, blobs, log }) {
    this.projectsDir = path.join(claudeDir, 'projects');
    this.registryDir = path.join(claudeDir, 'sessions');
    this.ownFile = path.join(privateDir, 'sessions.json');
    this.own = readJsonFile(this.ownFile, {});
    this.workspaceDir = workspaceDir;
    this.engine = engine;
    this.blobs = blobs;
    this.log = log;
    this.clients = new Map();
    this.views = new Map();
    this.files = new Map();
    this.entrypoints = new Map();
    this.live = new Map();
    this.liveSig = new Map();
    this.index = [];
    this.indexStale = true;
    this.indexing = null;
    this.changed = new Set();
    this.changeTimer = null;
    this.debounce = new Map();

    engine.on('state', id => this.#markChanged(id));
    engine.on('state', (id, state) => this.broadcast('engine', { sessionId: id, state }));
    engine.on('partial', (id, blocks) => this.broadcast('partial', { sessionId: id, blocks }, c => c.sessionId === id));
    engine.on('transcript', (id, opts) => this.refresh(id, { immediate: true, ...(opts || {}) }));
  }

  start() {
    this.#scanFiles();
    this.#readLive();
    try {
      this.projectsWatcher = fs.watch(this.projectsDir, { recursive: true }, (_e, name) => this.#onProjectFile(name));
    } catch (e) {
      this.log.warn('watch projects failed', e.message);
    }
    try {
      this.registryWatcher = fs.watch(this.registryDir, () => this.#scheduleLive());
    } catch (e) {
      this.log.warn('watch registry failed', e.message);
    }
    // fs.watch 偶尔会漏事件，再加一个轻量轮询兜底。
    this.pollTimer = setInterval(() => this.#poll(), 2000);
    this.liveTimer = setInterval(() => this.#readLive(), 4000);
    this.evictTimer = setInterval(() => this.#evict(), 60 * 1000);
    for (const t of [this.pollTimer, this.liveTimer, this.evictTimer]) t.unref();
  }

  stop() {
    this.projectsWatcher?.close();
    this.registryWatcher?.close();
    clearInterval(this.pollTimer);
    clearInterval(this.liveTimer);
    clearInterval(this.evictTimer);
    for (const c of this.clients.values()) c.res.end();
  }

  // ---------- 实时推送（SSE） ----------

  addClient(id, res) {
    const old = this.clients.get(id);
    if (old) old.res.end();
    const client = { id, res, sessionId: old?.sessionId || null };
    this.clients.set(id, client);
    return client;
  }

  removeClient(id, res) {
    const c = this.clients.get(id);
    if (c && c.res === res) this.clients.delete(id);
  }

  subscribe(clientId, sessionId) {
    const c = this.clients.get(clientId);
    if (!c) return;
    c.sessionId = sessionId || null;
    // 先建好视图，之后的变化才能按差异推送
    if (sessionId && !this.views.get(sessionId)?.ready) this.#run(sessionId);
  }

  broadcast(event, data, filter) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients.values()) {
      if (filter && !filter(c)) continue;
      try {
        c.res.write(frame);
      } catch {}
    }
  }

  #subscribed(id) {
    for (const c of this.clients.values()) if (c.sessionId === id) return true;
    return false;
  }

  // ---------- 对话列表 ----------

  markOwn(id, extra = {}) {
    this.own[id] = { createdAt: Date.now(), ...extra };
    writeFileAtomic(this.ownFile, JSON.stringify(this.own), 0o600);
    this.#markChanged(id);
  }

  #scanFiles() {
    let dirs = [];
    try {
      dirs = fs.readdirSync(this.projectsDir, { withFileTypes: true }).filter(d => d.isDirectory());
    } catch {
      return;
    }
    for (const d of dirs) {
      let names = [];
      try { names = fs.readdirSync(path.join(this.projectsDir, d.name)); } catch { continue; }
      for (const n of names) {
        if (n.endsWith('.jsonl') && isSessionId(n.slice(0, -6))) this.files.set(n.slice(0, -6), path.join(this.projectsDir, d.name, n));
      }
    }
  }

  #entrypoint(id) {
    if (this.entrypoints.has(id)) return this.entrypoints.get(id);
    const file = this.files.get(id);
    if (!file) return null;
    let found = null;
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(256 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      found = /"entrypoint":"([^"]+)"/.exec(buf.subarray(0, n).toString('utf8'))?.[1] || null;
    } catch {}
    if (found) this.entrypoints.set(id, found);
    return found;
  }

  async #ensureIndex() {
    if (!this.indexStale) return;
    if (!this.indexing) {
      this.indexing = (async () => {
        this.indexStale = false;
        try {
          this.index = await listSessions({});
        } catch (e) {
          this.indexStale = true;
          this.log.warn('listSessions failed', e.message);
        }
      })().finally(() => { this.indexing = null; });
    }
    await this.indexing;
  }

  projectName(cwd) {
    if (!cwd) return '未知目录';
    if (cwd === HOME) return '主目录';
    if (cwd === this.workspaceDir) return '手机工作区';
    if (isScratch(cwd)) return '临时工作区';
    return path.basename(cwd);
  }

  #source(id) {
    if (this.own[id]) return 'mobile';
    const owner = liveOwner(this.#entrypoint(id) || this.live.get(id)?.entrypoint);
    return owner === 'desktop' ? 'desktop' : owner === 'terminal' ? 'terminal' : owner === 'sdk' ? 'sdk' : 'other';
  }

  #metaFrom(info) {
    const id = info.sessionId;
    const live = this.live.get(id);
    const eng = this.engine.state(id);
    const owner = live ? liveOwner(live.entrypoint) : null;
    return {
      id,
      title: (owner === 'desktop' && live.name) || info.customTitle || info.summary || info.firstPrompt || '未命名对话',
      cwd: info.cwd || live?.cwd || eng?.cwd || null,
      project: this.projectName(info.cwd || live?.cwd || eng?.cwd),
      lastModified: info.lastModified || 0,
      createdAt: info.createdAt || null,
      gitBranch: info.gitBranch || null,
      source: this.#source(id),
      forkedFrom: this.own[id]?.forkedFrom || null,
      live: live && owner !== 'sdk' ? { by: owner, status: live.status } : null,
      engine: eng ? { state: eng.state, busy: eng.busy, pending: eng.pending.length } : null,
    };
  }

  // 手机刚新建、还没写出记录文件的对话
  #draftMeta(st) {
    return this.#metaFrom({ sessionId: st.sessionId, summary: this.own[st.sessionId]?.title || '新对话', cwd: st.cwd, lastModified: Date.now() });
  }

  async list({ q = '', offset = 0, limit = 50, source = '' } = {}) {
    await this.#ensureIndex();
    const rows = this.index.map(i => this.#metaFrom(i));
    for (const st of this.engine.states()) if (!rows.some(r => r.id === st.sessionId)) rows.push(this.#draftMeta(st));
    let out = rows;
    if (source) out = out.filter(r => r.source === source);
    if (q) {
      const k = q.toLowerCase();
      out = out.filter(r => `${r.title}\n${r.cwd || ''}`.toLowerCase().includes(k));
    }
    out.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
    return { total: out.length, rows: out.slice(offset, offset + limit) };
  }

  async meta(id) {
    await this.#ensureIndex();
    const info = this.index.find(i => i.sessionId === id);
    if (info) return this.#metaFrom(info);
    const st = this.engine.state(id);
    return st ? this.#draftMeta(st) : null;
  }

  async projects() {
    await this.#ensureIndex();
    const seen = new Map();
    for (const i of this.index) {
      if (i.cwd && !isScratch(i.cwd) && !seen.has(i.cwd)) seen.set(i.cwd, i.lastModified || 0);
    }
    const list = [...seen].filter(([cwd]) => fs.existsSync(cwd)).map(([cwd, lastUsed]) => ({ cwd, lastUsed }));
    for (const cwd of [HOME, this.workspaceDir]) if (!seen.has(cwd)) list.push({ cwd, lastUsed: 0 });
    list.sort((a, b) => b.lastUsed - a.lastUsed);
    return list.map(p => ({ ...p, name: this.projectName(p.cwd), display: displayPath(p.cwd) }));
  }

  // ---------- 对话内容 ----------

  #view(id) {
    let v = this.views.get(id);
    if (!v) {
      v = { items: [], order: [], hashes: new Map(), outputs: new Map(), version: 0, ready: false, chain: Promise.resolve(), stat: null, usedAt: Date.now() };
      this.views.set(id, v);
    }
    v.usedAt = Date.now();
    return v;
  }

  async #cwd(id) {
    let info = this.index.find(i => i.sessionId === id);
    if (!info && this.indexStale) {
      await this.#ensureIndex();
      info = this.index.find(i => i.sessionId === id);
    }
    return info?.cwd || this.engine.state(id)?.cwd || this.live.get(id)?.cwd || null;
  }

  async #compute(id) {
    const v = this.#view(id);
    const cwd = await this.#cwd(id);
    const messages = await getSessionMessages(id);
    const { items, outputs } = normalizeTranscript(messages, { cwd, blobs: this.blobs });
    const hashes = new Map(items.map(it => [it.id, sha1(JSON.stringify(it))]));
    const order = items.map(it => it.id);
    const prev = v.order;
    const appendOnly = prev.length <= order.length && prev.every((x, i) => order[i] === x);
    const upserts = [];
    items.forEach((it, i) => {
      if (v.hashes.get(it.id) !== hashes.get(it.id)) upserts.push({ ...it, seq: i });
    });
    const prevVersion = v.version;
    const changed = v.ready && (upserts.length > 0 || !appendOnly);
    Object.assign(v, { items, order, hashes, outputs, ready: true, stat: this.#stat(id) });
    if (!changed) return null;
    v.version += 1;
    return { sessionId: id, prevVersion, version: v.version, total: items.length, upserts, order: appendOnly ? null : order };
  }

  #stat(id) {
    try {
      const s = fs.statSync(this.files.get(id));
      return `${s.size}:${s.mtimeMs}`;
    } catch {
      return null;
    }
  }

  #run(id, opts = {}) {
    const v = this.#view(id);
    v.chain = v.chain
      .then(async () => {
        for (let attempt = 0; attempt < 8; attempt++) {
          const diff = await this.#compute(id);
          if (diff) this.broadcast('transcript', diff, c => c.sessionId === id);
          if (!opts.expect || v.order.some(x => x.startsWith(opts.expect))) break;
          await sleep(60);
        }
      })
      .catch(e => this.log.warn('refresh failed', id, e.message))
      .finally(() => opts.after?.());
    return v.chain;
  }

  refresh(id, opts = {}) {
    this.indexStale = true;
    this.#markChanged(id);
    const v = this.views.get(id);
    if (!v || !this.#subscribed(id)) {
      if (v) v.ready = false;
      opts.after?.();
      return;
    }
    if (opts.immediate) return this.#run(id, opts);
    clearTimeout(this.debounce.get(id));
    this.debounce.set(id, setTimeout(() => {
      this.debounce.delete(id);
      this.#run(id);
    }, 120));
  }

  async open(id) {
    const v = this.#view(id);
    await this.#run(id);
    const start = Math.max(0, v.items.length - PAGE);
    return {
      version: v.version,
      total: v.items.length,
      start,
      items: v.items.slice(start).map((it, k) => ({ ...it, seq: start + k })),
    };
  }

  async older(id, before) {
    const v = this.#view(id);
    if (!v.ready) await this.#run(id);
    const end = Math.max(0, Math.min(Number(before) || 0, v.items.length));
    const start = Math.max(0, end - PAGE);
    return { version: v.version, start, items: v.items.slice(start, end).map((it, k) => ({ ...it, seq: start + k })) };
  }

  toolOutput(id, toolUseId) {
    return this.views.get(id)?.outputs.get(toolUseId) ?? null;
  }

  // ---------- 变化来源 ----------

  #onProjectFile(name) {
    if (!name) return;
    const parts = String(name).split(path.sep);
    if (parts.length !== 2 || !parts[1].endsWith('.jsonl')) return;
    const id = parts[1].slice(0, -6);
    if (!isSessionId(id)) return;
    this.files.set(id, path.join(this.projectsDir, parts[0], parts[1]));
    this.refresh(id);
  }

  #poll() {
    for (const [id, v] of this.views) {
      if (!v.ready || !this.#subscribed(id)) continue;
      if (!this.files.has(id)) this.#scanFiles();
      const stat = this.#stat(id);
      if (stat && stat !== v.stat) this.refresh(id);
    }
  }

  #scheduleLive() {
    clearTimeout(this.liveDebounce);
    this.liveDebounce = setTimeout(() => this.#readLive(), 300);
  }

  #readLive() {
    const next = readLiveRegistry(this.registryDir);
    const ids = new Set([...next.keys(), ...this.live.keys()]);
    for (const id of ids) {
      const r = next.get(id);
      const sig = r ? `${r.status}|${r.name}|${r.entrypoint}` : '';
      if ((this.liveSig.get(id) || '') !== sig) {
        if (sig) this.liveSig.set(id, sig);
        else this.liveSig.delete(id);
        this.#markChanged(id);
      }
    }
    this.live = next;
  }

  #markChanged(id) {
    this.changed.add(id);
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(async () => {
      this.changeTimer = null;
      const ids = [...this.changed];
      this.changed.clear();
      try {
        await this.#ensureIndex();
        const rows = [];
        for (const id of ids) {
          const m = await this.meta(id);
          if (m) rows.push(m);
        }
        if (rows.length) this.broadcast('sessions', { rows });
      } catch (e) {
        this.log.warn('session broadcast failed', e.message);
      }
    }, 600);
  }

  #evict() {
    const now = Date.now();
    for (const [id, v] of this.views) {
      if (!this.#subscribed(id) && now - v.usedAt > 10 * 60 * 1000) this.views.delete(id);
    }
  }
}
