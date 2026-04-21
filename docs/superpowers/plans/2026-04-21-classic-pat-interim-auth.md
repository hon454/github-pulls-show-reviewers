# Classic PAT Interim Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fine-grained PAT guidance with Classic PAT guidance across UI, validation errors, documentation, tests, ADR, and release artifacts — while leaving stored token format, API request shape, and the no-token public-repository policy unchanged.

**Architecture:** Copy-and-docs change with one behavioral side effect — the validation error text produced by `src/github/api.ts` shifts from fine-grained wording (`Pull requests: Read`, "repository is selected in the token") to Classic PAT wording (`'repo'` / `'public_repo'` scopes) plus an SSO authorization reminder when a saved-token request gets 401/403 against a specific repository. The options page keeps the same token storage contract but points users at `https://github.com/settings/tokens/new` instead of the fine-grained creation page. Documentation, ADR, version, and release notes follow the same pivot.

**Tech Stack:** WXT Chrome extension, TypeScript, React 19 options UI, Zod validation, Vitest for unit tests, pnpm.

---

## Scope Check

The spec describes one coordinated UI-plus-copy change. It is not split into independent subsystems because the error-message, options-page, and docs changes all carry the same Classic-PAT + SSO story and ship together as `v1.1.0`. One plan is appropriate.

## File Structure

These are the exact files the plan touches and the single responsibility each one carries.

**Code:**

- `src/github/api.ts` — modify `describeGitHubEndpointError` (currently lines ~495–529) so saved-token 401/403/404 repository errors mention Classic PAT `repo`/`public_repo` scopes and, for 401 and 403, add an SSO authorization reminder. No type or function signature changes.
- `entrypoints/options/options-page.tsx` — modify copy (body paragraph, guidance box, input hint, link button), rename the PAT URL helper from `buildFineGrainedPatUrl` to `buildClassicPatUrl`, drop the repository-owner query-string logic (Classic PATs have no `target_name`), and add an SSO authorization notice.

**Tests:**

- `tests/fixtures/repository-validation-matrix.json` — update the existing "token lacks pull request permission" case to assert Classic PAT + SSO wording, and add two new cases covering 401 on a repository endpoint with a saved token and 403 on `/rate_limit` via `validateGitHubToken` (the token-validate path).
- `tests/api.test.ts` — replace the `expect(message).toContain("Pull requests: Read")` assertion with Classic PAT scope plus SSO assertions; no structural change.
- `tests/options-page.test.ts` — update the PAT-link test (URL, button text, query string) and add a test that asserts the SSO guidance paragraph is rendered.

**Docs and ADR:**

- `docs/adr/0002-classic-pat-interim-auth.md` (create) — record the decision to pivot to Classic PAT as an interim step before GitHub App + device flow.
- `AGENTS.md` — replace the fine-grained guidance bullet under "Product Rules" with Classic PAT guidance.
- `README.md` — rewrite the "Authentication Model" section and the recommended-token bullets.
- `docs/privacy-policy.md` — update the token-scope wording to `public_repo` / `repo`.
- `docs/chrome-web-store.md` — update listing copy and privacy checklist copy.
- `docs/chrome-web-store-submission.md` — update listing copy.
- `docs/implementation-notes.md` — update the options-page description and repository-diagnostics matrix cell that mentions `Pull requests: Read`.
- `docs/manual-chrome-testing.md` — add a Classic PAT + SSO authorize scenario and update the existing private-repository steps.

**Release:**

- `package.json` — bump `version` from `1.0.1` to `1.1.0`.
- `docs/releases/v1.1.0.md` (create) — structured release notes in the format already used by `v1.0.0.md` / `v1.0.1.md`.

---

## Task 1: Update API validation error messages for Classic PAT and SSO

Rewrite `describeGitHubEndpointError` so saved-token repository errors reflect Classic PAT scopes and include an SSO authorization reminder for 401/403. Update fixtures and unit tests first (TDD), then change the implementation.

**Files:**
- Modify: `tests/fixtures/repository-validation-matrix.json`
- Modify: `tests/api.test.ts`
- Modify: `src/github/api.ts`

- [ ] **Step 1: Update the existing fixture case to expect Classic PAT + SSO wording**

In `tests/fixtures/repository-validation-matrix.json`, replace the `messageIncludes` array of the case named `"token lacks pull request permission"` so that the test no longer asserts on `"Pull requests: Read"` and instead asserts on Classic PAT scope and SSO wording.

Replace this block:

```json
    "expected": {
      "ok": false,
      "authMode": "token",
      "outcome": "token-permission",
      "pullNumber": "42",
      "messageIncludes": [
        "pull #42",
        "Pull requests: Read",
        "/repos/hon454/github-pulls-show-reviewers/pulls/42/reviews"
      ],
      "authorizationHeaderPrefix": "Bearer "
    }
```

with:

```json
    "expected": {
      "ok": false,
      "authMode": "token",
      "outcome": "token-permission",
      "pullNumber": "42",
      "messageIncludes": [
        "pull #42",
        "'repo' scope",
        "public_repo",
        "SSO",
        "/repos/hon454/github-pulls-show-reviewers/pulls/42/reviews"
      ],
      "authorizationHeaderPrefix": "Bearer "
    }
```

