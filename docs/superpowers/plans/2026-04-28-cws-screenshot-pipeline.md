# CWS Screenshot Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Chrome Web Store screenshot pipeline that captures a real GitHub PR-list shell with deterministic reviewer states, including a before/after comparison and an avatar-only state showcase.

**Architecture:** Use a small public demo repository as the live GitHub shell, with three intentionally open PRs. Keep reviewer state deterministic by routing the extension's GitHub API calls inside `tests/e2e/capture-cws-assets.spec.ts`; the live repo supplies row structure and titles, while mocked API responses supply requested reviewers, teams, and completed review states.

**Tech Stack:** WXT MV3 Chrome build, TypeScript, Playwright persistent Chromium contexts, GitHub CLI for one-time demo repository setup, existing reviewer rendering and GitHub REST parsing contracts.

---

## File Structure

- Create or maintain remote GitHub repo `hon454/github-pulls-show-reviewers-screenshots`
  - Owns live screenshot shell PRs only.
  - Keep exactly three open PRs for the store screenshots.
- Modify `tests/e2e/capture-cws-assets.spec.ts`
  - Centralize screenshot repo constants and reviewer scenes.
  - Add extension-disabled before capture.
  - Add extension-enabled after capture and avatar-state showcase capture.
  - Add Playwright assertions before writing screenshot assets.
- Modify `README.md`
  - Point product images at the new before/after and avatar-state screenshots.
- Modify `docs/chrome-web-store.md`
  - Update screenshot inventory and regeneration notes.
- Modify `docs/chrome-web-store-submission.md`
  - Update submission screenshot captions.

## Task 1: Create The Live Demo PR Shell

**Files:**
- Remote: `hon454/github-pulls-show-reviewers-screenshots`

- [ ] **Step 1: Verify GitHub CLI authentication**

Run:

```bash
gh auth status
```

Expected: `Logged in to github.com` for an account that can create repositories under `hon454`. If this fails, stop and ask the maintainer to authenticate with `gh auth login`.

- [ ] **Step 2: Create or clone the demo repository**

Run:

```bash
workdir="$(mktemp -d)"
cd "$workdir"
if gh repo view hon454/github-pulls-show-reviewers-screenshots >/dev/null 2>&1; then
  gh repo clone hon454/github-pulls-show-reviewers-screenshots
else
  gh repo create hon454/github-pulls-show-reviewers-screenshots --public --description "Public PR-list shell for GitHub Pulls Show Reviewers store screenshots" --clone
fi
cd github-pulls-show-reviewers-screenshots
```

Expected: local shell is inside a clone of `hon454/github-pulls-show-reviewers-screenshots`.

- [ ] **Step 3: Seed the main branch**

In the demo repository clone, create `README.md` with `apply_patch`:

```patch
*** Begin Patch
*** Add File: README.md
+# GitHub Pulls Show Reviewers Screenshots
+
+This public repository exists only to provide stable GitHub pull request list
+rows for Chrome Web Store screenshots of GitHub Pulls Show Reviewers.
*** End Patch
```

Then run:

```bash
git add README.md
git commit -m "docs: seed screenshot shell" || true
git push origin main
```

Expected: `main` exists on the remote. The commit command may report nothing to commit if the repository was already seeded.

- [ ] **Step 4: Create the three screenshot PR branches**

Run:

```bash
for branch in \
  cws/add-repository-diagnostics-copy \
  cws/refresh-reviewer-chips-after-navigation \
  cws/keep-requested-reviewers-visible
do
  git checkout main
  git pull --ff-only origin main
  git checkout -B "$branch"
  mkdir -p scenarios
  touch "scenarios/${branch##*/}.txt"
  git add scenarios
  git commit -m "docs: add ${branch##*/} scenario" || true
  git push --force-with-lease origin "$branch"
done
```

Expected: three remote branches exist with one scenario file each.

- [ ] **Step 5: Open the three screenshot PRs**

Run:

```bash
gh pr create --base main --head cws/add-repository-diagnostics-copy --title "Add repository diagnostics copy" --body "Screenshot shell PR." || true
gh pr create --base main --head cws/refresh-reviewer-chips-after-navigation --title "Refresh reviewer chips after GitHub navigation" --body "Screenshot shell PR." || true
gh pr create --base main --head cws/keep-requested-reviewers-visible --title "Keep requested reviewers visible after review activity" --body "Screenshot shell PR." || true
```

Expected: the demo repo has three open PRs. In a new repo they should be PR `#1`, `#2`, and `#3`.

- [ ] **Step 6: Confirm the PR shell**

Run:

