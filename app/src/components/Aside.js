import { html } from "htm/preact";
import { cx, KIND_LABEL } from "../lib/util.js";
import { session, useSession, goStep, jumpToLine, draftCount, removeReply } from "../lib/session.js";
import { StepTab, FilesTab } from "./StepTab.js";
import { CommentCard } from "./Diff.js";
import { ChatPanel } from "./Chat.js";

// ---------- plan tab ----------
function PlanTab({ story }) {
  const current = useSession((s) => s.current);
  const reviewed = useSession((s) => s.reviewed);
  const done = story.steps.filter((s) => reviewed[s.id]).length;
  const total = story.steps.length;
  return html`<div class="plan-tab">
    <div class="prog">
      <div class="prog-bar"><i style=${{ width: total ? (done / total) * 100 + "%" : "0%" }}></i></div>
      <span>${done} of ${total} reviewed</span>
    </div>
    <ol class="mini-plan">
      ${story.steps.map(
        (s) => html`<li class=${cx(s.id === current && "current", reviewed[s.id] && "done", s.status !== "ready" && "pending")} key=${s.id}>
          <button onClick=${() => goStep(s.id)}>
            <span class="mp-dot">${reviewed[s.id] ? "✓" : s.status !== "ready" ? html`<i class="spin tiny"></i>` : s.order}</span>
            <span class="mp-title">${s.title}</span>
            <span class="mp-kind">${KIND_LABEL[s.kind] || s.kind}</span>
          </button>
        </li>`
      )}
    </ol>
    <div class="keys">
      <span><kbd>j</kbd><kbd>k</kbd> or <kbd>←</kbd><kbd>→</kbd> next and previous step</span>
      <span><kbd>r</kbd> mark reviewed</span>
      <span><kbd>c</kbd> open chat</span>
    </div>
  </div>`;
}

// ---------- comments tab ----------
function CommentsTab({ story }) {
  const comments = useSession((s) => s.comments);
  const replies = useSession((s) => s.replies || {});
  const threads = useSession((s) => s.threads);
  const n = draftCount({ comments, replies });
  const replyList = Object.keys(replies).map((id) => ({ id, body: replies[id], t: (threads?.threads || []).find((x) => x.id === id) }));
  const jumpReply = (t) => {
    const stepId = t?.placement?.stepId;
    if (!stepId) return;
    goStep(stepId);
    if (t.path && t.line != null) setTimeout(() => jumpToLine({ stepId, path: t.path, line: t.line }), 450);
  };
  const byStep = story.steps.map((st) => ({ st, list: comments.filter((c) => c.stepId === st.id) })).filter((x) => x.list.length);
  const extra = comments.filter((c) => c.stepId === "extras");
  const toExtras = () => document.getElementById("extras")?.scrollIntoView({ behavior: "smooth" });
  return html`<div class="comments-tab">
    ${comments.length === 0 && !replyList.length
      ? html`<div class="chat-empty"><p class="chat-hint">No comments yet. Click any line in a diff to add a draft comment.</p></div>`
      : html`<div class="clist">
          ${byStep.map(
            ({ st, list }) => html`<div class="cgroup" key=${st.id}>
              <button class="cgroup-head" onClick=${() => goStep(st.id)}>Step ${st.order} · ${st.title}</button>
              ${list.map((c) => html`<${CommentCard} key=${c.id} c=${c} onJump=${() => { goStep(st.id); if (c.scope !== "step") setTimeout(() => jumpToLine({ stepId: st.id, path: c.path, line: c.line }), 450); }} />`)}
            </div>`
          )}
          ${extra.length
            ? html`<div class="cgroup"><button class="cgroup-head" onClick=${toExtras}>Tests and docs</button>${extra.map((c) => html`<${CommentCard} key=${c.id} c=${c} onJump=${toExtras} />`)}</div>`
            : null}
          ${replyList.length
            ? html`<div class="cgroup"><div class="cgroup-head static">Thread replies</div>${replyList.map(({ id, body, t }) => html`<div class="ccard" key=${id}>
                <div class="ccard-head"><span class="ccard-kind">Reply to @${t?.comments?.[0]?.author.login || "thread"}</span><span class="badge badge-draft">Draft</span><button class="icon-btn" title="Discard draft" aria-label="Discard draft" onClick=${() => removeReply(id)}>×</button></div>
                <div class="ccard-body">${body}</div>
                ${t?.path ? html`<button class="link ccard-loc" onClick=${() => jumpReply(t)}>${t.path.split("/").pop()}${t.line != null ? ":" + t.line : ""}</button>` : null}
              </div>`)}</div>`
            : null}
        </div>`}
    <div class="tab-foot">
      <button class="btn primary wide" disabled=${!comments.length && false} onClick=${() => session.set((s) => ({ review: { ...s.review, open: true } }))}>
        Review and submit${n ? ` (${n} draft${n === 1 ? "" : "s"})` : ""}
      </button>
    </div>
  </div>`;
}

// ---------- aside shell ----------
export function Aside({ story, mode }) {
  const tab = useSession((s) => s.tab);
  const comments = useSession((s) => s.comments);
  const n = draftCount({ comments });
  const walk = mode === "walk";
  const active = !walk && ["step", "plan", "files"].includes(tab) ? "chat" : tab;
  const TabBtn = (id, label, badge) => html`<button role="tab" aria-selected=${active === id} class=${cx("tab", active === id && "on")} onClick=${() => session.set({ tab: id })}>${label}${badge ? html`<span class="tab-badge">${badge}</span>` : null}</button>`;
  return html`<aside class=${cx("aside", walk && "is-walk")}>
    <div class="tabs" role="tablist">
      ${walk ? TabBtn("step", "Step") : null}
      ${walk ? TabBtn("plan", "Plan") : null}
      ${walk ? TabBtn("files", "Files") : null}
      ${TabBtn("chat", "Chat")}
      ${TabBtn("comments", "Comments", n || null)}
    </div>
    <div class="tabbody">
      ${active === "step" ? html`<${StepTab} story=${story} />` : active === "plan" ? html`<${PlanTab} story=${story} />` : active === "files" ? html`<${FilesTab} story=${story} />` : active === "chat" ? html`<${ChatPanel} story=${story} />` : html`<${CommentsTab} story=${story} />`}
    </div>
  </aside>`;
}
