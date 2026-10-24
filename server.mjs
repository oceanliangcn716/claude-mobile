#!/usr/bin/env node
// Claude 手机入口：手机浏览器遥控这台 Mac 上的 Claude Code。
// 看：实时读取 ~/.claude/projects 里所有对话（电脑桌面 App 的也在内）。
// 做：电脑对话投递给桌面原进程；手机新建对话使用本机 Agent SDK。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { renameSession } from '@anthropic-ai/claude-agent-sdk';
import { Auth } from './lib/auth.mjs';
import { Listeners, lanAddresses } from './lib/net.mjs';
import { Engine, PERMISSION_MODES, EFFORTS } from './lib/engine.mjs';
import { Hub, isSessionId } from './lib/hub.mjs';
import { BlobStore, ATTACH_HEAD } from './lib/transcript.mjs';
import { UploadStore, UPLOAD_LIMIT, MAX_ATTACHMENTS, MAX_TOTAL, publicUpload } from './lib/uploads.mjs';
import { HttpError, sendJson, readJson, readBody, readJsonFile, writeFileAtomic, createLogger, addSecrets, redact } from './lib/util.mjs';
import { SettingsStore, SendLedger } from './lib/state.mjs';
import { DesktopPeer } from './lib/peer.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const PRIVATE = path.join(ROOT, 'private');
const WEB = path.join(ROOT, 'web');
const WORKSPACE = path.join(ROOT, 'mobile-workspace');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const VERSION = readJsonFile(path.join(ROOT, 'package.json'), {}).version || 'dev';
// 实际运行的是哪一份代码：Git 仓库里读提交号，部署出来的目录读 BUILD 文件
const BUILD = (() => {
  try {
    const head = execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const dirty = execFileSync('git', ['-C', ROOT, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return head + (dirty ? '-modified' : '');
  } catch {}
  try {
    return fs.readFileSync(path.join(ROOT, 'BUILD'), 'utf8').trim() || 'unknown';
  } catch {
    return 'unknown';
  }
})();

fs.mkdirSync(PRIVATE, { recursive: true, mode: 0o700 });
fs.mkdirSync(WORKSPACE, { recursive: true });

const log = createLogger(path.join(ROOT, 'logs', 'server.log'));

const DEFAULT_CONFIG = {
  bind_host: 'auto',
  port: 3082,
  trust_loopback: true,
  defaults: { model: 'opus', effort: 'medium', permissionMode: 'default', cwd: '~' },
};
const config = { ...DEFAULT_CONFIG, ...readJsonFile(CONFIG_FILE, {}) };
config.defaults = { ...DEFAULT_CONFIG.defaults, ...(config.defaults || {}) };
if (!fs.existsSync(CONFIG_FILE)) saveConfig();

function saveConfig() {
  writeFileAtomic(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 0o644);
}

// 模型菜单：config.json 的 models 优先（自定义服务商自己填）；否则启动时读本机 Claude Code 的模型目录和
// 每个模型支持的思考强度；都拿不到时用通用别名。菜单里有，不代表你的服务商一定支持，失败会在页面显示错误。
const FALLBACK_MODELS = [
  { value: 'opus', label: 'Opus', note: '' },
  { value: 'sonnet', label: 'Sonnet', note: '' },
  { value: 'haiku', label: 'Haiku', note: '' },
];
let models = (config.models || FALLBACK_MODELS).map(m => ({ ...m, source: config.models ? 'config' : 'fallback' }));

function modelInfo(value) {
  return models.find(m => m.value === value) || null;
}

async function loadModels() {
  if (config.models) return;
  try {
    const list = await engine.fetchModels(HOME);
    if (!list?.length) return;
    models = list.map(m => ({
      value: m.value,
      label: m.displayName || m.value,
      note: m.description || '',
      efforts: m.supportsEffort === false ? [] : m.supportedEffortLevels?.length ? m.supportedEffortLevels : undefined,
      source: 'claude-code',
    }));
    log.info('models loaded', models.map(m => m.value).join(','));
  } catch (e) {
    log.warn('load models failed', e.message);
  }
}

// 引擎进程的环境：去掉从桌面 App 继承来的会话变量，补上桌面第三方模式用的开关。
function engineEnv() {
  const env = { ...process.env };
  const inherited = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_.*|CLAUDE_CODE_(SESSION_ID|ENTRYPOINT|HOST_.*|MESSAGING_.*|CHILD_SESSION|SESSION_ATTENDED|PROVIDER_MANAGED_BY_HOST|DESKTOP_.*|DIAGNOSTICS_FILE|STARTUP_.*|EMIT_.*|TERMINAL_MCP_TOOLS|OAUTH_SCOPES|SDK_HAS_HOST_AUTH_REFRESH|REPORT_FINDINGS|CLASSIFIER_SUMMARY|SIMPLE|MODEL_CATALOG))$/;
  for (const k of Object.keys(env)) if (inherited.test(k)) delete env[k];
  return {
    ...env,
    CLAUDE_AGENT_SDK_CLIENT_APP: `claude-mobile/${VERSION}`,
    CLAUDE_CODE_ENABLE_AUTO_MODE: '1',
    CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL: 'true',
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    CLAUDE_CODE_DISABLE_FAST_MODE: '1',
    CLAUDE_CODE_EAGER_FLUSH: '1',
    CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
  };
}

// 已知密钥登记进脱敏表：日志和返回页面的错误里都不会出现
addSecrets(Object.entries({ ...process.env, ...(readJsonFile(path.join(CLAUDE_DIR, 'settings.json'), {}).env || {}) })
  .filter(([k]) => /TOKEN|KEY|SECRET|PASSWORD/i.test(k)).map(([, v]) => v));

const auth = new Auth(PRIVATE);
const sessionSettings = new SettingsStore(path.join(PRIVATE, 'session-settings.json'));
const sendLedger = new SendLedger(24 * 3600 * 1000, 2000, path.join(PRIVATE,'send-ledger.json'));
const uploads = new UploadStore(path.join(PRIVATE, 'uploads'));
const blobs = new BlobStore();
const engine = new Engine({ log, uploadsDir: uploads.root, env: engineEnv() });
const hub = new Hub({ claudeDir: CLAUDE_DIR, privateDir: PRIVATE, workspaceDir: WORKSPACE, engine, blobs, log });
const peer = new DesktopPeer({claudeDir:CLAUDE_DIR,onStatus:status=>hub.broadcast('delivery',status)});

// ---------- 安全检查 ----------

function hostname(req) {
  return String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
}

function isLoopback(req) {
  const ip = req.socket.remoteAddress || '';
  return (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') && ['localhost', '127.0.0.1'].includes(hostname(req));
}

function hostAllowed(req) {
  const h = hostname(req);
  return h === 'localhost' || h === '127.0.0.1' || listeners.addresses.includes(h);
}

function authorized(req, res) {
  if (config.trust_loopback && isLoopback(req)) return true;
  const r = auth.check(req);
  if (r.ok && r.refresh) res.setHeader('Set-Cookie', auth.cookieHeader(auth.issue()));
  return r.ok;
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};
const CSP = "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

// ---------- 静态页面 ----------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, route) {
  const rel = route === '/' ? 'index.html' : decodeURIComponent(route.slice(1));
  const file = path.resolve(WEB, rel);
  if (!file.startsWith(`${WEB}${path.sep}`)) return sendJson(res, 404, { error: '找不到页面' });
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return sendJson(res, 404, { error: '找不到页面' });
  }
  if (!stat.isFile()) return sendJson(res, 404, { error: '找不到页面' });
  const ext = path.extname(file);
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    ETag: etag,
    'Cache-Control': ['.png', '.ico'].includes(ext) ? 'public, max-age=86400' : 'no-cache',
  };
  if (ext === '.html') headers['Content-Security-Policy'] = CSP;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  fs.createReadStream(file).pipe(res);
}

