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
  volatileMetadataSelectors: [
    "relative-time",
    "time-ago",
    ".js-timeago",
    // Preview puts live check counts inside the description. They must not
    // invalidate reviewer caches when GitHub refreshes checks independently.
    '[class*="PullsListItem-module__inlineChecksBadge"]',
    '[data-testid="checks-status-badge-button"]',
  ],
  // Access-banner anchors, tried in order. Classic lists put the banner after
  // the toolbar or subnav. The Preview ListView has neither, so the banner goes
  // directly above the list container, which also holds the Open/Closed
  // header. The container is found by its id suffix, then by its CSS-module
  // name; if GitHub renames both, the banner goes above the bare list. `main`
  // is the last resort and receives the banner as its first child; inserting
  // after `</main>` would render the guidance below the whole page.
  accessBannerAnchors: [
    { selector: ".pr-toolbar", position: "afterend" },
    { selector: ".subnav", position: "afterend" },
    { selector: 'main [id$="-list-view-container"]', position: "beforebegin" },
    {
      selector: 'main [class*="ListView-module__container"]',
      position: "beforebegin",
    },
    {
      selector: '[data-listview-component="items-list"]',
      position: "beforebegin",
    },
    { selector: "main", position: "afterbegin" },
  ],
  observedRowAttributes: [
    "class",
    "href",
    "id",
    "data-testid",
    "data-listview-component",
    "data-listview-item-title-container",
  ],
} as const;
