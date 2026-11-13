import './logfile.js';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import * as store from './store.js';
import * as gh from './gh.js';
import * as jobs from './jobs.js';
import * as threads from './threads.js';
import * as sse from './sse.js';
import { postReview, validateReview, replyToThread, setThreadResolved, setReaction } from './reviews.js';
import { startWatcher } from './watcher.js';
import { ApiError } from './errors.js';
import * as chat from './chat.js';
import { readPrFile } from './files.js';
import * as credentials from './credentials.js';
import { LlmError } from './chatllm.js';
import { describeSettings, saveOverrides } from '../../pipeline/src/settings.js';
import { PIPELINE_INFO } from '../../pipeline/src/info.js';
import { MODELS, getStoryModel } from '../../pipeline/src/models.js';

const CORS = {
  'Access-Control-Allow-Origin': config.origin,
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, err) {
  if (res.headersSent) {
    try {
      res.end();
    } catch {}
    return;
  }
  if (err instanceof ApiError) {
    sendJson(res, err.status, { error: { code: err.code, message: err.message }, ...(err.extra || {}) });
    return;
  }
  if (err instanceof gh.GithubError) {
    if (err.status === 404) {
      sendJson(res, 404, { error: { code: 'not_found', message: err.message } });
      return;
    }
    const rejected = err.status === 422 || err.status === 400;
    sendJson(res, rejected ? 422 : 502, {
      error: {
        code: rejected ? 'github_rejected' : 'github_unavailable',
        message: err.message,
      },
    });
    return;
  }
  console.error('unhandled error: ' + (err?.stack || err));
  sendJson(res, 500, { error: { code: 'internal_error', message: err?.message || 'internal error' } });
}

function settingsPayload() {
  return { ...describeSettings(), info: PIPELINE_INFO, model: MODELS[getStoryModel()].label };
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 5 * 1024 * 1024) throw new ApiError(400, 'bad_request', 'body is too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'bad_request', 'body is not valid JSON');
  }
}

async function currentStory(repo, number) {
  const item = jobs.getItem(repo, number);
  const sha = item?.headSha || (await store.latestStorySha(repo, number));
  if (!sha) return null;
  return store.readStory(repo, number, sha);
}

// While a new story is being written, keep serving the last one that finished, so the reader
// keeps a whole story instead of a half built one.
async function readableStory(repo, number) {
  const story = await currentStory(repo, number);
  if (store.isFinished(story)) return story;
  return (await store.latestFinishedStory(repo, number)) || story;
}

// The export build makes one HTML file with the app, the styles and the fonts inlined.
const EXPORT_PAGE = fileURLToPath(new URL('../../app/dist-export/export.html', import.meta.url));
const escapeHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

async function sendExport(res, repo, number) {
  const story = await readableStory(repo, number);
  if (!story) throw new ApiError(404, 'not_found', 'no story for ' + repo + '#' + number);
  if (!store.isFinished(story)) throw new ApiError(409, 'not_ready', 'the story is still being written');
  let page;
  try {
    page = await readFile(EXPORT_PAGE, 'utf8');
  } catch {
    throw new ApiError(500, 'export_missing', 'the export page is not built. Run npm run build:export in app/.');
  }
  const title = escapeHtml(story.pr.repo + ' #' + story.pr.number + ' · ' + story.pr.title);
  const payload = JSON.stringify(story).replace(/</g, '\\u003c');
  const body = page
    .replace('<title>PR Explainer</title>', '<title>' + title + '</title>')
    .replace('<!--PRX-STORY-->', '<script>window.__PRX_EXPORT__=' + payload + ';</script>');
  res.writeHead(200, {
    ...CORS,
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Content-Disposition': 'attachment; filename="' + story.pr.repo.replace('/', '-') + '-' + story.pr.number + '-explainer.html"',
  });
  res.end(body);
}

