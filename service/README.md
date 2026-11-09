# PR Explainer service

Local HTTP service for the PR Explainer UI. ES modules, no dependencies.

## Requirements

- Node 22
- git (the service keeps bare mirrors of the repos it reads, under `~/.cache/pr-explainer/mirrors`)
- A GitHub token that can read the repos and write reviews
- A LiteLLM gateway URL and API key

No `gh` CLI and no local LLM proxy are needed.

## Setup

Either open the UI and fill in the setup screen, or set env vars before you start the service:

| Var | Meaning |
|---|---|
| `PR_EXPLAINER_GITHUB_TOKEN` | GitHub token |
| `PR_EXPLAINER_LITELLM_API_KEY` | LiteLLM API key |
| `PR_EXPLAINER_LITELLM_BASE_URL` | Gateway base URL, no `/v1`. Required |
| `PR_EXPLAINER_FAST_MODEL` | Model id for the fast profile. Default `deepseek-chat` |
| `PR_EXPLAINER_STRONG_MODEL` | Model id for the strong profile. Default `claude-opus-4-5` |
| `PR_EXPLAINER_STRONG_MODEL_BODY` | Optional JSON object merged into every request to the strong model |

Env vars win over the credentials file. The UI saves valid values to `<XDG_CONFIG_HOME or ~/.config>/pr-explainer/credentials.json` (`%APPDATA%` on Windows), mode 600. The service never logs or returns secrets. Until both credentials check out, every `/api` route except `/api/setup` returns 428 `setup_required`.

## Run

~~~sh
cd service
npm start
~~~

Serves on `http://127.0.0.1:5190` and allows CORS from `http://127.0.0.1:5180`.

Preview what the watcher would queue, without queueing or generating:

~~~sh
cd service
npm run watch-preview
~~~

## Environment

| Var | Default | Meaning |
|---|---|---|
| `PRX_PORT` | `5190` | HTTP port |
| `PRX_HOME` | `~/.cache/pr-explainer` | Cache root for stories, threads and `queue.json` |
| `PRX_MAX_STORIES` | `2` | Stories generated at once |
| `PRX_ORG` | none | Limit the watcher search to one GitHub org |
| `PRX_TEAMS` | none | Teams (in `PRX_ORG`) whose members count as teammates |
| `PRX_EXTRA_TEAMMATES` | none | Extra logins treated as teammates. With teams or extra teammates set, the watcher only queues their PRs |
| `PRX_EXCLUDED_TEAMMATES` | none | Logins removed from the teammate list |
| `PRX_IGNORED_REPOS` | none | Repos (`owner/name`) the watcher never queues |
| `PRX_WATCH` | on | `0` disables the review-request watcher |
| `PRX_WATCH_INTERVAL_S` | `180` | Watcher period |
| `PRX_WATCH_ONCE_DRYRUN` | off | `1` runs one watcher pass, prints what it would queue, then stops |
| `PRX_FAKE_GENERATOR` | off | `1` replays a story from `pipeline/out-v2` instead of calling the pipeline |
| `PRX_FAKE_STORY` | | Explicit story JSON for the fake generator |
| `PRX_FAKE_DELAY_MS` | `120` | Delay between fake events |
| `PRX_DRY_RUN` | off | `1` logs GitHub writes and returns fake success |
| `PRX_MAX_CONCURRENCY` | `6` | LLM concurrency for the pipeline |

## Watcher

The watcher polls one search: `is:pr is:open archived:false review-requested:<login> org:<org>`.

It queues a PR only when the author is a teammate and the PR is not handled:

- Teammates are members of `PRX_TEAMS`, plus `PRX_EXTRA_TEAMMATES`, minus `PRX_EXCLUDED_TEAMMATES` and the logged-in user. Logins compare case-insensitively; the team list is cached in memory for 24 h.
- A PR is handled when the user is not a direct requested reviewer, and the latest non-comment review per reviewer has an approval with no `CHANGES_REQUESTED`.
- Direct requests use source `review-requested`. Team requests use source `team-review-requested`.
- Drafts are allowed and go last.

## API

See `docs/service-api.md`. Endpoints:

- `GET /api/prs`, `POST /api/prs`
- `GET /api/prs/:owner/:repo/:number/story`
- `GET /api/prs/:owner/:repo/:number/events` (SSE)
- `GET /api/prs/:owner/:repo/:number/threads`
- `POST /api/prs/:owner/:repo/:number/reviews`
- `POST /api/threads/:threadId/replies`
- `POST /api/threads/:threadId/resolve`
- `POST /api/threads/:threadId/unresolve`
- `GET /api/setup`, `POST /api/setup`, `DELETE /api/setup`
- `GET /api/prs/:owner/:repo/:number/chat`, `POST` (SSE), `DELETE`

Cache layout under `PRX_HOME`:

~~~text
stories/<owner>/<repo>/<number>/<headSha>.json
threads/<owner>/<repo>/<number>.json
chat/<owner>/<repo>/<number>/<headSha>.json
queue.json
~~~

Chat uses up to 2 LLM calls at once, separate from story generation.

## Fake generator

Until `pipeline/src/generate.js` exists, run with `PRX_FAKE_GENERATOR=1`. The fake replays a story JSON through the same event sequence: story, summary, plan, one event per step, overview, done.
