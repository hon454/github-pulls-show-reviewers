import type { ReviewerSection } from "./view-model";
import { githubSelectors } from "../../github/selectors";

const ROOT_ATTRIBUTE = "data-ghpsr-root";
const STYLE_ATTRIBUTE = "data-ghpsr-style";

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
      gap: 6px 8px;
      margin-left: 8px;
      vertical-align: middle;
    }
    .ghpsr-section {
      display: inline-flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
    }
    .ghpsr-section-label {
      color: var(--fgColor-muted, #656d76);
      font-size: 12px;
      font-weight: 600;
    }
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
    .ghpsr-chip:hover {
      text-decoration: none;
      filter: brightness(0.98);
    }
    .ghpsr-chip--requested {
      color: var(--fgColor-accent, #0969da);
      background: color-mix(in srgb, var(--bgColor-accent-muted, #ddf4ff) 80%, white);
      border-color: color-mix(in srgb, var(--borderColor-accent-muted, #54aeff) 55%, white);
    }
    .ghpsr-chip--team {
      color: var(--fgColor-attention, #9a6700);
      background: color-mix(in srgb, var(--bgColor-attention-muted, #fff8c5) 80%, white);
      border-color: color-mix(in srgb, var(--borderColor-attention-muted, #d4a72c) 55%, white);
    }
    .ghpsr-chip--reviewed {
      color: var(--fgColor-success, #1a7f37);
      background: color-mix(in srgb, var(--bgColor-success-muted, #dafbe1) 80%, white);
      border-color: color-mix(in srgb, var(--borderColor-success-muted, #4ac26b) 55%, white);
    }
    .ghpsr-chip--approved {
      color: var(--fgColor-success, #1a7f37);
      background: color-mix(in srgb, var(--bgColor-success-muted, #dafbe1) 80%, white);
      border-color: color-mix(in srgb, var(--borderColor-success-muted, #4ac26b) 55%, white);
    }
    .ghpsr-chip--changes-requested {
      color: var(--fgColor-danger, #cf222e);
      background: color-mix(in srgb, var(--bgColor-danger-muted, #ffebe9) 82%, white);
      border-color: color-mix(in srgb, var(--borderColor-danger-muted, #ff818266) 55%, white);
    }
    .ghpsr-chip--commented {
      color: var(--fgColor-muted, #57606a);
      background: color-mix(in srgb, var(--bgColor-muted, #f6f8fa) 88%, white);
      border-color: color-mix(in srgb, var(--borderColor-muted, #d0d7de) 80%, white);
    }
    .ghpsr-chip--dismissed {
      color: var(--fgColor-done, #8250df);
      background: color-mix(in srgb, var(--bgColor-done-muted, #fbefff) 82%, white);
      border-color: color-mix(in srgb, var(--borderColor-done-muted, #c297ff) 55%, white);
    }
    .ghpsr-status {
      color: var(--fgColor-muted, #656d76);
      font-size: 12px;
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
  const metaContainer = findFirst<HTMLElement>(row, githubSelectors.metaContainers);
  if (metaContainer == null) {
    return null;
  }

  let inlineMetaRow = findFirst<HTMLElement>(metaContainer, githubSelectors.inlineMetaRowSelectors);
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

export function renderLoading(mount: HTMLElement): void {
  const node = document.createElement("span");
  node.className = "ghpsr-status";
  node.textContent = "Loading reviewers...";
  mount.replaceChildren(node);
  mount.removeAttribute("title");
}

export function renderReviewerSections(
  mount: HTMLElement,
  sections: ReviewerSection[],
): void {
  mount.replaceChildren(...sections.map(createSectionNode));
  mount.removeAttribute("title");
}

function createSectionNode(section: ReviewerSection): HTMLElement {
  const sectionNode = document.createElement("span");
  sectionNode.className = "ghpsr-section";

  const labelNode = document.createElement("span");
  labelNode.className = "ghpsr-section-label";
  labelNode.textContent = `${section.label}:`;
  sectionNode.append(labelNode);

  if (section.chips.length === 0) {
    const emptyNode = document.createElement("span");
    emptyNode.className = "ghpsr-status";
    emptyNode.textContent = section.emptyLabel;
    sectionNode.append(emptyNode);
    return sectionNode;
  }

  section.chips.forEach((chip) => {
    const link = document.createElement("a");
    link.className = `ghpsr-chip ghpsr-chip--${chip.tone}`;
    link.href = chip.href;
    link.textContent = chip.label;
    if (chip.title) {
      link.title = chip.title;
    }
    sectionNode.append(link);
  });

  return sectionNode;
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
