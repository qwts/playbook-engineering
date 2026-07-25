#!/usr/bin/env bash

set -Eeuo pipefail

echo "==> Codex setup starting"

# Codex should already run from the checked-out repo, but this keeps it safe.
if git rev-parse --show-toplevel >/dev/null 2>&1; then
  cd "$(git rev-parse --show-toplevel)"
fi

echo "==> Working directory: $(pwd)"

if ! command -v git >/dev/null 2>&1; then
  echo "ERROR: git is required but was not found on PATH"
  exit 1
fi

echo "==> Git: $(git --version)"

node_ready=false

if [ -f ".nvmrc" ]; then
  # Load nvm explicitly because setup scripts are non-interactive shells.
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    echo "ERROR: .nvmrc exists but nvm was not found at $NVM_DIR/nvm.sh"
    exit 1
  fi

  . "$NVM_DIR/nvm.sh"
  echo "==> Installing/using Node from .nvmrc: $(cat .nvmrc)"
  nvm install
  nvm use

  # Fresh agent commands run in new shells. Keep the repository-pinned Node
  # available without baking a repository name into the user's home directory.
  nvm alias default "$(nvm current)"
  CODEX_DEV_INIT="$HOME/.codex-agent-dev.sh"
  cat > "$CODEX_DEV_INIT" <<'EOF'
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  nvm use default --silent >/dev/null 2>&1 || true
fi
if [ -d "/opt/homebrew/bin" ]; then
  export PATH="/opt/homebrew/bin:$PATH"
fi
EOF

  for shell_profile in \
    "$HOME/.profile" \
    "$HOME/.bash_profile" \
    "$HOME/.bashrc" \
    "$HOME/.zprofile" \
    "$HOME/.zshrc"; do
    touch "$shell_profile"
    if ! grep -Fqx '. "$HOME/.codex-agent-dev.sh"' "$shell_profile"; then
      printf '\n%s\n' '. "$HOME/.codex-agent-dev.sh"' >> "$shell_profile"
    fi
  done

  . "$CODEX_DEV_INIT"
  node_ready=true
elif [ -f "package.json" ]; then
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo "ERROR: package.json exists but node and npm are not available"
    exit 1
  fi
  node_ready=true
else
  echo "==> No Node project detected; skipping Node setup"
fi

if [ "$node_ready" = true ]; then
  echo "==> Node: $(node --version)"
  echo "==> npm:  $(npm --version)"
fi

# These tools improve the agent experience but are host prerequisites, not
# project dependencies. Report them without mutating the host package manager.
if [ -x "/bin/zsh" ]; then
  echo "==> zsh: $(/bin/zsh --version)"
else
  echo "==> zsh: unavailable; protected zsh command wrappers will be skipped"
fi

if command -v gh >/dev/null 2>&1; then
  echo "==> GitHub CLI: $(gh --version | head -n 1)"
else
  echo "==> GitHub CLI: unavailable; install gh to publish repository changes"
fi

# Deterministic package install based on lockfile.
if [ "$node_ready" = true ] && [ -f "package-lock.json" ]; then
  echo "==> Installing dependencies with npm ci"
  npm ci --no-audit --no-fund
elif [ "$node_ready" = true ] && [ -f "package.json" ]; then
  echo "==> Installing dependencies with npm install"
  npm install
else
  echo "==> No package.json found; skipping dependency install"
fi

# Browser automation support, only when Playwright is present.
if [ "$node_ready" = true ] && grep -qiE '"@playwright/test"|"playwright"' package.json; then
  echo "==> Playwright detected; installing Chromium (with system deps for fresh containers)"
  npx playwright install --with-deps chromium || npx playwright install chromium || true
fi

# Initial build is deliberately FATAL: a broken build should fail setup loudly instead of
# wasting the session.
if [ "$node_ready" = true ] && npm run | grep -qE '^[[:space:]]+build$'; then
  echo "==> build script detected; running initial build"
  npm run build
fi

echo "==> Codex setup complete"
