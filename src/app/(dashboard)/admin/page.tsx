"use client";

// Platform-operator overview — accounts, subscription status, and
// MRR across every tenant. Not a per-account setting: access is
// enforced server-side by /api/admin/overview (compares the caller's
// account_id against PLATFORM_OPERATOR_ACCOUNT_ID). A non-operator
// gets a 403 from the API and is bounced back to /dashboard; the
// sidebar link is also hidden for them (see sidebar.tsx), but that's
// cosmetic only — the real gate lives server-side.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Users, TrendingUp, CircleCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SkeletonCard } from "@/components/dashboard/skeleton";

interface AccountRow {
  id: string;
  name: string;
  ownerEmail: string | null;
  createdAt: string;
  isOperator: boolean;
  subscriptionStatus: string | null;
  planCode: string | null;
  billingType: string | null;
  currentPeriodEnd: string | null;
}

interface PaymentRow {
  account_id: string;
  amount_cents: number;
  status: string;
  billing_type: string | null;
  paid_at: string | null;
  created_at: string;
}

interface OverviewData {
  totalAccounts: number;
  activePayingAccounts: number;
  mrrCents: number;
  statusCounts: Record<string, number>;
  accounts: AccountRow[];
  recentPayments: PaymentRow[];
}

function formatBRL(cents: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
}

function statusVariant(status: string | null): "default" | "secondary" | "outline" | "destructive" {
  if (status === "active" || status === "confirmed") return "default";
  if (status === "trialing" || status === "pending") return "secondary";
  if (status === "past_due" || status === "overdue" || status === "failed") return "destructive";
  return "outline";
}

export default function AdminOverviewPage() {
  const t = useTranslations("Admin.overview");
  const router = useRouter();
  const [data, setData] = useState<OverviewData | null>(null);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/admin/overview");
      if (cancelled) return;
      if (res.status === 403) {
        setForbidden(true);
        router.push("/dashboard");
        return;
      }
      if (!res.ok) return;
      setData(await res.json());
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (forbidden) return null;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {!data ? (
          Array.from({ length: 3 }).map((_, i) => <SkeletonCard key={i} />)
        ) : (
          <>
            <Card>
              <CardContent className="flex items-center gap-3 pt-6">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Users className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-foreground">{data.totalAccounts}</p>
                  <p className="text-xs text-muted-foreground">{t("totalAccounts")}</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex items-center gap-3 pt-6">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-500">
                  <CircleCheck className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-foreground">{data.activePayingAccounts}</p>
                  <p className="text-xs text-muted-foreground">{t("activePayingAccounts")}</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex items-center gap-3 pt-6">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <TrendingUp className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-foreground">{formatBRL(data.mrrCents)}</p>
                  <p className="text-xs text-muted-foreground">{t("mrr")}</p>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("accountsTitle")}</CardTitle>
          <CardDescription>{t("accountsDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          {!data ? (
            <div className="h-40 animate-pulse rounded-lg bg-muted" />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("colAccount")}</TableHead>
                    <TableHead>{t("colOwner")}</TableHead>
                    <TableHead>{t("colStatus")}</TableHead>
                    <TableHead>{t("colPlan")}</TableHead>
                    <TableHead>{t("colRenews")}</TableHead>
                    <TableHead>{t("colCreated")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.accounts.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell className="font-medium text-foreground">
                        {a.name}
                        {a.isOperator && (
                          <Badge variant="outline" className="ml-2">
                            {t("operatorBadge")}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{a.ownerEmail ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(a.subscriptionStatus)}>
                          {a.subscriptionStatus ? t(`status.${a.subscriptionStatus}`) : t("status.none")}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {a.planCode ? t(`plan.${a.planCode}`) : "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {a.currentPeriodEnd ? new Date(a.currentPeriodEnd).toLocaleDateString() : "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(a.createdAt).toLocaleDateString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("paymentsTitle")}</CardTitle>
          <CardDescription>{t("paymentsDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          {!data ? (
            <div className="h-32 animate-pulse rounded-lg bg-muted" />
          ) : data.recentPayments.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noPayments")}</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("colAmount")}</TableHead>
                    <TableHead>{t("colStatus")}</TableHead>
                    <TableHead>{t("colMethod")}</TableHead>
                    <TableHead>{t("colDate")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.recentPayments.map((p, ix) => (
                    <TableRow key={ix}>
                      <TableCell>{formatBRL(p.amount_cents)}</TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(p.status)}>{t(`paymentStatus.${p.status}`)}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {p.billing_type ? t(`method.${p.billing_type}`) : "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(p.paid_at ?? p.created_at).toLocaleDateString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
