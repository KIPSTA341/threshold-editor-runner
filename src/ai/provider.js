'use strict';
// AI providers. Server-side only. The API key is read from the server environment, sent only to the AI API,
// and never logged, stored, returned to browsers or shown to the model.
const fs = require('fs');
const { AI } = require('../config');

function anthropicProvider() {
  if (!AI.apiKey) throw new Error('AI is not configured (missing API key).');
  return {
    name: 'anthropic',
    model: AI.model,
    async send(params) {
      const res = await fetch(AI.apiUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': AI.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: AI.model, ...params }),
        signal: AbortSignal.timeout(180000),
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = null; }
      if (!res.ok) {
        const msg = data && data.error && data.error.message ? data.error.message : `HTTP ${res.status}`;
        const err = new Error(`The AI service returned an error: ${msg.slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }
      return data;
    },
  };
}

// Controlled mock for development and tests: replays a scripted list of assistant turns. It never claims to be
// real AI; generations made with it are recorded with provider "mock".
function mockProvider(script) {
  const turns = script || JSON.parse(fs.readFileSync(AI.mockScript, 'utf8'));
  let i = 0;
  const requests = [];
  return {
    name: 'mock',
    model: 'mock',
    requests,
    async send(params) {
      requests.push(JSON.parse(JSON.stringify(params)));
      const t = turns[i++];
      if (!t) return { content: [{ type: 'text', text: 'Mock script exhausted.' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
      if (t.error) { const e = new Error(t.error); e.status = t.status || 500; throw e; }
      return {
        content: t.content.map((c, k) => (c.type === 'tool_use' ? { id: `toolu_mock_${i}_${k}`, ...c } : c)),
        stop_reason: t.content.some((c) => c.type === 'tool_use') ? 'tool_use' : 'end_turn',
        usage: t.usage || { input_tokens: 3000, output_tokens: 400 },
      };
    },
  };
}

// Real AI through the editor Worker's Cloudflare Workers AI binding (free allowance). The runner never holds a
// Cloudflare credential; it authenticates to the Worker with the per-deployment runner secret. Messages are
// translated between the editor's tool-use format and the OpenAI-style format Workers AI models use.
function toOpenAi(params) {
  const msgs = [];
  const sys = (params.system || []).map((s) => s.text || s).join('\n');
  if (sys) msgs.push({ role: 'system', content: sys });
  for (const m of params.messages) {
    if (m.role === 'user') {
      const results = m.content.filter((c) => c.type === 'tool_result');
      results.forEach((r) => msgs.push({ role: 'tool', tool_call_id: r.tool_use_id, content: String(r.content) }));
      const text = m.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (text) msgs.push({ role: 'user', content: text });
    } else {
      const text = m.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      const calls = m.content.filter((c) => c.type === 'tool_use').map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input || {}) } }));
      msgs.push({ role: 'assistant', content: text || '', ...(calls.length ? { tool_calls: calls } : {}) });
    }
  }
  const tools = (params.tools || []).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  return { messages: msgs, tools, max_tokens: params.max_tokens };
}
function fromOpenAi(out, turn) {
  // Accept both Workers AI shapes: { response, tool_calls:[{name,arguments}] } and OpenAI { choices:[{message}] }.
  const msg = out && out.choices ? out.choices[0].message : { content: out && out.response, tool_calls: out && out.tool_calls };
  const content = [];
  if (msg.content && typeof msg.content === 'string' && msg.content.trim()) content.push({ type: 'text', text: msg.content });
  (msg.tool_calls || []).forEach((tc, k) => {
    const fn = tc.function || tc;
    let input = fn.arguments;
    if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = {}; } }
    content.push({ type: 'tool_use', id: tc.id || `call_${turn}_${k}`, name: fn.name, input: input || {} });
  });
  const u = (out && out.usage) || {};
  return { content, stop_reason: content.some((c) => c.type === 'tool_use') ? 'tool_use' : 'end_turn',
    usage: { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0 } };
}
function workersAiProxyProvider() {
  let turn = 0; let model = process.env.AI_PROXY_MODEL || 'workers-ai';
  return {
    name: 'workers-ai', get model() { return model; },
    async send(params) {
      turn++;
      const res = await fetch(process.env.AI_PROXY_URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.AI_PROXY_TOKEN}` },
        body: JSON.stringify(toOpenAi(params)), signal: AbortSignal.timeout(120000) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { const e = new Error(data.error || `AI proxy HTTP ${res.status}`); e.status = res.status; throw e; }
      if (data.model) model = data.model;
      return fromOpenAi(data.output, turn);
    },
  };
}

let testOverride = null;
function setTestProvider(factory) { testOverride = factory; } // tests only

function getProvider() {
  if (testOverride) return testOverride();
  if (AI.provider === 'anthropic') return anthropicProvider();
  if (AI.provider === 'workers-ai-proxy' && process.env.AI_PROXY_URL) return workersAiProxyProvider();
  if (AI.provider === 'mock' && AI.mockScript) return mockProvider();
  return null;
}

function status() {
  if (testOverride) return { enabled: true, mode: 'mock' };
  if (AI.provider === 'anthropic' && AI.apiKey) return { enabled: true, mode: 'live' };
  if (AI.provider === 'workers-ai-proxy' && process.env.AI_PROXY_URL) return { enabled: true, mode: 'live' };
  if (AI.provider === 'mock' && AI.mockScript) return { enabled: true, mode: 'mock' };
  return { enabled: false, mode: null };
}

module.exports = { getProvider, mockProvider, setTestProvider, status, toOpenAi, fromOpenAi };
