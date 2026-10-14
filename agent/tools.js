// Generic tool registry. Nothing here is specific to any one app or business domain.
const fs = require('fs');
const path = require('path');
const { classifyClick } = require('./policy');
const { appendCompanyRule, loadCompanyMemory } = require('./memory');
const { z } = require('zod');
const { DynamicStructuredTool } = require('@langchain/core/tools');

const FILES_DIR = path.resolve(process.env.FILES_DIR || path.join(__dirname, '..', 'samples'));

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || process.env.ERP_URL || 'http://localhost:4000').split(',').map((x) => x.trim());
function checkOrigin(url) {
  const origin = new URL(url).origin;
  if (!ALLOWED_ORIGINS.includes(origin)) throw new Error(`Origin ${origin} is not allowed in this sandbox. Allowed: ${ALLOWED_ORIGINS.join(', ')}`);
}

function safePath(p = '.') {
  const full = path.resolve(FILES_DIR, p);
  if (full !== FILES_DIR && !full.startsWith(FILES_DIR + path.sep)) throw new Error('Path is outside the allowed files folder.');
  return full;
}

async function extractText(file) {
  if (file.toLowerCase().endsWith('.pdf')) {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: fs.readFileSync(file) });
    try { return (await parser.getText()).text; } finally { await parser.destroy(); }
  }
  return fs.readFileSync(file, 'utf8');
}

function createTools(ctx) {
  return [
    {
      name: 'list_files', risk: 'safe',
      description: 'List files in the company files folder (documents such as PDFs and emails). Returns names and sizes only; open a file with read_file to see its contents.',
      schema: z.object({ path: z.string().optional().describe('Sub-folder, default is the root.') }),
      run: async ({ path: p }) => fs.readdirSync(safePath(p)).map((n) => ({ name: n, bytes: fs.statSync(path.join(safePath(p), n)).size })),
    },
    {
      name: 'read_file', risk: 'safe',
      description: 'Read the text content of a file (PDF or text). Use this to extract facts from documents.',
      schema: z.object({ path: z.string() }),
      run: async ({ path: p }) => ({ file: p, text: (await extractText(safePath(p))).slice(0, 8000) }),
    },
    {
      name: 'browser_open', risk: 'safe',
      description: 'Open a URL in the browser and return the page title and visible text.',
      schema: z.object({ url: z.string() }),
      run: async ({ url }) => { checkOrigin(url); return ctx.browser.open(url); },
    },
    {
      name: 'browser_read', risk: 'safe',
      description: 'Read the current page: visible text, form fields (name, label, current value, options), buttons and links. Use it before acting and after anything unexpected.',
      schema: z.object({}),
      run: async () => ctx.browser.read(),
    },
    {
      name: 'browser_type', risk: 'reversible',
      description: 'Fill a form field. "field" is the input name, id, label or placeholder as shown by browser_read. For dropdowns pass the option text.',
      schema: z.object({ field: z.string(), value: z.coerce.string() }),
      run: async ({ field, value }) => ctx.browser.type(field, value),
    },
    {
      name: 'browser_click',
      // Assessed from the real element that will be clicked, not from the words the LLM used. Default-deny.
      risk: 'irreversible',
      assess: async ({ target }, c) => {
        try {
          const info = await c.browser.inspectClick(target);
          const cls = classifyClick(info);
          const { fingerprint, ...element } = info;
          return { risk: cls.risk, detail: { reason: cls.reason, element }, token: fingerprint };
        } catch (e) {
          if (e.code === 'NO_MATCH') return { risk: 'reversible', detail: { note: 'no matching element; the click will just fail' } };
          throw e; // anything else fails closed in the policy layer
        }
      },
      description: 'Click a button or link by its visible text (or a CSS selector). Returns the resulting page. Buttons that commit changes need human approval, which the system requests for you.',
      schema: z.object({ target: z.string() }),
      run: async ({ target }, call) => ctx.browser.click(target, call && call.approval && call.approval.token),
    },
    {
      name: 'browser_screenshot', risk: 'safe',
      description: 'Save a screenshot of the current page as evidence of the outcome.',
      schema: z.object({ label: z.string().optional() }),
      run: async ({ label }) => ({ saved: await ctx.browser.screenshot(label || 'evidence') }),
    },
    {
      name: 'remember', risk: 'safe',
      description: 'Store a fact for the rest of this task (for example which document you decided is the latest, or an id you found).',
      schema: z.object({ key: z.string(), value: z.coerce.string() }),
      run: async ({ key, value }) => { ctx.memory[key] = value; return { stored: key }; },
    },
    {
      name: 'save_company_rule', risk: 'irreversible', effect: 'memory', // changes future behaviour, so a human must approve it; it does NOT change business records
      description: 'Save a lasting rule about how this company works so future tasks use it. Use it only after a human has told you or corrected you.',
      schema: z.object({ rule: z.string() }),
      run: async ({ rule }) => {
        appendCompanyRule(rule);
        if (!loadCompanyMemory().includes(rule.trim())) throw new Error('The rule could not be read back from company memory.');
        return { saved: true };
      },
    },
    {
      name: 'ask_human', risk: 'safe',
      description: 'Ask the human a question when the request is ambiguous, information conflicts, or you cannot proceed safely. Returns their answer. Do not guess when a wrong guess would matter.',
      schema: z.object({ question: z.string() }),
      run: async ({ question }) => ({ answer: await ctx.askHuman(question) }),
    },
  ];
}

const claimSchema = z.object({
  entity: z.string(),
  key: z.record(z.string(), z.any()).describe('Fields that identify the record.'),
  fields: z.record(z.string(), z.any()).describe('Field values that must be stored.'),
  source_file: z.string().optional().describe('File these values came from, if any.'),
});

// "finish" is not executed like other tools: the graph intercepts it and runs the independent verifier.
const FINISH_DEF = {
  name: 'finish',
  description: 'Call when the task is complete (or cannot be completed). For completed work that changed anything, list exactly what you believe is now true in the system as "claims"; the system will check them independently, and you will be sent back to fix any mismatch.',
  schema: z.object({
    status: z.enum(['completed', 'cannot_complete']),
    summary: z.string().describe('Factual summary of what happened. For a question or report, it must contain the complete answer (every value the user asked for), because the summary is the only thing the user is shown.'),
    claims: z.array(claimSchema).optional().describe('Facts that must be true in the system now. Format is described in company knowledge.'),
  }),
  run: async () => ({ note: 'finish is handled by the graph' }),
};

// Wrap our tool definition (which carries policy metadata) as a real LangChain tool.
// The approval decision reaches the tool through LangChain's per-call config (config.configurable.approval).
function toLangChainTool(def) {
  return new DynamicStructuredTool({
    name: def.name,
    description: def.description || def.name,
    schema: def.schema || z.object({}).passthrough(),
    func: async (input, _runManager, config) => {
      const data = await def.run(input, { approval: config && config.configurable ? config.configurable.approval : undefined });
      return JSON.stringify(data === undefined ? null : data);
    },
  });
}

module.exports = { createTools, toLangChainTool, FINISH_DEF, FILES_DIR, extractText, safePath };
