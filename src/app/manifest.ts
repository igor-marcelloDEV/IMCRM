import type { MetadataRoute } from "next";

// Installable-app manifest for the internal dashboard. Next only
// supports one root-level manifest.ts for the whole app (unlike
// icon.tsx, which can nest per segment) — the driver portal
// (/entregadores) gets its own separate manifest + start_url via
// entregadores/layout.tsx overriding this one for that segment, so
// installing from either surface opens back into that surface. The
// public storefront (/loja/*) is excluded from installability
// entirely (instrumentation-client.ts) — it's a one-off link shared
// over WhatsApp/Instagram, not something a customer installs as an app.
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
