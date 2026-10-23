// 在临时 HOME 和临时端口验证服务；不连接模型，不读取真实 Claude 记录。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('隔离启动、未配对拒绝、主机校验、配对、附件脚本隔离与 SSE', { timeout: 20000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-mobile-http-'));
  const reserve = net.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  for (const file of ['server.mjs', 'package.json', 'lib', 'web']) fs.cpSync(path.join(root, file), path.join(dir, file), { recursive: true });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  const claudeDir = path.join(dir, '.claude');
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(claudeDir, 'sessions'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ bind_host: '127.0.0.1', port, trust_loopback: false }));
  const child = spawn(process.execPath, [path.join(dir, 'server.mjs')], {
    env: { HOME: dir, CLAUDE_CONFIG_DIR: claudeDir, PATH: process.env.PATH, LANG: 'en_US.UTF-8' },
    stdio: 'ignore',
  });
  t.after(async () => {
    const exited = once(child, 'exit');
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try { ready = (await fetch(base + '/api/ping')).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, 'server must start');
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/api/state')).status, 401);
  const deniedStatus = await new Promise((resolve, reject) => {
    const req = http.get(base + '/api/ping', { headers: { Host: 'invalid.example' } }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
  });
  assert.equal(deniedStatus, 403);
  const post = (route, body, headers = {}) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const secret = fs.readFileSync(path.join(dir, 'private/pair.secret'), 'utf8').trim();
  assert.equal((await post('/api/pair', { secret }, { origin: 'http://invalid.example' })).status, 403);
  const pair = await post('/api/pair', { secret });
  assert.equal(pair.status, 200);
  const cookie = pair.headers.get('set-cookie').split(';')[0];
  const state = await fetch(base + '/api/state', { headers: { cookie } });
  assert.equal(state.status, 200);
  assert.equal((await state.json()).defaults.permissionMode, 'default');
  const upload = await fetch(base + '/api/upload', { method: 'POST', headers: { cookie, 'x-file-name': 'sample.html', 'content-type': 'text/html' }, body: '<script>void 0</script>' });
  assert.equal(upload.status, 200);
  const metadata = await upload.json();
  assert.equal('file' in metadata, false);
  const attachment = await fetch(base + metadata.url, { headers: { cookie } });
  assert.match(attachment.headers.get('content-disposition'), /^attachment;/);
  assert.match(attachment.headers.get('content-security-policy'), /sandbox/);
  const controller = new AbortController();
  const events = await fetch(base + '/api/events?client=offline-test', { headers: { cookie }, signal: controller.signal });
  assert.equal(events.status, 200);
  assert.match(events.headers.get('content-type'), /text\/event-stream/);
  const reader = events.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /event: hello/);
  controller.abort();
});
