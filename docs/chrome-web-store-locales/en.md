# English Chrome Web Store listing (`en`)

## Packaged name and short description

Name: `GitHub Pulls Show Reviewers`

Short description source: [`extension_description.message`](../../public/_locales/en/messages.json).
Use that catalog value verbatim; there is no separately editable summary here.
`extension_name.message` in the same catalog must match the name above.
Run `pnpm verify:cws` to print the current values and check the 75/132 character limits.
Chrome selects packaged metadata independently of the manual extension UI language.

## Detailed description

<!-- description:start -->
GitHub Pulls Show Reviewers shows reviewer information directly in GitHub pull request lists. See requested reviewers, requested teams, and each reviewer's completed review state without opening every pull request.

Requested reviewers have an outline. Completed reviews use badges for approved, changes requested, commented, and dismissed states. A reviewer can still be requested after completing a review; when a new request is detected after an approval, change request, or dismissed review, a refresh badge indicates that another review is requested. Team chips show requested teams, not a team's approval status. Unsubmitted pending reviews are not shown.

Choose whether to show reviewer usernames and state badges, and whether reviewer links should lead only to open pull requests. Repository checks help explain access problems. The extension focuses on reviewers; it does not add checks, mergeability, assignees, or labels.

Public repositories work without an account or token, subject to GitHub's unauthenticated API limits. For private repositories, sign in with GitHub using the maintainer-owned GitHub App and OAuth Device Flow. The App requests only Pull requests: Read repository permission. Access requires your account and the App installation to have access to the repository; signing in alone does not grant access. You can connect multiple GitHub accounts. Account credentials and preferences are stored locally in the browser. Reviewer data requests go directly to GitHub; there is no extension-operated backend.

Extension-owned UI supports English, Korean, Japanese, Simplified Chinese, and Traditional Chinese. By default it follows Chrome's UI language, with English as the fallback for unsupported languages. A manual language selection is saved in the extension's options. Changing it reformats the extension UI without fetching reviewer data again. Chrome selects packaged name and summary independently; the UI setting does not change the store listing language.

The extension does not translate GitHub pages, pull request titles, usernames, team names, or GitHub's external authorization page. The landing page, privacy policy, and linked developer documentation remain in English.
<!-- description:end -->

## Ordered screenshot inventory

Upload these three images to this locale, in order. Text below describes each
scene for review; it is not an additional dashboard field to populate.

1. [01-pr-list-before-after.png](../chrome-web-store-assets/01-pr-list-before-after.png) — Before and after: reviewer chips added directly to the GitHub pull request list.
1. [02-pr-list-avatar-state-showcase.png](../chrome-web-store-assets/02-pr-list-avatar-state-showcase.png) — Requested reviewers, requested teams, and completed review states with outlines and badges.
1. [03-options-repository-check.png](../chrome-web-store-assets/03-options-repository-check.png) — Display settings and a public repository check without a token.

<!-- capture-before: Before -->
<!-- capture-after: After -->

The two capture comments are the source for this locale's composition captions.
Screenshots use synthetic GitHub/user content and the **TESTING** GitHub App build
from `pnpm cws:assets`; they are not production-config package evidence.

## Terminology and review

Use the shared [localization glossary](../localization.md) and this locale's
catalog for reviewer states, usernames, repository access, and account terms.
`APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, and `DISMISSED` mean completed
review states. Requested teams have no aggregate approval state. A fresh request
after a completed review is distinct from a completed review that remains requested.
Keep GitHub, GitHub App, OAuth Device Flow, Pull requests: Read, and the product
name unchanged. GitHub user content and external pages are outside translation scope.

For registration and evidence, follow the [per-locale checklist](../chrome-web-store-submission.md#per-locale-dashboard-checklist).
