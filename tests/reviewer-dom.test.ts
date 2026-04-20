// @vitest-environment jsdom

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it } from "vitest";

import {
  ensureReviewerMount,
  extractPullNumber,
  renderReviewerSections,
} from "../src/features/reviewers/dom";
import { buildReviewerSections } from "../src/features/reviewers/view-model";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(currentDir, "fixtures");

async function loadFixture(name: string): Promise<void> {
  document.body.innerHTML = await readFile(path.join(fixturesDir, name), "utf8");
}

describe("reviewer dom rendering", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div class="js-issue-row" id="issue_42">
        <div class="d-flex mt-1 text-small color-fg-muted">
          <span class="d-none d-md-inline-flex">
            <span class="issue-meta-section ml-2">Existing metadata</span>
          </span>
        </div>
      </div>
    `;
  });

  it("renders requested and reviewed chips into the metadata row", () => {
    const row = document.querySelector(".js-issue-row");
    expect(row).not.toBeNull();

    const mount = ensureReviewerMount(row!);
    expect(mount).not.toBeNull();

    const sections = buildReviewerSections(
      { owner: "hon454", repo: "github-pulls-show-reviewers" },
      {
        requestedUsers: ["alice"],
        requestedTeams: ["platform"],
        completedReviews: [{ login: "bob", state: "APPROVED" }],
      },
    );

    renderReviewerSections(mount!, sections);

    expect(mount?.textContent).toContain("Requested:");
    expect(mount?.textContent).toContain("alice");
    expect(mount?.textContent).toContain("@platform");
    expect(mount?.textContent).toContain("bob");
    expect(mount?.textContent).toContain("approved");
  });

  it("extracts the pull number from the primary link when the row id is missing", async () => {
    await loadFixture("github-pulls-link-only.html");

    const row = document.querySelector(".js-issue-row");
    expect(row).not.toBeNull();
    expect(extractPullNumber(row!)).toBe("77");
  });

  it("finds CSS-module metadata rows by stable class prefix", async () => {
    await loadFixture("github-pulls-list-item-metadata.html");

    const row = document.querySelector(".js-issue-row");
    expect(row).not.toBeNull();

    const mount = ensureReviewerMount(row!);
    expect(mount).not.toBeNull();
    expect(row?.querySelector('[data-ghpsr-root="true"]')).toBe(mount);
  });

  it("creates an inline metadata row when GitHub omits the desktop wrapper span", async () => {
    await loadFixture("github-pulls-missing-inline-meta.html");

    const row = document.querySelector(".js-issue-row");
    expect(row).not.toBeNull();

    const mount = ensureReviewerMount(row!);
    expect(mount).not.toBeNull();
    expect(row?.querySelector(".d-none.d-md-inline-flex")).not.toBeNull();
  });
});
