import type { ReviewState } from "../../github/api";
import type { ReviewerEntry } from "./view-model";
import { STATE_ICONS } from "./state-icons";
import { githubSelectors } from "../../github/selectors";

const ROOT_ATTRIBUTE = "data-ghpsr-root";
const STYLE_ATTRIBUTE = "data-ghpsr-style";
const RENDERED_ATTRIBUTE = "data-ghpsr-rendered";

type RingTone =
  | "requested"
  | "approved"
  | "changes-requested"
  | "commented"
  | "dismissed";
type BadgeIcon =
  | "approved"
  | "changes-requested"
  | "commented"
  | "dismissed"
  | "refresh";

type ReviewerDisplay = {
  ringTone: RingTone;
  badgeIcon: BadgeIcon | null;
};

type RenderReviewersOptions = {
  showStateBadge: boolean;
  showReviewerName: boolean;
};

export function ensureReviewerStyles(): void {
  if (document.head.querySelector(`[${STYLE_ATTRIBUTE}]`)) {
    return;
  }

  const style = document.createElement("style");
  style.setAttribute(STYLE_ATTRIBUTE, "true");
  style.textContent = `
    .ghpsr-root {
      display: inline-flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px 6px;
      margin-left: 8px;
      vertical-align: middle;
    }
    .ghpsr-section-label {
      color: var(--fgColor-muted, #656d76);
      font-size: 12px;
      font-weight: 600;
      margin-right: 2px;
    }
    .ghpsr-status {
      color: var(--fgColor-muted, #656d76);
      font-size: 12px;
    }

    .ghpsr-avatar {
      position: relative;
      display: inline-block;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      box-shadow: 0 0 0 2px var(--ghpsr-border-color, transparent);
      margin-right: 2px;
    }
    .ghpsr-avatar-img,
    .ghpsr-initials {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      display: block;
    }
    .ghpsr-initials {
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-size: 11px;
      font-weight: 600;
    }

    .ghpsr-avatar--border-requested         { --ghpsr-border-color: #0969da; }
    .ghpsr-avatar--border-approved          { --ghpsr-border-color: #2ea043; }
    .ghpsr-avatar--border-changes-requested { --ghpsr-border-color: #cf222e; }
    .ghpsr-avatar--border-commented         { --ghpsr-border-color: #6e7781; }
    .ghpsr-avatar--border-dismissed         { --ghpsr-border-color: #8250df; }

    .ghpsr-badge {
      position: absolute;
      bottom: -3px;
      right: -5px;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      border: 2px solid var(--bgColor-default, #fff);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
      background: var(--ghpsr-badge-color, #6e7781);
    }
    .ghpsr-badge svg { width: 10px; height: 10px; fill: currentColor; }
    .ghpsr-badge--approved          { --ghpsr-badge-color: #2ea043; }
    .ghpsr-badge--changes-requested { --ghpsr-badge-color: #cf222e; }
    .ghpsr-badge--commented         { --ghpsr-badge-color: #6e7781; }
    .ghpsr-badge--dismissed         { --ghpsr-badge-color: #8250df; }
    .ghpsr-badge--refresh           { --ghpsr-badge-color: #0969da; }

    .ghpsr-pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 8px 2px 3px;
      border-radius: 12px;
      font-size: 12px;
      line-height: 20px;
      text-decoration: none;
      background: var(--ghpsr-pill-bg);
      color: var(--ghpsr-pill-fg);
    }
    .ghpsr-pill:hover { filter: brightness(0.98); }
    .ghpsr-pill-name { font-weight: 500; }
    .ghpsr-avatar--small { width: 18px; height: 18px; }
    .ghpsr-avatar--small .ghpsr-avatar-img,
    .ghpsr-avatar--small .ghpsr-initials { width: 18px; height: 18px; }
    .ghpsr-badge--small {
      width: 12px;
      height: 12px;
      bottom: -2px;
      right: -3px;
    }
    .ghpsr-badge--small svg { width: 8px; height: 8px; }

    .ghpsr-pill--requested         { --ghpsr-pill-bg: var(--bgColor-accent-muted,  #ddf4ff); --ghpsr-pill-fg: var(--fgColor-accent,  #0969da); }
    .ghpsr-pill--approved          { --ghpsr-pill-bg: var(--bgColor-success-muted, #dafbe1); --ghpsr-pill-fg: var(--fgColor-success, #1a7f37); }
    .ghpsr-pill--changes-requested { --ghpsr-pill-bg: var(--bgColor-danger-muted,  #ffebe9); --ghpsr-pill-fg: var(--fgColor-danger,  #cf222e); }
    .ghpsr-pill--commented         { --ghpsr-pill-bg: var(--bgColor-neutral-muted, #eaeef2); --ghpsr-pill-fg: var(--fgColor-muted,    #57606a); }
    .ghpsr-pill--dismissed         { --ghpsr-pill-bg: var(--bgColor-done-muted,    #fbefff); --ghpsr-pill-fg: var(--fgColor-done,     #8250df); }

    .ghpsr-chip {
      display: inline-flex;
      align-items: center;
      min-height: 20px;
      border-radius: 999px;
      padding: 0 8px;
      font-size: 12px;
      line-height: 20px;
      text-decoration: none;
      border: 1px solid transparent;
    }
    .ghpsr-chip:hover { text-decoration: none; filter: brightness(0.98); }

    .ghpsr-avatar:focus-visible,
    .ghpsr-pill:focus-visible,
    .ghpsr-chip:focus-visible {
      outline: 2px solid var(--fgColor-accent, #0969da);
      outline-offset: 2px;
      border-radius: 999px;
    }

    .ghpsr-chip--team {
      color: var(--fgColor-attention, #9a6700);
      background: color-mix(in srgb, var(--bgColor-attention-muted, #fff8c5) 80%, white);
      border-color: color-mix(in srgb, var(--borderColor-attention-muted, #d4a72c) 55%, white);
    }
  `;

  document.head.append(style);
}

