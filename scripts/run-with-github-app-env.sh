#!/usr/bin/env bash
# run-with-github-app-env.sh
#
# Loads the same repository-level GitHub Actions vars that the release
# workflow uses, then runs the provided command in that environment.
# The wrapper fails closed if the vars cannot be loaded.
#
# Usage:
#   bash ./scripts/run-with-github-app-env.sh pnpm build
#   bash ./scripts/run-with-github-app-env.sh pnpm zip

set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "Usage: $0 <command> [args...]" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_exports="$(bash "$script_dir/load-github-app-env.sh")"
eval "$env_exports"
"$@"
