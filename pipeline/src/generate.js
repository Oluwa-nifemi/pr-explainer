import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { changedLines, expandHunkRefs, planSize, prepare, stepRange } from './diff.js';
import { pullDiff, pullRequest } from './github.js';
import { jsonCall, setMaxConcurrency } from './llm.js';
import { MODELS, getStoryModel } from './models.js';
import { fetchShas } from './mirror.js';
import { systemPrompt, diagramFixMessage, gistFixMessage, gistReviewPrompt, plannerPrompt, summaryPrompt, workerPrompt } from './prompts.js';
import { overridesHash } from './settings.js';
import { splitLargeHunks } from './split.js';
import { RepoContext } from './repoctx.js';
import { TopLevelScanner } from './scanner.js';
import { diagramFixSchema, gistMode, gistReviewSchema, inlineWorkerSchema, planSchema, summarySchema, workerSchema } from './schemas.js';
import { MAX_STEPS, cleanDiagram, diagramShapeProblems, enforceCoverage, hunkRef, mergeSmallSteps, normalizeKind, shortNote, splitColon } from './story.js';
import { gistLint, validateStory } from './validate.js';

const here = dirname(fileURLToPath(import.meta.url));
const BASE_HASH = createHash('sha1')
  .update(['prompts.js', 'prompt-defaults.js', 'settings.js', 'schemas.js', 'diff.js', 'split.js', 'story.js', 'generate.js'].map((f) => readFileSync(join(here, f), 'utf8')).join('\n'))
  .digest('hex');

export const pipelineVersion = () => createHash('sha1').update(BASE_HASH + MODELS[getStoryModel()].label + overridesHash()).digest('hex').slice(0, 12);

export { setMaxConcurrency };