// ---------- 业务 ----------

function resolveCwd(value) {
  let p = typeof value === 'string' ? value.trim() : '';
  if (!p || p === '~') p = HOME;
  else if (p.startsWith('~/')) p = path.join(HOME, p.slice(2));
  if (!path.isAbsolute(p)) throw new HttpError(400, '工作目录需要是绝对路径');
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    throw new HttpError(400, `目录不存在：${p}`);
  }
  if (!st.isDirectory()) throw new HttpError(400, `不是目录：${p}`);
  return p;
}

// p 里显式给出的设置覆盖 base；思考强度按所选模型实际支持的档位校验。
function pickSettings(p, base) {
  const out = { model: base.model, effort: base.effort, permissionMode: base.permissionMode };
  if (typeof p.model === 'string' && /^[\w.\-[\]]{1,80}$/.test(p.model)) out.model = p.model;
  if (EFFORTS.includes(p.effort)) out.effort = p.effort;
  if (PERMISSION_MODES.includes(p.permissionMode)) out.permissionMode = p.permissionMode;
  const levels = modelInfo(out.model)?.efforts;
  if (levels && out.effort && !levels.includes(out.effort)) {
    if (EFFORTS.includes(p.effort)) throw new HttpError(400, levels.length ? `${out.model} 不支持“${p.effort}”思考强度，可选：${levels.join('/')}` : `${out.model} 不支持调节思考强度`);
    out.effort = levels.length ? levels[levels.length > 1 ? 1 : 0] : null;
  }
  return out;
}

