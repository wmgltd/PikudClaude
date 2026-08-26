#!/usr/bin/env bash
# Local (unpublished) build.
#
# Why this isn't just `electron-builder --dir`: electron-builder auto-discovers
# a signing identity from the keychain and picks the first usable one. When this
# project's own Developer ID went missing, that silently produced a build signed
# by an unrelated Apple Development certificate belonging to a DIFFERENT team —
# valid-looking locally, useless (and confusing) anywhere else.
#
# So: sign with the identity this project declares, or don't sign at all. Never
# borrow somebody else's.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -f .env.local ]]; then
  set -a
  # shellcheck source=/dev/null
  source .env.local
  set +a
fi

if [[ -n "${CSC_NAME:-}" ]] && security find-identity -v -p codesigning 2>/dev/null | grep -qF "$CSC_NAME"; then
  echo "→ Signing with: $CSC_NAME"
else
  if [[ -n "${CSC_NAME:-}" ]]; then
    echo "⚠️  '$CSC_NAME' is not in the keychain."
  else
    echo "⚠️  No CSC_NAME set (.env.local)."
  fi
  echo "    Building AD-HOC signed — runs on this Mac only, not distributable."
  echo "    Auto-discovery is disabled on purpose so the build cannot pick up"
  echo "    another team's certificate. Fix by installing the project's"
  echo "    Developer ID Application certificate, then re-run."
  export CSC_IDENTITY_AUTO_DISCOVERY=false
fi

npm run build
npx electron-builder --dir
