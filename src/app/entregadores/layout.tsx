import type { Metadata } from "next";

// Overrides the root layout's manifest link (which points the staff
// dashboard's install prompt at `/today`) so a driver installing from
// here gets their own app identity — see entregadores-manifest.webmanifest.
export const metadata: Metadata = {
  manifest: "/entregadores-manifest.webmanifest",
};

export default function EntregadoresLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
