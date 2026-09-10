export const githubSelectors = {
  // Classic rows and the repository dashboard's ListView rows. The structural
  // fallback avoids depending on CSS-module hashes or localized list labels.
  row: [
    ".js-issue-row",
    'li[class*="PullsListItem-module__listItem"]',
    '[data-listview-component="items-list"] > li:has([data-listview-item-title-container] a[data-testid="listitem-title-link"][href*="/pull/"])',
  ].join(", "),
  primaryLink: 'a.Link--primary[href*="/pull/"]',
  pullLinkSelectors: [
    'a.Link--primary[href*="/pull/"]',
    'a.js-navigation-open[href*="/pull/"]',
    'a[data-testid="listitem-title-link"][href*="/pull/"]',
    '[data-listview-item-title-container] h3 a[href*="/pull/"]',
  ],
  metaContainers: [
    ".d-flex.mt-1.text-small.color-fg-muted",
    '[class*="ListItem-module__ListItemMetadataRow"]',
    '[class*="PullsListItem-module__description"]',
    '[class*="Description-module__container"]',
  ],
  fallbackMetaContainer: "[data-ghpsr-fallback-meta]",
  volatileMetadataSelectors: ["relative-time", "time-ago", ".js-timeago"],
  observedRowAttributes: [
    "class",
    "href",
    "id",
    "data-testid",
    "data-listview-component",
    "data-listview-item-title-container",
  ],
} as const;
