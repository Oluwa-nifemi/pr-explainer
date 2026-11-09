import { html } from "htm/preact";
import { useEffect, useRef, useMemo } from "preact/hooks";
import { inline, Md } from "../lib/md.js";
import { cx, KIND_LABEL, fileName, dirName } from "../lib/util.js";
import { hunkStats } from "../lib/diff.js";
import { session, useSession, goStep, toggleReviewed, setHash, navLocked, jumpToNode, nodeIsLinked, setExtrasOpen, showOverview } from "../lib/session.js";
import { FileBlock, groupByFile } from "./Diff.js";
import { Diagram, DiagramLegend } from "./Diagram.js";
import { GistFailure } from "./StepTab.js";

function Chapter({ story, step, total, isCurrent }) {
  const reviewed = useSession((s) => !!s.reviewed[step.id]);
  const wrap = useSession((s) => s.wrap);
  const files = useMemo(() => groupByFile(step.hunks), [step]);
  const ready = step.status === "ready";
  const failed = step.status === "failed";
  const next = story.steps[step.order];
  const hunkCount = step.hunks.length;
  const num = String(step.order).padStart(2, "0");
  const diagram = ready && step.diagram && step.diagram.nodes?.length ? step.diagram : null;
  const gist = ready ? step.gist || step.explanation || step.summary : null;
  const finish = () => {
    if (!reviewed && ready) toggleReviewed(step.id);
    if (story.extras?.length) {
      const el = document.getElementById("extras");
      if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 70, behavior: "smooth" });
    } else session.set((s) => ({ review: { ...s.review, open: true } }));
  };

  return html`<article class=${cx("chapter", isCurrent && "current", reviewed && "reviewed", !ready && "pending")} data-step=${step.id} id=${step.id}>
    <header class="ch-head">
      <div class="ch-num"><span>${num}</span><i>of ${total}</i></div>
      <div class="ch-title">
        <div class="ch-meta">
          <span class=${"kindchip kind-" + step.kind}>${KIND_LABEL[step.kind] || step.kind}</span>
          <span class="muted">${hunkCount} hunk${hunkCount === 1 ? "" : "s"} · ${files.length} file${files.length === 1 ? "" : "s"}</span>
          ${!ready && !failed ? html`<span class="writing"><i class="spin"></i>Writing the gist</span>` : null}
        </div>
        <h2>${step.title}</h2>
        ${gist ? html`<div class="ch-gist"><${Md} text=${gist} /></div>` : null}
        ${failed ? html`<${GistFailure} step=${step} />` : null}
      </div>
    </header>

    ${diagram
      ? html`<section class="ch-diagram">
          <div class="dg-head">
            <span class="eyebrow-s">${diagram.title || "Diagram"}</span>
            <button class="link" onClick=${() => session.set({ expandDiagram: { diagram, stepId: step.id } })}>Enlarge</button>
          </div>
          <div class="diagram-card">
            <${Diagram} diagram=${diagram} showLabels=${true} onNodeClick=${(n) => jumpToNode(step.id, n)} canClick=${(n) => nodeIsLinked(step.id, n)} />
          </div>
          <${DiagramLegend} clickable=${true} />
        </section>`
      : null}

    <section class=${cx("ch-section", "changes", wrap && "wrap")}>
      <div class="sec-head">
        <h3>Changes</h3>
        <span class="muted">${hunkCount} hunk${hunkCount === 1 ? "" : "s"}</span>
        <span class="sec-tools">
          <label class="toggle"><input type="checkbox" checked=${wrap} onChange=${(e) => { localStorage.setItem("prx.wrap", e.currentTarget.checked ? "1" : "0"); session.set({ wrap: e.currentTarget.checked }); }} /><span>Wrap long lines</span></label>
        </span>
      </div>
      ${ready || failed || step.status === "retrying"
        ? files.map((f) => html`<${FileBlock} key=${f.path} path=${f.path} hunks=${f.hunks} step=${step} />`)
        : html`<div class="hunks-wait">Diff appears when the gist is ready.</div>`}
    </section>

    <footer class="ch-foot">
      ${next
        ? html`<button class="btn primary" onClick=${() => { if (!reviewed && ready) toggleReviewed(step.id); goStep(next.id); }}>
            ${ready && !reviewed ? "Mark reviewed and continue" : "Continue"} <span class="nxt">step ${next.order} · ${next.title} →</span>
          </button>`
        : html`<button class="btn primary" onClick=${finish}>${story.extras?.length ? "Mark reviewed · tests and docs ↓" : "Finish and write the review →"}</button>`}
    </footer>
  </article>`;
}

