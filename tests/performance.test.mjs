// 使用临时记录验证缓存和后台休眠，不访问真实会话或模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Hub } from '../lib/hub.mjs';
import { BlobStore } from '../lib/transcript.mjs';

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-perf-'));
  const claudeDir = path.join(root, 'claude');
  const project = path.join(claudeDir, 'projects', 'work');
  const privateDir = path.join(root, 'private');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(claudeDir, 'sessions'));
  fs.mkdirSync(privateDir);
  const id = crypto.randomUUID();
  const file = path.join(project, `${id}.jsonl`);
  const first = { type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: 'first' } };
  fs.writeFileSync(file, JSON.stringify(first) + '\n');
  const engine = Object.assign(new EventEmitter(), { state: () => null });
  const hub = new Hub({ claudeDir, privateDir, workspaceDir: root, engine, blobs: new BlobStore(), log: { warn() {} },
    readRegistry: () => new Map(), readMessages: async () => [first], ...options });
  hub.start();
  t.after(() => { hub.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { hub, id, file, first };
}

test('无客户端时不轮询；连接后启用兜底，最后一个客户端断开后停止', t => {
  let reads = 0;
  const { hub } = fixture(t, { readRegistry: () => { reads++; return new Map(); } });
  assert.equal(reads, 1);
  assert.equal(hub.pollTimer, undefined);
  assert.equal(hub.liveTimer, undefined);
  const res = () => ({ write() {}, end() {}, writableLength: 0 });
  const a = res(), b = res();
  hub.addClient('a', a);
  assert.ok(hub.pollTimer);
  assert.ok(hub.liveTimer);
  hub.addClient('b', b);
  hub.removeClient('a', a);
  assert.ok(hub.pollTimer, '其他手机仍连接时保留轮询');
  hub.removeClient('b', b);
  assert.equal(hub.pollTimer, null);
  assert.equal(hub.liveTimer, null);
  hub.addClient('a', a);
  assert.ok(hub.pollTimer, '重新连接后必须恢复');
});

test('未变记录只解析一次；读取过程中追加的消息下一次仍能同步', async t => {
  let reads = 0, appendDuringRead = false;
  let data;
  const f = fixture(t, { readMessages: async () => {
    reads++;
    const messages = fs.readFileSync(data.file, 'utf8').trim().split('\n').map(JSON.parse);
    if (appendDuringRead) {
      appendDuringRead = false;
      fs.appendFileSync(data.file, JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: 'arrived during read' } }) + '\n');
    }
    return messages;
  } });
  data = f;
  assert.equal((await f.hub.open(f.id)).items.length, 1);
  await f.hub.open(f.id);
  assert.equal(reads, 1, '未变化时不能重新解析历史');
  appendDuringRead = true;
  fs.appendFileSync(f.file, JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: 'second' } }) + '\n');
  assert.equal((await f.hub.open(f.id)).items.length, 2);
  assert.equal((await f.hub.open(f.id)).items.length, 3, '不能把未读取的追加内容误判为已同步');
  await f.hub.open(f.id);
  assert.equal(reads, 3);
});

test('图片缓存按实际访问淘汰旧图，遵守内存预算', () => {
  const blobs = new BlobStore(6);
  const a = blobs.put('a', 'image/png', Buffer.from('aaa').toString('base64'));
  const b = blobs.put('b', 'image/png', Buffer.from('bbb').toString('base64'));
  assert.ok(blobs.get(a));
  const c = blobs.put('c', 'image/png', Buffer.from('ccc').toString('base64'));
  assert.ok(blobs.get(a));
  assert.equal(blobs.get(b), undefined);
  assert.ok(blobs.get(c));
  assert.equal(blobs.size, 6);
});
