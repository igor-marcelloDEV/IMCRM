// ============================================================
// GET /api/admin/overview
//
// Platform-operator-only snapshot: how many accounts exist, which
// ones have a paying subscription, and roughly how much MRR that
// represents. There is no separate "admin" role — access is gated
// by comparing the caller's account_id against the single
// PLATFORM_OPERATOR_ACCOUNT_ID env var, the same pattern already
// used by the billing nurture cron (src/app/api/billing/nurture-cron/route.ts)
// and the coupon/plan management routes.
//
// Reads with the service-role client (src/lib/billing/admin-client.ts)
// because this necessarily crosses account boundaries — RLS on
// `accounts`/`subscriptions` scopes every other caller to their own
// row, which is exactly what a cross-tenant overview can't work
// within.
// ============================================================

import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse, ForbiddenError } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/billing/admin-client";

// Subscription statuses that count as "actively usable" — mirrors
// hasBillingAccess() in src/hooks/use-billing-status.ts.
const ACTIVE_STATUSES = new Set(["active", "trialing"]);

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const operatorAccountId = process.env.PLATFORM_OPERATOR_ACCOUNT_ID;
    if (!operatorAccountId || ctx.accountId !== operatorAccountId) {
      throw new ForbiddenError("Este painel é restrito ao operador da plataforma");
    }

    const db = supabaseAdmin();

    const [{ data: accounts }, { data: subs }, { data: plans }, { data: payments }] =
      await Promise.all([
        db
          .from("accounts")
          .select("id, name, owner_user_id, created_at")
          .order("created_at", { ascending: false }),
        db
          .from("subscriptions")
          .select("account_id, status, plan_id, billing_type, current_period_end, created_at"),
        db.from("billing_plans").select("id, code, name, price_cents, cycle_days"),
        db
          .from("payments")
          .select("account_id, amount_cents, status, billing_type, paid_at, created_at")
          .order("created_at", { ascending: false })
          .limit(10),
      ]);

    const { data: authUsers } = await db.auth.admin.listUsers({ perPage: 200 });
    const emailByUserId = new Map((authUsers?.users ?? []).map((u) => [u.id, u.email ?? null]));

    const planById = new Map((plans ?? []).map((p) => [p.id, p]));
    const subByAccount = new Map((subs ?? []).map((s) => [s.account_id, s]));

    let mrrCents = 0;
    const statusCounts: Record<string, number> = {};
    for (const s of subs ?? []) {
      statusCounts[s.status] = (statusCounts[s.status] ?? 0) + 1;
      if (ACTIVE_STATUSES.has(s.status)) {
        const plan = planById.get(s.plan_id);
        if (plan && plan.cycle_days > 0) {
          // Normalize every cycle length to a monthly figure so
          // weekly/monthly/annual plans sum into one comparable MRR.
          mrrCents += (plan.price_cents / plan.cycle_days) * 30;
        }
      }
    }

    const accountRows = (accounts ?? []).map((a) => {
      const sub = subByAccount.get(a.id);
      const plan = sub ? planById.get(sub.plan_id) : undefined;
      return {
        id: a.id,
        name: a.name,
        ownerEmail: a.owner_user_id ? (emailByUserId.get(a.owner_user_id) ?? null) : null,
        createdAt: a.created_at,
        isOperator: a.id === operatorAccountId,
        subscriptionStatus: sub?.status ?? null,
        planCode: plan?.code ?? null,
        billingType: sub?.billing_type ?? null,
        currentPeriodEnd: sub?.current_period_end ?? null,
      };
    });

    const activeCount = accountRows.filter(
      (a) => !a.isOperator && a.subscriptionStatus && ACTIVE_STATUSES.has(a.subscriptionStatus),
    ).length;

    return NextResponse.json({
      totalAccounts: accountRows.length,
      activePayingAccounts: activeCount,
      mrrCents: Math.round(mrrCents),
      statusCounts,
      accounts: accountRows,
      recentPayments: payments ?? [],
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
