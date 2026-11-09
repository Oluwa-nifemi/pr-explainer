// Plain-words description of how a story is made. The settings page shows it.
// Prompt blocks are referenced by id. The text of each block lives in settings.js.

export const PIPELINE_INFO = {
  stages: [
    { id: 'fetch', title: 'Read the PR', body: 'The service asks GitHub for the diff and the PR details: title, description, author and branches.' },
    { id: 'filter', title: 'Drop the noise', body: 'Lockfiles, snapshots, binary files, generated code, very large files and whitespace-only changes are left out. Tests, config and docs are tagged so they can be treated differently.', link: 'files' },
    { id: 'split', title: 'Cut big hunks', body: 'A hunk with 150 or more changed lines is cut into parts at natural boundaries by a short model call. A step can then take one part of a big file.' },
    { id: 'mirror', title: 'Fetch the code', body: 'git fetches the PR head and base commits into a local bare mirror. Workers read callers, callees and the old version of code from it.' },
    { id: 'plan', title: 'Plan and summarise at the same time', body: 'The planner groups the hunks into review steps and streams them back. The summary agent writes the overview. They do not wait for each other.', link: 'prompts' },
    { id: 'explain', title: 'One worker per step', body: 'Each step goes to its own worker as soon as the planner finishes it. Workers run in parallel. A worker sees only its own step, plus code context that was read by code, not by the model.', link: 'prompts' },
    { id: 'check', title: 'Check in code', body: 'Code checks the model output: every hunk is in exactly one step, small steps are merged, gists and diagrams must follow the rules, and bad ones are fixed or dropped.' },
    { id: 'save', title: 'Save', body: 'The story is saved per PR and head commit. It is shown from the saved copy until you regenerate it or the PR gets a new commit.' },
  ],
  agents: [
    {
      id: 'planner',
      title: 'Planner',
      job: 'Splits the PR into review steps.',
      blocks: [
        { type: 'section', id: 'system' },
        { type: 'data', title: 'PR details', note: 'Title, author, branches and the first 4000 characters of the description.' },
        { type: 'data', title: 'File list', note: 'Every kept file with its role, status and changed line count.' },
        { type: 'data', title: 'The diff', note: 'Every hunk with an id (h1, h2, ...), cut to 120 lines each.' },
        { type: 'section', id: 'plannerTask' },
        { type: 'section', id: 'style' },
        { type: 'section', id: 'reviewOrder' },
      ],
    },
    {
      id: 'summary',
      title: 'Summary agent',
      job: 'Writes the overview: one line, why, bullets and risk.',
      blocks: [
        { type: 'section', id: 'system' },
        { type: 'data', title: 'PR details', note: 'Title, author, branches and the first 4000 characters of the description.' },
        { type: 'data', title: 'File list', note: 'Every kept file with its role, status and changed line count.' },
        { type: 'data', title: 'The diff', note: 'Every hunk, cut to 80 lines each.' },
        { type: 'section', id: 'summaryTask' },
        { type: 'section', id: 'style' },
      ],
    },
    {
      id: 'worker',
      title: 'Workers',
      job: 'One per step. Writes the gist, the optional diagram and the test notes.',
      blocks: [
        { type: 'section', id: 'system' },
        { type: 'data', title: 'PR details', note: 'Title, author, branches and the first 2500 characters of the description.' },
        { type: 'data', title: 'The step', note: 'Its title and summary from the planner.' },
        { type: 'data', title: 'Hunks of this step', note: 'The code of the step with line numbers.' },
        { type: 'data', title: 'Full functions for the diagram', note: 'Whole bodies, at the PR head, of changed functions that branch.' },
        { type: 'data', title: 'Test hint', note: 'Which hunks come from test files, when there are any.' },
        { type: 'data', title: 'Code context', note: 'The old version of changed functions, callers of changed names, and functions the changed code calls. Read by code.' },
        { type: 'section', id: 'workerTask' },
        { type: 'section', id: 'style' },
        { type: 'section', id: 'gistRules' },
        { type: 'section', id: 'inlineGist' },
        { type: 'section', id: 'diagramRules' },
        { type: 'section', id: 'hunkNotesRules' },
      ],
    },
  ],
  checks: [
    { title: 'Every hunk has a home', rules: ['Each hunk is in exactly one step.', 'A hunk the planner missed is added to a step.', 'A step under about 20 changed lines is merged into a neighbour.'] },
    { title: 'At most 10 steps', rules: ['Extra steps are merged into the step before them.'] },
    { title: 'Gist limits', rules: ['2 or 3 sentences, at most 55 words.', 'No em dash, no arrows, no question mark.', 'No colon followed by a space.', 'At most one bold phrase and one backticked name.', 'No mention of other steps, and no "already".', 'No filler words such as "leverage" or "robust".', 'A gist that breaks a rule gets one rewrite request. If it still breaks, it is kept with a warning.'] },
    { title: 'Summary limits', rules: ['3 to 5 bullets.', 'Each bullet at most 12 words. Longer ones are shortened in code.'] },
    { title: 'Diagram limits', rules: ['3 to 6 nodes and at most 4 columns.', 'A label is at most 8 words and names no code.', 'Every decision has two different exits.', 'Every end matches a branch outcome in the code.', 'No arrow skips a column.', 'A loop needs a reason, such as a retry or a re-plan.', 'A diagram that breaks a rule gets one fix request, then it is dropped.'] },
  ],
};
