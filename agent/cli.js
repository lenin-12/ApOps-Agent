// Usage: node agent/cli.js "<task>" [--chaos flakySubmit,renamedField,...] [--reset] [--auto-approve] [--headed] [--max-steps 20]
require('dotenv').config();
const path = require('path');
const readline = require('readline');
const { createChatModel } = require('./llm');
const { createTools } = require('./tools');
const { Browser } = require('./browser');
const { runAgent } = require('./loop');
const adapter = require('./adapters/findesk');

const ERP = process.env.ERP_URL || 'http://localhost:4000';
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const task = argv.find((a, i) => !a.startsWith('--') && (i === 0 || !['--chaos', '--max-steps'].includes(argv[i - 1])));

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}

(async () => {
  if (!task) { console.error('Provide a task, see README for example tasks'); process.exit(1); }
  try { await fetch(`${ERP}/admin/chaos`); } catch { console.error(`FinDesk is not running at ${ERP}. Start it with: npm run erp`); process.exit(1); }
  if (flag('reset')) await fetch(`${ERP}/admin/reset`, { method: 'POST', headers: { 'x-apops-admin': '1' } });
  if (opt('chaos')) {
    const body = Object.fromEntries(opt('chaos').split(',').map((k) => [k.trim(), true]));
    console.log('Chaos enabled:', await (await fetch(`${ERP}/admin/chaos`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-apops-admin': '1' }, body: JSON.stringify(body) })).json());
  }

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(__dirname, '..', 'runs', runId);
  const browser = new Browser({ headed: flag('headed'), shotDir: path.join(runDir, 'screenshots') });
  const ctx = {
    memory: {}, browser, approvalMode: flag('auto-approve') ? 'auto' : 'interactive',
    askHuman: (q) => ask(`\n[AGENT ASKS] ${q}\n> `),
    approve: async ({ tool, args, page, detail }) => {
      if (flag('auto-approve')) { console.log(`  [auto-approved] ${tool} ${JSON.stringify(args)}`); return true; }
      console.log(`\n[APPROVAL NEEDED] ${tool} ${JSON.stringify(args)}`);
      if (detail) console.log('  Why:', JSON.stringify(detail));
      if (page) console.log('  Page:', page.url, '\n  Values on page:', JSON.stringify(page.filled_fields));
      return /^y/i.test(await ask('Approve? [y/N] '));
    },
  };
  const tools = createTools(ctx);
  console.log(`\nTask: ${task}\nModel: ${process.env.OPENAI_MODEL || 'gpt-4o-mini'}   Run: ${runId}\n`);
  try {
    const r = await runAgent({ task, llm: createChatModel(), tools, ctx, adapter, maxSteps: Number(opt('max-steps', 20)), runDir });
    if (browser.isOpen && r.status === 'completed') await browser.screenshot('final_state').catch(() => {});
    console.log(`\n=== RESULT: ${r.status.toUpperCase()} in ${r.steps} steps ===\n${r.summary || ''}\nTrace: ${r.tracePath}`);
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
