import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { Parser, Language } from 'web-tree-sitter';

const run = promisify(execFile);
const req = createRequire(import.meta.url);

const LANG_BY_EXT = { py: 'python', ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript' };
const DEF_TYPES = new Set([
  'function_definition', 'class_definition',
  'function_declaration', 'generator_function_declaration', 'class_declaration', 'abstract_class_declaration',
  'method_definition', 'interface_declaration', 'type_alias_declaration', 'enum_declaration',
]);
const FN_VALUES = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);
const WRAPPERS = new Set(['decorated_definition', 'export_statement', 'lexical_declaration', 'variable_declaration', 'expression_statement']);
const SKIP_NAMES = new Set(('print len str int float bool dict list set tuple isinstance getattr setattr hasattr super range enumerate zip map filter sorted any all min max open format ' +
  'append extend get items keys values update pop join split strip push slice then catch log error warn info debug toString parse stringify Object Array Promise resolve reject ' +
  'forEach find some every includes concat reduce assign entries from useState useEffect useMemo useCallback useRef useContext useLayoutEffect createElement Error Boolean Number String ' +
  'Date Math Set Map setTimeout clearTimeout addEventListener removeEventListener preventDefault stopPropagation describe expect test it beforeEach afterEach mock fn model_dump ' +
  'model_validate Field field dataclass property staticmethod classmethod abstractmethod cast type next iter self cls this props require').split(' '));

let initP = null;
const langs = new Map();
async function parserFor(path) {
  const lang = LANG_BY_EXT[path.split('.').pop()];
  if (!lang) return null;
  initP ||= Parser.init();
  await initP;
  if (!langs.has(lang)) langs.set(lang, Language.load(req.resolve('tree-sitter-wasms/out/tree-sitter-' + lang + '.wasm')));
  const p = new Parser();
  p.setLanguage(await langs.get(lang));
  return p;
}