- [ ] **Step 2: Add a new fixture case for saved-token 401 on the reviews endpoint**

Still in `tests/fixtures/repository-validation-matrix.json`, append a new case to the root array. The current file ends with:

```json
      "authorizationHeaderPrefix": "Bearer "
    }
  }
]
```

Add a comma after the final inner closing `}` (the one that closes the last fixture case), then the new case below, then the closing `]`. The tail of the file must read:

```json
      "authorizationHeaderPrefix": "Bearer "
    }
  },
  {
    "name": "saved token rejected with 401 on reviews endpoint",
    "token": "github_pat_example",
    "repository": "hon454/github-pulls-show-reviewers",
    "responses": [
      {
        "status": 200,
        "body": [
          {
            "number": 42
          }
        ]
      },
      {
        "status": 200,
        "body": {
          "user": {
            "login": "hon454"
          },
          "requested_reviewers": [],
          "requested_teams": []
        }
      },
      {
        "status": 401,
        "body": {
          "message": "Bad credentials"
        }
      }
    ],
    "expected": {
      "ok": false,
      "authMode": "token",
      "outcome": "token-invalid",
      "pullNumber": "42",
      "messageIncludes": [
        "Saved token was rejected",
        "SSO",
        "/repos/hon454/github-pulls-show-reviewers/pulls/42/reviews"
      ],
      "authorizationHeaderPrefix": "Bearer "
    }
  }
]
```

- [ ] **Step 3: Update `tests/api.test.ts` to assert Classic PAT + SSO wording**

Open `tests/api.test.ts`. In the test `"reports the exact reviews endpoint when review history access is denied"` (around lines 146–188), replace the final two assertions.

Change this block:

```ts
      expect(message).toContain(
        "/repos/hon454/github-pulls-show-reviewers/pulls/42/reviews",
      );
      expect(message).toContain("Pull requests: Read");
```

to:

```ts
      expect(message).toContain(
        "/repos/hon454/github-pulls-show-reviewers/pulls/42/reviews",
      );
      expect(message).toContain("'repo' scope");
      expect(message).toContain("public_repo");
      expect(message).toContain("SSO");
```

- [ ] **Step 4: Run the unit tests and confirm they fail**

Run: `pnpm test -- tests/api.test.ts`

Expected: The test `validateGitHubRepositoryAccess > matches the documented matrix for token lacks pull request permission` fails because the error message still contains `Pull requests: Read`. The new `saved token rejected with 401 on reviews endpoint` case also fails because the current 401 message does not mention SSO. The inline `describeGitHubApiError` test fails for the same reason. This confirms the fixtures are wired correctly.

- [ ] **Step 5: Update the saved-token 401/403/404 branches in `describeGitHubEndpointError`**

Open `src/github/api.ts`. Locate `describeGitHubEndpointError` (currently lines ~488–536). Replace the four branches that fire when `auth.githubToken` is truthy so the 401-on-repo-endpoint branch adds an SSO reminder, and the 403 and 404 branches use Classic PAT scope wording (plus SSO for 403).

Replace this block:

