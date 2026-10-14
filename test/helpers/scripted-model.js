// A scripted LangChain chat model for tests: it "decides" the next tool call from a fixed list, so the REAL graph,
// policy, tools, browser and verifier run without any API key.
const { BaseChatModel } = require('@langchain/core/language_models/chat_models');
const { AIMessage } = require('@langchain/core/messages');

class ScriptedChatModel extends BaseChatModel {
  constructor(steps, { clamp = false } = {}) { super({}); this.steps = steps; this.clamp = clamp; this.i = 0; this.calls = 0; }
  _llmType() { return 'scripted'; }
  bindTools(tools) { this.boundTools = tools; return this; }
  async _generate() {
    this.calls++;
    let s;
    if (this.clamp) {
      if (!this.steps.length) throw new Error('scripted model has no steps');
      s = this.steps[Math.min(this.i++, this.steps.length - 1)];
    } else {
      if (this.i >= this.steps.length) throw new Error('script exhausted');
      s = this.steps[this.i++];
    }
    const msg = new AIMessage({ content: s.content || '', tool_calls: s.tool_calls || [] });
    return { generations: [{ message: msg, text: msg.content }] };
  }
}

const call = (name, args) => ({ tool_calls: [{ name, args, id: 'c' + Math.random().toString(36).slice(2), type: 'tool_call' }] });
const say = (content) => ({ content });
const scripted = (steps, opts) => new ScriptedChatModel(steps, opts);

module.exports = { call, say, scripted, ScriptedChatModel };
