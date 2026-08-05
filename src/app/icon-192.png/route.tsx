import { ImageResponse } from "next/og";

// Plain route handlers (not the `icon.tsx` naming convention) so the
// URL is exactly `/icon-192.png` — predictable and hardcodable into
// `manifest.ts`'s `icons` array, which doesn't have visibility into
// Next's auto-generated favicon hashes. Same brand mark as
// src/app/icon.tsx, just sized for PWA install/splash icons.
export const runtime = "edge";

export async function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#7c3aed",
        }}
      >
        <svg
          width="120"
          height="120"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#ffffff"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </div>
    ),
    { width: 192, height: 192 },
  );
}
