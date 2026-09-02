import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { OptionsPage } from "./options-page";
import "./options.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <OptionsPage />
  </StrictMode>,
);