// 继续已有对话时的设置基准：手机上为这条对话选过的 > 记录里最近一轮实际用的 > 全局默认
function baseFor(id) {
  const actual = hub.actualSettings(id) || {};
  const chosen = sessionSettings.get(id) || {};
  const pick = k => chosen[k] ?? actual[k] ?? config.defaults[k];
  return { model: pick('model'), effort: pick('effort'), permissionMode: chosen.permissionMode ?? config.defaults.permissionMode };
}

function titleFrom(text) {
  const line = String(text || '').trim().split('\n')[0].trim();
  return (line.length > 40 ? `${line.slice(0, 40)}…` : line) || '手机对话';
}

async function handleSend(p) {
  const clientId = typeof p.clientMessageId === 'string' && isSessionId(p.clientMessageId) ? p.clientMessageId : crypto.randomUUID();
  const prior = sendLedger.claim(clientId);
  if (prior?.state === 'done') return {...prior.result,duplicate:true};
  if (prior) throw new HttpError(409, '这条消息正在投递，请等待电脑确认', {code:'in_flight'});
  try {
    const result=await performSend({...p,clientMessageId:clientId});
    sendLedger.done(clientId,result);return result;
  } catch(e) {sendLedger.fail(clientId);throw e;}
}

async function performSend(p) {
  const text = typeof p.text === 'string' ? p.text : '';
  if (text.length > 100000) throw new HttpError(413, '消息太长了');
  const ids = Array.isArray(p.attachments) ? p.attachments : [];
  if (ids.length > MAX_ATTACHMENTS) throw new HttpError(400, `每条消息最多 ${MAX_ATTACHMENTS} 个附件`);
  const atts = ids.map(id => uploads.get(id));
  if (atts.some(a => !a)) throw new HttpError(410, '有附件已经失效，请重新添加');
  if (atts.reduce((n, a) => n + a.size, 0) > MAX_TOTAL) throw new HttpError(413, '附件总共不能超过 40 MB');
  if (!text.trim() && !atts.length) throw new HttpError(400, '请输入内容');

  let sessionId = p.sessionId || null;
  let cwd;
  let resume = false;
  let title;
  let releaseWhenIdle = false;
  let desktopTarget = null;
  if (sessionId) {
    if (!isSessionId(sessionId)) throw new HttpError(400, '无效的对话');
    hub.refreshLive();
    const meta = await hub.meta(sessionId);
    if (!meta) throw new HttpError(404, '找不到这条对话');
    // 同一时间只允许一个进程写这条对话。电脑（桌面 App / 终端）有进程开着它时：
    // 正在运行 → 拒绝（手机无法插进电脑正在执行的任务）；空闲 → 需要用户明确确认“接管”。
    const holder = meta.live;
    if (meta.source === 'desktop' || holder?.by === 'desktop') {
      desktopTarget = peer.target(sessionId);
      if (!desktopTarget) throw new HttpError(409, '请先在电脑 Claude 里打开这条对话；手机不会另起进程接管', {code:'desktop_unavailable'});
    }
    if (holder && !desktopTarget) {
      const where = holder.by === 'terminal' ? '终端' : '电脑 Claude 应用';
      if (holder.status !== 'idle') throw new HttpError(409, `${where}正在执行这条对话，等它完成后再从手机继续`, { code: 'held_busy', by: holder.by });
      if (!p.takeover) throw new HttpError(409, `${where}里开着这条对话`, { code: 'takeover_required', by: holder.by });
      log.info('takeover', sessionId, holder.by);
    }
    if (!engine.has(sessionId)) {
      cwd = meta.cwd ? resolveCwd(meta.cwd) : HOME;
      resume = true;
      releaseWhenIdle = meta.source !== 'mobile';
    }
  } else {
    cwd = resolveCwd(p.cwd || config.defaults.cwd);
  }
  const settings = desktopTarget ? {} : pickSettings(p, sessionId ? baseFor(sessionId) : config.defaults);

  const clientId = p.clientMessageId;
  try {
    if (!sessionId) {
      sessionId = crypto.randomUUID();
      title = titleFrom(text) === '手机对话' && atts.length ? '图片' : titleFrom(text);
      hub.markOwn(sessionId, { title });
    }
  const content = [];
  for (const a of atts) if (a.kind === 'image') content.push(uploads.imageBlock(a));
  const notes = atts.map(a => `- ${a.kind === 'image' ? '图片' : '文件'} ${a.name}：${a.file}`);
  const body = [text.trim(), notes.length ? `${ATTACH_HEAD}\n${notes.join('\n')}` : ''].filter(Boolean).join('\n\n');
  content.push({ type: 'text', text: body });

  if (desktopTarget) {
    const result = await peer.send(desktopTarget, body, clientId || crypto.randomUUID());
    hub.refresh(sessionId);
    return result;
  }
  engine.send({ sessionId, resume, cwd, content, title, uuid: clientId || undefined, releaseWhenIdle, ...settings });
  sessionSettings.set(sessionId, settings);
  const result = { ok: true, sessionId };
  return result;
  } catch (e) {
    throw e;
  }
}

