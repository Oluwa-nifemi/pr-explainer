# Open a PR from Raycast

`explain-pr.sh` opens a GitHub pull request in your local PR Explainer, so a PR URL from a browser or Slack becomes a story in one keystroke.

## Set it up

1. In Raycast, open Settings → Extensions → Script Commands.
2. Add this `raycast/` folder as a Script Directory.
3. Make the script runnable:

   ```sh
   chmod +x raycast/explain-pr.sh
   ```

## Use it

Search for **Explain PR**, paste a GitHub PR URL into the argument field, and press Enter. It opens that PR in your browser.

PR Explainer must already be running locally. The script opens `http://127.0.0.1:5180/?pr=owner/repo/number` and checks the URL shape first, so a bad paste tells you instead of opening a broken page.
