import type { MetadataRoute } from "next";

// Installable-app manifest for the internal dashboard. The service
// worker that makes this actually installable (instrumentation-client.ts)
// deliberately skips registering on /loja/* — the storefront is a
// customer-facing page shared over WhatsApp/Instagram, not something
// staff install as an app — so this manifest's `start_url`/`scope`
// only make sense for the dashboard even though Next only supports one
// manifest file for the whole app.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "IM CRM",
    short_name: "IM CRM",
    description:
      "Organize atendimentos, clientes, vendas, pagamentos, pedidos e entregas em um só lugar.",
    start_url: "/today",
    scope: "/",
    display: "standalone",
    background_color: "#020617",
    theme_color: "#7c3aed",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
