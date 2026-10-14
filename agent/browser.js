// Thin Playwright wrapper. The agent perceives pages as text + a list of fields/buttons/links (no vision).
const path = require('path');
const fs = require('fs');

class Browser {
  constructor({ headed = false, shotDir } = {}) {
    this.headed = headed;
    this.shotDir = shotDir;
    this.page = null;
  }

  async ensure() {
    if (this.page) return;
    const { chromium } = require('playwright');
    const custom = process.env.PLAYWRIGHT_CHROMIUM_PATH;
    this.browser = await chromium.launch(custom
      ? { headless: !this.headed, executablePath: custom, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process', '--no-zygote'] }
      : { headless: !this.headed });
    this.context = await this.browser.newContext();
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(8000);
  }

  get isOpen() { return !!this.page; }

  async summary(chars = 1500) {
    const text = await this.page.evaluate(() => document.body.innerText);
    return { url: this.page.url(), title: await this.page.title(), text: text.slice(0, chars) };
  }

  async open(url) {
    await this.ensure();
    const resp = await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    const s = await this.summary();
    return { status: resp ? resp.status() : null, ...s };
  }

  async read() {
    if (!this.page) throw new Error('No page is open. Use browser_open first.');
    return this.page.evaluate(() => {
      const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const fields = [...document.querySelectorAll('input,select,textarea')]
        .filter((e) => vis(e) && e.type !== 'hidden' && e.type !== 'submit')
        .map((e) => ({
          tag: e.tagName.toLowerCase(), type: e.type || null, name: e.name || null,
          label: (e.labels && e.labels[0] ? e.labels[0].innerText.trim() : null),
          value: e.value || '',
          options: e.tagName === 'SELECT' ? [...e.options].map((o) => o.text) : undefined,
        }));
      const buttons = [...document.querySelectorAll('button,input[type=submit]')].filter(vis).map((e) => (e.innerText || e.value || '').trim());
      const links = [...document.querySelectorAll('a[href]')].filter(vis).map((a) => ({ text: a.innerText.trim(), href: a.getAttribute('href') }));
      return { url: location.href, title: document.title, text: document.body.innerText.slice(0, 5000), fields, buttons, links };
    });
  }

  async locate(field) {
    const q = field.replace(/"/g, '\\"');
    const candidates = [
      this.page.locator(`[name="${q}"]`),
      this.page.locator(`[id="${q}"]`),
      this.page.getByLabel(field),
      this.page.getByPlaceholder(field),
    ];
    for (const c of candidates) if ((await c.count()) > 0) return c.first();
    throw new Error(`No input found matching "${field}". Use browser_read to see the available fields.`);
  }

  async type(field, value) {
    if (!this.page) throw new Error('No page is open. Use browser_open first.');
    const loc = await this.locate(field);
    const tag = await loc.evaluate((e) => e.tagName);
    if (tag === 'SELECT') {
      await loc.selectOption({ label: value }).catch(() => loc.selectOption(value));
    } else {
      await loc.fill(String(value));
    }
    return { field, value: await loc.inputValue() };
  }

  // Resolve a target (visible text, role name, or CSS selector) to ONE element. Shared by inspectClick and click,
  // so the element that is assessed for approval is the same one that gets clicked.
  async resolve(target) {
    const p = this.page;
    const candidates = [p.getByRole('button', { name: target }), p.getByRole('link', { name: target }), p.getByText(target)];
    try { candidates.push(p.locator(target)); } catch (_) { /* not a valid selector */ }
    for (const c of candidates) {
      try { if ((await c.count()) > 0) return c.first(); } catch (_) { /* skip invalid selector */ }
    }
    const err = new Error(`Nothing clickable matches "${target}". Use browser_read to see buttons and links.`);
    err.code = 'NO_MATCH';
    throw err;
  }

  // Facts about one element, taken from the page right now.
  async describe(handle) {
    const info = await handle.evaluate((el) => {
      const form = el.closest('form') || el.form || null;
      return {
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type'),
        role: el.getAttribute('role'),
        text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 80),
        href: el.getAttribute('href'),
        disabled: !!el.disabled,
        formMethod: form ? (form.method || 'get').toLowerCase() : null,
        formAction: form ? form.getAttribute('action') : null,
        formHasPassword: !!(form && form.querySelector('input[type=password]')),
      };
    });
    return { ...info, pageUrl: this.page.url() };
  }

  fingerprint(info) {
    return JSON.stringify([info.pageUrl, info.tag, info.type, info.role, info.text, info.href, info.disabled, info.formMethod, info.formAction, info.formHasPassword]);
  }

  // Step 1 (before the policy decision): resolve ONE element, keep a reference to it, and return its facts
  // plus a fingerprint. The approval is bound to this exact element and fingerprint.
  async inspectClick(target) {
    if (!this.page) throw new Error('No page is open. Use browser_open first.');
    const loc = await this.resolve(target);
    const handle = await loc.elementHandle();
    const info = await this.describe(handle);
    const fingerprint = this.fingerprint(info);
    this.pinned = { handle, fingerprint };
    return { ...info, fingerprint };
  }

  // Step 2 (after approval): revalidate that the pinned element is still attached and still matches what was
  // assessed/approved, then click THAT element. The target is never resolved a second time.
  async click(target, approvedFingerprint) {
    if (!this.page) throw new Error('No page is open. Use browser_open first.');
    if (!approvedFingerprint) {
      await this.resolve(target); // throws a helpful "nothing matches" error if the element does not exist
      throw new Error('This click was not assessed before execution (the page may have changed). Call browser_click again.');
    }
    const pinned = this.pinned;
    this.pinned = null; // an approval is single-use
    if (!pinned || pinned.fingerprint !== approvedFingerprint) throw new Error('The approved element is no longer the one that was assessed. Nothing was clicked; read the page and try again.');
    const attached = await pinned.handle.evaluate((el) => el.isConnected).catch(() => false);
    if (!attached) throw new Error('The approved element is no longer on the page. Nothing was clicked; read the page and try again.');
    const now = this.fingerprint(await this.describe(pinned.handle));
    if (now !== approvedFingerprint) throw new Error('The element changed after it was assessed (text, target or page differs). Nothing was clicked; read the page and try again.');
    await pinned.handle.click();
    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
    await this.page.waitForTimeout(250);
    return this.summary();
  }

  async formValues() {
    if (!this.page) return null;
    const r = await this.read();
    const out = {};
    for (const f of r.fields) if (f.value) out[f.label || f.name] = f.value;
    return { url: r.url, filled_fields: out };
  }

  async screenshot(label = 'shot') {
    if (!this.page) throw new Error('No page is open.');
    fs.mkdirSync(this.shotDir, { recursive: true });
    const file = path.join(this.shotDir, `${Date.now()}_${label.replace(/[^a-z0-9_-]/gi, '_')}.png`);
    await this.page.screenshot({ path: file, fullPage: true });
    return file;
  }

  async close() { if (this.browser) await this.browser.close(); this.page = null; }
}

module.exports = { Browser };
