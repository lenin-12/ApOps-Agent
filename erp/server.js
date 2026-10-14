// FinDesk: a deliberately ordinary mock accounts-payable web app.
// It has chaos toggles (see /admin/chaos) so we can test how the agent copes with failures.
const express = require('express');
const crypto = require('crypto');
const { open, reset, init } = require('./db');

const PORT = process.env.ERP_PORT || 4000;
const db = open();
init(db);

const chaos = { flakySubmit: false, renamedField: false, sessionExpiry: false, silentCorruption: false, duplicateExists: false };
let flakyLeft = 0;
let expiryDone = false;
const sessions = new Map();

const app = express();
// Browser-based attacks on localhost: reject unexpected Host headers (DNS rebinding) and require a custom header on
// state-changing admin calls (a cross-origin web page cannot send it without a CORS preflight, which this server refuses).
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
app.use((req, res, next) => (LOCAL_HOST.test(req.headers.host || '') ? next() : res.status(403).send('Forbidden host')));
app.use('/admin', (req, res, next) => (req.method === 'GET' || req.headers['x-apops-admin'] === '1' ? next() : res.status(403).json({ error: 'Missing x-apops-admin header' })));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((c) => c.trim().split('=')));

function page(title, body, user) {
  const nav = user
    ? '<nav><a href="/invoices">Invoices</a> | <a href="/invoices/new">New Invoice</a> | <a href="/logout">Logout</a></nav>'
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} - FinDesk</title>
<style>body{font-family:sans-serif;max-width:820px;margin:24px auto;padding:0 12px}label{display:block;margin-top:10px}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px;text-align:left}
.error{color:#b00020;font-weight:bold}.ok{color:#0a7d2c;font-weight:bold}input,select{padding:5px;min-width:260px}button{margin-top:14px;padding:6px 14px}</style>
</head><body><h2>FinDesk Accounts Payable</h2>${nav}<hr><h3>${esc(title)}</h3>${body}</body></html>`;
}

function auth(req, res, next) {
  const sid = cookies(req).sid;
  const s = sid && sessions.get(sid);
  if (!s) return res.redirect('/login');
  s.count++;
  if (chaos.sessionExpiry && !expiryDone && s.count > 2) {
    expiryDone = true;
    sessions.delete(sid);
    return res.redirect('/login?expired=1');
  }
  req.user = s.user;
  next();
}

// ---------- admin / chaos control (test harness only, not part of the "company system") ----------
app.get('/admin/chaos', (req, res) => res.json(chaos));
app.post('/admin/chaos', (req, res) => {
  for (const k of Object.keys(chaos)) if (typeof req.body[k] === 'boolean') chaos[k] = req.body[k];
  if (chaos.flakySubmit) flakyLeft = 1;
  if (chaos.sessionExpiry) expiryDone = false;
  if (chaos.duplicateExists) {
    db.prepare("INSERT OR IGNORE INTO invoices (vendor_id, invoice_number, amount, due_date, po_number) VALUES (1,'INV-1002',42500,'2026-05-20','PO-7802')").run();
  }
  res.json(chaos);
});
app.post('/admin/reset', (req, res) => {
  reset(db);
  for (const k of Object.keys(chaos)) chaos[k] = false;
  flakyLeft = 0; expiryDone = false; sessions.clear();
  res.json({ ok: true });
});

// ---------- login ----------
app.get('/login', (req, res) => {
  const note = req.query.expired ? '<p class="error">Your session has expired. Please sign in again.</p>' : req.query.bad ? '<p class="error">Invalid username or password.</p>' : '';
  res.send(page('Sign in', `${note}<form method="POST" action="/login">
<label>Username <input name="username" type="text"></label>
<label>Password <input name="password" type="password"></label>
<button type="submit">Sign in</button></form>`));
});
app.post('/login', (req, res) => {
  if (req.body.username === 'admin' && req.body.password === 'admin123') {
    const sid = crypto.randomBytes(12).toString('hex');
    sessions.set(sid, { user: 'admin', count: 0 });
    res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly`);
    return res.redirect('/invoices');
  }
  res.redirect('/login?bad=1');
});
app.get('/logout', (req, res) => { sessions.delete(cookies(req).sid); res.redirect('/login'); });
app.get('/', (req, res) => res.redirect('/invoices'));

// ---------- invoices ----------
const listSql = `SELECT i.id, v.name AS vendor, i.invoice_number, i.amount, i.due_date, i.po_number, i.status
                 FROM invoices i JOIN vendors v ON v.id = i.vendor_id`;

app.get('/invoices', auth, (req, res) => {
  const rows = req.query.status
    ? db.prepare(listSql + ' WHERE i.status = ? ORDER BY i.id').all(req.query.status)
    : db.prepare(listSql + ' ORDER BY i.id').all();
  const body = `<table><tr><th>ID</th><th>Vendor</th><th>Invoice No</th><th>Amount (INR)</th><th>Due Date</th><th>PO</th><th>Status</th></tr>
${rows.map((r) => `<tr><td><a href="/invoices/${r.id}">${r.id}</a></td><td>${esc(r.vendor)}</td><td>${esc(r.invoice_number)}</td><td>${money(r.amount)}</td><td>${esc(r.due_date)}</td><td>${esc(r.po_number)}</td><td>${esc(r.status)}</td></tr>`).join('')}</table>`;
  res.send(page('Invoices', body, req.user));
});

