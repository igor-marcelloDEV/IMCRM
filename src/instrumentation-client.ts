// Registers the PWA service worker for the internal dashboard app.
// Deliberately skipped on /loja/* (the public storefront, shared over
// WhatsApp/Instagram) and /entregadores/* (the driver portal) — this
// is app.manifest's `start_url`/`scope` are dashboard-only too, this
// keeps the "installable app" experience scoped to staff, not
// customers or drivers browsing a link.
if (
  typeof window !== "undefined" &&
  "serviceWorker" in navigator &&
  !window.location.pathname.startsWith("/loja") &&
  !window.location.pathname.startsWith("/entregadores")
) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.error("[pwa] service worker registration failed:", err);
    });
  });
}