async function handleConfigure(p) {
  const id = isSessionId(p.sessionId) ? p.sessionId : null;
  const settings = pickSettings(p, id ? baseFor(id) : config.defaults);
  if (id) {
    const meta = await hub.meta(id);
    if (meta?.source === 'desktop' || meta?.live?.by === 'desktop') throw new HttpError(409, '电脑原会话的模型和思考强度请在电脑调整，手机会同步显示实际值', {code:'desktop_settings'});
    if (engine.has(id)) await engine.configure(id, settings);
    sessionSettings.set(id, settings);
  }
  if (p.saveDefault || !id) {
    config.defaults = { ...config.defaults, ...settings };
    if (typeof p.cwd === 'string') config.defaults.cwd = p.cwd.startsWith(HOME) ? `~${p.cwd.slice(HOME.length)}` : p.cwd;
    saveConfig();
  }
  return { ok: true, defaults: config.defaults, engine: id ? engine.state(id) : null, next: id ? sessionSettings.get(id) : null };
}

function serveFile(res, file, mime, name, inline) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return sendJson(res, 404, { error: '文件不存在' });
  }
  res.writeHead(200, {
    'Content-Type': mime || 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    'Cache-Control': 'private, max-age=86400',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
  });
  fs.createReadStream(file).pipe(res);
}

