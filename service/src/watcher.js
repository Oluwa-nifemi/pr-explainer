import { config } from './config.js';
import { graphql, rest, currentLogin } from './gh.js';
import * as store from './store.js';
import { enqueueBackground, isBusy, noteWatchedPr } from './jobs.js';

const TEAM_CACHE_MS = 24 * 60 * 60 * 1000;
const ENRICH_CONCURRENCY = 4;

const SEARCH_QUERY = `
  query($q: String!, $after: String) {
    search(query: $q, type: ISSUE, first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ... on PullRequest {
          number
          title
          url
          headRefOid
          isDraft
          updatedAt
          repository { nameWithOwner }
          author { login }
        }
      }
    }
  }
`;

const teamCache = new Map();

const lower = (value) => String(value || '').toLowerCase();

async function searchAll(query) {
  const nodes = [];
  let cursor = null;
  let hasNext = true;
  while (hasNext) {
    const data = await graphql(SEARCH_QUERY, { q: query, after: cursor });
    const page = data.search;
    nodes.push(...(page.nodes || []));
    cursor = page.pageInfo?.endCursor;
    hasNext = page.pageInfo?.hasNextPage;
  }
  return nodes;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function resolveTeammates(login) {
  const key = config.org + '|' + config.teams.join(',');
  const cached = teamCache.get(key);
  let members;
  if (cached && Date.now() - cached.fetchedAt < TEAM_CACHE_MS) {
    members = cached.members;
  } else {
    const lists = await Promise.all(
      (config.org ? config.teams : []).map((team) =>
        rest(
          'GET',
          '/orgs/' + encodeURIComponent(config.org) + '/teams/' + encodeURIComponent(team) + '/members?per_page=100',
        ).catch((err) => {
          console.error('watcher: team ' + team + ' lookup failed: ' + err.message);
          return [];
        }),
      ),
    );
    members = [...new Set(lists.flatMap((list) => (list || []).map((member) => member.login)))];
    teamCache.set(key, { members, fetchedAt: Date.now() });
  }
  const excluded = new Set([...config.excludedTeammates, login].map(lower));
  const seen = new Set();
  const resolved = [];
  for (const member of [...members, ...config.extraTeammates]) {
    const key = lower(member);
    if (excluded.has(key) || seen.has(key)) continue;
    seen.add(key);
    resolved.push(member);
  }
  return resolved;
}

async function fetchReviews(repo, number) {
  const reviews = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await rest('GET', '/repos/' + repo + '/pulls/' + number + '/reviews?per_page=100&page=' + page);
    if (!Array.isArray(batch)) break;
    reviews.push(...batch);
    if (batch.length < 100) break;
  }
  return reviews;
}

function latestNonCommentReviewsByReviewer(reviews, author, pendingLogins) {
  const pending = new Set(pendingLogins.map(lower));
  const authorKey = lower(author);
  const latest = new Map();
  for (const review of reviews) {
    const login = review?.user?.login;
    if (!login) continue;
    const key = lower(login);
    if (key === authorKey || review.state === 'COMMENTED' || pending.has(key)) continue;
    const existing = latest.get(key);
    if (!existing || new Date(review.submitted_at) > new Date(existing.submitted_at)) {
      latest.set(key, review);
    }
  }
  return latest;
}

export function isHandledByReview(reviews, author, pendingLogins) {
  const states = [...latestNonCommentReviewsByReviewer(reviews, author, pendingLogins).values()].map((r) => r.state);
  return states.includes('APPROVED') && !states.includes('CHANGES_REQUESTED');
}

async function classify(pr, login) {
  const detail = await rest('GET', '/repos/' + pr.repo + '/pulls/' + pr.number);
  const requested = (detail?.requested_reviewers || []).map((user) => user?.login).filter(Boolean);
  const isDirect = requested.some((name) => lower(name) === lower(login));
  if (isDirect) return { ...pr, source: 'review-requested' };
  const reviews = await fetchReviews(pr.repo, pr.number);
  if (isHandledByReview(reviews, pr.author, requested)) return null;
  return { ...pr, source: 'team-review-requested' };
}

function order(a, b) {
  return (
    (a.isDraft ? 1 : 0) - (b.isDraft ? 1 : 0) ||
    Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0)
  );
}

