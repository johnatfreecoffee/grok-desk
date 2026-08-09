#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.grok/bin:/usr/bin:/bin:$PATH"
export REPO="johnatfreecoffee/grok-desk"
export OUT_BODY="/tmp/gd-daily-body.txt"
export OUT_SUBJECT="/tmp/gd-daily-subject.txt"
cd "/Users/johnromano/Documents/grok-desk"
"/usr/local/bin/node" scripts/daily-repo-digest.mjs
export NOTIFY_FROM="${NOTIFY_FROM:-Grok Desk <e.grokdesk@freecoffee.dev>}"
export NOTIFY_TO="${NOTIFY_TO:-johnfrankromanojr@gmail.com}"
export REPLY_TO="e.grokdesk@freecoffee.dev"
SUBJECT=$(cat /tmp/gd-daily-subject.txt)
SUBJECT="$SUBJECT" BODY_FILE=/tmp/gd-daily-body.txt "/usr/local/bin/node" scripts/mail-notify.mjs
