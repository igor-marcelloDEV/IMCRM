// Registers the PWA service worker for the internal dashboard AND the
// driver portal (/entregadores) — drivers are out on the street on a
// phone browser, installability/offline-boot matters at least as much
// for them as for office staff. Each gets its own manifest identity
// (see entregadores/layout.tsx), so installing from either surface
// opens straight back into that surface, not the other one.
// Deliberately still skipped on /loja/* — the public storefront is a
// one-off link shared over WhatsApp/Instagram; a customer browsing it
// shouldn't get an "install this app" prompt.
if (
  typeof window !== "undefined" &&
  "serviceWorker" in navigator &&
  !window.location.pathname.startsWith("/loja")
) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.error("[pwa] service worker registration failed:", err);
    });
  });
}
