import fs from 'node:fs';
import { readJsonFile, writeFileAtomic } from './util.mjs';

// 每条对话在手机上选过的设置（下一轮生效），存盘，服务重启后仍然有效。
export class SettingsStore {
  constructor(file) {
    this.file = file;
    this.data = readJsonFile(file, {});
  }

  get(id) {
    return this.data[id] || null;
  }

  set(id, settings) {
    this.data[id] = { ...(this.data[id] || {}), ...settings, at: Date.now() };
    const ids = Object.keys(this.data);
    if (ids.length > 2000) {
      ids.sort((a, b) => (this.data[a].at || 0) - (this.data[b].at || 0));
      for (const old of ids.slice(0, ids.length - 2000)) delete this.data[old];
    }
    writeFileAtomic(this.file, JSON.stringify(this.data), 0o600);
  }
}

// 从对话记录末尾读出这条对话最近一轮实际用的模型、思考强度和权限模式。
const TAIL_BYTES = 512 * 1024;

export function readActualSettings(file) {
  let text;
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch {
    return null;
  }
  const out = {};
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0 && !(out.model && out.permissionMode); i--) {
    const line = lines[i];
    if (!line.startsWith('{')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain) continue;
    if (!out.model && o.type === 'assistant') {
      const model = o.requestedModel || o.message?.model;
      if (!model || model === '<synthetic>') continue;
      out.model = model;
      out.effort = o.perTurnEffort || o.effort || null;
      out.at = o.timestamp || null;
    } else if (!out.permissionMode && o.type === 'user' && o.permissionMode) {
      out.permissionMode = o.permissionMode;
    }
  }
  return out.model || out.permissionMode ? out : null;
}

// 发送去重：同一个 clientMessageId 只执行一次，断线重发时返回第一次的结果。
export class SendLedger {
  constructor(ttlMs = 24 * 3600 * 1000, max = 2000) {
    this.ttl = ttlMs;
    this.max = max;
    this.map = new Map();
  }

  // 返回 null 表示是新请求（已占位）；否则返回之前的记录
  claim(id) {
    this.#prune();
    const hit = this.map.get(id);
    if (hit) return hit;
    this.map.set(id, { state: 'pending', at: Date.now() });
    return null;
  }

  done(id, result) {
    this.map.set(id, { state: 'done', result, at: Date.now() });
  }

  fail(id) {
    this.map.delete(id);
  }

  #prune() {
    const now = Date.now();
    for (const [k, v] of this.map) {
      if (now - v.at < this.ttl && this.map.size <= this.max) break;
      this.map.delete(k);
    }
  }
}
