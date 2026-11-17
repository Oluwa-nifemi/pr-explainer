#!/usr/bin/env node
// Turns Claude Code on this machine into an OpenAI chat completions endpoint, so a container
// can use the seat that is already signed in here. Nothing is copied out of the host.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';

const PORT = Number(process.env.BRIDGE_PORT) || 5191;
const HOST = process.env.BRIDGE_HOST || '127.0.0.1';
const MAX_CALLS = Number(process.env.BRIDGE_MAX_CALLS) || 6;
const TIMEOUT_MS = Number(process.env.BRIDGE_TIMEOUT_MS) || 300000;
const HEALTH_MS = 20000;

const MODELS = (process.env.BRIDGE_MODELS || 'claude-code-opus,claude-code-sonnet').split(',').map((s) => s.trim()).filter(Boolean);
const ALIASES = { 'claude-code-opus': 'opus', 'claude-code-sonnet': 'sonnet', 'claude-code-haiku': 'haiku' };

const aliasFor = (name) => ALIASES[name] || (name && !name.includes('/') ? name : 'opus');

let active = 0;
const queue = [];

function slot() {
  if (active < MAX_CALLS) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => queue.push(resolve));
}

function release() {
  const next = queue.shift();
  if (next) next();
  else active--;
}

function send(res, status, body, type = 'application/json') {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {});
      } catch (err) {
        reject(new Error('request body is not JSON: ' + err.message));
      }
    });
    req.on('error', reject);
  });
}

function run(cmd, args, { timeout = HEALTH_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: error.message, spawnError: error });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

let healthCache = { at: 0, value: null };

async function health() {
  if (healthCache.value && Date.now() - healthCache.at < HEALTH_MS) return healthCache.value;
  const version = await run(process.env.BRIDGE_CLAUDE_BIN || 'claude', ['--version']);
  const installed = !version.spawnError;
  let authorized = false;
  let account = null;
  let error = null;
  if (installed) {
    const status = await run(process.env.BRIDGE_CLAUDE_BIN || 'claude', ['auth', 'status', '--json']);
    try {
      const parsed = JSON.parse(status.out);
      authorized = parsed.loggedIn === true || parsed.authorized === true;
      account = parsed.email || parsed.account || null;
    } catch {
      error = 'could not read claude auth status';
    }
  } else {
    error = 'the claude command is not installed on this machine';
  }
  const value = {
    ok: installed,
    models: MODELS.map((id) => ({ id, object: 'model', owned_by: 'claude-code' })),
    claude: {
      installed,
      authorized,
      version: installed ? version.out.trim().split('\n')[0].replace(/\s*\(Claude Code\)$/, '') : null,
      account,
      ...(error ? { error } : {}),
    },
  };
  healthCache = { at: Date.now(), value };
  return value;
}

// The pipeline sends an OpenAI message list. Claude Code takes one prompt and one system prompt.
export function flatten(messages) {
  const system = [];
  const turns = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const text = typeof m?.content === 'string' ? m.content : Array.isArray(m?.content) ? m.content.map((p) => p?.text || '').join('') : '';
    if (!text) continue;
    if (m.role === 'system') system.push(text);
    else if (m.role === 'assistant') turns.push('Assistant:\n' + text);
    else turns.push(turns.length ? 'User:\n' + text : text);
  }
  return { system: system.join('\n\n'), prompt: turns.join('\n\n') };
}

function claudeArgs({ model, schema, system }) {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--bare',
    '--restricted',
    '--tools', '',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--model', aliasFor(model),
  ];
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  if (system) args.push('--system-prompt', system);
  return args;
}

function chunkOf(id, model, delta, finish = null) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

