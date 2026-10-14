// End-to-end plumbing test with a REAL browser and the REAL ERP, but a scripted "LLM" (no API key needed).
// It exercises every real layer: tools, Playwright, policy + approval, silent corruption, verifier, recovery.
//   npm run test:e2e        (needs Chromium: npx playwright install chromium)
const { spawn } = require('child_process');
const { call, scripted: scriptedModel } = require('./helpers/scripted-model');
const scripted = (steps) => scriptedModel(steps, { clamp: false });
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const PORT = 4012, ERP = `http://localhost:${PORT}`;
process.env.ERP_URL = ERP; process.env.ERP_PORT = PORT;
process.env.ERP_DB = path.join(os.tmpdir(), `e2e-${Date.now()}.db`);
process.env.COMPANY_MEMORY = path.join(os.tmpdir(), 'cm-e2e.md'); fs.copyFileSync(path.join(__dirname, '..', 'agent', 'company_memory.md'), process.env.COMPANY_MEMORY);

const { createTools } = require('../agent/tools');
const { Browser } = require('../agent/browser');
const { runAgent } = require('../agent/loop');
const adapter = require('../agent/adapters/findesk');
const Database = require('better-sqlite3');

const admin = (p, body) => fetch(ERP + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-apops-admin': '1' }, body: JSON.stringify(body || {}) });
const rows = () => { const d = new Database(process.env.ERP_DB, { readonly: true }); try { return d.prepare('SELECT i.*, v.name AS vendor FROM invoices i JOIN vendors v ON v.id=i.vendor_id ORDER BY i.id').all(); } finally { d.close(); } };

const fillAndSubmit = [
  call('browser_open', { url: `${ERP}/login` }), call('browser_type', { field: 'username', value: 'admin' }), call('browser_type', { field: 'password', value: 'admin123' }),
  call('browser_click', { target: 'Sign in' }), call('browser_open', { url: `${ERP}/invoices/new` }),
  call('browser_type', { field: 'vendor_id', value: 'Acme Corp' }), call('browser_type', { field: 'invoice_number', value: 'INV-1002' }),
  call('browser_type', { field: 'amount', value: '42500' }), call('browser_type', { field: 'due_date', value: '2026-05-20' }), call('browser_type', { field: 'po_number', value: 'PO-7802' }),
  call('browser_click', { target: 'Submit Invoice' }),
];
const claim = { entity: 'invoice', key: { vendor: 'Acme Corp', invoice_number: 'INV-1002' }, fields: { amount: 42500, due_date: '2026-05-20', po_number: 'PO-7802' }, source_file: 'acme_invoice_april.pdf' };

async function run(steps, approveWith) {
  const runDir = path.join(os.tmpdir(), 'e2e-run-' + Math.random());
  const browser = new Browser({ shotDir: path.join(runDir, 'shots') });
  const approvals = [];
  const ctx = { memory: {}, browser, approvalMode: 'scripted', askHuman: async () => 'stop', approve: async (a) => { approvals.push(a); return approveWith(a); } };
  try {
    const r = await runAgent({ task: 'e2e', llm: scripted(steps), tools: createTools(ctx), ctx, adapter, runDir, log: () => {} });
    const trace = fs.readFileSync(r.tracePath, 'utf8').trim().split('\n').map(JSON.parse);
    return { r, trace, approvals, runDir };
  } finally { await browser.close(); }
}

(async () => {
  const srv = spawn('node', ['erp/server.js'], { env: process.env, stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) { try { await fetch(`${ERP}/admin/chaos`); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }

    // 1) Silent corruption: the UI says "saved", the verifier catches the wrong amount, the agent repairs it.
    await admin('/admin/reset'); await admin('/admin/chaos', { silentCorruption: true });
    let { r, trace, approvals, runDir } = await run([
      call('list_files', {}), call('read_file', { path: 'acme_invoice_april.pdf' }), ...fillAndSubmit,
      call('finish', { status: 'completed', summary: 'entered', claims: [claim] }),                       // must FAIL: database has 4250
      call('browser_open', { url: `${ERP}/invoices/5` }), call('browser_type', { field: 'amount', value: '42500' }),
      call('browser_click', { target: 'Update Invoice' }), call('browser_screenshot', { label: 'final' }),
      call('finish', { status: 'completed', summary: 'entered and corrected', claims: [claim] }),
    ], async () => true);
    assert.strictEqual(r.status, 'completed', r.summary);
    const ver = trace.filter((e) => e.type === 'verification');
    assert.deepStrictEqual(ver.map((v) => v.passed), [false, true], 'verifier must reject first, accept after the repair');
    assert.ok(/4250/.test(ver[0].problems.join()), 'the mismatch names the stored value');
    assert.strictEqual(approvals.length, 2, 'exactly two approvals: the submit and the correction');
    assert.strictEqual(approvals[0].detail.element.formAction, '/invoices'); assert.strictEqual(approvals[0].page.filled_fields['Invoice Number'], 'INV-1002');
    const signIn = trace.find((e) => e.type === 'policy' && e.tool === 'browser_click' && e.args.target === 'Sign in');
    assert.strictEqual(signIn.risk, 'reversible', 'sign-in needs no approval');
    assert.ok(fs.readdirSync(path.join(runDir, 'shots')).some((f) => f.endsWith('.png')), 'screenshot evidence was saved');
    const row = rows().find((x) => x.invoice_number === 'INV-1002');
    assert.strictEqual(row.amount, 42500); assert.strictEqual(row.due_date, '2026-05-20'); assert.strictEqual(row.po_number, 'PO-7802');
    console.log('PASS  real browser + real ERP: silent corruption caught by the verifier, repaired, verified (2 approvals, sign-in ungated)');

    // 2) Denied approval: nothing is saved.
    await admin('/admin/reset'); await admin('/admin/chaos', {});
    const before = rows().length;
    ({ r, trace, approvals } = await run([...fillAndSubmit, call('finish', { status: 'cannot_complete', summary: 'human denied' })], async () => false));
    assert.strictEqual(r.status, 'cannot_complete'); assert.strictEqual(approvals.length, 1);
    assert.strictEqual(rows().length, before, 'a denied submit must not create a record');
    assert.ok(trace.some((e) => e.type === 'observation' && e.tool === 'browser_click' && e.result.ok === false && /denied/i.test(e.result.error)));
    console.log('PASS  real browser: a denied approval saves nothing');

    // 3) Flaky submit then success: the agent sees the 503 page and retries, then the verifier passes.
    await admin('/admin/reset'); await admin('/admin/chaos', { flakySubmit: true });
    ({ r, trace } = await run([
      ...fillAndSubmit, call('browser_read', {}),   // the 503 page has no form, so a retry means reopening and refilling it
      call('browser_open', { url: `${ERP}/invoices/new` }), call('browser_type', { field: 'vendor_id', value: 'Acme Corp' }), call('browser_type', { field: 'invoice_number', value: 'INV-1002' }),
      call('browser_type', { field: 'amount', value: '42500' }), call('browser_type', { field: 'due_date', value: '2026-05-20' }), call('browser_type', { field: 'po_number', value: 'PO-7802' }),
      call('browser_click', { target: 'Submit Invoice' }),
      call('finish', { status: 'completed', summary: 'entered after a retry', claims: [claim] }),
    ], async () => true));
    assert.strictEqual(r.status, 'completed', r.summary);
    assert.ok(trace.some((e) => e.type === 'observation' && /503/.test(JSON.stringify(e.result))), 'the 503 page was observed');
    assert.strictEqual(rows().filter((x) => x.invoice_number === 'INV-1002').length, 1);
    console.log('PASS  real browser: flaky submit (503) observed, retried, verified');
  } finally { srv.kill(); }
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
