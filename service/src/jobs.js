import { config } from './config.js';
import * as store from './store.js';
import { generateStory, pipelineVersion } from './generator.js';
import * as sse from './sse.js';
import { refreshThreads } from './threads.js';
import { prMeta } from './gh.js';
import { ApiError } from './errors.js';

const items = new Map();
const currentStories = new Map();
const pending = [];
const active = new Map();
let running = 0;
let saveTimer = null;

function key(repo, number) {
  return repo + '#' + number;
}

function progressOf(story) {
  const steps = story?.steps || [];
  return { ready: steps.filter((s) => s.status === 'ready').length, total: steps.length };
}

export function isOutdated(story) {
  return Boolean(story) && story.generation?.status === 'done' && story.generation?.pipelineVersion !== pipelineVersion();
}

function normalizeItem(item) {
  return {
    repo: String(item.repo),
    number: Number(item.number),
    title: item.title || '',
    author: item.author || '',
    url: item.url || 'https://github.com/' + item.repo + '/pull/' + item.number,
    headSha: item.headSha || '',
    source: item.source || 'manual',
    status: item.status || 'queued',
    progress: { ready: Number(item.progress?.ready) || 0, total: Number(item.progress?.total) || 0 },
    queuedAt: item.queuedAt || new Date().toISOString(),
    updatedAt: item.updatedAt || new Date().toISOString(),
    openThreads: Number(item.openThreads) || 0,
    outdated: Boolean(item.outdated),
  };
}

export function publicItem(item) {
  return {
    repo: item.repo,
    number: item.number,
    title: item.title,
    author: item.author,
    url: item.url,
    headSha: item.headSha,
    source: item.source,
    status: item.status,
    progress: { ready: item.progress.ready, total: item.progress.total },
    queuedAt: item.queuedAt,
    updatedAt: item.updatedAt,
    openThreads: item.openThreads,
    outdated: item.status === 'done' && item.outdated,
  };
}

export function getItem(repo, number) {
  return items.get(key(repo, number)) || null;
}

export function getStory(repo, number) {
  return currentStories.get(key(repo, number)) || null;
}

export function listItems() {
  return [...items.values()]
    .map(publicItem)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveState();
  }, 20);
}

async function saveState() {
  const payload = {
    items: [...items.values()],
    pending: pending.map((job) => ({
      repo: job.repo,
      number: job.number,
      headSha: job.headSha,
      source: job.source,
      priority: job.priority,
      queuedAt: job.queuedAt,
      regenerate: Boolean(job.regenerate),
      ...(job.stepId ? { stepId: job.stepId } : {}),
    })),
  };
  try {
    await store.writeQueue(payload);
  } catch (err) {
    console.error('queue save failed: ' + err.message);
  }
}

