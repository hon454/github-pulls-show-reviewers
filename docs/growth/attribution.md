# Store Acquisition Attribution

Use campaign-tagged links for every publisher-controlled path to the Chrome Web
Store. Chrome forwards `utm_source`, `utm_medium`, and `utm_campaign` to the
store-managed Google Analytics property.

Store listing:

`https://chromewebstore.google.com/detail/github-pulls-show-reviewe/hoocgjopdboeghdkfjlkngkkpbiljggk`

## Naming convention

| Placement         | `utm_source`   | `utm_medium`   | `utm_campaign`                 |
| ----------------- | -------------- | -------------- | ------------------------------ |
| Repository README | `github`       | `readme`       | `evergreen`                    |
| README badges     | `github`       | `readme_badge` | `evergreen`                    |
| GitHub Pages tour | `github_pages` | `landing_page` | `evergreen`                    |
| GitHub Release    | `github`       | `release`      | release tag, such as `v1_13_0` |
| DEV article       | `devto`        | `article`      | `reviewer_visibility_launch`   |
| Hacker News       | `hacker_news`  | `community`    | `reviewer_visibility_launch`   |
| Reddit            | `reddit`       | `community`    | `reviewer_visibility_launch`   |
| LinkedIn          | `linkedin`     | `social`       | `reviewer_visibility_launch`   |

Use lowercase snake case. Do not reuse one source name for multiple platforms.
Do not add user, repository, or other personal identifiers to campaign values.

## Measurement setup

1. In the Chrome Web Store Developer Dashboard, opt in to Google Analytics
   under the listing's additional metrics if it is not already enabled.
2. In the store-managed GA4 property, mark the `install` event as a key event.
3. Compare `page_view` and `install` by session source, medium, and campaign.
4. Wait 48 hours before treating recent source data as final.
5. Review performance weekly; do not infer channel quality from fewer than 20
   attributed visits without qualitative evidence.

## Thirty-day scorecard

| Metric                           | August 2026 baseline |                  Experiment target |
| -------------------------------- | -------------------: | ---------------------------------: |
| Store page views                 |                   32 |                        100 or more |
| Zero-view days                   |                   15 |                         5 or fewer |
| Identified external-source share |                6.25% |                        70% or more |
| Install conversion rate          |        Not available | Establish baseline; do not regress |

The target is an experiment threshold, not a forecast. Optimize for qualified
installs and low uninstall behavior rather than page views alone.
