# PR Explainer

Read a pull request in the order it makes sense, with a short orientation for each step, before you read the code.

## Why it exists

A diff shows files in alphabetical order. A reviewer needs the story first: what the change is for, how the pieces fit, and where the decisions are. Most of the time goes into rebuilding that story in your head.

PR Explainer builds it for you:

- It groups the changes into steps, in the order you should read them.
- Each step gets a short gist of what that part does, so you know what you are about to read.
- Where a step branches, it draws the control flow. It never draws diagrams of how code is organised.
- It does not retell the diff, and it does not hunt for bugs. Your CI and your own eyes do that. You still read the code.

## See it in action

**PR walkthrough.**

Follow [budget-bot #1](https://github.com/Oluwa-nifemi/budget-bot/pull/1) from the overview through the review steps, diagrams and comments.

https://github.com/user-attachments/assets/f798ded0-5c45-43e8-a12b-6b1d76d108b2

**Generation.**

From pasting a PR link to the finished walkthrough. This recording is sped up 3×.

https://github.com/user-attachments/assets/8ea76f7c-e585-44c9-b204-d5f8ab325938

**Settings.**

Edit the worker prompt, choose how many diagrams you want, and change file rules.

https://github.com/user-attachments/assets/550eb711-e193-4f28-9151-b25ca50ac077

## How it works

![How a PR story is made, from reading the diff to parallel model calls, checks and the saved story](assets/how-it-works.svg)

Blue boxes are model calls. The rest is plain code. The planner streams its steps, so a worker starts on each step as soon as it arrives. A worker sees only its own step, plus code context that was read by code and not by the model: the old version of changed functions, callers of changed names, and the functions they call. After the models answer, code checks the result. Every hunk must be in exactly one step, gists and diagrams must follow the rules, and anything that breaks them is fixed once or dropped.

## Quick start

You need Docker, a GitHub token and a [LiteLLM](https://github.com/BerriAI/litellm) gateway.

1. Clone the repo and copy the example settings:

   ```sh
   git clone https://github.com/Oluwa-nifemi/pr-explainer.git
   cd pr-explainer
   cp .env.example .env
   ```

2. Edit `.env`. Set your gateway URL and, if your gateway uses other model names, the model ids. You can also leave the keys empty and enter them on the setup screen.
3. Start it:

   ```sh
   ./start.sh
   ```

   It starts the Claude Code bridge when Claude Code is signed in, then the containers. `--no-build` skips the rebuild, `--stop` stops both, `--install-service` starts the bridge at login. `docker compose up -d --build` still works on its own.

4. Open http://127.0.0.1:5180. Enter your GitHub token and LiteLLM key if asked, paste a PR link, and wait a few seconds.

The containers restart by themselves when Docker starts. Turn on "Start Docker Desktop when you sign in" and nothing else is needed.

### Open a PR from Raycast

Add this repo's `raycast/` folder as a Script Directory in Raycast Settings → Extensions → Script Commands. The script must be executable: `chmod +x raycast/explain-pr.sh`.

Search for **Explain PR**, paste a GitHub PR URL into the argument field, and press Enter. It opens that PR in your browser. PR Explainer must already be running locally.

**GitHub token.** It must read the repos you review and write reviews. A classic token with `repo` works. A fine-grained token needs Pull requests (read and write) and Contents (read).

**LiteLLM gateway.** The service calls `/chat/completions` on your gateway. Only LiteLLM is tested.

**Claude Code instead.** You can write stories and chat with a Claude Code login instead of a gateway. `./start.sh` starts the bridge on your machine; then pick Claude Code in Settings → Connections or on the setup screen.

Inside Docker the bridge is reachable at `http://host.docker.internal:5191`, which is the default. Set `PR_EXPLAINER_CLAUDE_BASE_URL` only if the bridge is not on the machine that runs Docker. The bridge runs on your machine because the login belongs to the `claude` command and cannot be copied into a container. Chat uses it too: lookups are passed through the bridge as tool calls. See [bridge/README.md](bridge/README.md) to keep the bridge running at login.

<details>
<summary>Run without Docker</summary>

```sh
cd service && npm start     # port 5190
cd app && npm install && npm run dev   # port 5180
```

Needs Node 22 and git. Stop the containers first, they use the same ports.

Export reads the page built by `npm run build:export --prefix app`. Run that once, or it answers with a 500.

</details>

## Export a story

Open a PR and pick Export from the `⋯` menu in the header. You get one HTML file with the whole story inside it: the overview, every step, the diagrams, the diffs and the test and doc files. Your draft comments are kept too, in that file's own local storage.

The file works with no service behind it. Open it by double-clicking, or send it to someone. Chat and the file lines between hunks need the service, so they are off in an export. The exported story is a snapshot: it does not follow new commits.

A comment you write in an export stays in that file's local storage, so it survives a reload. An export cannot post to GitHub, so the Review button shows the whole review in the page: your summary, and each comment with its `path:line`, the code it points at, and a link to that file's diff on GitHub. Copy as markdown or Download .md takes it out to paste into GitHub's review box. GitHub has no link that fills in a review for you.

## Features

- A PR split into review steps, each with a short gist
- Flow diagrams for steps that branch
- One-line notes on test hunks. Tests and docs sit in a closing section
- Comments on lines and ranges, thread replies and reactions
- Drafts you keep until you post everything as one review
- Chat grounded in the repo, which can also read the PR description and your drafts when you ask
- Stories marked Outdated when prompts change, and Regenerate on request
- The model that wrote a story is shown on the overview. Changing the model does not mark saved stories outdated
- Retry for one failed step
- Editable prompts and file rules
- Export one PR as a single HTML file you can send to someone

## Configuration

Put these in `.env`. Docker Compose reads the file by itself.

| Variable | Meaning |
|---|---|
| `PR_EXPLAINER_GITHUB_TOKEN` | GitHub token. Optional, you can use the setup screen |
| `PR_EXPLAINER_LITELLM_API_KEY` | LiteLLM key. Optional, you can use the setup screen |
| `PR_EXPLAINER_LITELLM_BASE_URL` | Gateway URL, without `/v1` |
| `PR_EXPLAINER_FAST_MODEL` | Model id for the fast profile. Default `deepseek-chat` |
| `PR_EXPLAINER_STRONG_MODEL` | Model id for the strong profile. Default `claude-opus-4-5` |
| `PR_EXPLAINER_STRONG_MODEL_BODY` | Optional JSON merged into every request to the strong model, for example routing tags |
| `PRX_WATCH` | Default for the background watcher. The Settings page switch overrides it. Docker turns it off unless you set this |
| `PRX_ORG` | Org the watcher searches |
| `PRX_TEAMS` | Default teams for the teammate filter. The Features settings page overrides it, and with neither set the teams you are on are used |
| `PRX_EXTRA_TEAMMATES`, `PRX_EXCLUDED_TEAMMATES` | Add or remove logins in the teammate list. When set, the watcher only queues their PRs |
| `PRX_IGNORED_REPOS` | Default repos the watcher never queues. The Features settings page overrides it |

### Settings page

Click Settings on the home page. You can read and change:

- **How it works.** The flow above, with the checks that always run.
- **Prompts.** Everything each agent is sent, in order. Edit the planner, summary and worker text, and choose how many diagrams you want.
- **Files.** What is left out of stories, such as lockfiles and snapshots, and how files are labelled as test, config or docs. Add your own patterns and try a path before you save.
- **Connections.** Your GitHub and LiteLLM details.
- **Diagnostics.** Export recent service logs and this tab's browser errors as one JSON file. It works before setup too.

Your changes are saved to `~/.config/pr-explainer/overrides.json`, outside the project. Anything you do not change follows the defaults. Saving marks existing stories as Outdated, and you regenerate them one at a time. To go back to the defaults, delete the file. In Docker: `docker compose exec service rm /home/node/.config/pr-explainer/overrides.json`.

### Temporary GitHub failures

GitHub reads retry up to twice after connection failures or HTTP 500, 502, 503 and 504 responses. Each read attempt times out after 15 seconds. Retries use short, increasing delays. Authentication, permission and rate-limit failures are not retried. Reviews, comments and other GitHub writes are never retried automatically.

If opening a PR still fails, click **Retry** on the error page. You do not need to reload. Logs include each retry and whether the request recovered.

A connection outage during startup does not mean your saved credentials are missing. The app keeps saved stories accessible and shows which connection is unavailable. It checks again automatically and removes the notice after recovery. Setup appears only for missing credentials, rejected credentials or settings that need correction.

### Export logs for debugging

Open **Settings → Diagnostics → Export logs**. If setup is blocked, click **Diagnostics** on the setup screen. You can also open http://127.0.0.1:5180/?settings=diagnostics directly.

The export includes up to 2 MB of recent service and pipeline logs, runtime details, and up to 200 browser events from the current tab. Browser events survive reloads in that tab and expire after 14 days. They include failed requests, broken connections, failed resource loads and interrupted streams, not request bodies or chat text.

If the service is unreachable, the download still contains browser logs. The page and the file both say that service logs are missing. Export before closing the affected tab.

Configured GitHub and LiteLLM keys and common credential patterns are redacted from service logs during export. Repository names, file paths and existing pipeline output may remain. Review the file before sharing it. Export does not upload anything.

Docker Compose normally saves service logs in `logs/service.log`, with 5 MB rotation and up to five older files. Rotated files expire after 14 days. If that folder is not writable, the service uses its cache folder. You can also inspect console output with `docker compose logs service`.

## Privacy and limits

- The diff and some repo context (changed functions, their callers, the old code) go to your LiteLLM gateway. Your GitHub token goes only to GitHub.
- Tokens are stored on your machine only. The service never returns them.
- The ports listen on `127.0.0.1` only. There is no login, so this is a single-user tool.

## License

MIT. See [LICENSE](LICENSE).