export async function watchCandidates() {
  const login = await currentLogin();
  if (!login) throw new Error('could not read the GitHub login');
  const teammates = await resolveTeammates(login);
  const teammateSet = new Set(teammates.map(lower));
  const limitToTeam = config.teams.length > 0 || config.extraTeammates.length > 0;
  const nodes = await searchAll(
    'is:pr is:open archived:false review-requested:' + login + (config.org ? ' org:' + config.org : ''),
  );

  const candidates = [];
  const seen = new Set();
  for (const node of nodes) {
    const repo = node.repository?.nameWithOwner;
    if (!repo || !node.number || !node.headRefOid) continue;
    const k = repo + '#' + node.number;
    if (seen.has(k)) continue;
    seen.add(k);
    if (config.ignoredRepos.includes(repo)) continue;
    const author = node.author?.login || '';
    if (!author || (limitToTeam && !teammateSet.has(lower(author)))) continue;
    candidates.push({
      repo,
      number: node.number,
      title: node.title || '',
      author,
      url: node.url || 'https://github.com/' + repo + '/pull/' + node.number,
      headRefOid: node.headRefOid,
      isDraft: Boolean(node.isDraft),
      updatedAt: node.updatedAt,
    });
  }

  const decided = await mapLimit(candidates, ENRICH_CONCURRENCY, async (pr) => {
    try {
      return await classify(pr, login);
    } catch (err) {
      console.error('watcher: ' + pr.repo + '#' + pr.number + ' skipped: ' + err.message);
      return null;
    }
  });

  return { login, teammates, items: decided.filter(Boolean).sort(order) };
}

export async function runWatcher({ dryRun = config.watchDryRun } = {}) {
  const { login, teammates, items } = await watchCandidates();

  if (dryRun) {
    const rows = [];
    for (const pr of items) {
      const story = await store.readStory(pr.repo, pr.number, pr.headRefOid);
      const current = Boolean(story && story.generation?.status === 'done');
      rows.push({ ...pr, current });
      console.log(
        'would queue ' +
          pr.repo + '#' + pr.number +
          ' | source ' + pr.source +
          ' | draft ' + (pr.isDraft ? 'yes' : 'no') +
          ' | author ' + pr.author +
          ' | ' + pr.title +
          (current ? ' | (story already current, a live run would skip)' : ''),
      );
    }
    console.log(
      'watcher preview: login ' + login +
        ', teammates ' + teammates.length + ' (' + teammates.join(', ') + ')' +
        ', matched ' + rows.length,
    );
    return { dryRun: true, login, teammates, found: rows.length, queued: [], items: rows };
  }

  const queued = [];
  let skipped = 0;
  for (const pr of items) {
    const story = await store.readStory(pr.repo, pr.number, pr.headRefOid);
    const current = Boolean(story && story.generation?.status === 'done');
    noteWatchedPr(pr, current, story);
    if (current || isBusy(pr.repo, pr.number)) {
      skipped++;
      continue;
    }
    if (
      enqueueBackground({
        repo: pr.repo,
        number: pr.number,
        headSha: pr.headRefOid,
        source: pr.source,
      })
    ) {
      queued.push(pr.repo + '#' + pr.number);
    }
  }

  const summary = {
    dryRun: false,
    login,
    teammates,
    found: items.length,
    queued: queued.length,
    skipped,
    items: queued,
  };
  console.log(
    'watcher: found ' +
      summary.found +
      ', queued ' +
      summary.queued +
      ', skipped ' +
      summary.skipped +
      (queued.length ? ' -> ' + queued.join(', ') : ''),
  );
  return summary;
}

export function startWatcher() {
  if (config.watchDryRun) {
    runWatcher({ dryRun: true }).catch((err) => console.error('watcher: ' + err.message));
    return null;
  }
  let active = false;
  const tick = async () => {
    if (active) return;
    active = true;
    try {
      await runWatcher({ dryRun: false });
    } catch (err) {
      console.error('watcher: ' + err.message);
    } finally {
      active = false;
    }
  };
  void tick();
  const timer = setInterval(tick, config.watchIntervalS * 1000);
  timer.unref?.();
  return timer;
}
