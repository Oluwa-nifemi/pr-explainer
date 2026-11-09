import { randomUUID } from 'node:crypto';

import { numberedPatch } from '../../pipeline/src/diff.js';
import { getStoryModel } from '../../pipeline/src/models.js';
import { createToolRunner, TOOLS } from './chat-tools.js';
import { LlmError, MODELS, streamAnswer } from './chatllm.js';
import { resolve as resolveCredentials } from './credentials.js';
import * as gh from './gh.js';
import * as jobs from './jobs.js';
import { hunkFor } from './placement.js';
import * as store from './store.js';

export const MAX_TOOL_ROUNDS = 4;
export const TOOL_TIMEOUT_MS = 20000;
const HISTORY_MESSAGES = 20;

const SYSTEM = [
  'You answer questions about one GitHub pull request for a senior engineer who is reviewing it.',
  'He reads code well. Answer the question directly in plain words. Do not restate the diff and do not narrate your lookups.',
  'One idea per sentence. Use active voice and name the actor. Keep sentences short.',
  'Use plain everyday words: write "check" or "rule", not "predicate"; "use", not "leverage".',
  'No em dashes. No colons as a mid-sentence connector. No filler like "in order to".',
  'Never use these words: additionally, crucial, delve, enhance, pivotal, robust, seamless, showcase, underscore, leverage, utilize, facilitate.',
  'No abstract metaphor nouns (surface, primitive, harness, substrate, scaffolding).',
  'Write code references as path:line. Name files, functions, types and fields exactly as they appear.',
  'Say plainly when the code cannot answer the question, or when you could not verify it.',
  'Never claim a bug without showing the lines that cause it. Read the code with the tools before you claim how it behaves.',
  'Use the draft_comment tool only when the user asks for a comment. Never put a draft comment in the answer.',
  'The PR description is in your context. The reviewer\'s own unposted draft comments and draft replies are not. Call get_my_drafts only when he asks about them.',
].join(' ');

function hunkText(hunk) {
  return numberedPatch({ ...hunk, lines: String(hunk.patch || '').split('\n') });
}

export function normalizeModel(value) {
  if (value === undefined || value === null || value === '') return { model: getStoryModel() };
  if (!MODELS[value]) return { error: 'model must be deepseek or opus' };
  return { model: value };
}

export function normalizeContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = {};
  if (typeof value.stepId === 'string' && value.stepId) out.stepId = value.stepId;
  if (typeof value.hunkId === 'string' && value.hunkId) out.hunkId = value.hunkId;
  if (typeof value.path === 'string' && value.path) out.path = value.path;
  if (Number.isInteger(value.line) && value.line > 0) out.line = value.line;
  if (value.side === 'LEFT' || value.side === 'RIGHT') out.side = value.side;
  return Object.keys(out).length ? out : undefined;
}

const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

export function normalizeDrafts(value) {
  if (!value || typeof value !== 'object') return undefined;
  const comments = (Array.isArray(value.comments) ? value.comments : []).slice(0, 50).map((c) => ({
    kind: c?.kind === 'question' ? 'question' : 'comment',
    path: clip(c?.path, 300),
    line: Number.isInteger(c?.line) ? c.line : null,
    startLine: Number.isInteger(c?.startLine) ? c.startLine : null,
    side: c?.side === 'LEFT' ? 'LEFT' : 'RIGHT',
    body: clip(c?.body, 3000),
  })).filter((c) => c.body);
  const replies = (Array.isArray(value.replies) ? value.replies : []).slice(0, 50).map((r) => ({
    path: clip(r?.path, 300),
    line: Number.isInteger(r?.line) ? r.line : null,
    replyingTo: clip(r?.replyingTo, 80),
    body: clip(r?.body, 3000),
  })).filter((r) => r.body);
  return comments.length || replies.length ? { comments, replies } : undefined;
}

function requestContext(story, context) {
  if (!context) return [];
  const parts = [];
  const step = context.stepId ? (story?.steps || []).find((s) => s.id === context.stepId) : null;
  if (step) {
    parts.push('## The step the request points at');
    parts.push(step.id + ' ' + step.title + ' (' + step.kind + ')');
    if (step.summary) parts.push(step.summary);
    if (step.gist) parts.push('', 'Gist:', step.gist);
    for (const h of step.hunks || []) parts.push('', '### ' + h.path + ' ' + h.id, hunkText(h));
  }
  const hunkId = context.hunkId;
  if (hunkId) {
    const found = (story?.steps || []).flatMap((s) => s.hunks || []).find((h) => h.id === hunkId);
    if (found) parts.push('', '## The hunk the request points at', '### ' + found.path + ' ' + found.id, hunkText(found));
  }
  if (context.path) {
    const side = context.side || 'RIGHT';
    const found = context.line ? hunkFor(story, context.path, side, context.line) : null;
    parts.push('', '## The line the request points at', context.path + ':' + (context.line ?? '?') + ' ' + side);
    if (found) parts.push('### ' + found.path + ' ' + found.hunk.id, hunkText(found.hunk));
    else parts.push('That line is not inside a changed hunk. Read the file with read_file.');
  }
  return parts;
}

const short = (sha) => (sha ? String(sha).slice(0, 7) : '?');

