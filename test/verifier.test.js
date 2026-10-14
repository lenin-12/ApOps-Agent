// Verifier edge cases: wrong fields, conflicting values, odd formats, missing labels, human-in-the-loop for ambiguity.
const { call, scripted: scriptedModel } = require('./helpers/scripted-model');
const scripted = (steps) => scriptedModel(steps, { clamp: true });
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-'));
process.env.FILES_DIR = dir; // must be set before the tools module loads
const real = require('../agent/adapters/findesk');
const { verify } = require('../agent/verifier');
const { runAgent } = require('../agent/loop');

const doc = (name, text) => fs.writeFileSync(path.join(dir, name), text);
const adapterFor = (row) => ({ fieldLabels: real.fieldLabels, fieldTypes: real.fieldTypes, lookup: () => row });
const claim = (fields, file, key = { vendor: 'Acme Corp', invoice_number: 'INV-1002' }) => [{ entity: 'invoice', key, fields, source_file: file }];
const row = (o = {}) => ({ invoice_number: 'INV-1002', vendor: 'Acme Corp', amount: 42500, due_date: '2026-05-20', po_number: 'PO-7802', status: 'pending', ...o });
const run = (fields, file, r, opts) => verify(claim(fields, file), adapterFor(r || row(fields)), opts);
let n = 0; const ok = (m) => { n++; console.log('PASS  ' + m); };

