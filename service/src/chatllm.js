import { Limiter } from '../../pipeline/src/llm.js';
import { MODELS, logCall, requestFields } from '../../pipeline/src/models.js';

export { MODELS };
export const chatLimiter = new Limiter(2);

export class LlmError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
  }
}

export async function streamAnswer({
  model,
  messages,
  tools,
  toolChoice,
  baseUrl,
  apiKey,
  onDelta,
  signal,
  maxTokens = 8000,
  timeoutMs = 120000,
}) {
  const body = {
    ...requestFields(model, 'chat'),
    messages,
    max_tokens: maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (tools) body.tools = tools;
  if (toolChoice) body.tool_choice = toolChoice;

  await chatLimiter.acquire(1);
  if (signal?.aborted) {
    chatLimiter.release();
    throw new LlmError(499, 'chat request was cancelled');
  }
  logCall(model, 'chat');
  const startedAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout after ' + timeoutMs + 'ms')), timeoutMs);
  const abortSignal = signal ? AbortSignal.any([ctrl.signal, signal]) : ctrl.signal;
  let content = '';
  let reasoning = '';
  const toolCalls = [];
  try {
    let res;
    try {
      res = await fetch(baseUrl + '/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}),
        },
        body: JSON.stringify(body),
        signal: abortSignal,
      });
    } catch (err) {
      if (ctrl.signal.aborted) throw new LlmError(504, 'the LLM call timed out after ' + Math.round(timeoutMs / 1000) + 's');
      throw new LlmError(502, 'could not reach the LLM gateway: ' + err.message);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new LlmError(502, 'LLM gateway returned ' + res.status + (text ? ': ' + text.slice(0, 300) : ''));
    }
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
        if (ev.error) throw new LlmError(502, 'LLM stream error: ' + JSON.stringify(ev.error).slice(0, 300));
        const choice = ev.choices && ev.choices[0];
        if (!choice) continue;
        const d = choice.delta || {};
        const r = d.reasoning_content || d.reasoning;
        if (r) reasoning += r;
        if (d.content) {
          content += d.content;
          if (onDelta) onDelta(d.content);
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
  } catch (err) {
    if (err instanceof LlmError) throw err;
    if (ctrl.signal.aborted && !signal?.aborted) throw new LlmError(504, 'the LLM call timed out after ' + Math.round(timeoutMs / 1000) + 's');
    throw new LlmError(502, 'LLM stream failed: ' + (err?.message || err));
  } finally {
    clearTimeout(timer);
    chatLimiter.release();
  }
  return { content, reasoning, toolCalls: toolCalls.filter(Boolean), ms: Date.now() - startedAt };
}
