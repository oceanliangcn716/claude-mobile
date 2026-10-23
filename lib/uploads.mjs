import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MB, HttpError, writeFileAtomic } from './util.mjs';

const run = promisify(execFile);

export const UPLOAD_LIMIT = 16 * MB;
export const MAX_ATTACHMENTS = 8;
export const MAX_TOTAL = 40 * MB;

// 发给模型的图片：长边不超过 2048，单张控制在 3.5 MB 以内（接口上限 5 MB）。
const SEND_MAX_EDGE = 2048;
const SEND_MAX_BYTES = 3.5 * MB;
const API_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function sniff(buf) {
  const head = buf.subarray(0, 16);
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (head.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 32).toString('latin1');
    if (/heic|heix|hevc|hevx|mif1|msf1/.test(brand)) return 'image/heic';
    if (/avif/.test(brand)) return 'image/avif';
  }
  if (head.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  return null;
}

function safeName(name) {
  const base = path.basename(String(name || 'file')).replace(/[\u0000-\u001f/\\:*?"<>|]+/g, '_').replace(/^\.+/, '').trim();
  return (base || 'file').slice(0, 120);
}

async function imageSize(file) {
  try {
    const { stdout } = await run('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { timeout: 15000 });
    const w = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1]);
    const h = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1]);
    return w && h ? { w, h } : null;
  } catch {
    return null;
  }
}

export class UploadStore {
  constructor(root) {
    this.root = root;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  #dir(id) {
    if (!/^[a-f0-9]{24}$/.test(String(id))) throw new HttpError(400, '无效的附件');
    return path.join(this.root, id);
  }

  async save(buf, rawName, declaredType) {
    if (!buf.length) throw new HttpError(400, '文件是空的');
    if (buf.length > UPLOAD_LIMIT) throw new HttpError(413, '单个附件不能超过 16 MB');
    const id = crypto.randomBytes(12).toString('hex');
    const dir = this.#dir(id);
    fs.mkdirSync(dir, { mode: 0o700 });
    let name = safeName(rawName);
    let mime = sniff(buf) || String(declaredType || '').split(';')[0].trim() || 'application/octet-stream';
    let file = path.join(dir, name);
    fs.writeFileSync(file, buf, { mode: 0o600 });

    // iPhone 照片常是 HEIC，模型不收；在 Mac 本地用 sips 转成 JPG。
    if (mime === 'image/heic' || mime === 'image/avif') {
      const jpg = path.join(dir, `${name.replace(/\.[^.]+$/, '') || 'photo'}.jpg`);
      try {
        await run('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '88', file, '--out', jpg], { timeout: 60000 });
        fs.chmodSync(jpg, 0o600);
        fs.rmSync(file, { force: true });
        file = jpg;
        name = path.basename(jpg);
        mime = 'image/jpeg';
      } catch {
        throw new HttpError(422, '这张照片转换失败，可以在相册里先导出为 JPG 再发');
      }
    }

    const kind = API_IMAGE_TYPES.has(mime) ? 'image' : 'file';
    const meta = { id, name, mime, kind, size: fs.statSync(file).size, file, created: Date.now() };
    if (kind === 'image') {
      const dims = await imageSize(file);
      if (dims) Object.assign(meta, { width: dims.w, height: dims.h });
      meta.sendFile = await this.#prepareForModel(file, dir, mime, meta);
    }
    writeFileAtomic(path.join(dir, 'meta.json'), JSON.stringify(meta), 0o600);
    return meta;
  }

  async #prepareForModel(file, dir, mime, meta) {
    const big = (meta.width || 0) > SEND_MAX_EDGE || (meta.height || 0) > SEND_MAX_EDGE;
    if (!big && meta.size <= SEND_MAX_BYTES) return file;
    const out = path.join(dir, '.send.jpg');
    try {
      await run('/usr/bin/sips', ['-Z', String(SEND_MAX_EDGE), '-s', 'format', 'jpeg', '-s', 'formatOptions', '82', file, '--out', out], { timeout: 60000 });
      fs.chmodSync(out, 0o600);
      return out;
    } catch {
      return meta.size <= SEND_MAX_BYTES ? file : null;
    }
  }

  get(id) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(this.#dir(id), 'meta.json'), 'utf8'));
      return fs.existsSync(meta.file) ? meta : null;
    } catch {
      return null;
    }
  }

  // 发给 SDK 的图片块
  imageBlock(meta) {
    const file = meta.sendFile || meta.file;
    const mime = meta.sendFile && meta.sendFile.endsWith('.send.jpg') ? 'image/jpeg' : meta.mime;
    return { type: 'image', source: { type: 'base64', media_type: mime, data: fs.readFileSync(file).toString('base64') } };
  }
}

export function publicUpload(meta) {
  return { id: meta.id, name: meta.name, mime: meta.mime, kind: meta.kind, size: meta.size, width: meta.width, height: meta.height, url: `/api/upload/${meta.id}` };
}
