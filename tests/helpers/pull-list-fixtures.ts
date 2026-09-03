export const REPRESENTATIVE_PULL_LIST_PULL_NUMBERS = Array.from(
  { length: 25 },
  (_, index) => String(125 - index),
);

export const FILTERED_PULL_LIST_PULL_NUMBERS = [
  "300",
  "245",
  "198",
  "151",
  "88",
  "34",
  "21",
  "7",
];

export function createPullListFixtureHtml(
  pullNumbers: readonly string[],
  route = { owner: "hon454", repo: "github-pulls-show-reviewers" },
): string {
  const rows = pullNumbers
    .map(
      (pullNumber) => `
        <div class="js-issue-row" id="issue_${pullNumber}">
          <a class="Link--primary" href="/${route.owner}/${route.repo}/pull/${pullNumber}">
            Pull request #${pullNumber}
          </a>
          <div class="d-flex mt-1 text-small color-fg-muted">
            <span class="d-none d-md-inline-flex">
              <span class="issue-meta-section ml-2">#${pullNumber} opened by ${route.owner}</span>
            </span>
          </div>
        </div>`,
    )
    .join("");

  return `<!doctype html>
    <html lang="en">
      <head><meta charset="UTF-8"><title>Pull list fixture</title></head>
      <body>
        <div class="js-navigation-container js-active-navigation-container">
          ${rows}
        </div>
      </body>
    </html>`;
}
