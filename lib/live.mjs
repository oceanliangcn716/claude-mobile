import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// 每个运行中的 Claude Code 进程（桌面 App、终端、SDK）都会写 ~/.claude/sessions/<pid>.json，
// 记录它正在处理哪条对话、忙还是闲、标题叫什么。读它就能知道哪些对话是“电脑上正开着的”。
export function readLiveRegistry(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter(n => /^\d+\.json$/.test(n));
  } catch {
    return new Map();
  }
  const records = [];
  for (const n of names) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (rec?.sessionId && Number.isInteger(rec.pid)) records.push(rec);
    } catch {}
  }
  const running = runningClaudePids(records.map(r => r.pid));
  const map = new Map();
  for (const rec of records) {
    if (!running.has(rec.pid)) continue;
    const prev = map.get(rec.sessionId);
    if (prev && prev.updatedAt > (rec.updatedAt || 0)) continue;
    map.set(rec.sessionId, {
      pid: rec.pid,
      status: rec.status || null,
      name: rec.name || null,
      entrypoint: rec.entrypoint || null,
      kind: rec.kind || null,
      cwd: rec.cwd || null,
      updatedAt: rec.updatedAt || rec.startedAt || 0,
    });
  }
  return map;
}

// 登记文件不会在进程崩溃时删除，pid 也可能被别的程序复用，所以用 ps 确认它确实还是 claude。
function runningClaudePids(pids) {
  const out = new Set();
  if (!pids.length) return out;
  try {
    const text = execFileSync('/bin/ps', ['-o', 'pid=,comm=', '-p', pids.join(',')], { encoding: 'utf8', timeout: 3000 });
    for (const line of text.split('\n')) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (m && /claude/i.test(m[2])) out.add(Number(m[1]));
    }
  } catch {}
  return out;
}

export function liveOwner(entrypoint) {
  if (!entrypoint) return 'other';
  if (entrypoint.startsWith('claude-desktop')) return 'desktop';
  if (entrypoint === 'cli') return 'terminal';
  if (entrypoint.startsWith('sdk')) return 'sdk';
  return 'other';
}
