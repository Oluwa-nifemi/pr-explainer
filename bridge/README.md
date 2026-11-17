# Claude Code bridge

Lets PR Explainer write stories with the Claude Code login that is already on this machine.
It runs on your machine, not in the container, because the login belongs to the Claude Code
command and cannot be copied into a container.

The bridge turns `POST /v1/chat/completions` into one `claude -p` run, so the service keeps
talking the same wire it talks to LiteLLM.

## Run it

```sh
node bridge/claude-bridge.js
```

Open http://127.0.0.1:5191 to see whether Claude Code is installed and signed in.

Then in the app: Settings → Connections → pick Claude Code. Inside Docker the bridge URL is
`http://host.docker.internal:5191`, which is the default.

## Keep it running

Write the plist with your own paths, then load it:

```sh
sed -e "s#__NODE__#$(which node)#" -e "s#__REPO__#$PWD#" -e "s#__HOME__#$HOME#g" \
  bridge/com.nifemi.pr-explainer-claude-bridge.plist \
  > ~/Library/LaunchAgents/com.nifemi.pr-explainer-claude-bridge.plist
launchctl load ~/Library/LaunchAgents/com.nifemi.pr-explainer-claude-bridge.plist
```

It restarts after a crash and starts again at login. Logs go to
`~/Library/Logs/pr-explainer-bridge.log`.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `BRIDGE_PORT` | `5191` | Port to listen on |
| `BRIDGE_HOST` | `127.0.0.1` | Address to bind. Keep it on loopback. |
| `BRIDGE_MAX_CALLS` | `6` | How many `claude` processes may run at once |
| `BRIDGE_TIMEOUT_MS` | `300000` | Kill a call after this long |
| `BRIDGE_MODELS` | `claude-code-opus,claude-code-sonnet` | Model ids the bridge answers for |
| `BRIDGE_CLAUDE_BIN` | `claude` | Path to the Claude Code binary |

## What it does and does not do

- It reads no files from your repository and takes no actions on your behalf. Each call is one
  prompt, one answer.
- Every call runs with `--bare --restricted --tools ""`, so your instructions, hooks, skills and
  MCP servers are not loaded.
- It never copies, prints or stores your Claude Code login. The command owns it.
- It does not support tool calls, so the app's chat tab stays on LiteLLM.
