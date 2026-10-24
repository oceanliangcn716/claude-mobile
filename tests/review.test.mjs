// 针对审查意见的回归测试：附件隔离、大图降级、脱敏、实际设置读取、发送去重、电脑持有对话时的接管保护。
// 全部离线：不连接模型，不读取真实 Claude 记录。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { UploadStore } from '../lib/uploads.mjs';
import { redact, addSecrets } from '../lib/util.mjs';
import { readActualSettings, SendLedger, SettingsStore } from '../lib/state.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

test('附件名为 meta.json / send.jpg 时不会覆盖内部文件，内容原样保存', async t => {
  const dir = tmp('cm-up-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new UploadStore(dir);
  for (const name of ['meta.json', 'send.jpg', '.send.jpg']) {
    const body = Buffer.from(`用户内容 ${name} ${crypto.randomUUID()}`);
    const meta = await store.save(body, name, 'text/plain');
    assert.deepEqual(fs.readFileSync(meta.file), body, `${name} 内容必须保持原样`);
    assert.equal(store.get(meta.id).id, meta.id, `${name} 的元数据必须仍可读`);
    assert.equal(path.dirname(meta.file), path.join(dir, meta.id, 'files'));
  }
});

test('图片：正常小图可发送；处理失败或超限的大图降级为文件，不回退发送原图', async t => {
  const dir = tmp('cm-img-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new UploadStore(dir);
  const small = await store.save(PNG, 'dot.png', 'image/png');
  assert.equal(small.kind, 'image');
  assert.equal(store.imageBlock(small).source.media_type, 'image/png');

  // 带 PNG 文件头但无法解析的 4 MB 数据：sips 处理失败
  const broken = Buffer.concat([PNG.subarray(0, 16), crypto.randomBytes(4 * 1024 * 1024)]);
  const big = await store.save(broken, 'broken.png', 'image/png');
  assert.equal(big.kind, 'file', '处理失败的大图应降级为文件');
  assert.equal(big.sendFile, undefined);
  assert.throws(() => store.imageBlock(big), /处理失败/);
  assert.throws(() => store.imageBlock({ ...small, sendFile: big.file, sendMime: 'image/png' }), /处理失败/, '最终文件超限必须拒绝');
});

test('脱敏：已知密钥、Bearer、sk- 密钥、URL 凭据和查询参数都被隐藏', () => {
  addSecrets(['relay-token-0123456789abcdef']);
  // 拼接构造，避免发布检查把测试样例误判为真实密钥或邮箱
  const fakeKey = ['sk', 'ant-api03-ABCDEFGHIJKLMNOP'].join('-');
  const fakeUrl = ['https://u:p', 'relay.example/v1?key=zzz'].join('@');
  const out = redact(`token relay-token-0123456789abcdef | Authorization: Bearer abc.def.ghijklmnop | ${fakeKey} | ${fakeUrl}`);
  for (const leak of ['relay-token-0123456789abcdef', 'abc.def.ghijklmnop', 'ABCDEFGHIJKLMNOP', 'u:p@', 'key=zzz']) assert.ok(!out.includes(leak), `不应包含 ${leak}`);
  assert.equal(redact('普通错误 429 rate_limit'), '普通错误 429 rate_limit');
});

test('从对话记录读出最近一轮实际模型、思考强度和权限；设置按会话存盘', t => {
  const dir = tmp('cm-st-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, [
    { type: 'user', permissionMode: 'default', message: { role: 'user', content: 'a' } },
    { type: 'assistant', requestedModel: 'claude-sonnet-5-5', effort: 'low', message: { model: 'claude-sonnet-5-5' } },
    { type: 'user', permissionMode: 'acceptEdits', message: { role: 'user', content: 'b' } },
    { type: 'assistant', requestedModel: 'claude-opus-5-5', effort: 'high', message: { model: 'claude-opus-5-5' } },
    { type: 'assistant', isSidechain: true, requestedModel: 'claude-haiku-5-5', effort: 'low' },
  ].map(o => JSON.stringify(o)).join('\n') + '\n');
  assert.deepEqual({ ...readActualSettings(file), at: undefined }, { model: 'claude-opus-5-5', effort: 'high', permissionMode: 'acceptEdits', at: undefined });
  assert.equal(readActualSettings(path.join(dir, 'missing.jsonl')), null);

  const store = new SettingsStore(path.join(dir, 'settings.json'));
  store.set('x', { model: 'sonnet', effort: 'max' });
  assert.equal(new SettingsStore(path.join(dir, 'settings.json')).get('x').effort, 'max', '重启后仍能读到');
});

test('发送去重：同一 id 只执行一次，失败后允许重试', () => {
  const l = new SendLedger();
  assert.equal(l.claim('a'), null);
  assert.equal(l.claim('a').state, 'pending');
  l.done('a', { sessionId: 's' });
  assert.deepEqual(l.claim('a').result, { sessionId: 's' });
  assert.equal(l.claim('b'), null);
  l.fail('b');
  assert.equal(l.claim('b'), null);
});

test('投递记录在服务重启后仍能去重', t => {
  const dir=tmp('cm-ledger-');
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'ledger.json');
  const first=new SendLedger(60000,20,file);
  first.claim('accepted');first.done('accepted',{sessionId:'s',delivery:'queued'});
  first.claim('uncertain');
  const restarted=new SendLedger(60000,20,file);
  assert.equal(restarted.claim('accepted').result.delivery,'queued');
  assert.equal(restarted.claim('uncertain').state,'pending');
  assert.equal(fs.statSync(file).mode&0o777,0o600);
});

