#!/usr/bin/env node
// 本机生成配对链接并直接交给系统剪贴板；不打印配对密钥。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { lanAddresses } from '../lib/net.mjs';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
try {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  const port = config.port || 3082;
  const response = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error('not ready');
  const ip = config.bind_host && config.bind_host !== 'auto' ? config.bind_host : lanAddresses()[0];
  if (!ip || ip === '127.0.0.1') throw new Error('no LAN');
  const secret = fs.readFileSync(path.join(root, 'private/pair.secret'), 'utf8').trim();
  if (secret.length < 32) throw new Error('no secret');
  execFileSync('/usr/bin/pbcopy', { input: `http://${ip}:${port}/#pair=${secret}` });
  console.log(`配对链接已复制。请在 iPhone Safari 地址栏粘贴打开（Mac 地址 ${ip}:${port}）。`);
} catch {
  console.error('无法生成配对链接：请确认服务已启动，并且 Mac 已连接局域网。');
  process.exitCode = 1;
}