async function complete(req, res, body) {
  const model = typeof body?.model === 'string' ? body.model : 'claude-code-opus';
  const { system, prompt } = flatten(body?.messages);
  const schema = body?.response_format?.json_schema?.schema || null;
  if (!prompt.trim()) return send(res, 400, { error: { message: 'no messages in the request' } });

  let aborted = false;
  let finished = false;
  let child = null;
  const done = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    release();
  };

  await slot();
  if (aborted) {
    release();
    return;
  }
  const id = 'chatcmpl-' + Math.random().toString(16).slice(2, 14);
  const startedAt = Date.now();
  child = spawn(process.env.BRIDGE_CLAUDE_BIN || 'claude', claudeArgs({ model, schema, system }), {
    cwd: tmpdir(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    done();
    if (!res.headersSent) send(res, 504, { error: { message: 'claude did not answer within ' + TIMEOUT_MS + 'ms' } });
    else res.end();
  }, TIMEOUT_MS);

  let stderr = '';
  let buffered = '';
  let content = '';
  let channel = null;
  let usage = null;
  let failure = null;
  let models = null;

  const write = (text) => {
    if (models === null) {
      models = model;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('data: ' + JSON.stringify(chunkOf(id, models, { role: 'assistant', content: '' })) + '\n\n');
    }
    if (!text) return;
    content += text;
    res.write('data: ' + JSON.stringify(chunkOf(id, models, { content: text })) + '\n\n');
  };

  const handle = (event) => {
    if (event.type === 'stream_event') {
      const ev = event.event || {};
      if (ev.type !== 'content_block_delta') return;
      const delta = ev.delta || {};
      const kind = delta.type === 'text_delta' ? 'text' : delta.type === 'thinking_delta' ? 'thinking' : 'json';
      if (kind === 'thinking') return;
      // A schema answer arrives as tool input JSON. Never mix the two, or the answer doubles.
      if (channel && channel !== kind) return;
      channel ||= kind;
      write(kind === 'text' ? delta.text || '' : delta.partial_json || '');
      return;
    }
    if (event.type === 'result') {
      if (event.is_error) failure = event.result || event.error || 'claude reported an error';
      const u = event.usage || {};
      const prompt = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      usage = {
        prompt_tokens: prompt,
        completion_tokens: u.output_tokens || 0,
        total_tokens: prompt + (u.output_tokens || 0),
        cache_read_input_tokens: u.cache_read_input_tokens || 0,
        cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
      };
      const final = typeof event.result === 'string' ? event.result : '';
      if (!content && final) write(final);
    }
  };

  child.stdout.on('data', (data) => {
    buffered += data.toString('utf8');
    let nl;
    while ((nl = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      if (!line.startsWith('{')) continue;
      try {
        handle(JSON.parse(line));
      } catch {
        // ignore a line that is not an event
      }
    }
  });
  child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
  child.on('error', (err) => (failure = err.message));
  child.on('close', (code) => {
    if (finished) return;
    const message = failure || (code !== 0 && !content ? stderr.trim() || 'claude exited with code ' + code : '');
    if (message) {
      done();
      log(model, startedAt, 0, 0, 'failed: ' + message.slice(0, 200));
      if (!res.headersSent) return send(res, 502, { error: { message: message.slice(0, 800) } });
      res.write('data: ' + JSON.stringify({ error: { message } }) + '\n\n');
      res.end();
      return;
    }
    if (models === null) {
      models = model;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('data: ' + JSON.stringify(chunkOf(id, models, { role: 'assistant', content: '' })) + '\n\n');
    }
    res.write('data: ' + JSON.stringify(chunkOf(id, models, {}, 'stop')) + '\n\n');
    if (usage) res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', model: models, choices: [], usage }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
    done();
    log(model, startedAt, usage?.prompt_tokens || 0, usage?.completion_tokens || 0, 'ok');
  });

  res.on('close', () => {
    aborted = true;
    if (!finished) {
      child.kill('SIGKILL');
      done();
      log(model, startedAt, 0, 0, 'cancelled');
    }
  });


  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
}

function log(model, startedAt, promptTokens, completionTokens, status) {
  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    new Date().toISOString() + ' ' + model + ' ' + secs + 's ' + promptTokens + '→' + completionTokens + ' ' + status + ' active=' + active
  );
}

const routes = {
  'GET /health': async (req, res) => send(res, 200, await health()),
  'GET /v1/health': async (req, res) => send(res, 200, await health()),
  'GET /v1/models': async (req, res) => send(res, 200, { object: 'list', data: MODELS.map((id) => ({ id, object: 'model', owned_by: 'claude-code' })) }),
  'GET /models': async (req, res) => send(res, 200, { object: 'list', data: MODELS.map((id) => ({ id, object: 'model', owned_by: 'claude-code' })) }),
  'POST /v1/chat/completions': async (req, res) => complete(req, res, await readBody(req)),
  'POST /chat/completions': async (req, res) => complete(req, res, await readBody(req)),
};

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://' + HOST).pathname.replace(/\/+$/, '') || '/';
  if (req.method === 'GET' && path === '/') {
    const h = await health();
    const line = (k, v) => '<tr><th>' + k + '</th><td>' + v + '</td></tr>';
    return send(
      res,
      200,
      '<!doctype html><meta charset="utf-8"><title>Claude Code bridge</title>' +
        '<body style="font:15px/1.6 system-ui;max-width:640px;margin:6vh auto;padding:0 20px">' +
        '<h1 style="font-size:22px">Claude Code bridge</h1>' +
        '<table cellpadding="6" style="border-collapse:collapse">' +
        line('Installed', h.claude.installed ? 'yes' : 'no') +
        line('Signed in', h.claude.authorized ? 'yes' : 'no') +
        line('Version', h.claude.version || '—') +
        line('Account', h.claude.account || '—') +
        line('Calls in flight', active + ' of ' + MAX_CALLS) +
        line('Models', MODELS.join(', ')) +
        '</table></body>',
      'text/html; charset=utf-8'
    );
  }
  const handler = routes[req.method + ' ' + path];
  if (!handler) return send(res, 404, { error: { message: 'no route for ' + req.method + ' ' + path } });
  try {
    await handler(req, res);
  } catch (err) {
    if (!res.headersSent) send(res, 500, { error: { message: err.message } });
    else res.end();
  }
});

server.listen(PORT, HOST, async () => {
  const h = await health();
  const where = 'http://' + HOST + ':' + PORT;
  console.log('claude bridge on ' + where);
  console.log('claude installed=' + h.claude.installed + ' signed-in=' + h.claude.authorized + ' version=' + (h.claude.version || '?'));
  if (!h.claude.installed) console.log('fix: install Claude Code, then run: claude auth login');
  else if (!h.claude.authorized) console.log('fix: run: claude auth login');
});
