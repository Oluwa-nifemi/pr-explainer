# PR Explainer

Turns a pull request into a short walkthrough you read before you read the code.

## Run it

You need Docker.

```
docker compose up -d --build
```

Open http://127.0.0.1:5180 and enter your GitHub token and LiteLLM API key on the setup screen.
They are saved in a Docker volume, so you enter them once.

To skip the setup screen, export `PR_EXPLAINER_GITHUB_TOKEN` and `PR_EXPLAINER_LITELLM_API_KEY` before you run the command.

Both containers restart by themselves when Docker starts. Turn on "Start Docker Desktop when you sign in" and nothing else is needed.

Ports 5180 (UI) and 5190 (service) must be free. Stop any dev servers first.

## Develop

```
cd service && npm start
cd app && npm run dev
```
