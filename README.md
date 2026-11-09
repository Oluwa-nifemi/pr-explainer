# PR Explainer

Read a pull request in the order it makes sense, with a short orientation for each step, before you read the code.

<!--
  HERO VIDEO: drag the mp4 into the GitHub editor, then paste the https://github.com/user-attachments/... link on its own line below.
-->

> **[ Video 1: walkthrough of a real PR ]**
> Paste a PR link, open the overview, step through two or three steps, show a diagram, leave a comment.

## Why it exists

A diff shows files in alphabetical order. A reviewer needs the story first: what the change is for, how the pieces fit, and where the decisions are. Most of the time goes into rebuilding that story in your head.

PR Explainer builds it for you:

- It groups the changes into steps, in the order you should read them.
- Each step gets a short gist of what that part does, so you know what you are about to read.
- Where a step branches, it draws the control flow. It never draws diagrams of how code is organised.
- It does not retell the diff, and it does not hunt for bugs. Your CI and your own eyes do that. You still read the code.

## See it

**Generation.**

> **[ Video 2: generating a story ]**
> Open a new PR and show the story appearing: summary, plan, then the steps filling in. Show how long it takes.

**Settings.**

> **[ Video 3: settings ]**
> Open Settings, edit the worker prompt, change how many diagrams you want, add a file to ignore, then Regenerate.

## How it works

```mermaid
flowchart LR
  A["Read the PR<br/>diff and details"] --> B["Drop the noise<br/>lockfiles, snapshots, generated"]
  B --> C["Cut big hunks"]
  C --> D["Fetch the code<br/>head and base commits"]
  D --> P["Planner<br/>groups hunks into steps"]
  D --> S["Summary agent"]
  P -->|steps stream out| W["Workers<br/>one per step, in parallel"]
  W --> K["Checks in code"]
  S --> K
  K --> R["Story"]
  classDef model fill:#e3e9f4,stroke:#3b5f9c,color:#1e1b16;
  classDef result fill:#e4f0df,stroke:#2c7a4b,color:#1e1b16;
  class C,P,S,W model;
  class R result;
```

Blue boxes are model calls. The rest is plain code. The planner streams its steps, so a worker starts on each step as soon as it arrives. A worker sees only its own step, plus code context that was read by code and not by the model: the old version of changed functions, callers of changed names, and the functions they call. After the models answer, code checks the result. Every hunk must be in exactly one step, gists and diagrams must follow the rules, and anything that breaks them is fixed once or dropped.

## Quick start

You need Docker, a GitHub token and a [LiteLLM](https://github.com/BerriAI/litellm) gateway.

1. Clone the repo and copy the example settings:

   ```sh
   git clone <this repo>
   cd pr-explainer
   cp .env.example .env
   ```

2. Edit `.env`. Set your gateway URL and, if your gateway uses other model names, the model ids. You can also leave the keys empty and enter them on the setup screen.
3. Start it:

   ```sh
   docker compose up -d --build
   ```

4. Open http://127.0.0.1:5180. Enter your GitHub token and LiteLLM key if asked, paste a PR link, and wait a few seconds.

The containers restart by themselves when Docker starts. Turn on "Start Docker Desktop when you sign in" and nothing else is needed.

**GitHub token.** It must read the repos you review and write reviews. A classic token with `repo` works. A fine-grained token needs Pull requests (read and write) and Contents (read).

**LiteLLM gateway.** The service calls `/chat/completions` on your gateway. Only LiteLLM is tested.

<details>
<summary>Run without Docker</summary>

```sh
cd service && npm start     # port 5190
cd app && npm install && npm run dev   # port 5180
```

Needs Node 22 and git. Stop the containers first, they use the same ports.

</details>

## Features

- A PR split into review steps, each with a short gist
- Flow diagrams for steps that branch
- One-line notes on test hunks. Tests and docs sit in a closing section
- Comments on lines and ranges, thread replies and reactions
- Drafts you keep until you post everything as one review
- Chat grounded in the repo, which can also read the PR description and your drafts when you ask
- Stories marked Outdated when prompts change, and Regenerate on request
- Retry for one failed step
- Editable prompts and file rules

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
| `PRX_WATCH` | `1` queues PRs where your review is requested. Off by default |
| `PRX_ORG`, `PRX_TEAMS` | Limit the watcher to one org and its teams |
| `PRX_EXTRA_TEAMMATES`, `PRX_EXCLUDED_TEAMMATES` | Add or remove logins in the teammate list. When set, the watcher only queues their PRs |
| `PRX_IGNORED_REPOS` | Repos the watcher never queues |

### Settings page

Click Settings on the home page. You can read and change:

- **How it works.** The flow above, with the checks that always run.
- **Prompts.** Everything each agent is sent, in order. Edit the planner, summary and worker text, and choose how many diagrams you want.
- **Files.** What is left out of stories, such as lockfiles and snapshots, and how files are labelled as test, config or docs. Add your own patterns and try a path before you save.
- **Connections.** Your GitHub and LiteLLM details.

Your changes are saved to `~/.config/pr-explainer/overrides.json`, outside the project. Anything you do not change follows the defaults. Saving marks existing stories as Outdated, and you regenerate them one at a time. To go back to the defaults, delete the file. In Docker: `docker compose exec service rm /home/node/.config/pr-explainer/overrides.json`.

## Privacy and limits

- The diff and some repo context (changed functions, their callers, the old code) go to your LiteLLM gateway. Your GitHub token goes only to GitHub.
- Tokens are stored on your machine only. The service never returns them.
- The ports listen on `127.0.0.1` only. There is no login, so this is a single-user tool.

## License

MIT. See [LICENSE](LICENSE).
