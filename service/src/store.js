import { mkdir, readFile, writeFile, rename, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { config } from './config.js';

const storiesRoot = join(config.home, 'stories');
const threadsRoot = join(config.home, 'threads');
const chatRoot = join(config.home, 'chat');
const queuePath = join(config.home, 'queue.json');

export const paths = { storiesRoot, threadsRoot, chatRoot, queuePath };

export function splitRepo(repo) {
  const parts = String(repo || '').split('/');
  const owner = parts[0];
  const name = parts[1];
  if (parts.length !== 2 || !owner || !name) throw new Error('invalid repo: ' + repo);
  return { owner, name };
}

export function storyPath(repo, number, sha) {
  const { owner, name } = splitRepo(repo);
  return join(storiesRoot, owner, name, String(number), sha + '.json');
}

export function threadsPath(repo, number) {
  const { owner, name } = splitRepo(repo);
  return join(threadsRoot, owner, name, String(number) + '.json');
}

export function chatPath(repo, number, sha) {
  const { owner, name } = splitRepo(repo);
  return join(chatRoot, owner, name, String(number), sha + '.json');
}

export function readChat(repo, number, sha) {
  if (!sha) return Promise.resolve(null);
  return readJson(chatPath(repo, number, sha));
}

export function writeChat(repo, number, sha, value) {
  return writeJsonAtomic(chatPath(repo, number, sha), value);
}

export function deleteChat(repo, number, sha) {
  return rm(chatPath(repo, number, sha), { force: true });
}

export async function ensureDirs() {
  await mkdir(storiesRoot, { recursive: true });
  await mkdir(threadsRoot, { recursive: true });
  await mkdir(chatRoot, { recursive: true });
}

export async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + '.' + process.pid + '.' + Math.random().toString(16).slice(2) + '.tmp';
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, path);
}

export function readStory(repo, number, sha) {
  if (!sha) return Promise.resolve(null);
  return readJson(storyPath(repo, number, sha));
}

export function writeStory(story) {
  if (!story?.pr?.repo || !story?.pr?.number || !story?.pr?.headSha) {
    return Promise.resolve();
  }
  return writeJsonAtomic(storyPath(story.pr.repo, story.pr.number, story.pr.headSha), story);
}

export function readThreadsCache(repo, number) {
  return readJson(threadsPath(repo, number));
}

export function writeThreadsCache(repo, number, value) {
  return writeJsonAtomic(threadsPath(repo, number), value);
}

export async function readQueue() {
  return readJson(queuePath, { items: [], pending: [] });
}

export function writeQueue(value) {
  return writeJsonAtomic(queuePath, value);
}

async function safeReaddir(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

export async function listStoryFiles() {
  const out = [];
  for (const owner of await safeReaddir(storiesRoot)) {
    if (!owner.isDirectory()) continue;
    for (const repo of await safeReaddir(join(storiesRoot, owner.name))) {
      if (!repo.isDirectory()) continue;
      for (const num of await safeReaddir(join(storiesRoot, owner.name, repo.name))) {
        if (!num.isDirectory()) continue;
        const dir = join(storiesRoot, owner.name, repo.name, num.name);
        for (const file of await safeReaddir(dir)) {
          if (!file.isFile() || !file.name.endsWith('.json')) continue;
          const full = join(dir, file.name);
          let info;
          try {
            info = await stat(full);
          } catch {
            continue;
          }
          out.push({
            repo: owner.name + '/' + repo.name,
            number: Number(num.name),
            sha: file.name.slice(0, -5),
            mtimeMs: info.mtimeMs,
          });
        }
      }
    }
  }
  return out;
}

async function storyFiles(repo, number) {
  const { owner, name } = splitRepo(repo);
  const dir = join(storiesRoot, owner, name, String(number));
  const out = [];
  for (const file of await safeReaddir(dir)) {
    if (!file.isFile() || !file.name.endsWith('.json')) continue;
    const info = await stat(join(dir, file.name)).catch(() => null);
    if (info) out.push({ sha: file.name.slice(0, -5), mtimeMs: info.mtimeMs });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export async function latestStorySha(repo, number) {
  return (await storyFiles(repo, number))[0]?.sha || null;
}

// Done or failed. Either way the story stopped growing.
export function isFinished(story) {
  const status = story?.generation?.status;
  return status === 'done' || status === 'failed';
}

// The newest finished story, skipping any story that is still being written.
export async function latestFinishedStory(repo, number) {
  for (const file of await storyFiles(repo, number)) {
    const story = await readStory(repo, number, file.sha);
    if (isFinished(story)) return story;
  }
  return null;
}
