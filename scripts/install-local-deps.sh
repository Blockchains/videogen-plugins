#!/usr/bin/env bash
# Local-only system deps for Cursor/Grok VideoGen (no cloud packages).
set -euo pipefail

if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg espeak-ng fonts-dejavu-core
elif command -v dnf >/dev/null 2>&1; then
  sudo dnf install -y ffmpeg espeak-ng dejavu-sans-fonts
elif command -v pacman >/dev/null 2>&1; then
  sudo pacman -S --noconfirm ffmpeg espeak-ng ttf-dejavu
elif command -v apk >/dev/null 2>&1; then
  sudo apk add ffmpeg espeak-ng ttf-dejavu
elif command -v brew >/dev/null 2>&1; then
  brew install ffmpeg espeak-ng
else
  echo "No supported package manager found. Install ffmpeg and espeak-ng manually, then run: node local/cli.mjs doctor" >&2
fi

command -v ffmpeg >/dev/null
command -v espeak-ng >/dev/null
echo "OK: ffmpeg + espeak-ng ready"

if command -v node >/dev/null 2>&1; then
  node "$(dirname "$0")/../local/cli.mjs" doctor || true
fi
