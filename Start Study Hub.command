#!/bin/bash
# Double-click this file to start Study Hub on a Mac.
# (The first time, macOS may ask: right-click it, choose Open, then Open again.)
cd "$(dirname "$0")" || exit 1
# Finder starts this with a short PATH, so also look where installers put Node.js.
export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:$HOME/.volta/bin"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "Study Hub needs Node.js, which is not installed yet."
  echo "Your browser will open the download page. Install the \"LTS\" version,"
  echo "then double-click \"Start Study Hub\" again."
  open "https://nodejs.org/en/download"
  read -n 1 -s -r -p "Press any key to close this window."
  exit 1
fi
if [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  echo "Study Hub needs Node.js 18 or newer. Please install the latest \"LTS\" version from nodejs.org."
  open "https://nodejs.org/en/download"
  read -n 1 -s -r -p "Press any key to close this window."
  exit 1
fi
echo "Starting Study Hub... your browser will open in a moment."
node server.js --open
echo
read -n 1 -s -r -p "Study Hub has stopped. Press any key to close this window."
