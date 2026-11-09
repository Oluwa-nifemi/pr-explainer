import { html } from "htm/preact";
import { useMemo } from "preact/hooks";
import { inline, Md } from "../lib/md.js";
import { cx, KIND_LABEL } from "../lib/util.js";
import { hunkStats } from "../lib/diff.js";
import { hunkRole } from "../lib/prepare.js";
import { useSession, goStep } from "../lib/session.js";

const RISK = { low: "Low risk", medium: "Medium risk", high: "High risk" };
const ROLE_ROWS = [["source", "Source"], ["test", "Tests"], ["generated", "Generated"], ["docs", "Docs"], ["config", "Config"]];

// Files and changed lines per file role, from the hunks. Files outside every step show as one "Skipped" row.
function roleBreakdown(story) {
  const by = {};
  [...story.steps.flatMap((s) => s.hunks), ...(story.extras || []).flatMap((f) => f.hunks)].forEach((h) => {
    const r = (by[hunkRole(h)] ||= { paths: new Set(), add: 0, del: 0 });
    const st = hunkStats(h.patch);
    r.paths.add(h.path);
    r.add += st.add;
    r.del += st.del;
  });
  const rows = ROLE_ROWS.filter(([k]) => by[k]).map(([k, label]) => ({ key: k, label, files: by[k].paths.size, add: by[k].add, del: by[k].del }));
  const skipped = story.skippedFiles || [];
  if (rows.length && skipped.length) {
    const add = rows.reduce((a, r) => a + r.add, 0);
    const del = rows.reduce((a, r) => a + r.del, 0);
    rows.push({ key: "skipped", label: "Skipped", files: skipped.length, add: Math.max(0, story.pr.additions - add), del: Math.max(0, story.pr.deletions - del) });
  }
  const total = rows.reduce((a, r) => ({ files: a.files + r.files, add: a.add + r.add, del: a.del + r.del }), { files: 0, add: 0, del: 0 });
  return { rows, total };
}

function DiffPill({ story }) {
  const { pr } = story;
  const { rows, total } = useMemo(() => roleBreakdown(story), [story]);
  const label = html`<b class="plus">+${pr.additions}</b> <b class="minus">−${pr.deletions}</b>`;
  if (!rows.length) return html`<span class="fact">${label}</span>`;
  return html`<span class="fact diffpill" tabindex="0" aria-describedby="diff-pop">
    ${label}
    <span class="popover" id="diff-pop" role="tooltip">
      <span class="pop-title">Changes by file type</span>
      ${rows.map((r) => html`<span class="pop-row" key=${r.key}><span class="pop-name">${r.label}</span><span class="pop-files">${r.files} file${r.files === 1 ? "" : "s"}</span><span class="pop-diff"><b class="plus">+${r.add}</b> <b class="minus">−${r.del}</b></span></span>`)}
      <span class="pop-row total"><span class="pop-name">Total</span><span class="pop-files">${total.files} file${total.files === 1 ? "" : "s"}</span><span class="pop-diff"><b class="plus">+${total.add}</b> <b class="minus">−${total.del}</b></span></span>
    </span>
  </span>`;
}

function stepStats(step) {
  let add = 0;
  let del = 0;
  step.hunks.forEach((h) => {
    const s = hunkStats(h.patch);
    add += s.add;
    del += s.del;
  });
  const files = new Set(step.hunks.map((h) => h.path)).size;
  return { add, del, files };
}

function Skel({ lines = 3, w = [100, 92, 64] }) {
  return html`<div class="skel-block">${Array.from({ length: lines }, (_, i) => html`<span class="skel" style=${{ width: w[i % w.length] + "%" }}></span>`)}</div>`;
}

