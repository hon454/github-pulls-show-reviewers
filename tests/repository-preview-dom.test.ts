// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { githubSelectors } from "../src/github/selectors";
import {
  ensureReviewerMount,
  extractPullNumber,
} from "../src/features/reviewers/dom";
import {
  collectVisiblePullNumbers,
  createReviewerRowLifecycle,
} from "../src/features/reviewers/row-lifecycle";

const preview = readFileSync(
  "tests/fixtures/github-pulls-repository-preview.html",
  "utf8",
);
const classic = readFileSync(
  "tests/fixtures/github-pulls-single-row.html",
  "utf8",
);
const route = { owner: "hon454", repo: "github-pulls-show-reviewers" };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const body = (html: string) =>
  new DOMParser().parseFromString(html, "text/html").body.innerHTML;

beforeEach(() => {
  document.body.innerHTML = body(preview);
});

describe("repository pull list Preview", () => {
  it("discovers structural fallback rows when ListView hydrates its marker", async () => {
    document.querySelector("li")!.removeAttribute("class");
    const list = document.querySelector("ul")!;
    list.removeAttribute("data-listview-component");
    const processRow = vi.fn();
    const lifecycle = createReviewerRowLifecycle({
      getRoute: () => route,
      processRow,
      markPageMetadataStale: vi.fn(),
    });
    const observer = lifecycle.observe();
    try {
      lifecycle.processRows();
      expect(processRow).not.toHaveBeenCalled();
      list.setAttribute("data-listview-component", "items-list");
      await flush();
      expect(processRow).toHaveBeenCalledOnce();
      expect(collectVisiblePullNumbers()).toEqual(["42"]);
    } finally {
      observer.disconnect();
    }
  });

  it("reprocesses a recycled dashboard row when its pull URL changes", async () => {
    const row = document.querySelector(githubSelectors.row)!;
    const processRow = vi.fn();
    const stale = vi.fn();
    const lifecycle = createReviewerRowLifecycle({
      getRoute: () => route,
      processRow,
      markPageMetadataStale: stale,
    });
    lifecycle.recordFingerprint(row, "42", route);
    const observer = lifecycle.observe();
    try {
      row
        .querySelector('[data-testid="listitem-title-link"]')!
        .setAttribute("href", "/hon454/github-pulls-show-reviewers/pull/43");
      await flush();
      expect(processRow).toHaveBeenCalledOnce();
      expect(stale).toHaveBeenCalledOnce();
      expect(collectVisiblePullNumbers()).toEqual(["43"]);
    } finally {
      observer.disconnect();
    }
  });
  it("finds the real dashboard structure and mounts in its description, not its title or trailing metadata", () => {
    expect(document.querySelector(".js-issue-row")).toBeNull();
    const rows = document.querySelectorAll(githubSelectors.row);
    expect(rows).toHaveLength(1);
    expect(collectVisiblePullNumbers()).toEqual(["42"]);
    const mount = ensureReviewerMount(rows[0])!;
    expect(
      mount.closest('[class*="PullsListItem-module__description"]'),
    ).not.toBeNull();
    expect(mount.closest("h3, a")).toBeNull();
    expect(ensureReviewerMount(rows[0])).toBe(mount);
  });

  it("keeps structural row discovery when CSS module names change and ignores non-PR items", () => {
    document.querySelector("li")!.removeAttribute("class");
    document
      .querySelector("ul")!
      .insertAdjacentHTML(
        "beforeend",
        '<li><div data-listview-item-title-container><h3><a data-testid="listitem-title-link" href="/hon454/github-pulls-show-reviewers/issues/99">Issue</a></h3></div></li>',
      );
    expect(document.querySelectorAll(githubSelectors.row)).toHaveLength(1);
    expect(collectVisiblePullNumbers()).toEqual(["42"]);
  });

  it("falls back to the title container if the title test id disappears and to a mount beside the title if description disappears", () => {
    document
      .querySelector('[data-testid="listitem-title-link"]')!
      .removeAttribute("data-testid");
    document
      .querySelector('[class*="Description-module__container"]')!
      .remove();
    const row = document.querySelector(githubSelectors.row)!;
    expect(extractPullNumber(row)).toBe("42");
    const mount = ensureReviewerMount(row)!;
    expect(mount.closest("a")).toBeNull();
    expect(row.querySelectorAll("[data-ghpsr-fallback-meta]")).toHaveLength(1);
    expect(ensureReviewerMount(row)).toBe(mount);
  });

  it.each([
    [classic, preview],
    [preview, classic],
  ])(
    "discovers rows after switching layouts without duplicating processing",
    async (initial, next) => {
      document.body.innerHTML = body(initial);
      const processRow = vi.fn();
      const lifecycle = createReviewerRowLifecycle({
        getRoute: () => route,
        processRow,
        markPageMetadataStale: vi.fn(),
      });
      const observer = lifecycle.observe();
      try {
        lifecycle.processRows();
        expect(processRow).toHaveBeenCalledOnce();
        processRow.mockClear();
        document.body.innerHTML = body(next);
        await flush();
        expect(processRow).toHaveBeenCalledOnce();
        expect(collectVisiblePullNumbers()).toEqual(["42"]);
      } finally {
        observer.disconnect();
      }
    },
  );

  it("repairs React description replacement and ignores extension rendering", async () => {
    const row = document.querySelector(githubSelectors.row)!;
    const processRow = vi.fn((element: Element) => {
      ensureReviewerMount(element);
    });
    const stale = vi.fn();
    const lifecycle = createReviewerRowLifecycle({
      getRoute: () => route,
      processRow,
      markPageMetadataStale: stale,
    });
    ensureReviewerMount(row);
    lifecycle.recordFingerprint(row, "42", route);
    const observer = lifecycle.observe();
    try {
      const description = row.querySelector(
        '[class*="PullsListItem-module__description"]',
      )!;
      const replacement = description.cloneNode(true) as Element;
      replacement.querySelector("[data-ghpsr-reviewer-meta]")!.remove();
      description.replaceWith(replacement);
      await flush();
      expect(processRow).toHaveBeenCalledOnce();
      expect(stale).not.toHaveBeenCalled();
      row.querySelector("[data-ghpsr-root]")!.textContent = "Reviewers: alice";
      await flush();
      expect(processRow).toHaveBeenCalledOnce();
      expect(row.querySelectorAll("[data-ghpsr-root]")).toHaveLength(1);
    } finally {
      observer.disconnect();
    }
  });
});