function newForm(user, error) {
  const vendors = db.prepare('SELECT id, name FROM vendors ORDER BY name').all();
  const amountName = chaos.renamedField ? 'total_amount' : 'amount';
  const amountLabel = chaos.renamedField ? 'Total Amount (INR)' : 'Amount (INR)';
  const btn = chaos.renamedField ? 'Save Invoice' : 'Submit Invoice';
  return page('New Invoice', `${error ? `<p class="error">${esc(error)}</p>` : ''}<form method="POST" action="/invoices">
<label>Vendor <select name="vendor_id">${vendors.map((v) => `<option value="${v.id}">${esc(v.name)}</option>`).join('')}</select></label>
<label>Invoice Number <input name="invoice_number" type="text"></label>
<label>${amountLabel} <input name="${amountName}" type="text"></label>
<label>Due Date <input name="due_date" type="date"></label>
<label>PO Number <input name="po_number" type="text"></label>
<button type="submit">${btn}</button></form>`, user);
}

app.get('/invoices/new', auth, (req, res) => res.send(newForm(req.user)));

app.post('/invoices', auth, (req, res) => {
  if (chaos.flakySubmit && flakyLeft > 0) {
    flakyLeft--;
    return res.status(503).send(page('Service Unavailable', '<p class="error">Error 503: service temporarily unavailable. Please try again.</p>', req.user));
  }
  const b = req.body;
  const amount = parseFloat(String(b.amount ?? b.total_amount ?? '').replace(/,/g, ''));
  const vendor = db.prepare('SELECT id, name FROM vendors WHERE id = ?').get(Number(b.vendor_id));
  if (!vendor) return res.status(400).send(newForm(req.user, 'Please select a vendor.'));
  if (!b.invoice_number || !b.invoice_number.trim()) return res.status(400).send(newForm(req.user, 'Invoice number is required.'));
  if (!(amount > 0)) return res.status(400).send(newForm(req.user, 'Amount must be a positive number.'));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.due_date || '')) return res.status(400).send(newForm(req.user, 'Due date is required (YYYY-MM-DD).'));
  const dup = db.prepare('SELECT id FROM invoices WHERE vendor_id = ? AND invoice_number = ?').get(vendor.id, b.invoice_number.trim());
  if (dup) return res.status(409).send(newForm(req.user, `Duplicate invoice: ${b.invoice_number.trim()} already exists for ${vendor.name} (record #${dup.id}).`));
  const stored = chaos.silentCorruption ? Math.floor(amount / 10) : amount; // silent data corruption: UI still says "saved"
  const r = db.prepare('INSERT INTO invoices (vendor_id, invoice_number, amount, due_date, po_number) VALUES (?,?,?,?,?)')
    .run(vendor.id, b.invoice_number.trim(), stored, b.due_date, (b.po_number || '').trim() || null);
  res.redirect(`/confirmation/${r.lastInsertRowid}`);
});

app.get('/confirmation/:id', auth, (req, res) => {
  const r = db.prepare(listSql + ' WHERE i.id = ?').get(req.params.id);
  if (!r) return res.status(404).send(page('Not found', '<p class="error">No such record.</p>', req.user));
  res.send(page('Saved', `<p class="ok">Invoice saved successfully.</p><p>Reference: #${r.id} (${esc(r.invoice_number)})</p><p><a href="/invoices/${r.id}">View invoice</a></p>`, req.user));
});

app.get('/invoices/:id', auth, (req, res) => {
  const r = db.prepare(listSql + ' WHERE i.id = ?').get(req.params.id);
  if (!r) return res.status(404).send(page('Not found', '<p class="error">No such invoice.</p>', req.user));
  const flash = req.query.flash ? `<p class="ok">${esc(req.query.flash)}</p>` : '';
  res.send(page(`Invoice ${r.invoice_number}`, `${flash}<table>
<tr><th>Vendor</th><td>${esc(r.vendor)}</td></tr><tr><th>Invoice Number</th><td>${esc(r.invoice_number)}</td></tr>
<tr><th>Amount (INR)</th><td>${money(r.amount)}</td></tr><tr><th>Due Date</th><td>${esc(r.due_date)}</td></tr>
<tr><th>PO Number</th><td>${esc(r.po_number)}</td></tr><tr><th>Status</th><td>${esc(r.status)}</td></tr></table>
<h4>Edit</h4><form method="POST" action="/invoices/${r.id}/edit">
<label>Amount (INR) <input name="amount" type="text" value="${r.amount}"></label>
<label>Due Date <input name="due_date" type="date" value="${esc(r.due_date)}"></label>
<button type="submit">Update Invoice</button></form>
${r.status === 'pending' ? `<form method="POST" action="/invoices/${r.id}/pay"><button type="submit">Mark as Paid</button></form>` : ''}`, req.user));
});

app.post('/invoices/:id/edit', auth, (req, res) => {
  const amount = parseFloat(String(req.body.amount || '').replace(/,/g, ''));
  if (!(amount > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(req.body.due_date || '')) {
    return res.status(400).send(page('Error', '<p class="error">Invalid amount or due date.</p>', req.user));
  }
  db.prepare('UPDATE invoices SET amount = ?, due_date = ? WHERE id = ?').run(amount, req.body.due_date, req.params.id);
  res.redirect(`/invoices/${req.params.id}?flash=${encodeURIComponent('Invoice updated.')}`);
});

app.post('/invoices/:id/pay', auth, (req, res) => {
  db.prepare("UPDATE invoices SET status = 'paid' WHERE id = ?").run(req.params.id);
  res.redirect(`/invoices/${req.params.id}?flash=${encodeURIComponent('Invoice marked as paid.')}`);
});

if (require.main === module) {
  app.listen(PORT, 'localhost', () => console.log(`FinDesk running on http://localhost:${PORT}  (login: admin / admin123)`));
}
module.exports = app;