```ts
  if (auth.githubToken) {
    if (error.status === 401) {
      return error.endpoint == null || error.endpoint.path === "/rate_limit"
        ? "Saved token is invalid or expired."
        : `Saved token was rejected by ${endpointLabel}.`;
    }

    if (isRateLimitError(error)) {
      return `${endpointLabel} hit GitHub's API rate limit${rateLimitSuffix}.`;
    }

    if (error.status === 403) {
      return `GitHub denied ${endpointLabel}. Check that the token has Pull requests: Read and includes this repository.`;
    }

    if (error.status === 404) {
      return `${endpointLabel} is not accessible with the current token. Confirm the repository is selected in the token and the pull request exists.`;
    }
  } else {
```

with:

```ts
  if (auth.githubToken) {
    if (error.status === 401) {
      if (error.endpoint == null || error.endpoint.path === "/rate_limit") {
        return "Saved token is invalid or expired.";
      }

      return `Saved token was rejected by ${endpointLabel}. If the repository belongs to an SSO-protected organization, authorize the token via 'Configure SSO → Authorize' at https://github.com/settings/tokens.`;
    }

    if (isRateLimitError(error)) {
      return `${endpointLabel} hit GitHub's API rate limit${rateLimitSuffix}.`;
    }

    if (error.status === 403) {
      return `GitHub denied ${endpointLabel}. Classic PATs need the 'repo' scope for private repositories (or 'public_repo' for public-only). If the organization uses SSO, also authorize the token via 'Configure SSO → Authorize' at https://github.com/settings/tokens.`;
    }

    if (error.status === 404) {
      return `${endpointLabel} is not accessible with the current token. Confirm the pull request exists and the Classic PAT has the 'repo' scope (or 'public_repo' for public-only repositories).`;
    }
  } else {
```

- [ ] **Step 6: Run the unit tests and confirm they pass**

Run: `pnpm test -- tests/api.test.ts`

Expected: all cases in `tests/api.test.ts` pass, including the updated `token lacks pull request permission` fixture and the new `saved token rejected with 401 on reviews endpoint` fixture.

- [ ] **Step 7: Commit**

```bash
git add src/github/api.ts tests/api.test.ts tests/fixtures/repository-validation-matrix.json
git commit -m "feat: shift saved-token error guidance to Classic PAT scopes and SSO"
```

---

## Task 2: Update the options page copy and PAT creation link

Switch the options page away from fine-grained PAT guidance. Rename and rewrite the URL helper, update body/guidance copy, add the SSO authorization notice, and update unit tests to match.

**Files:**
- Modify: `tests/options-page.test.ts`
- Modify: `entrypoints/options/options-page.tsx`

- [ ] **Step 1: Update the options-page unit tests to expect Classic PAT copy**

Open `tests/options-page.test.ts`. Replace the existing test `"renders a fine-grained PAT creation link in the token section"` with two tests — one for the link, one for the SSO guidance paragraph. Replace the entire block (lines ~101–111):

```ts
  it("renders a fine-grained PAT creation link in the token section", async () => {
    await renderOptionsPage();

    const link = document.querySelector<HTMLAnchorElement>(
      'a[href*="github.com/settings/personal-access-tokens/new"]',
    );

    expect(link).not.toBeNull();
    expect(link?.textContent).toContain("Create fine-grained PAT");
    expect(link?.href).toContain("pull_requests=read");
  });
```

with:

```ts
  it("renders a classic PAT creation link in the token section", async () => {
    await renderOptionsPage();

    const link = document.querySelector<HTMLAnchorElement>(
      'a[href*="github.com/settings/tokens/new"]',
    );

    expect(link).not.toBeNull();
    expect(link?.textContent).toContain("Create classic PAT");
    expect(link?.href).toContain("scopes=repo");
    expect(link?.href).toContain("description=");
  });

  it("shows SSO authorization guidance in the token section", async () => {
    await renderOptionsPage();

    expect(document.body.textContent).toContain("Configure SSO");
    expect(document.body.textContent).toContain("Authorize");
    expect(document.body.textContent).toContain("public_repo");
  });
```

- [ ] **Step 2: Run the options-page tests and confirm they fail**

Run: `pnpm test -- tests/options-page.test.ts`

Expected: `renders a classic PAT creation link in the token section` fails because the current link still points at `github.com/settings/personal-access-tokens/new`, and `shows SSO authorization guidance in the token section` fails because no SSO copy is rendered yet.

- [ ] **Step 3: Rewrite the PAT URL helper and constants in `options-page.tsx`**

Open `entrypoints/options/options-page.tsx`. Replace the existing `FINE_GRAINED_PAT_URL` constant, `buildFineGrainedPatUrl`, and `extractRepositoryOwner` helper (lines ~28–53) with a Classic PAT helper that has no repository parameter.

Replace this block:

```ts
const FINE_GRAINED_PAT_URL =
  "https://github.com/settings/personal-access-tokens/new";

export function buildFineGrainedPatUrl(repository: string): string {
  const url = new URL(FINE_GRAINED_PAT_URL);

  url.searchParams.set("name", "GitHub Pulls Show Reviewers");
  url.searchParams.set(
    "description",
    "Read reviewer metadata for GitHub pull request lists",
  );
  url.searchParams.set("pull_requests", "read");

  const owner = extractRepositoryOwner(repository);
  if (owner) {
    url.searchParams.set("target_name", owner);
  }

  return url.toString();
}

function extractRepositoryOwner(repository: string): string | null {
  const trimmed = repository.trim().replace(/^\/+|\/+$/g, "");
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(trimmed);
  return match ? match[1] : null;
}
```

with:

```ts
const CLASSIC_PAT_NEW_URL = "https://github.com/settings/tokens/new";
const CLASSIC_PAT_MANAGEMENT_URL = "https://github.com/settings/tokens";

export function buildClassicPatUrl(): string {
  const url = new URL(CLASSIC_PAT_NEW_URL);

  url.searchParams.set("scopes", "repo");
  url.searchParams.set(
    "description",
    "GitHub Pulls Show Reviewers — read reviewer metadata",
  );

  return url.toString();
}
```

- [ ] **Step 4: Rewrite the intro paragraph and guidance box**

Still in `entrypoints/options/options-page.tsx`, locate the body paragraph and guidance box (currently lines ~255–273). Replace this block:

```tsx
        <p style={styles.body}>
          Public repositories can stay on the no-token path. For private
          repositories, save fine-grained personal access tokens scoped only to
          the owners and repositories this extension reads.
        </p>
        <div style={styles.guidanceBox}>
          <p style={styles.guidanceTitle}>
            Recommended fine-grained token setup
          </p>
          <ul style={styles.guidanceList}>
            <li>Repository access: Only select repositories</li>
            <li>Repository permissions: Pull requests - Read-only</li>
            <li>No write permissions are required for this extension</li>
          </ul>
          <p style={styles.guidanceNote}>
            Organization-owned repositories may also require org approval before
            the token can read pull requests.
          </p>
        </div>
```

with:

```tsx
        <p style={styles.body}>
          Public repositories can stay on the no-token path. For private
          repositories, save a GitHub classic personal access token scoped to
          the minimum needed for reading pull request reviewer metadata.
        </p>
        <div style={styles.guidanceBox}>
          <p style={styles.guidanceTitle}>Recommended classic PAT setup</p>
          <ul style={styles.guidanceList}>
            <li>
              Public-only access: the <code>public_repo</code> scope is enough
            </li>
            <li>
              Private repositories: the <code>repo</code> scope (note the
              broader surface area — the extension only performs read operations)
            </li>
            <li>No write permissions are required for this extension</li>
          </ul>
          <p style={styles.guidanceNote}>
            After creating the token, open the{" "}
            <a
              href={CLASSIC_PAT_MANAGEMENT_URL}
              target="_blank"
              rel="noreferrer"
            >
              token settings page
            </a>{" "}
            and click <strong>Configure SSO → Authorize</strong> for each
            organization with private repositories.
          </p>
        </div>
```

- [ ] **Step 5: Update the token input hint and link button**

Still in `entrypoints/options/options-page.tsx`, locate the token input hint and "Create fine-grained PAT" link (currently lines ~389–401). Replace this block:

```tsx
          <p style={styles.hint}>
            Use a fine-grained PAT such as <code>github_pat_...</code>. The
            reviewer UI only reads pull request metadata and review history.
          </p>
          <div style={styles.inlineActions}>
            <a
              href={buildFineGrainedPatUrl(repository)}
              target="_blank"
              rel="noreferrer"
              style={styles.linkButton}
            >
              Create fine-grained PAT
            </a>
```

with:

```tsx
          <p style={styles.hint}>
            Use a GitHub classic PAT (token strings start with{" "}
            <code>ghp_</code>). The reviewer UI only reads pull request metadata
            and review history.
          </p>
          <div style={styles.inlineActions}>
            <a
              href={buildClassicPatUrl()}
              target="_blank"
              rel="noreferrer"
              style={styles.linkButton}
            >
              Create classic PAT
            </a>
```

- [ ] **Step 6: Update the placeholder in the token password input**

Still in `entrypoints/options/options-page.tsx`, find the token value input (currently around line 386) and change its placeholder from the fine-grained prefix to the classic prefix.

Replace:

```tsx
            placeholder="github_pat_..."
```

with:

```tsx
            placeholder="ghp_..."
```

- [ ] **Step 7: Run the options-page tests and confirm they pass**

Run: `pnpm test -- tests/options-page.test.ts`

Expected: all tests pass, including the new classic PAT link test and the new SSO guidance test. The existing tests that render saved token entries (`github_pat_1234567890`) continue to pass because we have not changed the token storage format.

- [ ] **Step 8: Run the full test suite to catch unrelated regressions**

Run: `pnpm test`

Expected: every test passes. If any unrelated test still references the old fine-grained wording, update it to match the new Classic PAT wording inline before moving on.

- [ ] **Step 9: Commit**

```bash
git add entrypoints/options/options-page.tsx tests/options-page.test.ts
git commit -m "feat: switch options page guidance to classic PAT with SSO notice"
```

---

## Task 3: Create ADR 0002 for the Classic PAT interim decision

Write the ADR that records the pivot from fine-grained to Classic PAT guidance and its interim nature.

**Files:**
- Create: `docs/adr/0002-classic-pat-interim-auth.md`

- [ ] **Step 1: Create `docs/adr/0002-classic-pat-interim-auth.md`**

Write the file with the following exact content:

```markdown
# ADR 0002: Classic PAT Interim Auth

- Status: Accepted
- Date: 2026-04-21

## Context

The extension has been guiding users toward GitHub fine-grained personal access tokens for private repository access. Fine-grained PATs require the target organization to opt into fine-grained tokens at the organization policy level. Some organizations — including the motivating case `cinev/shotloom` — have not enabled fine-grained PAT access, which leaves affected users unable to configure the extension for private repositories in those organizations.

At the same time, the product's long-term authentication direction is a GitHub App plus device flow, which restores fine-grained, per-repository read-only scopes with better UX than a PAT. That work is tracked separately and is not ready to ship.

## Decision

Replace fine-grained PAT guidance with Classic PAT guidance as an interim step.

- The options page, validation error copy, README, privacy policy, Chrome Web Store materials, implementation notes, and manual testing guide all move to Classic PAT wording.
- The stored token format (`TokenEntry` with `id`, `scope`, `token`, `label`) and the `Authorization: Bearer <token>` request shape are unchanged.
- The no-token public-repository policy recorded in [ADR 0001](./0001-keep-no-token-support-for-public-repositories.md) is unchanged.

## Rationale

- Classic PATs do not require organization-level opt-in for the token to exist. They only require per-organization SSO authorization, which is a user action on the token settings page.
- This directly unblocks users in organizations that disallow fine-grained PATs.
- The interim cost is that the Classic PAT `repo` scope is broader than the fine-grained `Pull requests: Read` permission. The extension only performs read operations, and the guidance states that explicitly.
- Because tokens are validated through the same `Authorization: Bearer` header, existing saved tokens continue to work without migration. There is no settings-schema change.
- OAuth App support was considered and rejected during brainstorming because it offers no advantage over Classic PAT for this product and adds an OAuth flow the extension does not otherwise need.

## Consequences

### Positive

- Users in organizations that disallow fine-grained PATs can complete private-repository setup by creating a Classic PAT and authorizing SSO.
- Validation error text now surfaces the actual unblock (SSO authorization) for 401/403 failures against repository endpoints with a saved token.
- Existing users who already saved a fine-grained PAT keep working, because GitHub accepts both styles at the `Authorization: Bearer` layer.

### Negative

- Classic PAT scopes are broader than fine-grained `Pull requests: Read`. The product mitigates this through explicit copy that the extension is read-only and by recommending `public_repo` whenever the user's usage is public-only.
- Users who preferred the fine-grained flow temporarily lose it. The long-term GitHub App work is the intended recovery path.

## Follow-up Guidance

- PAT support as a whole will be removed when GitHub App + device flow support ships. That work is tracked as a separate spec and is not part of this decision.
- `cinev/shotloom`-style organizations may still block Classic PAT via SSO policy. Document as a known limitation and revisit when GitHub App work begins. The fallback remains the no-token path for public repositories.
- Revisit this ADR when GitHub App support is ready to ship. At that point, replace this ADR's status with `Superseded`, link to the follow-up ADR, and remove PAT wording from the product.
```

- [ ] **Step 2: Commit**

```bash
git add docs/adr/0002-classic-pat-interim-auth.md
git commit -m "docs: add ADR 0002 for classic PAT interim auth decision"
```

---

## Task 4: Update AGENTS.md product rule

`AGENTS.md` currently tells agents to guide the product toward fine-grained PAT usage. Replace that bullet with Classic PAT guidance so future agents do not revert the change.

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Replace the fine-grained product rule bullet**

Open `AGENTS.md`. Replace line 15:

```markdown
- For private repositories, guide the product toward fine-grained PAT usage with minimum required read permissions.
```

with:

```markdown
- For private repositories, guide the product toward classic PAT usage (`public_repo` for public-only access, `repo` for private access) and remind users to authorize SSO per organization. A GitHub App flow is the intended long-term replacement and is tracked separately.
```

- [ ] **Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "docs: shift AGENTS private-repo rule to classic PAT guidance"
```

---

## Task 5: Update README.md authentication section

Rewrite the `Authentication Model` section and the recommended-token bullets so they describe Classic PAT setup and SSO authorization. Keep the rest of the README unchanged.

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace the `Authentication Model` section**

Open `README.md`. Replace lines 51–67 (the entire `## Authentication Model` section, from its heading through the paragraph ending in `token permission issues.`).

Replace this block:

```markdown
## Authentication Model

The extension prefers the lightest access model that works.

- Public repositories: try GitHub's unauthenticated REST path first
- Private repositories: use fine-grained PATs with minimum read access
- Options page: save multiple PAT scopes using `owner/*` and `owner/repo` matching
- Runtime auth resolution: prefer `owner/repo`, then `owner/*`, then no-token
- Matched-token failures do not fall back automatically to another token or the no-token path
- Legacy single-token settings are ignored instead of being migrated automatically
- Options page: diagnose repository access with the same API paths used by the content script and offer a shortcut button to GitHub's fine-grained PAT creation flow

Recommended token direction for private repositories:

- Repository access limited to the repos you need or to one owner-wide token per account when appropriate
- `Pull requests: Read`

The options page distinguishes between matched-token success, unauthenticated public access, rate limiting, private-like access failures, and token permission issues.
```

with:

```markdown
## Authentication Model

The extension prefers the lightest access model that works.

- Public repositories: try GitHub's unauthenticated REST path first
- Private repositories: use a GitHub classic personal access token (`public_repo` for public-only access, `repo` for private repositories — the extension only performs read operations)
- Options page: save multiple PAT scopes using `owner/*` and `owner/repo` matching
- Runtime auth resolution: prefer `owner/repo`, then `owner/*`, then no-token
- Matched-token failures do not fall back automatically to another token or the no-token path
- Legacy single-token settings are ignored instead of being migrated automatically
- Options page: diagnose repository access with the same API paths used by the content script and offer a shortcut button to GitHub's classic PAT creation flow

Recommended token direction for private repositories:

- Create a classic PAT at `https://github.com/settings/tokens/new`
- Use `public_repo` for public-only access or `repo` for private repositories
- For organizations that enforce SSO, open the token settings page and click `Configure SSO → Authorize` for each organization you need to read

The options page distinguishes between matched-token success, unauthenticated public access, rate limiting, private-like access failures, and token permission issues. Classic PAT support is an interim step before a GitHub App flow lands; see [ADR 0002](./docs/adr/0002-classic-pat-interim-auth.md).
```

- [ ] **Step 2: Append ADR 0002 to the `Related Docs` list**

Still in `README.md`, locate the `## Related Docs` list (currently ending at line 154). Replace the final bullet:

```markdown
- [ADR: Keep no-token support for public repositories](./docs/adr/0001-keep-no-token-support-for-public-repositories.md)
```

with:

```markdown
- [ADR: Keep no-token support for public repositories](./docs/adr/0001-keep-no-token-support-for-public-repositories.md)
- [ADR: Classic PAT interim auth](./docs/adr/0002-classic-pat-interim-auth.md)
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: describe classic PAT auth model in README"
```

---

## Task 6: Update the privacy policy

Update scope wording so the published privacy document reflects Classic PAT scopes.

**Files:**
- Modify: `docs/privacy-policy.md`

- [ ] **Step 1: Update the token description**

Open `docs/privacy-policy.md`. Replace this line (line 15):

```markdown
- An optional GitHub personal access token if the user enters one in the extension options page for private repository access.
```

with:

```markdown
- An optional GitHub classic personal access token (recommended scopes: `public_repo` for public-only access, or `repo` for private repositories) if the user enters one in the extension options page.
```

- [ ] **Step 2: Commit**

```bash
git add docs/privacy-policy.md
git commit -m "docs: reflect classic PAT scopes in privacy policy"
```

---

## Task 7: Update Chrome Web Store listing copy and submission packet

The Chrome Web Store notes and submission packet both contain "fine-grained" copy that will be visible to reviewers. Update both.

**Files:**
- Modify: `docs/chrome-web-store.md`
- Modify: `docs/chrome-web-store-submission.md`

- [ ] **Step 1: Update the detailed description in `docs/chrome-web-store.md`**

Open `docs/chrome-web-store.md`. Replace line 20:

```markdown
`The extension is designed for a narrow workflow: reviewer visibility first. It caches reviewer lookups per page, keeps GitHub selectors isolated for DOM resilience, and supports fine-grained personal access tokens with repository-scoped pull-request read access when private repositories need authentication.`
```

with:

```markdown
`The extension is designed for a narrow workflow: reviewer visibility first. It caches reviewer lookups per page, keeps GitHub selectors isolated for DOM resilience, and supports GitHub classic personal access tokens (public_repo or repo scope) when private repositories need authentication. The extension only performs read operations.`
```

- [ ] **Step 2: Update the privacy checklist line in `docs/chrome-web-store.md`**

Still in `docs/chrome-web-store.md`, replace lines 65–66:

```markdown
7. Confirm the privacy disclosure matches the shipped behavior:
   no sale of data, no advertising, no remote code, GitHub page access only, and optional fine-grained PAT storage in `browser.storage.local` for private repositories.
```

with:

```markdown
7. Confirm the privacy disclosure matches the shipped behavior:
   no sale of data, no advertising, no remote code, GitHub page access only, and optional classic PAT storage in `browser.storage.local` for private repositories.
```

- [ ] **Step 3: Update the detailed description in `docs/chrome-web-store-submission.md`**

Open `docs/chrome-web-store-submission.md`. Replace line 17:

```markdown
`The extension is designed for a narrow workflow: reviewer visibility first. It caches reviewer lookups per page, keeps GitHub selectors isolated for DOM resilience, and supports fine-grained personal access tokens with repository-scoped pull-request read access when private repositories need authentication.`
```

with:

```markdown
`The extension is designed for a narrow workflow: reviewer visibility first. It caches reviewer lookups per page, keeps GitHub selectors isolated for DOM resilience, and supports GitHub classic personal access tokens (public_repo or repo scope) when private repositories need authentication. The extension only performs read operations.`
```

- [ ] **Step 4: Update the current package target path**

Still in `docs/chrome-web-store-submission.md`, replace line 99:

```text
.output/github-pulls-show-reviewers-1.0.1-chrome.zip
```

with:

```text
.output/github-pulls-show-reviewers-1.1.0-chrome.zip
```

- [ ] **Step 5: Commit**

```bash
git add docs/chrome-web-store.md docs/chrome-web-store-submission.md
git commit -m "docs: rewrite chrome web store copy for classic PAT guidance"
```

---

## Task 8: Update implementation notes

Replace fine-grained references in implementation notes with Classic PAT wording, including the diagnostics matrix row.

**Files:**
- Modify: `docs/implementation-notes.md`

- [ ] **Step 1: Update the options-page description bullet**

Open `docs/implementation-notes.md`. Replace line 14:

```markdown
- The options page leaves the repository diagnostics input empty by default, resolves the best matching stored token for `owner/repo`, and provides a shortcut link to GitHub's fine-grained PAT creation page.
```

with:

```markdown
- The options page leaves the repository diagnostics input empty by default, resolves the best matching stored token for `owner/repo`, and provides a shortcut link to GitHub's classic PAT creation page along with an SSO authorization reminder.
```

- [ ] **Step 2: Update the diagnostics matrix token-denied row**

Still in `docs/implementation-notes.md`, replace line 54:

```markdown
| Token    | `403` without rate-limit signal                | Token is missing `Pull requests: Read` or repository access                    |
```

with:

```markdown
| Token    | `403` without rate-limit signal                | Classic PAT is missing the `repo` scope or the organization requires SSO authorization |
```

- [ ] **Step 3: Commit**

```bash
git add docs/implementation-notes.md
git commit -m "docs: update implementation notes for classic PAT diagnostics"
```

---

## Task 9: Update manual Chrome testing guide

Update the private-repository path and add a Classic PAT + SSO authorize scenario plus a "saved fine-grained token still works" check.

**Files:**
- Modify: `docs/manual-chrome-testing.md`

- [ ] **Step 1: Update the "good manual checks" bullet for private repositories**

Open `docs/manual-chrome-testing.md`. Replace line 61:

```markdown
- A private repository you can access, to validate the fine-grained PAT flow from the options page.
```

with:

```markdown
- A private repository you can access, to validate the classic PAT flow (including SSO authorization) from the options page.
```

- [ ] **Step 2: Rewrite the Private repository path steps**

Still in `docs/manual-chrome-testing.md`, locate the "Private repository path" section (lines 80–86). Replace this block:

```markdown
### Private repository path

1. Open the extension's options page from the extension card in `chrome://extensions`, or from the Chrome extensions menu.
2. Add a fine-grained PAT scoped to the owner or repository you want to test.
3. Keep permissions minimal:
   `Pull requests: Read`.
4. Save the token and use the repository diagnostics UI if needed.
5. Re-open the private repository PR list and confirm reviewer chips now render through the authenticated path.
```

with:

```markdown
### Private repository path

1. Open the extension's options page from the extension card in `chrome://extensions`, or from the Chrome extensions menu.
2. Use the "Create classic PAT" link on the options page to open GitHub's classic token creation flow with the `repo` scope pre-selected.
3. Keep scope selection minimal:
   - `public_repo` for public-only usage.
   - `repo` for private repository usage (the extension only performs read operations).
4. For each organization that enforces SSO (for example an organization that disallows fine-grained PATs), open the token settings page, find the new token, and click `Configure SSO → Authorize` for that organization.
5. Save the token in the options page and use the repository diagnostics UI to confirm access.
6. Re-open the private repository PR list and confirm reviewer chips now render through the authenticated path.
```

- [ ] **Step 3: Update the recommended manual regression checklist**

Still in `docs/manual-chrome-testing.md`, replace the existing bullet about broader permissions (line 123):

```markdown
- Private-repository access does not require broader token permissions than `Pull requests: Read`.
```

with:

```markdown
- Private-repository access works with a classic PAT that holds the `repo` scope (and `public_repo` alone suffices for public-only usage).
- A saved fine-grained PAT from a prior release still works without reconfiguration, because GitHub treats both styles as `Authorization: Bearer` tokens.
- Reviewer metadata loads in an organization that disallows fine-grained PATs (for example a `cinev`-style org) after the user authorizes the classic PAT via `Configure SSO → Authorize`.
```

- [ ] **Step 4: Update the private-repositories troubleshooting bullet**

Still in `docs/manual-chrome-testing.md`, replace line 139:

```markdown
- Re-check that the token has repository access and `Pull requests: Read`.
```

with:

```markdown
- Re-check that the classic PAT has the `repo` scope (or `public_repo` for public-only access) and that SSO is authorized for every organization whose repositories you want to read.
```

- [ ] **Step 5: Commit**

```bash
git add docs/manual-chrome-testing.md
git commit -m "docs: add classic PAT and SSO scenarios to manual testing guide"
```

---

## Task 10: Bump the package version to 1.1.0

Match the release notes and store submission by bumping the package version.

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update the `version` field**

Open `package.json`. Replace line 3:

```json
  "version": "1.0.1",
```

with:

```json
  "version": "1.1.0",
```

- [ ] **Step 2: Confirm no lockfile churn is required**

Run: `pnpm install --frozen-lockfile`

Expected: command succeeds without modifying `pnpm-lock.yaml`. The version bump is a metadata change and does not add or remove dependencies.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: bump version to 1.1.0"
```

---

## Task 11: Write the v1.1.0 release notes

Create `docs/releases/v1.1.0.md` in the structure the release workflow expects (matches `v1.0.0.md` and `v1.0.1.md`).

**Files:**
- Create: `docs/releases/v1.1.0.md`

- [ ] **Step 1: Create `docs/releases/v1.1.0.md`**

Write the file with this exact content:

```markdown
## v1.1.0

Interim authentication update for **GitHub Pulls Show Reviewers**. Replaces the fine-grained personal access token guidance with GitHub classic personal access token guidance so users in organizations that disallow fine-grained PATs can unblock private repository reviewer visibility.

### Highlights

- Options page now guides users toward a classic PAT with the `public_repo` or `repo` scope, and adds an SSO authorization reminder.
- Repository diagnostics error copy now mentions classic PAT scopes (`repo`, `public_repo`) and, for 401/403 against a repository endpoint, reminds users to run `Configure SSO → Authorize` for the organization.
- Reviewer rendering scope stays unchanged: requested reviewers, requested teams, and each reviewer's latest completed review state remain the only PR-list metadata shown.

### Authentication

- Public repositories still work on the no-token path when GitHub's unauthenticated REST access is available. See [ADR 0001](../adr/0001-keep-no-token-support-for-public-repositories.md).
- Private repositories now use classic PATs. See [ADR 0002](../adr/0002-classic-pat-interim-auth.md) for the interim rationale.
- Stored token format and `Authorization: Bearer` request shape are unchanged, so fine-grained PATs that users already saved continue to work without reconfiguration.

### Quality & Packaging

- Updated unit tests and repository-validation fixtures to assert classic PAT and SSO wording, including new coverage for 401 against a repository endpoint with a saved token.
- Updated Chrome Web Store listing copy, privacy policy scope wording, implementation notes, and manual Chrome testing guide to match the shipped Classic PAT guidance.

### Scope Notes

This extension still intentionally stays narrow in scope.

- In scope: requested reviewers, requested teams, and completed review state
- Out of scope: checks, mergeability, labels, assignees, and dashboard-style PR metadata
- Out of scope for this release: GitHub App + device flow. Tracked as a separate spec and will remove PAT support when it ships.

**Full Changelog**: https://github.com/hon454/github-pulls-show-reviewers/compare/v1.0.1...v1.1.0
```

- [ ] **Step 2: Commit**

```bash
git add docs/releases/v1.1.0.md
git commit -m "docs: add v1.1.0 release notes"
```

---

## Task 12: Full verification

Run the release verification script to confirm lint, typecheck, unit, and Playwright suites are all green with the Classic PAT changes in place.

**Files:** none.

- [ ] **Step 1: Run `pnpm lint`**

Run: `pnpm lint`

Expected: exit code 0. If any rule flags unused imports or helpers (for example the removed `extractRepositoryOwner`), update the offending file inline and re-run.

- [ ] **Step 2: Run `pnpm typecheck`**

Run: `pnpm typecheck`

Expected: exit code 0. If any TypeScript error references `buildFineGrainedPatUrl`, that means a caller outside the plan was missed; grep the repo with `grep -R "buildFineGrainedPatUrl" .` and update the caller to `buildClassicPatUrl()` before re-running.

- [ ] **Step 3: Run `pnpm test`**

Run: `pnpm test`

Expected: every unit test passes, including the updated `tests/options-page.test.ts` and `tests/api.test.ts` plus the expanded `tests/fixtures/repository-validation-matrix.json`.

- [ ] **Step 4: Run `pnpm test:e2e`**

Run: `pnpm test:e2e`

Expected: Playwright suite passes against the freshly built MV3 bundle. If Playwright Chromium is not installed locally, run `pnpm exec playwright install chromium` once first.

- [ ] **Step 5: Confirm no residual fine-grained references remain in shipped surfaces**

Run: `grep -R "fine-grained\|Pull requests: Read\|personal-access-tokens" README.md AGENTS.md docs entrypoints src tests`

Expected output should only include:
- Historical references inside `docs/releases/v1.0.0.md` and `docs/releases/v1.0.1.md` (release notes are frozen snapshots).
- The ADR 0002 file, which intentionally mentions fine-grained PATs in its rationale.
- `docs/manual-chrome-testing.md` bullet noting that saved fine-grained tokens still work (intentional).

Any other hit is a miss. Update inline and re-run until the grep output matches the allowed list.

- [ ] **Step 6: Final commit gate**

If Steps 1–5 required any inline fixes, stage and commit them with an explanatory message, for example:

```bash
git add <paths>
git commit -m "chore: clean up residual fine-grained references"
```

If no fixes were required, skip this step. The plan is complete.

---

## Self-Review

- **Spec coverage:** Every spec section has at least one task. Data-model unchanged (no code task needed, noted in File Structure). UI copy = Task 2. Validation error text = Task 1. Documentation edits (README, privacy, chrome-web-store, chrome-web-store-submission, implementation-notes, manual-chrome-testing) = Tasks 5–9. ADR = Task 3. Testing updates = Tasks 1 and 2. Version + release notes = Tasks 10 and 11. AGENTS.md product-rule bullet picked up as Task 4 because the existing wording explicitly steers agents back to fine-grained.
- **Placeholder scan:** No TBD / "add appropriate error handling" / "handle edge cases" / "similar to Task N" style steps. Every code-touching step carries the full replacement text.
- **Type consistency:** `buildClassicPatUrl()` is introduced in Task 2 Step 3 and called in Task 2 Step 5 with the exact same signature. `describeGitHubEndpointError` branches in Task 1 Step 5 use only existing symbols (`error.status`, `error.endpoint`, `endpointLabel`, `isRateLimitError`, `rateLimitSuffix`). `CLASSIC_PAT_MANAGEMENT_URL` is declared in Task 2 Step 3 and referenced in Task 2 Step 4. Fixture `messageIncludes` entries line up exactly with substrings produced by the new messages in `src/github/api.ts`. `tests/options-page.test.ts` selectors (`a[href*="github.com/settings/tokens/new"]`, `scopes=repo`, `description=`, `Create classic PAT`, `Configure SSO`, `Authorize`, `public_repo`) all match the strings placed into `entrypoints/options/options-page.tsx`.
