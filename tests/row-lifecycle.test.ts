// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  collectVisiblePullNumbers,
  createReviewerRowLifecycle,
} from "../src/features/reviewers/row-lifecycle";

const fixtureHtml = readFileSync(
  path.join(process.cwd(), "tests/fixtures/github-pulls-single-row.html"),
  "utf8",
);
const stressFixtureHtml = readFileSync(
  path.join(process.cwd(), "tests/fixtures/github-pulls-mutation-stress.html"),
  "utf8",
);
const route = { owner: "hon454", repo: "github-pulls-show-reviewers" };

function flushMutations(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  const fixtureDocument = new DOMParser().parseFromString(
    fixtureHtml,
    "text/html",
  );
  document.body.innerHTML = fixtureDocument.body.innerHTML;
});

describe("reviewer row lifecycle", () => {
  it("collects visible pull numbers once and in DOM order", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div class="js-issue-row"><a class="Link--primary" href="/hon454/github-pulls-show-reviewers/pull/42">duplicate</a></div>
       <div class="js-issue-row"><a class="Link--primary" href="/hon454/github-pulls-show-reviewers/pull/43">next</a></div>`,
    );

    expect(collectVisiblePullNumbers()).toEqual(["42", "43"]);
  });

  it("reprocesses a row when GitHub-owned metadata changes", async () => {
    const processRow = vi.fn();
    const markPageMetadataStale = vi.fn();
    const lifecycle = createReviewerRowLifecycle({
      getRoute: () => route,
      processRow,
      markPageMetadataStale,
    });
    const row = document.querySelector(".js-issue-row")!;
    lifecycle.recordFingerprint(row, "42", route);
    const observer = lifecycle.observe();

    document.querySelector(".issue-meta-section")!.textContent =
      "#42 updated by hon454";
    await flushMutations();
    observer.disconnect();

    expect(processRow).toHaveBeenCalledWith(row);
    expect(markPageMetadataStale).toHaveBeenCalledTimes(1);
  });

  it("ignores extension-owned DOM mutations", async () => {
    const processRow = vi.fn();
    const markPageMetadataStale = vi.fn();
    const lifecycle = createReviewerRowLifecycle({
      getRoute: () => route,
      processRow,
      markPageMetadataStale,
    });
    const row = document.querySelector(".js-issue-row")!;
    lifecycle.recordFingerprint(row, "42", route);
    const observer = lifecycle.observe();

    const mount = document.createElement("span");
    mount.dataset.ghpsrRoot = "true";
    row.append(mount);
    mount.textContent = "Loading reviewers…";
    await flushMutations();
    observer.disconnect();

    expect(processRow).not.toHaveBeenCalled();
    expect(markPageMetadataStale).not.toHaveBeenCalled();
  });

  it("measures deterministic work for unrelated mutation bursts", async () => {
    const fixtureDocument = new DOMParser().parseFromString(
      stressFixtureHtml,
      "text/html",
    );
    document.body.innerHTML = fixtureDocument.body.innerHTML;
    const work = {
      observerCallbacks: 0,
      mutationRecords: 0,
      fingerprints: 0,
      processRowCalls: 0,
      reviewerApiRequests: 0,
    };
    const lifecycle = createReviewerRowLifecycle({
      getRoute: () => route,
      processRow: () => {
        work.reviewerApiRequests += 1;
      },
      markPageMetadataStale: vi.fn(),
      diagnostics: {
        onObserverCallback(mutationCount) {
          work.observerCallbacks += 1;
          work.mutationRecords += mutationCount;
        },
        onFingerprint() {
          work.fingerprints += 1;
        },
        onProcessRow() {
          work.processRowCalls += 1;
        },
      },
    });
    const row = document.querySelector(".js-issue-row")!;
    lifecycle.recordFingerprint(row, "42", route);
    work.fingerprints = 0;
    const observer = lifecycle.observe();

    const link = document.querySelector<HTMLAnchorElement>("a.Link--primary")!;
    const relativeTime = document.querySelector("relative-time")!;
    const rowNoise = document.querySelector("[data-stress-row-noise]")!;
    const pageNoise = document.querySelector("[data-stress-page-noise]")!;
    for (let index = 0; index < 20; index += 1) {
      link.setAttribute("data-hovercard-url", `/pull/42?hover=${index}`);
      relativeTime.textContent = `${index + 2} hours ago`;
      rowNoise.append(document.createElement("span"));
      pageNoise.setAttribute("data-refresh", String(index));
      pageNoise.append(document.createElement("span"));
    }

    await flushMutations();
    observer.disconnect();

    expect(work).toEqual({
      observerCallbacks: 1,
      mutationRecords: 60,
      fingerprints: 1,
      processRowCalls: 0,
      reviewerApiRequests: 0,
    });
  });
});
