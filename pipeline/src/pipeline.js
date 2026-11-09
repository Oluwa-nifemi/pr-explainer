import { chat, jsonCall, concurrencyStats, runScope, Limiter } from './llm.js';
import { MODELS, getStoryModel } from './models.js';
import { prepare, expandHunkRefs, hunkBlock } from './diff.js';
import { prMeta, enforceCoverage, validateCoverage, hunkRef, cleanDiagram, normalizeKind, writeStory } from './story.js';
import { systemPrompt, plannerPrompt, summaryPrompt, workerPrompt, singleShotPrompt } from './prompts.js';
import { summarySchema, planSchema, workerSchema, singleShotSchema } from './schemas.js';
import { prefetchContext, warmContext, TOOL_DEFS, runTool } from './context.js';
import { RepoContext } from './repoctx.js';
import { TopLevelScanner } from './scanner.js';

export const ARCHS = {
  'A-single': { mode: 'single', thinking: 'default' },
  'B-fanout': { mode: 'fanout', planner: 'default', worker: 'default', side: 'default', context: 'none' },
  'C1-prefetch': { mode: 'fanout', planner: 'default', worker: 'default', side: 'default', context: 'prefetch' },
  'C2-tools': { mode: 'fanout', planner: 'default', worker: 'default', side: 'default', context: 'tools' },
};

export function defineArch(name, cfg) {
  ARCHS[name] = cfg;
}

const sys = (content) => [{ role: 'system', content: systemPrompt() }, { role: 'user', content }];

function planStepFrom(raw, ctx) {
  return {
    title: String(raw.title || 'Untitled step').slice(0, 80),
    kind: normalizeKind(raw.kind),
    summary: String(raw.summary || ''),
    dependsOn: raw.dependsOn || [],
    hunkAliases: expandHunkRefs(raw.hunks, ctx.hunks),
    status: 'pending',
  };
}

function applyWorker(step, value, ctx) {
  step.explanation = value.explanation;
  step.dataFlow = (value.dataFlow || []).filter(Boolean);
  step.diagramRaw = value.diagram;
  step.checklistRaw = value.checklist || [];
  step.notes = new Map();
  for (const n of value.hunkNotes || []) {
    const [a] = expandHunkRefs([n.hunk], ctx.hunks);
    if (a && n.note) step.notes.set(a, n.note);
  }
  step.status = 'ready';
}

function render(planSteps, ctx) {
  const live = planSteps.filter((s) => s.hunkAliases.length);
  return live.map((s, i) => {
    const id = 's' + (i + 1);
    const deps = new Set();
    for (const d of s.dependsOn || []) {
      const n = typeof d === 'number' ? d : parseInt(String(d).replace(/\D/g, ''), 10);
      if (n >= 1 && n <= i) deps.add('s' + n);
    }
    const out = {
      id,
      order: i + 1,
      status: s.status,
      title: s.title,
      kind: s.kind,
      summary: s.summary,
      dependsOn: [...deps],
      hunks: s.hunkAliases.map((a) => hunkRef(ctx.byAlias.get(a), s.notes?.get(a))),
    };
    if (s.status === 'ready') {
      out.explanation = s.explanation;
      out.dataFlow = s.dataFlow;
      const d = cleanDiagram(s.diagramRaw);
      if (d) out.diagram = d;
      const paths = new Set(out.hunks.map((h) => h.path));
      out.checklist = s.checklistRaw.filter((c) => c && c.text).map((c, k) => {
        const item = { id: id + '-c' + (k + 1), text: c.text, level: c.level === 'concern' ? 'concern' : 'check' };
        if (c.path && paths.has(c.path)) {
          item.path = c.path;
          if (c.line > 0) item.line = c.line;
        }
        return item;
      });
    }
    return out;
  });
}

function totals(calls) {
  const t = { calls: calls.length, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, errors: 0 };
  for (const c of calls) {
    t.promptTokens += c.promptTokens || 0;
    t.completionTokens += c.completionTokens || 0;
    t.reasoningTokens += c.reasoningTokens || 0;
    if (c.error || c.jsonError) t.errors++;
  }
  const tps = calls.map((c) => c.decodeTps).filter(Boolean);
  t.medianDecodeTps = tps.length ? tps.sort((a, b) => a - b)[Math.floor(tps.length / 2)] : null;
  return t;
}