```bash
gh pr list --repo hon454/github-pulls-show-reviewers-screenshots --state open --json number,title,headRefName
```

Expected output includes exactly:

```json
[
  {"number":1,"title":"Add repository diagnostics copy","headRefName":"cws/add-repository-diagnostics-copy"},
  {"number":2,"title":"Refresh reviewer chips after GitHub navigation","headRefName":"cws/refresh-reviewer-chips-after-navigation"},
  {"number":3,"title":"Keep requested reviewers visible after review activity","headRefName":"cws/keep-requested-reviewers-visible"}
]
```

Do not create real review requests or real completed reviews. The screenshot pipeline supplies reviewer state through routed API responses.

## Task 2: Centralize Screenshot Scenes

**Files:**
- Modify: `tests/e2e/capture-cws-assets.spec.ts`

- [ ] **Step 1: Add Playwright type import**

Change:

```ts
import { chromium, expect, test } from "@playwright/test";
```

to:

```ts
import { chromium, expect, type Page, test } from "@playwright/test";
```

- [ ] **Step 2: Add demo repo constants and scene types**

Add this block after `outputDir`:

```ts
const screenshotRepo = {
  owner: "hon454",
  repo: "github-pulls-show-reviewers-screenshots",
} as const;
const screenshotRepoFullName = `${screenshotRepo.owner}/${screenshotRepo.repo}`;
const screenshotPullsUrl = `https://github.com/${screenshotRepoFullName}/pulls`;

type ReviewPayload = {
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
  submitted_at: string;
  user: { login: string };
};

type PullScene = {
  pullNumber: string;
  summary: {
    user: { login: string };
    requested_reviewers: Array<{ login: string }>;
    requested_teams: Array<{ slug: string }>;
  };
  reviews: ReviewPayload[];
  expectedLogins: string[];
  expectedTeamText?: string;
  expectedBadgeClasses: string[];
};

const avatarStateScenes: PullScene[] = [
  {
    pullNumber: "1",
    summary: {
      user: { login: "hon454" },
      requested_reviewers: [{ login: "alice" }],
      requested_teams: [{ slug: "platform" }],
    },
    reviews: [
      {
        state: "APPROVED",
        submitted_at: "2026-04-20T12:00:00Z",
        user: { login: "bob" },
      },
    ],
    expectedLogins: ["alice", "bob"],
    expectedTeamText: "Team: platform",
    expectedBadgeClasses: ["ghpsr-badge--approved"],
  },
  {
    pullNumber: "2",
    summary: {
      user: { login: "maintainer" },
      requested_reviewers: [{ login: "mona" }],
      requested_teams: [],
    },
    reviews: [
      {
        state: "CHANGES_REQUESTED",
        submitted_at: "2026-04-20T12:05:00Z",
        user: { login: "kian" },
      },
    ],
    expectedLogins: ["mona", "kian"],
    expectedBadgeClasses: ["ghpsr-badge--changes-requested"],
  },
  {
    pullNumber: "3",
    summary: {
      user: { login: "contributor" },
      requested_reviewers: [{ login: "jules" }],
      requested_teams: [],
    },
    reviews: [
      {
        state: "APPROVED",
        submitted_at: "2026-04-20T12:10:00Z",
        user: { login: "jules" },
      },
      {
        state: "COMMENTED",
        submitted_at: "2026-04-20T12:15:00Z",
        user: { login: "riley" },
      },
    ],
    expectedLogins: ["jules", "riley"],
    expectedBadgeClasses: ["ghpsr-badge--refresh", "ghpsr-badge--commented"],
  },
];
```

- [ ] **Step 3: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS. The new constants are unused for now; TypeScript does not fail on unused locals in this repo configuration.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/capture-cws-assets.spec.ts
git commit -m "refactor: define cws screenshot scenes"
```

## Task 3: Route Deterministic Reviewer API Responses

**Files:**
- Modify: `tests/e2e/capture-cws-assets.spec.ts`

- [ ] **Step 1: Add API routing helper**

Add this helper above `capturePullListScreenshot`:

