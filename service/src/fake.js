import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { MODELS } from '../../pipeline/src/models.js';

export const pipelineVersion = () => 'deadbeef0001';

const here = dirname(fileURLToPath(import.meta.url));
const roots = [
  join(here, '..', '..', 'pipeline', 'out-v2'),
  join(here, '..', '..', 'app', 'public', 'stories'),
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function storyFiles() {
  const files = [];
  for (const dir of roots) {
    try {
      for (const name of readdirSync(dir)) {
        if (name.endsWith('.json')) files.push(join(dir, name));
      }
    } catch {}
  }
  return files;
}

function pickStory(input) {
  if (process.env.PRX_FAKE_STORY) {
    return JSON.parse(readFileSync(process.env.PRX_FAKE_STORY, 'utf8'));
  }
  const files = storyFiles();
  const repoName = String(input.repo).split('/')[1] || '';
  const exact = files.find((f) => f.includes('-' + repoName + '-' + input.number + '-'));
  const byNumber = files.find((f) => f.includes('-' + input.number + '-'));
  const chosen = exact || byNumber || files.find((f) => f.includes('-2203-')) || files[0];
  if (!chosen) throw new Error('fake generator found no story JSON to replay');
  return JSON.parse(readFileSync(chosen, 'utf8'));
}

function fingerprint(hunk) {
  const changed = String(hunk.patch || '')
    .split('\n')
    .filter((line) => line.startsWith('+') || line.startsWith('-'))
    .filter((line) => !line.startsWith('+++') && !line.startsWith('---'))
    .join('\n');
  return createHash('sha256').update(String(hunk.path || '') + '\n' + changed).digest('hex').slice(0, 12);
}

function upgradeStep(step) {
  const out = {
    id: step.id,
    order: step.order,
    status: 'pending',
    title: step.title || '',
    kind: step.kind || 'core-logic',
    summary: step.summary || '',
    dependsOn: step.dependsOn || [],
    hunks: (step.hunks || []).map((hunk) => ({
      id: hunk.id,
      fingerprint: hunk.fingerprint || fingerprint(hunk),
      path: hunk.path,
      ...(hunk.oldPath ? { oldPath: hunk.oldPath } : {}),
      fileStatus: hunk.fileStatus || 'modified',
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      header: hunk.header || '',
      patch: hunk.patch || '',
      ...(hunk.note ? { note: hunk.note } : {}),
    })),
  };
  if (step.explanation) out.explanation = step.explanation;
  if (step.dataFlow) out.dataFlow = step.dataFlow;
  if (step.diagram) out.diagram = step.diagram;
  if (Array.isArray(step.questions)) {
    out.questions = step.questions;
  } else if (Array.isArray(step.checklist)) {
    out.questions = step.checklist.map((item, i) => ({
      id: out.id + '-q' + (i + 1),
      text: item.text,
      ...(item.path ? { path: item.path } : {}),
      ...(item.line ? { line: item.line } : {}),
      ...(item.side ? { side: item.side } : {}),
    }));
  }
  return out;
}

function upgrade(source, input) {
  const pr = source.pr || {};
  const summary = source.summary || {};
  return {
    schemaVersion: 2,
    pr: {
      repo: input.repo,
      number: input.number,
      title: pr.title || '',
      body: pr.body || '',
      url: pr.url || 'https://github.com/' + input.repo + '/pull/' + input.number,
      author: pr.author || '',
      baseRef: pr.baseRef || '',
      headRef: pr.headRef || '',
      baseSha: pr.baseSha || '',
      headSha: input.headSha || pr.headSha || '',
      additions: pr.additions ?? 0,
      deletions: pr.deletions ?? 0,
      changedFiles: pr.changedFiles ?? 0,
    },
    generation: {
      status: 'planning',
      pipelineVersion: pipelineVersion(),
      model: MODELS.deepseek.label,
      startedAt: new Date().toISOString(),
    },
    ...(source.summary ? { summary: { ...summary } } : {}),
    steps: (source.steps || []).map(upgradeStep),
    skippedFiles: source.skippedFiles || [],
    openQuestions: source.openQuestions || [],
  };
}

export async function generateStory(input, opts = {}) {
  const onEvent = opts.onEvent || (() => {});
  const delay = Number(process.env.PRX_FAKE_DELAY_MS ?? 120);
  const base = upgrade(pickStory(input), input);
  const startedAt = Date.now();
  const story = structuredClone(base);

  const checkAbort = () => {
    if (opts.signal?.aborted) throw new Error('aborted');
  };

  onEvent('story', structuredClone(story));
  await sleep(delay);
  checkAbort();

  if (base.summary) {
    story.summary = base.summary;
    story.generation.timings = { summaryMs: Date.now() - startedAt };
    onEvent('summary', structuredClone(story.summary));
    await sleep(delay);
    checkAbort();
  }

  story.steps = base.steps.map((step) => ({ ...step, status: 'pending' }));
  story.generation.status = 'explaining';
  story.generation.timings = { ...story.generation.timings, planMs: Date.now() - startedAt };
  onEvent('plan', structuredClone(story.steps));
  await sleep(delay);

  for (const step of base.steps) {
    checkAbort();
    const ready = { ...step, status: 'ready' };
    story.steps = story.steps.map((s) => (s.id === ready.id ? ready : s));
    onEvent('step', structuredClone(ready));
    await sleep(delay);
  }

  story.generation = {
    ...story.generation,
    status: 'done',
    finishedAt: new Date().toISOString(),
    timings: { ...story.generation.timings, totalMs: Date.now() - startedAt },
  };
  onEvent('done', structuredClone(story.generation));
  return story;
}

export function setMaxConcurrency() {}
