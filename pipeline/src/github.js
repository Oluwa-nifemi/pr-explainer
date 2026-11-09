const API = 'https://api.github.com';
const TIMEOUT_MS = 60000;

let configuredToken = null;

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

export function configureGitHub({ token } = {}) {
  configuredToken = token || null;
}

export function githubToken() {
  return configuredToken || process.env.PR_EXPLAINER_GITHUB_TOKEN || '';
}

function headers(accept) {
  const token = githubToken();
  if (!token) throw new GitHubError(502, 'no GitHub token. Set PR_EXPLAINER_GITHUB_TOKEN.');
  return {
    Authorization: 'Bearer ' + token,
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'pr-explainer',
  };
}

export async function request(path, { accept = 'application/vnd.github+json', method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers: { ...headers(accept), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new GitHubError(502, 'GitHub request failed: ' + err.message);
  }
  const text = await res.text();
  if (!res.ok) {
    let reason = '';
    try {
      reason = JSON.parse(text)?.message || '';
    } catch {}
    throw new GitHubError(
      res.status,
      'GitHub ' + method + ' ' + path + ' failed with ' + res.status + (reason ? ': ' + reason : ''),
    );
  }
  return { text, contentType: res.headers.get('content-type') || '' };
}

export async function pullRequest(repo, number) {
  const { text } = await request('/repos/' + repo + '/pulls/' + number);
  return JSON.parse(text);
}

export async function pullDiff(repo, number) {
  const { text } = await request('/repos/' + repo + '/pulls/' + number, { accept: 'application/vnd.github.diff' });
  return text;
}

export async function baseShaOf(repo, number) {
  const detail = await pullRequest(repo, number);
  return detail.base?.sha || '';
}