async function syncStories() {
  const newest = new Map();
  for (const file of await store.listStoryFiles()) {
    const k = key(file.repo, file.number);
    const prev = newest.get(k);
    if (!prev || file.mtimeMs > prev.mtimeMs) newest.set(k, file);
  }
  for (const [k, file] of newest) {
    const story = await store.readStory(file.repo, file.number, file.sha);
    if (!story) continue;
    let item = items.get(k);
    if (!item) {
      item = normalizeItem({
        repo: file.repo,
        number: file.number,
        title: story.pr?.title,
        author: story.pr?.author,
        url: story.pr?.url,
        headSha: file.sha,
        source: 'manual',
        status: 'queued',
        queuedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      items.set(k, item);
    }
    if (item.headSha === file.sha) {
      const status = story.generation?.status;
      item.status = status === 'done' ? 'done' : status === 'failed' ? 'failed' : 'queued';
      item.progress = progressOf(story);
      item.outdated = isOutdated(story);
    }
  }
  for (const item of items.values()) {
    const cached = await store.readThreadsCache(item.repo, item.number);
    if (cached?.counts) item.openThreads = Number(cached.counts.open) || 0;
  }
  for (const [k, item] of items) {
    if (item.status === 'queued' || item.status === 'planning' || item.status === 'explaining') {
      if (!isBusy(item.repo, item.number) && item.headSha) {
        pending.push({
          repo: item.repo,
          number: item.number,
          headSha: item.headSha,
          source: item.source,
          priority: 'background',
          queuedAt: new Date().toISOString(),
        });
      }
    }
  }
}

export async function loadState() {
  const saved = await store.readQueue();
  for (const item of saved.items || []) {
    if (!item?.repo || !item?.number) continue;
    items.set(key(item.repo, item.number), normalizeItem(item));
  }
  pending.length = 0;
  for (const job of saved.pending || []) {
    if (!job?.repo || !job?.number || !job?.headSha) continue;
    pending.push({
      repo: job.repo,
      number: Number(job.number),
      headSha: job.headSha,
      source: job.source || 'manual',
      priority: job.priority === 'user' ? 'user' : 'background',
      queuedAt: job.queuedAt || new Date().toISOString(),
      regenerate: Boolean(job.regenerate),
      ...(job.stepId ? { stepId: job.stepId } : {}),
    });
  }
  await syncStories();
  await saveState();
}

export function isBusyFor(repo, number, headSha) {
  const k = key(repo, number);
  if (pending.some((job) => key(job.repo, job.number) === k && job.headSha === headSha)) return true;
  const job = active.get(k);
  return Boolean(job && job.job.headSha === headSha);
}

export function isBusy(repo, number) {
  const k = key(repo, number);
  return active.has(k) || pending.some((job) => key(job.repo, job.number) === k);
}

function persistStory(state) {
  if (state.job.stepId && state.story?.steps.some((s) => s.status === 'retrying')) return;
  if (state.job.regenerate && state.story?.generation?.status !== 'done') return;
  const snapshot = structuredClone(state.story);
  state.writes = state.writes
    .then(() => store.writeStory(snapshot))
    .catch((err) => console.error('story write failed: ' + err.message));
}

function applyEvent(state, item, type, data) {
  const story = state.story;
  if (type === 'story') {
    state.story = structuredClone(data);
    item.headSha = data?.pr?.headSha || item.headSha;
    item.status = 'planning';
  } else if (story) {
    if (type === 'summary') story.summary = data;
    else if (type === 'plan') story.steps = data;
    else if (type === 'step') {
      const index = (story.steps || []).findIndex((step) => step.id === data?.id);
      if (index >= 0) story.steps[index] = data;
      else (story.steps || (story.steps = [])).push(data);
    } else if (type === 'done') story.generation = data;
    else if (type === 'error') {
      story.generation = {
        ...(story.generation || {}),
        status: 'failed',
        error: data?.message || 'generation failed',
        finishedAt: new Date().toISOString(),
      };
    }
  }
  if (type === 'summary' || type === 'plan') {
    item.status = 'explaining';
    const status = state.story?.generation?.status;
    if (status && status !== 'done' && status !== 'failed') state.story.generation.status = 'explaining';
  }
  if (type === 'done') item.status = data?.status === 'failed' ? 'failed' : 'done';
  if (type === 'error') item.status = 'failed';
  if (state.story) {
    item.progress = progressOf(state.story);
    currentStories.set(key(item.repo, item.number), state.story);
    persistStory(state);
  }
}

function handleEvent(state, item, type, data) {
  const k = key(item.repo, item.number);
  const storySha = state.story?.pr?.headSha;
  if (item.headSha !== state.job.headSha && item.headSha !== storySha) return;
  if (type === 'error') state.errorEmitted = true;
  applyEvent(state, item, type, data);
  item.updatedAt = new Date().toISOString();
  sse.publish(k, type, data);
  scheduleSave();
}

async function run(job) {
  const k = key(job.repo, job.number);
  const prev = items.get(k);
  const item = normalizeItem({
    ...(prev || {}),
    repo: job.repo,
    number: job.number,
    headSha: job.headSha,
    source: job.source || prev?.source || 'manual',
    queuedAt: prev && prev.headSha === job.headSha ? prev.queuedAt : new Date().toISOString(),
  });
  item.status = 'planning';
  item.progress = { ready: 0, total: 0 };
  item.updatedAt = new Date().toISOString();
  items.set(k, item);
  const state = { job, story: null, writes: Promise.resolve(), errorEmitted: false };
  const controller = new AbortController();
  active.set(k, { job, controller });
  scheduleSave();
  const onEvent = (type, data) => {
    try {
      handleEvent(state, item, type, data);
    } catch (err) {
      console.error('event handler failed: ' + err.message);
    }
  };
  try {
    const finalStory = await generateStory(
      { repo: job.repo, number: job.number, headSha: job.headSha },
      { onEvent, priority: job.priority, signal: controller.signal, ...(job.stepId ? { stepId: job.stepId, retryStory: await store.readStory(job.repo, job.number, job.headSha) } : {}) },
    );
    if (finalStory) {
      state.story = finalStory;
      currentStories.set(k, finalStory);
      item.headSha = finalStory.pr?.headSha || item.headSha;
      item.status = finalStory.generation?.status === 'failed' ? 'failed' : 'done';
      item.progress = progressOf(finalStory);
      item.outdated = isOutdated(finalStory);
      persistStory(state);
      await state.writes;
    } else if (item.status !== 'failed') {
      item.status = 'done';
    }
  } catch (err) {
    const latest = items.get(k);
    if (latest === item && (item.headSha === job.headSha || item.headSha === state.story?.pr?.headSha)) {
      item.status = 'failed';
      if (!state.errorEmitted) {
        sse.publish(k, 'error', { code: 'generation_failed', message: err?.message || String(err) });
      }
    }
    console.error('story failed ' + k + '@' + String(job.headSha).slice(0, 7) + ': ' + (err?.message || err));
  } finally {
    await state.writes;
    if (job.stepId && item.status === 'failed') {
      const saved = await store.readStory(job.repo, job.number, job.headSha);
      if (saved) {
        currentStories.set(k, saved);
        item.status = saved.generation.status === 'failed' ? 'failed' : 'done';
        item.progress = progressOf(saved);
        sse.publish(k, 'story', saved);
      }
    }
    if (job.regenerate && item.status === 'failed') {
      item.status = 'done';
      item.outdated = true;
    }
    item.updatedAt = new Date().toISOString();
    scheduleSave();
    active.delete(k);
    refreshThreads(job.repo, job.number).catch((err) =>
      console.error('threads refresh failed ' + k + ': ' + err.message),
    );
  }
}

export function pump() {
  while (running < config.maxStories && pending.length) {
    const index = pending.findIndex((job) => !active.has(key(job.repo, job.number)));
    if (index < 0) return;
    const [job] = pending.splice(index, 1);
    running++;
    run(job)
      .catch((err) => console.error('job crashed: ' + (err?.message || err)))
      .finally(() => {
        running--;
        scheduleSave();
        pump();
      });
  }
}

export function enqueueBackground(job) {
  if (isBusyFor(job.repo, job.number, job.headSha)) return false;
  pending.push({
    repo: job.repo,
    number: job.number,
    headSha: job.headSha,
    source: job.source,
    priority: 'background',
    queuedAt: new Date().toISOString(),
  });
  scheduleSave();
  pump();
  return true;
}

function enqueueUser(job) {
  const k = key(job.repo, job.number);
  const index = pending.findIndex((j) => key(j.repo, j.number) === k && j.headSha === job.headSha);
  if (index >= 0) {
    const [existing] = pending.splice(index, 1);
    pending.unshift({ ...existing, priority: 'user' });
  } else {
    pending.unshift({ ...job, priority: 'user', queuedAt: new Date().toISOString() });
  }
  scheduleSave();
  pump();
}

export function parsePrUrl(value) {
  const match = String(value || '').match(/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/);
  if (!match) throw new ApiError(400, 'bad_request', 'expected a GitHub pull request URL');
  return { repo: match[1] + '/' + match[2], number: Number(match[3]) };
}

export async function requestPr(url) {
  const { repo, number } = parsePrUrl(url);
  const meta = await prMeta(repo, number);
  const story = await store.readStory(repo, number, meta.headSha);
  const reusable = Boolean(story && story.generation?.status === 'done');
  const k = key(repo, number);
  const prev = items.get(k);
  const now = new Date().toISOString();
  const item = normalizeItem({
    repo,
    number,
    title: meta.title,
    author: meta.author,
    url: meta.url,
    headSha: meta.headSha,
    source: 'manual',
    status: reusable ? 'done' : 'queued',
    progress: reusable ? progressOf(story) : { ready: 0, total: 0 },
    queuedAt: prev && prev.headSha === meta.headSha ? prev.queuedAt : now,
    updatedAt: now,
    openThreads: prev?.openThreads || 0,
    outdated: reusable && isOutdated(story),
  });
  if (reusable) currentStories.set(k, story);
  items.set(k, item);
  if (!reusable && !isBusyFor(repo, number, meta.headSha)) {
    const job = active.get(k);
    if (job && job.job.headSha !== meta.headSha) job.controller.abort();
    enqueueUser({ repo, number, headSha: meta.headSha, source: 'manual' });
  }
  scheduleSave();
  return publicItem(item);
}

export async function refreshOutdated() {
  for (const item of items.values()) {
    if (item.status !== 'done' || !item.headSha) continue;
    const story = await store.readStory(item.repo, item.number, item.headSha);
    item.outdated = isOutdated(story);
  }
  scheduleSave();
}

export async function retryStep(repo, number, stepId) {
  if (isBusy(repo, number)) throw new ApiError(409, 'busy', 'This PR is already being generated');
  const sha = getItem(repo, number)?.headSha || await store.latestStorySha(repo, number);
  const story = sha ? await store.readStory(repo, number, sha) : null;
  const step = story?.steps.find((s) => s.id === stepId);
  if (!step) throw new ApiError(404, 'not_found', 'Step not found');
  if (step.status !== 'failed') throw new ApiError(409, 'not_failed', 'Only failed steps can be retried');
  const meta = await prMeta(repo, number);
  if (meta.headSha !== sha) throw new ApiError(409, 'head_changed', 'The PR has new commits. Regenerate the story first.');
  if (isBusy(repo, number)) throw new ApiError(409, 'busy', 'This PR is already being generated');
  enqueueUser({ repo, number, headSha: sha, source: 'manual', stepId });
  return publicItem(getItem(repo, number));
}

export async function regeneratePr(repo, number) {
  if (isBusy(repo, number)) throw new ApiError(409, 'busy', 'This PR is already being generated');
  const meta = await prMeta(repo, number);
  const k = key(repo, number);
  const prev = items.get(k);
  const now = new Date().toISOString();
  const item = normalizeItem({
    ...(prev || {}),
    repo,
    number,
    title: meta.title,
    author: meta.author,
    url: meta.url,
    headSha: meta.headSha,
    source: 'manual',
    queuedAt: now,
    updatedAt: now,
  });
  items.set(k, item);
  enqueueUser({ repo, number, headSha: meta.headSha, source: 'manual', regenerate: true });
  return publicItem(item);
}

export function noteWatchedPr(node, current, story) {
  const k = key(node.repo, node.number);
  const prev = items.get(k);
  const now = new Date().toISOString();
  if (prev && isBusy(prev.repo, prev.number)) {
    prev.title = node.title || prev.title;
    prev.updatedAt = now;
    scheduleSave();
    return prev;
  }
  const item = normalizeItem({
    ...(prev || {}),
    repo: node.repo,
    number: node.number,
    title: node.title || prev?.title || '',
    author: node.author || prev?.author || '',
    url: node.url || prev?.url || 'https://github.com/' + node.repo + '/pull/' + node.number,
    headSha: node.headRefOid || prev?.headSha || '',
    source: prev?.source === 'manual' ? 'manual' : node.source,
    status: current ? 'done' : 'queued',
    progress: current ? progressOf(story) : { ready: 0, total: 0 },
    queuedAt: prev && prev.headSha === node.headRefOid ? prev.queuedAt : now,
    updatedAt: now,
    outdated: Boolean(current) && isOutdated(story),
  });
  items.set(k, item);
  scheduleSave();
  return item;
}

export function noteThreads(repo, number, openThreads) {
  const item = items.get(key(repo, number));
  if (!item) return;
  item.openThreads = Number(openThreads) || 0;
  scheduleSave();
}
