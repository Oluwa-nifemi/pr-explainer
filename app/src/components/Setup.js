import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { saveSetup, clearSetup, testSetup } from "../lib/api.js";
import { setup, closeSettings } from "../lib/setup.js";
import { cx } from "../lib/util.js";

const TOKENS_URL = "https://github.com/settings/tokens";
const PROVIDER_ORDER = ["litellm", "claude-code"];

function State({ ok, error, transient, source, envName, okText }) {
  if (error) return html`<p class=${cx("sf-state", transient ? "waiting" : "bad")} role=${transient ? "status" : "alert"}>${error}${transient ? " Your credential is still configured." : ""}</p>`;
  if (source === "env") return html`<p class="sf-state ok">Set by the environment variable <code>${envName}</code>. Change it there.</p>`;
  if (ok) return html`<p class="sf-state ok">${okText}</p>`;
  return null;
}

function Chip({ ok, error, transient }) {
  if (error) return html`<span class=${cx("conn-chip", transient ? "waiting" : "bad")}>${transient ? "Unreachable" : "Problem"}</span>`;
  if (ok) return html`<span class="conn-chip ok">Connected</span>`;
  return html`<span class="conn-chip">Not set</span>`;
}

function detailOf(result, id) {
  if (!result) return "";
  if (result.error) return result.error;
  if (id === "claude-code") {
    const bits = [];
    if (result.version) bits.push("Claude Code " + result.version);
    bits.push(result.models?.length ? result.models.length + " models" : "ready");
    return bits.join(" · ");
  }
  return result.models?.length ? result.models.length + " models available" : "ready";
}

