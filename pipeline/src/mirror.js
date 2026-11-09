import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { githubToken } from './github.js';

const run = promisify(execFile);
export const MIRROR_ROOT = process.env.PRX_MIRRORS || join(homedir(), '.cache', 'pr-explainer', 'mirrors');

export function mirrorDir(repo) {
  return join(MIRROR_ROOT, repo.replace('/', '__') + '.git');
}

async function git(dir, args) {
  const { stdout } = await run('git', ['-C', dir, ...args], { maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

function authArgs() {
  const token = githubToken();
  if (!token) throw new Error('no GitHub token. Set PR_EXPLAINER_GITHUB_TOKEN.');
  const basic = Buffer.from('x-access-token:' + token).toString('base64');
  return ['-c', 'http.extraHeader=Authorization: Basic ' + basic];
}

async function gitAuth(dir, args) {
  const { stdout } = await run('git', ['-C', dir, ...authArgs(), ...args], {
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
}

export async function ensureMirror(repo, originUrl) {
  const dir = mirrorDir(repo);
  if (!existsSync(join(dir, 'HEAD'))) {
    mkdirSync(dir, { recursive: true });
    await git(dir, ['init', '--bare', '-q']);
    await git(dir, ['remote', 'add', 'origin', originUrl || 'https://github.com/' + repo + '.git']);
  }
  return dir;
}

async function hasCommit(dir, sha) {
  try {
    await git(dir, ['cat-file', '-e', sha + '^{commit}']);
    return true;
  } catch {
    return false;
  }
}

export async function fetchShas(repo, shas, { originUrl } = {}) {
  const dir = await ensureMirror(repo, originUrl);
  const t = Date.now();
  const missing = [];
  for (const s of shas) if (!(await hasCommit(dir, s))) missing.push(s);
  if (missing.length) await gitAuth(dir, ['fetch', '-q', '--depth=1', '--no-tags', 'origin', ...missing]);
  return { dir, ms: Date.now() - t, fetched: missing.length };
}
