// LangChain callback handler: records every model call (exactly what was sent, what came back, how long it took)
// to llm.jsonl in the run folder. It plugs into LangChain's callback system, so it sees the real request.
const fs = require('fs');
const { BaseCallbackHandler } = require('@langchain/core/callbacks/base');

const text = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text || '').join('') : '');
const clip = (s, n = 8000) => (s.length > n ? s.slice(0, n) + `...[+${s.length - n} chars]` : s);

class RunLogger extends BaseCallbackHandler {
  name = 'RunLogger';
  awaitHandlers = true; // finish writing before the graph moves on, so the file is complete when a run ends
  constructor(file) { super(); this.file = file; this.step = 0; this.started = new Map(); }
  write(e) { fs.appendFileSync(this.file, JSON.stringify({ t: new Date().toISOString(), step: this.step, ...e }) + '\n'); }
  async handleChatModelStart(llm, messages, runId, _parent, extra) {
    this.started.set(runId, Date.now());
    const inv = (extra && extra.invocation_params) || {};
    this.write({ direction: 'request', model: inv.model || inv.model_name || null, tool_names: (inv.tools || []).map((t) => t.function && t.function.name),
      messages: messages[0].map((m) => ({ role: m.getType(), content: clip(text(m.content)), ...(m.tool_calls && m.tool_calls.length ? { tool_calls: m.tool_calls.map((c) => ({ name: c.name, args: c.args })) } : {}), ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}) })) });
  }
  async handleLLMEnd(output, runId) {
    const msg = output.generations[0][0].message;
    this.write({ direction: 'response', latency_ms: Date.now() - (this.started.get(runId) || Date.now()), content: text(msg.content),
      tool_calls: (msg.tool_calls || []).map((c) => ({ name: c.name, args: c.args })), usage: msg.usage_metadata || null });
    this.started.delete(runId);
  }
  async handleLLMError(err, runId) {
    this.write({ direction: 'error', latency_ms: Date.now() - (this.started.get(runId) || Date.now()), error: err.message });
    this.started.delete(runId);
  }
}

module.exports = { RunLogger };