export function Setup({ status, modal, embedded }) {
  const providers = status.providers || {};
  const providerOfModel = (name) => PROVIDER_ORDER.find((id) => (providers[id]?.models || []).some((m) => m.id === name)) || "litellm";
  const [github, setGithub] = useState("");
  const [key, setKey] = useState("");
  const [base, setBase] = useState(status.litellm.baseUrl || "");
  const [claudeBase, setClaudeBase] = useState(status.claudeCode?.baseUrl || "");
  const [storyModel, setStoryModel] = useState(status.storyModel);
  const [lastLitellm, setLastLitellm] = useState(providerOfModel(status.storyModel) === "litellm" ? status.storyModel : "opus");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [saved, setSaved] = useState(false);
  const [tests, setTests] = useState({});
  const [testing, setTesting] = useState(null);
  const gh = status.github;
  const ll = status.litellm;
  const cc = status.claudeCode || {};
  // A fresh test result describes the values on screen, so it wins over the saved status.
  const llView = tests.litellm || ll;
  const ccView = tests["claude-code"] || cc;
  const provider = providerOfModel(storyModel);
  const locked = status.storyModelSource === "env";
  const baseChanged = base.trim() && base.trim() !== ll.baseUrl;
  const claudeBaseChanged = claudeBase.trim() !== (cc.baseUrl || "");
  const storyChanged = storyModel !== status.storyModel;
  const dirty = github.trim() || key.trim() || baseChanged || claudeBaseChanged || storyChanged;

  const pickProvider = (id) => {
    if (provider === id) return;
    if (provider === "litellm" && lastLitellm !== storyModel) setLastLitellm(storyModel);
    if (id === "litellm") setStoryModel(lastLitellm);
    else setStoryModel(providers[id]?.models?.[0]?.id || "claude");
  };

  // A test result describes the values it tested. Drop it when they change.
  const dropTest = (id) => setTests((t) => (t[id] ? Object.fromEntries(Object.entries(t).filter(([k]) => k !== id)) : t));

  const submit = async (e) => {
    e.preventDefault();
    const body = {};
    if (github.trim() && gh.source !== "env") body.githubToken = github.trim();
    if (key.trim() && ll.source !== "env") body.litellmApiKey = key.trim();
    if (baseChanged) body.litellmBaseUrl = base.trim();
    if (claudeBaseChanged && claudeBase.trim()) body.claudeBaseUrl = claudeBase.trim();
    if (storyChanged) body.storyModel = storyModel;
    setBusy(true);
    setProblem(null);
    setSaved(false);
    try {
      const next = await saveSetup(body);
      const errors = next.errors || {};
      const failed = errors.github || errors.litellm || errors.claudeCode;
      if (body.githubToken && !errors.github) setGithub("");
      if (body.litellmApiKey && !errors.litellm) setKey("");
      if (body.litellmBaseUrl && !errors.litellm) setBase(next.litellm.baseUrl || base);
      if (body.claudeBaseUrl && !errors.claudeCode) setClaudeBase(next.claudeCode.baseUrl || claudeBase);
      setStoryModel(next.storyModel);
      setSaved(next.ready && !failed);
      setProblem(failed || null);
      setTests({});
      setup.set({ status: next });
    } catch (err) {
      setProblem(err.message);
    }
    setBusy(false);
  };

  const test = async (id) => {
    setTesting(id);
    try {
      const body =
        id === "claude-code"
          ? { provider: "claude-code", claudeBaseUrl: claudeBase.trim() }
          : { provider: "litellm", litellmBaseUrl: base.trim(), litellmApiKey: key.trim() };
      const result = await testSetup(body);
      setTests((t) => ({ ...t, [id]: result }));
    } catch (err) {
      setTests((t) => ({ ...t, [id]: { ok: false, error: err.message } }));
    }
    setTesting(null);
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

  const connection = (id) => {
    const result = id === "litellm" ? llView : ccView;
    const label = providers[id]?.label || id;
    const envName = id === "litellm" ? "PR_EXPLAINER_LITELLM_API_KEY" : "PR_EXPLAINER_CLAUDE_BASE_URL";
    const isEnv = id === "litellm" ? ll.source === "env" : cc.source === "env";
    return html`<div class="conn-row">
      <div class="conn-main">
        <div class="conn-head">
          <span class="conn-name">${label}</span>
          <${Chip} ok=${result?.ok} error=${result?.error} transient=${result?.transient} />
          ${testing === id ? html`<i class="spin"></i>` : null}
        </div>
        <p class="conn-detail">${detailOf(result, id) || (isEnv ? "Set by " + envName : "Not configured.")}</p>
      </div>
      <button type="button" class="btn ghost small" disabled=${testing === id} onClick=${() => test(id)}>Test</button>
    </div>`;
  };

  const form = html`<form class=${cx("setup", modal && "in-modal")} onSubmit=${submit}>
    <div class="setup-head">
      <h1>${modal ? "Settings" : "Set up PR Explainer"}</h1>
      ${modal ? html`<button type="button" class="icon-btn" aria-label="Close" onClick=${closeSettings}>×</button>` : null}
    </div>
    <p class="setup-lede">${modal ? "Connections and what writes your stories." : "PR Explainer needs GitHub, and one provider that writes the stories."}</p>

    <label class="sf">
      <span class="sf-label">GitHub token</span>
      <input type="password" autocomplete="off" spellcheck="false" value=${github} disabled=${gh.source === "env"} placeholder=${gh.source === "env" ? "Set by environment variable" : gh.source === "file" ? "Saved. Paste a new token to replace it." : "ghp_… or github_pat_…"} onInput=${(e) => setGithub(e.currentTarget.value)} />
      <span class="sf-help">Create a token at <a href=${TOKENS_URL} target="_blank" rel="noreferrer">github.com/settings/tokens</a> with the scopes <code>repo</code> and <code>read:org</code>.</span>
      <${State} ok=${gh.ok} error=${gh.error} transient=${gh.transient} source=${gh.source} envName="PR_EXPLAINER_GITHUB_TOKEN" okText=${"Working. Signed in as " + gh.login + "."} />
    </label>

    <div class="sf">
      <span class="sf-label">What writes your stories</span>
      <div class="model-row" role="radiogroup" aria-label="Story provider">
        ${PROVIDER_ORDER.filter((id) => providers[id]).map(
          (id) =>
            html`<button type="button" role="radio" aria-checked=${provider === id} disabled=${locked} class=${cx("model-opt", provider === id && "on")} onClick=${() => pickProvider(id)}><b>${providers[id].label}</b></button>`
        )}
      </div>
      <span class="sf-help">${provider === "claude-code" ? "Stories and chat run on your Claude Code login. Lookups in chat are passed through the bridge." : "Stories run on your LiteLLM gateway."}</span>
    </div>

    ${provider === "litellm"
      ? html`<label class="sf">
          <span class="sf-label">LiteLLM API key</span>
          <input type="password" autocomplete="off" spellcheck="false" value=${key} disabled=${ll.source === "env"} placeholder=${ll.source === "env" ? "Set by environment variable" : ll.source === "file" ? "Saved. Paste a new key to replace it." : "sk-…"} onInput=${(e) => { setKey(e.currentTarget.value); dropTest("litellm"); }} />
          <span class="sf-help">The key for your LiteLLM gateway. It must be allowed to use the story model you pick below.</span>
          <${State} ok=${llView.ok} error=${llView.error} transient=${llView.transient} source=${ll.source} envName="PR_EXPLAINER_LITELLM_API_KEY" okText=${"Working. " + (llView.models?.length || 0) + " models available."} />
        </label>

        <label class="sf">
          <span class="sf-label">LiteLLM base URL</span>
          <input type="text" spellcheck="false" value=${base} onInput=${(e) => { setBase(e.currentTarget.value); dropTest("litellm"); }} />
          <span class="sf-help">Without <code>/v1</code>. The service calls <code>/chat/completions</code> and <code>/models</code> under it.</span>
        </label>`
      : html`<label class="sf">
          <span class="sf-label">Claude Code bridge URL</span>
          <input type="text" spellcheck="false" value=${claudeBase} onInput=${(e) => { setClaudeBase(e.currentTarget.value); dropTest("claude-code"); }} />
          <span class="sf-help">Where the bridge runs. Inside Docker use <code>http://host.docker.internal:5191</code>. Start it with <code>node bridge/claude-bridge.js</code> on the host.</span>
          <${State} ok=${ccView.ok} error=${ccView.error} transient=${ccView.transient} source=${cc.source} envName="PR_EXPLAINER_CLAUDE_BASE_URL" okText=${ccView.ok ? "Working. Claude Code " + (ccView.version || "") + " is signed in" + (ccView.account ? " as " + ccView.account : "") + "." : undefined} />
        </label>`}

    <div class="sf">
      <span class="sf-label">Story model</span>
      <div class="model-row" role="radiogroup" aria-label="Story model">
        ${(providers[provider]?.models || []).map(
          (m) =>
            html`<button type="button" role="radio" aria-checked=${storyModel === m.id} disabled=${locked} class=${cx("model-opt", storyModel === m.id && "on")} onClick=${() => setStoryModel(m.id)}><b>${m.label}</b></button>`
        )}
      </div>
      <span class="sf-help">The model that writes stories. Saved stories keep the model they were written with, so changing this does not mark them outdated.</span>
      ${locked ? html`<p class="sf-state ok">Set by the environment variable <code>PR_EXPLAINER_STORY_MODEL</code>. Change it there.</p>` : null}
    </div>

    <div class="sf">
      <span class="sf-label">Connections</span>
      <div class="conn-list">
        <div class="conn-row">
          <div class="conn-main">
            <div class="conn-head"><span class="conn-name">GitHub</span><${Chip} ok=${gh.ok} error=${gh.error} transient=${gh.transient} /></div>
            <p class="conn-detail">${gh.error || (gh.ok ? "Signed in as " + gh.login + "." : "No token yet.")}</p>
          </div>
        </div>
        ${PROVIDER_ORDER.filter((id) => providers[id] && id === provider).map(connection)}
      </div>
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
      The environment variables <code>PR_EXPLAINER_GITHUB_TOKEN</code>, <code>PR_EXPLAINER_LITELLM_API_KEY</code>, <code>PR_EXPLAINER_LITELLM_BASE_URL</code>, <code>PR_EXPLAINER_CLAUDE_BASE_URL</code> and <code>PR_EXPLAINER_STORY_MODEL</code> override the file. The service never shows saved values again.
    </p>
  </form>`;

  if (embedded) return form;
  if (modal) return html`<div class="modal-back" onMouseDown=${(e) => e.target === e.currentTarget && closeSettings()}><div class="modal setup-modal" role="dialog" aria-modal="true" aria-label="Settings">${form}</div></div>`;
  return html`<main class="entry"><div class="entry-wrap setup-wrap"><div class="entry-brand"><span class="brand-mark">¶</span>PR Explainer<a class="btn ghost small entry-settings" href="?settings=diagnostics">Diagnostics</a></div>${form}</div></main>`;
}