const WORKER_TOKENS = 32000;
const WORKER_TIMEOUT_MS = 360000;
const TEMP_RE = /\b(temporar\w*|demo|debug|todo|revert\w*)\b/i;
const MAX_BULLETS = 5;
const MAX_BULLET_WORDS = 12;
const DANGLING = new Set(['and', 'or', 'but', 'the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'with', 'that', 'as', 'by', 'from', 'at', 'is', 'are', 'was', 'be', 'it', 'its', 'this', 'these', 'those', 'so', 'then', 'while', 'when', 'which', 'into', 'than', 'itself']);

function cutWords(text, max) {
  const w = String(text).trim().split(/\s+/).filter(Boolean);
  if (w.length <= max) return w.join(' ');
  w.length = max;
  while (w.length > 1 && DANGLING.has(w[w.length - 1].toLowerCase().replace(/[^a-z]/g, ''))) w.pop();
  return w.join(' ');
}

function repairSummary(value) {
  const summary = { ...value };
  summary.why = splitColon(summary.why || '');
  summary.riskReason = splitColon(summary.riskReason || '');
  const bullets = (summary.whatChanged || []).map(splitColon).filter(Boolean);
  const kept = bullets.slice(0, MAX_BULLETS);
  summary.whatChanged = kept.map((b) => cutWords(b, MAX_BULLET_WORDS));
  const shortened = kept.filter((b, i) => b !== summary.whatChanged[i]).length;
  const dropped = bullets.length - kept.length;
  if (shortened || dropped) console.warn('[pr-explainer] summary repaired in code: ' + shortened + ' bullet(s) shortened, ' + dropped + ' dropped');
  return summary;
}

function fallbackSummary(meta, changedLines) {
  const body = String(meta.body || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\r/g, '')
    .trim();
  const first = ((body.match(/[^.!?\n]+[.!?]?/) || [])[0] || '').trim();
  const why = first.split(/\s+/).filter(Boolean).length >= 4 ? first : meta.title || 'Pull request';
  return {
    why: splitColon(why),
    whatChanged: [],
    risk: 'medium',
    riskReason: 'No summary was generated.',
    reviewMinutes: Math.max(2, Math.round(changedLines / 60)),
  };
}

function sys(content) {
  return [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content },
  ];
}

async function fetchInput(repo, number) {
  const [detail, diffText] = await Promise.all([pullRequest(repo, number), pullDiff(repo, number)]);
  const meta = {
    number: detail.number,
    title: detail.title || '',
    body: detail.body || '',
    url: detail.html_url,
    author: detail.user?.login || '',
    baseRefName: detail.base?.ref,
    headRefName: detail.head?.ref,
    headRefOid: detail.head?.sha,
    additions: detail.additions ?? 0,
    deletions: detail.deletions ?? 0,
    changedFiles: detail.changed_files ?? 0,
  };
  return { meta, diffText, baseSha: detail.base?.sha || '' };
}

function prMeta(meta, repo, baseSha) {
  return {
    repo,
    number: meta.number,
    title: meta.title,
    body: meta.body || '',
    url: meta.url,
    author: meta.author?.login || meta.author || '',
    baseRef: meta.baseRefName,
    headRef: meta.headRefName,
    baseSha,
    headSha: meta.headRefOid,
    additions: meta.additions,
    deletions: meta.deletions,
    changedFiles: meta.changedFiles,
  };
}

const clone = (v) => JSON.parse(JSON.stringify(v));
export async function generateStory(input, opts = {}) {
  const model = getStoryModel();
  const onEvent = opts.onEvent || (() => {});
  const signal = opts.signal;
  const calls = opts.calls;
  const gistStats = Array.isArray(opts.gistLint) ? opts.gistLint : null;
  const cls = opts.priority === 'user' ? 'user' : 'background';
  const priority = (order) => ({ cls, order });
  const t0 = Date.now();
  const at = () => Date.now() - t0;
  const timings = {};

  const emit = (type, data) => {
    try {
      onEvent(type, data);
    } catch {}
  };
  const aborted = () => {
    const e = new Error('aborted');
    e.code = 'aborted';
    return e;
  };

  let meta;
  let diffText;
  let baseSha;
  try {
    if (opts.retryStory) {
      const pr = opts.retryStory.pr;
      meta = { ...pr, baseRefName: pr.baseRef, headRefName: pr.headRef, headRefOid: pr.headSha };
      baseSha = pr.baseSha;
      diffText = '';
    } else ({ meta, diffText, baseSha } = await fetchInput(input.repo, input.number));
  } catch (e) {
    const err = new Error('could not read ' + input.repo + '#' + input.number + ': ' + String(e.message || e));
    err.code = 'input_failed';
    emit('error', { code: err.code, message: err.message });
    throw err;
  }
  if (signal?.aborted) {
    emit('error', { code: 'aborted', message: 'aborted' });
    throw aborted();
  }

  const pr = prMeta(meta, input.repo, baseSha);
  const prep = prepare(diffText);
  const story = opts.retryStory ? clone(opts.retryStory) : {
    schemaVersion: 2,
    pr,
    generation: {
      status: 'planning',
      pipelineVersion: pipelineVersion(),
      model: MODELS[model].label,
      startedAt: new Date(t0).toISOString(),
    },
    steps: [],
    skippedFiles: prep.skippedFiles,
  };
  if (opts.retryStory) {
    const hunks = story.steps.flatMap((s) => s.hunks).map((h, i) => ({ ...h, alias: 'H' + (i + 1), lines: h.patch.split('\n') }));
    prep.hunks = hunks;
    prep.files = [...new Set(hunks.map((h) => h.path))].map((path, i) => ({ path, alias: 'F' + (i + 1), hunks: hunks.filter((h) => h.path === path) }));
    story.steps.find((s) => s.id === opts.stepId).status = 'retrying';
  }
  emit('story', clone(story));

  const splits = opts.retryStory ? [] : await splitLargeHunks(prep, { prTitle: meta.title, model, priority: priority(0), signal, calls });
  for (const s of splits) console.error('[pr-explainer] split ' + s.path + ' into ' + s.parts.length + ': ' + s.parts.join(' | '));
  const ctx = {
    meta,
    pr,
    files: prep.files,
    hunks: prep.hunks,
    skippedFiles: prep.skippedFiles,
    diffPaths: new Set(prep.files.map((f) => f.path)),
    byAlias: new Map(prep.hunks.map((h) => [h.alias, h])),
  };
  const size = planSize(prep.files);
  const planStepsRange = stepRange(size);

  let planSteps = [];
  let planEmitted = false;
  const stepQueue = [];
  const renderStep = (s, index, forcePending = false) => {
    const id = 's' + (index + 1);
    const deps = new Set();
    for (const d of s.dependsOn || []) {
      const n = typeof d === 'number' ? d : parseInt(String(d).replace(/\D/g, ''), 10);
      if (n >= 1 && n <= index) deps.add('s' + n);
    }
    const out = {
      id,
      order: index + 1,
      status: forcePending ? 'pending' : s.status,
      title: s.title,
      kind: s.kind,
      summary: s.summary,
      dependsOn: [...deps],
      hunks: s.hunkAliases.map((a) => hunkRef(ctx.byAlias.get(a), s.notes?.get(a))),
    };
    if (!forcePending && s.status === 'ready') {
      out.gist = s.gist;
      const d = cleanDiagram(s.diagramRaw, s.branches);
      if (d) out.diagram = d;
    }
    if (!forcePending && s.status === 'failed') out.error = s.error || 'step failed';
    return out;
  };

  const pushStep = (s) => {
    const index = planSteps.indexOf(s);
    if (index < 0) return;
    const event = renderStep(s, index);
    if (planEmitted) emit('step', event);
    else stepQueue.push(event);
  };

  const planStepFrom = (raw) => ({
    title: String(raw.title || 'Untitled step').slice(0, 80),
    kind: normalizeKind(raw.kind),
    summary: splitColon(raw.summary || ''),
    dependsOn: raw.dependsOn || [],
    hunkAliases: expandHunkRefs(raw.hunks, ctx.hunks),
    status: 'pending',
  });

  const applyWorker = (s, value, gist) => {
    s.gist = gist;
    s.branches = Array.isArray(value.branches) && s.hasFunctionBody ? value.branches : [];
    s.diagramRaw = value.diagram;
    s.notes = new Map();
    for (const n of value.hunkNotes || []) {
      const [a] = expandHunkRefs([n.hunk], ctx.hunks);
      const note = n.note ? shortNote(splitColon(n.note)) : '';
      if (a && note) s.notes.set(a, note);
    }
  };

  const hunkOrder = new Map(ctx.hunks.map((h, i) => [h.alias, i]));
  const sharedPrefix = (a, b) => {
    const pa = a.split('/');
    const pb = b.split('/');
    let i = 0;
    while (i < pa.length - 1 && i < pb.length - 1 && pa[i] === pb[i]) i++;
    return i;
  };
  const absorbLeftovers = (steps) => {
    const leftovers = steps.find((s) => s.isLeftovers);
    const pool = steps.filter((s) => s !== leftovers);
    if (!leftovers || !pool.length) return steps;
    for (const alias of leftovers.hunkAliases) {
      const path = ctx.byAlias.get(alias).path;
      let best = pool[0];
      let bestScore = -1;
      for (const s of pool) {
        const score = Math.max(0, ...s.hunkAliases.map((x) => sharedPrefix(path, ctx.byAlias.get(x).path)));
        if (score > bestScore) {
          best = s;
          bestScore = score;
        }
      }
      best.hunkAliases.push(alias);
    }
    for (const s of pool) s.hunkAliases.sort((x, y) => hunkOrder.get(x) - hunkOrder.get(y));
    return pool;
  };

  let workerFailures = 0;
  const dispatched = new Map();
  const workerPromises = [];
  let repoReady = null;
  let repoContext = null;

  const workerCall = async (steps, index, planIncomplete) => {
    const step = steps[index];
    const hunks = step.hunkAliases.map((a) => ctx.byAlias.get(a));
    let contextText = '';
    let functionsText = '';
    if (repoReady) {
      await repoReady;
      const [c, f] = await Promise.all([
        repoContext.forStep(hunks, { maxChars: 28000 }),
        repoContext.functionBodies(hunks, { max: 3, maxLines: 120 }),
      ]);
      contextText = c.text;
      functionsText = f;
      step.hasFunctionBody = Boolean(f && String(f).trim());
    }
    const mode = gistMode();
    const prompt = workerPrompt(ctx, steps, index, { contextText, contextKind: 'v2', functionsText, planIncomplete, gistMode: mode });
    const schema = mode === 'inline' ? inlineWorkerSchema : workerSchema;
    const opts = {
      label: 'worker-' + (index + 1),
      messages: sys(prompt),
      model,
      schema,
      maxTokens: WORKER_TOKENS,
      timeoutMs: WORKER_TIMEOUT_MS,
      priority: priority(10 + index),
      signal,
    };
    const value = (await jsonCall(opts, gistValueCheck, { calls })).value;
    return { value, prompt, schema, hunks, mode };
  };

  const gistValueCheck = (v) => (typeof v.gist === 'string' && v.gist.trim().length > 20 ? null : 'gist is missing');

  const repairGist = async ({ object, gist, schema, messages, label, changed }) => {
    const bad = gistLint(gist, { changedLines: changed });
    if (!bad.length) return { gist, object, violations: bad };
    try {
      const opts = {
        label: label + '-fix',
        messages: [...messages, { role: 'assistant', content: JSON.stringify(object) }, { role: 'user', content: gistFixMessage(bad) }],
        model,
        schema,
        maxTokens: WORKER_TOKENS,
        timeoutMs: WORKER_TIMEOUT_MS,
        priority: priority(70),
        signal,
      };
      const next = (await jsonCall(opts, gistValueCheck, { calls })).value;
      const fixed = String(next.gist || '').trim();
      const after = gistLint(fixed, { changedLines: changed });
      if (after.length < bad.length) return { gist: fixed, object: { ...object, ...next }, violations: after };
      return { gist, object, violations: bad };
    } catch (e) {
      if (e.aborted || signal?.aborted) throw e;
      console.error('[pr-explainer] gist fix failed for ' + label + ': ' + String(e.message || e));
      return { gist, object, violations: bad };
    }
  };

  const diagramValueCheck = (v) => ('diagram' in v ? null : 'diagram is missing');

  const repairDiagram = async ({ object, messages, index }) => {
    const first = diagramShapeProblems(object.diagram);
    if (!first.length) return { diagram: object.diagram, problems: first };
    try {
      const opts = {
        label: 'worker-' + (index + 1) + '-diagram-fix',
        messages: [...messages, { role: 'assistant', content: JSON.stringify(object) }, { role: 'user', content: diagramFixMessage(first) }],
        model,
        schema: diagramFixSchema,
        maxTokens: 8000,
        timeoutMs: WORKER_TIMEOUT_MS,
        priority: priority(75),
        signal,
      };
      const next = (await jsonCall(opts, diagramValueCheck, { calls })).value;
      const after = diagramShapeProblems(next.diagram);
      if (!after.length) return { diagram: next.diagram, problems: after };
      console.error('[pr-explainer] step ' + (index + 1) + ' diagram still breaks ' + after.length + ' rule(s), dropped: ' + after.join('; '));
      return { diagram: null, problems: after };
    } catch (e) {
      if (e.aborted || signal?.aborted) throw e;
      console.error('[pr-explainer] step ' + (index + 1) + ' diagram fix failed, dropped: ' + String(e.message || e));
      return { diagram: null, problems: first };
    }
  };

  const stepGist = async (s, index, work) => {
    const changed = s.hunkAliases.reduce((n, a) => n + changedLines(ctx.byAlias.get(a)), 0);
    const record = { step: index + 1, mode: work.mode, first: gistLint(String(work.value.gist || '').trim(), { changedLines: changed }), final: [] };
    const messages = sys(work.prompt);
    let out = await repairGist({ object: work.value, gist: String(work.value.gist || '').trim(), schema: work.schema, messages, label: 'worker-' + (index + 1), changed });
    let object = out.object;
    if (work.mode === 'review') {
      const prompt = gistReviewPrompt(out.gist, work.hunks);
      try {
        const opts = {
          label: 'gist-review-' + (index + 1),
          messages: sys(prompt),
          model,
          schema: gistReviewSchema,
          maxTokens: 3000,
          timeoutMs: 180000,
          priority: priority(60 + index),
          signal,
        };
        const reviewed = (await jsonCall(opts, gistValueCheck, { calls })).value;
        record.missing = Array.isArray(reviewed.missing) ? reviewed.missing : [];
        out = await repairGist({ object: reviewed, gist: String(reviewed.gist || '').trim(), schema: gistReviewSchema, messages: sys(prompt), label: 'gist-review-' + (index + 1), changed });
      } catch (e) {
        if (e.aborted || signal?.aborted) throw e;
        record.reviewError = String(e.message || e);
      }
    }
    const diagram = await repairDiagram({ object, messages, index });
    object = { ...object, diagram: diagram.diagram };
    record.final = out.violations;
    if (gistStats) gistStats.push(record);
    if (out.violations.length) console.error('[pr-explainer] step ' + (index + 1) + ' gist still breaks ' + out.violations.length + ' rule(s): ' + out.violations.join('; '));
    return { value: { ...object, gist: out.gist }, gist: out.gist };
  };

  const dispatch = (s, steps, planIncomplete) => {
    const index = steps.indexOf(s);
    if (index < 0) return;
    const snapshot = [...s.hunkAliases].sort();
    const p = (async () => {
      try {
        const work = await workerCall(steps, index, planIncomplete);
        const { value, gist } = await stepGist(s, index, work);
        applyWorker(s, value, gist);
        s.status = 'ready';
      } catch (e) {
        if (e.aborted || signal?.aborted) throw e;
        workerFailures++;
        s.status = 'failed';
        s.error = String(e.message || e);
      }
      s.doneAtMs = at();
      pushStep(s);
    })();
    p.catch(() => {});
    dispatched.set(s, { snapshot, p });
    workerPromises.push(p);
  };

  const claimed = new Set();
  let streamed = [];
  const scanner = new TopLevelScanner({
    onItem: (key, raw) => {
      if (key !== 'steps') return;
      const s = planStepFrom(raw);
      s.hunkAliases = s.hunkAliases.filter((a) => ctx.byAlias.has(a) && !claimed.has(a));
      s.hunkAliases.forEach((a) => claimed.add(a));
      streamed.push(s);
      if (s.hunkAliases.length) dispatch(s, streamed, true);
    },
  });

  try {
    const mirror = await fetchShas(input.repo, [pr.headSha, pr.baseSha]);
    if (signal?.aborted) throw aborted();
    repoContext = new RepoContext({ dir: mirror.dir, headSha: pr.headSha, baseSha: pr.baseSha, hunks: ctx.hunks, diffPaths: ctx.diffPaths });
    repoReady = repoContext.warm().catch(() => {});

    if (opts.retryStory) {
      const index = story.steps.findIndex((s) => s.id === opts.stepId);
      planSteps = story.steps.map((s) => ({ ...s, hunkAliases: s.hunks.map((h) => ctx.hunks.find((x) => x.id === h.id).alias) }));
      const step = planSteps[index];
      try {
        const work = await workerCall(planSteps, index, false);
        const { value, gist } = await stepGist(step, index, work);
        applyWorker(step, value, gist);
        step.status = 'ready';
        story.steps[index] = renderStep(step, index);
      } catch (e) {
        if (signal?.aborted) throw e;
        story.steps[index] = { ...story.steps[index], status: 'failed', error: String(e.message || e) };
      }
      emit('step', clone(story.steps[index]));
      if (story.steps.some((s) => s.status === 'ready') && story.generation.status === 'failed') {
        story.generation.status = 'done';
        delete story.generation.error;
      }
      emit('done', clone(story.generation));
      return story;
    }

    const summaryP = jsonCall({
      label: 'summary',
      messages: sys(summaryPrompt(ctx)),
      model,
      schema: summarySchema,
      maxTokens: 8000,
      priority: priority(1),
      signal,
    }, (v) => {
      const temp = (v.whatChanged || []).find((b) => TEMP_RE.test(b));
      if (temp && !TEMP_RE.test(v.riskReason || '')) return 'riskReason must name the temporary, demo or debug behaviour in "' + temp + '"';
      return null;
    }, { calls })
      .then(({ value }) => {
        story.summary = repairSummary(value);
        timings.summaryMs = at();
        emit('summary', clone(story.summary));
      })
      .catch((e) => {
        if (e.aborted || signal?.aborted) return;
        console.warn('[pr-explainer] summary failed, using fallback: ' + String(e.message || e));
        story.summary = fallbackSummary(meta, size);
        story.generation.summaryFallback = true;
        timings.summaryMs = at();
        emit('summary', clone(story.summary));
      });

    let plan;
    try {
      plan = await jsonCall(
        {
          label: 'planner',
          messages: sys(plannerPrompt(ctx, { size, range: planStepsRange })),
          model,
          schema: planSchema,
          maxTokens: 24000,
          timeoutMs: 300000,
          priority: priority(0),
          signal,
          onContent: (c) => scanner.feed(c),
        },
        (v) => (Array.isArray(v.steps) && v.steps.length ? null : 'steps is empty'),
        { calls }
      );
    } catch (e) {
      const err = new Error('planner failed: ' + String(e.message || e));
      err.code = e.aborted ? 'aborted' : 'planner_failed';
      throw err;
    }

    planSteps = streamed.length === plan.value.steps.length && plan.attempts === 1 ? streamed : plan.value.steps.map(planStepFrom);
    const { steps: fixed } = enforceCoverage(planSteps, ctx.hunks);
    planSteps = absorbLeftovers(fixed);
    planSteps = mergeSmallSteps(planSteps, {
      sizeOf: (s) => s.hunkAliases.reduce((n, a) => {
        const h = ctx.byAlias.get(a);
        return h.fileRole === 'test' || h.fileRole === 'generated' ? n : n + changedLines(h);
      }, 0),
      pathOf: (a) => ctx.byAlias.get(a).path,
      orderOf: (a) => hunkOrder.get(a),
      minSteps: planStepsRange[0],
      maxSteps: planStepsRange[1],
    });
    while (planSteps.length > MAX_STEPS) planSteps[planSteps.length - 2].hunkAliases.push(...planSteps.pop().hunkAliases);
    timings.planMs = at();
    story.generation.status = 'explaining';

    emit('plan', planSteps.map((s, i) => renderStep(s, i, true)));
    planEmitted = true;
    for (const event of stepQueue.splice(0)) emit('step', event);

    for (const s of planSteps) {
      const d = dispatched.get(s);
      if (!d) dispatch(s, planSteps, false);
      else if (d.snapshot.join() !== [...s.hunkAliases].sort().join()) {
        if (s.status !== 'ready') s.status = 'pending';
        delete s.doneAtMs;
        dispatch(s, planSteps, false);
      }
    }

    await Promise.all([summaryP, ...workerPromises]);
    timings.totalMs = at();
    if (planSteps[0]?.status === 'ready' && planSteps[0].doneAtMs !== undefined) timings.step1Ms = planSteps[0].doneAtMs;
    story.steps = planSteps.map((s, i) => renderStep(s, i));

    const failed = planSteps.filter((s) => s.status === 'failed').length;
    story.generation.timings = timings;
    story.generation.finishedAt = new Date().toISOString();
    if (planSteps.length && failed === planSteps.length) {
      story.generation.status = 'failed';
      story.generation.error = 'all ' + failed + ' steps failed';
      emit('error', { code: 'all_steps_failed', message: story.generation.error });
    } else {
      story.generation.status = 'done';
      emit('done', clone(story.generation));
    }

    const all = validateStory(story, ctx.hunks);
    const violations = all.filter((x) => !x.startsWith('warning: '));
    const warnings = all.filter((x) => x.startsWith('warning: '));
    if (violations.length) console.error('[pr-explainer] ' + violations.length + ' contract violation(s) in ' + pr.repo + '#' + pr.number + ':\n  ' + violations.join('\n  '));
    if (warnings.length) console.error('[pr-explainer] ' + warnings.length + ' gist warning(s) in ' + pr.repo + '#' + pr.number + ':\n  ' + warnings.join('\n  '));
    return story;
  } catch (e) {
    story.generation.status = 'failed';
    story.generation.error = String(e.message || e);
    story.generation.finishedAt = new Date().toISOString();
    if (Object.keys(timings).length) story.generation.timings = timings;
    emit('error', { code: e.code || 'pipeline_failed', message: story.generation.error });
    for (const p of workerPromises) p.catch(() => {});
    throw e;
  }
}
