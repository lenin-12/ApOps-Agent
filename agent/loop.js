// Runs one task through the LangGraph agent and returns a plain result object.
// Public signature is unchanged, so the CLI, the web UI and the eval runner do not care that LangGraph is underneath.
const fs = require('fs');
const path = require('path');
const { HumanMessage } = require('@langchain/core/messages');
const { buildAgentGraph } = require('./graph');
const { RunLogger } = require('./logging');

async function runAgent({ task, llm, tools, ctx, adapter, maxSteps = 20, runDir, log = console.log, onEvent }) {
  fs.mkdirSync(runDir, { recursive: true });
  const tracePath = path.join(runDir, 'trace.jsonl');
  const trace = (e) => { const full = { t: new Date().toISOString(), ...e }; fs.appendFileSync(tracePath, JSON.stringify(full) + '\n'); if (onEvent) onEvent(full); };
  trace({ type: 'task', task });

  const logger = new RunLogger(path.join(runDir, 'llm.jsonl'));
  const graph = buildAgentGraph({ model: llm, defs: tools, ctx, adapter, maxSteps, trace, tracePath, log, logger });
  // Each model call + tool execution is two graph steps; our own maxSteps is the real limit, this is only a safety net.
  let final;
  try {
    final = await graph.invoke({ messages: [new HumanMessage(task)] }, { recursionLimit: maxSteps * 4 + 20 });
  } catch (e) {
    trace({ type: 'error', message: e.message }); // the history view can then show why a run ended
    throw e;
  }
  const result = final.result || { status: 'aborted', steps: final.step, tracePath, summary: 'The graph ended without a result.' };
  trace({ type: 'result', status: result.status, steps: result.steps, summary: result.summary });
  return result;
}

module.exports = { runAgent };
