import { changedLines, fileRole, hunkBlock, planSize, stepRange } from './diff.js';
import { diagramRules, fill, gistRules, section } from './settings.js';

const style = () => section('style');
const reviewOrder = () => section('reviewOrder');

export const systemPrompt = () => section('system');

export function prHeader(ctx, { bodyChars = 4000 } = {}) {
  const m = ctx.meta;
  const body = (m.body || '').replace(/<!--[\s\S]*?-->/g, '').replace(/\r/g, '').trim();
  return [
    '# PR ' + ctx.pr.repo + '#' + m.number + ': ' + m.title,
    'Author: ' + ctx.pr.author + '. Base: ' + m.baseRefName + '. Head: ' + m.headRefName + '.',
    '',
    '## PR description',
    body.slice(0, bodyChars) || '(empty)',
  ].join('\n');
}

export function fileIndex(ctx) {
  return ctx.files
    .map((f) => {
      const hs = f.hunks.map((h) => h.alias);
      const range = hs.length > 1 ? hs[0] + '-' + hs.at(-1) : hs[0];
      const role = f.fileRole || fileRole(f);
      const n = f.hunks.reduce((sum, h) => sum + changedLines(h), 0);
      const counted = role === 'test' || role === 'generated' ? 'not counted' : n + ' changed lines';
      return f.alias + ' ' + f.path + ' (' + role + ', ' + f.status + ', ' + counted + ', +' + f.additions + '/-' + f.deletions + ', hunks ' + range + ')';
    })
    .join('\n');
}

export function diffBlock(ctx, { numbered = false, maxLines = 400 } = {}) {
  return ctx.hunks.map((h) => hunkBlock(h, { numbered, maxLines })).join('\n\n');
}

export function plannerPrompt(ctx, opts = {}) {
  const n = ctx.hunks.length;
  const size = opts.size ?? planSize(ctx.files);
  const range = opts.range || stepRange(size);
  return [
    prHeader(ctx),
    '',
    '## Files',
    fileIndex(ctx),
    '',
    '## Diff (each hunk is labelled with its id in brackets)',
    diffBlock(ctx, { maxLines: 120 }),
    '',
    fill(section('plannerTask'), {
      n,
      size,
      rangeMin: range[0],
      rangeMax: range[1],
      perStepLow: Math.round(size / range[1]),
      perStepHigh: Math.round(size / range[0]),
      style: style(),
      reviewOrder: reviewOrder(),
    }),
  ].join('\n');
}

export function summaryPrompt(ctx) {
  return [
    prHeader(ctx),
    '',
    '## Files',
    fileIndex(ctx),
    '',
    '## Diff',
    diffBlock(ctx, { maxLines: 80 }),
    '',
    fill(section('summaryTask'), { style: style() }),
  ].join('\n');
}

function planList(steps, currentIndex) {
  return steps
    .map((s, i) => (i === currentIndex ? '> ' : '  ') + (i + 1) + '. [' + s.kind + '] ' + s.title + ': ' + s.summary)
    .join('\n');
}

function workerTask(mode) {
  return fill(section('workerTask'), {
    style: style(),
    gistRules: gistRules(),
    inlineGist: mode === 'inline' ? section('inlineGist') : '',
    diagramRules: diagramRules(),
    hunkNotesRules: section('hunkNotesRules'),
  })
    .split('\n')
    .filter((l) => l.trim() !== '')
    .join('\n');
}

export function gistReviewPrompt(gist, hunks) {
  return [
    '## The current gist',
    gist,
    '',
    '## The code this step changes',
    hunks.map((h) => hunkBlock(h, { maxLines: 200 })).join('\n\n'),
    '',
    '## Task',
    'A reader who has seen nothing else must be able to place this step and understand it. Read the code and the current gist. Return JSON.',
    style(),
    gistRules(),
    'missing: the facts a reader who has seen nothing else would immediately ask about and that the gist leaves vague or out. Name the concrete kind, value or count the code defines. Example: "which kinds?", "how many?", "where does it run?". Return an empty list when the gist already names them.',
    'gist: the final gist, with every missing fact fixed inside the limits. Keep the parts that are already right. When nothing is missing, return the current gist unchanged.',
  ].join('\n');
}

