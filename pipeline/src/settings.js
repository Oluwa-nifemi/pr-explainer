import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  DIAGRAM_LINES, GIST_LINES, HUNK_NOTES_LINES, INLINE_GIST_LINES, PLANNER_TASK_LINES, REVIEW_ORDER_LINES,
  STYLE_LINES, SUMMARY_TASK_LINES, SYSTEM_LINES, WORKER_TASK_LINES,
} from './prompt-defaults.js';

// Everything a user can change lives in one overrides file outside the repo.
// Defaults stay in code. A key that is missing from the file means "use the default".

function configDir() {
  if (process.platform === 'win32') return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
}

export function overridesPath() {
  return process.env.PRX_OVERRIDES || join(configDir(), 'pr-explainer', 'overrides.json');
}

// ---------- prompt blocks ----------

export const PROMPT_SECTIONS = [
  { id: 'system', title: 'System prompt', joiner: ' ', lines: SYSTEM_LINES, help: 'Sent first to every agent. Sets the voice and the word rules. One rule per line.' },
  { id: 'style', title: 'Style rules', joiner: ' ', lines: STYLE_LINES, help: 'A short reminder added to the task of every agent.' },
  { id: 'reviewOrder', title: 'Review order', joiner: ' ', lines: REVIEW_ORDER_LINES, help: 'How the planner orders the steps.' },
  { id: 'plannerTask', title: 'Planner task', joiner: '\n', lines: PLANNER_TASK_LINES, tokens: ['n', 'size', 'rangeMin', 'rangeMax', 'perStepLow', 'perStepHigh', 'style', 'reviewOrder'], help: 'What the planner is asked to do with the diff. It decides how many steps there are and what goes in each.' },
  { id: 'summaryTask', title: 'Summary task', joiner: '\n', lines: SUMMARY_TASK_LINES, tokens: ['style'], help: 'What the summary agent writes: the one-liner, why, the bullets and the risk.' },
  { id: 'workerTask', title: 'Worker task', joiner: '\n', lines: WORKER_TASK_LINES, tokens: ['style', 'gistRules', 'inlineGist', 'diagramRules', 'hunkNotesRules'], help: 'What each worker writes for its step. The tokens in double braces are filled in with the blocks below.' },
  { id: 'gistRules', title: 'Gist rules', joiner: ' ', lines: GIST_LINES, help: 'The short explanation at the top of each step.' },
  { id: 'diagramRules', title: 'Diagram rules', joiner: ' ', lines: DIAGRAM_LINES, help: 'When a step gets a flow diagram and how it is drawn.' },
  { id: 'hunkNotesRules', title: 'Test note rules', joiner: ' ', lines: HUNK_NOTES_LINES, help: 'When a test hunk gets a one-line note.' },
  { id: 'inlineGist', title: 'Draft and check fields', joiner: ' ', lines: INLINE_GIST_LINES, help: 'Extra instruction when a worker drafts the gist, checks it, then rewrites it.' },
];

const SECTION_BY_ID = new Map(PROMPT_SECTIONS.map((s) => [s.id, s]));

export const DIAGRAM_MODES = {
  default: { label: 'Default', line: '' },
  fewer: { label: 'Fewer', line: 'Be selective. Draw a diagram only when the branching is hard to follow from the code alone, and return null otherwise.' },
  more: { label: 'More', line: 'Draw a diagram for every step that has real branching, even when there is only one decision.' },
  off: { label: 'Off', line: 'Always return null for diagram.' },
};

const clean = (text) => String(text).replace(/\r/g, '');
const defaultText = (s) => s.lines.join('\n');

function textOf(s, raw) {
  const text = clean(raw);
  return s.joiner === ' ' ? text.split('\n').map((l) => l.trim()).filter(Boolean).join(' ') : text.replace(/\s+$/, '');
}

// ---------- file rules ----------

