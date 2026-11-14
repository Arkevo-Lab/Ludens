import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Import RootLayout first so globals.css (@layer theme/base/components/utilities) precedes component CSS.
import RootLayout from "./layout";
import Dashboard from "./dashboard";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Missing #root mount element");
}

createRoot(rootElement).render(
  <StrictMode>
    <RootLayout>
      <Dashboard />
    </RootLayout>
  </StrictMode>,
);
