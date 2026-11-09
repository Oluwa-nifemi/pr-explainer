import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { getSettings, saveSettings } from "../lib/api.js";
import { useSetup } from "../lib/setup.js";
import { Setup } from "./Setup.js";
import { cx } from "../lib/util.js";

const TABS = [
  ["pipeline", "How it works"],
  ["prompts", "Prompts"],
  ["files", "Files"],
  ["connections", "Connections"],
];
const SKIP_ORDER = ["custom", "lockfile", "snapshot", "binary", "generated"];
const ROLE_ORDER = ["test", "config", "docs"];
const ROLE_LABEL = { test: "Test file", config: "Config file", docs: "Docs", source: "Source code" };

const clone = (v) => JSON.parse(JSON.stringify(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const escapeRe = (s) => s.replace(/[.*+?^$|()\[\]\\{}]/g, "\\$&");

function globToRegExp(glob) {
  const g = String(glob).trim().replace(/^\.?\//, "");
  let out = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      out += ".*";
      i++;
      if (g[i + 1] === "/") i++;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += escapeRe(c);
  }
  return new RegExp((g.includes("/") ? "^" : "(^|/)") + out + "$");
}

const lines = (s) => s.split("\n").map((l) => l.trim()).filter(Boolean).join(" ");
const textOf = (p, raw) => (p.joiner === " " ? lines(String(raw).replace(/\r/g, "")) : String(raw).replace(/\r/g, "").replace(/\s+$/, ""));

// Same shape the service saves, so "unsaved changes" is a plain comparison.
function tidy(draft, data) {
  const out = {};
  const prompts = {};
  for (const p of data.prompts) {
    const v = draft.prompts?.[p.id];
    if (typeof v !== "string" || !v.trim()) continue;
    if (textOf(p, v) === textOf(p, p.default)) continue;
    prompts[p.id] = v;
  }
  if (Object.keys(prompts).length) out.prompts = prompts;
  if (draft.diagrams?.mode && draft.diagrams.mode !== "default") out.diagrams = { mode: draft.diagrams.mode };
  const files = {};
  const groups = {};
  for (const g of data.files.groups) {
    const s = draft.files?.groups?.[g.id];
    if (!s) continue;
    const disabled = s.disabled || [];
    const added = (s.added || []).filter((a) => a.value && a.value.trim());
    if (disabled.length || added.length) groups[g.id] = { ...(disabled.length ? { disabled } : {}), ...(added.length ? { added } : {}) };
  }
  if (Object.keys(groups).length) files.groups = groups;
  if (draft.files?.hideRoles?.length) files.hideRoles = draft.files.hideRoles;
  const max = Number(draft.files?.limits?.maxFileChangedLines);
  if (Number.isInteger(max) && max > 0 && max !== data.files.limits.maxFileChangedLines.default) files.limits = { maxFileChangedLines: max };
  if (Object.keys(files).length) out.files = files;
  return out;
}

function Switch({ on, onChange, label }) {
  return html`<label class="sp-switch" title=${label}><input type="checkbox" checked=${on} onChange=${(e) => onChange(e.currentTarget.checked)} aria-label=${label} /><i></i></label>`;
}

// ---------- how it works ----------

function Node({ x, y, w, h = 64, title, sub, kind, stack, to, setTab }) {
  const go = to ? () => setTab(to) : undefined;
  return html`<g class=${cx("pn", kind, to && "go")} transform=${"translate(" + x + "," + y + ")"} onClick=${go} aria-label=${to ? title : undefined} tabindex=${to ? 0 : undefined} onKeyDown=${to ? (e) => e.key === "Enter" && go() : undefined}>
    ${stack ? html`<rect class="pn-box ghost" x="10" y="-9" width=${w} height=${h} rx="12" />` : null}
    ${stack ? html`<rect class="pn-box ghost" x="5" y="-4.5" width=${w} height=${h} rx="12" />` : null}
    <rect class="pn-box" width=${w} height=${h} rx="12" />
    <text class="pn-t" x="16" y="27">${title}</text>
    <text class="pn-s" x="16" y="47">${sub}</text>
  </g>`;
}

function PipelineTab({ data, setTab }) {
  const { checks } = data.info;
  const A = (d, label, lx, ly) => html`<g><path class="pn-arrow" d=${d} marker-end="url(#pn-head)" />${label ? html`<text class="pn-l" x=${lx} y=${ly} text-anchor="middle">${label}</text>` : null}</g>`;
  return html`<div class="sp-pane">
    <div class="pn-legend">
      <span><i class="code"></i>Code</span>
      <span><i class="model"></i>Model call (${data.model})</span>
      <span><i class="save"></i>Result</span>
      <span class="muted">Click a box to change it.</span>
    </div>
    <svg class="pn-svg" viewBox="-14 0 906 400" role="img" aria-label="How a story is made">
      <defs>
        <marker id="pn-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" class="pn-head" /></marker>
      </defs>
      <text class="pn-lane" x="8" y="22">1. Prepare</text>
      <${Node} x=8 y=36 w=186 title="Read the PR" sub="Diff and details from GitHub" kind="code" setTab=${setTab} />
      <${Node} x=236 y=36 w=186 title="Drop the noise" sub="Skips lockfiles, snapshots" kind="code" to="files" setTab=${setTab} />
      <${Node} x=464 y=36 w=186 title="Cut big hunks" sub="150+ lines, split at seams" kind="model" setTab=${setTab} />
      <${Node} x=692 y=36 w=186 title="Fetch the code" sub="Head and base in a mirror" kind="code" setTab=${setTab} />
      ${A("M194,68 H236")}
      ${A("M422,68 H464")}
      ${A("M650,68 H692")}

      <text class="pn-lane" x="330" y="150">2. Write, at the same time</text>
      <${Node} x=8 y=172 w=186 title="Planner" sub="Groups hunks into steps" kind="model" to="prompts" setTab=${setTab} />
      <${Node} x=270 y=172 w=200 title="Workers" sub="One per step, in parallel" kind="model" stack=${true} to="prompts" setTab=${setTab} />
      <${Node} x=8 y=290 w=186 title="Summary agent" sub="Overview, bullets, risk" kind="model" to="prompts" setTab=${setTab} />
      <${Node} x=520 y=172 w=186 title="Checks" sub="Coverage, gist, diagrams" kind="code" setTab=${setTab} />
      <${Node} x=748 y=172 w=130 title="Story" sub="Saved per commit" kind="save" setTab=${setTab} />
      ${A("M785,100 V138 H101 V172")}
      ${A("M101,138 H-6 V322 H8")}
      ${A("M194,204 H270", "steps", 232, 194)}
      ${A("M480,204 H520")}
      ${A("M194,322 H613 V236", null)}
      ${A("M706,204 H748")}
    </svg>
    <section class="sp-card">
      <h3>Checks that always run</h3>
      <ul class="pn-checks">${checks.map((c) => html`<li key=${c.title} tabindex="0">${c.title}<div class="pn-tip" role="tooltip"><b>${c.title}</b><ul>${c.rules.map((r) => html`<li key=${r}>${r}</li>`)}</ul></div></li>`)}</ul>
    </section>
  </div>`;
}

// ---------- prompts ----------

function PromptBlock({ p, value, onChange, alsoIn, children }) {
  const [editing, setEditing] = useState(false);
  const [full, setFull] = useState(false);
  const [showDefault, setShowDefault] = useState(false);
  const custom = typeof value === "string";
  const text = custom ? value : p.default;
  const rows = Math.max(4, Math.min(26, text.split("\n").length + 1));
  return html`<div class=${cx("sp-block", custom && "custom")}>
    <div class="sp-block-head">
      <h4>${p.title}</h4>
      ${custom ? html`<span class="sp-badge">Customised</span>` : null}
      <span class="sp-block-actions">
        ${custom ? html`<button class="link" onClick=${() => setShowDefault(!showDefault)}>${showDefault ? "Hide default" : "Show default"}</button>` : null}
        ${custom ? html`<button class="link" onClick=${() => (onChange(null), setEditing(false))}>Reset</button>` : null}
        <button class="link" onClick=${() => setEditing(!editing)}>${editing ? "Done" : "Edit"}</button>
      </span>
    </div>
    <p class="sp-help">${p.help}${alsoIn.length ? " Also used by " + alsoIn.join(" and ") + "." : ""}</p>
    ${children}
    ${editing
      ? html`<textarea class="sp-edit" rows=${rows} spellcheck="false" value=${text} onInput=${(e) => onChange(e.currentTarget.value)} />
          <p class="sp-hint">${p.joiner === " " ? "One rule per line. The lines are joined with spaces when sent." : "Sent as written, line by line."}${p.tokens.length ? " Tokens in double braces are filled in when a story is made: " + p.tokens.map((t) => "{{" + t + "}}").join(", ") + "." : ""}</p>`
      : html`<pre class=${cx("sp-text", !full && "clamp")} onClick=${() => setFull(!full)} title=${full ? "Click to fold" : "Click to read all"}>${text.replace(/\n/g, "\n\n")}</pre>`}
    ${showDefault ? html`<div class="sp-default"><b>Default</b><pre class="sp-text">${p.default.replace(/\n/g, "\n\n")}</pre></div>` : null}
  </div>`;
}

function PromptsTab({ data, draft, update }) {
  const [agentId, setAgentId] = useState("worker");
  const { agents } = data.info;
  const agent = agents.find((a) => a.id === agentId);
  const byId = Object.fromEntries(data.prompts.map((p) => [p.id, p]));
  const mode = draft.diagrams?.mode || "default";
  const modeInfo = data.diagrams.modes.find((m) => m.id === mode);
  return html`<div class="sp-pane">
    <p class="sp-lede">This is everything an agent is sent, in order. Grey blocks are filled in by code for each PR. The others are text you can read and change.</p>
    <div class="modes sp-agent-pick" role="tablist">
      ${agents.map((a) => html`<button key=${a.id} role="tab" aria-selected=${a.id === agentId} class=${cx("mode", a.id === agentId && "on")} onClick=${() => setAgentId(a.id)}>${a.title}</button>`)}
    </div>
    <p class="sp-agent-job"><b>${agent.title}.</b> ${agent.job} Runs on <code>${data.model}</code>.</p>
    <ol class="sp-blocks">
      ${agent.blocks.map((b, i) => {
        if (b.type === "data")
          return html`<li key=${i} class="sp-data"><span class="sp-rail">${i + 1}</span><div class="sp-block data"><h4>${b.title}</h4><p class="sp-help">${b.note} Filled in by code for each PR.</p></div></li>`;
        const p = byId[b.id];
        const alsoIn = agents.filter((a) => a.id !== agent.id && a.blocks.some((x) => x.id === b.id)).map((a) => a.title);
        return html`<li key=${i}>
          <span class="sp-rail">${i + 1}</span>
          <${PromptBlock} p=${p} value=${draft.prompts?.[p.id]} alsoIn=${alsoIn} onChange=${(v) => update((d) => ({ ...d, prompts: { ...(d.prompts || {}), [p.id]: v === null ? undefined : v } }))}>
            ${p.id === "diagramRules"
              ? html`<div class="sp-mode">
                  <span>How many diagrams</span>
                  <div class="modes">${data.diagrams.modes.map((m) => html`<button key=${m.id} class=${cx("mode", m.id === mode && "on")} onClick=${() => update((d) => ({ ...d, diagrams: { mode: m.id } }))}>${m.label}</button>`)}</div>
                  ${modeInfo?.line ? html`<em>Adds: ${modeInfo.line}</em>` : null}
                </div>`
              : null}
          <//>
        </li>`;
      })}
    </ol>
  </div>`;
}

// ---------- files ----------

function classify(path, groups, draft) {
  const p = path.trim();
  if (!p) return null;
  const test = (g) => {
    const o = draft.files?.groups?.[g.id] || {};
    const off = new Set(o.disabled || []);
    for (const r of g.rules) {
      if (off.has(r.id)) continue;
      try {
        if (new RegExp(r.pattern, r.flags).test(p)) return true;
      } catch {}
    }
    for (const a of o.added || []) {
      try {
        if ((a.kind === "glob" ? globToRegExp(a.value) : new RegExp(a.value, a.flags || "")).test(p)) return true;
      } catch {}
    }
    return false;
  };
  const byId = Object.fromEntries(groups.map((g) => [g.id, g]));
  for (const id of SKIP_ORDER) if (test(byId[id])) return { left: true, text: "Left out of the story: " + byId[id].title.toLowerCase() };
  const role = ROLE_ORDER.find((id) => test(byId[id])) || "source";
  if ((draft.files?.hideRoles || []).includes(role)) return { left: true, text: "Left out of the story: " + byId[role].title.toLowerCase() + " are hidden" };
  return { left: false, text: "Shown in the story as: " + ROLE_LABEL[role].toLowerCase() };
}

function RuleGroup({ g, draft, update, hidden }) {
  const [open, setOpen] = useState(g.id === "custom");
  const [value, setValue] = useState("");
  const [kind, setKind] = useState("glob");
  const [bad, setBad] = useState(null);
  const s = draft.files?.groups?.[g.id] || {};
  const off = new Set(s.disabled || []);
  const added = s.added || [];
  const set = (patch) => update((d) => ({ ...d, files: { ...(d.files || {}), groups: { ...(d.files?.groups || {}), [g.id]: { ...s, ...patch } } } }));
  const toggle = (id, on) => set({ disabled: on ? (s.disabled || []).filter((x) => x !== id) : [...(s.disabled || []), id] });
  const add = () => {
    const v = value.trim();
    if (!v) return;
    try {
      kind === "glob" ? globToRegExp(v) : new RegExp(v);
    } catch (e) {
      return setBad("That is not a valid " + kind + ".");
    }
    setBad(null);
    set({ added: [...added, { kind, value: v }] });
    setValue("");
  };
  const active = g.rules.filter((r) => !off.has(r.id)).length + added.length;
  return html`<section class=${cx("sp-card sp-group", open && "open")}>
    <button class="sp-group-head" onClick=${() => setOpen(!open)} aria-expanded=${open}>
      <span class="sp-chev">${open ? "⌄" : "›"}</span>
      <h3>${g.title}</h3>
      <span class="sp-count">${active} pattern${active === 1 ? "" : "s"} on</span>
    </button>
    <p class="sp-help">${g.help}</p>
    ${g.kind === "role"
      ? html`<div class="sp-row"><span>Leave these out of stories completely</span><${Switch} on=${hidden} label="Leave out" onChange=${(on) => update((d) => ({ ...d, files: { ...(d.files || {}), hideRoles: on ? [...new Set([...(d.files?.hideRoles || []), g.role])] : (d.files?.hideRoles || []).filter((r) => r !== g.role) } }))} /></div>`
      : null}
    ${open
      ? html`<div class="sp-rules">
          ${g.rules.map((r) => html`<div class="sp-rule" key=${r.id}><${Switch} on=${!off.has(r.id)} label=${r.pattern} onChange=${(on) => toggle(r.id, on)} /><code>${r.pattern}</code></div>`)}
          ${added.map((a, i) => html`<div class="sp-rule added" key=${i}><span class="sp-badge">${a.kind}</span><code>${a.value}</code><button class="icon-btn" aria-label="Remove" onClick=${() => set({ added: added.filter((_, k) => k !== i) })}>×</button></div>`)}
          <div class="sp-add">
            <input type="text" spellcheck="false" placeholder=${kind === "glob" ? "packages/*/migrations/meta/*_snapshot.json" : "(^|/)generated/"} value=${value} onInput=${(e) => (setValue(e.currentTarget.value), setBad(null))} onKeyDown=${(e) => e.key === "Enter" && add()} />
            <div class="modes"><button class=${cx("mode", kind === "glob" && "on")} onClick=${() => setKind("glob")}>Path</button><button class=${cx("mode", kind === "regex" && "on")} onClick=${() => setKind("regex")}>Regex</button></div>
            <button class="btn small" onClick=${add} disabled=${!value.trim()}>Add</button>
          </div>
          ${bad ? html`<p class="sp-bad">${bad}</p>` : null}
        </div>`
      : null}
  </section>`;
}

function FilesTab({ data, draft, update }) {
  const [path, setPath] = useState("packages/control-plane/migrations/meta/0009_snapshot.json");
  const groups = data.files.groups;
  const result = classify(path, groups, draft);
  const skip = SKIP_ORDER.map((id) => groups.find((g) => g.id === id));
  const roles = ROLE_ORDER.map((id) => groups.find((g) => g.id === id));
  const max = draft.files?.limits?.maxFileChangedLines ?? "";
  return html`<div class="sp-pane">
    <p class="sp-lede">Files that match a left-out pattern never reach the planner or the workers. The other files are labelled test, config, docs or source, and the label decides how they are shown.</p>
    <section class="sp-card sp-try">
      <h3>Try a path</h3>
      <input type="text" spellcheck="false" value=${path} placeholder="path/to/file.ts" onInput=${(e) => setPath(e.currentTarget.value)} />
      ${result ? html`<p class=${cx("sp-result", result.left && "left")}>${result.text}</p>` : null}
      <p class="sp-hint">Checks the path against the rules below, including unsaved changes. File size and "@generated" markers are not checked here.</p>
    </section>
    <h2 class="sp-h2">Left out of stories</h2>
    ${skip.map((g) => html`<${RuleGroup} key=${g.id} g=${g} draft=${draft} update=${update} hidden=${false} />`)}
    <section class="sp-card">
      <h3>Very large files</h3>
      <p class="sp-help">A file with more changed lines than this is left out.</p>
      <div class="sp-row"><span>Changed lines</span><input class="sp-num-in" type="number" min="1" value=${max} placeholder=${String(data.files.limits.maxFileChangedLines.default)} onInput=${(e) => update((d) => ({ ...d, files: { ...(d.files || {}), limits: { maxFileChangedLines: e.currentTarget.value } } }))} /></div>
    </section>
    <h2 class="sp-h2">How the rest is labelled</h2>
    ${roles.map((g) => html`<${RuleGroup} key=${g.id} g=${g} draft=${draft} update=${update} hidden=${(draft.files?.hideRoles || []).includes(g.role)} />`)}
  </div>`;
}

// ---------- page ----------

export function SettingsPage({ tab, go }) {
  const current = TABS.some(([id]) => id === tab) ? tab : "pipeline";
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState(null);
  const [saved, setSaved] = useState(false);
  const status = useSetup().status;

  useEffect(() => {
    getSettings()
      .then((d) => (setData(d), setDraft(clone(d.overrides))))
      .catch((e) => setError(e.message));
  }, []);

  const update = (fn) => {
    setSaved(false);
    setProblem(null);
    setDraft((d) => tidy(fn(d), data));
  };
  const dirty = data && !same(draft, data.overrides);
  const save = async () => {
    setSaving(true);
    setProblem(null);
    try {
      const next = await saveSettings(draft);
      setData(next);
      setDraft(clone(next.overrides));
      setSaved(true);
    } catch (e) {
      setProblem(e.message);
    }
    setSaving(false);
  };
  const setTab = (id) => go("?settings=" + id);

  return html`<main class="sp">
    <header class="sp-top">
      <button class="brand" onClick=${() => go("")} aria-label="Back to start"><span class="brand-mark">¶</span><span>PR Explainer</span></button>
      <span class="sp-crumb">Settings</span>
    </header>
    <div class="sp-wrap">
      <h1>How your stories are made</h1>
      <nav class="sp-tabs" role="tablist">
        ${TABS.map(([id, label]) => html`<button key=${id} role="tab" aria-selected=${id === current} class=${cx("sp-tab", id === current && "on")} onClick=${() => setTab(id)}>${label}</button>`)}
      </nav>
      ${error ? html`<div class="notice"><b>Could not load the settings.</b> ${error}</div>` : null}
      ${!data && !error ? html`<div class="boot"><i class="spin"></i></div>` : null}
      ${data && current === "pipeline" ? html`<${PipelineTab} data=${data} setTab=${setTab} />` : null}
      ${data && current === "prompts" ? html`<${PromptsTab} data=${data} draft=${draft} update=${update} />` : null}
      ${data && current === "files" ? html`<${FilesTab} data=${data} draft=${draft} update=${update} />` : null}
      ${current === "connections" && status ? html`<div class="sp-pane sp-conn"><${Setup} status=${status} embedded=${true} /></div>` : null}
      ${data ? html`<p class="sp-foot">Your changes are saved to <code>${data.path}</code>, outside the project, so git never sees them. Delete the file to go back to the defaults.</p>` : null}
    </div>
    ${dirty || saved || problem
      ? html`<div class="sp-savebar" role="status">
          ${problem
            ? html`<span class="sp-bad">${problem}</span>`
            : saved && !dirty
            ? html`<span>Saved. Stories made before now show as Outdated until you regenerate them.</span>`
            : html`<span>You have unsaved changes. Saving marks existing stories as outdated.</span>`}
          ${dirty ? html`<button class="btn ghost small" onClick=${() => (setDraft(clone(data.overrides)), setProblem(null))} disabled=${saving}>Discard</button>` : null}
          ${dirty ? html`<button class="btn primary small" onClick=${save} disabled=${saving}>${saving ? "Saving…" : "Save"}</button>` : null}
        </div>`
      : null}
  </main>`;
}
