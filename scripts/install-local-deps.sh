#!/usr/bin/env bash
# Local-only system deps for Cursor/Grok VideoGen (no cloud packages).
set -euo pipefail
if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg espeak-ng fonts-dejavu-core
fi
command -v ffmpeg >/dev/null
command -v espeak-ng >/dev/null
echo "OK: ffmpeg + espeak-ng ready"
