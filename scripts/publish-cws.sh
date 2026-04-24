#!/usr/bin/env bash
# publish-cws.sh
#
# Uploads the packaged Chrome extension to the Chrome Web Store and submits it
# with DEFAULT_PUBLISH. The submission still goes through Chrome Web Store
# review; after approval, the item is published according to the store's
# existing visibility settings.

set -euo pipefail

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "$name is required" >&2
    exit 1
  fi
}

json_value() {
  local field_path="$1"
  node -e '
const fs = require("node:fs");
const input = fs.readFileSync(0, "utf8");
const fieldPath = process.argv[1].split(".");
let value = JSON.parse(input);
for (const field of fieldPath) {
  value = value?.[field];
}
if (value !== undefined && value !== null) {
  process.stdout.write(String(value));
}
' "$field_path"
}

find_package() {
  local explicit_path="${1:-}"
  if [ -n "$explicit_path" ]; then
    if [ ! -f "$explicit_path" ]; then
      echo "Chrome extension package not found: $explicit_path" >&2
      exit 1
    fi
    printf '%s' "$explicit_path"
    return
  fi

  local packages=()
  while IFS= read -r package_path; do
    packages+=("$package_path")
  done < <(find .output -maxdepth 1 -type f -name '*-chrome.zip' | sort)

  if [ "${#packages[@]}" -ne 1 ]; then
    echo "Expected exactly one .output/*-chrome.zip package, found ${#packages[@]}" >&2
    exit 1
  fi

  printf '%s' "${packages[0]}"
}

wait_for_upload() {
  local api_name="$1"
  local upload_state="$2"
  local attempts="${CWS_UPLOAD_POLL_ATTEMPTS:-12}"
  local poll_seconds="${CWS_UPLOAD_POLL_SECONDS:-5}"

  case "$upload_state" in
    SUCCEEDED)
      return
      ;;
    IN_PROGRESS | UPLOAD_IN_PROGRESS)
      ;;
    FAILED)
      echo "Chrome Web Store upload failed." >&2
      exit 1
      ;;
    *)
      echo "Unexpected Chrome Web Store upload state: ${upload_state:-<empty>}" >&2
      exit 1
      ;;
  esac

  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if [ "$poll_seconds" != "0" ]; then
      sleep "$poll_seconds"
    fi

    local status_response
    status_response="$(curl -fsS \
      -H "Authorization: Bearer ${CWS_ACCESS_TOKEN}" \
      "https://chromewebstore.googleapis.com/v2/${api_name}:fetchStatus")"
    upload_state="$(printf '%s' "$status_response" | json_value lastAsyncUploadState)"

    case "$upload_state" in
      SUCCEEDED)
        return
        ;;
      IN_PROGRESS | UPLOAD_IN_PROGRESS | "")
        ;;
      FAILED)
        echo "Chrome Web Store upload failed." >&2
        exit 1
        ;;
      *)
        echo "Unexpected Chrome Web Store upload state: ${upload_state}" >&2
        exit 1
        ;;
    esac
  done

  echo "Chrome Web Store upload did not finish after ${attempts} status checks." >&2
  exit 1
}

require_env CWS_ACCESS_TOKEN
require_env CWS_PUBLISHER_ID
require_env CWS_EXTENSION_ID

package_path="$(find_package "${1:-}")"
api_name="publishers/${CWS_PUBLISHER_ID}/items/${CWS_EXTENSION_ID}"

echo "Uploading ${package_path} to Chrome Web Store item ${CWS_EXTENSION_ID}."
upload_response="$(curl -fsS \
  -X POST \
  -H "Authorization: Bearer ${CWS_ACCESS_TOKEN}" \
  -H "Content-Type: application/zip" \
  --data-binary "@${package_path}" \
  "https://chromewebstore.googleapis.com/upload/v2/${api_name}:upload")"
upload_state="$(printf '%s' "$upload_response" | json_value uploadState)"
crx_version="$(printf '%s' "$upload_response" | json_value crxVersion)"
wait_for_upload "$api_name" "$upload_state"

if [ -n "$crx_version" ]; then
  echo "Chrome Web Store upload accepted version ${crx_version}."
else
  echo "Chrome Web Store upload accepted."
fi

publish_response="$(curl -fsS \
  -X POST \
  -H "Authorization: Bearer ${CWS_ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{"publishType":"DEFAULT_PUBLISH"}' \
  "https://chromewebstore.googleapis.com/v2/${api_name}:publish")"
publish_state="$(printf '%s' "$publish_response" | json_value state)"

echo "Chrome Web Store publish submitted with state: ${publish_state:-unknown}."
