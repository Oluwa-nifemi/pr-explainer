import { resolve as resolveCredentials } from './credentials.js';

const API = 'https://api.github.com';

export class GithubError extends Error {
  constructor(status, message, data) {
    super(message);
    this.name = 'GithubError';
    this.status = status;
    this.data = data;
  }
}

async function token() {
  const { githubToken } = await resolveCredentials();
  if (!githubToken) throw new GithubError(502, 'no GitHub token. Set it in setup or PR_EXPLAINER_GITHUB_TOKEN.');
  return githubToken;
}

async function ghFetch(path, init = {}, retry = true) {
  const headers = {
    Authorization: 'Bearer ' + (await token()),
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'pr-explainer-service',
    ...(init.headers || {}),
  };
  let res;
  try {
    res = await fetch(API + path, { ...init, headers });
  } catch (err) {
    throw new GithubError(502, 'GitHub request failed: ' + err.message);
  }
  if (res.status === 401 && retry) {
    await resolveCredentials();
    return ghFetch(path, init, false);
  }
  return res;
}

export async function rest(method, path, body) {
  const res = await ghFetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }
  if (!res.ok) {
    const base = data?.message || data?.error || 'GitHub ' + method + ' ' + path + ' failed with ' + res.status;
    const details = (Array.isArray(data?.errors) ? data.errors : []).map((e) => (typeof e === 'string' ? e : e?.message)).filter(Boolean);
    const message = details.length ? base + ': ' + details.join('; ') : base;
    throw new GithubError(res.status, message, data);
  }
  return data;
}

export async function graphql(query, variables) {
  const res = await ghFetch('/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new GithubError(502, 'GitHub GraphQL returned invalid JSON');
  }
  if (!res.ok || data.errors) {
    const message = (data.errors || []).map((e) => e.message).join('; ') || 'GraphQL failed with ' + res.status;
    const authProblem = /bad credentials|requires authentication/i.test(message);
    throw new GithubError(authProblem ? 502 : res.ok ? 422 : res.status, message, data);
  }
  return data.data;
}

const metaCache = new Map();
const META_TTL_MS = 15000;

export async function prMeta(repo, number) {
  const k = repo + '#' + number;
  const hit = metaCache.get(k);
  if (hit && Date.now() - hit.at < META_TTL_MS) return hit.value;
  const value = await fetchPrMeta(repo, number);
  metaCache.set(k, { at: Date.now(), value });
  return value;
}

async function fetchPrMeta(repo, number) {
  const d = await rest('GET', '/repos/' + repo + '/pulls/' + number);
  return {
    repo,
    number,
    title: d.title || '',
    author: d.user?.login || '',
    url: d.html_url || 'https://github.com/' + repo + '/pull/' + number,
    headSha: d.head?.sha || '',
    baseSha: d.base?.sha || '',
    baseRef: d.base?.ref || '',
    headRef: d.head?.ref || '',
    draft: Boolean(d.draft),
    body: d.body || '',
    additions: d.additions ?? 0,
    deletions: d.deletions ?? 0,
    changedFiles: d.changed_files ?? 0,
  };
}

export async function prHeadSha(repo, number) {
  const d = await rest('GET', '/repos/' + repo + '/pulls/' + number);
  return d.head?.sha || '';
}

export async function currentLogin() {
  const d = await rest('GET', '/user');
  return d.login || '';
}
