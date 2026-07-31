"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { CheckCircle2, Circle, X, Sparkles } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";

interface ChecklistItem {
  key: string;
  href: string;
  done: boolean;
  /** Optional steps stay visible but do not make progress impossible
   *  for solo entrepreneurs. */
  optional?: boolean;
  /** Shown instead of the description when the step doesn't apply
   *  (e.g. template approval on an unofficial connection). */
  skipNote?: string;
}

/**
 * First-login guidance — every new account is seeded with a working
 * pipeline, flow, automation, and templates (migration 044) so the
 * dashboard is never blank, but a brand-new owner still doesn't know
 * WHERE to look.
 *
 * Two bugs shipped in the first version of this component, both
 * fixed here (migration 045 has the full writeup):
 *   1. Dismissal lived in localStorage (per-browser) — now a single
 *      `accounts.onboarding_dismissed_at` column, one dismiss for
 *      everyone on the account, on any device, permanently.
 *   2. The card auto-hid itself once every item looked "done",
 *      recomputed from live account data on every load — which made
 *      it flicker in and out as that data changed. It now ONLY
 *      disappears on an explicit dismiss.
 *
 * Query cost: dismissal state is fetched FIRST and alone. If already
 * dismissed (the common case after the first session), the component
 * stops there — zero extra queries on every other dashboard load.
 * Only an undismissed card pays for the per-item "done" checks below.
 */
export function OnboardingChecklist() {
  const t = useTranslations("Dashboard.onboarding");
  const { accountId, account } = useAuth();
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  const [checks, setChecks] = useState<{
    whatsappConnected: boolean;
    templateApproved: boolean;
    hasTeammate: boolean;
    hasActiveFlow: boolean;
    hasDeal: boolean;
  } | null>(null);

  useEffect(() => {
    if (!accountId) return;
    const supabase = createClient();
    let cancelled = false;

    void (async () => {
      const { data } = await supabase
        .from("accounts")
        .select("onboarding_dismissed_at")
        .eq("id", accountId)
        .maybeSingle();
      if (!cancelled) {
        setDismissed(!!data?.onboarding_dismissed_at);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [accountId]);

  useEffect(() => {
    // Skip entirely once dismissed — this is the query-cost guard
    // described above. `dismissed === null` means the first check
    // above hasn't resolved yet; wait for it rather than firing both
    // requests at once.
    if (accountId === null || dismissed !== false) return;
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const [
        { data: whatsappConfig },
        { data: baileysConn },
        { count: approvedTemplates },
        { count: profiles },
        { count: activeFlows },
        { count: deals },
      ] =
        await Promise.all([
          supabase.from("whatsapp_config").select("id").eq("account_id", accountId).maybeSingle(),
          supabase.from("baileys_connections").select("status").eq("account_id", accountId).eq("status", "connected").maybeSingle(),
          supabase.from("message_templates").select("id", { count: "exact", head: true }).eq("account_id", accountId).eq("status", "APPROVED"),
          supabase.from("profiles").select("id", { count: "exact", head: true }).eq("account_id", accountId),
          supabase.from("flows").select("id", { count: "exact", head: true }).eq("account_id", accountId).eq("status", "active"),
          supabase.from("deals").select("id", { count: "exact", head: true }).eq("account_id", accountId),
        ]);
      if (cancelled) return;
      setChecks({
        whatsappConnected: !!whatsappConfig || !!baileysConn,
        templateApproved: (approvedTemplates ?? 0) > 0,
        hasTeammate: (profiles ?? 0) > 1,
        hasActiveFlow: (activeFlows ?? 0) > 0,
        hasDeal: (deals ?? 0) > 0,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [accountId, dismissed]);

  const dismiss = useCallback(async () => {
    if (!accountId) return;
    setDismissed(true); // optimistic — don't wait on the round trip to hide it
    const supabase = createClient();
    await supabase
      .from("accounts")
      .update({ onboarding_dismissed_at: new Date().toISOString() })
      .eq("id", accountId);
  }, [accountId]);

  const isBaileys = account?.active_whatsapp_provider === "baileys";

  const items: ChecklistItem[] = useMemo(() => {
    if (!checks) return [];
    return [
      { key: "whatsapp", href: "/settings?tab=whatsapp", done: checks.whatsappConnected },
      { key: "flow", href: "/flows", done: checks.hasActiveFlow },
      {
        key: "templates",
        href: "/settings?tab=templates",
        done: isBaileys || checks.templateApproved,
        skipNote: isBaileys ? t("templatesSkipBaileys") : undefined,
      },
      { key: "pipeline", href: "/pipelines", done: checks.hasDeal },
      {
        key: "team",
        href: "/settings?tab=members",
        done: checks.hasTeammate,
        optional: true,
      },
    ];
  }, [checks, isBaileys, t]);

  // Covers both "still loading" and "dismissed" — same null render,
  // no layout jump either way.
  if (dismissed !== false || !checks) return null;

  const requiredItems = items.filter((item) => !item.optional);
  const doneCount = requiredItems.filter((item) => item.done).length;

  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 shrink-0 text-primary" />
          <div>
            <h2 className="text-sm font-semibold text-foreground">{t("title")}</h2>
            <p className="text-xs text-muted-foreground">
              {t("subtitle", { done: doneCount, total: requiredItems.length })}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t("dismiss")}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
        {items.map((item) => (
          <li key={item.key}>
            <Link
              href={item.href}
              className={cn(
                "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs transition-colors",
                item.done
                  ? "border-transparent text-muted-foreground"
                  : "border-border bg-card text-foreground hover:border-primary/40",
              )}
            >
              {item.done ? (
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
              ) : (
                <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1">
                <span className={cn("block font-medium", item.done && "line-through")}>
                  {t(`items.${item.key}.title`)}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {item.skipNote ?? t(`items.${item.key}.description`)}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
