import { NextResponse } from "next/server";

// Next's `manifest.ts` file convention only supports ONE manifest for
// the whole app (root-level only, unlike icon.tsx which can nest at
// any segment) — so the driver portal's own installable-app identity
// (own name, own start_url so the home-screen icon opens straight into
// /entregadores instead of the staff dashboard) is hand-rolled here
// and wired in via `metadata.manifest` on entregadores/layout.tsx,
// which overrides the root manifest link for just that segment.
export async function GET() {
  return NextResponse.json({
    name: "IM CRM Entregador",
    short_name: "Entregador",
    description: "Corridas disponíveis e suas entregas em andamento.",
    start_url: "/entregadores",
    scope: "/entregadores",
    display: "standalone",
    background_color: "#070b12",
    theme_color: "#2563eb",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  });
}
