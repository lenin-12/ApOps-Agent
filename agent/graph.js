// The agent as a LangGraph state graph.
//
//   START -> agent --(tool calls)--> act --> agent ...      (loop)
//              |                      |
//              |--(no tool call)--> nudge --> agent
//              '--(result set)----> END      act --(result set)--> END
//
// The LLM (a LangChain chat model) is the planner. LangGraph owns the control flow. Our code inside the nodes is the
// runtime: it validates tool input, enforces the approval policy, executes LangChain tools, detects "stuck" runs,
// and refuses to finish until the independent verifier agrees.
const { StateGraph, Annotation, START, END } = require('@langchain/langgraph');
const { HumanMessage, SystemMessage, ToolMessage } = require('@langchain/core/messages');
const { buildSystemPrompt } = require('./prompt');
const { loadCompanyMemory } = require('./memory');
const { authorize } = require('./policy');
const { verify } = require('./verifier');
const { toLangChainTool, FINISH_DEF } = require('./tools');

const STUCK_LIMIT = 3;       // the same call failing this many times -> stop and ask a human
const MAX_ESCALATIONS = 2;   // after this many human escalations in one run, give up
const stable = (o) => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((x) => [x, v[x]])) : v));
const clip = (o, n = 6000) => { const s = JSON.stringify(o); return s.length > n ? s.slice(0, n) + '...[truncated]' : s; };
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text || '').join('') : '');

const replace = (def) => Annotation({ reducer: (_, b) => b, default: () => def });
const State = Annotation.Root({
  messages: Annotation({ reducer: (a, b) => a.concat(b), default: () => [] }),
  step: replace(0),
  result: replace(null),                       // set exactly once, by whichever node ends the run
  failCounts: replace({}),
  nudges: replace(0), verifyFails: replace(0), escalations: replace(0),
  // Two different kinds of change: business records (need verification claims) vs. persistent memory (needs approval only).
  externalStateChanged: replace(false), persistentMemoryChanged: replace(false),
  // Conflicting source values need a human, not a guess.
  ambiguityReported: replace(false), humanAfterAmbiguity: replace(false),
});

