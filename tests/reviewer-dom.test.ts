// @vitest-environment jsdom

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it } from "vitest";

import {
  ensureReviewerMount,
  ensureReviewerStyles,
  extractPullNumber,
  renderReviewers,
} from "../src/features/reviewers/dom";
import { buildReviewers } from "../src/features/reviewers/view-model";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(currentDir, "fixtures");

async function loadFixture(name: string): Promise<void> {
  document.body.innerHTML = await readFile(
    path.join(fixturesDir, name),
    "utf8",
  );
}

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

describe("renderReviewers", () => {
  const route = { owner: "hon454", repo: "github-pulls-show-reviewers" };

  function mount(): HTMLElement {
    const row = document.querySelector(".js-issue-row")!;
    return ensureReviewerMount(row)!;
  }

  it("renders a single 'Reviewers:' label followed by entries", () => {
    const entries = buildReviewers(route, {
      status: "ok",
      requestedUsers: [{ login: "alice", avatarUrl: null }],
      requestedTeams: ["platform"],
      completedReviews: [
        { login: "bob", avatarUrl: null, state: "APPROVED" },
      ],
    });

    renderReviewers(mount(), entries, {
      showStateBadge: true,
      showReviewerName: false,
    });

    const labels = document.querySelectorAll(".ghpsr-section-label");
    expect(labels).toHaveLength(1);
    expect(labels[0].textContent).toBe("Reviewers:");
  });

  it("renders the avatar-only shape when showReviewerName is false", () => {
    const entries = buildReviewers(route, {
      status: "ok",
      requestedUsers: [{ login: "alice", avatarUrl: "https://example/a.png" }],
      requestedTeams: [],
      completedReviews: [],
    });

    renderReviewers(mount(), entries, {
      showStateBadge: true,
      showReviewerName: false,
    });

    const avatar = document.querySelector<HTMLAnchorElement>("a.ghpsr-avatar");
    expect(avatar).not.toBeNull();
    expect(avatar?.classList.contains("ghpsr-avatar--border-requested")).toBe(
      true,
    );
    expect(avatar?.querySelector("img.ghpsr-avatar-img")?.getAttribute("src")).toBe(
      "https://example/a.png",
    );
    expect(avatar?.querySelector("img.ghpsr-avatar-img")?.getAttribute("loading")).toBe(
      "lazy",
    );
    expect(avatar?.querySelector("img.ghpsr-avatar-img")?.getAttribute("width")).toBe(
      "24",
    );
    expect(document.querySelector(".ghpsr-pill")).toBeNull();
  });

  it("renders the pill shape with @login text when showReviewerName is true", () => {
    const entries = buildReviewers(route, {
      status: "ok",
      requestedUsers: [{ login: "alice", avatarUrl: "https://example/a.png" }],
      requestedTeams: [],
      completedReviews: [],
    });

    renderReviewers(mount(), entries, {
      showStateBadge: true,
      showReviewerName: true,
    });

    const pill = document.querySelector<HTMLAnchorElement>("a.ghpsr-pill");
    expect(pill).not.toBeNull();
    expect(pill?.classList.contains("ghpsr-pill--requested")).toBe(true);
    expect(pill?.querySelector(".ghpsr-pill-name")?.textContent).toBe("@alice");
  });

  it("omits the badge when showStateBadge is false even if state is set", () => {
    const entries = buildReviewers(route, {
      status: "ok",
      requestedUsers: [],
      requestedTeams: [],
      completedReviews: [
        { login: "bob", avatarUrl: null, state: "APPROVED" },
      ],
    });

    renderReviewers(mount(), entries, {
      showStateBadge: false,
      showReviewerName: false,
    });

    expect(document.querySelector(".ghpsr-badge")).toBeNull();
  });

  it("omits the badge when state is null even if showStateBadge is true", () => {
    const entries = buildReviewers(route, {
      status: "ok",
      requestedUsers: [{ login: "alice", avatarUrl: null }],
      requestedTeams: [],
      completedReviews: [],
    });

    renderReviewers(mount(), entries, {
      showStateBadge: true,
      showReviewerName: false,
    });

    expect(document.querySelector(".ghpsr-badge")).toBeNull();
  });

  it("renders state-specific badge classes when enabled and state is non-null", () => {
    const entries = buildReviewers(route, {
      status: "ok",
      requestedUsers: [],
      requestedTeams: [],
      completedReviews: [
        { login: "bob", avatarUrl: null, state: "CHANGES_REQUESTED" },
      ],
    });

    renderReviewers(mount(), entries, {
      showStateBadge: true,
      showReviewerName: false,
    });

    expect(
      document.querySelector(".ghpsr-badge--changes-requested"),
    ).not.toBeNull();
  });

  it("appends '(still requested)' to the title when the reviewer is still in requested_reviewers", () => {
    const entries = buildReviewers(route, {
      status: "ok",
      requestedUsers: [{ login: "alice", avatarUrl: null }],
      requestedTeams: [],
      completedReviews: [
        { login: "alice", avatarUrl: null, state: "COMMENTED" },
      ],
    });

    renderReviewers(mount(), entries, {
      showStateBadge: true,
      showReviewerName: false,
    });

    const avatar = document.querySelector<HTMLAnchorElement>("a.ghpsr-avatar");
    expect(avatar?.title).toBe("@alice · commented (still requested)");
  });

  it("renders teams as the existing text chip shape", () => {
    const entries = buildReviewers(route, {
      status: "ok",
      requestedUsers: [],
      requestedTeams: ["platform"],
      completedReviews: [],
    });

    renderReviewers(mount(), entries, {
      showStateBadge: true,
      showReviewerName: false,
    });

    const chip = document.querySelector<HTMLAnchorElement>(
      ".ghpsr-chip.ghpsr-chip--team",
    );
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe("Team: platform");
  });

  it("swaps the img for an initials span when the avatar image fails to load", () => {
    const entries = buildReviewers(route, {
      status: "ok",
      requestedUsers: [{ login: "alice", avatarUrl: null }],
      requestedTeams: [],
      completedReviews: [],
    });

    renderReviewers(mount(), entries, {
      showStateBadge: true,
      showReviewerName: false,
    });

    const img = document.querySelector<HTMLImageElement>(".ghpsr-avatar-img")!;
    img.dispatchEvent(new Event("error"));

    expect(document.querySelector(".ghpsr-avatar-img")).toBeNull();
    const initials = document.querySelector(".ghpsr-initials")!;
    expect(initials.textContent).toBe("A");
  });

  it("clears the mount when entries is empty", () => {
    renderReviewers(mount(), [], {
      showStateBadge: true,
      showReviewerName: false,
    });

    const mountEl = document.querySelector('[data-ghpsr-root="true"]')!;
    expect(mountEl.textContent).toBe("");
    expect(mountEl.childElementCount).toBe(0);
  });

  it("extracts the pull number from the primary link when the row id is missing", async () => {
    await loadFixture("github-pulls-link-only.html");
    const row = document.querySelector(".js-issue-row");
    expect(extractPullNumber(row!)).toBe("77");
  });

  it("finds CSS-module metadata rows by stable class prefix", async () => {
    await loadFixture("github-pulls-list-item-metadata.html");
    const row = document.querySelector(".js-issue-row");
    const mountNode = ensureReviewerMount(row!);
    expect(mountNode).not.toBeNull();
  });

  it("creates an inline metadata row when GitHub omits the desktop wrapper span", async () => {
    await loadFixture("github-pulls-missing-inline-meta.html");
    const row = document.querySelector(".js-issue-row");
    expect(ensureReviewerMount(row!)).not.toBeNull();
    expect(row?.querySelector(".d-none.d-md-inline-flex")).not.toBeNull();
  });

  it("declares :focus-visible styles for reviewer pills and team chips", () => {
    ensureReviewerStyles();
    const styleEl = document.querySelector("[data-ghpsr-style]");
    const css = styleEl?.textContent ?? "";
    expect(css).toContain(".ghpsr-pill:focus-visible");
    expect(css).toContain(".ghpsr-chip:focus-visible");
    expect(css).toContain("outline:");
  });
});

