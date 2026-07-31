import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { DashboardShell } from "@/components/layout/dashboard-shell";
import {
  PaymentRequiredError,
  UnauthorizedError,
  requireEntitledAccount,
} from "@/lib/auth/account";

// Server layout whose only job is to declare "do not index" metadata
// for the authed app. robots.ts already disallows these paths at the
// crawler-level and Proxy redirects unauthenticated visitors, so
// this is belt-and-suspenders — but SEO-critical if a URL ever leaks
// via a link shared externally.
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
};

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let context: Awaited<ReturnType<typeof requireEntitledAccount>>;
  try {
    context = await requireEntitledAccount();
  } catch (error) {
    if (error instanceof UnauthorizedError) redirect("/login");
    if (error instanceof PaymentRequiredError) redirect("/billing");
    throw error;
  }

  return (
    <DashboardShell billingBypass={context.entitlement.reason === "operator"}>
      {children}
    </DashboardShell>
  );
}
