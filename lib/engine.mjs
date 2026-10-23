import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { query, forkSession } from '@anthropic-ai/claude-agent-sdk';
import { describeTool } from './transcript.mjs';

export const PERMISSION_MODES = ['auto', 'default', 'acceptEdits', 'plan', 'bypassPermissions'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const IDLE_CLOSE_MS = 30 * 60 * 1000;
const PARTIAL_THROTTLE_MS = 120;

const ERROR_TEXT = {
  authentication_failed: '中转站认证失败，检查 ~/.claude/settings.json 里的令牌',
  billing_error: '中转站额度或计费出错',
  rate_limit: '请求被限流（429）',
  invalid_request: '请求被拒绝（参数无效）',
  server_error: '中转站或模型服务出错',
  max_output_tokens: '回复超过了输出长度上限',
  unknown: '未知错误',
};

export function errorText(code) {
  return ERROR_TEXT[code] || String(code || '未知错误');
}

// 给 SDK 的流式输入：手机每发一条就 push 一条，任务运行中也可以继续补充。
class InputQueue {
  #items = [];
  #waiters = [];
  #closed = false;

  push(value) {
    if (this.#closed) throw new Error('输入已关闭');
    const w = this.#waiters.shift();
    if (w) w({ value, done: false });
    else this.#items.push(value);
  }

  close() {
    this.#closed = true;
    for (const w of this.#waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.#items.length) return Promise.resolve({ value: this.#items.shift(), done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise(resolve => this.#waiters.push(resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

class EngineSession {
  constructor(engine, opts) {
    this.engine = engine;
    this.sessionId = opts.sessionId;
    this.cwd = opts.cwd;
    this.model = opts.model;
    this.effort = opts.effort;
    this.permissionMode = opts.permissionMode;
    this.title = opts.title;
    this.resume = !!opts.resume;
    this.state = 'closed';
    this.status = null;
    this.retry = null;
    this.error = null;
    this.pending = new Map();
    this.partial = null;
    this.toolProgress = null;
    this.turnStartedAt = null;
    this.lastResult = null;
    this.lastActivity = Date.now();
    this.query = null;
    this.input = null;
    this.partialTimer = null;
  }

  get log() {
    return this.engine.log;
  }

  publicState() {
    return {
      sessionId: this.sessionId,
      cwd: this.cwd,
      state: this.state,
      busy: this.state === 'starting' || this.state === 'running' || this.state === 'requires_action',
      status: this.status,
      retry: this.retry,
      error: this.error,
      model: this.model,
      effort: this.effort,
      permissionMode: this.permissionMode,
      turnStartedAt: this.turnStartedAt,
      lastResult: this.lastResult,
      toolProgress: this.toolProgress,
      pending: [...this.pending.values()].map(p => p.public),
    };
  }

  start() {
    this.input = new InputQueue();
    this.state = 'starting';
    this.error = null;
    const options = {
      cwd: this.cwd,
      model: this.model || undefined,
      effort: this.effort || undefined,
      permissionMode: this.permissionMode || undefined,
      allowDangerouslySkipPermissions: true,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      tools: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      includePartialMessages: true,
      additionalDirectories: [this.engine.uploadsDir],
      canUseTool: (name, input, o) => this.#canUseTool(name, input, o),
      env: this.engine.env,
      stderr: d => this.log.warn(`[cli ${this.sessionId.slice(0, 8)}]`, String(d).trim().slice(0, 800)),
    };
    if (this.resume) options.resume = this.sessionId;
    else {
      options.sessionId = this.sessionId;
      if (this.title) options.title = this.title;
    }
    this.query = query({ prompt: this.input, options });
    this.resume = true;
    this.#pump(this.query);
    this.#emit();
  }

  async #pump(q) {
    let failure = null;
    try {
      for await (const m of q) this.#onMessage(m);
    } catch (e) {
      failure = e;
    }
    if (this.query !== q) return;
    this.query = null;
    this.input?.close();
    for (const p of this.pending.values()) p.settle({ behavior: 'deny', message: '会话已结束' }, true);
    this.pending.clear();
    this.partial = null;
    this.status = null;
    this.toolProgress = null;
    this.turnStartedAt = null;
    if (failure && !this.closing) {
      this.state = 'error';
      this.error = `Claude 进程退出：${failure.message}`;
      this.log.error('engine session failed', this.sessionId, failure);
    } else {
      this.state = 'closed';
    }
    this.closing = false;
    this.#emit();
    this.engine.emit('transcript', this.sessionId);
  }

  #onMessage(m) {
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          this.model = m.model || this.model;
          this.permissionMode = m.permissionMode || this.permissionMode;
          if (m.effort !== undefined && m.effort !== null) this.effort = m.effort;
          if (this.state === 'starting') this.state = 'running';
          this.#emit();
        } else if (m.subtype === 'session_state_changed') {
          this.state = m.state;
          if (m.state === 'idle') {
            this.status = null;
            this.toolProgress = null;
            this.turnStartedAt = null;
            this.partial = null;
            this.#emitPartial(true);
          } else if (!this.turnStartedAt) this.turnStartedAt = Date.now();
          this.#emit();
        } else if (m.subtype === 'status') {
          this.status = m.status || null;
          if (m.permissionMode) this.permissionMode = m.permissionMode;
          this.#emit();
        } else if (m.subtype === 'api_retry') {
          this.retry = { attempt: m.attempt, max: m.max_retries, status: m.error_status, error: errorText(m.error), delayMs: m.retry_delay_ms };
          this.#emit();
        } else if (m.subtype === 'compact_boundary') {
          this.engine.emit('transcript', this.sessionId);
        }
        break;
      case 'stream_event':
        if (m.parent_tool_use_id) break;
        if (this.state === 'idle' && m.event?.type === 'message_start') this.#turnStarted();
        this.#onStream(m.event);
        break;
      case 'assistant':
        if (m.parent_tool_use_id) break;
        if (this.state === 'idle') this.#turnStarted();
        if (this.retry) {
          this.retry = null;
          this.#emit();
        }
        if (m.error) {
          this.error = errorText(m.error);
          this.#emit();
        }
        this.#consumePartial(m.message?.content);
        this.engine.emit('transcript', this.sessionId, { expect: m.uuid, after: () => this.#emitPartial(true) });
        break;
      case 'user':
        if (!m.parent_tool_use_id) this.engine.emit('transcript', this.sessionId);
        break;
      case 'result':
        this.lastResult = { ok: m.subtype === 'success' && !m.is_error, cost: m.total_cost_usd, durationMs: m.duration_ms, at: Date.now() };
        // 一轮结束。session_state_changed 也会报 idle，这里先置好，避免它缺席时一直显示“运行中”。
        if (!this.pending.size) {
          this.state = 'idle';
          this.status = null;
          this.toolProgress = null;
          this.turnStartedAt = null;
        }
        if (m.is_error || m.subtype !== 'success') this.error = (m.errors || []).join('；') || m.result || '运行出错';
        else this.error = null;
        this.retry = null;
        this.lastActivity = Date.now();
        this.#emit();
        this.engine.emit('transcript', this.sessionId);
        break;
      case 'tool_progress':
        if (m.parent_tool_use_id) break;
        this.toolProgress = { toolUseId: m.tool_use_id, name: m.tool_name, seconds: Math.round(m.elapsed_time_seconds) };
        this.#emitSoon();
        break;
      default:
        break;
    }
  }

  // 排队的补充消息会在上一轮结束后直接开始新一轮
  #turnStarted() {
    this.state = 'running';
    this.turnStartedAt = Date.now();
    this.#emit();
  }

  // 正在生成的文字：先在手机上逐字显示，等这一段写进对话记录后再换成正式条目。
  #onStream(ev) {
    if (!ev) return;
    if (ev.type === 'message_start') this.partial = { blocks: [] };
    else if (ev.type === 'content_block_start') {
      const b = ev.content_block || {};
      this.partial ??= { blocks: [] };
      this.partial.blocks[ev.index] =
        b.type === 'text' ? { type: 'text', text: b.text || '' }
          : b.type === 'thinking' ? { type: 'thinking', text: b.thinking || '' }
            : b.type === 'tool_use' ? { type: 'tool', name: b.name, text: '' }
              : { type: 'other', text: '' };
    } else if (ev.type === 'content_block_delta') {
      const blk = this.partial?.blocks[ev.index];
      const d = ev.delta || {};
      if (!blk) return;
      if (d.type === 'text_delta') blk.text += d.text;
      else if (d.type === 'thinking_delta') blk.text += d.thinking;
      else if (d.type === 'input_json_delta') blk.text += d.partial_json;
    } else if (ev.type === 'content_block_stop') {
      const blk = this.partial?.blocks[ev.index];
      if (blk) blk.done = true;
    } else return;
    this.#emitPartial();
  }

  #consumePartial(content) {
    if (!this.partial) return;
    for (const b of Array.isArray(content) ? content : []) {
      const type = b.type === 'tool_use' ? 'tool' : b.type;
      const idx = this.partial.blocks.findIndex(x => x && !x.consumed && x.type === type);
      if (idx >= 0) this.partial.blocks[idx].consumed = true;
    }
  }

  partialPayload() {
    const blocks = (this.partial?.blocks || []).filter(b => b && !b.consumed && b.type !== 'other');
    if (!blocks.length) return null;
    return blocks.map(b => ({ type: b.type, name: b.name, text: b.type === 'tool' ? b.text.slice(-600) : b.text }));
  }

  #emitPartial(now = false) {
    if (now) {
      clearTimeout(this.partialTimer);
      this.partialTimer = null;
      this.engine.emit('partial', this.sessionId, this.partialPayload());
      return;
    }
    if (this.partialTimer) return;
    this.partialTimer = setTimeout(() => {
      this.partialTimer = null;
      this.engine.emit('partial', this.sessionId, this.partialPayload());
    }, PARTIAL_THROTTLE_MS);
  }

  #emit() {
    clearTimeout(this.stateTimer);
    this.stateTimer = null;
    this.engine.emit('state', this.sessionId, this.publicState());
  }

  #emitSoon() {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => this.#emit(), 1000);
  }

  #canUseTool(toolName, input, o) {
    return new Promise(resolve => {
      const id = o.requestId || o.toolUseID || crypto.randomUUID();
      const kind = toolName === 'AskUserQuestion' ? 'question' : toolName === 'ExitPlanMode' ? 'plan' : 'permission';
      const shown = describeTool(toolName, input, this.cwd);
      const pub = {
        id,
        kind,
        toolName,
        toolUseId: o.toolUseID,
        title: o.title || null,
        displayName: o.displayName || null,
        description: o.description || null,
        reason: o.decisionReason || null,
        blockedPath: o.blockedPath || null,
        canAlways: kind === 'permission' && !!o.suggestions?.length && !o.suppressAlwaysAllowRule,
        defaultToNo: !!o.defaultToNo,
        createdAt: Date.now(),
        label: shown.label,
        summary: shown.summary,
        code: shown.code,
        diff: shown.diff,
        plan: shown.plan,
        questions: shown.questions,
      };
      const onAbort = () => settle({ behavior: 'deny', message: '已取消' });
      const settle = (result, quiet) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        o.signal?.removeEventListener('abort', onAbort);
        if (this.state === 'requires_action' && !this.pending.size) this.state = 'running';
        resolve(result);
        if (!quiet) this.#emit();
      };
      if (o.signal?.aborted) return resolve({ behavior: 'deny', message: '已取消' });
      o.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { public: pub, input, suggestions: o.suggestions, settle });
      this.state = 'requires_action';
      this.#emit();
    });
  }

  answer(requestId, a) {
    const p = this.pending.get(requestId);
    if (!p) throw new Error('这个请求已经处理过了');
    const kind = p.public.kind;
    if (kind === 'question') {
      if (a.decision === 'deny') return p.settle({ behavior: 'deny', message: '用户在手机上跳过了这些问题，请按你的判断继续或换个方式询问' });
      const answers = {};
      for (const q of p.input.questions || []) {
        const v = a.answers?.[q.question];
        if (typeof v === 'string' && v.trim()) answers[q.question] = v.trim().slice(0, 4000);
      }
      return p.settle({ behavior: 'allow', updatedInput: { ...p.input, answers } });
    }
    if (kind === 'plan') {
      if (a.decision !== 'allow') return p.settle({ behavior: 'deny', message: a.message?.trim() ? `用户希望修改计划：${a.message.trim()}` : '用户暂不批准这个计划，请继续完善' });
      const mode = PERMISSION_MODES.includes(a.mode) && a.mode !== 'plan' ? a.mode : 'auto';
      this.permissionMode = mode;
      return p.settle({ behavior: 'allow', updatedInput: p.input, updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }] });
    }
    if (a.decision === 'allow') return p.settle({ behavior: 'allow', updatedInput: p.input });
    if (a.decision === 'always') return p.settle({ behavior: 'allow', updatedInput: p.input, updatedPermissions: p.suggestions || [] });
    return p.settle({ behavior: 'deny', message: a.message?.trim() ? `用户拒绝了这个操作：${a.message.trim()}` : '用户在手机上拒绝了这个操作' });
  }

  send(content, uuid) {
    if (!this.query) this.start();
    this.input.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, uuid: uuid || crypto.randomUUID() });
    this.lastActivity = Date.now();
    this.error = null;
    if (this.state === 'idle' || this.state === 'closed' || this.state === 'error') this.state = 'running';
    if (!this.turnStartedAt) this.turnStartedAt = Date.now();
    this.#emit();
  }

  async interrupt() {
    if (!this.query) return;
    for (const p of [...this.pending.values()]) p.settle({ behavior: 'deny', message: '用户停止了任务', interrupt: true }, true);
    await this.query.interrupt();
    this.#emit();
  }

  async configure({ model, effort, permissionMode }) {
    if (model && model !== this.model) {
      if (this.query) await this.query.setModel(model);
      this.model = model;
    }
    if (effort && effort !== this.effort) {
      if (this.query) await this.query.applyFlagSettings({ effortLevel: effort });
      this.effort = effort;
    }
    if (permissionMode && permissionMode !== this.permissionMode) {
      if (this.query) await this.query.setPermissionMode(permissionMode);
      this.permissionMode = permissionMode;
    }
    this.#emit();
  }

  close() {
    if (!this.query) return;
    this.closing = true;
    this.input?.close();
    this.query.close();
  }
}

