"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, CheckCircle2, Copy } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useBillingStatus, hasBillingAccess, type BillingStatus } from "@/hooks/use-billing-status";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

interface BillingPlan {
  id: string;
  code: "weekly" | "monthly" | "annual";
  name: string;
  price_cents: number;
  currency: string;
}

interface SubscriptionRow {
  id: string;
  status: BillingStatus;
  billing_type: string | null;
  current_period_end: string | null;
  trial_ends_at: string | null;
}

interface PaymentRow {
  id: string;
  amount_cents: number;
  currency: string;
  status: string;
  billing_type: string | null;
  paid_at: string | null;
  due_date: string | null;
  created_at: string;
}

type PaymentMethod = "pix" | "boleto" | "credit_card";

function formatCents(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`;
  }
}

export default function BillingPage() {
  const t = useTranslations("Billing");
  const { accountId, user } = useAuth();
  const status = useBillingStatus(accountId);

  const [plans, setPlans] = useState<BillingPlan[] | null>(null);
  const [subscription, setSubscription] = useState<SubscriptionRow | null>(null);
  const [payments, setPayments] = useState<PaymentRow[]>([]);

  const [selectedPlan, setSelectedPlan] = useState<BillingPlan["code"]>("monthly");
  const [method, setMethod] = useState<PaymentMethod>("pix");
  const [cpfCnpj, setCpfCnpj] = useState("");
  const [couponCode, setCouponCode] = useState("");
  const [couponPreview, setCouponPreview] = useState<
    { valid: true; discountType: "percentage" | "fixed"; discountValue: number } | { valid: false } | null
  >(null);
  const [checkingCoupon, setCheckingCoupon] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pixResult, setPixResult] = useState<{ qrCodeImage: string; payload: string } | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    const [{ data: planRows }, { data: subRows }] = await Promise.all([
      supabase.from("billing_plans").select("id, code, name, price_cents, currency").eq("is_active", true),
      accountId
        ? supabase
            .from("subscriptions")
            .select("id, status, billing_type, current_period_end, trial_ends_at")
            .eq("account_id", accountId)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    setPlans((planRows as BillingPlan[]) ?? []);
    setSubscription((subRows as SubscriptionRow | null) ?? null);

    if (accountId && subRows) {
      const { data: paymentRows } = await supabase
        .from("payments")
        .select("id, amount_cents, currency, status, billing_type, paid_at, due_date, created_at")
        .eq("account_id", accountId)
        .order("created_at", { ascending: false })
        .limit(20);
      setPayments((paymentRows as PaymentRow[]) ?? []);
    }

    // Pre-fill CPF/CNPJ if the account already went through checkout
    // once before (see /api/billing/checkout) — no need to ask twice.
    if (user?.id) {
      const { data: profileRow } = await supabase
        .from("profiles")
        .select("cpf_cnpj")
        .eq("user_id", user.id)
        .maybeSingle();
      if (profileRow?.cpf_cnpj) setCpfCnpj(profileRow.cpf_cnpj);
    }
  }, [accountId, user?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const plan = useMemo(() => plans?.find((p) => p.code === selectedPlan) ?? null, [plans, selectedPlan]);

  const priceBreakdown = useMemo(() => {
    if (!plan) return null;
    if (couponPreview?.valid) {
      const discountCents =
        couponPreview.discountType === "percentage"
          ? Math.round((plan.price_cents * couponPreview.discountValue) / 100)
          : Math.round(couponPreview.discountValue * 100);
      const finalCents = Math.max(0, plan.price_cents - discountCents);
      return { baseCents: plan.price_cents, finalCents, discount: "coupon" as const };
    }
    if (method === "pix") {
      const finalCents = Math.round(plan.price_cents * 0.9);
      return { baseCents: plan.price_cents, finalCents, discount: "pix" as const };
    }
    return { baseCents: plan.price_cents, finalCents: plan.price_cents, discount: null };
  }, [plan, method, couponPreview]);

  const checkCoupon = useCallback(async () => {
    if (!couponCode.trim()) {
      setCouponPreview(null);
      return;
    }
    setCheckingCoupon(true);
    try {
      const res = await fetch("/api/billing/coupon/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: couponCode.trim() }),
      });
      const data = await res.json();
      setCouponPreview(data);
      if (!data.valid) toast.error(t("couponInvalid"));
    } catch {
      toast.error(t("networkError"));
    } finally {
      setCheckingCoupon(false);
    }
  }, [couponCode, t]);

  const handleCheckout = useCallback(async () => {
    if (!plan) return;
    const cpfCnpjDigits = cpfCnpj.replace(/\D/g, "");
    if (cpfCnpjDigits.length !== 11 && cpfCnpjDigits.length !== 14) {
      toast.error(t("cpfCnpjInvalid"));
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planCode: plan.code,
          billingType: method,
          cpfCnpj: cpfCnpjDigits,
          couponCode: couponPreview?.valid ? couponCode.trim() : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || t("checkoutFailed"));
        return;
      }
      if (data.billingType === "pix") {
        setPixResult({ qrCodeImage: data.pix.qrCodeImage, payload: data.pix.payload });
      } else if (data.redirectUrl) {
        window.location.href = data.redirectUrl;
      }
      void load();
    } catch {
      toast.error(t("networkError"));
    } finally {
      setSubmitting(false);
    }
  }, [plan, method, cpfCnpj, couponPreview, couponCode, t, load]);

  const copyPixPayload = useCallback(async (payload: string) => {
    try {
      await navigator.clipboard.writeText(payload);
      toast.success(t("pixCopied"));
    } catch {
      toast.error(t("pixCopyFailed"));
    }
  }, []);

  if (plans === null) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  const alreadyPaying = subscription && hasBillingAccess(status);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      {alreadyPaying && subscription ? (
        <Card className="border-border bg-card">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-foreground">
                <CheckCircle2 className="h-5 w-5 text-primary" />
                {t("activeTitle")}
              </CardTitle>
              <Badge variant={status === "trialing" ? "secondary" : "default"}>
                {t(`status.${status}`)}
              </Badge>
            </div>
            <CardDescription>
              {subscription.current_period_end
                ? t("renewsAt", { date: new Date(subscription.current_period_end).toLocaleDateString() })
                : subscription.trial_ends_at
                  ? t("trialEndsAt", { date: new Date(subscription.trial_ends_at).toLocaleDateString() })
                  : null}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="text-foreground">{t("pickPlan")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {!hasBillingAccess(status) && status !== "loading" && status !== "none" && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-500">
                {t(`gateReason.${status}`)}
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-3">
              {plans.map((p) => (
                <button
                  key={p.code}
                  type="button"
                  onClick={() => setSelectedPlan(p.code)}
                  className={cn(
                    "rounded-xl border p-4 text-left transition-colors",
                    selectedPlan === p.code
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-border/70",
                  )}
                >
                  <p className="text-sm font-medium text-foreground">{t(`plan.${p.code}`)}</p>
                  <p className="mt-1 text-lg font-bold text-foreground">
                    {formatCents(p.price_cents, p.currency)}
                  </p>
                </button>
              ))}
            </div>

            <div className="space-y-2">
              <Label>{t("paymentMethod")}</Label>
              <div className="grid gap-2 sm:grid-cols-3">
                {(["pix", "credit_card", "boleto"] as PaymentMethod[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMethod(m)}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
                      method === m
                        ? "border-primary bg-primary/5 text-primary"
                        : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t(`method.${m}`)}
                    {m === "pix" && <span className="ml-1 text-xs">{t("pixDiscountBadge")}</span>}
                  </button>
                ))}
              </div>
              {method === "credit_card" && (
                <p className="text-xs text-muted-foreground">{t("cardRecurringNote")}</p>
              )}
              {method !== "credit_card" && (
                <p className="text-xs text-muted-foreground">{t("manualRenewalNote")}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="cpfCnpj">{t("cpfCnpjLabel")}</Label>
              <Input
                id="cpfCnpj"
                value={cpfCnpj}
                onChange={(e) => setCpfCnpj(e.target.value)}
                placeholder={t("cpfCnpjPlaceholder")}
                className="border-border bg-muted text-foreground"
              />
              <p className="text-xs text-muted-foreground">{t("cpfCnpjNote")}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="coupon">{t("couponLabel")}</Label>
              <div className="flex gap-2">
                <Input
                  id="coupon"
                  value={couponCode}
                  onChange={(e) => {
                    setCouponCode(e.target.value);
                    setCouponPreview(null);
                  }}
                  placeholder={t("couponPlaceholder")}
                  className="border-border bg-muted text-foreground"
                />
                <Button type="button" variant="outline" onClick={checkCoupon} disabled={checkingCoupon}>
                  {checkingCoupon ? <Loader2 className="h-4 w-4 animate-spin" /> : t("apply")}
                </Button>
              </div>
              {couponPreview?.valid && (
                <p className="text-xs text-primary">{t("couponApplied")}</p>
              )}
            </div>

            {priceBreakdown && (
              <div className="rounded-lg border border-border bg-muted/40 p-3">
                {priceBreakdown.discount && (
                  <p className="text-xs text-muted-foreground line-through">
                    {formatCents(priceBreakdown.baseCents, plan?.currency ?? "BRL")}
                  </p>
                )}
                <p className="text-xl font-bold text-foreground">
                  {formatCents(priceBreakdown.finalCents, plan?.currency ?? "BRL")}
                </p>
              </div>
            )}

            {pixResult ? (
              <div className="flex flex-col items-center gap-3 rounded-lg border border-border p-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`data:image/png;base64,${pixResult.qrCodeImage}`}
                  alt={t("pixQrAlt")}
                  className="h-48 w-48"
                />
                <Button type="button" variant="outline" onClick={() => copyPixPayload(pixResult.payload)}>
                  <Copy className="h-4 w-4" />
                  {t("pixCopyButton")}
                </Button>
                <p className="text-center text-xs text-muted-foreground">{t("pixWaitingNote")}</p>
              </div>
            ) : (
              <Button type="button" className="w-full" disabled={submitting || !plan} onClick={handleCheckout}>
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : t("subscribeButton")}
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {payments.length > 0 && (
        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="text-foreground">{t("invoicesTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("invoiceDate")}</TableHead>
                  <TableHead>{t("invoiceAmount")}</TableHead>
                  <TableHead>{t("invoiceStatus")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payments.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>{new Date(p.created_at).toLocaleDateString()}</TableCell>
                    <TableCell>{formatCents(p.amount_cents, p.currency)}</TableCell>
                    <TableCell>
                      <Badge variant={p.status === "confirmed" ? "default" : "outline"}>
                        {t(`paymentStatus.${p.status}`)}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