function openEvents(req, res, url) {
  const clientId = url.searchParams.get('client');
  if (!clientId || !/^[\w-]{8,64}$/.test(clientId)) return sendJson(res, 400, { error: '缺少 client' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 2000\nevent: hello\ndata: ${JSON.stringify({ version: VERSION, now: Date.now() })}\n\n`);
  hub.addClient(clientId, res);
  const ping = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 15000);
  req.on('close', () => {
    clearInterval(ping);
    hub.removeClient(clientId, res);
  });
}

async function route(req, res) {
  const url = new URL(req.url, 'http://local');
  const r = url.pathname;
  const q = k => url.searchParams.get(k);

  if (!hostAllowed(req)) return sendJson(res, 403, { error: '不允许的访问地址' });
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

  if (!r.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: '不支持' });
    return serveStatic(req, res, r);
  }

  if (req.method === 'POST') {
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) return sendJson(res, 403, { error: '来源不匹配' });
  }

  if (r === '/api/ping') return sendJson(res, 200, { ok: true, paired: authorized(req, res), version: VERSION, build: BUILD });

  if (r === '/api/pair' && req.method === 'POST') {
    const p = await readJson(req, 4096);
    const result = auth.pair(req.socket.remoteAddress || '', p.secret);
    if (!result.ok) return sendJson(res, result.status, { error: result.error });
    log.info('device paired', req.socket.remoteAddress, String(req.headers['user-agent'] || '').slice(0, 120));
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.cookieHeader(auth.issue()) });
  }

  if (!authorized(req, res)) return sendJson(res, 401, { error: '需要配对', code: 'unpaired' });

  if (r === '/api/events' && req.method === 'GET') return openEvents(req, res, url);

  if (r === '/api/state' && req.method === 'GET') {
    return sendJson(res, 200, {
      version: VERSION,
      home: HOME,
      workspace: WORKSPACE,
      port: config.port,
      addresses: listeners.addresses.filter(a => a !== '127.0.0.1'),
      defaults: config.defaults,
      build: BUILD,
      models,
      efforts: EFFORTS,
      modes: PERMISSION_MODES,
      projects: await hub.projects(),
      engine: engine.states(),
    });
  }

  if (r === '/api/sessions' && req.method === 'GET') {
    return sendJson(res, 200, await hub.list({ q: q('q') || '', source: q('source') || '', offset: Number(q('offset')) || 0, limit: Math.min(Number(q('limit')) || 50, 200) }));
  }

  if (r === '/api/session' && req.method === 'GET') {
    const id = q('id');
    if (!isSessionId(id)) throw new HttpError(400, '无效的对话');
    if (q('client')) hub.subscribe(q('client'), id);
    const meta = await hub.meta(id);
    if (!meta) throw new HttpError(404, '找不到这条对话');
    const data = await hub.open(id);
    return sendJson(res, 200, { meta, ...data, actual: hub.actualSettings(id), next: sessionSettings.get(id), engine: engine.state(id), partial: engine.sessions.get(id)?.partialPayload() ?? null });
  }

  if (r === '/api/session/older' && req.method === 'GET') {
    const id = q('id');
    if (!isSessionId(id)) throw new HttpError(400, '无效的对话');
    return sendJson(res, 200, await hub.older(id, q('before')));
  }

  if (r === '/api/subscribe' && req.method === 'POST') {
    const p = await readJson(req);
    hub.subscribe(p.client, isSessionId(p.sessionId) ? p.sessionId : null);
    return sendJson(res, 200, { ok: true });
  }

  if (r === '/api/tool-output' && req.method === 'GET') {
    const text = hub.toolOutput(q('id'), q('tool'));
    if (text === null) throw new HttpError(404, '输出已经不在缓存里了，刷新对话后再试');
    return sendJson(res, 200, { text: text.length > 400000 ? `${text.slice(0, 400000)}\n…（内容过长，已截断）` : text });
  }

  if (r === '/api/send' && req.method === 'POST') return sendJson(res, 200, await handleSend(await readJson(req, 512 * 1024)));

  if (r === '/api/stop' && req.method === 'POST') {
    const p = await readJson(req);
    const meta = await hub.meta(p.sessionId);
    if (meta?.source === 'desktop' || meta?.live?.by === 'desktop') throw new HttpError(409, '这条通道暂不支持停止电脑任务，请在电脑操作');
    await engine.stop(p.sessionId);
    return sendJson(res, 200, { ok: true });
  }

  if (r === '/api/answer' && req.method === 'POST') {
    const p = await readJson(req, 64 * 1024);
    engine.answer(p.sessionId, p.requestId, p);
    return sendJson(res, 200, { ok: true });
  }

  if (r === '/api/configure' && req.method === 'POST') return sendJson(res, 200, await handleConfigure(await readJson(req)));

  if (r === '/api/rename' && req.method === 'POST') {
    const p = await readJson(req);
    const title = String(p.title || '').trim().slice(0, 80);
    if (!isSessionId(p.sessionId) || !title) throw new HttpError(400, '标题不能为空');
    if (!hub.own[p.sessionId]) throw new HttpError(403, '电脑上的对话请在电脑上改名');
    await renameSession(p.sessionId, title);
    hub.refresh(p.sessionId);
    return sendJson(res, 200, { ok: true });
  }

  if (r === '/api/upload' && req.method === 'POST') {
    if (!req.headers['x-file-name']) throw new HttpError(400, '缺少文件名');
    let name = 'file';
    try { name = decodeURIComponent(String(req.headers['x-file-name'])); } catch {}
    const buf = await readBody(req, UPLOAD_LIMIT + 1);
    return sendJson(res, 200, publicUpload(await uploads.save(buf, name, req.headers['content-type'])));
  }

  const up = /^\/api\/upload\/([a-f0-9]{24})$/.exec(r);
  if (up && req.method === 'GET') {
    const meta = uploads.get(up[1]);
    if (!meta) throw new HttpError(404, '附件不存在');
    return serveFile(res, meta.file, meta.mime, meta.name, meta.kind === 'image' || meta.mime === 'application/pdf' || meta.mime === 'text/plain');
  }

  const blob = /^\/api\/blob\/([a-f0-9]{40})$/.exec(r);
  if (blob && req.method === 'GET') {
    const b = blobs.get(blob[1]);
    if (!b) throw new HttpError(404, '图片已从缓存移除，刷新对话后再看');
    res.writeHead(200, { 'Content-Type': b.mime, 'Content-Length': b.buf.length, 'Cache-Control': 'private, max-age=604800, immutable' });
    return res.end(b.buf);
  }

  throw new HttpError(404, '没有这个接口');
}

async function handler(req, res) {
  try {
    await route(req, res);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status >= 500) log.error('request failed', req.method, req.url, e);
    // 内部错误不把原始信息返回页面（可能含路径、地址等），详情只进脱敏后的日志
    if (!res.headersSent) sendJson(res, status, { error: status >= 500 ? 'Mac 上的服务出错了，详情见日志' : redact(e.message || '出错了'), ...(e.extra || {}) });
    else res.end();
  }
}

// ---------- 启动 ----------

const listeners = new Listeners({ port: config.port, handler, log });

async function syncAddresses() {
  const lan = config.bind_host === 'auto' ? lanAddresses() : [config.bind_host];
  await listeners.sync(['127.0.0.1', ...lan]);
}

hub.start();
await syncAddresses();
const addressTimer = setInterval(() => syncAddresses().catch(e => log.warn('address sync failed', e.message)), 10000);
loadModels();
log.info(`Claude Mobile ${VERSION} (${BUILD}) ready`, listeners.addresses.map(a => `http://${a}:${config.port}/`).join(' '));

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down', signal);
  clearInterval(addressTimer);
  hub.stop();
  void peer.close();
  engine.shutdown();
  listeners.closeAll();
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', e => log.error('unhandled rejection', e));
process.on('uncaughtException', e => {
  log.error('uncaught exception', e);
  shutdown('uncaughtException');
});
