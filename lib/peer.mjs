// Deliver to the existing desktop process using Claude Code's local peer inbox.
// This is peer messaging, not the official Remote Control protocol. It cannot
// change models, stop a turn or answer permission prompts. Never impersonate a
// child process or claim a less restrictive permission mode to avoid approval.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {HttpError} from './util.mjs';

function processInfo(pid) {
  try {
    const comm=execFileSync('/bin/ps',['-ww','-o','comm=','-p',String(pid)],{encoding:'utf8',timeout:2000,env:{...process.env,TZ:'UTC',LC_ALL:'C'}}).trim();
    const start=execFileSync('/bin/ps',['-o','lstart=','-p',String(pid)],{encoding:'utf8',timeout:2000,env:{...process.env,TZ:'UTC',LC_ALL:'C'}}).trim();
    return {comm,start};
  } catch { return null; }
}

export class DesktopPeer {
  constructor({claudeDir,onStatus=()=>{},inspectProcess=processInfo}) {
    this.registry=path.join(claudeDir,'sessions');
    this.onStatus=onStatus;
    this.inspectProcess=inspectProcess;
    this.servers=new Map();
    this.pending=new Map();
  }

  target(sessionId) {
    let names=[];try {names=fs.readdirSync(this.registry);}catch {return null;}
    for(const name of names) {
      if(!/^\d+\.json$/.test(name))continue;
      let rec;try {rec=JSON.parse(fs.readFileSync(path.join(this.registry,name),'utf8'));}catch {continue;}
      if(rec.sessionId!==sessionId||!String(rec.entrypoint).startsWith('claude-desktop')||!Number.isSafeInteger(rec.pid)||rec.pid<=0)continue;
      const proc=this.inspectProcess(rec.pid);
      if(!proc||!/(?:^|\/)claude(?:\.exe)?$/i.test(proc.comm)||!rec.procStart||proc.start!==rec.procStart.trim())continue;
      const socket=rec.messagingSocketPath;
      if(typeof socket!=='string'||!path.isAbsolute(socket))continue;
      try {
        const st=fs.lstatSync(socket),dir=fs.lstatSync(path.dirname(socket));
        if(!st.isSocket()||st.uid!==process.getuid()||(st.mode&0o077)||!dir.isDirectory()||dir.isSymbolicLink()||dir.uid!==process.getuid()||(dir.mode&0o077))continue;
        if(fs.realpathSync(path.dirname(socket))!==path.dirname(fs.realpathSync(socket)))continue;
      } catch {continue;}
      return {...rec,socket};
    }
    return null;
  }

  async #inbox(directory) {
    if(this.servers.has(directory))return this.servers.get(directory);
    const promise=(async()=>{
      const socket=path.join(directory,`mobile-${process.pid}.sock`);
      const server=net.createServer(conn=>{
        let data='';conn.setTimeout(5000,()=>conn.destroy());
        conn.on('error',()=>{});
        conn.on('data',chunk=>{
          data+=chunk;if(data.length>65536)return conn.destroy();
          while(data.includes('\n')) {
            const i=data.indexOf('\n'),line=data.slice(0,i);data=data.slice(i+1);
            try {
              const frame=JSON.parse(line),entry=this.pending.get(frame.orig_msg_id);
              if(entry&&frame.type==='control'&&frame.action==='peer_message_status'&&['held','delivered','denied','expired'].includes(frame.status)) {
                this.onStatus({...entry,status:frame.status});
                if(frame.status!=='held')this.pending.delete(frame.orig_msg_id);
              }
            }catch {}
          }
        });
      });
      // Do not unlink an existing socket: another instance may still own it.
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});
      fs.chmodSync(socket,0o600);server.unref();
      return {server,socket};
    })();
    this.servers.set(directory,promise);
    try{return await promise;}catch(e){this.servers.delete(directory);throw e;}
  }

  async send(target,text,clientMessageId) {
    // Revalidate immediately before delivery, including PID reuse and socket mode.
    const current=this.target(target.sessionId);
    if(!current||current.pid!==target.pid||current.socket!==target.socket)throw new HttpError(409,'电脑会话已变化，请刷新后重试',{code:'desktop_changed'});
    const {socket:reply}=await this.#inbox(path.dirname(current.socket));
    const msgId='cc-msg-'+crypto.createHash('sha256').update(clientMessageId).digest('hex').slice(0,32);
    const from='uds:'+reply;
    const frame={type:'user',message:{role:'user',content:`<cross-session-message from="${from}" from-name="手机" from-mode="default" mobile-message-id="${clientMessageId}">\n${text}\n</cross-session-message>`},from,priority:'next',msgV:1,msg_id:msgId};
    // The peer token is used only with its own inbox and never returned or logged.
    const keyFile=[current.socket,fs.realpathSync(current.socket)].map(value=>{
      const hash=crypto.createHash('sha256').update(value).digest('hex');
      return path.join(this.registry,`${current.pid}.${hash}.key`);
    }).find(file=>fs.existsSync(file));
    if(!keyFile)throw new HttpError(409,'电脑会话认证文件不可用，请重新打开这条对话');
    const st=fs.lstatSync(keyFile);
    if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&0o077))throw new HttpError(409,'电脑会话认证文件权限异常');
    const key=JSON.parse(fs.readFileSync(keyFile,'utf8'));
    if(!key.peerToken||key.procStart!==current.procStart)throw new HttpError(409,'电脑会话认证已变化，请刷新后重试');
    const entry={sessionId:target.sessionId,clientMessageId};
    this.pending.set(msgId,entry);
    while(this.pending.size>2000)this.pending.delete(this.pending.keys().next().value);
    try {
      await new Promise((resolve,reject)=>{
        const conn=net.createConnection(current.socket);
        conn.setTimeout(5000,()=>conn.destroy(new Error('desktop inbox timed out')));
        conn.on('error',reject);
        conn.on('connect',()=>conn.end(JSON.stringify({type:'auth',token:key.peerToken})+'\n'+JSON.stringify(frame)+'\n'));
        conn.on('finish',()=>{conn.destroy();resolve();});
      });
    }catch {this.pending.delete(msgId);throw new HttpError(409,'未能投递到电脑原会话，请刷新后重试');}
    return {ok:true,sessionId:target.sessionId,transport:'desktop-peer',delivery:'queued'};
  }

  async close() {
    for(const p of this.servers.values()) {
      try {const {server,socket}=await p;server.close();try{fs.unlinkSync(socket);}catch {}}catch {}
    }
    this.servers.clear();this.pending.clear();
  }
}
