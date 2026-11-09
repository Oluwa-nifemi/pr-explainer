import { html } from "htm/preact";
import { findRef, openRef } from "./chat.js";

const REF = /^([\w@.\-/]+\.\w+):(\d+)(?:-(\d+))?$/;
const REF_LOOSE = /[\w@.\-/]+\.\w+:\d+(?:-\d+)?/g;

function Ref({ text, hit }) {
  return html`<button class="ref" title=${text + " · Jump to step " + hit.step.order} onClick=${() => openRef(hit)}>${text.split("/").pop()}</button>`;
}

function plain(text, refs) {
  if (!refs || !text.includes(":")) return [text];
  const out = [];
  let last = 0;
  for (const m of text.matchAll(REF_LOOSE)) {
    const p = REF.exec(m[0]);
    const hit = p && findRef(p[1], +p[2]);
    if (!hit) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(html`<${Ref} text=${m[0]} hit=${hit} />`);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Tiny markdown: paragraphs, headings, lists, fenced code, quotes, `code`, **bold**, *em*.
export function inline(text, refs) {
  const out = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(...plain(text.slice(last, m.index), refs));
    const t = m[0];
    if (t[0] === "`") {
      const body = t.slice(1, -1);
      const p = refs && REF.exec(body);
      const hit = p && findRef(p[1], +p[2]);
      out.push(hit ? html`<${Ref} text=${body} hit=${hit} />` : html`<code>${body}</code>`);
    } else if (t.startsWith("**")) out.push(html`<strong>${inline(t.slice(2, -2), refs)}</strong>`);
    else out.push(html`<em>${t.slice(1, -1)}</em>`);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(...plain(text.slice(last), refs));
  return out;
}

const FENCE = /^\s*```/;
const UL = /^\s*[-*] /;
const OL = /^\s*\d+[.)] /;

function blocks(src) {
  const lines = String(src || "").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) {
      i++;
    } else if (FENCE.test(l)) {
      const code = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push({ t: "code", text: code.join("\n") });
    } else if (/^#{1,6} /.test(l)) {
      out.push({ t: "h", text: l.replace(/^#+ /, "") });
      i++;
    } else if (UL.test(l) || OL.test(l)) {
      const re = UL.test(l) ? UL : OL;
      const items = [];
      while (i < lines.length && re.test(lines[i])) items.push(lines[i++].replace(re, ""));
      out.push({ t: re === UL ? "ul" : "ol", items });
    } else if (l.startsWith(">")) {
      const q = [];
      while (i < lines.length && lines[i].startsWith(">")) q.push(lines[i++].replace(/^> ?/, ""));
      out.push({ t: "quote", text: q.join(" ") });
    } else {
      const p = [];
      while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !/^(#{1,6} |>)/.test(lines[i]) && !UL.test(lines[i]) && !OL.test(lines[i])) p.push(lines[i++]);
      out.push({ t: "p", text: p.join(" ") });
    }
  }
  return out;
}

export function Md({ text, class: cls, refs }) {
  return html`<div class=${"md " + (cls || "")}>
    ${blocks(text).map((b) =>
      b.t === "code"
        ? html`<pre class="md-code"><code>${b.text}</code></pre>`
        : b.t === "h"
        ? html`<p class="md-h">${inline(b.text, refs)}</p>`
        : b.t === "ul"
        ? html`<ul>${b.items.map((x) => html`<li>${inline(x, refs)}</li>`)}</ul>`
        : b.t === "ol"
        ? html`<ol>${b.items.map((x) => html`<li>${inline(x, refs)}</li>`)}</ol>`
        : b.t === "quote"
        ? html`<blockquote>${inline(b.text, refs)}</blockquote>`
        : html`<p>${inline(b.text, refs)}</p>`
    )}
  </div>`;
}
