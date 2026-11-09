# PR Explainer

Turns a pull request into a short walkthrough a reviewer reads before the code.
Read README.md for how to run it.

## Layout

- `pipeline/` builds a story from a PR: diff parsing, planner, summary, workers, checks. Plain Node (ESM), no build step.
- `service/` is the local HTTP server (port 5190). It queues jobs, talks to GitHub, stores stories, serves chat and review posting. It imports the pipeline directly.
- `app/` is the UI (port 5180). Preact with htm, built by Vite. No state library: `app/src/lib/session.js` holds the state.
- `docs/` and `demo-ui/` are local only and git-ignored. Do not rely on them.

## Run and check

- Run it with `docker compose up -d --build`. The UI is built into the image, so rebuild after every UI change.
- Develop without Docker with `cd service && npm start` and `cd app && npm run dev`. Stop the containers first, they use the same ports.
- There is no test suite. Check a change by running it: call the API with curl, or open the page.
- Run `node --check` on every file you edit. For the app, run `npx vite build` in `app/`.

## Where data lives

- `~/.cache/pr-explainer/` holds stories, chat history and git mirrors.
- `~/.config/pr-explainer/credentials.json` holds the GitHub token and LiteLLM key.
- `~/.config/pr-explainer/overrides.json` holds the user's prompt and file-rule changes.
- In Docker, the same folders are volumes.
- Never put a token, key or real PR content in the repo.

## Rules that matter

- **Defaults live in code, user changes live in the overrides file.** Never write user settings into the repo. A missing key in the file means "use the default". See `pipeline/src/settings.js`.
- **Prompt text is data.** The default text is in `pipeline/src/prompt-defaults.js`. When you refactor prompts, the text sent to the model must stay byte-identical unless you mean to change it. Compare before and after on a real PR diff.
- **Pipeline version.** Any change to the pipeline files or to the overrides changes `pipelineVersion`. Saved stories then show as Outdated. They do not regenerate by themselves. The user clicks Regenerate.
- **Code checks the model.** Limits on gists, summaries and diagrams live in `story.js` and `validate.js`. If you change a prompt rule, check that the code limit still agrees.
- **Secrets stay out of logs and responses.** The service never returns a saved token.

## Style

- Keep it simple. No new abstraction, library or setting unless the task needs it.
- No comments unless the code is not obvious. Name things well instead.
- Text the user reads is plain and short. Use everyday words. Say "check", not "predicate". Short sentences, active voice, no em dash.
- UI work must match the existing look: warm paper colours, Fraunces headings, Instrument Sans body, the same buttons and cards. Look at `app/src/styles.css` before adding styles.
- Diagrams show control flow only. Never draw a diagram of how code is organised.

## Git

- Keep commits small and grouped by area. Write the message as what changed and why.
- Do not commit `node_modules`, `dist`, build output, logs or local scratch files.
