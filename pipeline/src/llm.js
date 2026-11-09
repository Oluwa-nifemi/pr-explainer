import { AsyncLocalStorage } from 'node:async_hooks';

import { MODELS, getStoryModel, logCall, requestFields, schemaFor } from './models.js';

export const DEFAULT_BASE_URL = '';
const MAX_CONCURRENCY = Number(process.env.PRX_MAX_CONCURRENCY) > 0 ? Number(process.env.PRX_MAX_CONCURRENCY) : 6;

let llmConfig = {};

export function configureLLM({ baseUrl, apiKey }) {
  llmConfig = { baseUrl: baseUrl || null, apiKey: apiKey || null };
}

export function llmSettings() {
  const baseUrl = (llmConfig.baseUrl || process.env.PR_EXPLAINER_LITELLM_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  return { baseUrl, apiKey: llmConfig.apiKey || process.env.PR_EXPLAINER_LITELLM_API_KEY || '' };
}

export function chatUrl() {
  return llmSettings().baseUrl + '/chat/completions';
}

export function rank(priority = 'background', order = 0) {
  if (typeof priority === 'string') return [priority === 'user' ? 0 : 1, order];
  if (priority && typeof priority === 'object') return [priority.cls === 'user' ? 0 : 1, Number(priority.order) || 0];
  return [1, Number(priority) || 0];
}

const before = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

export class Limiter {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.peak = 0;
    this.waiters = [];
  }

  async acquire(priority = 50) {
    const rankOf = rank(priority);
    if (this.active < this.max) this.active++;
    else {
      await new Promise((resolve) => {
        const w = { priority: rankOf, resolve };
        const i = this.waiters.findIndex((x) => before(rankOf, x.priority));
        if (i < 0) this.waiters.push(w);
        else this.waiters.splice(i, 0, w);
      });
    }
    this.peak = Math.max(this.peak, this.active);
  }

  release() {
    const next = this.waiters.shift();
    if (next) next.resolve();
    else this.active--;
  }
}

export const globalLimiter = new Limiter(MAX_CONCURRENCY);
export const runScope = new AsyncLocalStorage();
const modelLimiters = {};

function modelLimiter(name) {
  const max = MODELS[name]?.maxConcurrency;
  if (!max) return null;
  return (modelLimiters[name] ||= new Limiter(max));
}

export function setMaxConcurrency(n) {
  globalLimiter.max = Math.max(1, Math.floor(n) || 1);
  while (globalLimiter.active < globalLimiter.max && globalLimiter.waiters.length) {
    globalLimiter.active++;
    globalLimiter.waiters.shift().resolve();
  }
}

async function acquire(priority, model) {
  const lane = runScope.getStore()?.lane;
  if (lane) await lane.acquire(priority);
  await modelLimiter(model)?.acquire(priority);
  await globalLimiter.acquire(priority);
}

function release(model) {
  globalLimiter.release();
  modelLimiter(model)?.release();
  runScope.getStore()?.lane?.release();
}

export function concurrencyStats() {
  const lane = runScope.getStore()?.lane;
  return { globalPeak: globalLimiter.peak, lanePeak: lane?.peak ?? null };
}