```ts
async function routeReviewerScenes(
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
  scenes: PullScene[],
): Promise<() => Promise<void>> {
  const routeUrls: string[] = [];

  for (const scene of scenes) {
    const pullRoute = `https://api.github.com/repos/${screenshotRepoFullName}/pulls/${scene.pullNumber}`;
    const reviewsRoute = `${pullRoute}/reviews`;
    routeUrls.push(pullRoute, reviewsRoute);

    await context.route(pullRoute, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(scene.summary),
      });
    });

    await context.route(reviewsRoute, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(scene.reviews),
      });
    });
  }

  return async () => {
    for (const routeUrl of routeUrls) {
      await context.unroute(routeUrl);
    }
  };
}
```

- [ ] **Step 2: Add reviewer assertion helper**

Add this helper below `routeReviewerScenes`:

```ts
async function assertReviewerScenes(page: Page, scenes: PullScene[]): Promise<void> {
  const root = page.locator(".ghpsr-root");
  await expect(root).toContainText("Reviewers:");

  for (const scene of scenes) {
    for (const login of scene.expectedLogins) {
      await expect(root.locator(`a.ghpsr-avatar[title*="@${login}"]`)).toHaveCount(1);
    }
    for (const badgeClass of scene.expectedBadgeClasses) {
      await expect(root.locator(`.${badgeClass}`)).toHaveCount(1);
    }
    if (scene.expectedTeamText != null) {
      await expect(root).toContainText(scene.expectedTeamText);
    }
  }
}
```

- [ ] **Step 3: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/capture-cws-assets.spec.ts
git commit -m "test: route cws reviewer scenes"
```

## Task 4: Capture Live Before And After Screenshots

**Files:**
- Modify: `tests/e2e/capture-cws-assets.spec.ts`

- [ ] **Step 1: Add no-extension context helper**

Add this helper after `withExtensionContext`:

```ts
async function withPlainContext(
  run: (
    context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
  ) => Promise<void>,
): Promise<void> {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "ghpsr-cws-plain-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    viewport: { width: 1280, height: 800 },
  });

  try {
    await run(context);
  } finally {
    await context.close();
  }
}
```

- [ ] **Step 2: Set the extension context viewport**

In `withExtensionContext`, add `viewport` to the `launchPersistentContext` options:

```ts
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: "chromium",
  viewport: { width: 1280, height: 800 },
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
});
```

- [ ] **Step 3: Add screenshot style helper**

Add this helper above `capturePullListScreenshot`:

```ts
async function stabilizePullListForScreenshot(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      .d-none.d-md-inline-flex,
      [class*="ListItem-module__ListItemMetadataRow"] {
        display: inline-flex !important;
        visibility: visible !important;
      }
      .ghpsr-root {
        display: inline-flex !important;
      }
    `,
  });
}
```

- [ ] **Step 4: Add live before helper**

Add this helper above `capturePullListScreenshot`:

```ts
async function captureLiveBeforeScreenshot(
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
  filePath: string,
): Promise<void> {
  const page = await context.newPage();
  try {
    await page.goto(screenshotPullsUrl);
    await expect(page.locator(".ghpsr-root")).toHaveCount(0);
    await stabilizePullListForScreenshot(page);
    await page.screenshot({ path: filePath });
  } finally {
    await page.close();
  }
}
```

- [ ] **Step 5: Add live after helper**

Add this helper below `captureLiveBeforeScreenshot`:

```ts
async function captureLiveAfterScreenshot(
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
  scenes: PullScene[],
  filePath: string,
): Promise<void> {
  const unrouteReviewerScenes = await routeReviewerScenes(context, scenes);
  const page = await context.newPage();
  try {
    await page.goto(screenshotPullsUrl);
    await assertReviewerScenes(page, scenes);
    await stabilizePullListForScreenshot(page);
    await page.screenshot({ path: filePath });
  } finally {
    await page.close();
    await unrouteReviewerScenes();
  }
}
```

- [ ] **Step 6: Run capture command**

Run:

```bash
pnpm cws:assets
```

Expected: PASS. The new helpers are not called yet, so screenshots should match the current behavior.

- [ ] **Step 7: Commit**

```bash
git add tests/e2e/capture-cws-assets.spec.ts
git commit -m "test: add live cws screenshot helpers"
```

## Task 5: Compose The Before / After Asset

**Files:**
- Modify: `tests/e2e/capture-cws-assets.spec.ts`

- [ ] **Step 1: Add `rm` import**

Change:

```ts
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
```

to:

```ts
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
```

- [ ] **Step 2: Add before/after composer**

Add this helper above `capturePullListScreenshot`:

```ts
async function captureBeforeAfterScreenshot(
  extensionContext: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
): Promise<void> {
  const beforePath = path.join(outputDir, "01-pr-list-before.tmp.png");
  const afterPath = path.join(outputDir, "01-pr-list-after.tmp.png");
  const combinedPath = path.join(outputDir, "01-pr-list-before-after.png");

  await withPlainContext(async (plainContext) => {
    await captureLiveBeforeScreenshot(plainContext, beforePath);
  });

  await captureLiveAfterScreenshot(extensionContext, [avatarStateScenes[0]], afterPath);

  const composer = await extensionContext.newPage();
  try {
    const beforeData = (await readFile(beforePath)).toString("base64");
    const afterData = (await readFile(afterPath)).toString("base64");
    await composer.setViewportSize({ width: 1280, height: 800 });
    await composer.setContent(`
      <!doctype html>
      <html>
        <head>
          <style>
            body {
              margin: 0;
              background: #f6f8fa;
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            }
            .frame {
              width: 1280px;
              height: 800px;
              box-sizing: border-box;
              padding: 32px;
              display: grid;
              grid-template-columns: 1fr 1fr;
              gap: 24px;
            }
            .panel {
              overflow: hidden;
              border: 1px solid #d0d7de;
              border-radius: 8px;
              background: #ffffff;
              box-shadow: 0 8px 24px rgba(140, 149, 159, 0.2);
            }
            .label {
              height: 44px;
              display: flex;
              align-items: center;
              padding: 0 16px;
              border-bottom: 1px solid #d8dee4;
              font-size: 15px;
              font-weight: 700;
            }
            img {
              display: block;
              width: 100%;
            }
          </style>
        </head>
        <body>
          <div class="frame">
            <section class="panel">
              <div class="label">Before</div>
              <img alt="" src="data:image/png;base64,${beforeData}">
            </section>
            <section class="panel">
              <div class="label">After</div>
              <img alt="" src="data:image/png;base64,${afterData}">
            </section>
          </div>
        </body>
      </html>
    `);
    await composer.screenshot({ path: combinedPath });
  } finally {
    await composer.close();
    await rm(beforePath, { force: true });
    await rm(afterPath, { force: true });
  }
}
```

- [ ] **Step 3: Replace the first PR-list screenshot call**

Inside the test, replace the first `capturePullListScreenshot(...)` call with:

```ts
await captureBeforeAfterScreenshot(context);
```

Keep the old `capturePullListScreenshot` function for one more task so the existing second PR-list screenshot and options screenshot still work.

- [ ] **Step 4: Run capture command**

Run:

```bash
pnpm cws:assets
```

Expected: PASS and `docs/chrome-web-store-assets/01-pr-list-before-after.png` is generated. The command fails before writing the final combined image if the live demo repo cannot be reached or the after reviewer chips do not render.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/capture-cws-assets.spec.ts docs/chrome-web-store-assets/01-pr-list-before-after.png
git commit -m "test: capture cws before after asset"
```

