import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { fetchShas } from '../../pipeline/src/mirror.js';
import { ApiError } from './errors.js';
import * as jobs from './jobs.js';
import * as store from './store.js';

const run = promisify(execFile);
const MAX_BYTES = 2 * 1024 * 1024;

async function git(dir, args, options) {
  const { stdout } = await run('git', ['-C', dir, ...args], options);
  return stdout;
}

async function headAndBase(repo, number) {
  const item = jobs.getItem(repo, number);
  const sha = item?.headSha || (await store.latestStorySha(repo, number));
  const story = sha ? await store.readStory(repo, number, sha) : null;
  return { headSha: item?.headSha || story?.pr?.headSha || sha, baseSha: story?.pr?.baseSha };
}

export async function readPrFile({ repo, number, path, at }) {
  const rel = String(path || '');
  if (!rel || rel.includes('..') || rel.startsWith('-')) {
    throw new ApiError(400, 'bad_request', 'invalid path');
  }
  const fromBase = at === 'base';
  const { headSha, baseSha } = await headAndBase(repo, number);
  const sha = fromBase ? baseSha : headSha;
  if (!sha) throw new ApiError(404, 'not_found', 'no ' + (fromBase ? 'base' : 'head') + ' commit for ' + repo + '#' + number);

  const { dir } = await fetchShas(repo, [sha]);
  const spec = sha + ':' + rel;
  let size;
  try {
    size = Number((await git(dir, ['cat-file', '-s', spec])).trim());
  } catch {
    throw new ApiError(404, 'not_found', 'no such file at ' + (fromBase ? 'base' : 'head') + ': ' + rel);
  }
  if (size > MAX_BYTES) throw new ApiError(413, 'file_too_large', 'file is over 2 MB: ' + rel);

  const buf = await git(dir, ['show', spec], { encoding: 'buffer', maxBuffer: MAX_BYTES + 1024 * 1024 });
  if (Buffer.isBuffer(buf) && buf.includes(0)) {
    throw new ApiError(415, 'bad_request', 'binary file: ' + rel);
  }
  const lines = buf.toString('utf8').replace(/\r\n/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return { path: rel, at: fromBase ? 'base' : 'head', sha, lines };
}
