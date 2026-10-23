import os from 'node:os';
import http from 'node:http';
import { isIP } from 'node:net';

// 只绑定私有网段（家庭局域网、Tailscale 100.64/10），从不绑定 0.0.0.0。
const PRIVATE = [
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

export function lanAddresses() {
  const rows = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const r of list || []) {
      if (r.family === 'IPv4' && !r.internal && PRIVATE.some(re => re.test(r.address))) rows.push({ name, address: r.address });
    }
  }
  rows.sort((a, b) => (a.name === 'en0' ? -1 : b.name === 'en0' ? 1 : a.name.localeCompare(b.name)));
  return [...new Set(rows.map(r => r.address))];
}

export function allowedBindAddress(addr) {
  return isIP(addr) === 4 && (addr === '127.0.0.1' || PRIVATE.some(re => re.test(addr)));
}

// 每个地址一个 http.Server。Mac 换地址时 sync() 会关闭旧监听并创建新监听。
export class Listeners {
  constructor({ port, handler, log }) {
    this.port = port;
    this.handler = handler;
    this.log = log;
    this.servers = new Map();
  }

  get addresses() {
    return [...this.servers.keys()];
  }

  async sync(wanted) {
    for (const [addr, srv] of this.servers) {
      if (wanted.includes(addr)) continue;
      srv.close();
      srv.closeAllConnections?.();
      this.servers.delete(addr);
      this.log.info('stop listening', addr);
    }
    for (const addr of wanted) {
      if (!allowedBindAddress(addr)) {
        this.log.warn('ignored non-private bind address');
        continue;
      }
      if (!this.servers.has(addr)) await this.#listen(addr);
    }
  }

  #listen(addr) {
    return new Promise(resolve => {
      const srv = http.createServer(this.handler);
      srv.requestTimeout = 10 * 60 * 1000;
      srv.headersTimeout = 30 * 1000;
      srv.keepAliveTimeout = 65 * 1000;
      srv.once('error', e => {
        this.log.warn('listen failed', `${addr}:${this.port}`, e.code || e.message);
        resolve(false);
      });
      srv.listen(this.port, addr, () => {
        this.servers.set(addr, srv);
        this.log.info('listening', `http://${addr}:${this.port}/`);
        resolve(true);
      });
    });
  }

  closeAll() {
    for (const srv of this.servers.values()) {
      srv.close();
      srv.closeAllConnections?.();
    }
    this.servers.clear();
  }
}
