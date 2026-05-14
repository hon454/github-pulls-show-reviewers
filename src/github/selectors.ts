export const githubSelectors = {
  row: ".js-issue-row",
  primaryLink: 'a.Link--primary[href*="/pull/"]',
  metaContainers: [
    ".d-flex.mt-1.text-small.color-fg-muted",
    '[class*="ListItem-module__ListItemMetadataRow"]',
  ],
  fallbackMetaContainer: "[data-ghpsr-fallback-meta]",
  inlineMetaRowSelectors: [".d-none.d-md-inline-flex"],
  volatileMetadataSelectors: ["relative-time", "time-ago", ".js-timeago"],
} as const;
