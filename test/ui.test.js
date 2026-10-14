// Tests the UI server (SSE stream, approval/question round trips, stop, single run) AND its access control,
// with a scripted LLM, so no API key, browser or ERP is needed.
const { call, scripted: scriptedModel } = require('./helpers/scripted-model');
const scripted = (steps) => scriptedModel(steps, { clamp: true });
const assert = require('assert');
const http = require('http');
const fs = require('fs'), os = require('os'), path = require('path');
process.env.ERP_DB = path.join(os.tmpdir(), `ui-test-${Date.now()}.db`);
process.env.COMPANY_MEMORY = path.join(os.tmpdir(), 'cm-ui.md'); fs.writeFileSync(process.env.COMPANY_MEMORY, '# t');
const { open, reset } = require('../erp/db');
const d = open(); reset(d); d.close();
const { createApp } = require('../ui/server');
const RUNS = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-runs-')); // tests must not write into the real runs/ folder
const { createTools } = require('../agent/tools');

const toolsFactory = (ctx) => [...createTools(ctx).filter((t) => ['list_files', 'ask_human'].includes(t.name)),
  { name: 'write', risk: 'irreversible', description: 'test', parameters: { type: 'object', properties: {} }, run: async () => ({ done: true }) }];

async function openSSE(base, headers) {
  const res = await fetch(base + '/api/events', { headers });
  if (res.status !== 200) return { status: res.status };
  const reader = res.body.getReader(); const dec = new TextDecoder();
  const events = []; let buf = ''; const waiters = [];
  (async () => { for (;;) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value);
    let i; while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); const line = chunk.split('\n').find((l) => l.startsWith('data: ')); if (line) { events.push(JSON.parse(line.slice(6))); waiters.slice().forEach((w) => w()); } } } })().catch(() => {});
  const waitFor = (pred, from = 0, ms = 6000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for event')), ms);
    const check = () => { const e = events.slice(from).find(pred); if (e) { clearTimeout(t); resolve(e); return true; } return false; };
    if (!check()) { const w = () => { if (check()) waiters.splice(waiters.indexOf(w), 1); }; waiters.push(w); }
  });
  return { status: 200, events, waitFor, close: () => reader.cancel() };
}

