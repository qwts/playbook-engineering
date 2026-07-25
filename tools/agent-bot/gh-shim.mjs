export function buildGhShim(tokenTool) {
  return `#!/bin/sh
# gh shim — agent bot identity (ENG-0045). Managed by
# install-gh-shim.mjs; do not edit in place.
TOKEN_TOOL="${tokenTool}"
SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REAL=""
OLDIFS=$IFS; IFS=:
for d in $PATH; do
  [ "$d" = "$SELF_DIR" ] && continue
  if [ -x "$d/gh" ]; then REAL="$d/gh"; break; fi
done
IFS=$OLDIFS
[ -z "$REAL" ] && { echo "agent-bot gh shim: real gh not found on PATH" >&2; exit 127; }
# gh whoami: who will gh act as HERE, stated plainly. An explicit GH_TOKEN
# outranks worktree territory, matching gh itself; otherwise bot territory is
# local/no-network and human territory asks GitHub through stock gh.
if [ "$1" = "whoami" ]; then
  if [ -n "$GH_TOKEN" ]; then
    LOGIN=$("$REAL" api graphql -f "query={viewer{login}}" --jq .data.viewer.login 2>/dev/null) || {
      echo "agent-bot: could not resolve explicit GH_TOKEN identity" >&2
      exit 1
    }
    [ -n "$LOGIN" ] || {
      echo "agent-bot: explicit GH_TOKEN returned no identity" >&2
      exit 1
    }
    echo "$LOGIN — explicit GH_TOKEN"
    exit 0
  fi
  if [ -f "$TOKEN_TOOL" ] && command -v node >/dev/null 2>&1; then
    SLUG=$(node "$TOKEN_TOOL" --slug 2>/dev/null)
    if [ -n "$SLUG" ]; then echo "$\{SLUG}[bot] — bot territory (ENG-0045)"; exit 0; fi
  fi
  echo "$("$REAL" api user --jq .login 2>/dev/null || echo 'unknown') — human territory, gh is stock"
  exit 0
fi
if [ -z "$GH_TOKEN" ] && [ -f "$TOKEN_TOOL" ] && command -v node >/dev/null 2>&1; then
  TOKEN=$(node "$TOKEN_TOOL") || {
    echo "agent-bot: token mint failed in a bot worktree — refusing to run gh as the human" >&2
    exit 1
  }
  if [ -n "$TOKEN" ]; then GH_TOKEN="$TOKEN"; export GH_TOKEN; fi
fi
exec "$REAL" "$@"
`;
}
