#!/bin/bash

# @raycast.schemaVersion 1
# @raycast.title Explain PR
# @raycast.mode silent
# @raycast.packageName PR Explainer
# @raycast.icon 📖
# @raycast.argument1 { "type": "text", "placeholder": "GitHub PR URL" }
# @raycast.description Open a GitHub pull request in your local PR Explainer.

set -euo pipefail

pattern='^https://(www\.)?github\.com/([A-Za-z0-9][A-Za-z0-9-]*)/([A-Za-z0-9_.-]+)/pull/([1-9][0-9]*)([/#?].*)?$'
if [[ ! "${1:-}" =~ $pattern ]]; then
  echo "Enter a GitHub PR URL, like https://github.com/owner/repo/pull/123."
  exit 1
fi

key="${BASH_REMATCH[2]}/${BASH_REMATCH[3]}/${BASH_REMATCH[4]}"
open "http://127.0.0.1:5180/?pr=$key"
