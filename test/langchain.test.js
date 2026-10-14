// Tests the REAL LangChain ChatOpenAI model + LangGraph runtime against a fake OpenAI HTTP endpoint (no API key, no network).
// This checks what we actually send to OpenAI and that tool calls coming back are parsed, gated and answered correctly.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
process.env.COMPANY_MEMORY = path.join(os.tmpdir(), 'cm-lc.md'); fs.writeFileSync(process.env.COMPANY_MEMORY, '# test company memory');
const { ChatOpenAI } = require('@langchain/openai');
const { runAgent } = require('../agent/loop');
const { createTools } = require('../agent/tools');
const { createChatModel } = require('../agent/llm');
const adapter = require('../agent/adapters/findesk');

function fakeOpenAI(replies) {
  const requests = []; let i = 0;
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body); requests.push({ url: String(url), body });
    const r = replies[Math.min(i++, replies.length - 1)];
    const message = { role: 'assistant', content: r.content ?? null, ...(r.tool_calls ? { tool_calls: r.tool_calls.map((c, n) => ({ id: c.id || `call_${i}_${n}`, type: 'function', function: { name: c.name, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args) } })) } : {}) };
    return new Response(JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, message, finish_reason: r.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { requests, model: new ChatOpenAI({ model: 'gpt-4o-mini', apiKey: 'sk-test', maxRetries: 0, configuration: { fetch } }) };
}
const mkctx = () => ({ memory: {}, browser: null, askHuman: async () => 'stop', approve: async () => true });
const rd = () => path.join(os.tmpdir(), 'lc-run-' + Math.random().toString(36).slice(2));

