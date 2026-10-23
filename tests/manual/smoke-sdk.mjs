// 手动付费测试：只有明确设置 ALLOW_PAID_TESTS=1 才执行。
if (process.env.ALLOW_PAID_TESTS !== '1') {
  console.error('未执行：此测试会调用模型并可能修改工作区。确认后设置 ALLOW_PAID_TESTS=1。');
  process.exit(2);
}
// 开发用冒烟测试：确认 Agent SDK 能用 ~/.claude/settings.json 里的中转配置完成一次最小请求。
// 用法：node tests/manual/smoke-sdk.mjs [model]
import { query } from '@anthropic-ai/claude-agent-sdk';
const model = process.argv[2] || 'haiku';
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
setTimeout(() => { log('TIMEOUT'); process.exit(2); }, 25000).unref();
const q = query({ prompt: '只回复两个字：收到', options: {
  model, cwd: process.env.HOME, maxTurns: 1, permissionMode: 'default',
  systemPrompt: { type: 'preset', preset: 'claude_code' }, tools: [],
  persistSession: false,
  env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'claude-mobile/smoke', CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1' },
  stderr: d => log('[cli]', String(d).trim().slice(0, 300)),
} });
try {
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') {
      log('init model=%s mode=%s apiKeySource=%s version=%s', m.model, m.permissionMode, m.apiKeySource, m.claude_code_version);
      q.supportedModels().then(ms => log('models:', ms.map(x => `${x.value}${x.supportsEffort ? '(effort:' + (x.supportedEffortLevels || []).join('/') + ')' : ''}${x.supportsAutoMode ? '[auto]' : ''}`).join(', '))).catch(e => log('models failed', e.message));
    } else if (m.type === 'assistant') log('assistant:', JSON.stringify(m.message.content.map(b => b.type === 'text' ? b.text : b.type)), m.error || '');
    else if (m.type === 'result') { log('result:', m.subtype, 'is_error=' + m.is_error, (m.errors || []).join(';'), 'cost=$' + m.total_cost_usd); }
    else if (m.subtype === 'api_retry') log('api_retry', 'attempt=' + m.attempt, 'status=' + m.error_status, 'error=' + m.error, JSON.stringify(m.no_response || {})); else log('msg', m.type, m.subtype || '');
  }
  log('done');
} catch (e) { log('FAILED:', e.message); process.exitCode = 1; }
