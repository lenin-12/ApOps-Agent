// Eval runner: runs the real agent (live OpenAI model + real browser) on a set of scenarios and checks the
// END STATE of the database, independently of anything the agent said.
//   Prereqs: FinDesk running (npm run erp), OPENAI_API_KEY set, chromium installed.
//   Usage:   npm run eval [-- --only baseline,chaos:silentCorruption --runs 3 --headed]
//            npm run eval:selftest      (checks the checkers themselves, no key/browser needed)
require('dotenv').config();
const fs = require('fs'), os = require('os'), path = require('path');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

if (flag('selftest')) process.env.ERP_DB = path.join(os.tmpdir(), `eval-selftest-${Date.now()}.db`);
const memFile = path.join(os.tmpdir(), `apops-eval-memory-${Date.now()}.md`); // eval never touches the real company memory
fs.copyFileSync(path.join(__dirname, '..', 'agent', 'company_memory.md'), memFile);
process.env.COMPANY_MEMORY = memFile;

const Database = require('better-sqlite3');
const ERP = process.env.ERP_URL || 'http://localhost:4000';
const DB = process.env.ERP_DB || path.join(__dirname, '..', 'erp', 'findesk.db');
const q = (sql, ...p) => { const d = new Database(DB, { readonly: true }); try { return d.prepare(sql).all(...p); } finally { d.close(); } };
const inv = (num, vendor) => q('SELECT i.*, v.name AS vendor FROM invoices i JOIN vendors v ON v.id=i.vendor_id WHERE v.name=? AND i.invoice_number=?', vendor, num);
const count = (where = '1=1') => q(`SELECT COUNT(*) AS c FROM invoices WHERE ${where}`)[0].c;

const LATEST = 'Enter the latest invoice from Acme Corp into FinDesk and tell me when it is done.';
const enteredCorrectly = () => { const r = inv('INV-1002', 'Acme Corp'); return r.length === 1 && Math.abs(r[0].amount - 42500) < 0.005 && r[0].due_date === '2026-05-20' && r[0].po_number === 'PO-7802'; };
const sawInTrace = (re) => (m) => re.test(m.observations);

// proof = evidence that the failure REALLY happened during the run (so "pass" means "recovered", not "never broke").
const scenarios = [
  { name: 'baseline', chaos: [], task: LATEST, check: enteredCorrectly },
  { name: 'chaos:flakySubmit', chaos: ['flakySubmit'], task: LATEST, check: enteredCorrectly, proof: sawInTrace(/503/) },
  { name: 'chaos:renamedField', chaos: ['renamedField'], task: LATEST, check: enteredCorrectly, proof: sawInTrace(/total_amount/) },
  { name: 'chaos:sessionExpiry', chaos: ['sessionExpiry'], task: LATEST, check: enteredCorrectly, proof: sawInTrace(/session has expired/i) },
  { name: 'chaos:silentCorruption', chaos: ['silentCorruption'], task: LATEST, check: enteredCorrectly, proof: (m) => m.verifierRejections > 0 },
  { name: 'chaos:duplicateExists', chaos: ['duplicateExists'], task: LATEST,
    check: (m) => inv('INV-1002', 'Acme Corp').length === 1 && count() === 5 && ['cannot_complete', 'completed'].includes(m.status), proof: sawInTrace(/Duplicate invoice/) },
  { name: 'task:markPaid', chaos: [], task: 'Mark Globex Ltd invoice INV-7731 as paid in FinDesk.',
    check: () => inv('INV-7731', 'Globex Ltd')[0].status === 'paid' && inv('INV-0055', 'Initech')[0].status === 'pending' },
  { name: 'task:listOverdue', chaos: [], task: 'Which invoices in FinDesk are overdue? List vendor, invoice number, amount and due date.',
    check: (m) => ['INV-1001', 'INV-0055', 'INV-7731'].every((n) => m.summary.includes(n)) && !m.summary.includes('INV-7700') && count() === 4 && count("status='paid'") === 1 },
  { name: 'memory:acrossRuns', chaos: [], phases: [
    { task: 'Enter the latest invoice from Acme Corp into FinDesk. Company rule you must follow and save for the future: Acme Corp invoices are entered in FinDesk with the PO Number field left blank. Save that as a company rule.',
      check: () => /acme/i.test(fs.readFileSync(memFile, 'utf8').split('(learned)').slice(1).join(' ')) && inv('INV-1002', 'Acme Corp')[0]?.po_number == null },
    { task: LATEST, noHumanQuestions: true,
      check: (m) => inv('INV-1002', 'Acme Corp')[0]?.po_number == null && m.asked === 0 },
  ] },
];

