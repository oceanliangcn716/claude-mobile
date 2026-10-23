import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Auth } from '../lib/auth.mjs';
import { allowedBindAddress } from '../lib/net.mjs';
import { UploadStore, publicUpload } from '../lib/uploads.mjs';

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-mobile-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('配对密钥权限、有效 Cookie、伪造拒绝与轮换失效', t => {
  const auth = new Auth(temporary(t));
  assert.equal(fs.statSync(auth.file).mode & 0o777, 0o600);
  assert.equal(auth.pair('test-device', auth.secret).ok, true);
  const token = auth.issue();
  const request = { headers: { cookie: `claude_mobile=${token}` } };
  assert.equal(auth.check(request).ok, true);
  assert.equal(auth.check({ headers: { cookie: `claude_mobile=${token}x` } }).ok, false);
  auth.rotate();
  assert.equal(auth.check(request).ok, false);
});

test('配对失败次数限制', t => {
  const auth = new Auth(temporary(t));
  for (let i = 0; i < 8; i++) assert.equal(auth.pair('test-device', 'invalid').status, 403);
  assert.equal(auth.pair('test-device', auth.secret).status, 429);
});

test('只允许回环、私有网段和 Tailscale 地址，拒绝公网与通配地址', () => {
  for (const ip of ['127.0.0.1', '172.16.2.4', '172.31.2.4', '100.64.2.4', '100.127.2.4']) assert.equal(allowedBindAddress(ip), true, ip);
  for (const ip of ['0.0.0.0', '8.8.8.8', '172.32.1.1', '100.128.2.4', 'localhost', '::', ['10', '999', '0', '1'].join('.')]) assert.equal(allowedBindAddress(ip), false, ip);
});

test('附件不会逃出目录，公开元数据不暴露本机路径，拒绝空附件', async t => {
  const root = temporary(t);
  const uploads = new UploadStore(root);
  const meta = await uploads.save(Buffer.from('sample document'), '../../sample.txt', 'text/plain');
  assert.ok(meta.file.startsWith(root + path.sep));
  assert.equal(fs.statSync(meta.file).mode & 0o777, 0o600);
  assert.equal(uploads.get(meta.id).name, 'sample.txt');
  assert.equal(uploads.get('../invalid'), null);
  assert.equal('file' in publicUpload(meta), false);
  await assert.rejects(uploads.save(Buffer.alloc(0), 'empty.txt'), { status: 400 });
});