async function git(dir, args) {
  try {
    const { stdout } = await run('git', ['-C', dir, ...args], { maxBuffer: 256 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    if (e.code === 1 && args[0] === 'grep') return '';
    throw e;
  }
}

function memo(map, key, fn) {
  if (!map.has(key)) map.set(key, fn());
  return map.get(key);
}

function nameOf(node) {
  const n = node.childForFieldName('name');
  return n ? n.text : null;
}

function collectDefs(root) {
  const defs = [];
  const walk = (node, parentDef) => {
    let def = null;
    if (DEF_TYPES.has(node.type)) def = { name: nameOf(node), node };
    else if (node.type === 'variable_declarator') {
      const value = node.childForFieldName('value');
      if (value && (FN_VALUES.has(value.type) || !parentDef)) def = { name: nameOf(node), node };
    } else if (node.type === 'assignment' && node.parent?.type === 'expression_statement' && node.parent.parent?.type === 'module') {
      const left = node.childForFieldName('left');
      if (left?.type === 'identifier') def = { name: left.text, node };
    } else if (node.type === 'public_field_definition' || node.type === 'field_definition') {
      const value = node.childForFieldName('value');
      if (value && FN_VALUES.has(value.type)) def = { name: nameOf(node) || node.childForFieldName('property')?.text, node };
    }
    if (def && def.name) {
      let outer = def.node;
      while (outer.parent && WRAPPERS.has(outer.parent.type)) outer = outer.parent;
      def.start = outer.startPosition.row + 1;
      def.end = outer.endPosition.row + 1;
      def.kind = node.type;
      def.parent = parentDef;
      defs.push(def);
    }
    for (const c of node.namedChildren) walk(c, def && def.name ? def : parentDef);
  };
  walk(root, null);
  return defs;
}

function innermost(defs, line) {
  let best = null;
  for (const d of defs) if (d.start <= line && line <= d.end && (!best || d.end - d.start < best.end - best.start)) best = d;
  return best;
}

function calleeNames(node) {
  const out = new Map();
  const walk = (n) => {
    if (n.type === 'call' || n.type === 'call_expression' || n.type === 'new_expression') {
      let f = n.childForFieldName('function') || n.childForFieldName('constructor');
      let member = false;
      if (f?.type === 'attribute') (f = f.childForFieldName('attribute')), (member = true);
      else if (f?.type === 'member_expression') (f = f.childForFieldName('property')), (member = true);
      if (f && /^[A-Za-z_$][\w$]*$/.test(f.text) && !(out.has(f.text) && !out.get(f.text))) out.set(f.text, member);
    } else if (n.type === 'jsx_opening_element' || n.type === 'jsx_self_closing_element') {
      const nm = n.childForFieldName('name');
      if (nm && /^[A-Z]/.test(nm.text) && !nm.text.includes('.')) out.set(nm.text, false);
    }
    for (const c of n.namedChildren) walk(c);
  };
  walk(node);
  return [...out].filter(([x]) => x.length > 3 && !SKIP_NAMES.has(x)).map(([name, member]) => ({ name, member }));
}

function numbered(lines, from, to) {
  const out = [];
  for (let i = from; i <= to && i <= lines.length; i++) out.push(String(i).padStart(5) + '  ' + lines[i - 1]);
  return out.join('\n');
}

function clip(lines, from, to, maxLines, focus) {
  if (to - from + 1 <= maxLines) return numbered(lines, from, to);
  if (focus) {
    const a = Math.max(from, Math.min(focus - Math.floor(maxLines / 2), to - maxLines + 1));
    const head = a > from ? numbered(lines, from, from) + '\n   ...\n' : '';
    const b = a + maxLines - 1;
    return head + numbered(lines, a, b) + (b < to ? '\n   ...\n' + numbered(lines, to, to) : '');
  }
  const h = Math.floor(maxLines * 0.75);
  return numbered(lines, from, from + h - 1) + '\n   ... [' + (to - from + 1 - maxLines) + ' lines omitted] ...\n' + numbered(lines, to - (maxLines - h) + 1, to);
}

const BRANCH_HEAD = /^\s*(if|elif|else|match|case|try|except|finally|for|while)\b/;

function hasBranches(lines, from, to) {
  let lastCode = from;
  for (let i = Math.min(to, lines.length); i >= from; i--) {
    if ((lines[i - 1] || '').trim()) {
      lastCode = i;
      break;
    }
  }
  for (let i = from; i <= to && i <= lines.length; i++) {
    const text = lines[i - 1] || '';
    if (BRANCH_HEAD.test(text)) return true;
    if (i < lastCode && /^\s*return\b/.test(text)) return true;
  }
  return false;
}

function markedLines(lines, from, to, changed, maxLines) {
  const emit = (a, b) => {
    const out = [];
    for (let i = a; i <= b && i <= lines.length; i++) out.push(String(i).padStart(5) + (changed.has(i) ? ' + ' : '   ') + (lines[i - 1] ?? ''));
    return out.join('\n');
  };
  if (to - from + 1 <= maxLines) return emit(from, to);
  const first = [...changed].filter((i) => i >= from && i <= to).sort((a, b) => a - b)[0] || from;
  const a = Math.max(from, Math.min(first - Math.floor(maxLines / 2), to - maxLines + 1));
  const b = a + maxLines - 1;
  return (a > from ? emit(from, from) + '\n   ...\n' : '') + emit(a, b) + (b < to ? '\n   ...\n' + emit(to, to) : '');
}

function oldSide(h) {
  const out = [];
  let no = h.oldStart;
  for (const l of h.lines.slice(1)) {
    if (l.startsWith('+') || l.startsWith('\\')) continue;
    out.push({ no: no++, text: l.slice(1), removed: l.startsWith('-') });
  }
  return out;
}

function newSide(h) {
  const out = [];
  let no = h.newStart;
  for (const l of h.lines.slice(1)) {
    if (l.startsWith('-') || l.startsWith('\\')) continue;
    out.push({ no: no++, text: l.slice(1), added: l.startsWith('+') });
  }
  return out;
}

function alignOffset(baseLines, side) {
  const probe = side.filter((x) => x.text.trim()).slice(0, 4);
  if (!probe.length) return 0;
  const matches = (off) => probe.every((p) => baseLines[p.no - 1 + off] === p.text);
  if (matches(0)) return 0;
  for (let d = 1; d < baseLines.length; d++) {
    if (matches(d)) return d;
    if (matches(-d)) return -d;
  }
  return null;
}

function proximity(a, b) {
  if (a === b) return 1000;
  const pa = a.split('/');
  const pb = b.split('/');
  let i = 0;
  while (i < pa.length - 1 && i < pb.length - 1 && pa[i] === pb[i]) i++;
  return i;
}

export class RepoContext {
  constructor({ dir, headSha, baseSha, hunks, diffPaths }) {
    Object.assign(this, { dir, headSha, baseSha, hunks, diffPaths });
    this.files = new Map();
    this.parsed = new Map();
    this.trees = new Map();
    this.greps = new Map();
    this.stats = { alignMisses: 0 };
  }

  lines(sha, path) {
    return memo(this.files, sha + ':' + path, () => git(this.dir, ['show', sha + ':' + path]).then((t) => t.split('\n'), () => null));
  }

  defs(sha, path) {
    return memo(this.parsed, sha + ':' + path, async () => {
      const lines = await this.lines(sha, path);
      const parser = lines && (await parserFor(path));
      if (!parser) return null;
      const tree = parser.parse(lines.join('\n'));
      const defs = collectDefs(tree.rootNode).map(({ node, parent, ...d }) => ({ ...d, parentName: parent?.name || null, callees: d.kind.includes('function') || d.kind.includes('method') || d.kind === 'variable_declarator' || d.kind.includes('field') ? calleeNames(node) : [] }));
      this.trees.set(sha + ':' + path, tree);
      parser.delete();
      return defs;
    });
  }

  isCodeRef(sha, path, line, text, name) {
    const tree = this.trees.get(sha + ':' + path);
    if (!tree) return false;
    const re = new RegExp('(^|[^A-Za-z0-9_$])' + name.replace(/[$]/g, '\\$') + '(?![A-Za-z0-9_$])', 'g');
    let m;
    while ((m = re.exec(text))) {
      const col = m.index + m[1].length;
      const node = tree.rootNode.descendantForPosition({ row: line - 1, column: col });
      if (node && /identifier$/.test(node.type)) return true;
    }
    return false;
  }

  async grepMany(names) {
    const todo = [...new Set(names)].filter((n) => n.length > 3 && !SKIP_NAMES.has(n) && !this.greps.has(n));
    if (!todo.length) return;
    const p = (async () => {
      const index = new Map(todo.map((n) => [n, []]));
      for (let i = 0; i < todo.length; i += 400) {
        const batch = todo.slice(i, i + 400);
        const pattern = '(?<![\\w$])(?:' + batch.map((n) => n.replace(/\$/g, '\\$')).join('|') + ')(?![\\w$])';
        let out = '';
        try {
          out = await git(this.dir, ['grep', '-n', '-I', '-P', pattern, this.headSha, '--', '.', ':!*.lock', ':!*lock.json', ':!*lock.yaml', ':!*.snap', ':!*.min.js', ':!*.map']);
        } catch {}
        for (const l of out.split('\n')) {
          const m = l.slice(this.headSha.length + 1).match(/^(.*?):(\d+):(.*)$/);
          if (!m) continue;
          const hit = { path: m[1], line: +m[2], text: m[3].slice(0, 400) };
          for (const w of new Set(hit.text.match(/[A-Za-z_$][\w$]*/g) || [])) index.get(w)?.push(hit);
        }
      }
      return index;
    })();
    for (const n of todo) this.greps.set(n, p.then((index) => index.get(n)));
    await p;
  }

  async hits(name) {
    if (!this.greps.has(name)) await this.grepMany([name]);
    return (await this.greps.get(name)) || [];
  }

  async hunkInfo(h) {
    return memo(this.hunkCache ||= new Map(), h.alias, async () => {
      const info = { before: [], after: [], symbols: new Map() };
      if (h.fileStatus !== 'added') {
        const oldPath = h.fileStatus === 'renamed' ? h.oldPath || h.path : h.path;
        const base = await this.lines(this.baseSha, oldPath);
        const defs = base && (await this.defs(this.baseSha, oldPath));
        if (base && defs) {
          const side = oldSide(h);
          let off = alignOffset(base, side);
          if (off === null) {
            this.stats.alignMisses++;
            off = 0;
          }
          const touched = side.filter((x) => x.removed).map((x) => x.no + off);
          if (!touched.length) touched.push(h.oldStart + off + Math.floor(h.oldLines / 2));
          for (const ln of touched) {
            const d = innermost(defs, ln);
            if (d) {
              info.before.push({ path: oldPath, def: d });
              if (h.lines.some((l) => l.startsWith('-') && l.includes(d.name))) info.symbols.set(d.name, { path: h.path, removed: true });
            }
          }
        }
      }
      if (h.fileStatus !== 'removed') {
        const defs = await this.defs(this.headSha, h.path);
        if (defs) {
          const touched = newSide(h).filter((x) => x.added).map((x) => x.no);
          for (const ln of touched) {
            const d = innermost(defs, ln);
            if (d) info.after.push({ path: h.path, def: d });
          }
        }
      }
      for (const b of info.before) if (!info.symbols.has(b.def.name)) info.symbols.set(b.def.name, { path: h.path });
      for (const a of info.after) info.symbols.set(a.def.name, { path: h.path });
      return info;
    });
  }

  async callers(name, path, ownDefs) {
    if (name.length <= 3 || SKIP_NAMES.has(name)) return { hits: [], tooMany: false, outside: 0 };
    const all = await this.hits(name);
    if (all.length > 80) return { hits: [], tooMany: true, outside: all.length };
    const hits = [...all].sort((a, b) => proximity(b.path, path) - proximity(a.path, path));
    const out = [];
    let outside = 0;
    let checked = 0;
    for (const hit of hits) {
      const isOutside = !this.diffPaths.has(hit.path);
      const isImportText = /^\s*(import\b|from\s+\S+\s+import\b|export\s+\{|export\s+\*|} from )/.test(hit.text);
      if (isImportText) {
        if (isOutside) outside++;
        out.push({ ...hit, enclosing: null, isImport: true, score: 0 });
        continue;
      }
      if (out.filter((x) => !x.isImport).length >= 6 && (outside > 0 || !isOutside)) continue;
      if (++checked > 20) break;
      const defs = await this.defs(this.headSha, hit.path);
      if (!this.isCodeRef(this.headSha, hit.path, hit.line, hit.text, name)) continue;
      if (isOutside) outside++;
      if (ownDefs.some((d) => d.path === hit.path && d.def.start <= hit.line && hit.line <= d.def.end)) continue;
      const enclosing = defs ? innermost(defs, hit.line) : null;
      if (enclosing && enclosing.name === name && hit.line - enclosing.start <= 5) continue;
      const isImport = !enclosing && /^\s*[\w$, ]+,?\s*$/.test(hit.text);
      out.push({ ...hit, enclosing, isImport, score: proximity(hit.path, path) + (isOutside ? 0.5 : 0) });
    }
    out.sort((a, b) => b.score - a.score);
    return { hits: out, tooMany: false, outside };
  }

  async definitionOf(name, nearPath, { sameFile = false } = {}) {
    if (SKIP_NAMES.has(name)) return null;
    if (sameFile) {
      const defs = await this.defs(this.headSha, nearPath);
      const d = defs?.find((x) => x.name === name);
      return d ? { path: nearPath, def: d } : null;
    }
    const defLine = new RegExp('(def|class|function\\*?|interface|type|enum|const|let|var)\\s+' + name.replace(/[$]/g, '\\$') + '(?![\\w$])');
    const hits = (await this.hits(name)).filter((h) => defLine.test(h.text));
    if (!hits.length || hits.length > 6) return null;
    const found = [];
    for (const hit of hits) {
      const defs = await this.defs(this.headSha, hit.path);
      const d = defs?.find((x) => x.name === name && x.start <= hit.line && hit.line <= x.start + 5);
      if (d && !found.some((f) => f.path === hit.path && f.def.start === d.start)) found.push({ path: hit.path, def: d });
    }
    if (!found.length || found.length > 3) return null;
    found.sort((a, b) => proximity(b.path, nearPath) - proximity(a.path, nearPath));
    return found[0];
  }

  async warm() {
    const t = Date.now();
    await Promise.all(this.hunks.map((h) => this.hunkInfo(h)));
    const names = new Set();
    for (const h of this.hunks) {
      const info = await this.hunkInfo(h);
      for (const [n] of info.symbols) names.add(n);
      for (const a of info.after) for (const c of a.def.callees || []) if (!c.member) names.add(c.name);
    }
    await this.grepMany([...names]);
    this.stats.warmGreps = names.size;
    this.stats.warmMs = Date.now() - t;
  }

  async functionBodies(hunks, { max = 3, maxLines = 120 } = {}) {
    const changed = new Map();
    for (const h of hunks) {
      if (!changed.has(h.path)) changed.set(h.path, new Set());
      for (const x of newSide(h)) if (x.added) changed.get(h.path).add(x.no);
    }
    const out = [];
    const seen = new Set();
    for (const h of hunks) {
      if (out.length >= max) break;
      const info = await this.hunkInfo(h);
      for (const a of info.after) {
        if (out.length >= max) break;
        const key = a.path + ':' + a.def.start;
        if (seen.has(key)) continue;
        const lines = await this.lines(this.headSha, a.path);
        if (!lines || !hasBranches(lines, a.def.start, a.def.end)) continue;
        seen.add(key);
        const name = (a.def.parentName ? a.def.parentName + '.' : '') + a.def.name;
        out.push('#### ' + name + ' in ' + a.path + ' (lines ' + a.def.start + '-' + a.def.end + ' at the PR head, a + before the code marks a line this PR changed)\n' + markedLines(lines, a.def.start, a.def.end, changed.get(a.path) || new Set(), maxLines));
      }
    }
    return out.join('\n\n');
  }

  async forStep(hunks, { maxChars = 28000, beforeMaxLines = 150, callerMaxLines = 50, calleeMaxLines = 40, maxCallees = 8 } = {}) {
    const t = Date.now();
    const infos = await Promise.all(hunks.map((h) => this.hunkInfo(h)));
    const stepPaths = new Set(hunks.map((h) => h.path));
    const stepAliases = new Set(hunks.map((h) => h.alias));
    const items = [];
    const seen = new Set();
    const add = (key, section, text, prio) => {
      if (seen.has(key)) return;
      seen.add(key);
      items.push({ section, text, prio, order: items.length });
    };

    for (const info of infos) {
      for (const b of info.before) {
        const lines = await this.lines(this.baseSha, b.path);
        const d = b.def;
        add('B' + b.path + d.start, 'before', '#### ' + b.path + ' :: ' + (d.parentName ? d.parentName + '.' : '') + d.name + ' (lines ' + d.start + '-' + d.end + ' at base)\n' + clip(lines, d.start, d.end, beforeMaxLines), 0);
      }
    }

    const symbols = new Map();
    for (const info of infos) for (const [name, s] of info.symbols) if (!symbols.has(name)) symbols.set(name, s);
    const ownDefs = infos.flatMap((i) => [...i.after, ...i.before]);
    const allChanged = new Set();
    for (const h of this.hunks) for (const [n] of (await this.hunkInfo(h)).symbols) allChanged.add(n);

    const unused = [];
    const importedBy = [];
    const callerLists = [];
    const callerResults = await Promise.all([...symbols].map(([name, s]) => this.callers(name, s.path, ownDefs)));
    [...symbols].forEach(([name, s], i) => {
      const c = callerResults[i];
      if (c.tooMany) return;
      if (c.outside === 0 && !s.removed) unused.push(name);
      if (s.removed && c.hits.length === 0) unused.push(name + ' (removed or renamed)');
      const imports = c.hits.filter((x) => x.isImport && !stepPaths.has(x.path));
      if (imports.length) importedBy.push('- ' + name + ': ' + [...new Set(imports.map((x) => x.path))].slice(0, 6).join(', '));
      callerLists.push({ name, hits: c.hits.filter((x) => !x.isImport) });
    });
    for (let round = 0; round < 4; round++) {
      for (const { name, hits } of callerLists) {
        const hit = hits[round];
        if (!hit) continue;
        const lines = await this.lines(this.headSha, hit.path);
        if (!lines) continue;
        const e = hit.enclosing;
        const where = e ? (e.parentName ? e.parentName + '.' : '') + e.name : 'top level';
        const body = e ? clip(lines, e.start, e.end, callerMaxLines, hit.line) : numbered(lines, Math.max(1, hit.line - 3), hit.line + 3);
        const tag = this.diffPaths.has(hit.path) ? ', changed in this PR' : '';
        add('C' + hit.path + (e ? e.start : hit.line), 'callers', '#### ' + name + ' used in ' + hit.path + ' :: ' + where + ' (line ' + hit.line + tag + ')\n' + body, 1 + round * 2 + (hit.score >= 1000 ? 0 : 1));
      }
    }

    const calleeNamesSeen = new Set();
    const calleeList = [];
    for (const info of infos) for (const a of info.after) for (const { name: n, member } of a.def.callees || []) if (!allChanged.has(n) && !calleeNamesSeen.has(n)) {
      calleeNamesSeen.add(n);
      calleeList.push({ name: n, near: a.path, member });
    }
    let callees = 0;
    const resolved = await Promise.all(calleeList.slice(0, maxCallees * 3).map(({ name, near, member }) => this.definitionOf(name, near, { sameFile: member })));
    for (const [k, { name }] of calleeList.slice(0, maxCallees * 3).entries()) {
      const d = resolved[k];
      if (callees >= maxCallees) break;
      if (!d) continue;
      callees++;
      const lines = await this.lines(this.headSha, d.path);
      add('D' + d.path + d.def.start, 'callees', '#### ' + name + ' defined in ' + d.path + ' (lines ' + d.def.start + '-' + d.def.end + ')\n' + clip(lines, d.def.start, d.def.end, calleeMaxLines), 4 + callees);
    }

    const sections = { before: [], callers: [], callees: [] };
    let used = 0;
    const head = [];
    if (unused.length) head.push('### Changed symbols with no reference in any file outside this PR (git grep -w at the PR head)\n' + unused.join(', '));
    if (importedBy.length) head.push('### Changed symbols imported by files outside this step\n' + importedBy.join('\n'));
    used = head.join('\n\n').length;
    let dropped = 0;
    for (const it of [...items].sort((a, b) => a.prio - b.prio || a.order - b.order)) {
      if (used + it.text.length > maxChars) {
        dropped++;
        continue;
      }
      used += it.text.length + 2;
      sections[it.section].push(it);
    }
    const titles = {
      before: '### Changed functions and classes before this PR (full bodies at the base commit)',
      callers: '### Where changed symbols are used (enclosing function at the PR head)',
      callees: '### Functions the changed code calls (definitions at the PR head)',
    };
    const parts = [...head];
    for (const k of ['before', 'callers', 'callees']) {
      const its = sections[k].sort((a, b) => a.order - b.order);
      if (its.length) parts.push(titles[k] + '\n' + its.map((x) => x.text).join('\n\n'));
    }
    const text = parts.join('\n\n');
    return {
      text,
      chars: text.length,
      ms: Date.now() - t,
      counts: { before: sections.before.length, callers: sections.callers.length, callees: sections.callees.length, dropped, symbols: symbols.size },
      stepAliases: [...stepAliases],
    };
  }
}