## Task 6: Capture The Avatar-Only State Showcase

**Files:**
- Modify: `tests/e2e/capture-cws-assets.spec.ts`

- [ ] **Step 1: Add showcase helper**

Add this helper above `captureOptionsScreenshot`:

```ts
async function captureAvatarStateShowcase(
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
): Promise<void> {
  await captureLiveAfterScreenshot(
    context,
    avatarStateScenes,
    path.join(outputDir, "02-pr-list-avatar-state-showcase.png"),
  );
}
```

- [ ] **Step 2: Replace the second PR-list screenshot call**

Inside the test, remove:

```ts
await setPreference(context, extensionId, "showReviewerName", true);
await capturePullListScreenshot(context, {
  fixture: "github-pulls-list-item-metadata.html",
  fileName: "02-pr-list-mixed-review-states.png",
  pullNumber: "42",
  summary: {
    user: { login: "hon454" },
    requested_reviewers: [{ login: "jules" }],
    requested_teams: [{ slug: "security" }],
  },
  reviews: [
    {
      state: "CHANGES_REQUESTED",
      submitted_at: "2026-04-20T12:05:00Z",
      user: { login: "kian" },
    },
  ],
  expectedLogins: ["jules", "kian"],
  expectedTeamText: "Team: security",
  expectedNamePills: ["@jules", "@kian"],
});
```

Replace it with:

```ts
await captureAvatarStateShowcase(context);
```

Do not call `setPreference(..., "showReviewerName", true)` before this screenshot. The showcase must use the default avatar-only UI.

- [ ] **Step 3: Remove stale screenshot asset**

Run:

```bash
git rm docs/chrome-web-store-assets/02-pr-list-mixed-review-states.png
```

Expected: file is staged for deletion.

- [ ] **Step 4: Run capture command**

Run:

```bash
pnpm cws:assets
```

