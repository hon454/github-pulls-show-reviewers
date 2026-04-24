# Release Automation Guideline

This document describes the end-to-end Chrome Web Store (CWS)
publishing automation for this repository: which Google Cloud and
Chrome Web Store artifacts it depends on, how to provision them on
a fresh maintainer setup, and how to diagnose the failures the
maintainer has actually hit during first-time provisioning.

Placeholders like `<PROJECT_ID>`, `<PUBLISHER_ID>`, and
`<EXTENSION_ID>` stand in for real values. Never commit real IDs
or keys into this file or any PR description.

## Scope

- In scope: the automated `release.yml` job that uploads and
  submits a built extension zip to Chrome Web Store after the
  package job succeeds.
- Out of scope: GitHub App configuration
  (`WXT_GITHUB_APP_*`), Chrome Web Store store-listing copy,
  screenshot capture (`pnpm cws:assets`), and the local
  `pnpm verify:release` gate. Those are covered elsewhere in
  [`docs/chrome-web-store.md`](../chrome-web-store.md),
  [`docs/chrome-web-store-submission.md`](../chrome-web-store-submission.md),
  and the `Pre-release Test Workflow` section of
  [`README.md`](../../README.md).

## Architecture

```
Tag push (v*) OR workflow_dispatch (tag input)
        │
        ▼
 .github/workflows/release.yml (package job)
        │
        ├── pnpm verify:release
        ├── pnpm zip                                    → .output/<name>-<version>-chrome.zip
        ├── actions/upload-artifact                     → workflow artifact
        ├── softprops/action-gh-release                 → GitHub Release body from docs/releases/<tag>.md
        ├── google-github-actions/auth (credentials_json)
        │     │
        │     └── IAM Credentials API generateAccessToken
        │         (scope: https://www.googleapis.com/auth/chromewebstore)
        │
        └── scripts/publish-cws.sh                      → CWS API v2 upload + publish (DEFAULT_PUBLISH)
```

The CWS step runs whenever `steps.release_meta.outputs.tag`
starts with `v`, so both tag pushes and `workflow_dispatch` with
an existing tag input will publish to Chrome Web Store.

## Provisioning checklist (first-time maintainer setup)

Work through these in order. Each step has a verification command
or expected output, so partial setups stop at the first failing
step instead of silently skipping publish.

### 1. Confirm the Chrome Web Store item exists

- The extension must already exist in the Chrome Web Store
  Developer Dashboard under the publisher account. Automated
  publish cannot create a new item — it can only update an
  existing one.
- Note the item's `<EXTENSION_ID>` (32-char lowercase string,
  visible in the item's dashboard URL or public store URL
  `https://chromewebstore.google.com/detail/<slug>/<EXTENSION_ID>`).
- Note the `<PUBLISHER_ID>` (UUID under **Account → Publisher
  information** in the dashboard).

### 2. Create the Google Cloud project

- Either reuse an existing project the maintainer already owns,
  or create a dedicated one. A dedicated project is preferred
  because the service account we create has no reason to share a
  project with unrelated resources.
- Record `<PROJECT_ID>` (human-readable slug) and
  `<PROJECT_NUMBER>` (numeric, shown on the Dashboard page).

### 3. Enable the IAM Service Account Credentials API

The `google-github-actions/auth` action uses the
`iamcredentials.googleapis.com` API to mint scoped access tokens.
If the API is disabled, auth fails with
`SERVICE_DISABLED: IAM Service Account Credentials API has not
been used in project <PROJECT_NUMBER> before or it is disabled`.

Enable it once per project:

- Console:
  `https://console.developers.google.com/apis/api/iamcredentials.googleapis.com/overview?project=<PROJECT_NUMBER>`
  → **Enable**.
- gcloud:
  ```bash
  gcloud services enable iamcredentials.googleapis.com \
    --project=<PROJECT_ID>
  ```

### 4. Create the service account

Use a name that names the *repository* and the *role* so it is
unmistakable in audit logs.

- **Service account ID**: `<SA_ID>` (6–30 chars, lowercase,
  `[a-z][a-z0-9-]{4,28}[a-z0-9]`). Recommended pattern:
  `<product-slug>-cws-publisher`.
- **Display name**: short, human readable, e.g.
  `<Product> Chrome Web Store publisher`.
- **Description**: one sentence naming the repository and the
  workflow, e.g. `Publishes <owner>/<repo> to the Chrome Web Store
  from GitHub Actions release.yml`.
