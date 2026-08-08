import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

if (typeof window !== "undefined" && window.deskApp?.isApp) {
  document.body.classList.add("desk-app");
  // Desktop must never use the PWA service worker — it caches old CSS/JS
  // and hides layout fixes (e.g. missing composer).
  if ("serviceWorker" in navigator) {
    void navigator.serviceWorker.getRegistrations().then((regs) => {
      for (const r of regs) void r.unregister();
    });
    try {
      caches.keys().then((keys) => {
        for (const k of keys) void caches.delete(k);
      });
    } catch {
      /* */
    }
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