function buildAgentGraph({ model, defs, ctx, adapter, maxSteps, trace, tracePath, log, logger }) {
  const lcTools = Object.fromEntries(defs.map((d) => [d.name, toLangChainTool(d)]));
  const defByName = Object.fromEntries(defs.map((d) => [d.name, d]));
  const finishTool = toLangChainTool(FINISH_DEF);
  const bound = model.bindTools([...Object.values(lcTools), finishTool], { parallel_tool_calls: false });
  const today = new Date().toISOString().slice(0, 10);
  const result = (status, extra = {}) => ({ status, steps: 0, tracePath, ...extra });
  const issues = (err) => err.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ');

  // ---- node: ask the model for the next action ----
  async function agentNode(state) {
    const step = state.step + 1;
    if (ctx.stopRequested) { trace({ type: 'stopped', step }); return { step, result: { ...result('stopped'), steps: step - 1, summary: 'Stopped by the user.' } }; }
    if (step > maxSteps) return { step, result: { ...result('max_steps'), steps: maxSteps, summary: 'Step limit reached without finishing.' } };
    const system = new SystemMessage(buildSystemPrompt({ companyMemory: loadCompanyMemory(), runMemory: ctx.memory, today }));
    if (logger) logger.step = step;
    const t0 = Date.now();
    const ai = await bound.invoke([system, ...state.messages], logger ? { callbacks: [logger] } : undefined);
    const latency_ms = Date.now() - t0;
    const calls = (ai.tool_calls || []).map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }));
    trace({ type: 'llm', step, content: textOf(ai.content), tool_calls: calls.length ? calls : undefined, usage: ai.usage_metadata, latency_ms });
    return { step, messages: [ai] };
  }

  // ---- node: the model replied without calling a tool ----
  async function nudgeNode(state) {
    const ai = state.messages[state.messages.length - 1];
    if (textOf(ai.content)) log(`  [agent says] ${textOf(ai.content)}`);
    const nudges = state.nudges + 1;
    if (nudges > 3) return { nudges, result: { ...result('aborted'), steps: state.step, summary: 'Agent stopped using tools without finishing.' } };
    return { nudges, messages: [new HumanMessage('Continue by calling a tool, or call finish when the work is done or cannot be done.')] };
  }

  // ---- node: gate, execute and observe the tool calls; run the verifier on finish ----
  async function actNode(state) {
    const ai = state.messages[state.messages.length - 1];
    const step = state.step;
    let { externalStateChanged, persistentMemoryChanged, ambiguityReported, humanAfterAmbiguity, verifyFails, escalations } = state;
    const failCounts = { ...state.failCounts };
    const out = [];
    const snapshot = (extra = {}) => ({ messages: out, failCounts, verifyFails, escalations, externalStateChanged, persistentMemoryChanged, ambiguityReported, humanAfterAmbiguity, ...extra });
    const reply = (call, name, observation) => {
      trace({ type: 'observation', step, tool: name, result: observation });
      out.push(new ToolMessage({ content: clip(observation), tool_call_id: call.id, name }));
    };

    for (const call of ai.invalid_tool_calls || []) reply(call, call.name || 'unknown', { ok: false, error: 'Tool arguments were not valid JSON.' });

    for (const call of ai.tool_calls || []) {
      const name = call.name;
      let args = call.args || {};
      let obs;

      if (name === 'finish') {
        const parsed = finishTool.schema.safeParse(args);
        if (!parsed.success) { reply(call, name, { ok: false, error: `Invalid arguments: ${issues(parsed.error)}` }); continue; }
        args = parsed.data;
        log(`  step ${step}: finish(${args.status})`);
        if (args.status === 'cannot_complete') {
          trace({ type: 'finish', step, ...args });
          return snapshot({ result: { ...result('cannot_complete'), steps: step, summary: args.summary } });
        }
        const v = await verify(args.claims, adapter, { stateChanged: externalStateChanged, humanResolvedAmbiguity: humanAfterAmbiguity });
        if (v.ambiguous) ambiguityReported = true;
        trace({ type: 'verification', step, passed: v.passed, problems: v.problems, checks: v.checks, externalStateChanged, persistentMemoryChanged });
        if (v.passed) {
          log('  verifier: PASSED');
          return snapshot({ result: { ...result('completed'), steps: step, summary: args.summary, verification: v, externalStateChanged, persistentMemoryChanged } });
        }
        verifyFails++;
        log(`  verifier: FAILED -> ${v.problems.join(' | ')}`);
        if (verifyFails >= 3) return snapshot({ result: { ...result('verification_failed'), steps: step, summary: args.summary, verification: v } });
        obs = { ok: false, error: 'VERIFICATION FAILED. The system of record does not match your claims. Investigate and fix, then call finish again.', problems: v.problems };
        reply(call, name, obs);
        continue;
      }

      const def = defByName[name];
      if (!def) { reply(call, name, { ok: false, error: `Unknown tool "${name}".` }); continue; }

      // Validate input against the tool's schema BEFORE the policy runs, so malformed calls never reach an approval prompt.
      const parsed = lcTools[name].schema.safeParse(args);
      if (!parsed.success) {
        obs = { ok: false, error: `Invalid arguments for ${name}: ${issues(parsed.error)}` };
      } else {
        args = parsed.data;
        const auth = await authorize(def, args, ctx);
        trace({ type: 'policy', step, tool: name, args, risk: auth.risk, detail: auth.detail, allowed: auth.allowed, approval: auth.risk === 'irreversible' ? (auth.mode || 'interactive') : undefined });
        if (!auth.allowed) {
          obs = { ok: false, error: 'A human denied this action. Do not retry it; ask the human what to do instead.' };
        } else {
          try {
            // Executed as a real LangChain tool call; the approval travels in the per-call config.
            const raw = await lcTools[name].invoke(args, { configurable: { approval: auth } });
            obs = { ok: true, data: JSON.parse(raw) };
            if (name === 'ask_human' && ambiguityReported) humanAfterAmbiguity = true;
            if (auth.risk === 'irreversible') {
              if (def.effect === 'memory') persistentMemoryChanged = true;
              else externalStateChanged = true; // default for any irreversible tool: assume it changed business records
            }
          } catch (e) {
            obs = { ok: false, error: e.message };
          }
        }
      }
      log(`  step ${step}: ${name}(${clip(args, 120)}) -> ${obs.ok ? 'ok' : 'ERROR: ' + obs.error}`);

      const key = name + stable(args);
      if (obs.ok) {
        delete failCounts[key];
      } else if (parsed.success) {
        failCounts[key] = (failCounts[key] || 0) + 1;
        if (failCounts[key] >= STUCK_LIMIT) {
          // Design rule: the same call failing 3 times means the agent is stuck. Stop and ask a human.
          escalations++;
          trace({ type: 'stuck_escalation', step, tool: name, args, error: obs.error, failures: failCounts[key], escalation: escalations });
          const answer = escalations > MAX_ESCALATIONS ? '' : await ctx.askHuman(`I have failed ${STUCK_LIMIT} times in a row at ${name}(${clip(args, 200)}). Error: ${obs.error}\nHow should I proceed? (reply "stop" to abort the task)`);
          if (!answer || /^\s*(stop|abort|cancel|quit)\b/i.test(answer)) {
            trace({ type: 'stuck_abort', step, tool: name });
            return snapshot({ result: { ...result('stuck'), steps: step, summary: `Stopped after ${STUCK_LIMIT} identical failures of ${name}: ${obs.error}` } });
          }
          failCounts[key] = 0;
          obs = { ok: false, error: obs.error, human_guidance: answer };
        }
      }
      reply(call, name, obs);
    }
    return snapshot();
  }

  const hasCalls = (m) => (m.tool_calls && m.tool_calls.length) || (m.invalid_tool_calls && m.invalid_tool_calls.length);
  return new StateGraph(State)
    .addNode('agent', agentNode)
    .addNode('act', actNode)
    .addNode('nudge', nudgeNode)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', (s) => (s.result ? END : hasCalls(s.messages[s.messages.length - 1]) ? 'act' : 'nudge'), ['act', 'nudge', END])
    .addConditionalEdges('act', (s) => (s.result ? END : 'agent'), ['agent', END])
    .addConditionalEdges('nudge', (s) => (s.result ? END : 'agent'), ['agent', END])
    .compile();
}

module.exports = { buildAgentGraph };
