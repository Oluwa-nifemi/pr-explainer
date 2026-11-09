import { html } from "htm/preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Md } from "../lib/md.js";
import { cx, KIND_LABEL, fileName, dirName } from "../lib/util.js";
import { hunkStats } from "../lib/diff.js";
import { hunkRole } from "../lib/prepare.js";
import { useSession, live, toast, goStep, jumpToFile, askAbout } from "../lib/session.js";
import { retryStep } from "../lib/api.js";
import { groupByFile } from "./Diff.js";

export const ROLE_TAG = { source: "src", test: "test", generated: "gen", docs: "docs", config: "config" };
export const ROLE_LABEL = { source: "Source", test: "Tests", generated: "Generated", docs: "Docs", config: "Config" };

export function GistFailure({ step }) {
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    try { await retryStep(live.prKey, step.id); }
    catch (e) { toast(e.message, "error"); }
    finally { setBusy(false); }
  };
  return html`<div class="gist-failure" role="status"><span>Couldn’t write this gist.</span><button class="link" disabled=${busy} onClick=${retry}>${busy ? "Retrying…" : "Retry"}</button></div>`;
}

function Skeleton({ lines = 3 }) {
  return html`<div class="skel-block">${Array.from({ length: lines }, (_, i) => html`<span class="skel" style=${{ width: 100 - ((i * 17) % 40) + "%" }}></span>`)}</div>`;
}