(async () => {
  // ---- conflicting values in the source document ----
  doc('revised.txt', 'Invoice No: INV-1002\nOriginal Total Amount Due 42,500.00\nRevised Total Amount Due 40,000.00\nDue Date: 20 May 2026\n');
  let r = await run({ amount: 40000 }, 'revised.txt'); assert.strictEqual(r.passed, false); assert.ok(r.ambiguous && /AMBIGUOUS SOURCE/.test(r.problems.join()) && /42500\.00 vs 40000\.00|40000\.00 vs 42500\.00/.test(r.problems.join()));
  r = await run({ amount: 42500 }, 'revised.txt'); assert.strictEqual(r.passed, false, 'even the first value must not pass silently');
  ok('conflicting totals (original vs revised) fail with both values listed, whichever one is claimed');
  r = await run({ amount: 40000 }, 'revised.txt', row({ amount: 40000 }), { humanResolvedAmbiguity: true }); assert.strictEqual(r.passed, true); assert.strictEqual(r.ambiguous, true);
  r = await run({ amount: 39000 }, 'revised.txt', row({ amount: 39000 }), { humanResolvedAmbiguity: true }); assert.strictEqual(r.passed, false, 'after a human is consulted the value must still appear in the document');
  ok('after a human is consulted the claim can pass, but only with a value that is really in the document');

  doc('repeat.txt', 'Total Amount Due 42,500.00\nSummary\nTotal Amount Due (INR) 42,500.00\n');
  assert.strictEqual((await run({ amount: 42500 }, 'repeat.txt')).passed, true); ok('the same total printed twice is not ambiguous');
  doc('dates-in-line.txt', 'Total Amount Due as of 20 May 2026: 42,500.00\nDue Date: 20 May 2026\n');
  assert.strictEqual((await run({ amount: 42500, due_date: '2026-05-20' }, 'dates-in-line.txt')).passed, true); ok('a date on the amount line is not mistaken for a second amount');
  doc('latefee.txt', 'Due Date: 20 May 2026. Payments after 05 June 2026 incur a late fee.\n');
  r = await run({ due_date: '2026-05-20' }, 'latefee.txt'); assert.strictEqual(r.passed, false); assert.ok(r.ambiguous); ok('two different dates on the due-date line are flagged for a human');
  doc('samedate.txt', 'Due Date: 20 May 2026 (20/05/2026)\n');
  assert.strictEqual((await run({ due_date: '2026-05-20' }, 'samedate.txt')).passed, true); ok('one date written in two formats is not ambiguous');

  // ---- formatting and layout variations that must still pass ----
  doc('nextline.txt', 'Total Amount Due\n42,500.00\nDue Date\n20 May 2026\n');
  assert.strictEqual((await run({ amount: 42500, due_date: '2026-05-20' }, 'nextline.txt')).passed, true); ok('value on the line after its label');
  doc('upper.txt', 'TOTAL AMOUNT DUE   42,500.00\nDUE DATE: 20 MAY 2026\n');
  assert.strictEqual((await run({ amount: 42500, due_date: '2026-05-20' }, 'upper.txt')).passed, true); ok('upper-case labels and month names');
  for (const [i, line] of ['Total Amount Due Rs. 42,500/-', 'Total Amount Due INR 42500', 'Total Amount Due ₹42,500.00', 'Total Amount Due: 42500.0'].entries()) {
    doc(`cur${i}.txt`, line + '\n'); assert.strictEqual((await run({ amount: 42500 }, `cur${i}.txt`)).passed, true, line);
  }
  ok('currency prefixes and suffixes (Rs., INR, rupee sign, /-) and plain numbers');
  for (const [i, d] of ['20/05/2026', 'May 20, 2026', '2026-05-20', '20 May 2026'].entries()) {
    doc(`date${i}.txt`, `Due Date: ${d}\n`); assert.strictEqual((await run({ due_date: '2026-05-20' }, `date${i}.txt`)).passed, true, d);
  }
  ok('four different date formats');

  // ---- things that must be rejected ----
  doc('normal.txt', 'Invoice Date: 20 April 2026\nDue Date: 20 May 2026\nSubtotal 36,016.95\nTotal Amount Due (INR) 42,500.00\nPO Reference: PO-7802\n');
  for (const bad of [4250, 425000, 36016.95, 4250.0]) assert.strictEqual((await run({ amount: bad }, 'normal.txt', row({ amount: bad }))).passed, false, String(bad));
  ok('wrong amounts (a digit dropped, a digit added, the subtotal) are rejected even when the database matches the claim');
  assert.strictEqual((await run({ due_date: '2026-04-20' }, 'normal.txt', row({ due_date: '2026-04-20' }))).passed, false); ok('the invoice date is rejected as a due date');
  r = await run({ amount: 42500 }, 'normal.txt', row({ amount: 4250 })); assert.strictEqual(r.passed, false); assert.ok(/stored as 4250/.test(r.problems.join())); ok('document matches the claim but the database does not: rejected');
  r = await verify(claim({ amount: 42500 }, 'normal.txt'), { ...adapterFor(null) }); assert.strictEqual(r.passed, false); assert.ok(/NOT found/.test(r.problems.join())); ok('record missing from the system: rejected');
  r = await verify(claim({ amount: 42500 }, 'missing-file.pdf'), adapterFor(row())); assert.strictEqual(r.passed, false); ok('unreadable source file: rejected, not skipped');
  r = await verify(claim({ amount: 42500 }, '../outside.txt'), adapterFor(row())); assert.strictEqual(r.passed, false); ok('source path outside the files folder: rejected');
  r = await run({ invoice_number: 'INV-9999' }, 'normal.txt'); // identifier must also match the document
  doc('ids.txt', 'Invoice No: INV-1001\nTotal Amount Due 42,500.00\n');
  r = await verify(claim({ amount: 42500 }, 'ids.txt'), adapterFor(row())); assert.strictEqual(r.passed, false); assert.ok(/invoice_number/.test(r.problems.join())); ok('the invoice number claimed does not match the one in the document: rejected');

  // ---- lenient cases that are recorded rather than failed ----
  doc('nolabel.txt', 'Amount payable: 42,500.00\n');
  r = await run({ amount: 42500 }, 'nolabel.txt'); assert.strictEqual(r.passed, true); assert.strictEqual(r.checks.find((c) => c.field === 'amount').label_check, 'no_label_found'); ok('no known label in the document: value must still appear, and the check records "no_label_found"');
  r = await run({ po_number: '' }, 'normal.txt', row({ po_number: '' })); assert.strictEqual(r.passed, true); ok('an intentionally blank PO is not checked against the document');
  assert.strictEqual((await run({ status: 'paid' }, 'normal.txt', row({ status: 'paid' }))).passed, true); ok('status claims are checked against the database only');

  // ---- loop level: a human must be consulted before a conflicting document can pass ----
  doc('amb.txt', 'Original Total Amount Due 42,500.00\nRevised Total Amount Due 40,000.00\n');
      const fin = call('finish', { status: 'completed', summary: 's', claims: claim({ amount: 40000 }, 'amb.txt') });
  const tools = [{ name: 'ask_human', risk: 'safe', description: '', parameters: { type: 'object', properties: {} }, run: async () => ({ answer: 'use the revised total' }) }];
  const mkctx = () => ({ memory: {}, askHuman: async () => '', approve: async () => true });
  const rd = () => path.join(os.tmpdir(), 'vr-' + Math.random());
  let res = await runAgent({ task: 't', llm: scripted([fin, fin, fin]), tools, ctx: mkctx(), adapter: adapterFor(row({ amount: 40000 })), runDir: rd(), log: () => {} });
  assert.strictEqual(res.status, 'verification_failed', 'finishing again without asking a human must keep failing');
  res = await runAgent({ task: 't', llm: scripted([fin, call('ask_human', { question: 'Which total?' }), fin]), tools, ctx: mkctx(), adapter: adapterFor(row({ amount: 40000 })), runDir: rd(), log: () => {} });
  assert.strictEqual(res.status, 'completed'); ok('loop: conflicting source fails until the agent actually asks a human, then it can complete');
  res = await runAgent({ task: 't', llm: scripted([call('ask_human', { question: 'preemptive question' }), fin, fin, fin]), tools, ctx: mkctx(), adapter: adapterFor(row({ amount: 40000 })), runDir: rd(), log: () => {} });
  assert.strictEqual(res.status, 'verification_failed'); ok('loop: asking a human BEFORE the conflict was reported does not count');

  // ---- D-1: document-derived fields must name their source when state changed ----
  r = await verify([{ entity: 'invoice', key: { vendor: 'Acme Corp', invoice_number: 'INV-1002' }, fields: { amount: 42500 } }], adapterFor(row()), { stateChanged: true });
  assert.strictEqual(r.passed, false); assert.ok(/no source_file/.test(r.problems.join()));
  r = await verify([{ entity: 'invoice', key: { vendor: 'Globex Ltd', invoice_number: 'INV-7731' }, fields: { status: 'paid' } }], adapterFor(row({ vendor: 'Globex Ltd', invoice_number: 'INV-7731', status: 'paid' })), { stateChanged: true });
  assert.strictEqual(r.passed, true, 'a status-only claim (mark as paid) needs no source document');
  ok('D-1: amount/date/PO claims without source_file fail after a state change; status-only claims still pass');

  console.log(`\n${n} verifier checks groups passed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