export function extractPullNumber(row: Element): string | null {
  const rowId = row.getAttribute("id");
  if (rowId) {
    const rowMatch = rowId.match(/issue_(\d+)/);
    if (rowMatch) {
      return rowMatch[1];
    }
  }

  const link = row.querySelector<HTMLAnchorElement>(githubSelectors.primaryLink);
  const href = link?.getAttribute("href");
  const match = href?.match(/\/pull\/(\d+)/);

  return match?.[1] ?? null;
}

export function ensureReviewerMount(row: Element): HTMLElement | null {
  const metaContainer =
    findFirst<HTMLElement>(row, githubSelectors.metaContainers) ??
    row.querySelector<HTMLElement>(githubSelectors.fallbackMetaContainer) ??
    createFallbackMetaContainer(row);
  if (metaContainer == null) return null;

  let inlineMetaRow = findFirst<HTMLElement>(
    metaContainer,
    githubSelectors.inlineMetaRowSelectors,
  );
  if (inlineMetaRow == null) {
    inlineMetaRow = document.createElement("span");
    inlineMetaRow.className = "d-none d-md-inline-flex";
    metaContainer.append(inlineMetaRow);
  }

  let mount = inlineMetaRow.querySelector<HTMLElement>(`[${ROOT_ATTRIBUTE}]`);
  if (mount == null) {
    mount = document.createElement("span");
    mount.className = "ghpsr-root";
    mount.setAttribute(ROOT_ATTRIBUTE, "true");
    inlineMetaRow.append(mount);
  }

  return mount;
}

function createFallbackMetaContainer(row: Element): HTMLElement | null {
  const link = row.querySelector<HTMLAnchorElement>(githubSelectors.primaryLink);
  if (link == null) return null;

  const container = document.createElement("span");
  container.className = "d-none d-md-inline-flex";
  container.setAttribute("data-ghpsr-fallback-meta", "true");
  link.insertAdjacentElement("afterend", container);
  return container;
}

export function renderLoading(mount: HTMLElement): void {
  const node = document.createElement("span");
  node.className = "ghpsr-status";
  node.textContent = "Loading reviewers...";
  mount.replaceChildren(node);
  mount.removeAttribute("title");
  clearRenderedReviewerState(mount);
}

export function mountHasRenderedChips(mount: HTMLElement): boolean {
  return mount.getAttribute(RENDERED_ATTRIBUTE) === "1";
}

export function clearRenderedReviewerState(mount: HTMLElement): void {
  mount.removeAttribute(RENDERED_ATTRIBUTE);
}

export function renderReviewers(
  mount: HTMLElement,
  entries: ReviewerEntry[],
  options: RenderReviewersOptions,
): void {
  if (entries.length === 0) {
    mount.replaceChildren();
    mount.removeAttribute("title");
    clearRenderedReviewerState(mount);
    return;
  }

  const label = document.createElement("span");
  label.className = "ghpsr-section-label";
  label.textContent = "Reviewers:";

  const nodes: Node[] = [label];
  for (const entry of entries) {
    if (entry.kind === "team") {
      nodes.push(createTeamNode(entry));
    } else {
      nodes.push(createUserNode(entry, options));
    }
  }
  mount.replaceChildren(...nodes);
  mount.removeAttribute("title");
  mount.setAttribute(RENDERED_ATTRIBUTE, "1");
}

function createTeamNode(entry: Extract<ReviewerEntry, { kind: "team" }>): HTMLElement {
  const link = document.createElement("a");
  link.className = "ghpsr-chip ghpsr-chip--team";
  link.href = entry.href;
  link.textContent = `Team: ${entry.slug}`;
  return link;
}

