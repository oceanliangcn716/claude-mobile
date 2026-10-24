import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MB = 1024 * 1024;

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function sendJson(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

export async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, '内容太大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, limit = 256 * 1024) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, '需要 JSON 请求');
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON 格式错误');
  }
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeFileAtomic(file, data, mode = 0o600) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

export function sha1(value) {
  return crypto.createHash('sha1').update(value).digest('hex');
}

// ---------- 脱敏：日志和返回给页面的错误都先过一遍 ----------

const SECRETS = new Set();

// 登记已知的密钥值（令牌、API Key），出现在任何文本里都会被替换。
export function addSecrets(values) {
  for (const v of values) if (typeof v === 'string' && v.length >= 8) SECRETS.add(v);
}

const PATTERNS = [
  [/\b(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]{8,}/g, '$1…<已隐藏>'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <已隐藏>'],
  [/((?:api[_-]?key|auth[_-]?token|access[_-]?token|token|secret|password|authorization|x-api-key|cookie)["']?\s*[:=]\s*["']?)[^\s"',;}&]{6,}/gi, '$1<已隐藏>'],
  [/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1<已隐藏>@'],
  [/(https?:\/\/[^\s?#"']+)\?[^\s"')]*/gi, '$1?<已隐藏>'],
  [/\b(claude_mobile|pair)=([A-Za-z0-9._-]{16,})/g, '$1=<已隐藏>'],
];

export function redact(value) {
  let s = String(value ?? '');
  for (const secret of SECRETS) if (s.includes(secret)) s = s.split(secret).join('<已隐藏>');
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  return s;
}

// 简单的文件日志：超过 5 MB 轮转一次，避免长期运行把磁盘写满。
export function createLogger(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let stream = fs.createWriteStream(file, { flags: 'a', mode: 0o600 });
  let written = 0;
  try { written = fs.statSync(file).size; } catch {}
  const format = a => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a));
  const write = (level, args) => {
    const line = `${new Date().toISOString()} ${level} ${redact(args.map(format).join(' '))}\n`;
    if (written > 5 * MB) {
      stream.end();
      try { fs.renameSync(file, `${file}.1`); } catch {}
      stream = fs.createWriteStream(file, { flags: 'a', mode: 0o600 });
      written = 0;
    }
    written += Buffer.byteLength(line);
    stream.write(line);
    if (process.stdout.isTTY) process.stdout.write(line);
  };
  return {
    info: (...a) => write('INFO', a),
    warn: (...a) => write('WARN', a),
    error: (...a) => write('ERROR', a),
  };
}
