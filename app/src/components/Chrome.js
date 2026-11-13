import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { cx, fmtSec, sleep } from "../lib/util.js";
import { fakeSummary } from "../lib/chat.js";
import { session, useSession, removeReply, showOverview, goStep, draftCount, openChat, toast, jumpToNode, nodeIsLinked, live } from "../lib/session.js";
import { postReview, getThreads, replyThread, exportUrl } from "../lib/api.js";
import { openSettings } from "../lib/setup.js";
import { isExport } from "../lib/mode.js";
import { Diagram, DiagramLegend } from "./Diagram.js";
import { CommentCard } from "./Diff.js";

const PHASE = { queued: "Queued", planning: "Planning the review order", explaining: "Writing step gists", done: "Done", failed: "Failed" };

export function Header({ story, elapsed, simulated, regenerating, onRegenerate, navigateHome }) {
  const view = useSession((s) => s.view);
  const reviewed = useSession((s) => s.reviewed);
  const comments = useSession((s) => s.comments);
  const review = useSession((s) => s.review);
  const current = useSession((s) => s.current);
  const asideOpen = useSession((s) => s.asideOpen);
  const n = draftCount({ comments });
  const gen = story.generation;
  const generating = !["done", "failed"].includes(gen.status);
  const ready = story.steps.filter((s) => s.status === "ready").length;
  const total = story.steps.length;
  const done = story.steps.filter((s) => reviewed[s.id]).length;
  const pct = gen.status === "done" ? 100 : total ? 12 + (ready / total) * 88 : gen.status === "queued" ? 3 : 10;
  const label = generating
    ? gen.status === "explaining" && total
      ? `${PHASE[gen.status]} · ${ready} of ${total} steps`
      : PHASE[gen.status] || "Working"
    : gen.status === "failed"
    ? "Generation failed"
    : simulated
    ? `Analysed in ${fmtSec(story.generation.timings?.totalMs ?? elapsed)}`
    : `Analysed in ${fmtSec(gen.timings?.totalMs ?? 0)}`;
  const verdictLabel = { comment: "Commented", approve: "Approved", request_changes: "Changes requested" };

  return html`<header class="topbar">
    ${navigateHome
      ? html`<button class="brand" onClick=${navigateHome} aria-label="Back to start"><span class="brand-mark">¶</span><span>PR Explainer</span></button>`
      : html`<span class="brand"><span class="brand-mark">¶</span><span>PR Explainer</span></span>`}
    <div class="crumb" title=${story.pr.title}>
      <a href=${story.pr.url} target="_blank" rel="noreferrer">${story.pr.repo} #${story.pr.number}</a>
    </div>
    <nav class="modes" role="tablist">
      <button role="tab" aria-selected=${view === "overview"} class=${cx("mode", view === "overview" && "on")} onClick=${showOverview}>Overview</button>
      <button role="tab" aria-selected=${view === "walk"} class=${cx("mode", view === "walk" && "on")} disabled=${!total} onClick=${() => goStep(current || story.steps[0].id)}>Walkthrough</button>
    </nav>
    <div class="top-right">
      <div class=${cx("genstate", generating && "live")} role="status" aria-live="polite">
        ${generating ? html`<i class="spin"></i>` : gen.status === "failed" ? html`<i class="x">!</i>` : html`<i class="okdot"></i>`}
        <span>${label}</span>
        ${generating ? html`<span class="elapsed">${fmtSec(elapsed)}</span>` : null}
      </div>
      ${total ? html`<div class="reviewprog" title="Steps you marked as reviewed"><div class="prog-bar"><i style=${{ width: (done / total) * 100 + "%" }}></i></div><span>${done}/${total}</span></div>` : null}
      ${isExport()
        ? null
        : html`<${TopMenu} story=${story} view=${view} asideOpen=${asideOpen} generating=${generating} regenerating=${regenerating} onRegenerate=${onRegenerate} />`}
      <button class="btn primary" onClick=${() => session.set((s) => ({ review: { ...s.review, open: true } }))}>
        ${review.submitted ? verdictLabel[review.submitted.verdict] : "Review"}${n ? html`<span class="count">${n}</span>` : null}
      </button>
    </div>
    ${generating || gen.status === "done" && simulated && elapsed < (story.generation.timings?.totalMs || 0) + 1200 ? html`<div class="genbar"><i style=${{ width: pct + "%" }}></i></div>` : null}
  </header>`;
}

