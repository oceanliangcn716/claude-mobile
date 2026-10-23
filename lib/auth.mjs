import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeEqual, writeFileAtomic } from './util.mjs';

const COOKIE = 'claude_mobile';
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
// 每天最多续期一次：经常使用的手机不会过期，闲置 30 天才需要重新配对。
const REFRESH_AFTER_MS = 24 * 3600 * 1000;
const LOCK_AFTER = 8;
const LOCK_MS = 10 * 60 * 1000;

export class Auth {
  constructor(privateDir) {
    this.file = path.join(privateDir, 'pair.secret');
    this.failures = new Map();
    this.secret = this.#load();
  }

  #load() {
    try {
      const s = fs.readFileSync(this.file, 'utf8').trim();
      if (s.length >= 32) return s;
    } catch {}
    return this.rotate();
  }

  // 更换配对密钥后，所有已配对的设备都需要重新配对。
  rotate() {
    const s = crypto.randomBytes(32).toString('base64url');
    writeFileAtomic(this.file, `${s}\n`, 0o600);
    this.secret = s;
    return s;
  }

  #sign(payload) {
    return crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  issue() {
    const payload = `v1.${crypto.randomBytes(12).toString('base64url')}.${Date.now() + MAX_AGE_MS}`;
    return `${payload}.${this.#sign(payload)}`;
  }

  cookieHeader(value) {
    return `${COOKIE}=${value}; Path=/; Max-Age=${MAX_AGE_MS / 1000}; HttpOnly; SameSite=Strict`;
  }

  check(req) {
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie || '');
    if (!m) return { ok: false };
    const parts = m[1].split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return { ok: false };
    const exp = Number(parts[2]);
    if (!safeEqual(parts[3], this.#sign(parts.slice(0, 3).join('.'))) || !(exp > Date.now())) return { ok: false };
    return { ok: true, refresh: exp - Date.now() < MAX_AGE_MS - REFRESH_AFTER_MS };
  }

  pair(ip, secret) {
    const f = this.failures.get(ip);
    if (f && f.count >= LOCK_AFTER && Date.now() - f.time < LOCK_MS) {
      return { ok: false, status: 429, error: '尝试次数太多，请 10 分钟后再试' };
    }
    if (typeof secret === 'string' && safeEqual(secret.trim(), this.secret)) {
      this.failures.delete(ip);
      return { ok: true };
    }
    this.failures.set(ip, { count: (f && Date.now() - f.time < LOCK_MS ? f.count : 0) + 1, time: Date.now() });
    return { ok: false, status: 403, error: '配对链接无效，可能已经更换过' };
  }
}
