#!/bin/sh
# install.sh — installer for jev-test-auditor (jta)
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/typesafe-ai/jev-test-auditor/main/install.sh | sh

set -e

# ANSI colors if connected to a terminal
if [ -t 1 ]; then
  BOLD="\033[1m"
  GREEN="\033[32m"
  YELLOW="\033[33m"
  RED="\033[31m"
  RESET="\033[0m"
else
  BOLD=""
  GREEN=""
  YELLOW=""
  RED=""
  RESET=""
fi

echo "${BOLD}jev-test-auditor (jta) installer${RESET}"
echo "---------------------------------"

# 1. Verify Node.js presence
if ! command -v node >/dev/null 2>&1; then
  echo "${RED}Error: Node.js is required but was not found in PATH.${RESET}" >&2
  echo "Please install Node.js >= 22.13.0 and rerun this installer." >&2
  echo "Download: https://nodejs.org or use nvm / fnm / brew." >&2
  exit 1
fi

# 2. Verify Node.js version >= 22.13.0
NODE_VER=$(node -v 2>/dev/null | tr -d 'v')
NODE_OK=$(node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major > 22 || (major === 22 && minor >= 13)) {
    process.stdout.write("ok");
  } else {
    process.stdout.write("fail");
  }
' 2>/dev/null || echo "fail")

if [ "$NODE_OK" != "ok" ]; then
  echo "${RED}Error: Node.js >= 22.13.0 is required (found v${NODE_VER}).${RESET}" >&2
  echo "jta uses built-in SQLite persistence available unflagged in Node >= 22.13.0." >&2
  echo "Please upgrade Node.js and rerun this installer." >&2
  exit 1
fi

# 3. Verify npm presence
if ! command -v npm >/dev/null 2>&1; then
  echo "${RED}Error: npm is required but was not found in PATH.${RESET}" >&2
  exit 1
fi

# 4. Determine install target
# If run inside the cloned repository, install from local directory
SCRIPT_DIR="$(dirname "$0" 2>/dev/null || echo ".")"
if [ -f "$SCRIPT_DIR/package.json" ] && grep -q '"name": "jev-test-auditor"' "$SCRIPT_DIR/package.json" 2>/dev/null; then
  echo "Installing from local repository at ${SCRIPT_DIR}..."
  (cd "$SCRIPT_DIR" && npm run build --silent && npm install -g .)
else
  echo "Installing latest jev-test-auditor from npm..."
  if ! npm install -g jev-test-auditor; then
    echo "" >&2
    echo "${YELLOW}Notice: Global installation failed, likely due to file permissions.${RESET}" >&2
    echo "You can retry with sudo or configure a custom npm global prefix:" >&2
    echo "  mkdir -p \"\$HOME/.npm-global\"" >&2
    echo "  npm config set prefix \"\$HOME/.npm-global\"" >&2
    echo "  export PATH=\"\$HOME/.npm-global/bin:\$PATH\"" >&2
    echo "  npm install -g jev-test-auditor" >&2
    exit 1
  fi
fi

# 5. Verify installation
echo ""
if command -v jta >/dev/null 2>&1; then
  echo "${GREEN}${BOLD}✓ jev-test-auditor (jta) installed successfully!${RESET}"
  echo ""
  echo "${BOLD}Quick start:${RESET}"
  echo "  ${BOLD}jta audit${RESET}              Inspect tests offline without executing project code"
  echo "  ${BOLD}jta audit --dry-run${RESET}    Preview billable calls and token costs"
  echo "  ${BOLD}jta auth login${RESET}         Configure TypeSafe API key"
  echo "  ${BOLD}jta audit --evaluate${RESET}   Run semantic evaluation with Jev"
  echo "  ${BOLD}jta --help${RESET}             Show all commands and options"
  echo ""
  echo "Note: The alias '${BOLD}jev-test-auditor${RESET}' is also available."
else
  echo "${YELLOW}Installation succeeded, but 'jta' is not in your current PATH.${RESET}"
  NPM_BIN_PATH="$(npm bin -g 2>/dev/null || echo "")"
  if [ -n "$NPM_BIN_PATH" ]; then
    echo "Add the npm global bin directory to your PATH:"
    echo "  export PATH=\"$NPM_BIN_PATH:\$PATH\""
  else
    NPM_PREFIX="$(npm config get prefix 2>/dev/null || echo "")"
    echo "Add the npm bin directory to your PATH:"
    echo "  export PATH=\"$NPM_PREFIX/bin:\$PATH\""
  fi
fi
