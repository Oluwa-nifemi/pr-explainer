import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { showFile } from '../../pipeline/src/context.js';
import { numberedPatch } from '../../pipeline/src/diff.js';
import { fetchShas } from '../../pipeline/src/mirror.js';
import * as threads from './threads.js';

const run = promisify(execFile);
const MAX_RESULT_CHARS = 12000;
const MAX_READ_LINES = 200;

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read lines from a file in the repository at the PR head commit or the base commit. Returns numbered lines. At most 200 lines per call.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repository-relative path' },
          startLine: { type: 'integer', description: '1-based first line' },
          endLine: { type: 'integer', description: 'Last line, inclusive' },
          at: { type: 'string', enum: ['head', 'base'], description: 'Which commit. Default head.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description:
        'Search the repository at the PR head commit with a POSIX extended regular expression (git grep -E). Do not use \\b, \\d or \\w; use plain words, [0-9] and [[:space:]]. Returns up to 40 matches as path:line:text.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: 'Optional path or directory to limit the search' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_step',
      description: 'Return the gist and hunks of one story step.',
      parameters: {
        type: 'object',
        properties: { stepId: { type: 'string', description: 'Step id, for example s3' } },
        required: ['stepId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_hunk',
      description: 'Return one diff hunk with line numbers.',
      parameters: {
        type: 'object',
        properties: { hunkId: { type: 'string', description: 'Hunk id from the story' } },
        required: ['hunkId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_threads',
      description: 'Return the GitHub review threads for this PR, optionally for one path.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Optional file path' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_my_drafts',
      description: "Return the reviewer's own unposted draft comments and draft thread replies. Use only when he asks about his drafts.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'draft_comment',
      description: 'Save a draft review comment for the user to post. Use only when the user asks for a comment.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          line: { type: 'integer' },
          side: { type: 'string', enum: ['LEFT', 'RIGHT'] },
          body: { type: 'string', description: 'Markdown comment body' },
        },
        required: ['path', 'line', 'side', 'body'],
      },
    },
  },
];

function cut(text) {
  return text.length > MAX_RESULT_CHARS ? text.slice(0, MAX_RESULT_CHARS) + '\n... [truncated]' : text;
}

function numbered(lines, from, to) {
  const out = [];
  for (let i = from; i <= to && i <= lines.length; i++) out.push(String(i).padStart(5) + '  ' + lines[i - 1]);
  return out.join('\n');
}

function hunkText(hunk) {
  return numberedPatch({ ...hunk, lines: String(hunk.patch || '').split('\n') });
}

function allHunks(story) {
  return (story?.steps || []).flatMap((step) => step.hunks || []);
}

