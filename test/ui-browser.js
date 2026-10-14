// Drives the actual UI page in a real browser (scripted LLM behind it): token/cookie handshake, live stream,
// approval card buttons, result card, database panel, auto-approve checkbox state.
//   npm run test:e2e
const { call, scripted: scriptedModel } = require('./helpers/scripted-model');
const scripted = (steps) => scriptedModel(steps, { clamp: true });
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
process.env.ERP_DB = path.join(os.tmpdir(), `uib-${Date.now()}.db`);
process.env.COMPANY_MEMORY = path.join(os.tmpdir(), 'cm-uib.md'); fs.writeFileSync(process.env.COMPANY_MEMORY, '# t');
const { open, reset } = require('../erp/db'); const d = open(); reset(d); d.close();
const { createApp } = require('../ui/server');
const RUNS = fs.mkdtempSync(path.join(os.tmpdir(), 'uib-runs-'));
const { createTools } = require('../agent/tools');
const { chromium } = require('playwright');

const toolsFactory = (ctx) => [...createTools(ctx).filter((t) => t.name === 'list_files'),
  { name: 'write', risk: 'irreversible', description: 't', parameters: { type: 'object', properties: {} }, run: async () => ({ done: true }) }];

(async () => {
  const app = createApp({ skipErp: true, toolsFactory, allowAutoApprove: false, runsDir: RUNS,
    llmFactory: () => scripted([call('list_files', {}), call('write', {}), call('finish', { status: 'cannot_complete', summary: 'Scripted demo finished.' })]) });
  const server = app.listen(0, 'localhost'); await new Promise((r) => server.once('listening', r)); const url = `http://localhost:${server.address().port}/`;
  const custom = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const browser = await chromium.launch(custom ? { executablePath: custom, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process', '--no-zygote'] } : {});
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(url);
    await page.waitForFunction(() => document.querySelectorAll('#invoices tr').length === 5, null, { timeout: 5000 }); // header + 4 seed rows
    assert.strictEqual(await page.isDisabled('#auto'), true, 'auto-approve checkbox is disabled when the server does not allow it');
    await page.click('.examples button >> nth=0');
    assert.ok((await page.inputValue('#task')).includes('Acme'), 'example button fills the task');
    await page.click('#run');
    await page.waitForSelector('.card.ask', { timeout: 5000 });
    assert.ok(/approval needed/i.test(await page.textContent('.card.ask')));
    await page.screenshot({ path: process.env.UI_SHOT || '/tmp/ui-approval.png' });
    await page.click('.card.ask button.ok');
    await page.waitForFunction(() => /could not complete/i.test(document.querySelector('#result .big')?.textContent || ''), null, { timeout: 5000 });
    assert.ok((await page.textContent('#result')).includes('Scripted demo finished.'));
    await page.waitForFunction(() => !document.querySelector('#run').disabled, null, { timeout: 3000 });
    assert.ok((await page.textContent('#timeline')).includes('Looked at the available files'), 'the feed describes each action in plain language');
    await page.screenshot({ path: process.env.UI_SHOT2 || '/tmp/ui-result.png' });
    // Run history: the finished run is listed and can be replayed with the model-call table.
    await page.waitForSelector('#history .hrow button', { timeout: 5000 });
    await page.click('#history .hrow button >> nth=0');
    await page.waitForFunction(() => /replay of stored run/i.test(document.querySelector('#timeline').textContent), null, { timeout: 5000 });
    const replay = await page.textContent('#timeline');
    assert.ok(/model calls/i.test(replay) && replay.includes('list_files'), 'replay shows the model-call table and the tools it chose');
    await page.screenshot({ path: process.env.UI_SHOT3 || '/tmp/ui-history.png' });
    // Another page without the session cookie/token cannot drive the server.
    const ctx2 = await browser.newContext();
    const r = await ctx2.request.post(url + 'api/run', { data: { task: 'x' }, headers: { 'content-type': 'application/json' } });
    assert.strictEqual(r.status(), 401, 'a fresh browser context with no session is refused');
    assert.deepStrictEqual(errors, [], 'no browser console or page errors: ' + errors.join(' | '));
    console.log('PASS  UI page in a real browser: handshake, live cards, Approve button, result card, database panel, no console errors');
  } finally { await browser.close(); server.close(); }
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