function createUserNode(
  entry: Extract<ReviewerEntry, { kind: "user" }>,
  options: RenderReviewersOptions,
): HTMLElement {
  const display = resolveDisplay(entry);
  const stateLabel = resolveStateLabel(entry);
  const titleText = `@${entry.login} · ${stateLabel}`;
  const ariaText = `@${entry.login}, ${stateLabel}`;

  if (options.showReviewerName) {
    const pill = document.createElement("a");
    pill.className = `ghpsr-pill ghpsr-pill--${display.ringTone}`;
    pill.href = entry.href;
    pill.title = titleText;
    pill.setAttribute("aria-label", ariaText);

    const avatarWrap = document.createElement("span");
    avatarWrap.className = `ghpsr-avatar ghpsr-avatar--small ghpsr-avatar--border-${display.ringTone}`;
    attachAvatarImage(avatarWrap, entry, 18);
    if (options.showStateBadge && display.badgeIcon != null) {
      avatarWrap.append(createBadgeNode(display.badgeIcon, true));
    }

    const name = document.createElement("span");
    name.className = "ghpsr-pill-name";
    name.textContent = `@${entry.login}`;

    pill.append(avatarWrap, name);
    return pill;
  }

  const link = document.createElement("a");
  link.className = `ghpsr-avatar ghpsr-avatar--border-${display.ringTone}`;
  link.href = entry.href;
  link.title = titleText;
  link.setAttribute("aria-label", ariaText);
  attachAvatarImage(link, entry, 24);
  if (options.showStateBadge && display.badgeIcon != null) {
    link.append(createBadgeNode(display.badgeIcon, false));
  }
  return link;
}

function attachAvatarImage(
  container: HTMLElement,
  entry: Extract<ReviewerEntry, { kind: "user" }>,
  size: 18 | 24,
): void {
  const img = document.createElement("img");
  img.className = "ghpsr-avatar-img";
  img.alt = "";
  img.setAttribute("loading", "lazy");
  img.setAttribute("width", String(size));
  img.setAttribute("height", String(size));
  img.src = entry.avatarUrl ?? `https://github.com/${entry.login}.png?size=48`;
  img.addEventListener("error", () => {
    const initials = document.createElement("span");
    initials.className = "ghpsr-initials";
    initials.textContent = (entry.login[0] ?? "?").toUpperCase();
    initials.style.background = initialsBackground(entry.login);
    img.replaceWith(initials);
  });
  container.append(img);
}

function createBadgeNode(icon: BadgeIcon, small: boolean): HTMLElement {
  const badge = document.createElement("span");
  badge.className = small
    ? `ghpsr-badge ghpsr-badge--small ghpsr-badge--${icon}`
    : `ghpsr-badge ghpsr-badge--${icon}`;
  badge.setAttribute("aria-hidden", "true");
  badge.innerHTML = selectIconMarkup(icon);
  return badge;
}

function selectIconMarkup(icon: BadgeIcon): string {
  if (icon === "approved") return STATE_ICONS.approved;
  if (icon === "changes-requested") return STATE_ICONS.changesRequested;
  if (icon === "commented") return STATE_ICONS.commented;
  if (icon === "dismissed") return STATE_ICONS.dismissed;
  return STATE_ICONS.refresh;
}

function resolveDisplay(
  entry: Extract<ReviewerEntry, { kind: "user" }>,
): ReviewerDisplay {
  if (entry.isRequested) {
    const hasEvidence =
      entry.state === "APPROVED" ||
      entry.state === "CHANGES_REQUESTED" ||
      entry.state === "DISMISSED";
    return {
      ringTone: "requested",
      badgeIcon: hasEvidence ? "refresh" : null,
    };
  }
  switch (entry.state) {
    case "APPROVED":
      return { ringTone: "approved", badgeIcon: "approved" };
    case "CHANGES_REQUESTED":
      return { ringTone: "changes-requested", badgeIcon: "changes-requested" };
    case "COMMENTED":
      return { ringTone: "commented", badgeIcon: "commented" };
    case "DISMISSED":
      return { ringTone: "dismissed", badgeIcon: "dismissed" };
    default:
      // (false, null) is excluded by the view-model, but stay defensive.
      return { ringTone: "requested", badgeIcon: null };
  }
}

function resolveStateLabel(
  entry: Extract<ReviewerEntry, { kind: "user" }>,
): string {
  const base = stateLabelBase(entry.state);
  if (entry.state != null && entry.isRequested) {
    return `${base} (still requested)`;
  }
  return base;
}

function stateLabelBase(state: ReviewState | null): string {
  if (state === "APPROVED") return "approved";
  if (state === "CHANGES_REQUESTED") return "changes requested";
  if (state === "COMMENTED") return "commented";
  if (state === "DISMISSED") return "dismissed";
  return "requested";
}

function initialsBackground(login: string): string {
  let hash = 0;
  for (let index = 0; index < login.length; index += 1) {
    hash = (hash * 31 + login.charCodeAt(index)) >>> 0;
  }
  return `hsl(${hash % 360}, 40%, 55%)`;
}

function findFirst<T extends Element>(root: ParentNode, selectors: readonly string[]): T | null {
  for (const selector of selectors) {
    const match = root.querySelector<T>(selector);
    if (match) {
      return match;
    }
  }

  return null;
}
