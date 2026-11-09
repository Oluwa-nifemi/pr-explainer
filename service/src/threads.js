import * as store from './store.js';
import { graphql } from './gh.js';
import { placeThread } from './placement.js';
import * as sse from './sse.js';
import { getItem, getStory, noteThreads } from './jobs.js';

const states = new Map();
const STALE_MS = 60 * 1000;

function key(repo, number) {
  return repo + '#' + number;
}

const COMMENT_FIELDS = `
  id
  url
  body
  bodyHTML
  createdAt
  author { login avatarUrl __typename }
  reactionGroups { content viewerHasReacted reactors { totalCount } }
`;

const THREAD_FIELDS = `
  id
  isResolved
  isOutdated
  path
  line
  startLine
  originalLine
  diffSide
  subjectType
  resolvedBy { login }
  comments(first: 100) {
    pageInfo { hasNextPage endCursor }
    nodes { ${COMMENT_FIELDS} }
  }
`;

const THREADS_QUERY = `
  query($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        headRefOid
        reviewThreads(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { ${THREAD_FIELDS} }
        }
      }
    }
  }
`;

const THREAD_COMMENTS_QUERY = `
  query($id: ID!, $after: String) {
    node(id: $id) {
      ... on PullRequestReviewThread {
        comments(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { ${COMMENT_FIELDS} }
        }
      }
    }
  }
`;

export function mapComment(node) {
  return {
    id: node.id,
    author: {
      login: node.author?.login || 'ghost',
      avatarUrl: node.author?.avatarUrl || '',
      isBot: node.author?.__typename === 'Bot',
    },
    body: node.body || '',
    bodyHtml: node.bodyHTML || '',
    createdAt: node.createdAt,
    url: node.url || '',
    reactions: (node.reactionGroups || []).map((group) => ({
      content: group.content,
      count: group.reactors?.totalCount ?? 0,
      mine: Boolean(group.viewerHasReacted),
    })),
  };
}

async function loadComments(threadId, firstPage) {
  const comments = [...(firstPage.nodes || [])];
  let cursor = firstPage.pageInfo?.endCursor;
  let hasNext = firstPage.pageInfo?.hasNextPage;
  while (hasNext) {
    const data = await graphql(THREAD_COMMENTS_QUERY, { id: threadId, after: cursor });
    const page = data.node?.comments;
    if (!page) break;
    comments.push(...(page.nodes || []));
    cursor = page.pageInfo?.endCursor;
    hasNext = page.pageInfo?.hasNextPage;
  }
  return comments.map(mapComment).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

async function fetchThreads(repo, number) {
  const [owner, name] = repo.split('/');
  let cursor = null;
  let headSha = '';
  const nodes = [];
  let hasNext = true;
  while (hasNext) {
    const data = await graphql(THREADS_QUERY, { owner, name, number, after: cursor });
    const pr = data.repository?.pullRequest;
    if (!pr) throw new Error('pull request not found: ' + repo + '#' + number);
    headSha = pr.headRefOid || headSha;
    const page = pr.reviewThreads;
    nodes.push(...(page.nodes || []));
    cursor = page.pageInfo?.endCursor;
    hasNext = page.pageInfo?.hasNextPage;
  }
  const threads = [];
  for (const node of nodes) {
    threads.push({
      id: node.id,
      url: node.comments?.nodes?.[0]?.url || '',
      path: node.path || '',
      side: node.diffSide === 'LEFT' ? 'LEFT' : 'RIGHT',
      line: node.line ?? null,
      startLine: node.startLine ?? null,
      originalLine: node.originalLine ?? null,
      isResolved: Boolean(node.isResolved),
      ...(node.resolvedBy?.login ? { resolvedBy: node.resolvedBy.login } : {}),
      isOutdated: Boolean(node.isOutdated),
      subjectType: node.subjectType === 'FILE' ? 'FILE' : 'LINE',
      placement: { kind: 'outdated', stepId: null, hunkId: null },
      comments: await loadComments(node.id, node.comments || {}),
    });
  }
  return { headSha, threads };
}

function countsOf(threads) {
  return {
    open: threads.filter((t) => !t.isResolved).length,
    resolved: threads.filter((t) => t.isResolved).length,
    openByBots: threads.filter((t) => !t.isResolved && t.comments[0]?.author?.isBot).length,
  };
}

async function loadState(repo, number) {
  const k = key(repo, number);
  let state = states.get(k);
  if (state) return state;
  const cached = await store.readThreadsCache(repo, number);
  state = {
    cache: cached || null,
    fetchedAtMs: cached ? Date.parse(cached.fetchedAt) || 0 : 0,
    refreshing: false,
    promise: null,
  };
  states.set(k, state);
  return state;
}

function withRefreshing(state) {
  if (!state.cache) return null;
  return { ...state.cache, refreshing: state.refreshing };
}

async function placementStory(repo, number) {
  const item = getItem(repo, number);
  if (!item) return null;
  const live = getStory(repo, number);
  if (live) return live;
  if (!item.headSha) return null;
  return store.readStory(repo, number, item.headSha);
}

async function doRefresh(repo, number, state) {
  const { headSha, threads } = await fetchThreads(repo, number);
  const story = await placementStory(repo, number);
  for (const thread of threads) thread.placement = placeThread(thread, story);
  const result = {
    schemaVersion: 1,
    pr: { repo, number, headSha },
    placedAgainstSha: story?.pr?.headSha ?? null,
    fetchedAt: new Date().toISOString(),
    refreshing: false,
    counts: countsOf(threads),
    threads,
  };
  state.cache = result;
  state.fetchedAtMs = Date.parse(result.fetchedAt);
  await store.writeThreadsCache(repo, number, result);
  noteThreads(repo, number, result.counts.open);
  sse.publish(key(repo, number), 'threads', result);
  return result;
}

function startRefresh(repo, number, state) {
  if (state.promise) return state.promise;
  state.refreshing = true;
  state.promise = doRefresh(repo, number, state).finally(() => {
    state.refreshing = false;
    state.promise = null;
  });
  return state.promise;
}

export async function refreshThreads(repo, number) {
  const state = await loadState(repo, number);
  return startRefresh(repo, number, state);
}

export async function getThreads(repo, number, { refresh = false } = {}) {
  const state = await loadState(repo, number);
  if (refresh || !state.cache) return startRefresh(repo, number, state);
  if (Date.now() - state.fetchedAtMs > STALE_MS) {
    startRefresh(repo, number, state).catch((err) =>
      console.error('threads refresh failed ' + repo + '#' + number + ': ' + err.message),
    );
  }
  return withRefreshing(state);
}

export async function peekThreads(repo, number) {
  const state = await loadState(repo, number);
  return state.cache;
}
