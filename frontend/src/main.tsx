import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App, { DemoApp } from "./App.tsx";
import "./index.css";
import { initAnalytics } from "./analytics";

void initAnalytics();

// The marketing demo lives at /demo (served by the backend) and also responds to
// ?demo / #demo, so it loads from any host even without the SPA fallback route.
function isDemoRoute(): boolean {
  const path = window.location.pathname.replace(/\/+$/, "");
  if (path === "/demo") return true;
  if (/(?:^|[?&])demo(?:=|&|$)/.test(window.location.search)) return true;
  return window.location.hash.replace(/^#\/?/, "") === "demo";
}

const Root = isDemoRoute() ? DemoApp : App;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
