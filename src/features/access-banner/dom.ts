import type { BannerState } from "./aggregator";
import { formatBannerMessage } from "./aggregator";

const BANNER_ATTRIBUTE = "data-ghpsr-banner";

export type BannerMount = {
  update(state: BannerState): void;
  teardown(): void;
};

export function mountBanner(input: {
  insertAfter: HTMLElement;
  installUrl: string;
  optionsPageUrl: string;
  onDismiss: () => void;
}): BannerMount {
  let element: HTMLElement | null = null;

  function render(state: BannerState): void {
    const visible =
      !state.dismissed &&
      (state.uncoveredOrgs.length > 0 || state.unauthRateLimited);

    if (!visible) {
      element?.remove();
      element = null;
      return;
    }

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

    if (state.uncoveredOrgs.length > 0) {
      const installLink = document.createElement("a");
      installLink.href = input.installUrl;
      installLink.target = "_blank";
      installLink.rel = "noreferrer";
      installLink.textContent =
        state.uncoveredOrgs.length === 1 ? "Install" : "Manage access";
      element.append(installLink);
    } else if (state.unauthRateLimited) {
      const signInLink = document.createElement("a");
      signInLink.href = input.optionsPageUrl;
      signInLink.target = "_blank";
      signInLink.rel = "noreferrer";
      signInLink.textContent = "Sign in";
      element.append(signInLink);
    }

    const dismissBtn = document.createElement("button");
    dismissBtn.type = "button";
    dismissBtn.textContent = "Dismiss";
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