// ---------- top bar menu ----------
function TopMenu({ story, view, asideOpen, generating, regenerating, onRegenerate }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => !wrap.current?.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const chat = view === "overview";
  const item = (label, onClick, { tick, busy, disabled, title } = {}) =>
    html`<button class="menu-item" role="menuitem" disabled=${disabled} title=${title} onClick=${() => (setOpen(false), onClick())}>
      <span>${label}</span>
      ${busy ? html`<i class="spin tiny"></i>` : null}
      ${tick ? html`<span class="menu-tick" aria-hidden="true">✓</span>` : null}
    </button>`;
  const rs = [chat ? item("Chat", () => (asideOpen ? session.set({ asideOpen: false }) : openChat()), { tick: asideOpen }) : null];
  const tools = [
    onRegenerate ? item(regenerating ? "Regenerating…" : "Regenerate", onRegenerate, { busy: regenerating, disabled: generating || regenerating, title: "Rebuild the explanation from the latest PR commits" }) : null,
    live.prKey
      ? html`<a class="menu-item" role="menuitem" href=${exportUrl(live.prKey)} title="Download this story as one HTML file you can send to someone" onClick=${() => setOpen(false)}>Export</a>`
      : null,
    item("Settings", openSettings),
  ].filter(Boolean);
  return html`<div class="menu-wrap" ref=${wrap}>
    <button class="btn ghost menu-btn" aria-haspopup="menu" aria-expanded=${open} aria-label="More actions" title="More actions" onClick=${() => setOpen(!open)}>⋯</button>
    ${open
      ? html`<div class="menu" role="menu" aria-label="More actions">
          ${rs}
          ${rs.some(Boolean) && tools.length ? html`<div class="menu-sep"></div>` : null}
          ${tools}
        </div>`
      : null}
  </div>`;
}

// ---------- review dialog ----------
const VERDICTS = [
  ["comment", "Comment", "General feedback. No decision."],
  ["approve", "Approve", "This is ready to merge."],
  ["request_changes", "Request changes", "These points must change first."],
];

const EMPTY = {};