export function Overview({ story }) {
  const reviewed = useSession((s) => s.reviewed);
  const { pr, summary, steps } = story;
  const extras = story.extras || [];
  const readyCount = steps.filter((s) => s.status === "ready").length;
  const doneCount = steps.filter((s) => reviewed[s.id]).length;
  const description = String(pr.body || "").replace(/<!--[\s\S]*?-->/g, "").replace(/\r/g, "").trim();

  return html`<div class="overview">
    <header class="ov-hero">
      <div class="eyebrow">
        <a href=${pr.url} target="_blank" rel="noreferrer">${pr.repo} #${pr.number}</a>
        <span>·</span><span>${pr.author}</span>
        <span>·</span><span class="branch">${pr.headRef} → ${pr.baseRef}</span>
      </div>
      <h1>${pr.title}</h1>
      <div class="facts">
        ${summary
          ? html`<span class=${cx("fact", "risk-" + summary.risk)}><i class="dot"></i>${RISK[summary.risk]}</span>`
          : html`<span class="fact skel-chip"></span>`}
        <${DiffPill} story=${story} />
        <span class="fact"><b>${pr.changedFiles}</b> files</span>
        <span class="fact"><b>${steps.length || "…"}</b> steps</span>
      </div>
    </header>

    <div class="ov-stack">
      <section class="ov-sec">
        <h2>Why this exists</h2>
        ${summary ? html`<p class="lede">${inline(summary.why)}</p>` : html`<${Skel} lines=${3} />`}
      </section>
      <section class="ov-sec">
        <h2>What changed</h2>
        ${summary
          ? html`<ul class="bullets">${summary.whatChanged.map((b) => html`<li>${inline(b)}</li>`)}</ul>`
          : html`<${Skel} lines=${4} w=${[96, 88, 92, 70]} />`}
      </section>
    </div>

    ${summary
      ? html`<section class=${cx("riskbox", "risk-" + summary.risk)}>
          <div class="riskbox-head"><i class="dot"></i>${RISK[summary.risk]}</div>
          <p>${inline(summary.riskReason)}</p>
        </section>`
      : null}

    ${description
      ? html`<details class="pr-desc">
          <summary>PR description <span class="muted">by ${pr.author}</span></summary>
          <div class="pr-desc-body"><${Md} text=${description} /></div>
        </details>`
      : null}

    <section class="ov-sec wide">
      <div class="sec-head">
        <h2>Review plan</h2>
        <span class="muted">${doneCount} of ${steps.length} reviewed${readyCount < steps.length ? ` · ${readyCount} of ${steps.length} written` : ""}</span>
      </div>
      ${steps.length
        ? html`<ol class="plan">
            ${steps.map((s) => {
              const st = stepStats(s);
              const ready = s.status === "ready";
              return html`<li key=${s.id} class=${cx("plan-row", !ready && "pending", reviewed[s.id] && "done")}>
                <button onClick=${() => goStep(s.id)}>
                  <span class="plan-num">${reviewed[s.id] ? "✓" : s.order}</span>
                  <span class="plan-main">
                    <span class="plan-title">${s.title}<span class=${"kindchip kind-" + s.kind}>${KIND_LABEL[s.kind] || s.kind}</span></span>
                    <span class="plan-sum">${s.summary}</span>
                  </span>
                  <span class="plan-meta">
                    ${ready ? html`<span><b class="plus">+${st.add}</b> <b class="minus">−${st.del}</b></span><span class="muted">${st.files} file${st.files === 1 ? "" : "s"}</span>` : html`<span class="writing"><i class="spin"></i>writing</span>`}
                  </span>
                </button>
              </li>`;
            })}
          </ol>`
        : html`<div class="skel-card tall"></div>`}
      ${extras.length
        ? html`<p class="plan-extras muted">After the steps: ${extras.filter((x) => x.kind === "test").length} test files and ${extras.filter((x) => x.kind === "doc").length} doc files, collapsed, with a one-line note each.</p>`
        : null}
    </section>

    ${story.skippedFiles.length
      ? html`<section class="ov-sec wide">
          <h2>Skipped files</h2>
          <p class="muted">These files are not in any step.</p>
          <ul class="skipped">${story.skippedFiles.map((f) => html`<li><code>${f.path}</code><span class="tag">${f.reason}</span></li>`)}</ul>
        </section>`
      : null}

  </div>`;
}