export function loadInput({ meta, diffText, repoDir }) {
  const prep = prepare(diffText);
  const pr = prMeta(meta);
  return { meta, pr, repoDir, ...prep, byAlias: new Map(prep.hunks.map((h) => [h.alias, h])), diffPaths: new Set(prep.files.map((f) => f.path)) };
}

export function runStory(ctx, archName, opts = {}) {
  const lane = new Limiter(opts.slots || 8);
  return runScope.run({ lane }, () => runStoryInner(ctx, archName, opts));
}

async function runStoryInner(ctx, archName, { outPath, log = () => {} } = {}) {
  const cfg = ARCHS[archName];
  if (!cfg) throw new Error('unknown arch ' + archName);
  const t0 = Date.now();
  const at = () => Date.now() - t0;
  const calls = [];
  const m = { arch: archName, cfg, repo: ctx.pr.repo, number: ctx.pr.number, hunks: ctx.hunks.length, files: ctx.files.length, stages: {}, jsonRetries: 0, jsonFailures: 0, workerFailures: 0, redispatched: 0 };
  const story = {
    schemaVersion: 1,
    pr: ctx.pr,
    generation: { status: 'planning', architecture: archName, model: MODELS[getStoryModel()].label, startedAt: new Date(t0).toISOString() },
    steps: [],
    skippedFiles: ctx.skippedFiles,
    openQuestions: [],
  };
  let planSteps = [];
  const write = () => {
    story.steps = render(planSteps, ctx);
    if (outPath) writeStory(outPath, story);
  };
  const mark = (name, extra = {}) => {
    m.stages[name] = { ms: at(), ...extra };
    log(archName + ' ' + name + ' @' + (at() / 1000).toFixed(1) + 's');
  };
  const stepReady = (s) => {
    if (m.firstReadyMs === undefined) m.firstReadyMs = at();
    const live = planSteps.filter((x) => x.hunkAliases.length);
    if ((live.length ? live[0] === s : s.firstStreamed) && m.step1ReadyMs === undefined) m.step1ReadyMs = at();
  };
  write();

  try {
    if (cfg.mode === 'single') await single(ctx, cfg, { story, calls, m, at, mark, write, stepReady, get: () => planSteps, set: (v) => (planSteps = v) });
    else await fanout(ctx, cfg, { story, calls, m, at, mark, write, stepReady, get: () => planSteps, set: (v) => (planSteps = v) });
    story.generation.status = 'done';
  } catch (e) {
    story.generation.status = 'failed';
    story.generation.error = String(e.message || e);
    m.error = story.generation.error;
  }
  m.totalMs = at();
  story.generation.finishedAt = new Date().toISOString();
  story.generation.timings = { planMs: m.planMs, firstStepMs: m.step1ReadyMs ?? m.firstReadyMs, totalMs: m.totalMs };
  write();
  const cov = validateCoverage(story, ctx.hunks);
  m.coverageOk = cov.ok;
  m.coverageFinal = cov;
  m.steps = story.steps.length;
  m.readySteps = story.steps.filter((s) => s.status === 'ready').length;
  m.peakConcurrency = concurrencyStats();
  m.tokens = totals(calls);
  m.calls = calls.map(({ contentSamples, ...c }) => c);
  return { story, metrics: m };
}

