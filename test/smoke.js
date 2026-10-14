// Smoke test of the runtime WITHOUT an OpenAI key or a browser: a scripted "LLM" drives the real loop,
// real file tools, real policy layer, real verifier and the real ERP. It proves the wiring, including
// that the verifier catches silent data corruption and the agent can recover.
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const { call, scripted: scriptedModel } = require('./helpers/scripted-model');
const scripted = (steps) => scriptedModel(steps, { clamp: false });
const assert = require('assert');

const PORT = 4011, BASE = `http://localhost:${PORT}`;
const DB = path.join(os.tmpdir(), `findesk-smoke-${Date.now()}.db`);
process.env.ERP_DB = DB; process.env.ERP_PORT = PORT;
process.env.COMPANY_MEMORY = path.join(os.tmpdir(), 'cm-smoke.md');
fs.writeFileSync(process.env.COMPANY_MEMORY, '# test memory');

const { createTools } = require('../agent/tools');
const { runAgent } = require('../agent/loop');
const adapter = require('../agent/adapters/findesk');

let cookie = '';
async function login() {
  const r = await fetch(`${BASE}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=admin&password=admin123' });
  cookie = r.headers.get('set-cookie').split(';')[0];
}
const post = (p, body) => fetch(`${BASE}${p}`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });


(async () => {
  const srv = spawn('node', ['erp/server.js'], { env: process.env, stdio: 'ignore' });
  try {
    for (let i = 0; i < 30; i++) { try { await fetch(`${BASE}/admin/chaos`); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
    await fetch(`${BASE}/admin/chaos`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-apops-admin': '1' }, body: JSON.stringify({ silentCorruption: true }) });
    await login();

    const ctx = { memory: {}, browser: null, askHuman: async () => 'n/a', approve: async () => true };
    const tools = createTools(ctx).filter((t) => ['list_files', 'read_file', 'remember'].includes(t.name));
    let invoiceId;
    tools.push({ name: 'erp_submit', risk: 'irreversible', description: 'test', parameters: { type: 'object', properties: {} },
      run: async (a) => { const r = await post('/invoices', a); const m = r.headers.get('location').match(/confirmation\/(\d+)/); invoiceId = m[1]; return { saved: true, ref: invoiceId }; } });
    tools.push({ name: 'erp_edit', risk: 'irreversible', description: 'test', parameters: { type: 'object', properties: {} },
      run: async (a) => { await post(`/invoices/${invoiceId}/edit`, a); return { updated: true }; } });

    const claim = { entity: 'invoice', key: { vendor: 'Acme Corp', invoice_number: 'INV-1002' }, fields: { amount: 42500, due_date: '2026-05-20', po_number: 'PO-7802' }, source_file: 'acme_invoice_april.pdf' };
    const llm = scripted([
      call('list_files', {}),
      call('read_file', { path: 'acme_invoice_april.pdf' }),
      call('remember', { key: 'latest_acme', value: 'INV-1002' }),
      call('erp_submit', { vendor_id: '1', invoice_number: 'INV-1002', amount: '42500', due_date: '2026-05-20', po_number: 'PO-7802' }),
      call('finish', { status: 'completed', summary: 'Entered INV-1002', claims: [claim] }),   // verifier must FAIL (4250 stored)
      call('erp_edit', { amount: '42500', due_date: '2026-05-20' }),
      call('finish', { status: 'completed', summary: 'Entered and corrected INV-1002', claims: [claim] }), // must PASS
    ]);
    const r = await runAgent({ task: 'test', llm, tools, ctx, adapter, runDir: path.join(os.tmpdir(), 'run-smoke-' + Date.now()), log: () => {} });

    const trace = fs.readFileSync(r.tracePath, 'utf8').trim().split('\n').map(JSON.parse);
    const ver = trace.filter((e) => e.type === 'verification');
    assert.strictEqual(r.status, 'completed');
    assert.strictEqual(ver.length, 2);
    assert.strictEqual(ver[0].passed, false, 'first verification must catch the corrupted amount');
    assert.ok(/4250/.test(ver[0].problems.join(' ')), 'mismatch message should mention stored value 4250');
    assert.strictEqual(ver[1].passed, true, 'second verification must pass after the fix');
    assert.ok(trace.some((e) => e.type === 'policy' && e.tool === 'erp_submit' && e.risk === 'irreversible'));
    assert.strictEqual(ctx.memory.latest_acme, 'INV-1002');
    console.log('PASS  verifier caught silent corruption (4250 vs 42500), agent fixed it, verifier then passed');

    // Policy: a denied irreversible action must not run and must be reported back.
    const ctx2 = { memory: {}, askHuman: async () => '', approve: async () => false };
    let ran = false;
    const t2 = [{ name: 'danger', risk: 'irreversible', description: '', parameters: { type: 'object', properties: {} }, run: async () => { ran = true; return {}; } }];
    const r2 = await runAgent({ task: 't', llm: scripted([call('danger', {}), call('finish', { status: 'cannot_complete', summary: 'denied' })]), tools: t2, ctx: ctx2, adapter, runDir: path.join(os.tmpdir(), 'run-smoke2-' + Date.now()), log: () => {} });
    assert.strictEqual(ran, false); assert.strictEqual(r2.status, 'cannot_complete');
    console.log('PASS  denied irreversible action was blocked by the runtime');

    // Stuck detector: the SAME failing call 3 times -> runtime stops and asks a human (design rule).
    const t3 = [{ name: 'flaky', risk: 'safe', description: '', parameters: { type: 'object', properties: {} }, run: async () => { throw new Error('boom'); } }];
    let asked = 0;
    const countingModel = scriptedModel([call('flaky', { b: 2, a: 1 })], { clamp: true }); // the same failing call, forever
    const ctx3 = { memory: {}, askHuman: async () => { asked++; return 'stop'; }, approve: async () => true };
    const r3 = await runAgent({ task: 't', llm: countingModel, tools: t3, ctx: ctx3, adapter, runDir: path.join(os.tmpdir(), 'run-smoke3-' + Date.now()), log: () => {} });
    assert.strictEqual(r3.status, 'stuck'); assert.strictEqual(countingModel.calls, 3, 'must stop at exactly the 3rd identical failure'); assert.strictEqual(asked, 1, 'must ask a human once');
    console.log('PASS  3rd identical failure stops the run and asks a human (exactly 3 attempts)');

    // Human guidance lets the run continue; counter resets.
    let n = 0, asked2 = 0;
    const t3b = [{ name: 'flaky', risk: 'safe', description: '', parameters: { type: 'object', properties: {} }, run: async () => { if (++n <= 3) throw new Error('boom'); return { ok: 1 }; } }];
    const ctx3b = { memory: {}, askHuman: async () => { asked2++; return 'try again, it should work now'; }, approve: async () => true };
    const r3b = await runAgent({ task: 't', llm: scripted([call('flaky', {}), call('flaky', {}), call('flaky', {}), call('flaky', {}), call('finish', { status: 'cannot_complete', summary: 'done' })]), tools: t3b, ctx: ctx3b, adapter, runDir: path.join(os.tmpdir(), 'run-smoke3b-' + Date.now()), log: () => {} });
    assert.strictEqual(asked2, 1); assert.strictEqual(r3b.status, 'cannot_complete');
    console.log('PASS  human guidance after a stuck escalation lets the run continue');

    // ---- P0: approval policy cannot be bypassed ----
    const { classifyClick, authorize } = require('../agent/policy');
    const info = (o) => ({ tag: 'button', type: null, text: '', href: null, formMethod: 'post', formAction: '/x', formHasPassword: false, ...o });
    assert.strictEqual(classifyClick(info({ text: 'Submit Invoice' })).risk, 'irreversible');
    assert.strictEqual(classifyClick(info({ text: 'Go' })).risk, 'irreversible', 'a POST-form button with a harmless label must still need approval (this was the bypass)');
    assert.strictEqual(classifyClick(info({ text: 'OK', formAction: '/invoices/5/pay' })).risk, 'irreversible');
    assert.strictEqual(classifyClick(info({ tag: 'div', text: 'Next', formMethod: null })).risk, 'irreversible', 'unknown elements are default-deny');
    assert.strictEqual(classifyClick(info({ tag: 'button', text: 'Sign in', formHasPassword: true })).risk, 'reversible');
    assert.strictEqual(classifyClick({ tag: 'a', text: 'Invoices', href: '/invoices' }).risk, 'reversible');
    assert.strictEqual(classifyClick({ tag: 'a', text: 'Delete', href: '/invoices/5/delete' }).risk, 'irreversible');
    assert.strictEqual(classifyClick(null).risk, 'irreversible');
    // Real browser_click tool through authorize(), with a fake browser: a CSS selector with no commit words must still be gated.
    const fakeBrowser = (i, boom) => ({ isOpen: true, inspectClick: async () => { if (boom) throw new Error('inspect blew up'); return i; }, formValues: async () => ({ url: 'u', filled_fields: {} }) });
    const clickTool = createTools({ memory: {}, browser: null }).find((t) => t.name === 'browser_click');
    let approvals = 0;
    const mk = (b) => ({ browser: b, approve: async () => { approvals++; return false; } });
    let a = await authorize(clickTool, { target: 'main form button' }, mk(fakeBrowser(info({ text: 'Go' }))));
    assert.strictEqual(a.allowed, false); assert.strictEqual(approvals, 1, 'CSS-selector click on a POST-form button must ask for approval');
    a = await authorize(clickTool, { target: 'main form button' }, mk(fakeBrowser(null, true)));
    assert.strictEqual(a.allowed, false); assert.strictEqual(approvals, 2, 'if the element cannot be assessed, fail closed');
    a = await authorize(clickTool, { target: 'Invoices' }, mk(fakeBrowser({ tag: 'a', text: 'Invoices', href: '/invoices' })));
    assert.strictEqual(a.allowed, true); assert.strictEqual(approvals, 2, 'plain navigation needs no approval');
    // Tool with no/unknown risk label is treated as irreversible.
    a = await authorize({ name: 'mystery', run: async () => {} }, {}, mk(null));
    assert.strictEqual(a.risk, 'irreversible'); assert.strictEqual(approvals, 3);
    // Memory writes need approval; non-allowlisted origins are refused.
    assert.strictEqual(createTools({ memory: {} }).find((t) => t.name === 'save_company_rule').risk, 'irreversible');
    await assert.rejects(() => createTools({ memory: {}, browser: {} }).find((t) => t.name === 'browser_open').run({ url: 'https://evil.example/x' }), /not allowed/);
    console.log('PASS  approval cannot be bypassed: default-deny, element-based, fail-closed, origin allowlist');

    // ---- Review fix 1: the approved element is pinned and revalidated right before the click ----
    const { Browser } = require('../agent/browser');
    const mkBrowser = () => {
      const state = { info: { tag: 'button', type: 'submit', role: null, text: 'Update Invoice', href: null, disabled: false, formMethod: 'post', formAction: '/invoices/5/edit', formHasPassword: false } };
      const b = new Browser({ shotDir: 'x' });
      const clicked = [];
      const handle = { connected: true, evaluate: async () => handle.connected, click: async () => { clicked.push(1); } };
      b.page = { url: () => 'http://localhost/invoices/5', waitForLoadState: async () => {}, waitForTimeout: async () => {}, evaluate: async () => 'body', title: async () => 't' };
      b.resolve = async () => ({ elementHandle: async () => handle });
      b.describe = async () => ({ ...state.info, pageUrl: b.page.url() });
      return { b, state, handle, clicked };
    };
    const clickFlow = async (mutateAfterApproval) => {
      const f = mkBrowser();
      const tool = createTools({ memory: {}, browser: f.b }).find((t) => t.name === 'browser_click');
      const c = { browser: f.b, approve: async () => { mutateAfterApproval && mutateAfterApproval(f); return true; } };
      const auth = await authorize(tool, { target: 'whatever' }, c);
      assert.strictEqual(auth.risk, 'irreversible'); assert.ok(auth.token, 'assessment must hand a token to execution');
      return { f, tool, auth, run: () => tool.run({ target: 'whatever' }, { approval: auth }) };
    };
    let t = await clickFlow(); await t.run(); assert.strictEqual(t.f.clicked.length, 1, 'unchanged element: clicked once');
    t = await clickFlow((f) => { f.state.info.text = 'Mark as Paid'; f.state.info.formAction = '/invoices/5/pay'; });
    await assert.rejects(t.run, /changed after it was assessed/); assert.strictEqual(t.f.clicked.length, 0, 'element swapped after approval: must NOT click');
    t = await clickFlow((f) => { f.handle.connected = false; });
    await assert.rejects(t.run, /no longer on the page/); assert.strictEqual(t.f.clicked.length, 0, 'element removed after approval: must NOT click');
    t = await clickFlow((f) => { f.b.page.url = () => 'http://localhost/invoices/6'; });
    await assert.rejects(t.run, /changed after it was assessed/); assert.strictEqual(t.f.clicked.length, 0, 'page changed after approval: must NOT click');
    t = await clickFlow();
    await assert.rejects(() => t.tool.run({ target: 'whatever' }, {}), /not assessed/); assert.strictEqual(t.f.clicked.length, 0, 'a click with no assessment token must be refused');
    t = await clickFlow(); await t.run();
    await assert.rejects(t.run, /no longer the one that was assessed/); assert.strictEqual(t.f.clicked.length, 1, 'an approval is single-use');
    console.log('PASS  approved element is pinned and revalidated before the click (swap, detach, navigation, no-token, replay all refused)');

    // ---- Review fix 2: memory changes and business-record changes are tracked separately ----
    const ctx5 = { memory: {}, browser: null, askHuman: async () => '', approve: async () => true, approvalMode: 'auto' };
    const memTools = createTools(ctx5).filter((x) => x.name === 'save_company_rule');
    const r5 = await runAgent({ task: 't', llm: scripted([call('save_company_rule', { rule: 'Acme Corp POs are left blank' }), call('finish', { status: 'completed', summary: 'saved the rule' })]), tools: memTools, ctx: ctx5, adapter, runDir: path.join(os.tmpdir(), 'run-smoke5-' + Date.now()), log: () => {} });
    assert.strictEqual(r5.status, 'completed', 'a memory-only task must not demand business-record claims');
    assert.strictEqual(r5.persistentMemoryChanged, true); assert.strictEqual(r5.externalStateChanged, false);
    assert.ok(fs.readFileSync(process.env.COMPANY_MEMORY, 'utf8').includes('Acme Corp POs are left blank'));
    const mixTools = [...createTools(ctx5).filter((x) => x.name === 'save_company_rule'), { name: 'write', risk: 'irreversible', description: '', parameters: { type: 'object', properties: {} }, run: async () => ({}) }];
    const r6 = await runAgent({ task: 't', llm: scripted([call('save_company_rule', { rule: 'another rule' }), call('write', {}), call('finish', { status: 'completed', summary: 'x' }), call('finish', { status: 'completed', summary: 'x' }), call('finish', { status: 'completed', summary: 'x' })]), tools: mixTools, ctx: ctx5, adapter, runDir: path.join(os.tmpdir(), 'run-smoke6-' + Date.now()), log: () => {} });
    assert.strictEqual(r6.status, 'verification_failed', 'a real business-record change with no claims must still be rejected');
    let denied = 0; const ctx7 = { ...ctx5, approve: async () => { denied++; return false; } };
    const r7 = await runAgent({ task: 't', llm: scripted([call('save_company_rule', { rule: 'x' }), call('finish', { status: 'cannot_complete', summary: 'no' })]), tools: createTools(ctx7).filter((x) => x.name === 'save_company_rule'), ctx: ctx7, adapter, runDir: path.join(os.tmpdir(), 'run-smoke7-' + Date.now()), log: () => {} });
    assert.strictEqual(denied, 1); assert.ok(!fs.readFileSync(process.env.COMPANY_MEMORY, 'utf8').includes('- (learned) x'), 'denied memory write must not be saved');
    console.log('PASS  memory-only tasks complete without business claims; real record changes still require them; memory writes still need approval');

    // ---- P2: label-anchored source validation ----
    const { verify } = require('../agent/verifier');
    const base = { invoice_number: 'INV-1002', vendor: 'Acme Corp', amount: 42500, due_date: '2026-05-20', po_number: 'PO-7802', status: 'pending' };
    const fake = (row) => ({ fieldLabels: adapter.fieldLabels, lookup: () => row });
    const cl = (f) => [{ entity: 'invoice', key: { vendor: 'Acme Corp', invoice_number: 'INV-1002' }, fields: f, source_file: 'acme_invoice_april.pdf' }];
    assert.strictEqual((await verify(cl({ amount: 42500, due_date: '2026-05-20', po_number: 'PO-7802' }), fake(base))).passed, true);
    assert.strictEqual((await verify(cl({ amount: 36016.95 }), fake({ ...base, amount: 36016.95 }))).passed, false, 'subtotal must not pass as the total');
    assert.strictEqual((await verify(cl({ due_date: '2026-04-20' }), fake({ ...base, due_date: '2026-04-20' }))).passed, false, 'invoice date must not pass as the due date');
    console.log('PASS  source validation rejects values taken from the wrong label (subtotal, invoice date)');

    // ---- P2: persistent memory plumbing across separate processes ----
    const memFile = path.join(os.tmpdir(), `mem-persist-${Date.now()}.md`); fs.writeFileSync(memFile, '# memory');
    const { execFileSync } = require('child_process');
    execFileSync('node', ['-e', "require('./agent/tools').createTools({memory:{}}).find(t=>t.name==='save_company_rule').run({rule:'Acme Corp invoices: leave PO Number blank'})"], { env: { ...process.env, COMPANY_MEMORY: memFile }, cwd: path.join(__dirname, '..') });
    const out = execFileSync('node', ['-e', "const {loadCompanyMemory}=require('./agent/memory');const {buildSystemPrompt}=require('./agent/prompt');process.stdout.write(buildSystemPrompt({companyMemory:loadCompanyMemory(),runMemory:{},today:'x'}))"], { env: { ...process.env, COMPANY_MEMORY: memFile }, cwd: path.join(__dirname, '..') }).toString();
    assert.ok(out.includes('leave PO Number blank'), 'rule saved by one process must appear in the next process\'s system prompt');
    console.log('PASS  a rule saved in one process is loaded into the next process\'s prompt');

    // Write without claims must not pass.
    const ctx4 = { memory: {}, askHuman: async () => '', approve: async () => true };
    const t4 = [{ name: 'write', risk: 'irreversible', description: '', parameters: { type: 'object', properties: {} }, run: async () => ({}) }];
    const r4 = await runAgent({ task: 't', llm: scripted([call('write', {}), call('finish', { status: 'completed', summary: 'x' }), call('finish', { status: 'completed', summary: 'x' }), call('finish', { status: 'completed', summary: 'x' })]), tools: t4, ctx: ctx4, adapter, runDir: path.join(os.tmpdir(), 'run-smoke4-' + Date.now()), log: () => {} });
    assert.strictEqual(r4.status, 'verification_failed');
    console.log('PASS  claiming done after a write with no claims is rejected');
  } finally { srv.kill(); }
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
