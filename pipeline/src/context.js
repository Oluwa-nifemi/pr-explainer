import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function git(repoDir, args) {
  try {
    const { stdout } = await run('git', ['-C', repoDir, ...args], { maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    if (e.code === 1 && args[0] === 'grep') return '';
    throw e;
  }
}

const fileCache = new Map();
export async function showFile(repoDir, sha, path) {
  const key = repoDir + '|' + sha + '|' + path;
  if (!fileCache.has(key)) fileCache.set(key, git(repoDir, ['show', sha + ':' + path]).then((t) => t.split('\n'), () => null));
  return fileCache.get(key);
}

const grepCache = new Map();
function grepSymbol(repoDir, sha, name) {
  const key = repoDir + '|' + sha + '|' + name;
  if (!grepCache.has(key)) grepCache.set(key, git(repoDir, ['grep', '-n', '-w', '-I', '--max-count=3', name, sha, '--', '.', ':!*.lock', ':!*lock.json', ':!*.snap']).catch(() => ''));
  return grepCache.get(key);
}

export async function warmContext(repoDir, sha, hunks) {
  const paths = [...new Set(hunks.filter((h) => h.fileStatus !== 'added' && h.fileStatus !== 'removed').map((h) => h.path))];
  const names = changedSymbols(hunks).map((s) => s.name);
  await Promise.all([...paths.map((p) => showFile(repoDir, sha, p)), ...names.map((n) => grepSymbol(repoDir, sha, n))]);
}

function numbered(lines, from, to) {
  const out = [];
  for (let i = from; i <= to && i <= lines.length; i++) out.push(String(i).padStart(5) + '  ' + lines[i - 1]);
  return out.join('\n');
}

const DEF_PATTERNS = [
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/,
  /^\s*class\s+([A-Za-z_]\w*)/,
  /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^([A-Z][A-Z0-9_]{2,})\s*[:=]/,
  /^([A-Za-z_]\w*)\s*(?::\s*[^=]+)?=\s*/,
];

export function changedSymbols(hunks) {
  const seen = new Map();
  for (const h of hunks) {
    for (const l of h.lines.slice(1)) {
      if (!(l.startsWith('+') || l.startsWith('-'))) continue;
      const code = l.slice(1);
      for (const re of DEF_PATTERNS) {
        const m = code.match(re);
        if (m && m[1].length > 3 && !['self', 'this', 'props', 'const', 'export', 'return', 'default'].includes(m[1])) {
          if (!seen.has(m[1])) seen.set(m[1], h.path);
          break;
        }
      }
    }
    const hm = h.header.match(/(?:def|class|function|const)\s+([A-Za-z_$][\w$]*)/);
    if (hm && !seen.has(hm[1])) seen.set(hm[1], h.path);
  }
  return [...seen].map(([name, path]) => ({ name, path }));
}

export async function prefetchContext(repoDir, sha, hunks, { diffPaths, maxChars = 24000, maxSymbols = 10, hitsPerSymbol = 6 } = {}) {
  const parts = [];
  const byFile = new Map();
  for (const h of hunks) {
    if (h.fileStatus === 'added' || h.fileStatus === 'removed') continue;
    if (!byFile.has(h.path)) byFile.set(h.path, []);
    byFile.get(h.path).push(h);
  }
  for (const [path, hs] of byFile) {
    const lines = await showFile(repoDir, sha, path);
    if (!lines) continue;
    const ranges = [];
    for (const h of hs) {
      const from = Math.max(1, h.newStart - 25);
      const to = Math.min(lines.length, h.newStart + h.newLines + 25);
      const last = ranges.at(-1);
      if (last && from <= last[1] + 5) last[1] = Math.max(last[1], to);
      else ranges.push([from, to]);
    }
    const header = lines.slice(0, 40).findIndex((l) => /^(import|from|const .* = require)/.test(l)) >= 0 ? numbered(lines, 1, Math.min(lines.length, 30)) : null;
    const body = ranges.map(([a, b]) => numbered(lines, a, b)).join('\n   ...\n');
    parts.push('### ' + path + ' around the changes (' + lines.length + ' lines total)\n' + (header && ranges[0][0] > 31 ? header + '\n   ...\n' : '') + body);
  }
  const symbols = changedSymbols(hunks).slice(0, maxSymbols * 2);
  const usages = [];
  const unused = [];
  for (const { name } of symbols) {
    if (usages.length + unused.length >= maxSymbols) break;
    const out = await grepSymbol(repoDir, sha, name);
    const hits = out.split('\n').filter(Boolean).map((l) => l.slice(sha.length + 1)).filter((l) => !diffPaths?.has(l.split(':')[0]));
    if (!hits.length) {
      unused.push(name);
      continue;
    }
    if (hits.length > 40) continue;
    usages.push('- ' + name + ' is used outside this PR in:\n' + hits.slice(0, hitsPerSymbol).map((l) => '    ' + l.slice(0, 200)).join('\n') + (hits.length > hitsPerSymbol ? '\n    (+' + (hits.length - hitsPerSymbol) + ' more)' : ''));
  }
  const refs = [];
  if (usages.length) refs.push('### Usages of changed symbols in files outside this PR\n' + usages.join('\n'));
  if (unused.length) refs.push('### Changed symbols with no reference in any file outside this PR (git grep -w at the PR head)\n' + unused.join(', '));
  parts.unshift(...refs);
  let text = parts.join('\n\n');
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n... [context truncated]';
  return { text, symbols: symbols.map((s) => s.name), chars: text.length };
}

export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read lines of a file in the repository at the PR head commit. Returns numbered lines. Max 200 lines per call.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repository-relative path' },
          startLine: { type: 'integer', description: '1-based first line' },
          endLine: { type: 'integer', description: 'Last line (inclusive)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search the repository at the PR head commit with a regular expression (git grep -E). Returns up to 40 matching lines as path:line:text.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: 'Optional directory or glob to limit the search' },
        },
        required: ['pattern'],
      },
    },
  },
];

export async function runTool(repoDir, sha, name, args) {
  if (name === 'read_file') {
    const lines = await showFile(repoDir, sha, String(args.path || '').replace(/^\/+/, ''));
    if (!lines) return 'error: file not found at PR head: ' + args.path;
    const from = Math.max(1, args.startLine || 1);
    const to = Math.min(lines.length, args.endLine || from + 199, from + 199);
    return numbered(lines, from, to) + (to < lines.length ? '\n(file has ' + lines.length + ' lines)' : '');
  }
  if (name === 'grep') {
    const spec = args.path ? [args.path] : ['.'];
    let out;
    try {
      out = await git(repoDir, ['grep', '-n', '-I', '-E', '--max-count=5', String(args.pattern || ''), sha, '--', ...spec, ':!*.lock', ':!*lock.json']);
    } catch (e) {
      return 'error: ' + String(e.message).slice(0, 200);
    }
    const hits = out.split('\n').filter(Boolean).map((l) => l.slice(sha.length + 1).slice(0, 220));
    if (!hits.length) return 'no matches';
    return hits.slice(0, 40).join('\n') + (hits.length > 40 ? '\n(+' + (hits.length - 40) + ' more)' : '');
  }
  return 'error: unknown tool ' + name;
}
