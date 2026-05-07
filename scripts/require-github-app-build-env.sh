#!/usr/bin/env bash
# require-github-app-build-env.sh
#
# Fails release packaging when GitHub App build variables are missing.

set -euo pipefail

required_vars=(
  WXT_GITHUB_APP_CLIENT_ID
  WXT_GITHUB_APP_SLUG
  WXT_GITHUB_APP_NAME
)
missing_vars=()

for var_name in "${required_vars[@]}"; do
  if [ -z "${!var_name:-}" ]; then
    missing_vars+=("$var_name")
  fi
done

if [ "${#missing_vars[@]}" -gt 0 ]; then
  joined="${missing_vars[0]}"
  for var_name in "${missing_vars[@]:1}"; do
    joined="$joined, $var_name"
  done

  echo "Missing required GitHub App build vars: $joined" >&2
  exit 1
fi
