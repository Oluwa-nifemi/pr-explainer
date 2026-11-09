import { html } from "htm/preact";

const PY_KW = new Set("and as assert async await class def elif else except finally for from if import in is lambda not or pass raise return try while with yield match case type".split(" "));
const TS_KW = new Set("import export from const let var function return if else for while new class extends implements interface type enum async await as of in typeof void null undefined true false satisfies default throw try catch switch case break continue readonly private public static".split(" "));
const PY_CONST = new Set(["None", "True", "False", "self", "cls"]);

const PY_RE = /(#.*$)|("""|''')|((?:[rRfFbB]{1,2})?"(?:[^"\\]|\\.)*"|(?:[rRfFbB]{1,2})?'(?:[^'\\]|\\.)*')|(\b\d[\d_.]*\b)|(@[\w.]+)|(\b[A-Za-z_]\w*\b)/g;
const TS_RE = /(\/\/.*$)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|(\b\d[\d_.]*\b)|(\b[A-Za-z_$][\w$]*\b)/g;
const JSON_RE = /("(?:[^"\\]|\\.)*")|(\b\d[\d.]*\b)|(\b(?:true|false|null)\b)/g;

const span = (cls, text) => html`<span class=${"tk-" + cls}>${text}</span>`;

// Returns { nodes, state }. 'state' carries open triple-quote strings across lines (python).
function pyLine(line, state) {
  const nodes = [];
  let i = 0;
  if (state.doc) {
    const end = line.indexOf(state.doc);
    if (end === -1) return { nodes: [span("str", line)], state };
    nodes.push(span("str", line.slice(0, end + 3)));
    i = end + 3;
    state = { doc: null };
  }
  PY_RE.lastIndex = i;
  let m;
  let prev = "";
  while ((m = PY_RE.exec(line))) {
    if (m.index > i) nodes.push(line.slice(i, m.index));
    i = m.index + m[0].length;
    if (m[1]) nodes.push(span("com", m[1]));
    else if (m[2]) {
      const close = line.indexOf(m[2], i);
      if (close === -1) {
        nodes.push(span("str", line.slice(m.index)));
        state = { doc: m[2] };
        i = line.length;
        break;
      }
      nodes.push(span("str", line.slice(m.index, close + 3)));
      i = close + 3;
      PY_RE.lastIndex = i;
    } else if (m[3]) nodes.push(span("str", m[3]));
    else if (m[4]) nodes.push(span("num", m[4]));
    else if (m[5]) nodes.push(span("dec", m[5]));
    else {
      const w = m[6];
      if (PY_KW.has(w)) nodes.push(span("kw", w));
      else if (PY_CONST.has(w)) nodes.push(span("const", w));
      else if (prev === "def") nodes.push(span("fn", w));
      else if (prev === "class") nodes.push(span("cls", w));
      else if (/^[A-Z][a-z]/.test(w)) nodes.push(span("cls", w));
      else nodes.push(w);
      prev = w;
      continue;
    }
    prev = "";
  }
  if (i < line.length) nodes.push(line.slice(i));
  return { nodes, state };
}

function tsLine(line, state) {
  const t = line.trim();
  if (state.block) {
    const end = line.indexOf("*/");
    if (end === -1) return { nodes: [span("com", line)], state };
    return { nodes: [span("com", line.slice(0, end + 2)), line.slice(end + 2)], state: { block: false } };
  }
  if (t.startsWith("/*")) {
    if (t.includes("*/")) return { nodes: [span("com", line)], state };
    return { nodes: [span("com", line)], state: { block: true } };
  }
  const nodes = [];
  let i = 0;
  let m;
  let prev = "";
  TS_RE.lastIndex = 0;
  while ((m = TS_RE.exec(line))) {
    if (m.index > i) nodes.push(line.slice(i, m.index));
    i = m.index + m[0].length;
    if (m[1]) nodes.push(span("com", m[1]));
    else if (m[2]) nodes.push(span("str", m[2]));
    else if (m[3]) nodes.push(span("num", m[3]));
    else {
      const w = m[4];
      if (TS_KW.has(w)) nodes.push(span("kw", w));
      else if (prev === "function") nodes.push(span("fn", w));
      else if (/^[A-Z][a-z]/.test(w)) nodes.push(span("cls", w));
      else nodes.push(w);
      prev = w;
      continue;
    }
    prev = "";
  }
  if (i < line.length) nodes.push(line.slice(i));
  return { nodes, state };
}

function jsonLine(line, state) {
  const nodes = [];
  let i = 0;
  let m;
  JSON_RE.lastIndex = 0;
  while ((m = JSON_RE.exec(line))) {
    if (m.index > i) nodes.push(line.slice(i, m.index));
    i = m.index + m[0].length;
    nodes.push(span(m[1] ? "str" : m[2] ? "num" : "kw", m[0]));
  }
  if (i < line.length) nodes.push(line.slice(i));
  return { nodes, state };
}

function mdLine(line, state) {
  if (/^\s{0,3}#{1,6} /.test(line)) return { nodes: [span("fn", line)], state };
  const nodes = [];
  const re = /`[^`]+`/g;
  let i = 0;
  let m;
  while ((m = re.exec(line))) {
    if (m.index > i) nodes.push(line.slice(i, m.index));
    nodes.push(span("str", m[0]));
    i = m.index + m[0].length;
  }
  if (i < line.length) nodes.push(line.slice(i));
  return { nodes, state };
}

const FN = { py: pyLine, ts: tsLine, json: jsonLine, md: mdLine };

// Highlights all lines of a hunk. Old-side and new-side keep separate multi-line state.
export function highlightLines(lines, lang) {
  const fn = FN[lang];
  if (!fn) return lines.map((l) => l.text);
  let oldS = {};
  let newS = {};
  return lines.map((l) => {
    if (l.type === "meta") return l.text;
    if (l.type === "del") {
      const r = fn(l.text, oldS);
      oldS = r.state;
      return r.nodes;
    }
    if (l.type === "add") {
      const r = fn(l.text, newS);
      newS = r.state;
      return r.nodes;
    }
    const r = fn(l.text, newS);
    newS = r.state;
    oldS = fn(l.text, oldS).state;
    return r.nodes;
  });
}