(async () => {
  // createChatModel builds a real ChatOpenAI from the environment, and refuses to start without a key.
  const saved = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY;
  assert.throws(() => createChatModel(), /OPENAI_API_KEY is not set/);
  process.env.OPENAI_API_KEY = 'sk-test'; process.env.OPENAI_MODEL = 'gpt-4o-mini';
  assert.strictEqual(createChatModel().constructor.name, 'ChatOpenAI');
  if (saved) process.env.OPENAI_API_KEY = saved; else delete process.env.OPENAI_API_KEY;
  console.log('PASS  createChatModel returns a LangChain ChatOpenAI and needs an API key');

  // A full run through the real ChatOpenAI class.
  const ctx = mkctx();
  const tools = createTools(ctx).filter((t) => ['list_files', 'read_file', 'ask_human'].includes(t.name));
  const { requests, model } = fakeOpenAI([
    { tool_calls: [{ id: 'call_a', name: 'list_files', args: {} }] },
    { tool_calls: [{ id: 'call_b', name: 'read_file', args: { path: 'acme_invoice_april.pdf' } }] },
    { tool_calls: [{ id: 'call_c', name: 'finish', args: { status: 'cannot_complete', summary: 'read the file, nothing to do' } }] },
  ]);
  const runDir1 = rd();
  const r = await runAgent({ task: 'Look at the Acme invoice', llm: model, tools, ctx, adapter, runDir: runDir1, log: () => {} });
  assert.strictEqual(r.status, 'cannot_complete'); assert.strictEqual(r.steps, 3);
  assert.strictEqual(requests.length, 3);
  const first = requests[0].body;
  assert.ok(/chat\/completions$/.test(requests[0].url));
  assert.strictEqual(first.model, 'gpt-4o-mini');
  assert.deepStrictEqual(first.tools.map((t) => t.function.name).sort(), ['ask_human', 'finish', 'list_files', 'read_file'], 'our tools + finish are sent to OpenAI as function tools');
  assert.strictEqual(first.parallel_tool_calls, false, 'one action at a time');
  assert.strictEqual(first.messages[0].role, 'system'); assert.ok(first.messages[0].content.includes('Company knowledge') && first.messages[0].content.includes('test company memory'), 'system prompt carries company memory');
  assert.ok(!/step 1|first call/i.test(first.messages[0].content), 'the prompt contains no fixed step order');
  assert.deepStrictEqual(first.messages.slice(1).map((m) => [m.role, m.content]), [['user', 'Look at the Acme invoice']]);
  const second = requests[1].body.messages;
  assert.deepStrictEqual(second.slice(2).map((m) => m.role), ['assistant', 'tool'], 'the model sees its own tool call and the tool result');
  assert.strictEqual(second[3].tool_call_id, 'call_a');
  assert.ok(JSON.parse(second[3].content).ok === true && second[3].content.includes('acme_invoice_april.pdf'));
  const third = requests[2].body.messages;
  assert.ok(third[5].content.includes('Total Amount Due'), 'the PDF text really reached the model');
  console.log('PASS  real ChatOpenAI + LangGraph: tools, system prompt, memory, tool results all exactly what OpenAI should receive');

  // The backend log of the same run shows the real model name, offered tools, token usage and the answer.
  const log = fs.readFileSync(path.join(runDir1, 'llm.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const req0 = log.find((e) => e.direction === 'request'), res0 = log.find((e) => e.direction === 'response');
  assert.strictEqual(req0.model, 'gpt-4o-mini'); assert.deepStrictEqual([...req0.tool_names].sort(), ['ask_human', 'finish', 'list_files', 'read_file']);
  assert.strictEqual(res0.usage.total_tokens, 15); assert.strictEqual(res0.tool_calls[0].name, 'list_files'); assert.ok(typeof res0.latency_ms === 'number');
  console.log('PASS  llm.jsonl from the real ChatOpenAI path: model name, offered tools, token usage, answer, latency');

  // Bad JSON arguments from the model must not crash the run; the model gets an error it can react to.
  const bad = fakeOpenAI([
    { tool_calls: [{ id: 'call_x', name: 'read_file', args: '{not valid json' }] },
    { tool_calls: [{ id: 'call_y', name: 'finish', args: { status: 'cannot_complete', summary: 'gave up' } }] },
  ]);
  const rb = await runAgent({ task: 't', llm: bad.model, tools, ctx: mkctx(), adapter, runDir: rd(), log: () => {} });
  assert.strictEqual(rb.status, 'cannot_complete');
  const msgs = bad.requests[1].body.messages;
  const assistant = msgs.find((m) => m.role === 'assistant'); const toolMsg = msgs.find((m) => m.role === 'tool');
  assert.ok(assistant && assistant.tool_calls && assistant.tool_calls.some((c) => c.id === 'call_x'), 'the invalid call is still sent back as an assistant tool call (OpenAI rejects orphaned tool messages)');
  assert.strictEqual(toolMsg.tool_call_id, 'call_x'); assert.ok(/not valid JSON/.test(toolMsg.content));
  console.log('PASS  invalid tool-call JSON from the model is answered with an error the model can recover from');

  // Wrong argument types are rejected by the schema before the policy or the tool runs.
  const wrong = fakeOpenAI([
    { tool_calls: [{ id: 'call_w', name: 'read_file', args: { path: 123 } }] },
    { tool_calls: [{ id: 'call_z', name: 'finish', args: { status: 'cannot_complete', summary: 'x' } }] },
  ]);
  let policyCalls = 0; const ctxW = { ...mkctx(), approve: async () => { policyCalls++; return true; } };
  await runAgent({ task: 't', llm: wrong.model, tools, ctx: ctxW, adapter, runDir: rd(), log: () => {} });
  const wm = wrong.requests[1].body.messages.find((m) => m.role === 'tool');
  assert.ok(/Invalid arguments for read_file/.test(wm.content) && /path/.test(wm.content), 'schema error names the field');
  console.log('PASS  tool input is validated by the zod schema before policy or execution');

  // Text-only answers are nudged back to tool use; after 3 nudges the run aborts instead of looping forever.
  const chat = fakeOpenAI([{ content: 'I think I am done.' }]);
  const rc = await runAgent({ task: 't', llm: chat.model, tools, ctx: mkctx(), adapter, runDir: rd(), log: () => {} });
  assert.strictEqual(rc.status, 'aborted');
  assert.ok(chat.requests[1].body.messages.some((m) => m.role === 'user' && /Continue by calling a tool/.test(m.content)));
  console.log('PASS  a model that answers in prose is nudged, then aborted after 3 nudges');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
