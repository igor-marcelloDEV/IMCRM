import {
  ForbiddenError,
  getCurrentAccount,
  type AccountContext,
} from "@/lib/auth/account";

export interface PlatformAdminConfiguration {
  operatorAccountId?: string;
  adminUserIds?: string;
}

function currentConfiguration(): PlatformAdminConfiguration {
  return {
    operatorAccountId: process.env.PLATFORM_OPERATOR_ACCOUNT_ID,
    adminUserIds: process.env.PLATFORM_ADMIN_USER_IDS,
  };
}

/**
 * Cross-tenant service-role reads require all configured boundaries:
 * the operator account, its owner role, and (when present) an explicit
 * user allowlist. Account membership alone is never sufficient.
 */
export function assertPlatformAdmin(
  context: AccountContext,
  configuration: PlatformAdminConfiguration = currentConfiguration(),
): void {
  if (
    !configuration.operatorAccountId ||
    context.accountId !== configuration.operatorAccountId ||
    context.role !== "owner"
  ) {
    throw new ForbiddenError(
      "Este painel é restrito ao proprietário operador da plataforma",
    );
  }

  if (configuration.adminUserIds !== undefined) {
    const allowedUserIds = new Set(
      configuration.adminUserIds
        .split(",")
        .map((userId) => userId.trim())
        .filter(Boolean),
    );
    if (!allowedUserIds.has(context.userId)) {
      throw new ForbiddenError(
        "Seu usuário não está autorizado a administrar a plataforma",
      );
    }
  }
}

export async function requirePlatformAdmin(): Promise<AccountContext> {
  const context = await getCurrentAccount();
  assertPlatformAdmin(context);
  return context;
}
