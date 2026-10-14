// Web UI for the agent: start a task, watch every step live, approve/deny actions, see the real database.
// The UI is an observer: it runs the same runAgent() as the CLI and reads the database read-only.
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

function createApp(deps = {}) {
  const ERP = process.env.ERP_URL || 'http://localhost:4000';
  const { runAgent } = require('../agent/loop');
  const { createTools } = require('../agent/tools');
  const { Browser } = require('../agent/browser');
  const adapter = require('../agent/adapters/findesk');
  const { DB_PATH } = require('../erp/db');
  const llmFactory = deps.llmFactory || (() => require('../agent/llm').createChatModel());
  const toolsFactory = deps.toolsFactory || ((ctx) => createTools(ctx));
  const useErp = deps.skipErp !== true;
  const RUNS_DIR = deps.runsDir || path.join(__dirname, '..', 'runs');

  const app = express();
  app.use(express.json({ limit: '20kb' }));

  // ---- Access control: only the page this server served can start runs or approve actions ----
  // Threat: any web page open in the user's browser can send requests to localhost. Layers:
  //  1) Host must be localhost/127.0.0.1 (blocks DNS rebinding).
  //  2) A random per-server token is set as an HttpOnly SameSite=Strict cookie when the page loads, and is required
  //     on every /api and /runs request (also protects the live stream and screenshots).
  //  3) State-changing requests also need the same token in an x-ui-token header (embedded in the page; a cross-origin
  //     page cannot read it), a matching Origin (if sent) and a JSON content type.
  const TOKEN = deps.token || crypto.randomBytes(32).toString('hex');
  const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
  const allowAutoApprove = deps.allowAutoApprove ?? process.env.UI_ALLOW_AUTO_APPROVE === '1';
  const cookieOf = (req) => Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((c) => { const i = c.indexOf('='); return [c.slice(0, i).trim(), c.slice(i + 1).trim()]; }));
  const tokenOk = (v) => { const a = Buffer.from(String(v || '')), b = Buffer.from(TOKEN); return a.length === b.length && crypto.timingSafeEqual(a, b); };
  const sameOrigin = (req) => { if (!req.headers.origin) return true; try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; } };

  app.use((req, res, next) => (LOCAL_HOST.test(req.headers.host || '') ? next() : res.status(403).send('Forbidden host')));
  const guard = (req, res, next) => {
    if (!tokenOk(cookieOf(req).ui_session)) return res.status(401).json({ error: 'Unauthorized. Open the UI page first.' });
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (!sameOrigin(req)) return res.status(403).json({ error: 'Cross-origin request refused.' });
      if (!tokenOk(req.headers['x-ui-token'])) return res.status(403).json({ error: 'Missing or invalid x-ui-token.' });
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return res.status(415).json({ error: 'JSON required.' });
    }
    next();
  };
  const CHAOS_NAMES = ['flakySubmit', 'renamedField', 'sessionExpiry', 'silentCorruption', 'duplicateExists'];

  app.get('/', (req, res) => {
    res.set({ 'Set-Cookie': `ui_session=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`, 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' });
    res.type('html').send(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').replace('__UI_TOKEN__', TOKEN));
  });
  app.use('/api', guard);
  app.use('/runs', guard, (req, res, next) => (req.path.endsWith('.jsonl') ? res.status(404).end() : next()), express.static(RUNS_DIR));

  let run = null, seq = 0, reqSeq = 0, buffer = [];
  const clients = new Set();
  const pending = new Map();

  const emit = (e) => {
    const ev = { id: ++seq, ...e };
    buffer.push(ev);
    for (const res of clients) res.write(`id: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`);
  };

  app.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    const last = Number(req.headers['last-event-id'] || 0);
    for (const ev of buffer) if (ev.id > last) res.write(`id: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });

  app.get('/api/state', async (req, res) => {
    let erp = !useErp;
    if (useErp) { try { await fetch(`${ERP}/admin/chaos`); erp = true; } catch { erp = false; } }
    res.json({ running: !!run, erp, allowAutoApprove });
  });

  app.get('/api/invoices', (req, res) => {
    if (!fs.existsSync(DB_PATH)) return res.json([]);
    const db = new Database(DB_PATH, { readonly: true });
    try {
      res.json(db.prepare('SELECT i.id, v.name AS vendor, i.invoice_number, i.amount, i.due_date, i.po_number, i.status FROM invoices i JOIN vendors v ON v.id = i.vendor_id ORDER BY i.id').all());
    } catch { res.json([]); } finally { db.close(); }
  });

  // ---- run history: every past run's trace (actions) and model log (what the LLM saw and said) ----
  const RUN_ID = /^[0-9TZ-]{10,40}$/; // run folders are ISO timestamps; this also rules out path traversal
  const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
  app.get('/api/runs', (req, res) => {
    if (!fs.existsSync(RUNS_DIR)) return res.json([]);
    const ids = fs.readdirSync(RUNS_DIR).filter((d) => RUN_ID.test(d) && fs.existsSync(path.join(RUNS_DIR, d, 'trace.jsonl'))).sort().reverse().slice(0, 40);
    res.json(ids.map((id) => {
      const ev = readJsonl(path.join(RUNS_DIR, id, 'trace.jsonl'));
      const task = ev.find((e) => e.type === 'task'); const end = [...ev].reverse().find((e) => e.type === 'result' || e.type === 'error');
      return { id, started: ev[0] && ev[0].t, task: task && task.task, status: end ? (end.type === 'error' ? 'error' : end.status) : 'unfinished', steps: end && end.steps, summary: end && (end.summary || end.message) };
    }));
  });
  const runFile = (name) => (req, res) => {
    if (!RUN_ID.test(req.params.id)) return res.status(400).json({ error: 'Bad run id.' });
    const f = path.join(RUNS_DIR, req.params.id, name);
    if (!fs.existsSync(f)) return res.status(404).json({ error: 'No such run.' });
    res.json(readJsonl(f));
  };
  app.get('/api/runs/:id/trace', runFile('trace.jsonl'));
  app.get('/api/runs/:id/llm', runFile('llm.jsonl'));

  const erpPost = (p, body) => fetch(`${ERP}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-apops-admin': '1' }, body: JSON.stringify(body || {}) });

  // Ask the human through the UI and wait for the answer.
  const ask = (kind, payload) => new Promise((resolve) => {
    const reqId = ++reqSeq;
    pending.set(reqId, { kind, resolve });
    emit({ kind, reqId, ...payload });
  });

  app.post('/api/respond', (req, res) => {
    const p = pending.get(Number(req.body.reqId));
    if (!p) return res.status(404).json({ error: 'No such pending request.' });
    pending.delete(Number(req.body.reqId));
    const value = p.kind === 'approval_request' ? req.body.value === true : String(req.body.value ?? '').slice(0, 2000);
    emit({ kind: 'response_recorded', reqId: Number(req.body.reqId), value });
    p.resolve(value);
    res.json({ ok: true });
  });

  app.post('/api/stop', (req, res) => {
    if (!run) return res.json({ ok: true });
    run.ctx.stopRequested = true;
    emit({ kind: 'stopping' });
    for (const [id, p] of pending) { pending.delete(id); p.resolve(p.kind === 'approval_request' ? false : 'stop'); }
    res.json({ ok: true });
  });

  app.post('/api/run', async (req, res) => {
    if (run) return res.status(409).json({ error: 'A run is already in progress.' });
    const { task, chaos = [], reset = true, headed = false, autoApprove = false } = req.body || {};
    if (typeof task !== 'string' || !task.trim()) return res.status(400).json({ error: 'Type a task first.' });
    if (task.length > 2000) return res.status(400).json({ error: 'Task is too long (2000 characters max).' });
    if (!Array.isArray(chaos) || chaos.some((c) => !CHAOS_NAMES.includes(c))) return res.status(400).json({ error: 'Unknown chaos option.' });
    if (typeof reset !== 'boolean' || typeof headed !== 'boolean' || typeof autoApprove !== 'boolean') return res.status(400).json({ error: 'Invalid options.' });
    if (autoApprove && !allowAutoApprove) return res.status(403).json({ error: 'Auto-approve is disabled. Start the UI with UI_ALLOW_AUTO_APPROVE=1 to enable it.' });
    try {
      if (useErp) {
        if (reset) await erpPost('/admin/reset');
        if (chaos.length) await erpPost('/admin/chaos', Object.fromEntries(chaos.map((k) => [k, true])));
      }
    } catch (e) { return res.status(502).json({ error: `FinDesk is not reachable at ${ERP}.` }); }

    const runId = new Date().toISOString().replace(/[:.]/g, '-');
    const runDir = path.join(RUNS_DIR, runId);
    const browser = new Browser({ headed, shotDir: path.join(runDir, 'screenshots') });
    const ctx = {
      memory: {}, browser, stopRequested: false, approvalMode: autoApprove ? 'auto' : 'interactive',
      approve: (a) => (autoApprove ? Promise.resolve(true) : ask('approval_request', a)),
      askHuman: (question) => ask('question', { question }),
    };
    run = { runId, ctx };
    buffer = []; seq = 0; pending.clear();
    emit({ kind: 'run_start', task, chaos, runId, autoApprove });
    res.json({ ok: true, runId });

    (async () => {
      try {
        const r = await runAgent({ task, llm: llmFactory(), tools: toolsFactory(ctx), ctx, adapter, maxSteps: 25, runDir, log: () => {}, onEvent: (ev) => emit({ kind: 'trace', ev }) });
        let screenshot = null;
        if (browser.isOpen && r.status === 'completed') {
          try { screenshot = `/runs/${runId}/screenshots/${path.basename(await browser.screenshot('final_state'))}`; } catch { /* optional */ }
        }
        emit({ kind: 'result', status: r.status, steps: r.steps, summary: r.summary || '', verification: r.verification || null, externalStateChanged: !!r.externalStateChanged, persistentMemoryChanged: !!r.persistentMemoryChanged, screenshot, trace: path.relative(path.join(__dirname, '..'), r.tracePath) });
      } catch (e) {
        emit({ kind: 'error', message: e.message });
      } finally {
        await browser.close().catch(() => {});
        run = null;
        emit({ kind: 'idle' });
      }
    })();
  });

  return app;
}

async function ensureErp() {
  const ERP = process.env.ERP_URL || 'http://localhost:4000';
  try { await fetch(`${ERP}/admin/chaos`); return null; } catch { /* not running: start it */ }
  const child = spawn('node', [path.join(__dirname, '..', 'erp', 'server.js')], { stdio: 'inherit' });
  const stop = () => { child.kill(); process.exit(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop); process.on('exit', () => child.kill());
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try { await fetch(`${ERP}/admin/chaos`); return child; } catch { /* keep waiting */ }
  }
  throw new Error('Could not start FinDesk.');
}

if (require.main === module) {
  const PORT = process.env.UI_PORT || 3000;
  ensureErp().then(() => createApp().listen(PORT, 'localhost', () => console.log(`\nApOps Agent UI: http://localhost:${PORT}  (reachable from this machine only)\n`)))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
module.exports = { createApp };