export function ReviewDialog({ story }) {
  const review = useSession((s) => s.review);
  const comments = useSession((s) => s.comments);
  const reviewed = useSession((s) => s.reviewed);
  const drafts = comments.filter((c) => !c.posted);
  const replies = useSession((s) => s.replies || EMPTY);
  const replyIds = Object.keys(replies);
  const lastAuto = useRef("");
  const ta = useRef(null);

  useEffect(() => {
    if (!review.open || review.status !== "idle" || live.prKey) return;
    const auto = fakeSummary(review.verdict, drafts, story);
    if (!review.summary || review.summary === lastAuto.current) {
      lastAuto.current = auto;
      session.set((s) => ({ review: { ...s.review, summary: auto } }));
    }
  }, [review.open, review.verdict, drafts.length]);

  useEffect(() => {
    if (!review.open) return;
    const onKey = (e) => e.key === "Escape" && review.status !== "sending" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [review.open, review.status]);

  if (!review.open) return null;
  const close = () => session.set((s) => ({ review: { ...s.review, open: false, status: s.review.status === "done" ? "idle" : s.review.status } }));
  const set = (patch) => session.set((s) => ({ review: { ...s.review, ...patch } }));
  const unreviewed = story.steps.filter((s) => !reviewed[s.id]).length;

  const submit = async () => {
    set({ status: "sending", error: null });
    if (live.prKey) {
      const lineDrafts = drafts.filter((c) => c.path && c.line != null);
      const loose = drafts.filter((c) => !(c.path && c.line != null));
      const body = [review.summary.trim(), ...loose.map((c) => c.body)].filter(Boolean).join("\n\n");
      const event = { comment: "COMMENT", approve: "APPROVE", request_changes: "REQUEST_CHANGES" }[review.verdict];
      try {
        const res = await postReview(live.prKey, {
          event,
          body,
          expectedHeadSha: story.pr.headSha,
          comments: lineDrafts.map((c) => {
            const side = c.side || "RIGHT";
            return {
              path: c.path,
              line: c.line,
              side,
              ...(c.startLine != null && c.startLine < c.line ? { startLine: c.startLine, startSide: c.startSide || side } : {}),
              body: c.body,
            };
          }),
        });
        let sent = 0;
        let replyError = null;
        for (const id of replyIds) {
          try {
            await replyThread(id, replies[id]);
            removeReply(id);
            sent++;
          } catch (e) {
            replyError = e.message;
            break;
          }
        }
        session.set((s) => ({
          comments: s.comments.map((c) => ({ ...c, posted: true })),
          review: { ...s.review, status: "done", submitted: { verdict: s.review.verdict, count: drafts.length, replies: sent, replyError, url: res.url, moved: res.movedToFileLevel?.length || 0 } },
        }));
        getThreads(live.prKey, true).then((t) => session.set({ threads: t })).catch(() => {});
      } catch (e) {
        const msg = e.code === "head_moved" ? "The PR has new commits since this story was made. Reload the PR to review the latest version. Nothing was posted." : e.message;
        set({ status: "idle", error: msg });
      }
      return;
    }
    await sleep(1100);
    session.set((s) => ({
      comments: s.comments.map((c) => ({ ...c, posted: true })),
      review: { ...s.review, status: "done", submitted: { verdict: s.review.verdict, count: drafts.length } },
    }));
  };

  return html`<div class="modal-back" onMouseDown=${(e) => e.target === e.currentTarget && review.status !== "sending" && close()}>
    <div class="modal review" role="dialog" aria-modal="true" aria-label="Finish your review">
      ${review.status === "done"
        ? html`<div class="done-view">
            <div class="done-mark">✓</div>
            <h2>Review submitted</h2>
            <p>${review.submitted.count} comment${review.submitted.count === 1 ? "" : "s"} posted with a "${VERDICTS.find((v) => v[0] === review.submitted.verdict)[1]}" review.</p>
            ${review.submitted.replies ? html`<p>${review.submitted.replies} thread repl${review.submitted.replies === 1 ? "y" : "ies"} posted.</p>` : null}
            ${review.submitted.replyError ? html`<p class="review-error">Some replies were not posted and are still drafts: ${review.submitted.replyError}</p>` : null}
            ${review.submitted.url
              ? html`<p><a href=${review.submitted.url} target="_blank" rel="noreferrer">Open the review on GitHub ↗</a>${review.submitted.moved ? html`<br /><span class="muted">${review.submitted.moved} comment${review.submitted.moved === 1 ? " was" : "s were"} outside the diff and posted as file comments.</span>` : null}</p>`
              : html`<p class="muted">This is a demo. Nothing was sent to GitHub.</p>`}
            <button class="btn primary" onClick=${close}>Close</button>
          </div>`
        : html`
          <header class="modal-head">
            <h2>Finish your review</h2>
            <button class="icon-btn" aria-label="Close" onClick=${close}>×</button>
          </header>
          <div class="verdicts" role="radiogroup">
            ${VERDICTS.map(
              ([id, name, hint]) => html`<label class=${cx("verdict", "v-" + id, review.verdict === id && "on")}>
                <input type="radio" name="verdict" checked=${review.verdict === id} onChange=${() => set({ verdict: id })} />
                <b>${name}</b><span>${hint}</span>
              </label>`
            )}
          </div>
          <label class="field">
            <span>Summary</span>
            <textarea ref=${ta} rows="6" value=${review.summary} onInput=${(e) => set({ summary: e.currentTarget.value })} placeholder="Say what you found, in a few lines" />
          </label>
          <div class="review-facts">
            ${replyIds.length ? html`<div><b>${replyIds.length}</b> thread repl${replyIds.length === 1 ? "y" : "ies"} will be posted</div>` : null}
            <div><b>${drafts.length}</b> inline comment${drafts.length === 1 ? "" : "s"} will be posted${drafts.some((c) => c.kind === "clarification") ? " (including questions for the author)" : ""}</div>
            ${unreviewed ? html`<div class="warn"><b>${unreviewed}</b> of ${story.steps.length} steps are not marked as reviewed</div>` : html`<div class="ok">All ${story.steps.length} steps reviewed</div>`}
          </div>
          ${drafts.length
            ? html`<details class="draft-list"><summary>Show the drafts</summary>${drafts.map((c) => html`<${CommentCard} key=${c.id} c=${c} />`)}</details>`
            : null}
          ${review.error ? html`<p class="review-error">${review.error}</p>` : null}
          <footer class="modal-foot">
            <button class="btn ghost" onClick=${close} disabled=${review.status === "sending"}>Cancel</button>
            <button class=${cx("btn primary", review.verdict === "request_changes" && "danger")} onClick=${submit} disabled=${review.status === "sending" || !review.summary.trim() && !drafts.length && !replyIds.length}>
              ${review.status === "sending" ? html`<i class="spin light"></i>Submitting…` : "Submit review"}
            </button>
          </footer>`}
    </div>
  </div>`;
}

// ---------- large diagram ----------
export function ExpandModal() {
  const ex = useSession((s) => s.expandDiagram);
  const reviewed = useSession((s) => s.reviewed);
  useEffect(() => {
    if (!ex) return;
    const onKey = (e) => e.key === "Escape" && session.set({ expandDiagram: null });
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ex]);
  if (!ex) return null;
  return html`<div class="modal-back" onMouseDown=${(e) => e.target === e.currentTarget && session.set({ expandDiagram: null })}>
    <div class="modal big-diagram" role="dialog" aria-modal="true" aria-label=${ex.diagram.title || "Diagram"}>
      <header class="modal-head"><h2>${ex.diagram.title || "Diagram"}</h2><button class="icon-btn" aria-label="Close" onClick=${() => session.set({ expandDiagram: null })}>×</button></header>
      <div class="diagram-card big"><${Diagram} diagram=${ex.diagram} maxScale=${1.7} showLabels=${true} reviewed=${reviewed} onNodeClick=${ex.stepId ? (n) => (session.set({ expandDiagram: null }), jumpToNode(ex.stepId, n)) : null} canClick=${ex.stepId ? (n) => nodeIsLinked(ex.stepId, n) : null} /></div>
      <${DiagramLegend} clickable=${!!ex.stepId} />
    </div>
  </div>`;
}

export function Toast() {
  const t = useSession((s) => s.toast);
  if (!t) return null;
  return html`<div class=${cx("toast", t.tone)} role="status" key=${t.id}>${t.text}</div>`;
}
