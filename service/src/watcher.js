import { config } from './config.js';
import { getOverrides } from '../../pipeline/src/settings.js';
import { graphql, rest, currentLogin } from './gh.js';
import * as store from './store.js';
import { enqueueBackground, isBusy, noteWatchedPr } from './jobs.js';

let timer = null;
let timerIntervalMs = 0;

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
let detected = null;

const lower = (value) => String(value || '').toLowerCase();

function watchSettings() {
  return getOverrides().watch || {};
}

// A key missing from the settings file falls back to the environment, so an existing setup keeps
// working, and an empty list means "I turned every team off".
export function watchTeams() {
  const saved = watchSettings().teams;
  return Array.isArray(saved) ? saved : config.teams;
}

export function watchIgnoredRepos() {
  const saved = watchSettings().ignoredRepos;
  return Array.isArray(saved) ? saved : config.ignoredRepos;
}

export function watchIntervalS() {
  const minutes = Number(watchSettings().intervalMinutes);
  if (Number.isFinite(minutes) && minutes >= 1) return Math.round(minutes * 60);
  return config.watchIntervalS;
}

// The teams you are on, so the teammate filter needs no setup. Cached for a day.
export async function detectTeams({ fresh = false } = {}) {
  // A failed lookup is retried after a minute, a good one is kept for a day.
  const keepMs = detected?.error ? 60 * 1000 : TEAM_CACHE_MS;
  if (!fresh && detected && Date.now() - detected.fetchedAt < keepMs) return detected;
  const teams = [];
  let error = null;
  try {
    for (let page = 1; page <= 20; page++) {
      const batch = await rest('GET', '/user/teams?per_page=100&page=' + page);
      if (!Array.isArray(batch)) break;
      for (const team of batch) {
        const org = team?.organization?.login || '';
        if (config.org && lower(org) !== lower(config.org)) continue;
        if (typeof team?.slug !== 'string' || !team.slug) continue;
        teams.push({
          slug: team.slug,
          name: team.name || team.slug,
          reposCount: Number(team.repos_count) || 0,
          membersCount: Number(team.members_count) || 0,
        });
      }
      if (batch.length < 100) break;
    }
  } catch (err) {
    error = err.message;
    console.error('watcher: team detection failed: ' + error);
  }
  detected = { teams, error, fetchedAt: Date.now() };
  return detected;
}

// The settings page must never wait on GitHub, so a slow lookup returns what we already know.
export async function detectTeamsWithin(ms) {
  const raced = await Promise.race([
    detectTeams(),
    new Promise((resolve) => setTimeout(() => resolve(null), ms).unref?.()),
  ]);
  return raced || { teams: detected?.teams || [], error: 'GitHub did not answer yet', fetchedAt: detected?.fetchedAt || Date.now() };
}

// A team that owns almost nothing is not a code review team, so it stays off until it is asked for.
export const DEFAULT_MIN_REPOS = 2;

export function effectiveWatchTeams() {
  const saved = watchTeams();
  if (saved.length) return saved;
  if (config.teams.length) return config.teams;
  return (detected?.teams || []).filter((team) => team.reposCount >= DEFAULT_MIN_REPOS).map((team) => team.slug);
}

async function configuredTeams() {
  if (watchTeams().length || config.teams.length) return effectiveWatchTeams();
  await detectTeams();
  return effectiveWatchTeams();
}

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
  const teams = await configuredTeams();
  const key = config.org + '|' + teams.join(',');
  const cached = teamCache.get(key);
  let members;
  if (cached && Date.now() - cached.fetchedAt < TEAM_CACHE_MS) {
    members = cached.members;
  } else {
    const lists = await Promise.all(
      teams.map((team) =>
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

// A PR stays in the list while your review is still requested, even when someone else already
// approved it. Only your own review takes it off the list, and GitHub does that for us.
async function classify(pr, login) {
  const detail = await rest('GET', '/repos/' + pr.repo + '/pulls/' + pr.number);
  const requested = (detail?.requested_reviewers || []).map((user) => user?.login).filter(Boolean);
  const isDirect = requested.some((name) => lower(name) === lower(login));
  return { ...pr, source: isDirect ? 'review-requested' : 'team-review-requested' };
}

function order(a, b) {
  return Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0);
}

export async function watchCandidates() {
  const login = await currentLogin();
  if (!login) throw new Error('could not read the GitHub login');
  const teammates = await resolveTeammates(login);
  const teammateSet = new Set(teammates.map(lower));
  const ignored = watchIgnoredRepos();
  const limitToTeam = effectiveWatchTeams().length > 0 || config.extraTeammates.length > 0;
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
    if (ignored.includes(repo)) continue;
    if (node.isDraft) continue;
    const author = node.author?.login || '';
    if (!author || (limitToTeam && !teammateSet.has(lower(author)))) continue;
    candidates.push({
      repo,
      number: node.number,
      title: node.title || '',
      author,
      url: node.url || 'https://github.com/' + repo + '/pull/' + node.number,
      headRefOid: node.headRefOid,
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

// The settings file wins over the environment. A missing key means "use the env default",
// so an existing setup behaves exactly as before the toggle existed.
export function watcherEnabled() {
  const saved = getOverrides().watch?.enabled;
  return typeof saved === 'boolean' ? saved : config.watch;
}

export function watcherRunning() {
  return Boolean(timer);
}

export function stopWatcher() {
  if (timer) clearInterval(timer);
  timer = null;
  timerIntervalMs = 0;
}

export function startWatcher() {
  if (config.watchDryRun) {
    runWatcher({ dryRun: true }).catch((err) => console.error('watcher: ' + err.message));
    return null;
  }
  if (timer) return timer;
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
  timerIntervalMs = watchIntervalS() * 1000;
  timer = setInterval(tick, timerIntervalMs);
  timer.unref?.();
  return timer;
}

export function syncWatcher() {
  const on = watcherEnabled();
  if (config.watchDryRun) return on;
  if (!on) stopWatcher();
  else if (timer && timerIntervalMs !== watchIntervalS() * 1000) {
    stopWatcher();
    startWatcher();
  } else startWatcher();
  return on;
}
