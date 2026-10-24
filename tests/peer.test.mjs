import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {DesktopPeer} from '../lib/peer.mjs';
import {normalizeTranscript} from '../lib/transcript.mjs';

test('peer delivery authenticates to the original process without bypassing approval', async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cm-p-'));
  fs.chmodSync(dir,0o700);fs.mkdirSync(path.join(dir,'sessions'),{mode:0o700});
  const socket=path.join(dir,'target.sock'),sid=crypto.randomUUID(),client=crypto.randomUUID();
  const pid=12345,rec={pid,sessionId:sid,entrypoint:'claude-desktop-3p',procStart:'start',messagingSocketPath:socket,status:'busy'};
  let got;const received=new Promise(resolve=>{got=resolve;});
  const server=net.createServer(conn=>{let buf='';conn.on('data',c=>{buf+=c;const rows=buf.trim().split('\n');if(rows.length>=2)got(rows.map(x=>JSON.parse(x)));});});
  await new Promise(r=>server.listen(socket,r));fs.chmodSync(socket,0o600);
  fs.writeFileSync(path.join(dir,'sessions',pid+'.json'),JSON.stringify(rec));
  const hash=crypto.createHash('sha256').update(socket).digest('hex');
  const keyFile=path.join(dir,'sessions',`${pid}.${hash}.key`);
  fs.writeFileSync(keyFile,JSON.stringify({peerToken:'synthetic-test-token',procStart:'start'}),{mode:0o600});
  let identity={comm:'/test/claude',start:'start'};
  const peer=new DesktopPeer({claudeDir:dir,inspectProcess:()=>identity});
  t.after(async()=>{await peer.close();server.close();fs.rmSync(dir,{recursive:true,force:true});});
  const target=peer.target(sid);assert.ok(target);
  const result=await peer.send(target,'phone text',client);
  assert.equal(result.transport,'desktop-peer');assert.equal(result.delivery,'queued');
  const [auth,message]=await received;
  assert.equal(auth.token,'synthetic-test-token');assert.equal(message.priority,'next');
  assert.match(message.message.content,/from-mode="default"/);
  assert.match(message.message.content,new RegExp(client));
  assert.equal('childToken' in auth,false);
  identity={comm:'/test/claude',start:'reused PID'};
  assert.equal(peer.target(sid),null);
  await assert.rejects(peer.send(target,'again',crypto.randomUUID()),/会话已变化/);
  identity={comm:'/test/claude',start:'start'};fs.chmodSync(keyFile,0o644);
  await assert.rejects(peer.send(target,'again',crypto.randomUUID()),/权限异常/);
});

test('phone peer messages keep their message id and attachment cards in the transcript',()=>{
  const client=crypto.randomUUID();
  const text=`Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/mobile-123.sock" from-name="手机" from-mode="default" mobile-message-id="${client}">\nhello\n</cross-session-message>\nThis came from another Claude session.`;
  const {items}=normalizeTranscript([{type:'user',uuid:crypto.randomUUID(),timestamp:new Date().toISOString(),message:{role:'user',content:text}}]);
  assert.equal(items[0].kind,'user');assert.equal(items[0].text,'hello');
  assert.equal(items[0].clientMessageId,client);
});
