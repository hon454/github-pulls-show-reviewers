# Reviewer Visibility Launch Kit

The campaign leads with one problem: GitHub pull request lists do not show
enough reviewer context for a fast scan. Keep every post accurate, useful, and
specific to that workflow.

## Canonical message

**Headline**

See GitHub PR reviewer status without opening every pull request

**Short introduction**

GitHub Pulls Show Reviewers adds requested reviewers, requested teams, and each
reviewer's latest completed review state directly to GitHub pull request list
rows. Public repositories work without signing in, and private repositories use
GitHub sign-in with Pull requests: Read access.

**Demo**

Use `docs/chrome-web-store-assets/01-pr-list-before-after.png` as the primary
visual and link readers to the product tour:

`https://hon454.github.io/github-pulls-show-reviewers/`

## DEV article draft

### Stop opening GitHub pull requests just to find the reviewer

When a repository has a busy pull request queue, GitHub's list view tells you a
lot about each PR—but not enough about its review state. I kept opening pull
requests one by one just to answer three small questions:

- Who is still requested?
- Is a team responsible for the review?
- Did the latest review approve the change or request changes?

GitHub Pulls Show Reviewers puts those answers directly in each pull request
row. It adds one lightweight `Reviewers:` strip with requested people, requested
teams, and completed review-state badges. It deliberately does not turn the
list into another dashboard.

Public repositories work without a token. For private repositories, the
extension uses GitHub sign-in through a GitHub App that requests Pull requests:
Read access only.

The project is open source. Feedback about reviewer visibility, GitHub DOM
changes, and real pull request queues is welcome.

Product tour:
`https://hon454.github.io/github-pulls-show-reviewers/`

Chrome Web Store:
`https://chromewebstore.google.com/detail/github-pulls-show-reviewe/hoocgjopdboeghdkfjlkngkkpbiljggk?utm_source=devto&utm_medium=article&utm_campaign=reviewer_visibility_launch`

Source:
`https://github.com/hon454/github-pulls-show-reviewers`

## Show HN draft

**Title**

Show HN: See reviewer status directly in GitHub pull request lists

**Body**

I built a small Chrome extension for one GitHub workflow: seeing requested
reviewers, requested teams, and completed review states without opening every
pull request. It adds a single reviewer strip to each PR-list row and leaves the
rest of GitHub's UI alone.

Public repositories work without sign-in. Private repositories use a GitHub App
with Pull requests: Read access. The extension is open source.

Demo: https://hon454.github.io/github-pulls-show-reviewers/

Store:
https://chromewebstore.google.com/detail/github-pulls-show-reviewe/hoocgjopdboeghdkfjlkngkkpbiljggk?utm_source=hacker_news&utm_medium=community&utm_campaign=reviewer_visibility_launch

Source: https://github.com/hon454/github-pulls-show-reviewers

## Reddit draft

**Title**

I made a focused extension that shows reviewers in GitHub PR lists

**Body**

I wanted to scan a pull request queue without opening every PR just to see who
was requested or whether the latest review approved it or requested changes.

The extension adds requested reviewers, teams, and completed review-state
badges directly to GitHub's PR-list rows. It works on public repositories
without sign-in and stays intentionally limited to reviewer visibility.

Demo: https://hon454.github.io/github-pulls-show-reviewers/

Chrome Web Store:
https://chromewebstore.google.com/detail/github-pulls-show-reviewe/hoocgjopdboeghdkfjlkngkkpbiljggk?utm_source=reddit&utm_medium=community&utm_campaign=reviewer_visibility_launch

Source: https://github.com/hon454/github-pulls-show-reviewers

## Publication checklist

- Verify the store listing screenshot matches the current GitHub App sign-in
  flow before publishing any campaign post.
- Use the channel-specific store URL above; do not reuse the README URL.
- Use the actual Before/After image without altering the GitHub UI or reviewer
  states.
- Answer questions about permissions and public-repository access directly.
- Do not incentivize ratings or reviews.