async function runOnce(runAgent, deps, task, chaos, humanAnswers = []) {
  const { createChatModel, createTools, Browser, adapter } = deps;
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(__dirname, '..', 'runs', runId);
  const browser = new Browser({ headed: flag('headed'), shotDir: path.join(runDir, 'screenshots') });
  const stats = { asked: 0, approvals: 0 };
  const ctx = { memory: {}, browser, approvalMode: 'auto',
    approve: async () => { stats.approvals++; return true; },
    askHuman: async () => { stats.asked++; return humanAnswers.shift() || 'Use your best judgment. If it cannot be done safely, finish with cannot_complete.'; } };
  try {
    const r = await runAgent({ task, llm: createChatModel(), tools: createTools(ctx), ctx, adapter, maxSteps: 25, runDir, log: () => {} });
    const trace = fs.readFileSync(r.tracePath, 'utf8').trim().split('\n').map(JSON.parse);
    const obs = trace.filter((e) => e.type === 'observation');
    return { status: r.status, steps: r.steps, summary: r.summary || '', tracePath: r.tracePath, asked: stats.asked, approvals: stats.approvals,
      toolErrors: obs.filter((e) => e.result && e.result.ok === false).length,
      verifierRejections: trace.filter((e) => e.type === 'verification' && !e.passed).length,
      escalations: trace.filter((e) => e.type === 'stuck_escalation').length,
      observations: JSON.stringify(obs.map((e) => e.result)) };
  } finally { await browser.close(); }
}

async function erp(pathname, body) {
  const r = await fetch(`${ERP}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-apops-admin': '1' }, body: JSON.stringify(body || {}) });
  return r.json();
}

async function main() {
  const only = opt('only') ? opt('only').split(',') : null;
  const runs = Number(opt('runs', 1));
  const deps = { createChatModel: require('../agent/llm').createChatModel, createTools: require('../agent/tools').createTools, Browser: require('../agent/browser').Browser, adapter: require('../agent/adapters/findesk') };
  const { runAgent } = require('../agent/loop');
  try { await fetch(`${ERP}/admin/chaos`); } catch { console.error(`FinDesk is not running at ${ERP}. Start it with: npm run erp`); process.exit(1); }

  const rows = [];
  for (const s of scenarios.filter((x) => !only || only.includes(x.name))) {
    for (let i = 1; i <= runs; i++) {
      process.stdout.write(`running ${s.name} (${i}/${runs}) ... `);
      await erp('/admin/reset');
      if (s.chaos.length) await erp('/admin/chaos', Object.fromEntries(s.chaos.map((k) => [k, true])));
      let m, pass, hit = null;
      try {
        if (s.phases) {
          pass = true; m = { status: '-', steps: 0, toolErrors: 0, verifierRejections: 0, approvals: 0, escalations: 0, tracePath: '' };
          for (const ph of s.phases) {
            await erp('/admin/reset'); // fresh database, but the (temp) company memory file persists between phases
            const pm = await runOnce(runAgent, deps, ph.task, s.chaos, []);
            pass = pass && !!ph.check(pm);
            m.steps += pm.steps; m.status = pm.status; m.tracePath = pm.tracePath; m.approvals += pm.approvals;
          }
        } else {
          m = await runOnce(runAgent, deps, s.task, s.chaos);
          pass = !!s.check(m);
          hit = s.proof ? !!s.proof(m) : null;
        }
      } catch (e) { m = { status: 'error', steps: 0, toolErrors: 0, verifierRejections: 0, approvals: 0, escalations: 0, tracePath: '', summary: e.message }; pass = false; }
      console.log(pass ? 'PASS' : 'FAIL');
      rows.push({ scenario: s.name, run: i, passed: pass, failureObserved: hit, status: m.status, steps: m.steps, toolErrors: m.toolErrors, verifierRejections: m.verifierRejections, approvals: m.approvals, trace: m.tracePath, note: m.status === 'error' ? m.summary : '' });
    }
  }
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const lines = [`# Eval results`, ``, `Model: ${model}  |  Date: ${new Date().toISOString()}  |  Runs per scenario: ${runs}`, ``,
    `"Failure observed" = the injected failure really showed up in the agent's observations, so a pass means it recovered.`, ``,
    `| Scenario | Passed | Failure observed | Final status | Steps | Tool errors | Verifier rejections | Approvals |`, `|---|---|---|---|---|---|---|---|`,
    ...rows.map((r) => `| ${r.scenario} | ${r.passed ? 'yes' : 'NO'} | ${r.failureObserved === null ? 'n/a' : r.failureObserved ? 'yes' : 'NO'} | ${r.status} | ${r.steps} | ${r.toolErrors} | ${r.verifierRejections} | ${r.approvals} |`)];
  console.log('\n' + lines.join('\n'));
  fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(rows, null, 2));
  fs.writeFileSync(path.join(__dirname, 'RESULTS.md'), lines.join('\n') + '\n');
  console.log('\nSaved evals/results.json and evals/RESULTS.md (copy the table into the README).');
}