test('电脑通道不可用时拒绝接管；保留实际设置并禁止虚假的手机配置', { timeout: 40000 }, async t => {
  const dir = tmp('cm-own-');
  const reserve = net.createServer();
  await new Promise(r => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port;
  await new Promise(r => reserve.close(r));
  for (const f of ['server.mjs', 'package.json', 'lib', 'web']) fs.cpSync(path.join(root, f), path.join(dir, f), { recursive: true });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  const claudeDir = path.join(dir, '.claude');
  const cwd = path.join(dir, 'work');
  fs.mkdirSync(cwd);
  const projDir = path.join(claudeDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(path.join(claudeDir, 'sessions'));
  const sid = crypto.randomUUID();
  const u1 = crypto.randomUUID();
  const base = { sessionId: sid, cwd, isSidechain: false, userType: 'external', entrypoint: 'claude-desktop-3p', version: '2.1.309', gitBranch: '' };
  fs.writeFileSync(path.join(projDir, `${sid}.jsonl`), [
    { ...base, type: 'user', parentUuid: null, uuid: u1, timestamp: new Date().toISOString(), permissionMode: 'default', message: { role: 'user', content: '电脑上的问题' } },
    { ...base, type: 'assistant', parentUuid: u1, uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), requestedModel: 'claude-opus-5-5', effort: 'high', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: '电脑上的回答' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } },
  ].map(o => JSON.stringify(o)).join('\n') + '\n');

  // 名字含 claude 的假进程，模拟桌面 App 持有这条对话
  const fake = path.join(dir, 'claude');
  // 复制的系统程序会被 macOS 签名检查杀掉，这里用 Node 程序的硬链接（失败时复制）
  try { fs.linkSync(process.execPath, fake); } catch { fs.copyFileSync(process.execPath, fake); }
  const holder = spawn(fake, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  const reg = status => fs.writeFileSync(path.join(claudeDir, 'sessions', `${holder.pid}.json`), JSON.stringify({ pid: holder.pid, sessionId: sid, cwd, status, kind: 'interactive', entrypoint: 'claude-desktop-3p', name: '电脑对话', updatedAt: Date.now() }));
  reg('busy');

  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ bind_host: '127.0.0.1', port, trust_loopback: true, models: [{ value: 'claude-opus-5-5', label: 'Opus', efforts: ['low', 'high'] }] }));
  const child = spawn(process.execPath, [path.join(dir, 'server.mjs')], { env: { HOME: dir, CLAUDE_CONFIG_DIR: claudeDir, PATH: process.env.PATH, LANG: 'en_US.UTF-8' }, stdio: 'ignore' });
  t.after(async () => {
    holder.kill();
    const exited = once(child, 'exit');
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(url + '/api/ping')).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  const send = body => fetch(url + '/api/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const waitFor = async (fn, ms = 8000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v || Date.now() > end) return v;
      await new Promise(r => setTimeout(r, 250));
    }
  };

  const busy = await waitFor(async () => {
    const r = await send({ sessionId: sid, text: '手机补充', clientMessageId: crypto.randomUUID() });
    const j = await r.json();
    return r.status === 409 && j.code === 'desktop_unavailable' ? j : null;
  });
  assert.ok(busy, '不能投递到桌面原进程时必须拒绝另起进程');

  reg('idle');
  const idle = await waitFor(async () => {
    const r = await send({ sessionId: sid, text: '手机补充', clientMessageId: crypto.randomUUID() });
    const j = await r.json();
    return r.status === 409 && j.code === 'desktop_unavailable' ? j : null;
  });
  assert.ok(idle, '电脑空闲也不能静默另起进程接管');

  const s = await (await fetch(`${url}/api/session?id=${sid}`)).json();
  assert.equal(s.actual.model, 'claude-opus-5-5');
  assert.equal(s.actual.effort, 'high');
  assert.equal(s.meta.live.by, 'desktop');

  const bad = await fetch(url + '/api/configure', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: sid, effort: 'max' }) });
  assert.equal(bad.status, 400, '模型不支持的思考强度必须拒绝');
  const unsupported = await fetch(url + '/api/configure', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: sid, effort: 'low' }) });
  assert.equal(unsupported.status, 409);
  assert.equal((await unsupported.json()).code, 'desktop_settings');

  // The same HTTP send now reaches the existing process's inbox, even while
  // busy. No SDK session is created, and a retry is not sent a second time.
  const socket=path.join(dir,'desktop.sock');
  let delivered=[];
  const inbox=net.createServer(conn=>{let buf='';conn.on('data',chunk=>{buf+=chunk;let n;while((n=buf.indexOf('\n'))>=0){const line=buf.slice(0,n);buf=buf.slice(n+1);delivered.push(JSON.parse(line));}});});
  await new Promise(r=>inbox.listen(socket,r));fs.chmodSync(socket,0o600);
  t.after(()=>inbox.close());
  const procStart=execFileSync('/bin/ps',['-o','lstart=','-p',String(holder.pid)],{encoding:'utf8',env:{...process.env,TZ:'UTC',LC_ALL:'C'}}).trim();
  fs.writeFileSync(path.join(claudeDir,'sessions',`${holder.pid}.json`),JSON.stringify({pid:holder.pid,sessionId:sid,cwd,status:'busy',entrypoint:'claude-desktop-3p',procStart,messagingSocketPath:socket}));
  const keyHash=crypto.createHash('sha256').update(socket).digest('hex');
  fs.writeFileSync(path.join(claudeDir,'sessions',`${holder.pid}.${keyHash}.key`),JSON.stringify({peerToken:'synthetic-api-token',procStart}),{mode:0o600});
  const messageId=crypto.randomUUID(),body={sessionId:sid,text:'API phone message',clientMessageId:messageId};
  const first=await send(body);assert.equal(first.status,200);
  assert.equal((await first.json()).transport,'desktop-peer');
  await waitFor(()=>delivered.length===2);
  const retry=await send(body);assert.equal((await retry.json()).duplicate,true);
  assert.equal(delivered.length,2);
  assert.equal((await (await fetch(url+'/api/state')).json()).engine.length,0);

  // Simulate the desktop writing its received message and response. The phone
  // reads that same transcript and settles the optimistic message by client id.
  const transcript=path.join(projDir,`${sid}.jsonl`);
  const previous=JSON.parse(fs.readFileSync(transcript,'utf8').trim().split('\n').at(-1)).uuid;
  const receivedId=crypto.randomUUID();
  fs.appendFileSync(transcript,[
    {...base,type:'user',parentUuid:previous,uuid:receivedId,timestamp:new Date().toISOString(),message:{role:'user',content:'Another Claude session sent a message:\n'+delivered[1].message.content}},
    {...base,type:'assistant',parentUuid:receivedId,uuid:crypto.randomUUID(),timestamp:new Date().toISOString(),message:{role:'assistant',model:'claude-opus-5-5',content:[{type:'text',text:'API_SYNC_OK'}]}}
  ].map(row=>JSON.stringify(row)).join('\n')+'\n');
  const synced=await (await fetch(`${url}/api/session?id=${sid}`)).json();
  assert.ok(synced.items.some(item=>item.clientMessageId===messageId&&item.text==='API phone message'));
  assert.ok(synced.items.some(item=>item.text==='API_SYNC_OK'));
});