function ExtraFile({ f, step }) {
  const open = useSession((s) => !!s.extrasOpen[f.path]);
  const st = f.hunks.reduce((a, h) => { const s = hunkStats(h.patch); return { add: a.add + s.add, del: a.del + s.del }; }, { add: 0, del: 0 });
  return html`<li class=${cx("extra", open && "open")} data-file=${"extras|" + f.path}>
    <button class="extra-row" aria-expanded=${open} onClick=${() => setExtrasOpen([f.path], !open)}>
      <span class=${cx("chev", open && "open")} aria-hidden="true"></span>
      <span class="extra-main">
        <span class="file-path"><span class="dir">${dirName(f.path)}/</span><b>${fileName(f.path)}</b></span>
        ${f.notes.map((n) => html`<span class="extra-note">${inline(n)}</span>`)}
      </span>
      <span class="hh-stats"><b class="plus">+${st.add}</b> <b class="minus">−${st.del}</b></span>
    </button>
    ${open ? html`<div class="extra-diff"><${FileBlock} path=${f.path} hunks=${f.hunks} step=${step} bare=${true} /></div>` : null}
  </li>`;
}

function Extras({ story }) {
  const step = useMemo(() => ({ id: "extras", order: story.steps.length + 1, title: "Tests and docs", hunks: story.extras.flatMap((f) => f.hunks) }), [story.extras]);
  const tests = story.extras.filter((f) => f.kind === "test");
  const docs = story.extras.filter((f) => f.kind === "doc");
  const paths = story.extras.map((f) => f.path);
  const allOpen = useSession((s) => paths.every((p) => s.extrasOpen[p]));
  const anyOpen = useSession((s) => paths.some((p) => s.extrasOpen[p]));
  const group = (title, list) => (list.length ? html`<div class="extra-group"><h3>${title}</h3><ul class="extras">${list.map((f) => html`<${ExtraFile} key=${f.path} f=${f} step=${step} />`)}</ul></div>` : null);
  return html`<section class="extras-sec" id="extras" data-step="extras">
    <header>
      <div class="sec-head">
        <h2>Tests and docs</h2>
        <span class="sec-tools">
          <button class="link" disabled=${allOpen} onClick=${() => setExtrasOpen(paths, true)}>Expand all</button>
          <button class="link" disabled=${!anyOpen} onClick=${() => setExtrasOpen(paths, false)}>Collapse all</button>
        </span>
      </div>
      <p class="muted">${tests.length} test file${tests.length === 1 ? "" : "s"}${docs.length ? " and " + docs.length + " doc file" + (docs.length === 1 ? "" : "s") : ""}, kept out of the steps. Open a file to see its diff.</p>
    </header>
    ${group("Tests", tests)}
    ${group("Docs", docs)}
    <footer class="ch-foot">
      <button class="btn primary" onClick=${() => session.set((s) => ({ review: { ...s.review, open: true } }))}>Finish and write the review →</button>
    </footer>
  </section>`;
}

export function Walkthrough({ story }) {
  const raf = useRef(0);

  useEffect(() => {
    const onScroll = () => {
      if (raf.current) return;
      raf.current = requestAnimationFrame(() => {
        raf.current = 0;
        if (navLocked()) return;
        const els = [...document.querySelectorAll("article[data-step]")];
        if (!els.length) return;
        let cur = els[0];
        for (const el of els) if (el.getBoundingClientRect().top <= 150) cur = el;
        const id = cur.dataset.step;
        if (id !== session.get().current) {
          session.set({ current: id });
          setHash(id);
        }
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
  }, []);

  const current = useSession((s) => s.current);
  const done = story.generation.status === "done" || story.steps.every((s) => s.status === "ready");
  return html`<div class="story">
    <div class="story-top">
      <button class="link" onClick=${showOverview}>← Overview</button>
    </div>
    ${story.steps.map((s) => html`<${Chapter} key=${s.id} story=${story} step=${s} total=${story.steps.length} isCurrent=${s.id === current} />`)}
    ${story.generation.status === "explaining" ? html`<div class="more-coming"><i class="spin"></i>More steps are still being written…</div>` : null}
    ${done && story.extras?.length ? html`<${Extras} story=${story} />` : null}
  </div>`;
}