(async () => {
  let scriptFor = () => scripted([]);
  const app = createApp({ skipErp: true, llmFactory: () => scriptFor(), toolsFactory, allowAutoApprove: false, runsDir: RUNS });
  const server = app.listen(0); const port = server.address().port; const base = `http://localhost:${port}`;

  // The "browser": load the page the way a user would, receiving the cookie and the embedded token.
  const page = await fetch(base + '/');
  const cookie = page.headers.get('set-cookie').split(';')[0];
  const html = await page.text();
  const token = html.match(/name="ui-token" content="([0-9a-f]+)"/)[1];
  assert.ok(/HttpOnly/i.test(page.headers.get('set-cookie')) && /SameSite=Strict/i.test(page.headers.get('set-cookie')), 'cookie is HttpOnly + SameSite=Strict');
  const good = { cookie, 'x-ui-token': token, 'content-type': 'application/json' };
  const post = (p, b, h = good) => fetch(base + p, { method: 'POST', headers: h, body: JSON.stringify(b || {}) });
  const get = (p, h = { cookie }) => fetch(base + p, { headers: h });

  try {
    // ---------------- access control ----------------
    assert.strictEqual((await fetch(base + '/api/state')).status, 401, 'no cookie -> 401');
    assert.strictEqual((await fetch(base + '/api/state', { headers: { cookie: 'ui_session=wrong' } })).status, 401, 'wrong cookie -> 401');
    assert.strictEqual((await fetch(base + '/api/invoices')).status, 401, 'database panel needs the session');
    assert.strictEqual((await fetch(base + '/runs/anything.png')).status, 401, 'screenshots need the session');
    assert.strictEqual((await openSSE(base, {})).status, 401, 'live stream needs the session');
    assert.strictEqual((await post('/api/run', { task: 'x' }, { cookie, 'content-type': 'application/json' })).status, 403, 'cookie alone is not enough for POST (needs x-ui-token)');
    assert.strictEqual((await post('/api/run', { task: 'x' }, { ...good, 'x-ui-token': 'nope' })).status, 403, 'wrong x-ui-token');
    assert.strictEqual((await post('/api/run', { task: 'x' }, { ...good, origin: 'http://evil.example' })).status, 403, 'cross-origin POST refused');
    assert.strictEqual((await post('/api/run', { task: 'x' }, { ...good, origin: 'null' })).status, 403, 'null origin refused');
    assert.strictEqual((await post('/api/run', { task: 'x' }, { cookie, 'x-ui-token': token, 'content-type': 'text/plain' })).status, 415, 'non-JSON refused');
    assert.strictEqual((await post('/api/run', { task: 'x' }, { ...good, origin: base })).status !== 403, true, 'same-origin POST with token is accepted');
    // let that accepted run finish before continuing
    await new Promise((r) => setTimeout(r, 300));
    // DNS-rebinding style: right cookie and token, but a foreign Host header.
    const rebind = await new Promise((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port, path: '/api/state', headers: { Host: 'evil.example', cookie } }, (res) => resolve(res.statusCode)); r.on('error', reject); r.end(); });
    assert.strictEqual(rebind, 403, 'foreign Host header refused');
    assert.ok(!(await (await get('/api/state')).text()).includes(token), 'token is never returned by the API');
    console.log('PASS  UI access control: session cookie, token header, origin, host, content type all enforced');

    // ---------------- input validation ----------------
    assert.strictEqual((await post('/api/run', { task: '  ' })).status, 400, 'empty task');
    assert.strictEqual((await post('/api/run', { task: 'x'.repeat(2001) })).status, 400, 'task too long');
    assert.strictEqual((await post('/api/run', { task: 'x', chaos: ['rm -rf'] })).status, 400, 'unknown chaos option');
    assert.strictEqual((await post('/api/run', { task: 'x', chaos: 'flakySubmit' })).status, 400, 'chaos must be a list');
    assert.strictEqual((await post('/api/run', { task: 'x', autoApprove: 'yes' })).status, 400, 'options must be booleans');
    assert.strictEqual((await post('/api/run', { task: 'x', autoApprove: true })).status, 403, 'auto-approve is off unless the server enables it');
    assert.strictEqual((await (await get('/api/state')).json()).allowAutoApprove, false);
    assert.strictEqual((await (await get('/api/invoices')).json()).length, 4, 'database panel endpoint returns the seed rows');
    console.log('PASS  UI input validation: types, lengths, chaos allowlist, auto-approve disabled by default');

    // ---------------- behaviour ----------------
    const sse = await openSSE(base, { cookie });
    assert.strictEqual(sse.status, 200);
    await new Promise((r) => setTimeout(r, 150)); // let the replay of earlier buffered events arrive before taking indexes
    scriptFor = () => scripted([call('list_files', {}), call('write', {}), call('ask_human', { question: 'Which one?' }), call('finish', { status: 'cannot_complete', summary: 'all done' })]);
    let from = sse.events.length;
    assert.strictEqual((await post('/api/run', { task: 'demo', reset: false })).status, 200);
    const ap = await sse.waitFor((e) => e.kind === 'approval_request', from);
    assert.strictEqual(ap.tool, 'write');
    assert.strictEqual((await post('/api/run', { task: 'again', reset: false })).status, 409, 'only one run at a time');

    // Unauthorized approval attempts must not approve anything.
    assert.strictEqual((await post('/api/respond', { reqId: ap.reqId, value: true }, { 'content-type': 'application/json' })).status, 401, 'no session -> cannot approve');
    assert.strictEqual((await post('/api/respond', { reqId: ap.reqId, value: true }, { cookie, 'content-type': 'application/json' })).status, 403, 'cookie without token -> cannot approve');
    assert.strictEqual((await post('/api/respond', { reqId: ap.reqId, value: true }, { ...good, origin: 'http://evil.example' })).status, 403, 'foreign origin -> cannot approve');
    assert.ok(!sse.events.slice(from).some((e) => e.kind === 'response_recorded'), 'the approval is still pending after the refused attempts');
    assert.strictEqual((await post('/api/respond', { reqId: ap.reqId, value: 'true' })).status, 200);
    const rec = await sse.waitFor((e) => e.kind === 'response_recorded', from);
    assert.strictEqual(rec.value, false, 'only a boolean true approves; the string "true" is treated as a denial');
    console.log('PASS  UI approvals: unauthorized or malformed responses never approve an action');

    // restart a clean run for the happy path
    await post('/api/stop'); // the denied run is now waiting on a question; end it before starting the next one
    await sse.waitFor((e) => e.kind === 'idle', from);
    scriptFor = () => scripted([call('list_files', {}), call('write', {}), call('ask_human', { question: 'Which one?' }), call('finish', { status: 'cannot_complete', summary: 'all done' })]);
    from = sse.events.length;
    assert.strictEqual((await post('/api/run', { task: 'demo2', reset: false })).status, 200);
    const ap2 = await sse.waitFor((e) => e.kind === 'approval_request', from);
    await post('/api/respond', { reqId: ap2.reqId, value: true });
    const q = await sse.waitFor((e) => e.kind === 'question', from);
    assert.strictEqual(q.question, 'Which one?');
    await post('/api/respond', { reqId: q.reqId, value: 'the second one' });
    const res1 = await sse.waitFor((e) => e.kind === 'result', from);
    assert.strictEqual(res1.status, 'cannot_complete'); assert.strictEqual(res1.summary, 'all done');
    await sse.waitFor((e) => e.kind === 'idle', from);
    const traces = sse.events.slice(from).filter((e) => e.kind === 'trace').map((e) => e.ev.type);
    for (const t of ['task', 'llm', 'policy', 'observation', 'finish']) assert.ok(traces.includes(t), `live stream must include "${t}" events`);
    assert.ok(sse.events.slice(from).some((e) => e.kind === 'response_recorded' && e.value === true));
    console.log('PASS  UI: live step stream, approval + question round trips');

    // ---- run history: stored runs can be listed and replayed (actions + what the model saw) ----
    const runs = await (await get('/api/runs')).json();
    const mine = runs.find((r) => r.task === 'demo2');
    assert.ok(mine, 'the finished run is listed'); assert.strictEqual(mine.status, 'cannot_complete'); assert.strictEqual(mine.summary, 'all done');
    const tr = await (await get(`/api/runs/${mine.id}/trace`)).json();
    for (const t of ['task', 'llm', 'policy', 'observation', 'result']) assert.ok(tr.some((e) => e.type === t), `stored trace has ${t}`);
    const calls = await (await get(`/api/runs/${mine.id}/llm`)).json();
    assert.ok(calls.some((c) => c.direction === 'request') && calls.some((c) => c.direction === 'response'), 'stored model log has requests and responses');
    assert.strictEqual((await get('/api/runs', {})).status, 401, 'history needs the session');
    assert.strictEqual((await get(`/api/runs/${mine.id}/trace`, {})).status, 401);
    assert.strictEqual((await get('/api/runs/..%2F..%2Fetc%2Fpasswd/trace')).status, 400, 'path traversal is refused');
    assert.strictEqual((await get('/api/runs/2026-01-01T00-00-00-000Z/trace')).status, 404, 'unknown run');
    assert.strictEqual((await get(`/runs/${mine.id}/llm.jsonl`)).status, 404, 'raw logs are not served as static files');
    console.log('PASS  UI run history: list, replay data (trace + model log), session required, traversal refused');

    scriptFor = () => scripted([call('write', {}), call('list_files', {})]);
    from = sse.events.length;
    await post('/api/run', { task: 'stop me', reset: false });
    await sse.waitFor((e) => e.kind === 'approval_request', from);
    await post('/api/stop');
    assert.strictEqual((await sse.waitFor((e) => e.kind === 'result', from)).status, 'stopped');
    await sse.waitFor((e) => e.kind === 'idle', from);
    console.log('PASS  UI: Stop ends a run that is waiting for approval');
    sse.close();

    // Auto-approve only when the server operator enabled it; it is still recorded in the trace.
    const app2 = createApp({ skipErp: true, llmFactory: () => scripted([call('write', {}), call('finish', { status: 'cannot_complete', summary: 'ok' })]), toolsFactory, allowAutoApprove: true, runsDir: RUNS });
    const server2 = app2.listen(0); const base2 = `http://localhost:${server2.address().port}`;
    const pg2 = await fetch(base2 + '/'); const ck2 = pg2.headers.get('set-cookie').split(';')[0]; const tk2 = (await pg2.text()).match(/content="([0-9a-f]{64})"/)[1];
    const h2 = { cookie: ck2, 'x-ui-token': tk2, 'content-type': 'application/json' };
    const sse2 = await openSSE(base2, { cookie: ck2 });
    assert.strictEqual((await fetch(base2 + '/api/run', { method: 'POST', headers: h2, body: JSON.stringify({ task: 'auto', reset: false, autoApprove: true }) })).status, 200);
    await sse2.waitFor((e) => e.kind === 'result');
    assert.ok(!sse2.events.some((e) => e.kind === 'approval_request'), 'no approval card in auto mode');
    assert.strictEqual(sse2.events.find((e) => e.kind === 'trace' && e.ev.type === 'policy' && e.ev.tool === 'write').ev.approval, 'auto');
    console.log('PASS  UI: auto-approve works only when explicitly enabled, and is recorded as "auto"');
    sse2.close(); server2.close();
  } finally { server.close(); }
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
