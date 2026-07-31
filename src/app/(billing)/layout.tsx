import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { DashboardShell } from "@/components/layout/dashboard-shell";
import {
  UnauthorizedError,
  getCurrentAccount,
} from "@/lib/auth/account";

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

/**
 * Billing is the explicit entitlement exception: an authenticated
 * account must be able to recover access by purchasing a plan.
 */
export default async function BillingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  try {
    await getCurrentAccount();
  } catch (error) {
    if (error instanceof UnauthorizedError) redirect("/login");
    throw error;
  }

  return <DashboardShell>{children}</DashboardShell>;
}