- **Project-level IAM roles**: none. This SA does not touch any
  GCP resource.
- **"Grant users access" principals**: none. This SA is used with
  a JSON key, not impersonation.

gcloud:

```bash
gcloud iam service-accounts create <SA_ID> \
  --display-name="<Display name>" \
  --description="<Description>" \
  --project=<PROJECT_ID>
```

Verify:

```bash
gcloud iam service-accounts list --project=<PROJECT_ID>
```

The full SA email is `<SA_ID>@<PROJECT_ID>.iam.gserviceaccount.com`.

### 5. Grant the SA `roles/iam.serviceAccountTokenCreator` on itself

`generateAccessToken` is modeled as "the caller impersonates a
service account." When the caller is the SA itself, it still
needs `iam.serviceAccounts.getAccessToken` on the target — which
is *itself*. Without this binding, auth fails with
`Permission 'iam.serviceAccounts.getAccessToken' denied on
resource (or it may not exist)`.

This binding is on the service account resource, not at the
project level.

gcloud:

```bash
gcloud iam service-accounts add-iam-policy-binding \
  <SA_ID>@<PROJECT_ID>.iam.gserviceaccount.com \
  --member="serviceAccount:<SA_ID>@<PROJECT_ID>.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator" \
  --project=<PROJECT_ID>
```

Verify:

```bash
gcloud iam service-accounts get-iam-policy \
  <SA_ID>@<PROJECT_ID>.iam.gserviceaccount.com \
  --project=<PROJECT_ID>
```

`bindings[].members` should include the SA's own email.

### 6. Create and download a JSON key

- Console: **IAM & Admin → Service Accounts → <SA_ID> → Keys →
  Add Key → Create new key → JSON**.
- gcloud:
  ```bash
  gcloud iam service-accounts keys create <local-path>.json \
    --iam-account=<SA_ID>@<PROJECT_ID>.iam.gserviceaccount.com \
    --project=<PROJECT_ID>
  ```

The downloaded JSON contains the private key. Treat it like any
other production secret:

- Never commit it.
- Never paste it into chat, PR bodies, issue comments, or
  transcripts.
- Delete the local file after the GitHub secret is registered
  (step 8).

### 7. Grant the SA CWS API access

Chrome Web Store API authorization is orthogonal to GCP IAM. The
SA must be added to the publisher's API access list in the
Chrome Web Store Developer Dashboard.

- Chrome Web Store Developer Dashboard → **Account → API access**.
- Invite `<SA_ID>@<PROJECT_ID>.iam.gserviceaccount.com` as a
  member.
- Accept the invitation from the SA side (the invite flow varies;
  for a SA, accepting is typically automatic once added, but the
  dashboard will surface any pending action).

Without this step, `scripts/publish-cws.sh` gets a 401 or 403
from the CWS REST API even though GCP auth succeeds.

### 8. Register GitHub Actions secret + variables

The workflow references:

- `${{ secrets.CWS_SERVICE_ACCOUNT_JSON }}` — the JSON key file
  contents from step 6. Must be a **secret**, not a variable,
  because variables are not encrypted and appear unmasked in
  logs, and because the workflow uses the `secrets.` namespace.
- `${{ vars.CWS_PUBLISHER_ID }}` — `<PUBLISHER_ID>` from step 1.
- `${{ vars.CWS_EXTENSION_ID }}` — `<EXTENSION_ID>` from step 1.

```bash
gh secret set CWS_SERVICE_ACCOUNT_JSON \
  --repo <owner>/<repo> \
  < <local-path>.json

gh variable set CWS_PUBLISHER_ID \
  --repo <owner>/<repo> \
  --body "<PUBLISHER_ID>"

gh variable set CWS_EXTENSION_ID \
  --repo <owner>/<repo> \
  --body "<EXTENSION_ID>"
```

Verify:

```bash
gh secret list --repo <owner>/<repo>
gh variable list --repo <owner>/<repo>
```

After the secret is registered, delete the local JSON key file.

### 9. Verify end-to-end

Pick a published tag and dispatch the release workflow against
it:

```bash
gh workflow run release.yml \
  --repo <owner>/<repo> \
  --ref main \
  -f tag=<tag>
```

Watch the run:

```bash
gh run watch <run-id> --repo <owner>/<repo> --exit-status
```