Expected: PASS and `docs/chrome-web-store-assets/02-pr-list-avatar-state-showcase.png` is generated.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/capture-cws-assets.spec.ts docs/chrome-web-store-assets
git commit -m "test: capture avatar state showcase"
```

## Task 7: Remove Obsolete Fixture Capture Path

**Files:**
- Modify: `tests/e2e/capture-cws-assets.spec.ts`

- [ ] **Step 1: Delete old fixture helper**

Remove the entire `capturePullListScreenshot` function from `tests/e2e/capture-cws-assets.spec.ts`.

- [ ] **Step 2: Keep the remaining imports exact**

Keep this import because `captureBeforeAfterScreenshot` still reads temporary
PNG files:

```ts
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
```

Remove any remaining local variables named `fixturePath` and any remaining
`path.join(projectRoot, "tests/fixtures", ...)` expressions from
`tests/e2e/capture-cws-assets.spec.ts`.

- [ ] **Step 3: Run search check**

Run:

```bash
rg -n "fixture|github-pulls-list-item-metadata|02-pr-list-mixed-review-states|01-pr-list-requested-and-reviewed" tests/e2e/capture-cws-assets.spec.ts
```

Expected: no output.

- [ ] **Step 4: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/capture-cws-assets.spec.ts
git commit -m "refactor: remove fixture cws capture path"
```

## Task 8: Update Store Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/chrome-web-store.md`
- Modify: `docs/chrome-web-store-submission.md`

- [ ] **Step 1: Update README hero image**

Replace:

```markdown
![GitHub PR list with merged reviewer chips](./docs/chrome-web-store-assets/01-pr-list-requested-and-reviewed.png)
```

with:

```markdown
![Before and after GitHub PR list showing reviewer chips added by the extension](./docs/chrome-web-store-assets/01-pr-list-before-after.png)
```

- [ ] **Step 2: Update README screenshot table**

Replace the table headings:

```markdown
| Merged `Reviewers` section with state badges                                                   | Name-pill layout (optional)                                                                     |
```

with:

```markdown
| Before / after reviewer visibility                                                             | Avatar-only state showcase                                                                      |
```

Replace the table image row:

```markdown
| ![Merged reviewer chips](./docs/chrome-web-store-assets/01-pr-list-requested-and-reviewed.png) | ![Reviewer name-pill layout](./docs/chrome-web-store-assets/02-pr-list-mixed-review-states.png) |
```

with:

```markdown
| ![Before and after reviewer chips](./docs/chrome-web-store-assets/01-pr-list-before-after.png) | ![Avatar-only reviewer state showcase](./docs/chrome-web-store-assets/02-pr-list-avatar-state-showcase.png) |
```

- [ ] **Step 3: Update Chrome Web Store notes**

In `docs/chrome-web-store.md`, replace the current screenshot set with:

```markdown
- `01-pr-list-before-after.png` — before/after comparison showing GitHub's default PR list beside the extension-enhanced reviewer strip
- `02-pr-list-avatar-state-showcase.png` — default avatar-only reviewer chips with requested outlines and completed-review badges
- `03-options-repository-check.png` — options page display settings and repository diagnostics
```

- [ ] **Step 4: Update submission packet**

In `docs/chrome-web-store-submission.md`, replace the screenshot inventory with:

```markdown
- `01-pr-list-before-after.png`
  Caption: `Before and after: reviewer chips added directly to the GitHub pull request list.`
- `02-pr-list-avatar-state-showcase.png`
  Caption: `Requested reviewers and completed review states shown as avatar chips with outlines and badges.`
- `03-options-repository-check.png`
  Caption: `Display settings and repository diagnostics on the options page.`
```

- [ ] **Step 5: Run stale-reference search**

Run:

```bash
rg -n "01-pr-list-requested-and-reviewed|02-pr-list-mixed-review-states" README.md docs/chrome-web-store.md docs/chrome-web-store-submission.md
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/chrome-web-store.md docs/chrome-web-store-submission.md
git commit -m "docs: update cws screenshot inventory"
```

## Task 9: Final Verification

**Files:**
- Verify only.

- [ ] **Step 1: Run static checks**

Run:

```bash
pnpm typecheck
pnpm lint
```

Expected: both commands pass.

- [ ] **Step 2: Run screenshot capture**

Run:

```bash
pnpm cws:assets
```

Expected: Playwright capture project passes and these files exist:

```text
docs/chrome-web-store-assets/01-pr-list-before-after.png
docs/chrome-web-store-assets/02-pr-list-avatar-state-showcase.png
docs/chrome-web-store-assets/03-options-repository-check.png
```

- [ ] **Step 3: Confirm old assets are gone**

Run:

```bash
test ! -e docs/chrome-web-store-assets/01-pr-list-requested-and-reviewed.png
test ! -e docs/chrome-web-store-assets/02-pr-list-mixed-review-states.png
```

Expected: both commands exit `0`.

- [ ] **Step 4: Inspect final diff**

Run:

```bash
git status --short
git diff --stat HEAD
```

Expected: only intended code, docs, and screenshot asset changes remain.
