// Real-browser checks of the browser layer AND the approval boundary. Start FinDesk first (npm run erp).
//   npm run check:browser            (add --headed to watch)
// Optional: PLAYWRIGHT_CHROMIUM_PATH=/path/to/chromium to use a specific Chromium build.
const assert = require('assert');
const { Browser } = require('../agent/browser');
const { classifyClick, authorize } = require('../agent/policy');
const { createTools } = require('../agent/tools');

const ERP = process.env.ERP_URL || 'http://localhost:4000';
// The same two steps the agent runtime performs: assess/pin the element, then click that element.
const assessedClick = async (b, target) => { const info = await b.inspectClick(target); return b.click(target, info.fingerprint); };

(async () => {
  const b = new Browser({ headed: process.argv.includes('--headed'), shotDir: 'runs/browser-check' });
  const results = [];
  const check = async (name, fn) => { await fn(); results.push(name); console.log('PASS  ' + name); };
  try {
    await b.open(`${ERP}/login`);
    await b.type('username', 'admin'); await b.type('password', 'admin123');
    await check('sign in through the real form', async () => { const s = await assessedClick(b, 'Sign in'); assert.ok(s.url.endsWith('/invoices')); });

    await b.open(`${ERP}/invoices/new`);
    await b.type('vendor_id', 'Acme Corp'); await b.type('invoice_number', 'TEST-1'); await b.type('due_date', '2026-05-20');
    await check('form fields can be read back (select by label text, date input)', async () => {
      const r = await b.read();
      assert.ok(r.fields.some((f) => f.name === 'invoice_number' && f.value === 'TEST-1'));
      assert.ok(r.fields.some((f) => f.name === 'due_date' && f.value === '2026-05-20'));
      assert.ok(r.buttons.includes('Submit Invoice'));
    });

    // ---- classification of REAL elements ----
    const classify = async (target) => classifyClick(await b.inspectClick(target));
    await check('real elements: commit buttons need approval, plain links and sign-in do not', async () => {
      assert.strictEqual((await classify('Submit Invoice')).risk, 'irreversible');
      assert.strictEqual((await classify('form button[type=submit]')).risk, 'irreversible', 'a CSS selector must not bypass approval');
      assert.strictEqual((await classify('Invoices')).risk, 'reversible');
    });
    await check('a harmless-looking button inside a POST form is still gated (the original bypass)', async () => {
      await b.page.evaluate(() => { const x = document.createElement('button'); x.textContent = 'Go'; x.type = 'submit'; document.querySelector('form[action="/invoices"]').appendChild(x); });
      assert.strictEqual((await classify('Go')).risk, 'irreversible');
    });
    await check('a clickable div (no form, no link) is default-deny', async () => {
      await b.page.evaluate(() => { const x = document.createElement('div'); x.textContent = 'Next'; x.setAttribute('role', 'button'); x.onclick = () => { fetch('/admin/reset', { method: 'POST' }); }; document.body.appendChild(x); });
      assert.strictEqual((await classify('Next')).risk, 'irreversible');
    });

    // ---- approval boundary through the REAL tool + policy ----
    const tool = createTools({ memory: {}, browser: b }).find((t) => t.name === 'browser_click');
    const flow = async (target, mutate) => {
      let asked = 0;
      const ctx = { browser: b, approve: async () => { asked++; if (mutate) await mutate(); return true; } };
      const auth = await authorize(tool, { target }, ctx);
      return { auth, asked, go: () => tool.run({ target }, { approval: auth }) };
    };
    await b.open(`${ERP}/invoices/1`);
    await check('approval is requested for an irreversible click and the same element is then clicked', async () => {
      const f = await flow('Update Invoice');
      assert.strictEqual(f.asked, 1); assert.strictEqual(f.auth.risk, 'irreversible'); assert.ok(f.auth.token);
      const s = await f.go(); assert.ok(/updated/i.test(s.text));
    });
    await b.open(`${ERP}/invoices/1`);
    await check('element text changed after approval -> refused, nothing clicked', async () => {
      const f = await flow('Update Invoice', () => b.page.evaluate(() => { document.querySelector('button[type=submit]').textContent = 'Pay Now'; }));
      await assert.rejects(f.go, /changed after it was assessed/);
    });
    await b.open(`${ERP}/invoices/1`);
    await check('element removed after approval -> refused', async () => {
      const f = await flow('Update Invoice', () => b.page.evaluate(() => { document.querySelector('button[type=submit]').remove(); }));
      await assert.rejects(f.go, /no longer on the page|no longer the one|changed after/);
    });
    await b.open(`${ERP}/invoices/1`);
    await check('form target changed after approval -> refused', async () => {
      const f = await flow('Update Invoice', () => b.page.evaluate(() => { document.querySelector('form[action$="/edit"]').setAttribute('action', '/invoices/1/pay'); }));
      await assert.rejects(f.go, /changed after it was assessed/);
    });
    await b.open(`${ERP}/invoices/1`);
    await check('page changed after approval (client-side navigation) -> refused', async () => {
      const f = await flow('Update Invoice', () => b.page.evaluate(() => history.pushState({}, '', '/invoices/2')));
      await assert.rejects(f.go, /changed after it was assessed/);
    });
    await b.open(`${ERP}/invoices/1`);
    await check('an approval token cannot be reused for a second click', async () => {
      const f = await flow('Update Invoice');
      await f.go();
      await b.open(`${ERP}/invoices/1`);
      await assert.rejects(f.go, /no longer the one that was assessed/);
    });
    await b.open(`${ERP}/invoices/1`);
    await check('a token from one element cannot be used to click a different one', async () => {
      const a = await flow('Update Invoice'); // assess + pin the Update button
      const paid = await b.inspectClick('Mark as Paid'); // pin moves to a different element
      await assert.rejects(() => b.click('Mark as Paid', a.auth.token), /no longer the one that was assessed/);
      assert.ok(paid.fingerprint);
    });
    await check('a click with no assessment token is refused', async () => {
      await assert.rejects(() => tool.run({ target: 'Update Invoice' }, {}), /not assessed/);
    });
    await check('the approval dialog data shows what is about to be submitted', async () => {
      await b.open(`${ERP}/invoices/new`);
      await b.type('invoice_number', 'SHOW-1');
      const v = await b.formValues();
      assert.strictEqual(v.filled_fields['Invoice Number'], 'SHOW-1');
    });
    await check('screenshots can be saved as evidence', async () => { assert.ok((await b.screenshot('check')).endsWith('.png')); });

    console.log(`\nBrowser layer and approval boundary OK (${results.length} checks)`);
  } finally { await b.close(); }
})().catch((e) => { console.error('Browser check failed:', e.message); process.exit(1); });
