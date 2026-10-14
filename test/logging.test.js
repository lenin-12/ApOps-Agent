// Every model call and every action must be logged to the backend: llm.jsonl (what the model was sent and answered,
// latency, tokens) and trace.jsonl (decisions, policy, observations, verification, final result).
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
process.env.COMPANY_MEMORY = path.join(os.tmpdir(), 'cm-log.md'); fs.writeFileSync(process.env.COMPANY_MEMORY, '# logging test memory');
const { call, scripted } = require('./helpers/scripted-model');
const { runAgent } = require('../agent/loop');
const { createTools } = require('../agent/tools');
const adapter = require('../agent/adapters/findesk');
const read = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map(JSON.parse);

(async () => {
  const runDir = path.join(os.tmpdir(), 'log-run-' + Math.random().toString(36).slice(2));
  const ctx = { memory: {}, browser: null, askHuman: async () => 'stop', approve: async () => true };
  const tools = createTools(ctx).filter((t) => ['list_files', 'read_file'].includes(t.name));
  const model = scripted([call('list_files', {}), call('read_file', { path: 'does-not-exist.pdf' }), call('finish', { status: 'cannot_complete', summary: 'file missing' })]);
  const r = await runAgent({ task: 'Read the missing file', llm: model, tools, ctx, adapter, runDir, log: () => {} });
  assert.strictEqual(r.status, 'cannot_complete');

  const llm = read(path.join(runDir, 'llm.jsonl'));
  const requests = llm.filter((e) => e.direction === 'request'), responses = llm.filter((e) => e.direction === 'response');
  assert.strictEqual(requests.length, 3); assert.strictEqual(responses.length, 3, 'one request and one response per model call');
  assert.deepStrictEqual(requests.map((e) => e.step), [1, 2, 3]);
  assert.strictEqual(requests[0].messages[0].role, 'system'); assert.ok(requests[0].messages[0].content.includes('logging test memory'), 'the exact system prompt is logged');
  assert.strictEqual(requests[0].messages[1].role, 'human'); assert.strictEqual(requests[0].messages[1].content, 'Read the missing file');
  assert.ok(requests[1].messages.some((m) => m.role === 'tool' && m.content.includes('does-not-exist') === false && m.content.includes('"ok":true')), 'the second request contains the first tool result');
  assert.ok(requests[2].messages.some((m) => m.role === 'tool' && /"ok":false/.test(m.content)), 'the failed read is shown to the model');
  assert.deepStrictEqual(responses.map((e) => e.tool_calls[0].name), ['list_files', 'read_file', 'finish']);
  assert.ok(responses.every((e) => typeof e.latency_ms === 'number' && e.latency_ms >= 0), 'latency recorded');
  console.log('PASS  llm.jsonl records each model request (system prompt, history, tool results) and response with latency');

  const trace = read(path.join(runDir, 'trace.jsonl'));
  const types = trace.map((e) => e.type);
  for (const t of ['task', 'llm', 'policy', 'observation', 'finish', 'result']) assert.ok(types.includes(t), `trace has ${t}`);
  assert.ok(trace.filter((e) => e.type === 'llm').every((e) => typeof e.latency_ms === 'number'), 'trace llm events carry latency');
  const failed = trace.find((e) => e.type === 'observation' && e.tool === 'read_file');
  assert.strictEqual(failed.result.ok, false); assert.ok(failed.result.error.length > 0, 'the failure and its error text are logged');
  assert.strictEqual(trace[trace.length - 1].type, 'result'); assert.strictEqual(trace[trace.length - 1].status, 'cannot_complete');
  console.log('PASS  trace.jsonl records decisions, policy, observations (including failures) and the final result');

  // A crash is logged too, so the history view can explain a run that ended badly.
  const crashDir = path.join(os.tmpdir(), 'log-crash-' + Math.random().toString(36).slice(2));
  await assert.rejects(() => runAgent({ task: 't', llm: scripted([]), tools, ctx, adapter, runDir: crashDir, log: () => {} }), /script exhausted/);
  const crash = read(path.join(crashDir, 'trace.jsonl')); assert.strictEqual(crash[crash.length - 1].type, 'error');
  assert.ok(read(path.join(crashDir, 'llm.jsonl')).some((e) => e.direction === 'error'), 'a failed model call is logged');
  console.log('PASS  a crashed run logs the model error and an error event');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
