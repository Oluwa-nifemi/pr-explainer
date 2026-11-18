import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { configureGitHub } from '../../pipeline/src/github.js';
import { DEFAULT_BASE_URL, DEFAULT_CLAUDE_BASE_URL, configureLLM } from '../../pipeline/src/llm.js';
import { MODELS, PROVIDERS, getStoryModel, modelsFor, providerOf, setStoryModel } from '../../pipeline/src/models.js';
import { ApiError } from './errors.js';
import { registerSecrets, redact, errorDetails } from './diagnostics.js';

const CHECK_TIMEOUT_MS = 15000;
const CACHE_MS = 20000;

let cache = null;
let deepseek = { id: null, state: 'unknown' };

function probeDeepseek(baseUrl, apiKey) {
  const id = baseUrl + '\n' + apiKey;
  if (deepseek.id === id) return;
  deepseek = { id, state: 'unknown' };
  fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ model: MODELS.deepseek.model, messages: [{ role: 'user', content: 'ok' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  })
    .then((res) => {
      if (deepseek.id === id) deepseek.state = res.ok ? 'ok' : 'failed';
      if (!res.ok) console.warn('litellm model probe failed status=' + res.status);
    })
    .catch((err) => {
      console.warn('litellm model probe connection failed ' + errorDetails(err));
      if (deepseek.id === id) deepseek.state = 'failed';
    });
}

export function configDir() {
  if (process.platform === 'win32') return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
}

export function credentialsPath() {
  return join(configDir(), 'pr-explainer', 'credentials.json');
}

