import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { configureGitHub } from '../../pipeline/src/github.js';
import { DEFAULT_BASE_URL, configureLLM } from '../../pipeline/src/llm.js';
import { MODELS, getStoryModel, setStoryModel } from '../../pipeline/src/models.js';
import { ApiError } from './errors.js';

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
    })
    .catch(() => {
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
  const sources = {
    github: env.PR_EXPLAINER_GITHUB_TOKEN ? 'env' : file.githubToken ? 'file' : 'missing',
    litellm: env.PR_EXPLAINER_LITELLM_API_KEY ? 'env' : file.litellmApiKey ? 'file' : 'missing',
  };
  configureLLM({ baseUrl: litellmBaseUrl, apiKey: litellmApiKey });
  configureGitHub({ token: githubToken });
  const storyModel = [env.PR_EXPLAINER_STORY_MODEL, file.storyModel, 'deepseek'].find((m) => MODELS[m]);
  setStoryModel(storyModel);
  sources.storyModel = MODELS[env.PR_EXPLAINER_STORY_MODEL] ? 'env' : MODELS[file.storyModel] ? 'file' : 'default';
  return { githubToken, litellmApiKey, litellmBaseUrl, storyModel, sources };
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
    return { ok: false, transient: true, error: 'could not reach api.github.com: ' + err.message };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, error: 'GitHub rejected the token (' + res.status + ')' };
  if (!res.ok) return { ok: false, transient: res.status >= 500 || res.status === 429, error: 'GitHub GET /user returned ' + res.status };
  let data = {};
  try {
    data = await res.json();
  } catch {}
  const login = typeof data.login === 'string' ? data.login : '';
  if (!login) return { ok: false, error: 'GitHub GET /user returned no login' };
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
    return { ok: false, transient: true, models, error: 'could not reach ' + baseUrl + ': ' + err.message };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, models, error: 'LiteLLM rejected the key (' + res.status + ')' };
  if (!res.ok) return { ok: false, transient: res.status >= 500 || res.status === 429, models, error: 'LiteLLM GET /models returned ' + res.status };
  let data = null;
  try {
    data = await res.json();
  } catch {
    return { ok: false, models, error: 'LiteLLM GET /models returned invalid JSON' };
  }
  for (const entry of Array.isArray(data?.data) ? data.data : []) {
    if (typeof entry?.id === 'string') models.push(entry.id);
  }
  // A gateway may route model names that /models does not list, so only the strong model is checked, and only when it is the story model. The fast model is probed with a real request.
  const missing = (getStoryModel() === 'opus' ? [MODELS.opus.model] : []).filter((name) => !models.includes(name));
  if (missing.length) return { ok: false, models, error: 'LiteLLM does not list: ' + missing.join(', ') };
  return { ok: true, models };
}

let lastGood = null;

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
    if (Date.now() - cache.at >= CACHE_MS) refresh().catch(() => {});
    return cache.value;
  }
  return refresh();
}

async function compute() {
  const creds = await resolve();
  const [github, litellm] = await Promise.all([
    checkGithub(creds.githubToken),
    checkLitellm(creds.litellmBaseUrl, creds.litellmApiKey),
  ]);
  if (litellm.ok && creds.storyModel === 'deepseek') probeDeepseek(creds.litellmBaseUrl, creds.litellmApiKey);
  const value = {
    ready: github.ok && litellm.ok,
    github: {
      ok: github.ok,
      source: creds.sources.github,
      ...(github.login ? { login: github.login } : {}),
      ...(github.avatarUrl ? { avatarUrl: github.avatarUrl } : {}),
      ...(github.ok ? {} : { error: github.error }),
    },
    litellm: {
      ok: litellm.ok,
      baseUrl: creds.litellmBaseUrl,
      models: litellm.models,
      source: creds.sources.litellm,
      deepseek: litellm.ok && creds.storyModel === 'deepseek' ? deepseek.state : 'unknown',
      ...(litellm.ok ? {} : { error: litellm.error }),
    },
    storyModel: creds.storyModel,
    storyModelSource: creds.sources.storyModel,
  };
  const blocked = (!github.ok && !github.transient) || (!litellm.ok && !litellm.transient);
  const key = creds.githubToken + '|' + creds.litellmApiKey + '|' + creds.litellmBaseUrl;
  if (value.ready) lastGood = { key, value };
  else if (!blocked && lastGood && lastGood.key === key) {
    cache = { at: Date.now() - CACHE_MS + 3000, value: lastGood.value };
    return lastGood.value;
  }
  cache = { at: Date.now(), value };
  return value;
}

export function clearStatus() {
  cache = null;
  lastGood = null;
}

export async function isReady() {
  return (await status()).ready;
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
  if (errors.github) out.github.error = errors.github;
  if (errors.litellm) out.litellm.error = errors.litellm;
  return out;
}

export async function remove() {
  await rm(credentialsPath(), { force: true });
  clearStatus();
  return status({ fresh: true });
}