export function createToolRunner({ repo, number, story, headSha, baseSha, drafts }) {
  let dirPromise = null;
  const draft = { value: null };

  function dir() {
    dirPromise ||= fetchShas(repo, [headSha, baseSha].filter(Boolean)).then((m) => m.dir);
    return dirPromise;
  }

  async function readFile(args) {
    const path = String(args.path || '').replace(/^\/+/, '');
    if (!path) return { text: 'error: path is required' };
    const at = args.at === 'base' ? 'base' : 'head';
    const sha = at === 'base' ? baseSha : headSha;
    if (!sha) return { text: 'error: this PR has no ' + at + ' commit' };
    const lines = await showFile(await dir(), sha, path);
    if (!lines) return { text: 'error: no such file at ' + at + ': ' + path };
    const from = Math.max(1, Number(args.startLine) || 1);
    const to = Math.min(lines.length, Number(args.endLine) || from + MAX_READ_LINES - 1, from + MAX_READ_LINES - 1);
    const text = numbered(lines, from, to) + (to < lines.length ? '\n(file has ' + lines.length + ' lines)' : '');
    return { text: cut(text), label: path + ':' + from + '-' + to + ' @' + at };
  }

  async function grep(args) {
    const pattern = String(args.pattern || '');
    if (!pattern) return { text: 'error: pattern is required' };
    const label = 'grep "' + pattern + '" @head';
    const spec = args.path ? [String(args.path)] : ['.'];
    try {
      const { stdout } = await run(
        'git',
        ['-C', await dir(), 'grep', '-n', '-I', '-E', '--max-count=5', pattern, headSha, '--', ...spec],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      const hits = stdout.split('\n').filter(Boolean).map((l) => l.slice(headSha.length + 1).slice(0, 240));
      if (!hits.length) return { text: 'no matches', label };
      const text = hits.slice(0, 40).join('\n') + (hits.length > 40 ? '\n(+' + (hits.length - 40) + ' more)' : '');
      return { text: cut(text), label };
    } catch (err) {
      if (err.code === 1) return { text: 'no matches', label };
      return { text: 'error: ' + String(err.message || err).slice(0, 200), label };
    }
  }

  function step(args) {
    const id = String(args.stepId || '');
    const ids = (story?.steps || []).map((s) => s.id);
    const s = (story?.steps || []).find((x) => x.id === id);
    if (!s) return { text: 'error: no step ' + id + '. Steps: ' + ids.join(', '), label: 'step ' + id };
    const parts = [s.id + ' ' + s.title + ' (' + s.kind + ')', s.summary || ''];
    if (s.gist) parts.push('', 'Gist:', s.gist);
    for (const h of s.hunks || []) parts.push('', '### ' + h.path + ' hunk ' + h.id, hunkText(h));
    return { text: cut(parts.join('\n')), label: 'step ' + s.id };
  }

  function hunk(args) {
    const id = String(args.hunkId || '');
    const found = allHunks(story).find((h) => h.id === id || h.fingerprint === id);
    if (!found) return { text: 'error: no hunk ' + id, label: 'hunk ' + id };
    return { text: cut('### ' + found.path + ' ' + found.id + '\n' + hunkText(found)), label: 'hunk ' + found.id };
  }

  async function reviewThreads(args) {
    const path = args.path ? String(args.path) : '';
    const cached = await threads.peekThreads(repo, number);
    const list = (cached?.threads || []).filter((t) => !path || t.path === path);
    const label = 'threads' + (path ? ' ' + path : '');
    if (!list.length) return { text: 'no review threads' + (path ? ' for ' + path : ''), label };
    const lines = list.slice(0, 20).map((t) => {
      const head = '- ' + t.path + ':' + (t.line ?? '?') + ' ' + t.side + (t.isResolved ? ' (resolved)' : ' (open)');
      const bodies = t.comments.map((c) => '    ' + c.author.login + ': ' + c.body.replace(/\s+/g, ' ').slice(0, 300));
      return [head, ...bodies].join('\n');
    });
    return { text: cut(lines.join('\n')), label };
  }

  function draftComment(args) {
    const path = String(args.path || '');
    const line = Number(args.line);
    const side = args.side === 'LEFT' ? 'LEFT' : 'RIGHT';
    const body = typeof args.body === 'string' ? args.body.trim() : '';
    if (!path || !Number.isInteger(line) || line < 1 || !body) {
      return { text: 'error: path, line and body are required' };
    }
    draft.value = { path, line, side, body };
    return { text: 'draft comment saved for ' + path + ':' + line, label: 'draft ' + path + ':' + line + ' ' + side };
  }

  function myDrafts() {
    const label = 'your drafts';
    const comments = drafts?.comments || [];
    const replies = drafts?.replies || [];
    if (!comments.length && !replies.length) return { text: 'The reviewer has no unposted drafts right now.', label };
    const out = [];
    if (comments.length) {
      out.push('Draft comments (not posted yet):');
      for (const c of comments) {
        const where = c.path ? c.path + (c.line ? ':' + (c.startLine && c.startLine < c.line ? c.startLine + '-' : '') + c.line : '') : 'general';
        out.push('- ' + (c.kind === 'question' ? '[question for the author] ' : '') + where + ': ' + c.body.replace(/\s+/g, ' '));
      }
    }
    if (replies.length) {
      out.push('', 'Draft replies to review threads (not posted yet):');
      for (const r of replies) {
        const where = r.path ? ' on ' + r.path + (r.line ? ':' + r.line : '') : '';
        out.push('- reply' + (r.replyingTo ? ' to ' + r.replyingTo : '') + where + ': ' + r.body.replace(/\s+/g, ' '));
      }
    }
    return { text: cut(out.join('\n')), label };
  }

  async function call(name, args) {
    if (name === 'read_file') return readFile(args || {});
    if (name === 'grep') return grep(args || {});
    if (name === 'get_step') return step(args || {});
    if (name === 'get_hunk') return hunk(args || {});
    if (name === 'get_threads') return reviewThreads(args || {});
    if (name === 'get_my_drafts') return myDrafts();
    if (name === 'draft_comment') return draftComment(args || {});
    return { text: 'error: unknown tool ' + name };
  }

  return { call, draft };
}