export class Engine extends EventEmitter {
  constructor({ log, uploadsDir, env }) {
    super();
    this.log = log;
    this.uploadsDir = uploadsDir;
    this.env = env;
    this.sessions = new Map();
    this.reaper = setInterval(() => this.#reap(), 60 * 1000);
    this.reaper.unref();
  }

  has(id) {
    return this.sessions.has(id);
  }

  state(id) {
    return this.sessions.get(id)?.publicState() ?? null;
  }

  states() {
    return [...this.sessions.values()].map(s => s.publicState());
  }

  send({ sessionId, resume, cwd, content, model, effort, permissionMode, title, uuid }) {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = new EngineSession(this, { sessionId, resume, cwd, model, effort, permissionMode, title });
      this.sessions.set(sessionId, s);
    }
    s.send(content, uuid);
    return sessionId;
  }

  async fork(sourceId, title) {
    const { sessionId } = await forkSession(sourceId, title ? { title } : undefined);
    return sessionId;
  }

  #get(id) {
    const s = this.sessions.get(id);
    if (!s) throw new Error('这条对话不在手机引擎里运行');
    return s;
  }

  async stop(id) {
    await this.#get(id).interrupt();
  }

  answer(id, requestId, payload) {
    this.#get(id).answer(requestId, payload || {});
  }

  async configure(id, cfg) {
    await this.#get(id).configure(cfg);
  }

  // 闲置半小时的会话关掉 Claude 进程；下次发消息会自动从对话记录恢复。
  #reap() {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      const idle = (s.state === 'idle' || s.state === 'closed' || s.state === 'error') && !s.pending.size;
      if (!idle || now - s.lastActivity < IDLE_CLOSE_MS) continue;
      s.close();
      if (s.state !== 'error') this.sessions.delete(id);
      this.emit('state', id, s.state === 'error' ? s.publicState() : null);
    }
  }

  shutdown() {
    clearInterval(this.reaper);
    for (const s of this.sessions.values()) s.close();
  }
}
