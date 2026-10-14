// The policy layer lives in the RUNTIME, not in the prompt: the LLM cannot talk its way past it.
// risk: 'safe' (read-only) | 'reversible' (can be undone) | 'irreversible' (needs human approval)
// Default-deny: anything that is not explicitly safe/reversible is treated as irreversible,
// and if we cannot assess an action we fail closed.
const COMMIT_WORDS = /\b(submit|save|pay|paid|delete|remove|confirm|approve|send|update|transfer|post|create|add|place|order|checkout|finali[sz]e|complete|authori[sz]e|release|cancel|publish|archive|reject)\b/i;

// Classify a click from facts about the REAL element that will be clicked (not the words the LLM used).
function classifyClick(info) {
  if (!info) return { risk: 'irreversible', reason: 'could not inspect the element' };
  const label = `${info.text || ''} ${info.href || ''} ${info.formAction || ''}`;
  if (COMMIT_WORDS.test(label)) return { risk: 'irreversible', reason: 'label or target looks like a commit action' };
  if (info.tag === 'a' && info.href && !/^\s*javascript:/i.test(info.href)) return { risk: 'reversible', reason: 'plain navigation link' };
  if (info.formHasPassword && info.formMethod === 'post') return { risk: 'reversible', reason: 'sign-in form' };
  return { risk: 'irreversible', reason: `${info.tag} element that may submit data or run code (form method: ${info.formMethod || 'none'})` };
}

const normalizeRisk = (r) => (r === 'safe' || r === 'reversible' ? r : 'irreversible');

async function assess(tool, args, ctx) {
  try {
    if (typeof tool.assess === 'function') {
      const r = await tool.assess(args, ctx);
      return { risk: normalizeRisk(r.risk), detail: r.detail, token: r.token };
    }
    const risk = typeof tool.risk === 'function' ? await tool.risk(args, ctx) : tool.risk;
    return { risk: normalizeRisk(risk) };
  } catch (e) {
    return { risk: 'irreversible', detail: { assessment_error: e.message } };
  }
}

async function authorize(tool, args, ctx) {
  const { risk, detail, token } = await assess(tool, args, ctx);
  if (risk !== 'irreversible') return { allowed: true, risk, detail, token };
  const page = ctx.browser && ctx.browser.isOpen ? await ctx.browser.formValues().catch(() => null) : null;
  const approved = !!(await ctx.approve({ tool: tool.name, args, page, detail }));
  return { allowed: approved, risk, detail, token, approved, mode: ctx.approvalMode || 'interactive' };
}

module.exports = { authorize, assess, classifyClick, COMMIT_WORDS };
