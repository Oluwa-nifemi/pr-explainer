import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pipelineVersion, generateStory } from './generate.js';
import { globalLimiter, llmSettings } from './llm.js';
import { MODELS, getStoryModel } from './models.js';
import { validateStory } from './validate.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(
    process.argv
      .slice(2)
      .map((a) => a.replace(/^--/, '').split('='))
      .map(([k, ...rest]) => [k, rest.join('=')])
  );
  const spec = args.pr;
  if (!spec) {
    console.error('usage: node src/run.js --pr=owner/repo#number');
    process.exit(1);
  }
  const hash = spec.lastIndexOf('#');
  const repo = spec.slice(0, hash);
  const number = Number(spec.slice(hash + 1));
  if (hash < 0 || !repo.includes('/') || !Number.isInteger(number) || number <= 0) {
    console.error('bad --pr value: ' + spec + ' (expected owner/repo#number)');
    process.exit(1);
  }

  const { apiKey, baseUrl } = llmSettings();
  if (!process.env.PR_EXPLAINER_GITHUB_TOKEN) {
    console.error('PR_EXPLAINER_GITHUB_TOKEN is not set');
    process.exit(1);
  }
  if (!apiKey) {
    console.error('PR_EXPLAINER_LITELLM_API_KEY is not set');
    process.exit(1);
  }

  const t0 = Date.now();
  const secs = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
  const t = (s) => String(s).padStart(7);
  let lastType = null;

  console.error('pipeline ' + pipelineVersion() + ' model ' + MODELS[getStoryModel()].label + ' at ' + baseUrl + ' cap ' + globalLimiter.max);

  const onEvent = (type, data) => {
    lastType = type;
    if (type === 'story') console.error(t(secs()) + ' ' + type + ' ' + data.pr.repo + '#' + data.pr.number + ' head ' + data.pr.headSha.slice(0, 7));
    else if (type === 'summary') console.error(t(secs()) + ' ' + type + ' ' + String(data.why).slice(0, 80));
    else if (type === 'plan') console.error(t(secs()) + ' ' + type + ' ' + data.length + ' steps');
    else if (type === 'step') console.error(t(secs()) + ' ' + type + ' ' + data.id + ' ' + data.status + ' ' + data.title + (data.error ? ' (' + data.error + ')' : ''));
    else if (type === 'done') console.error(t(secs()) + ' ' + type + ' ' + JSON.stringify(data.timings));
    else if (type === 'error') console.error(t(secs()) + ' ' + type + ' ' + data.code + ': ' + data.message);
  };

  try {
    const story = await generateStory({ repo, number }, { onEvent, priority: 'user' });
    const [owner, name] = repo.split('/');
    const outDir = join(root, 'out-v3');
    const outPath = join(outDir, owner + '__' + name + '__' + number + '__' + story.pr.headSha.slice(0, 7) + '.json');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(outPath, JSON.stringify(story, null, 2));
    const violations = validateStory(story, null);
    const ready = story.steps.filter((s) => s.status === 'ready').length;
    console.error(
      'wrote ' + outPath +
        ' | steps ' + story.steps.length + ' (ready ' + ready + ', failed ' + (story.steps.length - ready) + ')' +
        ' | hunks ' + story.steps.reduce((n, s) => n + s.hunks.length, 0) +
        ' | questions ' + story.steps.reduce((n, s) => n + (s.questions?.length || 0), 0) +
        ' | violations ' + violations.length
    );
    if (violations.length) console.error('  ' + violations.join('\n  '));
    if (lastType === 'error') process.exitCode = 1;
  } catch (e) {
    console.error('failed: ' + String(e.message || e));
    process.exitCode = 1;
  }
}