const rx = (r) => ({ pattern: r.source.replace(/\\\//g, '/'), flags: r.flags });
const escapeRe = (s) => s.replace(/[.*+?^$|()\[\]\\{}]/g, '\\$&');

const LOCK_NAMES = [
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'npm-shrinkwrap.json',
  'uv.lock', 'poetry.lock', 'Pipfile.lock', 'Cargo.lock', 'go.sum', 'Gemfile.lock',
  'composer.lock', 'flake.lock', 'deps.lock', 'mix.lock', 'pubspec.lock',
];

export const FILE_GROUPS = [
  {
    id: 'custom', kind: 'skip', reason: 'ignored', title: 'Your ignored files',
    help: 'Files that match are left out of the story completely. Add your own paths here.',
    rules: [],
  },
  {
    id: 'lockfile', kind: 'skip', reason: 'lockfile', title: 'Lockfiles',
    help: 'Dependency lock files change a lot and say little. They are left out.',
    rules: LOCK_NAMES.map((n) => ({ pattern: '(^|/)' + escapeRe(n) + '$', flags: '' })),
  },
  {
    id: 'snapshot', kind: 'skip', reason: 'snapshot', title: 'Snapshots',
    help: 'Test snapshots and database migration snapshots. They are left out.',
    rules: [/(^|\/)__snapshots__\//, /\.snap$/, /(^|\/)migrations\/meta\/[^/]+_snapshot\.json$/].map(rx),
  },
  {
    id: 'binary', kind: 'skip', reason: 'binary', title: 'Binary files',
    help: 'Images, fonts, archives and other files that are not text. They are left out.',
    rules: [rx(/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|eot|mp4|mov|wasm|jar)$/i)],
  },
  {
    id: 'generated', kind: 'skip', reason: 'generated', role: 'generated', title: 'Generated code',
    help: 'Build output and generated files. They are left out. A file that starts with an "@generated" or "DO NOT EDIT" marker is also treated as generated.',
    rules: [
      /(^|\/)(dist|build|out|vendor|node_modules|__generated__|generated)\//,
      /\.min\.(js|css)$/, /\.map$/, /\.generated\.\w+$/, /\.g\.dart$/, /_pb2(_grpc)?\.pyi?$/, /\.pb\.go$/,
      /(^|\/)gen\//,
    ].map(rx),
  },
  {
    id: 'test', kind: 'role', role: 'test', title: 'Test files',
    help: 'Tests are shown in a closing section and do not count toward the size of a step.',
    rules: [
      /(^|\/)(test|tests|__tests__|__mocks__|spec|specs|e2e|cypress)\//i,
      /\.(test|spec)\.[^/]+$/i,
      /(^|\/)test_[^/]+\.py$/i,
      /_test\.(py|go|rb|exs)$/i,
      /(^|\/)conftest\.py$/i,
      /(Tests?)\.(java|kt|cs|swift)$/,
    ].map(rx),
  },
  {
    id: 'config', kind: 'role', role: 'config', title: 'Config files',
    help: 'Project and tool configuration. It is explained together with the code it configures.',
    rules: [
      /(^|\/)(package\.json|tsconfig[^/]*\.json|jsconfig[^/]*\.json|Dockerfile[^/]*|Makefile|Procfile|\.env[^/]*|requirements[^/]*\.txt|\.npmrc|\.nvmrc|\.editorconfig|\.gitignore|\.dockerignore|\.prettierrc[^/]*|\.eslintrc[^/]*)$/i,
      /\.(toml|ya?ml|ini|cfg|conf|json)$/i,
      /(^|\/)\.github\//,
      /(vite|webpack|rollup|babel|jest|vitest|esbuild|metro|tailwind|postcss|playwright)\.config\.[^/]+$/i,
    ].map(rx),
  },
  {
    id: 'docs', kind: 'role', role: 'docs', title: 'Docs',
    help: 'Documentation, including agent instructions and skill files that end in .md. Shown in the closing section.',
    rules: [/\.(md|mdx|rst|adoc|txt)$/i, /(^|\/)docs?\//i].map(rx),
  },
];

const GROUP_BY_ID = new Map(FILE_GROUPS.map((g) => [g.id, g]));
export const HIDEABLE_ROLES = ['test', 'config', 'docs'];
export const DEFAULT_MAX_FILE_LINES = 3000;
const ruleId = (r) => r.pattern + '/' + (r.flags || '');

export function globToRegExp(glob) {
  const g = String(glob).trim().replace(/^\.?\//, '');
  let out = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      out += '.*';
      i++;
      if (g[i + 1] === '/') i++;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += escapeRe(c);
  }
  return new RegExp((g.includes('/') ? '^' : '(^|/)') + out + '$');
}

function addedToRegExp(a) {
  return a.kind === 'glob' ? globToRegExp(a.value) : new RegExp(a.value, a.flags || '');
}

// ---------- overrides ----------

let overrides = {};
let cache = null;

function bad(msg) {
  const e = new Error(msg);
  e.code = 'bad_overrides';
  return e;
}

export function sanitize(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;

  const prompts = {};
  for (const s of PROMPT_SECTIONS) {
    const v = raw.prompts?.[s.id];
    if (typeof v !== 'string' || !v.trim()) continue;
    if (textOf(s, v) === textOf(s, defaultText(s))) continue;
    prompts[s.id] = clean(v);
  }
  if (Object.keys(prompts).length) out.prompts = prompts;

  const mode = raw.diagrams?.mode;
  if (mode !== undefined && mode !== 'default') {
    if (!DIAGRAM_MODES[mode]) throw bad('unknown diagram mode "' + mode + '"');
    out.diagrams = { mode };
  }

  const files = {};
  const groups = {};
  for (const g of FILE_GROUPS) {
    const src = raw.files?.groups?.[g.id];
    if (!src) continue;
    const known = new Set(g.rules.map(ruleId));
    const disabled = (Array.isArray(src.disabled) ? src.disabled : []).filter((id) => known.has(id));
    const added = [];
    for (const a of Array.isArray(src.added) ? src.added : []) {
      const value = typeof a?.value === 'string' ? a.value.trim() : '';
      if (!value) continue;
      const entry = { kind: a.kind === 'regex' ? 'regex' : 'glob', value, ...(a.kind === 'regex' && a.flags ? { flags: String(a.flags).replace(/[^gimsuy]/g, '') } : {}) };
      try {
        addedToRegExp(entry);
      } catch (e) {
        throw bad('"' + value + '" is not a valid ' + entry.kind + ': ' + e.message);
      }
      added.push(entry);
    }
    if (disabled.length || added.length) groups[g.id] = { ...(disabled.length ? { disabled } : {}), ...(added.length ? { added } : {}) };
  }
  if (Object.keys(groups).length) files.groups = groups;
  const hide = (Array.isArray(raw.files?.hideRoles) ? raw.files.hideRoles : []).filter((r) => HIDEABLE_ROLES.includes(r));
  if (hide.length) files.hideRoles = [...new Set(hide)];
  const max = Number(raw.files?.limits?.maxFileChangedLines);
  if (Number.isInteger(max) && max > 0 && max !== DEFAULT_MAX_FILE_LINES) files.limits = { maxFileChangedLines: max };
  if (Object.keys(files).length) out.files = files;
  return out;
}

function readFile() {
  try {
    return sanitize(JSON.parse(readFileSync(overridesPath(), 'utf8')));
  } catch {
    return {};
  }
}

export function getOverrides() {
  return overrides;
}

export function setOverrides(raw) {
  overrides = sanitize(raw);
  cache = null;
  return overrides;
}

export function saveOverrides(raw) {
  const next = sanitize(raw);
  const file = overridesPath();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  renameSync(tmp, file);
  overrides = next;
  cache = null;
  return next;
}

export function reloadOverrides() {
  overrides = readFile();
  cache = null;
}

reloadOverrides();

export function overridesHash() {
  if (!Object.keys(overrides).length) return '';
  return createHash('sha1').update(JSON.stringify(overrides)).digest('hex').slice(0, 12);
}

// ---------- reading the effective settings ----------

function compiled() {
  if (cache) return cache;
  const groups = {};
  for (const g of FILE_GROUPS) {
    const o = overrides.files?.groups?.[g.id] || {};
    const off = new Set(o.disabled || []);
    const list = g.rules.filter((r) => !off.has(ruleId(r))).map((r) => new RegExp(r.pattern, r.flags));
    for (const a of o.added || []) list.push(addedToRegExp(a));
    groups[g.id] = list;
  }
  cache = {
    groups,
    hideRoles: new Set(overrides.files?.hideRoles || []),
    maxFileChangedLines: overrides.files?.limits?.maxFileChangedLines || DEFAULT_MAX_FILE_LINES,
    sections: new Map(),
  };
  return cache;
}

export const fileRegexes = (groupId) => compiled().groups[groupId] || [];
export const hiddenRoles = () => compiled().hideRoles;
export const maxFileChangedLines = () => compiled().maxFileChangedLines;

export function section(id) {
  const s = SECTION_BY_ID.get(id);
  if (!s) throw new Error('unknown prompt block ' + id);
  const c = compiled();
  if (!c.sections.has(id)) {
    const o = overrides.prompts?.[id];
    c.sections.set(id, o !== undefined ? textOf(s, o) : s.lines.join(s.joiner));
  }
  return c.sections.get(id);
}

export function diagramRules() {
  const line = DIAGRAM_MODES[overrides.diagrams?.mode || 'default'].line;
  return section('diagramRules') + (line ? ' ' + line : '');
}

export const gistRules = () => section('gistRules');

export function fill(template, vars) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
}

// ---------- what the settings page shows ----------

export function describeSettings() {
  return {
    path: overridesPath(),
    customised: Object.keys(overrides).length > 0,
    prompts: PROMPT_SECTIONS.map((s) => ({
      id: s.id,
      title: s.title,
      help: s.help,
      joiner: s.joiner,
      tokens: s.tokens || [],
      default: defaultText(s),
      value: overrides.prompts?.[s.id] ?? null,
    })),
    diagrams: { mode: overrides.diagrams?.mode || 'default', modes: Object.entries(DIAGRAM_MODES).map(([id, m]) => ({ id, label: m.label, line: m.line })) },
    files: {
      groups: FILE_GROUPS.map((g) => {
        const o = overrides.files?.groups?.[g.id] || {};
        const off = new Set(o.disabled || []);
        return {
          id: g.id,
          kind: g.kind,
          role: g.role || null,
          reason: g.reason || null,
          title: g.title,
          help: g.help,
          rules: g.rules.map((r) => ({ id: ruleId(r), pattern: r.pattern, flags: r.flags, enabled: !off.has(ruleId(r)) })),
          added: o.added || [],
        };
      }),
      hideRoles: overrides.files?.hideRoles || [],
      hideable: HIDEABLE_ROLES,
      limits: { maxFileChangedLines: { default: DEFAULT_MAX_FILE_LINES, value: overrides.files?.limits?.maxFileChangedLines ?? null } },
    },
    overrides,
  };
}