Expected terminal state: package job green, both
`Authenticate to Google for Chrome Web Store` and
`Publish to Chrome Web Store` steps green. The CWS
Developer Dashboard should show the item state as
`PENDING_REVIEW` (or `STAGED` depending on item configuration).

## Triggering a real release

After provisioning is complete, the ordinary release path is:

1. Open a `chore(release): prepare v<X.Y.Z>` PR that bumps
   `package.json`, syncs the expected zip filename in
   `docs/chrome-web-store-submission.md`, and adds
   `docs/releases/v<X.Y.Z>.md`.
2. Merge the PR to `main`.
3. Tag from `main`:
   ```bash
   git fetch origin main
   git tag -a v<X.Y.Z> <merge-commit-sha> -m "v<X.Y.Z>"
   git push origin v<X.Y.Z>
   ```
4. `release.yml` fires on the tag push and runs the full package
   + Release + CWS publish pipeline.

If the tag-push run fails *after* creating the GitHub Release
(typical first-time cause: CWS credentials still being
provisioned), resolve the underlying issue and re-run the same
tag via `workflow_dispatch`:

```bash
gh workflow run release.yml --ref main -f tag=v<X.Y.Z>
```

The package job reuses the existing tag, skips recreating the
GitHub Release (the tag already has one), and re-attempts the
CWS steps. Do not delete and recreate the tag — that invalidates
the existing GitHub Release and its attached zip.

## Troubleshooting

Errors observed during this repository's initial provisioning,
matched to the specific step that was still missing.

| Step of `release.yml` | Error substring | Root cause | Fix |
| --- | --- | --- | --- |
| `Authenticate to Google for Chrome Web Store` | `the GitHub Action workflow must specify exactly one of "workload_identity_provider" or "credentials_json"` | `CWS_SERVICE_ACCOUNT_JSON` secret is missing or empty. | Step 8 — register the secret. |
| `Authenticate to Google for Chrome Web Store` | `IAM Service Account Credentials API has not been used in project <PROJECT_NUMBER> before or it is disabled` | `iamcredentials.googleapis.com` not enabled. | Step 3. Propagation can take a few minutes. |
| `Authenticate to Google for Chrome Web Store` | `Permission 'iam.serviceAccounts.getAccessToken' denied on resource (or it may not exist)` | SA does not have `roles/iam.serviceAccountTokenCreator` on itself. | Step 5. |
| `Publish to Chrome Web Store` | CWS API 401 / 403 | SA not added to CWS publisher API access list. | Step 7. |
| `Publish to Chrome Web Store` | `itemError` or `unexpected state` | CWS-side item state (e.g. item rejected, or visibility conflict). | Inspect the response body in the step log. `scripts/publish-cws.sh` surfaces `publish_error_detail` and the real `ItemState` enum in the failure message. |

For workflow-condition issues (e.g. the CWS step is skipped even
though you dispatched with a tag), the gating condition is
`if: startsWith(steps.release_meta.outputs.tag, 'v')` on both
CWS steps. If the dispatch input is missing or does not start
with `v`, `release_meta` emits an empty `tag` and both steps
skip.

## Key rotation

Rotate the SA key when any of these apply:

- The JSON key has been exposed (chat log, PR body, shared
  transcript, accidentally committed file).
- More than 90 days have passed since the last rotation and the
  maintainer has no compensating alerting.
- A collaborator with key access leaves.

Rotation procedure:

1. Create a new JSON key (step 6).
2. Overwrite the GitHub secret:
   ```bash
   gh secret set CWS_SERVICE_ACCOUNT_JSON \
     --repo <owner>/<repo> \
     < <new-key>.json
   ```
3. Dispatch `release.yml` against an existing tag to verify the
   new key works end-to-end.
4. Only then, delete the old key in the GCP Console or via:
   ```bash
   gcloud iam service-accounts keys delete <old-key-id> \
     --iam-account=<SA_ID>@<PROJECT_ID>.iam.gserviceaccount.com \
     --project=<PROJECT_ID>
   ```

Never delete the old key before confirming the new key publishes
successfully — otherwise a tag-push run can fail mid-flight with
no working credentials.

## Referenced files

- [`.github/workflows/release.yml`](../../.github/workflows/release.yml)
- [`scripts/publish-cws.sh`](../../scripts/publish-cws.sh)
- [`tests/cws-publish.test.ts`](../../tests/cws-publish.test.ts)
- [`docs/chrome-web-store.md`](../chrome-web-store.md)
- [`docs/chrome-web-store-submission.md`](../chrome-web-store-submission.md)
