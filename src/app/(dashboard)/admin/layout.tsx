import { redirect } from "next/navigation";

import { ForbiddenError } from "@/lib/auth/account";
import { requirePlatformAdmin } from "@/lib/auth/platform-admin";

/**
 * The parent layout checks authentication and entitlement (with the
 * operator-account bypass). This leaf check additionally prevents a
 * paying tenant from rendering the operator page shell directly.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  try {
    await requirePlatformAdmin();
  } catch (error) {
    if (error instanceof ForbiddenError) redirect("/dashboard");
    throw error;
  }
  return children;
}