export async function chat({
  label = 'call',
  model = getStoryModel(),
  messages,
  thinking,
  schema,
  jsonMode,
  tools,
  toolChoice,
  maxTokens = 16000,
  timeoutMs = 240000,
  priority = 50,
  onContent,
  signal,
}) {
  const body = {
    ...requestFields(model, 'story', thinking),
    messages,
    max_tokens: maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (schema) body.response_format = { type: 'json_schema', json_schema: { name: schema.name, strict: true, schema: schemaFor(model, schema.schema) } };
  else if (jsonMode) body.response_format = { type: 'json_object' };
  if (tools) body.tools = tools;
  if (toolChoice) body.tool_choice = toolChoice;

  const queuedAt = Date.now();
  await acquire(priority, model);
  logCall(model, label);
  const startedAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout after ' + timeoutMs + 'ms')), timeoutMs);
  const abortSignal = signal ? AbortSignal.any([ctrl.signal, signal]) : ctrl.signal;
  const rec = {
    label,
    thinking: thinking || 'default',
    queuedMs: startedAt - queuedAt,
    ttftMs: null,
    firstContentMs: null,
    totalMs: null,
    usage: null,
    finish: null,
    error: null,
    contentSamples: [],
  };
  let content = '';
  let reasoning = '';
  const toolCalls = [];
  let lastTokenAt = null;
  try {
    const { apiKey } = llmSettings();
    const res = await fetch(chatUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}) },
      body: JSON.stringify(body),
      signal: abortSignal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + (await res.text()).slice(0, 500));
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let ev;
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }
        if (ev.error) throw new Error('stream error: ' + JSON.stringify(ev.error).slice(0, 500));
        if (ev.usage) rec.usage = ev.usage;
        const choice = ev.choices && ev.choices[0];
        if (!choice) continue;
        if (choice.finish_reason) rec.finish = choice.finish_reason;
        const d = choice.delta || {};
        const now = Date.now() - startedAt;
        const r = d.reasoning_content || d.reasoning;
        if (r || d.content || d.tool_calls) {
          if (rec.ttftMs === null) rec.ttftMs = now;
          lastTokenAt = now;
        }
        if (r) reasoning += r;
        if (d.content) {
          if (rec.firstContentMs === null) rec.firstContentMs = now;
          content += d.content;
          rec.contentSamples.push([now, content.length]);
          if (onContent) onContent(content, now);
        }
        for (const tc of d.tool_calls || []) {
          const i = tc.index ?? 0;
          toolCalls[i] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) toolCalls[i].id = tc.id;
          if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
          if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
        }
      }
    }
  } catch (e) {
    rec.error = signal?.aborted ? 'aborted' : String(e?.message || e);
  } finally {
    clearTimeout(timer);
    release(model);
  }
  rec.totalMs = Date.now() - startedAt;
  const u = rec.usage || {};
  rec.promptTokens = u.prompt_tokens || 0;
  rec.completionTokens = u.completion_tokens || 0;
  rec.reasoningTokens = u.completion_tokens_details?.reasoning_tokens || 0;
  const decodeMs = lastTokenAt !== null && rec.ttftMs !== null ? lastTokenAt - rec.ttftMs : 0;
  rec.decodeTps = decodeMs > 500 ? Math.round((rec.completionTokens / decodeMs) * 1000) : null;
  rec.reasoningEndMs = rec.firstContentMs ?? (toolCalls.length ? lastTokenAt : null);
  if (rec.contentSamples.length > 400) {
    const step = Math.ceil(rec.contentSamples.length / 400);
    rec.contentSamples = rec.contentSamples.filter((_, i) => i % step === 0);
  }
  return { content, reasoning, toolCalls: toolCalls.filter(Boolean), rec };
}

export function parseJson(text) {
  let t = (text || '').trim();
  const fence = t.match(/^~~~(?:json)?\s*([\s\S]*?)\s*~~~$/) || t.match(/^\u0060\u0060\u0060(?:json)?\s*([\s\S]*?)\s*\u0060\u0060\u0060$/);
  if (fence) t = fence[1];
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error('no JSON object in output');
  }
}

export async function jsonCall(opts, validate = () => null, { retries = 1, calls } = {}) {
  let messages = opts.messages;
  let lastErr = null;
  let thinking = opts.thinking;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const out = await chat({ ...opts, messages, thinking, label: opts.label + (attempt ? '#retry' + attempt : '') });
    if (calls) calls.push(out.rec);
    if (out.rec.error === 'aborted') {
      const err = new Error('aborted');
      err.aborted = true;
      throw err;
    }
    if ((out.rec.error?.startsWith('timeout') || out.rec.finish === 'length') && thinking !== 'none') {
      thinking = 'none';
      out.rec.nextAttemptThinkingOff = true;
      messages = opts.messages;
      lastErr = out.rec.error || 'hit max_tokens';
      continue;
    }
    if (out.rec.error) {
      lastErr = out.rec.error;
      continue;
    }
    let value;
    try {
      value = parseJson(out.content);
    } catch (e) {
      lastErr = 'invalid JSON: ' + e.message + (out.rec.finish === 'length' ? ' (hit max_tokens)' : '');
      out.rec.jsonError = lastErr;
      messages = [...opts.messages, { role: 'assistant', content: out.content.slice(0, 2000) }, { role: 'user', content: 'That was not valid JSON (' + lastErr + '). Reply again with only the complete JSON object.' }];
      continue;
    }
    const problem = validate(value);
    if (!problem) return { value, rec: out.rec, attempts: attempt + 1 };
    lastErr = 'validation: ' + problem;
    out.rec.jsonError = lastErr;
    messages = [...opts.messages, { role: 'assistant', content: out.content }, { role: 'user', content: 'Problem with your JSON: ' + problem + '. Reply again with the corrected complete JSON object.' }];
  }
  const err = new Error(lastErr || 'failed');
  err.attempts = retries + 1;
  throw err;
}
