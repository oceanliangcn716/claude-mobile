// 手动付费测试：只有明确设置 ALLOW_PAID_TESTS=1 才执行。
if (process.env.ALLOW_PAID_TESTS !== '1') {
  console.error('未执行：此测试会调用模型并可能修改工作区。确认后设置 ALLOW_PAID_TESTS=1。');
  process.exit(2);
}
// 端到端接口测试：新建一条手机对话、观察 SSE 事件、自动处理权限请求，最后读出对话内容。
// 用法：node tests/manual/e2e-api.mjs [permissionMode] [prompt]
const BASE = process.env.BASE || 'http://127.0.0.1:3082';
const mode = process.argv[2] || 'default';
const prompt = process.argv[3] || '在当前目录创建 hello.txt，内容是 hi from phone，然后用 Read 读出来告诉我内容。';
const client = `test-${Date.now()}`;
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${p} ${r.status} ${JSON.stringify(j)}`);
  return j;
};

let sessionId = null;
let done;
const finished = new Promise(r => { done = r; });
const answered = new Set();

const es = await fetch(`${BASE}/api/events?client=${client}`);
(async () => {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of es.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (.+)$/m.exec(frame)?.[1];
      const data = /^data: (.+)$/m.exec(frame)?.[1];
      if (!ev || !data) continue;
      const d = JSON.parse(data);
      if (ev === 'engine' && d.sessionId === sessionId && d.state) {
        const s = d.state;
        log('engine', s.state, s.status || '', s.retry ? `retry#${s.retry.attempt} ${s.retry.error}` : '', s.error ? `error=${s.error}` : '', `pending=${s.pending.length}`);
        for (const p of s.pending) {
          if (answered.has(p.id)) continue;
          answered.add(p.id);
          log('  permission request:', p.kind, p.toolName, p.label, p.summary, p.title || '');
          await post('/api/answer', { sessionId, requestId: p.id, decision: 'allow' });
          log('  -> allowed');
        }
        if (s.state === 'idle' && s.lastResult) done();
      } else if (ev === 'partial' && d.sessionId === sessionId) {
        const b = d.blocks?.at(-1);
        if (b) process.stdout.write(`\r[partial ${b.type}] ${b.text.slice(-60).replace(/\n/g, ' ')}`.padEnd(90));
      } else if (ev === 'transcript' && d.sessionId === sessionId) {
        console.log();
        log(`transcript v${d.version} (+${d.upserts.length}${d.order ? ', reorder' : ''})`, d.upserts.map(u => `${u.kind}${u.label ? ':' + u.label : ''}${u.status ? '/' + u.status : ''}`).join(' '));
      }
    }
  }
})();

await new Promise(r => setTimeout(r, 300));
const sent = await post('/api/send', { text: prompt, cwd: process.env.CWD || '~/.local/share/claude-mobile/mobile-workspace', permissionMode: mode, effort: 'low' });
sessionId = sent.sessionId;
await post('/api/subscribe', { client, sessionId });
log('sent, session', sessionId);
const timer = setTimeout(() => { log('TIMEOUT'); process.exit(2); }, 180000);
await finished;
clearTimeout(timer);
const s = await (await fetch(`${BASE}/api/session?id=${sessionId}&client=${client}`)).json();
log('final transcript items:');
for (const it of s.items) console.log('   ', it.kind.padEnd(9), (it.label || '').padEnd(4), JSON.stringify(it.summary ?? it.text ?? '').slice(0, 100), it.status || '');
log('meta', JSON.stringify({ title: s.meta.title, source: s.meta.source, project: s.meta.project }), 'engine', s.engine?.state, 'cost', s.engine?.lastResult?.cost);
process.exit(0);