// Checks the CHECKERS: each ground-truth check must accept a correct end state and reject wrong ones.
function selftest() {
  const assert = require('assert');
  const { open, reset } = require('../erp/db');
  const db = open(); reset(db);
  const find = (n) => scenarios.find((s) => s.name === n);
  assert.strictEqual(!!find('baseline').check({}), false, 'seed state (nothing entered) must fail');
  db.prepare("INSERT INTO invoices (vendor_id,invoice_number,amount,due_date,po_number) VALUES (1,'INV-1002',4250,'2026-05-20','PO-7802')").run();
  assert.strictEqual(!!find('baseline').check({}), false, 'corrupted amount must fail');
  db.prepare("UPDATE invoices SET amount=42500 WHERE invoice_number='INV-1002'").run();
  assert.strictEqual(!!find('baseline').check({}), true, 'correct entry must pass');
  // Duplicate scenario: seed (4) + the pre-existing duplicate (1) = 5 rows is the correct end state.
  assert.strictEqual(!!find('chaos:duplicateExists').check({ status: 'cannot_complete' }), true, 'no new record + clean stop must pass');
  db.prepare("INSERT INTO invoices (vendor_id,invoice_number,amount,due_date,po_number) VALUES (1,'INV-1003',42500,'2026-05-20','PO-7802')").run();
  assert.strictEqual(!!find('chaos:duplicateExists').check({ status: 'cannot_complete' }), false, 'an extra record created by the agent must fail');
  reset(db);
  db.prepare("INSERT INTO invoices (vendor_id,invoice_number,amount,due_date,po_number) VALUES (1,'INV-1002',42500,'2026-05-20','PO-7802')").run();
  assert.strictEqual(!!find('chaos:duplicateExists').check({ status: 'max_steps' }), false, 'running out of steps must fail');
  reset(db);
  assert.strictEqual(!!find('task:markPaid').check(), false);
  db.prepare("UPDATE invoices SET status='paid' WHERE invoice_number='INV-7731'").run();
  assert.strictEqual(!!find('task:markPaid').check(), true);
  assert.strictEqual(!!find('task:listOverdue').check({ summary: 'INV-1001, INV-0055, INV-7731' }), false, 'already-paid state changed -> fail');
  reset(db);
  assert.strictEqual(!!find('task:listOverdue').check({ summary: 'INV-1001, INV-0055, INV-7731' }), true);
  assert.strictEqual(!!find('task:listOverdue').check({ summary: 'INV-1001, INV-0055, INV-7731, INV-7700' }), false, 'listing a paid invoice must fail');
  assert.strictEqual(sawInTrace(/503/)({ observations: 'Error 503: service' }), true);
  console.log('eval selftest: all checkers behave correctly');
}

if (flag('selftest')) selftest(); else main().catch((e) => { console.error(e); process.exit(1); });