async function readFileCredentials() {
  try {
    const data = JSON.parse(await readFile(credentialsPath(), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function normalizeBase(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

export async function resolve() {
  const file = await readFileCredentials();
  const env = process.env;
  const githubToken = env.PR_EXPLAINER_GITHUB_TOKEN || file.githubToken || '';
  const litellmApiKey = env.PR_EXPLAINER_LITELLM_API_KEY || file.litellmApiKey || '';
  const litellmBaseUrl = normalizeBase(env.PR_EXPLAINER_LITELLM_BASE_URL || file.litellmBaseUrl || DEFAULT_BASE_URL);
  // Not a setting. The default follows the environment, and the variable covers an unusual host.
  const claudeBaseUrl = normalizeBase(env.PR_EXPLAINER_CLAUDE_BASE_URL || DEFAULT_CLAUDE_BASE_URL);
  registerSecrets(env.PR_EXPLAINER_GITHUB_TOKEN, file.githubToken, env.PR_EXPLAINER_LITELLM_API_KEY, file.litellmApiKey);
  const sources = {
    github: env.PR_EXPLAINER_GITHUB_TOKEN ? 'env' : file.githubToken ? 'file' : 'missing',
    litellm: env.PR_EXPLAINER_LITELLM_API_KEY ? 'env' : file.litellmApiKey ? 'file' : 'missing',
    claudeCode: env.PR_EXPLAINER_CLAUDE_BASE_URL ? 'env' : 'default',
  };
  configureLLM({ baseUrl: litellmBaseUrl, apiKey: litellmApiKey, claudeBaseUrl });
  configureGitHub({ token: githubToken });
  const storyModel = [env.PR_EXPLAINER_STORY_MODEL, file.storyModel, 'deepseek'].find((m) => MODELS[m]);
  setStoryModel(storyModel);
  sources.storyModel = MODELS[env.PR_EXPLAINER_STORY_MODEL] ? 'env' : MODELS[file.storyModel] ? 'file' : 'default';
  return { githubToken, litellmApiKey, litellmBaseUrl, claudeBaseUrl, storyModel, sources };
}

export async function checkGithub(token) {
  if (!token) return { ok: false, error: 'no GitHub token' };
  let res;
  try {
    res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'pr-explainer-service',
      },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn('github setup connection failed ' + errorDetails(err));
    return { ok: false, transient: true, error: 'could not reach api.github.com: ' + err.message };
  }
  if (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after'))) {
    return { ok: false, transient: true, error: 'GitHub rate limit reached. Checking again shortly.' };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, error: 'GitHub rejected the token (' + res.status + ')' };
  if (!res.ok) return { ok: false, transient: res.status >= 500 || res.status === 408 || res.status === 429, error: 'GitHub GET /user returned ' + res.status };
  let data = {};
  try {
    data = await res.json();
  } catch (err) {
    console.warn('github setup response could not be read ' + errorDetails(err));
    return { ok: false, transient: true, error: 'GitHub GET /user returned an unreadable response' };
  }
  const login = typeof data?.login === 'string' ? data.login : '';
  if (!login) return { ok: false, transient: true, error: 'GitHub GET /user returned no login' };
  return { ok: true, login, avatarUrl: typeof data.avatar_url === 'string' ? data.avatar_url : '' };
}

export async function checkLitellm(baseUrl, apiKey) {
  const models = [];
  if (!apiKey) return { ok: false, models, error: 'no LiteLLM API key' };
  if (!baseUrl) return { ok: false, models, error: 'no LiteLLM base URL' };
  if (!/^https?:\/\//.test(baseUrl)) return { ok: false, models, error: 'LiteLLM base URL must start with http or https' };
  let res;
  try {
    res = await fetch(baseUrl + '/models', {
      headers: { Authorization: 'Bearer ' + apiKey },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn('litellm setup connection failed ' + errorDetails(err));
    return { ok: false, transient: true, models, error: 'could not reach ' + baseUrl + ': ' + err.message };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, models, error: 'LiteLLM rejected the key (' + res.status + ')' };
  if (!res.ok) return { ok: false, transient: res.status >= 500 || res.status === 408 || res.status === 429, models, error: 'LiteLLM GET /models returned ' + res.status };
  let data = null;
  try {
    data = await res.json();
  } catch (err) {
    console.warn('litellm setup response could not be read ' + errorDetails(err));
    return { ok: false, transient: true, models, error: 'LiteLLM GET /models returned an unreadable response' };
  }
  if (!Array.isArray(data?.data)) return { ok: false, transient: true, models, error: 'LiteLLM GET /models returned no model list' };
  for (const entry of Array.isArray(data?.data) ? data.data : []) {
    if (typeof entry?.id === 'string') models.push(entry.id);
  }
  // A gateway may route model names that /models does not list, so only the strong model is checked, and only when it is the story model. The fast model is probed with a real request.
  const missing = (getStoryModel() === 'opus' ? [MODELS.opus.model] : []).filter((name) => !models.includes(name));
  if (missing.length) return { ok: false, models, error: 'LiteLLM does not list: ' + missing.join(', ') };
  return { ok: true, models };
}

export async function checkClaudeCode(baseUrl) {
  if (!baseUrl) return { ok: false, models: [], error: 'no Claude Code bridge URL' };
  if (!/^https?:\/\//.test(baseUrl)) return { ok: false, models: [], error: 'Claude Code bridge URL must start with http or https' };
  let res;
  try {
    res = await fetch(baseUrl + '/health', { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
  } catch (err) {
    console.warn('claude code bridge connection failed ' + errorDetails(err));
    return { ok: false, transient: true, models: [], error: 'could not reach the Claude Code bridge at ' + baseUrl + '. Is it running on the host?' };
  }
  if (!res.ok) return { ok: false, transient: res.status >= 500, models: [], error: 'Claude Code bridge /health returned ' + res.status };
  const data = await res.json().catch(() => null);
  if (!data || typeof data !== 'object') return { ok: false, transient: true, models: [], error: 'Claude Code bridge /health returned an unreadable response' };
  const models = (Array.isArray(data.models) ? data.models : []).map((m) => (typeof m === 'string' ? m : m?.id)).filter((id) => typeof id === 'string');
  const claude = data.claude || {};
  if (!claude.installed) return { ok: false, models, error: claude.error || 'the claude command is not installed on the host' };
  if (!claude.authorized) {
    return { ok: false, models, version: claude.version, error: claude.error || 'Claude Code is installed but not signed in. Run claude auth login on the host.' };
  }
  return { ok: true, models, version: claude.version, account: claude.account };
}

export async function checkConnection(input = {}) {
  const current = await resolve();
  const provider = input.provider === 'claude-code' ? 'claude-code' : 'litellm';
  if (provider === 'claude-code') {
    const baseUrl = current.claudeBaseUrl;
    const check = await checkClaudeCode(baseUrl);
    return {
      provider,
      ok: check.ok,
      transient: !!check.transient,
      baseUrl,
      models: check.models,
      ...(check.version ? { version: check.version } : {}),
      ...(check.account ? { account: check.account } : {}),
      ...(check.ok ? {} : { error: check.error }),
    };
  }
  const baseUrl = normalizeBase(input.litellmBaseUrl) || current.litellmBaseUrl;
  const apiKey = typeof input.litellmApiKey === 'string' && input.litellmApiKey.trim() ? input.litellmApiKey.trim() : current.litellmApiKey;
  const check = await checkLitellm(baseUrl, apiKey);
  return {
    provider,
    ok: check.ok,
    transient: !!check.transient,
    baseUrl,
    models: check.models,
    ...(check.ok ? {} : { error: check.error }),
  };
}

let inflight = null;

function refresh() {
  inflight ||= compute().finally(() => {
    inflight = null;
  });
  return inflight;
}

// Answer from the saved result at once. An old result starts one check in the background, so a slow GitHub or LiteLLM never holds up a request.
export async function status({ fresh = false } = {}) {
  if (fresh) return compute();
  if (cache) {
    const cacheMs = !cache.value.ready && !cache.value.setupRequired ? 3000 : CACHE_MS;
    if (Date.now() - cache.at >= cacheMs) refresh().catch(() => {});
    return cache.value;
  }
  return refresh();
}

async function compute() {
  const creds = await resolve();
  const provider = providerOf(creds.storyModel);
  const [github, litellm, claudeCode] = await Promise.all([
    checkGithub(creds.githubToken),
    checkLitellm(creds.litellmBaseUrl, creds.litellmApiKey),
    checkClaudeCode(creds.claudeBaseUrl),
  ]);
  for (const [name, result] of [['github', github], ['litellm', litellm], ['claude-code', claudeCode]]) {
    if (!result.ok) console.warn('connection check failed service=' + name + ' transient=' + !!result.transient + ' reason=' + redact(result.error));
  }
  if (litellm.ok && creds.storyModel === 'deepseek') probeDeepseek(creds.litellmBaseUrl, creds.litellmApiKey);
  const story = provider === 'claude-code' ? claudeCode : litellm;
  const value = {
    ready: github.ok && story.ok,
    setupRequired: (!github.ok && !github.transient) || (!story.ok && !story.transient),
    github: {
      ok: github.ok,
      transient: !!github.transient,
      source: creds.sources.github,
      ...(github.login ? { login: github.login } : {}),
      ...(github.avatarUrl ? { avatarUrl: github.avatarUrl } : {}),
      ...(github.ok ? {} : { error: github.error }),
    },
    litellm: {
      ok: litellm.ok,
      transient: !!litellm.transient,
      baseUrl: creds.litellmBaseUrl,
      models: litellm.models,
      source: creds.sources.litellm,
      deepseek: litellm.ok && creds.storyModel === 'deepseek' ? deepseek.state : 'unknown',
      ...(litellm.ok ? {} : { error: litellm.error }),
    },
    claudeCode: {
      ok: claudeCode.ok,
      transient: !!claudeCode.transient,
      baseUrl: creds.claudeBaseUrl,
      models: claudeCode.models,
      source: creds.sources.claudeCode,
      ...(claudeCode.version ? { version: claudeCode.version } : {}),
      ...(claudeCode.account ? { account: claudeCode.account } : {}),
      ...(claudeCode.ok ? {} : { error: claudeCode.error }),
    },
    provider,
    chatModel: creds.storyModel,
    storyModel: creds.storyModel,
    storyModelSource: creds.sources.storyModel,
    providers: Object.fromEntries(
      Object.keys(PROVIDERS).map((id) => [
        id,
        { label: PROVIDERS[id].label, models: modelsFor(id).map((name) => ({ id: name, label: MODELS[name].option || name, model: MODELS[name].label })) },
      ])
    ),
  };
  cache = { at: Date.now(), value };
  return value;
}

export function clearStatus() {
  cache = null;
}

async function writeFileCredentials(value) {
  const dir = join(configDir(), 'pr-explainer');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const path = credentialsPath();
  const tmp = path + '.' + process.pid + '.tmp';
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
  await chmod(path, 0o600);
}

export async function save(input = {}) {
  if (input.storyModel !== undefined && !MODELS[input.storyModel]) {
    throw new ApiError(400, 'bad_request', 'storyModel must be ' + Object.keys(MODELS).join(' or '));
  }
  const current = await resolve();
  const next = { ...(await readFileCredentials()) };
  const candidateKey =
    typeof input.litellmApiKey === 'string' && input.litellmApiKey.trim() ? input.litellmApiKey.trim() : null;
  const candidateBase = normalizeBase(input.litellmBaseUrl);
  const candidateToken = typeof input.githubToken === 'string' && input.githubToken.trim() ? input.githubToken.trim() : null;
  const baseUrl = candidateBase || current.litellmBaseUrl;
  let saved = false;
  const errors = {};

  if (input.storyModel) {
    next.storyModel = input.storyModel;
    saved = true;
  }
  if (candidateBase) {
    const check = await checkLitellm(baseUrl, candidateKey || current.litellmApiKey);
    if (check.ok) {
      next.litellmBaseUrl = baseUrl;
      saved = true;
    } else errors.litellm = check.error;
  }
  if (candidateKey) {
    const check = await checkLitellm(baseUrl, candidateKey);
    if (check.ok) {
      next.litellmApiKey = candidateKey;
      saved = true;
      delete errors.litellm;
    } else errors.litellm = check.error;
  }
  if (candidateToken) {
    const check = await checkGithub(candidateToken);
    if (check.ok) {
      next.githubToken = candidateToken;
      saved = true;
    } else errors.github = check.error;
  }
  if (saved) await writeFileCredentials(next);
  clearStatus();
  const out = structuredClone(await status({ fresh: true }));
  // Rejected values are reported here, not inside the status. The status describes what is saved,
  // so an error never lingers against a field the person has already corrected.
  if (Object.keys(errors).length) out.errors = errors;
  return out;
}

export async function remove() {
  await rm(credentialsPath(), { force: true });
  clearStatus();
  return status({ fresh: true });
}
