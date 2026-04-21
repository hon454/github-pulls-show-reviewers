// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchPullReviewerSummaryMock = vi.fn();
const resolveAccountForRepoMock = vi.fn();
const markAccountInvalidatedMock = vi.fn();

vi.mock("../src/github/api", () => ({
  fetchPullReviewerSummary: fetchPullReviewerSummaryMock,
}));

vi.mock("../src/storage/accounts", () => ({
  resolveAccountForRepo: resolveAccountForRepoMock,
  markAccountInvalidated: markAccountInvalidatedMock,
}));

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.resetModules();
  fetchPullReviewerSummaryMock.mockReset();
  resolveAccountForRepoMock.mockReset();
  markAccountInvalidatedMock.mockReset();

  vi.stubGlobal("browser", {
    storage: {
      onChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
  });

  document.head.innerHTML = "";
  document.body.innerHTML = `
    <div class="js-issue-row" id="issue_42">
      <a class="Link--primary" href="/cinev/shotloom/pull/42">PR #42</a>
      <div class="d-flex mt-1 text-small color-fg-muted"></div>
    </div>
  `;
  window.history.replaceState(
    {},
    "",
    "/cinev/shotloom/pulls",
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bootReviewerListPage", () => {
  it("invalidates the matched account when GitHub rejects it with 401", async () => {
    resolveAccountForRepoMock.mockResolvedValue({
      id: "acc-1",
      login: "hon454",
      token: "ghu_abc",
    });
    fetchPullReviewerSummaryMock.mockRejectedValue({ status: 401 });

    const { bootReviewerListPage } = await import("../src/features/reviewers");
    bootReviewerListPage({
      addEventListener: vi.fn(),
      setInterval: vi.fn(),
      onInvalidated: vi.fn(),
    } as never);

    await flushMicrotasks();
    await flushMicrotasks();

    expect(markAccountInvalidatedMock).toHaveBeenCalledWith("acc-1", "revoked");
  });
});