// Select text in the gist to ask the chat about it.
function SelectionAsk({ step, rootRef }) {
  const [sel, setSel] = useState(null);
  useEffect(() => {
    const onUp = () => {
      setTimeout(() => {
        const s = window.getSelection();
        const text = String(s || "").trim();
        const root = rootRef.current;
        if (!text || text.length < 3 || !root || !s.rangeCount || !root.contains(s.getRangeAt(0).commonAncestorContainer)) return setSel(null);
        const r = s.getRangeAt(0).getBoundingClientRect();
        setSel({ text, x: r.left + r.width / 2, y: r.top });
      }, 0);
    };
    const onDown = (e) => !e.target.closest?.(".sel-ask") && setSel(null);
    const onScroll = () => setSel(null);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);
  if (!sel) return null;
  const short = sel.text.length > 48 ? sel.text.slice(0, 46) + "…" : sel.text;
  return html`<button
    class="sel-ask"
    style=${{ left: sel.x + "px", top: sel.y - 8 + "px" }}
    onClick=${() => {
      askAbout({ type: "quote", label: "“" + short + "”", stepId: step.id, snippet: sel.text });
      window.getSelection()?.removeAllRanges();
      setSel(null);
    }}
  >Ask about this</button>`;
}

// The gist of the step the reader is on.
export function StepTab({ story }) {
  const current = useSession((s) => s.current);
  const step = story.steps.find((s) => s.id === current);
  const proseRef = useRef(null);
  const body = useRef(null);
  useEffect(() => {
    if (body.current) body.current.scrollTop = 0;
  }, [current]);
  if (!step) return html`<div class="step-tab"><p class="chat-hint">No step yet.</p></div>`;
  const ready = step.status === "ready";
  const failed = step.status === "failed";
  const gist = step.gist || step.explanation || step.summary;
  return html`<div class="step-tab" ref=${body}>
    <header class="st-head">
      <div class="eyebrow-s">Step ${step.order} of ${story.steps.length}</div>
      <h3>${step.title}</h3>
      <div class="st-meta">
        <span class=${"kindchip kind-" + step.kind}>${KIND_LABEL[step.kind] || step.kind}</span>
      </div>
    </header>
    ${ready
      ? html`
        <section class=${cx("st-sec", "prose", !step.gist && "clamped")} ref=${proseRef}>
          <${Md} text=${gist} />
        </section>
        <${SelectionAsk} step=${step} rootRef=${proseRef} />
        <div class="st-actions">
          <button class="btn ghost" onClick=${() => askAbout({ type: "step", label: "Step " + step.order + " · " + step.title, stepId: step.id, snippet: gist })}>Ask about this step</button>
        </div>
      `
      : failed ? html`<div class="st-sec"><${GistFailure} step=${step} /></div>`
      : html`<div class="st-sec"><div class="writing"><i class="spin"></i>Writing the gist</div><${Skeleton} lines=${4} /></div>`}
  </div>`;
}

const fileStats = (hunks) =>
  hunks.reduce((a, h) => {
    const s = hunkStats(h.patch);
    return { add: a.add + s.add, del: a.del + s.del };
  }, { add: 0, del: 0 });

// Every changed file, grouped by the step that shows it. Test and doc files point at the closing section.
export function filesByStep(story) {
  const extras = story.extras || [];
  const groups = story.steps.map((s) => ({
    id: s.id,
    order: s.order,
    title: s.title,
    files: [
      ...groupByFile(s.hunks).map((f) => ({ path: f.path, stepId: s.id, role: hunkRole(f.hunks[0]), ...fileStats(f.hunks) })),
      ...extras.filter((x) => x.origin?.id === s.id).map((x) => ({ path: x.path, stepId: "extras", role: hunkRole(x.hunks[0]), ...fileStats(x.hunks) })),
    ],
  }));
  const known = new Set(story.steps.map((s) => s.id));
  extras
    .filter((x) => !known.has(x.origin?.id))
    .forEach((x) => {
      const key = x.origin?.id || "x";
      let g = groups.find((y) => y.id === "orphan-" + key);
      if (!g) groups.push((g = { id: "orphan-" + key, order: null, title: x.origin?.title || "Tests and docs", files: [] }));
      g.files.push({ path: x.path, stepId: "extras", role: hunkRole(x.hunks[0]), ...fileStats(x.hunks) });
    });
  return groups.filter((g) => g.files.length);
}

export function FilesTab({ story }) {
  const current = useSession((s) => s.current);
  const groups = useMemo(() => filesByStep(story), [story]);
  const curRef = useRef(null);
  useEffect(() => {
    curRef.current?.scrollIntoView({ block: "nearest" });
  }, [current]);
  const skipped = story.skippedFiles || [];
  return html`<div class="files-tab">
    ${groups.map(
      (g) => html`<section class=${cx("fgroup", g.id === current && "current")} key=${g.id} ref=${g.id === current ? curRef : null}>
        <button class="fgroup-head" disabled=${!g.order} onClick=${() => goStep(g.id)}>
          ${g.order ? html`<span class="fg-num">${g.order}</span>` : null}<span class="fg-title">${g.title}</span><span class="fg-count">${g.files.length}</span>
        </button>
        <ul>
          ${g.files.map(
            (f) => html`<li key=${f.stepId + f.path}>
              <button class="frow" title=${f.path} onClick=${() => jumpToFile({ stepId: f.stepId, path: f.path })}>
                <span class="fr-path"><b>${fileName(f.path)}</b><span class="dir">${dirName(f.path)}</span></span>
                <span class=${"rtag role-" + f.role}>${ROLE_TAG[f.role]}</span>
                <span class="hh-stats"><b class="plus">+${f.add}</b> <b class="minus">−${f.del}</b></span>
              </button>
            </li>`
          )}
        </ul>
      </section>`
    )}
    ${skipped.length
      ? html`<section class="fgroup skipped-group">
          <div class="fgroup-head static"><span class="fg-title">Not in any step</span><span class="fg-count">${skipped.length}</span></div>
          <ul>${skipped.map((f) => html`<li key=${f.path}><div class="frow static" title=${f.path}><span class="fr-path"><b>${fileName(f.path)}</b><span class="dir">${dirName(f.path)}</span></span><span class="rtag">${f.reason}</span></div></li>`)}</ul>
        </section>`
      : null}
  </div>`;
}
