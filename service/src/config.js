import { homedir } from 'node:os';
import { join } from 'node:path';

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function list(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = {
  host: process.env.PRX_HOST || '127.0.0.1',
  port: num(process.env.PRX_PORT, 5190),
  origin: process.env.PRX_ORIGIN || 'http://127.0.0.1:5180',
  home: process.env.PRX_HOME || join(homedir(), '.cache', 'pr-explainer'),
  org: process.env.PRX_ORG || '',
  teams: list('PRX_TEAMS', []),
  extraTeammates: list('PRX_EXTRA_TEAMMATES', []),
  excludedTeammates: list('PRX_EXCLUDED_TEAMMATES', []),
  ignoredRepos: list('PRX_IGNORED_REPOS', []),
  maxStories: num(process.env.PRX_MAX_STORIES, 2),
  watch: process.env.PRX_WATCH !== '0',
  watchIntervalS: num(process.env.PRX_WATCH_INTERVAL_S, 180),
  watchDryRun: process.env.PRX_WATCH_ONCE_DRYRUN === '1',
  fake: process.env.PRX_FAKE_GENERATOR === '1',
  dryRun: process.env.PRX_DRY_RUN === '1',
};