async function handleEvents(req, res, repo, number) {
  res.writeHead(200, {
    ...CORS,
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  res.flushHeaders?.();
  const story = await currentStory(repo, number);
  if (story) sse.send(res, 'story', story);
  const cached = await threads.peekThreads(repo, number);
  if (cached) sse.send(res, 'threads', cached);
  sse.subscribe(repo + '#' + number, res, 15000);
}

function chatErrorCode(err) {
  if (err instanceof ApiError) return err.code;
  if (err instanceof LlmError) return 'llm_unavailable';
  if (err instanceof gh.GithubError) return 'github_unavailable';
  return 'internal_error';
}

async function handleChat(req, res, repo, number) {
  const body = await readBody(req);
  if (typeof body?.message !== 'string' || !body.message.trim()) {
    throw new ApiError(400, 'bad_request', 'message is required');
  }
  const model = chat.normalizeModel(body.model);
  if (model.error) throw new ApiError(400, 'bad_request', model.error);
  const context = chat.normalizeContext(body.context);
  const headSha = await chat.currentHead(repo, number);
  if (!headSha) throw new ApiError(404, 'not_found', 'no head commit for ' + repo + '#' + number);

  const story = await store.readStory(repo, number, headSha);
  const meta = story ? null : await gh.prMeta(repo, number);
  const thread = await chat.loadThread(repo, number, headSha);
  const userMessage = chat.newMessage({
    role: 'user',
    text: body.message.trim(),
    ...(context ? { context } : {}),
  });
  await chat.appendMessage(repo, number, headSha, userMessage);

  res.writeHead(200, {
    ...CORS,
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  res.flushHeaders?.();
  const controller = new AbortController();
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      controller.abort();
    }
  }, 15000);
  ping.unref?.();
  res.on('close', () => controller.abort());
  sse.send(res, 'user', userMessage);
  const turnId = userMessage.id.slice(0, 8);
  const startedAt = Date.now();
  const log = (text) => console.log('chat ' + turnId + ' ' + repo + '#' + number + ' ' + text);
  log('start model=' + model.model + ' context=' + JSON.stringify(context || {}));

  try {
    const answer = await chat.ask({
      repo,
      number,
      headSha,
      story,
      meta,
      history: thread.messages,
      message: userMessage.text,
      model: model.model,
      context,
      drafts: chat.normalizeDrafts(body.drafts),
      onEvent: (type, data) => sse.send(res, type, data),
      signal: controller.signal,
      log,
    });
    if (!answer.text) throw new ApiError(502, 'llm_unavailable', 'the model returned no answer');
    const assistantMessage = chat.newMessage({
      role: 'assistant',
      text: answer.text,
      model: model.model,
      ...(answer.lookups.length ? { lookups: answer.lookups } : {}),
      ...(answer.draftComment ? { draftComment: answer.draftComment } : {}),
    });
    await chat.appendMessage(repo, number, headSha, assistantMessage);
    sse.send(res, 'done', assistantMessage);
    log('done ' + (Date.now() - startedAt) + 'ms, ' + answer.lookups.length + ' lookups, ' + answer.text.length + ' chars');
  } catch (err) {
    if (controller.signal.aborted) {
      log('cancelled by client after ' + (Date.now() - startedAt) + 'ms');
      res.end();
      return;
    }
    log('error after ' + (Date.now() - startedAt) + 'ms: ' + (err?.message || err));
    sse.send(res, 'error', { code: chatErrorCode(err), message: err?.message || 'chat failed' });
  } finally {
    clearInterval(ping);
    res.end();
  }
}

async function route(req, res) {
  const url = new URL(req.url, 'http://' + config.host);
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (path === '/api/setup') {
    if (req.method === 'GET') {
      sendJson(res, 200, await credentials.status());
      return;
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      sendJson(res, 200, await credentials.save(body));
      return;
    }
    if (req.method === 'DELETE') {
      sendJson(res, 200, await credentials.remove());
      return;
    }
  }

  if (path.startsWith('/api/') && !(await credentials.isReady())) {
    throw new ApiError(428, 'setup_required', 'credentials are missing or invalid. See GET /api/setup.');
  }

  if (path === '/api/settings' && req.method === 'GET') {
    sendJson(res, 200, settingsPayload());
    return;
  }

  if (path === '/api/settings' && req.method === 'PUT') {
    const body = await readBody(req);
    try {
      saveOverrides(body);
    } catch (err) {
      if (err.code === 'bad_overrides') throw new ApiError(400, 'bad_request', err.message);
      throw err;
    }
    await jobs.refreshOutdated();
    sendJson(res, 200, settingsPayload());
    return;
  }

  if (path === '/api/prs' && req.method === 'GET') {
    sendJson(res, 200, jobs.listItems());
    return;
  }

  if (path === '/api/prs' && req.method === 'POST') {
    const body = await readBody(req);
    if (typeof body?.url !== 'string' || !body.url) {
      throw new ApiError(400, 'bad_request', 'url is required');
    }
    sendJson(res, 200, await jobs.requestPr(body.url));
    return;
  }

  let match = path.match(/^\/api\/prs\/([^/]+)\/([^/]+)\/(\d+)\/story$/);
  if (match && req.method === 'GET') {
    const [repo, number] = [match[1] + '/' + match[2], Number(match[3])];
    const asked = url.searchParams.get('sha');
    const story = asked ? await store.readStory(repo, number, asked) : await readableStory(repo, number);
    if (!story) throw new ApiError(404, 'not_found', 'no story for ' + repo + '#' + number);
    sendJson(res, 200, {
      ...story,
      outdated: jobs.isOutdated(story),
      regenerating: jobs.isBusy(repo, number),
      headChanged: jobs.headChanged(story),
    });
    return;
  }

  match = path.match(/^\/api\/prs\/([^/]+)\/([^/]+)\/(\d+)\/export$/);
  if (match && req.method === 'GET') {
    await sendExport(res, match[1] + '/' + match[2], Number(match[3]));
    return;
  }

  match = path.match(/^\/api\/prs\/([^/]+)\/([^/]+)\/(\d+)\/regenerate$/);
  if (match && req.method === 'POST') {
    sendJson(res, 200, await jobs.regeneratePr(match[1] + '/' + match[2], Number(match[3])));
    return;
  }

  match = path.match(/^\/api\/prs\/([^/]+)\/([^/]+)\/(\d+)\/steps\/(s\d+)\/retry$/);
  if (match && req.method === 'POST') {
    sendJson(res, 202, await jobs.retryStep(match[1] + '/' + match[2], Number(match[3]), match[4]));
    return;
  }

  match = path.match(/^\/api\/prs\/([^/]+)\/([^/]+)\/(\d+)\/events$/);
  if (match && req.method === 'GET') {
    await handleEvents(req, res, match[1] + '/' + match[2], Number(match[3]));
    return;
  }

  match = path.match(/^\/api\/prs\/([^/]+)\/([^/]+)\/(\d+)\/file$/);
  if (match && req.method === 'GET') {
    sendJson(
      res,
      200,
      await readPrFile({
        repo: match[1] + '/' + match[2],
        number: Number(match[3]),
        path: url.searchParams.get('path') || '',
        at: url.searchParams.get('at') === 'base' ? 'base' : 'head',
      }),
    );
    return;
  }

  match = path.match(/^\/api\/prs\/([^/]+)\/([^/]+)\/(\d+)\/threads$/);
  if (match && req.method === 'GET') {
    const repo = match[1] + '/' + match[2];
    const number = Number(match[3]);
    const refresh = url.searchParams.get('refresh') === '1';
    sendJson(res, 200, await threads.getThreads(repo, number, { refresh }));
    return;
  }

  match = path.match(/^\/api\/prs\/([^/]+)\/([^/]+)\/(\d+)\/chat$/);
  if (match && ['GET', 'POST', 'DELETE'].includes(req.method)) {
    const repo = match[1] + '/' + match[2];
    const number = Number(match[3]);
    if (req.method === 'GET') {
      const sha = url.searchParams.get('sha') || (await chat.currentHead(repo, number));
      sendJson(res, 200, await chat.loadThread(repo, number, sha));
      return;
    }
    if (req.method === 'DELETE') {
      const sha = url.searchParams.get('sha') || (await chat.currentHead(repo, number));
      await store.deleteChat(repo, number, sha);
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    if (req.method === 'POST') {
      await handleChat(req, res, repo, number);
      return;
    }
  }

  match = path.match(/^\/api\/prs\/([^/]+)\/([^/]+)\/(\d+)\/reviews$/);
  if (match && req.method === 'POST') {
    const repo = match[1] + '/' + match[2];
    const number = Number(match[3]);
    const request = await readBody(req);
    validateReview(request);
    sendJson(res, 200, await postReview(repo, number, request));
    return;
  }

  match = path.match(/^\/api\/threads\/([^/]+)\/replies$/);
  if (match && req.method === 'POST') {
    const body = await readBody(req);
    if (typeof body?.body !== 'string') {
      throw new ApiError(400, 'bad_request', 'body is required');
    }
    sendJson(res, 200, await replyToThread(decodeURIComponent(match[1]), body.body));
    return;
  }

  match = path.match(/^\/api\/comments\/([^/]+)\/reactions$/);
  if (match && req.method === 'POST') {
    const body = await readBody(req);
    sendJson(res, 200, await setReaction(decodeURIComponent(match[1]), String(body?.content || ''), body?.on !== false));
    return;
  }

  match = path.match(/^\/api\/threads\/([^/]+)\/(resolve|unresolve)$/);
  if (match && req.method === 'POST') {
    sendJson(res, 200, await setThreadResolved(decodeURIComponent(match[1]), match[2] === 'resolve'));
    return;
  }

  throw new ApiError(404, 'not_found', 'no route for ' + req.method + ' ' + path);
}

await store.ensureDirs();
await jobs.loadState();

const startup = await credentials
  .status()
  .catch((err) => ({ ready: false, error: err?.message || String(err) }));
console.log(
  'credentials ' +
    (startup.ready ? 'ready (github ' + startup.github.login + ', litellm ' + startup.litellm.models.length + ' models)' : 'not ready, open the UI setup'),
);

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => sendError(res, err));
});

server.listen(config.port, config.host, () => {
  console.log(
    'pr-explainer service on http://' +
      config.host +
      ':' +
      config.port +
      ' (home ' +
      config.home +
      ', fake generator ' +
      (config.fake ? 'on' : 'off') +
      ', dry-run ' +
      (config.dryRun ? 'on' : 'off') +
      ', watch ' +
      (config.watch ? config.watchIntervalS + 's' : 'off') +
      ')',
  );
});

if (config.watch) startWatcher();
jobs.pump();

const shutdown = () => {
  server.close();
  setTimeout(() => process.exit(0), 100).unref?.();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