async function single(ctx, cfg, { story, calls, m, at, mark, write, stepReady, get, set }) {
  let contextText;
  if (cfg.context === 'prefetch' && ctx.repoDir) {
    const t = Date.now();
    await warmContext(ctx.repoDir, ctx.pr.headSha, ctx.hunks);
    const c = await prefetchContext(ctx.repoDir, ctx.pr.headSha, ctx.hunks, { diffPaths: ctx.diffPaths, maxChars: cfg.contextChars || 60000, maxSymbols: 25 });
    contextText = c.text;
    m.prefetch = [{ step: 'all', ms: Date.now() - t, chars: c.chars, symbols: c.symbols }];
  }
  const streamed = [];
  const scanner = new TopLevelScanner({
    onValue: (key, v) => {
      if (key === 'summary' && !story.summary) {
        story.summary = v;
        m.summaryMs = at();
        mark('summary-streamed');
        write();
      }
    },
    onItem: (key, v, index) => {
      if (key !== 'steps') return;
      const s = planStepFrom(v, ctx);
      applyWorker(s, v, ctx);
      streamed.length = index;
      streamed.push(s);
      set([...streamed]);
      stepReady(s);
      if (!m.stages['first-step-streamed']) mark('first-step-streamed');
      story.generation.status = 'explaining';
      write();
    },
  });
  const { value, attempts } = await jsonCall(
    { label: 'single', messages: sys(singleShotPrompt(ctx, { contextText })), thinking: cfg.thinking, schema: singleShotSchema, maxTokens: 48000, timeoutMs: 600000, onContent: (c) => scanner.feed(c) },
    (v) => (Array.isArray(v.steps) && v.steps.length ? null : 'steps is empty'),
    { calls }
  );
  m.jsonRetries += attempts - 1;
  const steps = value.steps.map((raw) => {
    const s = planStepFrom(raw, ctx);
    applyWorker(s, raw, ctx);
    return s;
  });
  const { steps: fixed, issues } = enforceCoverage(steps, ctx.hunks);
  for (const s of fixed) if (!s.explanation) s.status = 'failed';
  m.coverageRepairs = issues;
  set(fixed);
  story.summary = value.summary;
  story.openQuestions = value.openQuestions || [];
  m.planMs = m.planMs ?? at();
  if (m.summaryMs === undefined) m.summaryMs = at();
  if (m.firstReadyMs === undefined) stepReady(fixed[0]);
  mark('done');
}

async function workerCall(ctx, cfg, planSteps, index, { calls, m, planIncomplete, repo }) {
  const step = planSteps[index];
  const label = 'worker-' + (index + 1);
  const hunks = step.hunkAliases.map((a) => ctx.byAlias.get(a));
  let contextText;
  if (cfg.context === 'v2' && repo) {
    const t = Date.now();
    await repo.ready;
    const c = await repo.rc.forStep(hunks, { maxChars: cfg.contextChars || 28000 });
    contextText = c.text;
    (m.prefetch ||= []).push({ step: index + 1, ms: Date.now() - t, chars: c.chars, ...c.counts });
  } else if (step.contextText !== undefined) {
    contextText = step.contextText;
  } else if (cfg.context === 'prefetch' && ctx.repoDir) {
    const t = Date.now();
    const c = await prefetchContext(ctx.repoDir, ctx.pr.headSha, hunks, { diffPaths: ctx.diffPaths, maxChars: cfg.contextChars || 24000 });
    contextText = c.text;
    (m.prefetch ||= []).push({ step: index + 1, ms: Date.now() - t, chars: c.chars, symbols: c.symbols });
  }
  const prompt = workerPrompt(ctx, planSteps, index, { contextText, contextKind: cfg.context === 'v2' ? 'v2' : 'v1', planIncomplete, toolsAvailable: cfg.context === 'tools' });
  let messages = sys(prompt);
  if (cfg.context === 'tools' && ctx.repoDir) {
    const toolLog = { step: index + 1, rounds: 0, calls: [] };
    (m.toolUse ||= []).push(toolLog);
    const roundMsgs = [...messages.slice(0, 1), { role: 'user', content: prompt + '\n\nFirst decide whether you need more repository context. Call tools if you do. When you have enough, reply with only the word DONE.' }];
    for (let round = 0; round < (cfg.maxToolRounds || 3); round++) {
      const out = await chat({ label: label + '-tools' + round, messages: roundMsgs, thinking: cfg.worker, tools: TOOL_DEFS, maxTokens: 4000, timeoutMs: 120000, priority: 10 + index });
      calls.push(out.rec);
      if (out.rec.error || !out.toolCalls.length) break;
      toolLog.rounds++;
      roundMsgs.push({ role: 'assistant', content: out.content || '', tool_calls: out.toolCalls });
      for (const tc of out.toolCalls.slice(0, 6)) {
        let args = {};
        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch {}
        const result = await runTool(ctx.repoDir, ctx.pr.headSha, tc.function.name, args);
        toolLog.calls.push({ name: tc.function.name, args, chars: result.length });
        roundMsgs.push({ role: 'tool', tool_call_id: tc.id, content: result.slice(0, 12000) });
      }
      for (const tc of out.toolCalls.slice(6)) roundMsgs.push({ role: 'tool', tool_call_id: tc.id, content: 'skipped: too many calls in one round' });
    }
    const gathered = roundMsgs.slice(2);
    if (gathered.length) {
      const transcript = gathered
        .map((x) => (x.role === 'assistant' ? x.tool_calls.map((t) => '> ' + t.function.name + ' ' + t.function.arguments).join('\n') : x.content))
        .join('\n\n');
      messages = sys(prompt.replace('\n## Task', '\n## Repository context you looked up\n' + transcript.slice(0, 40000) + '\n\n## Task'));
    }
  }
  const { value, attempts } = await jsonCall(
    { label, messages, thinking: cfg.worker, schema: workerSchema, maxTokens: cfg.workerMaxTokens || 12000, timeoutMs: cfg.workerTimeoutMs || 180000, priority: 10 + index },
    (v) => (typeof v.explanation === 'string' && v.explanation.length > 20 ? null : 'explanation is missing'),
    { calls }
  );
  m.jsonRetries += attempts - 1;
  return value;
}


