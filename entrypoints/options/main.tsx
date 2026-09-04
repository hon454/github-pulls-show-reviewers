import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { getLocaleStore } from "../../src/i18n/browser";
import { OptionsPage } from "./options-page";
import "./options.css";

const localeStore = getLocaleStore();
// Hydrate before the first render; translated keys are never used as HTML defaults.
void localeStore.ready().then(() => {
  const root = createRoot(document.getElementById("root")!);
  root.render(
    <StrictMode>
      <OptionsPage localeStore={localeStore} />
    </StrictMode>,
  );
  window.addEventListener("pagehide", (event) => {
    if (!event.persisted) {
      root.unmount();
      localeStore.dispose();
    }
  });
});
