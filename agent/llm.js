// The language model, via LangChain.js. Any LangChain chat model that supports tool calling can be swapped in here
// (tests use a scripted fake model; production uses ChatOpenAI).
const { ChatOpenAI } = require('@langchain/openai');

function createChatModel({ model = process.env.OPENAI_MODEL || 'gpt-4o-mini' } = {}) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set (copy .env.example to .env).');
  return new ChatOpenAI({ model, apiKey: process.env.OPENAI_API_KEY, maxRetries: 3, timeout: 90000 });
}

module.exports = { createChatModel };
