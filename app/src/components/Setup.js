import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { saveSetup, clearSetup } from "../lib/api.js";
import { setup, closeSettings } from "../lib/setup.js";
import { cx } from "../lib/util.js";

const TOKENS_URL = "https://github.com/settings/tokens";

function State({ ok, error, source, envName, okText }) {
  if (source === "env") return html`<p class="sf-state ok">Set by the environment variable <code>${envName}</code>. Change it there.</p>`;
  if (error) return html`<p class="sf-state bad" role="alert">${error}</p>`;
  if (ok) return html`<p class="sf-state ok">${okText}</p>`;
  return null;
}

export function Setup({ status, modal, embedded }) {
  const [github, setGithub] = useState("");
  const [key, setKey] = useState("");
  const [base, setBase] = useState(status.litellm.baseUrl || "");
  const [storyModel, setStoryModel] = useState(status.storyModel);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [saved, setSaved] = useState(false);
  const gh = status.github;
  const ll = status.litellm;
  const baseChanged = base.trim() && base.trim() !== ll.baseUrl;
  const storyChanged = storyModel !== status.storyModel;
  const dirty = github.trim() || key.trim() || baseChanged || storyChanged;

  const submit = async (e) => {
    e.preventDefault();
    const body = {};
    if (github.trim() && gh.source !== "env") body.githubToken = github.trim();
    if (key.trim() && ll.source !== "env") body.litellmApiKey = key.trim();
    if (baseChanged) body.litellmBaseUrl = base.trim();
    if (storyChanged) body.storyModel = storyModel;
    setBusy(true);
    setProblem(null);
    setSaved(false);
    try {
      const next = await saveSetup(body);
      if (!next.github.error) setGithub("");
      if (!next.litellm.error) setKey("");
      setBase(next.litellm.baseUrl || base);
      setStoryModel(next.storyModel);
      setSaved(next.ready);
      setup.set({ status: next });
    } catch (err) {
      setProblem(err.message);
    }
    setBusy(false);
  };

  const clear = async () => {
    if (!confirm("Remove the saved credentials? Values from environment variables stay.")) return;
    setBusy(true);
    try {
      setup.set({ status: await clearSetup() });
      setGithub("");
      setKey("");
      setSaved(false);
    } catch (err) {
      setProblem(err.message);
    }
    setBusy(false);
  };

  const form = html`<form class=${cx("setup", modal && "in-modal")} onSubmit=${submit}>
    <div class="setup-head">
      <h1>${modal ? "Settings" : "Set up PR Explainer"}</h1>
      ${modal ? html`<button type="button" class="icon-btn" aria-label="Close" onClick=${closeSettings}>×</button>` : null}
    </div>
    <p class="setup-lede">${modal ? "Credentials the service uses." : "The service needs two credentials before it can read a PR and write gists."}</p>

    <label class="sf">
      <span class="sf-label">GitHub token</span>
      <input type="password" autocomplete="off" spellcheck="false" value=${github} disabled=${gh.source === "env"} placeholder=${gh.source === "env" ? "Set by environment variable" : gh.ok ? "Saved. Paste a new token to replace it." : "ghp_… or github_pat_…"} onInput=${(e) => setGithub(e.currentTarget.value)} />
      <span class="sf-help">Create a token at <a href=${TOKENS_URL} target="_blank" rel="noreferrer">github.com/settings/tokens</a> with the scopes <code>repo</code> and <code>read:org</code>.</span>
      <${State} ok=${gh.ok} error=${gh.error} source=${gh.source} envName="PR_EXPLAINER_GITHUB_TOKEN" okText=${"Working. Signed in as " + gh.login + "."} />
    </label>

    <label class="sf">
      <span class="sf-label">LiteLLM API key</span>
      <input type="password" autocomplete="off" spellcheck="false" value=${key} disabled=${ll.source === "env"} placeholder=${ll.source === "env" ? "Set by environment variable" : ll.ok ? "Saved. Paste a new key to replace it." : "sk-…"} onInput=${(e) => setKey(e.currentTarget.value)} />
      <span class="sf-help">The key for your LiteLLM gateway. It must be allowed to use the story model you pick below.</span>
      <${State} ok=${ll.ok} error=${ll.error} source=${ll.source} envName="PR_EXPLAINER_LITELLM_API_KEY" okText=${"Working. " + ll.models.length + " models available."} />
    </label>

    <label class="sf">
      <span class="sf-label">LiteLLM base URL</span>
      <input type="text" spellcheck="false" value=${base} onInput=${(e) => setBase(e.currentTarget.value)} />
      <span class="sf-help">Without <code>/v1</code>. The service calls <code>/chat/completions</code> and <code>/models</code> under it.</span>
    </label>

    <div class="sf">
      <span class="sf-label">Story model</span>
      <div class="model-row" role="radiogroup" aria-label="Story model">
        ${[["deepseek", "DeepSeek"], ["opus", "Opus"]].map(
          ([id, label]) => html`<button type="button" role="radio" aria-checked=${storyModel === id} disabled=${status.storyModelSource === "env"} class=${cx("model-opt", storyModel === id && "on")} onClick=${() => setStoryModel(id)}><b>${label}</b></button>`
        )}
      </div>
      <span class="sf-help">The model that writes stories. Changing it marks saved stories as outdated. Regenerate them one at a time. Chat uses it as its default.</span>
      ${status.storyModelSource === "env" ? html`<p class="sf-state ok">Set by the environment variable <code>PR_EXPLAINER_STORY_MODEL</code>. Change it there.</p>` : null}
    </div>

    ${problem ? html`<p class="sf-state bad" role="alert">${problem}</p>` : null}
    ${saved ? html`<p class="sf-state ok">Saved. Everything works.</p>` : null}

    <div class="setup-actions">
      <button class="btn primary" type="submit" disabled=${busy || !dirty}>${busy ? html`<i class="spin light"></i>Checking…` : "Save"}</button>
      ${modal ? html`<button type="button" class="btn ghost" onClick=${closeSettings}>Close</button>` : null}
      ${modal ? html`<button type="button" class="btn ghost danger-text" disabled=${busy} onClick=${clear}>Clear saved credentials</button>` : null}
    </div>

    <p class="setup-foot">
      Saved values go to <code>~/.config/pr-explainer/credentials.json</code> (or <code>$XDG_CONFIG_HOME/pr-explainer/</code>; <code>%APPDATA%\\pr-explainer\\</code> on Windows), readable only by you.
      The environment variables <code>PR_EXPLAINER_GITHUB_TOKEN</code>, <code>PR_EXPLAINER_LITELLM_API_KEY</code> and <code>PR_EXPLAINER_LITELLM_BASE_URL</code> override the file. The service never shows saved values again.
    </p>
  </form>`;

  if (embedded) return form;
  if (modal) return html`<div class="modal-back" onMouseDown=${(e) => e.target === e.currentTarget && closeSettings()}><div class="modal setup-modal" role="dialog" aria-modal="true" aria-label="Settings">${form}</div></div>`;
  return html`<main class="entry"><div class="entry-wrap setup-wrap"><div class="entry-brand"><span class="brand-mark">¶</span>PR Explainer</div>${form}</div></main>`;
}
