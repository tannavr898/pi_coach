import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App, { DemoApp, AdminApp, TourPreview } from "./App.tsx";
import { PrivacyApp, TermsApp } from "./legal";
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

// The legal pages. These must stay reachable at a stable, guessable path on the
// bare domain: Google's OAuth brand verification checks that the privacy-policy
// and terms URLs on the consent screen actually resolve (DEPLOY.md §6b), and it
// follows the literal URL rather than anything the SPA does client-side.
function legalRoute(): "privacy" | "terms" | null {
  const path = window.location.pathname.replace(/\/+$/, "");
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (path === "/privacy" || hash === "privacy") return "privacy";
  if (path === "/terms" || hash === "terms") return "terms";
  return null;
}

const legal = legalRoute();

const Root = legal === "privacy"
  ? PrivacyApp
  : legal === "terms"
    ? TermsApp
    : isTourRoute()
      ? TourPreview
      : isAdminRoute()
        ? AdminApp
        : isDemoRoute()
          ? DemoApp
          : App;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <Root />
    </AuthProvider>
  </StrictMode>,
);