export function contextText(story, meta, context) {
  const pr = story?.pr || meta || {};
  const parts = [
    '# PR ' + (pr.repo || meta?.repo) + '#' + (pr.number || meta?.number) + ': ' + (pr.title || ''),
    'Author: ' + (pr.author || '?') + '. Base: ' + (pr.baseRef || '?') + ' (' + short(pr.baseSha) + '). Head: ' + (pr.headRef || '?') + ' (' + short(pr.headSha) + ').',
  ];
  const body = String(pr.body || '').replace(/<!--[\s\S]*?-->/g, '').trim();
  parts.push('', '## PR description', body.slice(0, 20000) || '(empty)');
  const summary = story?.summary;
  if (summary) {
    parts.push('', '## Story summary');
    if (summary.why) parts.push('', summary.why);
    for (const bullet of summary.whatChanged || []) parts.push('- ' + bullet);
    parts.push('', 'Risk: ' + (summary.risk || '?') + '. ' + (summary.riskReason || ''));
  }
  const steps = story?.steps || [];
  if (steps.length) {
    parts.push('', '## Steps in review order');
    for (const s of steps) parts.push(s.id + ' (' + s.kind + ') ' + s.title + ': ' + (s.summary || ''));
  }
  const extra = requestContext(story, context);
  if (extra.length) parts.push('', ...extra);
  parts.push('', '## How to look things up');
  parts.push('Use read_file and grep for real code at the head or base commit. Use get_step and get_hunk for the story. Use get_threads for review threads and get_my_drafts for the reviewer\'s own unposted drafts.');
  return parts.join('\n');
}

export function emptyThread(repo, number, headSha) {
  return { pr: { repo, number, headSha }, messages: [] };
}

export async function loadThread(repo, number, headSha) {
  const saved = await store.readChat(repo, number, headSha);
  if (!saved || !Array.isArray(saved.messages)) return emptyThread(repo, number, headSha);
  return { pr: { repo, number, headSha }, messages: saved.messages };
}

export async function currentHead(repo, number) {
  const item = jobs.getItem(repo, number);
  if (item?.headSha) return item.headSha;
  const sha = await store.latestStorySha(repo, number);
  if (sha) return sha;
  return gh.prHeadSha(repo, number);
}

async function withTimeout(promise, ms, what) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new LlmError(504, what + ' timed out after ' + Math.round(ms / 1000) + 's')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function ask({ repo, number, headSha, story, meta, history, message, model, context, drafts, onEvent, signal, log = () => {} }) {
  const { litellmApiKey, litellmBaseUrl } = await resolveCredentials();
  const baseSha = story?.pr?.baseSha || meta?.baseSha || '';
  const runner = createToolRunner({ repo, number, story, headSha, baseSha, drafts });
  const messages = [{ role: 'system', content: SYSTEM + '\n\n' + contextText(story, meta, context) }];
  for (const item of history.slice(-HISTORY_MESSAGES)) {
    messages.push({ role: item.role, content: item.text });
  }
  messages.push({ role: 'user', content: message });

  const startedAt = Date.now();
  const lookups = [];
  let rounds = 0;
  let wrapUp = false;
  let answer = '';
  for (;;) {
    const allowTools = rounds < MAX_TOOL_ROUNDS;
    if (!allowTools && !wrapUp) {
      messages.push({ role: 'user', content: 'You have no lookups left. Do not call any tool. Answer the question now from what you have read.' });
      wrapUp = true;
    }
    const out = await streamAnswer({
      model,
      messages,
      tools: TOOLS,
      baseUrl: litellmBaseUrl,
      apiKey: litellmApiKey,
      onDelta: (text) => onEvent('delta', { text }),
      signal,
    });
    log('llm round ' + rounds + ' ' + out.ms + 'ms, ' + out.toolCalls.length + ' tool calls, ' + out.content.length + ' chars');
    if (!allowTools || !out.toolCalls.length) {
      answer = out.content.trim();
      break;
    }
    rounds++;
    const assistant = { role: 'assistant', content: out.content || '', tool_calls: out.toolCalls };
    if (model === 'deepseek' && out.reasoning) assistant.reasoning_content = out.reasoning;
    messages.push(assistant);
    for (const [index, call] of out.toolCalls.entries()) {
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        args = {};
      }
      const t = Date.now();
      const result = await withTimeout(runner.call(call.function.name, args), TOOL_TIMEOUT_MS, 'tool ' + call.function.name);
      log('lookup ' + call.function.name + ' ' + (result.label || '') + ' ' + (Date.now() - t) + 'ms');
      if (result.label) {
        lookups.push({ tool: call.function.name, label: result.label });
        onEvent('lookup', { tool: call.function.name, label: result.label });
      }
      messages.push({ role: 'tool', tool_call_id: call.id || 'call_' + rounds + '_' + index, content: result.text });
    }
  }
  return { text: answer, lookups, draftComment: runner.draft.value || undefined, rounds, ms: Date.now() - startedAt };
}

export function newMessage(fields) {
  return { id: randomUUID(), createdAt: new Date().toISOString(), ...fields };
}

const writes = new Map();

export function appendMessage(repo, number, headSha, message) {
  const key = repo + '#' + number + '@' + headSha;
  const run = (writes.get(key) || Promise.resolve()).then(async () => {
    const thread = await loadThread(repo, number, headSha);
    thread.messages.push(message);
    await store.writeChat(repo, number, headSha, thread);
  });
  writes.set(key, run.catch(() => {}));
  return run;
}
