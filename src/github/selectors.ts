export const githubSelectors = {
  row: ".js-issue-row",
  primaryLink: 'a.Link--primary[href*="/pull/"]',
  pullLinkSelectors: [
    'a.Link--primary[href*="/pull/"]',
    'a.js-navigation-open[href*="/pull/"]',
  ],
  metaContainers: [
    ".d-flex.mt-1.text-small.color-fg-muted",
    '[class*="ListItem-module__ListItemMetadataRow"]',
  ],
  fallbackMetaContainer: "[data-ghpsr-fallback-meta]",
  volatileMetadataSelectors: ["relative-time", "time-ago", ".js-timeago"],
  observedRowAttributes: ["class", "href", "id"],
} as const;
