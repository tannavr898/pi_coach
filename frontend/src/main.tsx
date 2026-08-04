import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App, { DemoApp, AdminApp, TourPreview } from "./App.tsx";
import "./index.css";
import { initAnalytics } from "./analytics";
import { AuthProvider } from "./auth";

// The onboarding tour, viewable without signing up. Analytics is deliberately
// NEVER initialised on this route: reviewing the tour must not fire tour_step
// events or otherwise skew the real onboarding funnel.
function isTourRoute(): boolean {
  const path = window.location.pathname.replace(/\/+$/, "");
  if (path === "/tour") return true;
  if (/(?:^|[?&])tour(?:=|&|$)/.test(window.location.search)) return true;
  return window.location.hash.replace(/^#\/?/, "") === "tour";
}

if (!isTourRoute()) void initAnalytics();

// The marketing demo lives at /demo (served by the backend) and also responds to
// ?demo / #demo, so it loads from any host even without the SPA fallback route.
function isDemoRoute(): boolean {
  const path = window.location.pathname.replace(/\/+$/, "");
  if (path === "/demo") return true;
  if (/(?:^|[?&])demo(?:=|&|$)/.test(window.location.search)) return true;
  return window.location.hash.replace(/^#\/?/, "") === "demo";
}

function isAdminRoute(): boolean {
  const path = window.location.pathname.replace(/\/+$/, "");
  if (path === "/admin") return true;
  return window.location.hash.replace(/^#\/?/, "") === "admin";
}

const Root = isTourRoute() ? TourPreview : isAdminRoute() ? AdminApp : isDemoRoute() ? DemoApp : App;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <Root />
    </AuthProvider>
  </StrictMode>,
);