const placementSchema = {
  name: 'placements',
  schema: {
    type: 'object',
    properties: { placements: { type: 'array', items: { type: 'object', properties: { hunk: { type: 'string' }, step: { type: 'integer' } }, required: ['hunk', 'step'], additionalProperties: false } } },
    required: ['placements'],
    additionalProperties: false,
  },
};

async function placeMissing(ctx, planSteps, { calls, m }) {
  const owned = new Set();
  const raw = { unknown: 0, duplicated: 0 };
  for (const s of planSteps) {
    for (const a of s.hunkAliases) {
      if (!ctx.byAlias.has(a)) raw.unknown++;
      else if (owned.has(a)) raw.duplicated++;
      else owned.add(a);
    }
  }
  owned.clear();
  for (const s of planSteps) {
    s.hunkAliases = s.hunkAliases.filter((a) => ctx.byAlias.has(a) && !owned.has(a));
    s.hunkAliases.forEach((a) => owned.add(a));
  }
  const missing = ctx.hunks.filter((h) => !owned.has(h.alias));
  m.rawPlanIssues = { ...raw, missing: missing.length };
  if (!missing.length) return;
  const t = Date.now();
  const prompt = [
    'These review steps were planned for a PR:',
    planSteps.map((s, i) => i + 1 + '. [' + s.kind + '] ' + s.title + ': ' + s.summary + ' Files: ' + [...new Set(s.hunkAliases.map((a) => ctx.byAlias.get(a).path))].join(', ')).join('\n'),
    '',
    'These hunks were not placed in any step:',
    missing.map((h) => hunkBlock(h, { maxLines: 40 })).join('\n\n'),
    '',
    'For each hunk id, return the number of the step it belongs to. Return JSON.',
  ].join('\n');
  try {
    const { value } = await jsonCall({ label: 'repair', messages: sys(prompt), thinking: 'none', schema: placementSchema, maxTokens: 2000, priority: 0 }, () => null, { calls });
    for (const p of value.placements || []) {
      const s = planSteps[p.step - 1];
      if (s && ctx.byAlias.has(p.hunk) && !owned.has(p.hunk)) {
        s.hunkAliases.push(p.hunk);
        owned.add(p.hunk);
      }
    }
  } catch (e) {
    m.repairError = String(e.message);
  }
  m.repairMs = Date.now() - t;
}