describe("renderReviewers — (isRequested, state) display truth table", () => {
  const route = { owner: "hon454", repo: "github-pulls-show-reviewers" };

  function mount(): HTMLElement {
    const row = document.querySelector(".js-issue-row")!;
    return ensureReviewerMount(row)!;
  }

  function renderOne(opts: {
    login: string;
    isRequested: boolean;
    state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | null;
  }): void {
    renderReviewers(
      mount(),
      buildReviewers(route, {
        status: "ok",
        requestedUsers: opts.isRequested
          ? [{ login: opts.login, avatarUrl: null }]
          : [],
        requestedTeams: [],
        completedReviews:
          opts.state == null
            ? []
            : [{ login: opts.login, avatarUrl: null, state: opts.state }],
      }),
      { showStateBadge: true, showReviewerName: false },
    );
  }

  it("case 1 — (true, null): blue ring, no badge", () => {
    renderOne({ login: "u1", isRequested: true, state: null });
    const avatar = document.querySelector<HTMLAnchorElement>("a.ghpsr-avatar")!;
    expect(avatar.classList.contains("ghpsr-avatar--border-requested")).toBe(true);
    expect(avatar.querySelector(".ghpsr-badge")).toBeNull();
  });

  it("case 2 — (true, APPROVED): blue ring, refresh badge", () => {
    renderOne({ login: "u2", isRequested: true, state: "APPROVED" });
    const avatar = document.querySelector<HTMLAnchorElement>("a.ghpsr-avatar")!;
    expect(avatar.classList.contains("ghpsr-avatar--border-requested")).toBe(true);
    expect(avatar.querySelector(".ghpsr-badge--refresh")).not.toBeNull();
  });

  it("case 3 — (true, CHANGES_REQUESTED): blue ring, refresh badge", () => {
    renderOne({ login: "u3", isRequested: true, state: "CHANGES_REQUESTED" });
    const avatar = document.querySelector<HTMLAnchorElement>("a.ghpsr-avatar")!;
    expect(avatar.classList.contains("ghpsr-avatar--border-requested")).toBe(true);
    expect(avatar.querySelector(".ghpsr-badge--refresh")).not.toBeNull();
  });

  it("case 4 — (true, COMMENTED): blue ring, no badge (4b exception)", () => {
    renderOne({ login: "u4", isRequested: true, state: "COMMENTED" });
    const avatar = document.querySelector<HTMLAnchorElement>("a.ghpsr-avatar")!;
    expect(avatar.classList.contains("ghpsr-avatar--border-requested")).toBe(true);
    expect(avatar.querySelector(".ghpsr-badge")).toBeNull();
  });

  it("case 5 — (true, DISMISSED): blue ring, refresh badge", () => {
    renderOne({ login: "u5", isRequested: true, state: "DISMISSED" });
    const avatar = document.querySelector<HTMLAnchorElement>("a.ghpsr-avatar")!;
    expect(avatar.classList.contains("ghpsr-avatar--border-requested")).toBe(true);
    expect(avatar.querySelector(".ghpsr-badge--refresh")).not.toBeNull();
  });

  it("case 6 — (false, APPROVED): green ring, approved badge", () => {
    renderOne({ login: "u6", isRequested: false, state: "APPROVED" });
    const avatar = document.querySelector<HTMLAnchorElement>("a.ghpsr-avatar")!;
    expect(avatar.classList.contains("ghpsr-avatar--border-approved")).toBe(true);
    expect(avatar.querySelector(".ghpsr-badge--approved")).not.toBeNull();
  });

  it("case 7 — (false, CHANGES_REQUESTED): red ring, changes-requested badge", () => {
    renderOne({ login: "u7", isRequested: false, state: "CHANGES_REQUESTED" });
    const avatar = document.querySelector<HTMLAnchorElement>("a.ghpsr-avatar")!;
    expect(avatar.classList.contains("ghpsr-avatar--border-changes-requested")).toBe(true);
    expect(avatar.querySelector(".ghpsr-badge--changes-requested")).not.toBeNull();
  });

  it("case 8 — (false, COMMENTED): gray ring, commented badge", () => {
    renderOne({ login: "u8", isRequested: false, state: "COMMENTED" });
    const avatar = document.querySelector<HTMLAnchorElement>("a.ghpsr-avatar")!;
    expect(avatar.classList.contains("ghpsr-avatar--border-commented")).toBe(true);
    expect(avatar.querySelector(".ghpsr-badge--commented")).not.toBeNull();
  });

  it("case 9 — (false, DISMISSED): purple ring, dismissed badge", () => {
    renderOne({ login: "u9", isRequested: false, state: "DISMISSED" });
    const avatar = document.querySelector<HTMLAnchorElement>("a.ghpsr-avatar")!;
    expect(avatar.classList.contains("ghpsr-avatar--border-dismissed")).toBe(true);
    expect(avatar.querySelector(".ghpsr-badge--dismissed")).not.toBeNull();
  });

  it("refresh badge is still gated by showStateBadge", () => {
    renderReviewers(
      mount(),
      buildReviewers(route, {
        status: "ok",
        requestedUsers: [{ login: "u2", avatarUrl: null }],
        requestedTeams: [],
        completedReviews: [{ login: "u2", avatarUrl: null, state: "APPROVED" }],
      }),
      { showStateBadge: false, showReviewerName: false },
    );
    expect(document.querySelector(".ghpsr-badge")).toBeNull();
  });
});
