import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { parsePrUrl } from "../lib/loader.js";
import { listPrs, keyOf } from "../lib/api.js";
import { hasSeen } from "../lib/generation.js";
import { cx } from "../lib/util.js";

const STATUS = { queued: "Queued", planning: "Planning", explaining: "Explaining", done: "Ready", failed: "Failed" };

export function Entry({ go, goPr, goSettings }) {
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState(null);
  const [prs, setPrs] = useState(null);
  const [down, setDown] = useState(false);
  const [manual, setManual] = useState("");

  useEffect(() => {
    let dead = false;
    const load = () =>
      listPrs()
        .then((l) => !dead && (setPrs(l), setDown(false)))
        .catch(() => !dead && setDown(true));
    load();
    const id = setInterval(load, 4000);
    return () => ((dead = true), clearInterval(id));
  }, []);

  const submit = (e) => {
    e?.preventDefault();
    const p = parsePrUrl(value);
    if (!p) return setProblem({ error: "invalid" });
    goPr(keyOf(p.owner, p.repo, p.number));
  };

  return html`<main class="entry">
    <div class="entry-wrap">
      <div class="entry-brand"><span class="brand-mark">¶</span>PR Explainer<button class="btn ghost small entry-settings" onClick=${goSettings}>Settings</button></div>
      <h1>Read a pull request in the order it makes sense.</h1>
      <p class="entry-lede">Paste a PR link. You get a review order, a short gist for each step, and a diagram only where a step needs one. The diff comes along, step by step.</p>

      <form class="url-form" onSubmit=${submit}>
        <input
          type="text"
          value=${value}
          placeholder="https://github.com/owner/repo/pull/123"
          aria-label="Pull request URL"
          spellcheck="false"
          onInput=${(e) => {
            setValue(e.currentTarget.value);
            setProblem(null);
          }}
        />
        <button class="btn primary big" type="submit" disabled=${!value.trim()}>Explain this PR</button>
      </form>

      ${problem?.error === "invalid"
        ? html`<div class="notice"><b>That does not look like a GitHub pull request link.</b> It should look like <code>https://github.com/owner/repo/pull/123</code>.</div>`
        : null}
      ${down ? html`<div class="notice"><b>The PR Explainer service is not running.</b> Start it with <code>cd service && npm start</code>. It listens on 127.0.0.1:5190.</div>` : null}

      <section class="queue">
        <div class="queue-head">
          <h2>Your PRs</h2>
          <span class="muted">Stories the service has made or is making</span>
        </div>
        <ul>
          ${(prs || []).map(
            (p) => html`<li key=${p.repo + p.number}>
              <button class=${cx("qrow", p.status === "done" ? "ready" : "queued")} onClick=${() => goPr(keyOf(...p.repo.split("/"), p.number))}>
                <span class="q-main">
                  <span class="q-title">${p.title}</span>
                  <span class="q-sub">${p.repo} #${p.number} · ${p.author}${p.openThreads ? " · " + p.openThreads + " open thread" + (p.openThreads === 1 ? "" : "s") : ""}</span>
                </span>
                <span class="q-size"></span>
                <span class=${cx("q-status", p.status === "done" && !p.outdated ? "ready" : "queued")}>
                  <i class="dot"></i>${p.status === "done" && p.outdated ? "Outdated" : STATUS[p.status] || p.status}${p.status === "explaining" && p.progress?.total ? " " + p.progress.ready + "/" + p.progress.total : ""}
                </span>
              </button>
            </li>`
          )}
          ${prs && !prs.length ? html`<li class="muted">No stories yet. Paste a PR link above.</li>` : null}
        </ul>
      </section>

      <details class="load-json">
        <summary>Load a story file</summary>
        <form onSubmit=${(e) => (e.preventDefault(), manual.trim() && go(manual.trim()))}>
          <input type="text" value=${manual} onInput=${(e) => setManual(e.currentTarget.value)} placeholder="story name or URL, for example /pipeline/my-pr.json" aria-label="Story name or URL" />
          <button class="btn" type="submit">Open</button>
        </form>
      </details>

      <p class="entry-foot">Stories, review threads, chat and review submit run through the local service.</p>
    </div>
  </main>`;
}