async function fanout(ctx, cfg, { story, calls, m, at, mark, write, stepReady, get, set }) {
  if (cfg.context === 'prefetch' && ctx.repoDir) warmContext(ctx.repoDir, ctx.pr.headSha, ctx.hunks).catch(() => {});
  let repo = null;
  if (cfg.context === 'v2') {
    if (!ctx.mirrorDir || !ctx.pr.baseSha) throw new Error('context v2 needs ctx.mirrorDir and ctx.pr.baseSha (use attachMirror)');
    const rc = new RepoContext({ dir: ctx.mirrorDir, headSha: ctx.pr.headSha, baseSha: ctx.pr.baseSha, hunks: ctx.hunks, diffPaths: ctx.diffPaths });
    repo = { rc, ready: rc.warm().then(() => (m.contextWarm = { ...rc.stats, doneAtMs: at() })).catch((e) => (m.contextWarmError = String(e.message))) };
  }
  const summaryP = jsonCall({ label: 'summary', messages: sys(summaryPrompt(ctx)), thinking: cfg.side, schema: summarySchema, maxTokens: 8000, priority: 1 }, () => null, { calls })
    .then(({ value, attempts }) => {
      m.jsonRetries += attempts - 1;
      const { openQuestions, ...summary } = value;
      story.summary = summary;
      story.openQuestions = openQuestions || [];
      m.summaryMs = at();
      mark('summary');
      write();
    })
    .catch((e) => {
      m.jsonFailures++;
      m.summaryError = String(e.message);
    });

  const dispatched = new Map();
  const workerPromises = [];
  const claimed = new Set();
  let streamedSteps = [];
  const dispatch = (s, steps, planIncomplete) => {
    const snapshot = [...s.hunkAliases].sort();
    const p = (async () => {
      try {
        const value = await workerCall(ctx, cfg, steps, steps.indexOf(s), { calls, m, planIncomplete, repo });
        applyWorker(s, value, ctx);
        stepReady(s);
      } catch (e) {
        s.status = 'failed';
        s.error = String(e.message);
        m.workerFailures++;
      }
      write();
    })();
    dispatched.set(s, { snapshot, p });
    workerPromises.push(p);
  };

  const scanner = cfg.streamDispatch
    ? new TopLevelScanner({
        onItem: (key, raw) => {
          if (key !== 'steps') return;
          const s = planStepFrom(raw, ctx);
          s.hunkAliases = s.hunkAliases.filter((a) => ctx.byAlias.has(a) && !claimed.has(a));
          s.hunkAliases.forEach((a) => claimed.add(a));
          streamedSteps.push(s);
          if (streamedSteps.length === 1) s.firstStreamed = true;
          if (streamedSteps.length === 1) mark('first-plan-step-streamed');
          if (s.hunkAliases.length) dispatch(s, streamedSteps, true);
        },
      })
    : null;

  let plan;
  try {
    plan = await jsonCall(
      { label: 'planner', messages: sys(plannerPrompt(ctx)), thinking: cfg.planner, schema: planSchema, maxTokens: 24000, timeoutMs: 300000, priority: 0, onContent: scanner ? (c) => scanner.feed(c) : undefined },
      (v) => (Array.isArray(v.steps) && v.steps.length ? null : 'steps is empty'),
      { calls }
    );
  } catch (e) {
    m.jsonFailures++;
    throw new Error('planner failed: ' + e.message);
  }
  m.jsonRetries += plan.attempts - 1;

  let planSteps;
  if (scanner && streamedSteps.length === plan.value.steps.length && plan.attempts === 1) {
    planSteps = streamedSteps;
  } else {
    planSteps = plan.value.steps.map((raw) => planStepFrom(raw, ctx));
  }
  if (cfg.repairCall !== false) await placeMissing(ctx, planSteps, { calls, m });
  const { steps: fixed, issues } = enforceCoverage(planSteps, ctx.hunks);
  m.coverageRepairs = issues;
  m.coverageIssueCount = issues.unknown.length + issues.duplicated.length + issues.missing.length;
  set(fixed);
  m.planMs = at();
  mark('plan', { steps: fixed.length });
  story.generation.status = 'explaining';
  write();

  if (cfg.context === 'prefetch' && ctx.repoDir) {
    const t = Date.now();
    await Promise.all(
      fixed.map(async (s, i) => {
        if (dispatched.has(s)) return;
        const c = await prefetchContext(ctx.repoDir, ctx.pr.headSha, s.hunkAliases.map((a) => ctx.byAlias.get(a)), { diffPaths: ctx.diffPaths, maxChars: cfg.contextChars || 24000 });
        s.contextText = c.text;
        (m.prefetch ||= []).push({ step: i + 1, chars: c.chars, symbols: c.symbols });
      })
    );
    m.prefetchAllMs = Date.now() - t;
  }
  for (const s of fixed) {
    const d = dispatched.get(s);
    if (!d) dispatch(s, fixed, false);
    else if (d.snapshot.join() !== [...s.hunkAliases].sort().join()) {
      m.redispatched++;
      if (s.status !== 'ready') s.status = 'pending';
      dispatch(s, fixed, false);
    }
  }

  await Promise.all([summaryP, ...workerPromises]);
  let pending = workerPromises.length;
  while (workerPromises.length > pending || pending === 0) {
    pending = workerPromises.length;
    await Promise.all(workerPromises);
    if (pending === workerPromises.length) break;
  }
  m.workersDoneMs = at();
  mark('workers-done');
}
