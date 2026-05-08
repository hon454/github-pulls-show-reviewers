import type { BannerKind, BannerState } from "./aggregator";
import { formatBannerMessage } from "./aggregator";

const BANNER_ATTRIBUTE = "data-ghpsr-banner";
const BANNER_STYLE_ATTRIBUTE = "data-ghpsr-banner-style";

function ensureBannerStyles(): void {
  if (document.head.querySelector(`[${BANNER_STYLE_ATTRIBUTE}]`)) {
    return;
  }
  const style = document.createElement("style");
  style.setAttribute(BANNER_STYLE_ATTRIBUTE, "true");
  style.textContent = `
    .ghpsr-banner-cta:focus-visible,
    .ghpsr-banner-dismiss:focus-visible {
      outline: 2px solid var(--fgColor-accent, #0969da);
      outline-offset: 2px;
      border-radius: 4px;
    }
  `;
  document.head.append(style);
}

export type BannerMount = {
  update(state: BannerState): void;
  teardown(): void;
};

type CtaSpec =
  | { kind: "link"; label: string; href: string }
  | { kind: "none" };

function ctaFor(
  current: BannerKind,
  installUrl: string,
  optionsPageUrl: string,
): CtaSpec {
  switch (current) {
    case "app-uncovered":
      return { kind: "link", label: "Configure access", href: installUrl };
    case "auth-expired":
    case "unauth-rate-limit":
    case "signin-required":
      return { kind: "link", label: "Sign in", href: optionsPageUrl };
    case "auth-rate-limit":
      return { kind: "none" };
  }
}

export function mountBanner(input: {
  insertAfter: HTMLElement;
  installUrl: string;
  optionsPageUrl: string;
  onDismiss: () => void;
}): BannerMount {
  let element: HTMLElement | null = null;

  function render(state: BannerState): void {
    const current = state.current;
    if (state.dismissed || current == null) {
      element?.remove();
      element = null;
      return;
    }

    ensureBannerStyles();

    if (element == null) {
      element = document.createElement("div");
      element.setAttribute(BANNER_ATTRIBUTE, "true");
      element.style.cssText = [
        "margin: 12px 0",
        "padding: 12px 16px",
        "border-radius: 6px",
        "background: #ddf4ff",
        "color: #0969da",
        "display: flex",
        "gap: 12px",
        "align-items: center",
        "font-size: 13px",
      ].join(";");
      input.insertAfter.insertAdjacentElement("afterend", element);
    }

    element.innerHTML = "";

    const message = document.createElement("span");
    message.textContent = formatBannerMessage(state);
    element.append(message);

    const cta = ctaFor(current, input.installUrl, input.optionsPageUrl);
    if (cta.kind === "link") {
      const link = document.createElement("a");
      link.href = cta.href;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = cta.label;
      link.className = "ghpsr-banner-cta";
      element.append(link);
    }

    const dismissBtn = document.createElement("button");
    dismissBtn.type = "button";
    dismissBtn.textContent = "Dismiss";
    dismissBtn.className = "ghpsr-banner-dismiss";
    dismissBtn.addEventListener("click", () => input.onDismiss());
    element.append(dismissBtn);
  }

  return {
    update: render,
    teardown() {
      element?.remove();
      element = null;
    },
  };
}
