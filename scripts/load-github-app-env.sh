#!/usr/bin/env bash
# load-github-app-env.sh
#
# Prints `export NAME=VALUE` lines for every repository-level GitHub
# Actions variable. Designed for maintainers who want `pnpm build` and
# `pnpm zip` to run locally with the same environment the release
# workflow uses, without maintaining a personal `.env.local`.
#
# Usage:
#   eval "$(./scripts/load-github-app-env.sh)" && pnpm build
#   eval "$(./scripts/load-github-app-env.sh)" && pnpm zip
#
# Or source it in the current shell:
#   source <(./scripts/load-github-app-env.sh)
#
# Requirements:
#   - GitHub CLI (`gh`) installed and authenticated for this repository.
#   - The variables you want populated must already exist in the
#     repository's GitHub Actions `vars` scope.
#
# Notes:
#   - No values are hardcoded here; everything is fetched at runtime.
#   - `jq` is not required — `gh --jq` handles the filtering.
#   - The script does not touch `.env.local`; it only prints to stdout.

set -euo pipefail

gh variable list --json name,value --jq '.[] | "export \(.name)=\(.value|@sh)"'