export function gistFixMessage(violations) {
  return (
    'The gist breaks these rules: ' + violations.join('; ') + '. ' +
    'Rewrite it as at most 55 words in 2-3 sentences of at most 20 words each, with no em dash, no colon followed by a space, no arrow, no question mark, at most one bold phrase and at most one backticked name. ' +
    'Cut words instead of adding any. Keep the facts that are already right and keep the concrete kinds, values and counts. Reply with the complete JSON object.'
  );
}

export function diagramFixMessage(problems) {
  return (
    'The diagram breaks these rules: ' + problems.join('; ') + '. ' +
    'Give each branch of a decision its own node. When a branch does nothing, add an explicit step node in plain words, for example "use the runner as it is", "skip it" or "nothing happens", and let both branches continue to the next node. ' +
    'Never draw an edge that skips a column: every forward edge goes from column L to exactly column L+1. Merging two branches into one node in the next column is fine. ' +
    'Use an edge back to an earlier node only for real repetition such as a retry or a loop cap. Reply with the corrected diagram as JSON.'
  );
}

const CONTEXT_TITLES = {
  v1: '## Repository context at the PR head (read-only, not part of the diff)',
  v2: '## Repository context (read-only, not part of the diff): the old version of changed code at the base commit, code that uses the changed symbols, and code the changed functions call',
};

export function workerPrompt(ctx, steps, index, { contextText, contextKind = 'v1', functionsText = '', planIncomplete = false, toolsAvailable = false, gistMode = 'none' } = {}) {
  const step = steps[index];
  const hunks = step.hunkAliases.map((a) => ctx.byAlias.get(a));
  const testHunks = hunks.filter((h) => h.fileRole === 'test').map((h) => h.alias);
  const newTestFiles = hunks.filter((h) => h.fileRole === 'test' && h.fileStatus === 'added').map((h) => h.alias);
  return [
    prHeader(ctx, { bodyChars: 2500 }),
    '',
    '## Your step: ' + (index + 1) + '. ' + step.title,
    step.summary,
    '',
    '## Hunks in this step (left column = line number in the new file; removed lines have no number)',
    hunks.map((h) => hunkBlock(h, { numbered: true, maxLines: 500 })).join('\n\n'),
    functionsText
      ? '\n## Full function for the diagram\nThese are the full bodies, at the PR head, of the changed functions in this step that contain branches. A + before the code marks a line this PR changed. List every branch of these functions, including the ones this PR did not touch, and do not guess a branch from the hunks alone.\n' + functionsText
      : '',
    testHunks.length
      ? '\nSome hunks here come from test files: ' + testHunks.join(', ') + '.' + (newTestFiles.length ? ' Of those, these add a whole new test file: ' + newTestFiles.join(', ') + '.' : '') + ' Write a hunkNote only for one that adds or changes what a test case checks, and a new test file normally does. No note for imports, namespace requires, fixture keys, renames, or mock setup alone.'
      : '',
    contextText ? '\n' + CONTEXT_TITLES[contextKind] + '\n' + contextText : '',
    toolsAvailable
      ? '\nYou can call read_file and grep to read the repository at the PR head. Use them only when the hunks do not show enough: for example a caller, a type definition, or the code around a change. At most a few calls.'
      : '',
    '',
    workerTask(gistMode),
  ].join('\n');
}

export function singleShotPrompt(ctx, { contextText } = {}) {
  const n = ctx.hunks.length;
  return [
    prHeader(ctx),
    '',
    '## Files',
    fileIndex(ctx),
    '',
    '## Diff (each hunk is labelled with its id in brackets; left column = line number in the new file)',
    diffBlock(ctx, { numbered: true, maxLines: 400 }),
    contextText ? '\n## Repository context at the PR head (read-only, not part of the diff)\n' + contextText : '',
    '',
    '## Task',
    'Write a guided review story for this PR as JSON.',
    'summary: why (1-3 sentences), whatChanged (3-5 bullets, each max 12 words, at most one code name per bullet), risk (low/medium/high), riskReason, reviewMinutes.',
    'steps: group the ' + n + ' hunks into review steps. ' + reviewOrder(),
    'Every hunk id h1-h' + n + ' must be in exactly one step. Write "h3-h7" for a run of hunks or "f4" for a whole file.',
    'Each step: title (max 8 words), kind, summary (1-2 sentences), dependsOn (1-based step numbers), hunks, gist, diagram, hunkNotes.',
    gistRules(),
    diagramRules(),
  ].join('\n');
}
