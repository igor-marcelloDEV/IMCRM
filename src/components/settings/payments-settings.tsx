"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { CheckCircle2, Copy, KeyRound, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsPanelHead } from "./settings-panel-head";

interface PaymentsConfig {
  connected: boolean;
  asaas_env: "sandbox" | "production";
  nfe_enabled: boolean;
  webhook_token: string | null;
}

export function PaymentsSettings() {
  const t = useTranslations("Settings.payments");
  const [config, setConfig] = useState<PaymentsConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [apiKey, setApiKey] = useState("");
  const [env, setEnv] = useState<"sandbox" | "production">("sandbox");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/account/payments", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.config) {
        setConfig(data.config);
        setEnv(data.config.asaas_env);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/account/payments", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: apiKey || undefined, asaas_env: env }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t("toastSaveFailed"));
        return;
      }
      toast.success(t("toastSaved"));
      setApiKey("");
      await load();
    } catch {
      toast.error(t("toastSaveFailed"));
    } finally {
      setSaving(false);
    }
  }, [apiKey, env, load, t]);

  const copy = useCallback(
    async (value: string, successKey: string) => {
      try {
        await navigator.clipboard.writeText(value);
        toast.success(t(successKey));
      } catch {
        toast.error(t("copyFailed"));
      }
    },
    [t],
  );

  const webhookUrl =
    (process.env.NEXT_PUBLIC_SITE_URL ?? "") + "/api/orders/webhook";

  if (loading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div>
      <SettingsPanelHead title={t("title")} description={t("description")} />

      <div className="rounded-lg border border-border bg-card p-4">
        <div className="mb-4 flex items-center gap-2">
          {config?.connected ? (
            <>
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              <span className="text-sm font-medium text-foreground">{t("connected")}</span>
            </>
          ) : (
            <>
              <KeyRound className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium text-muted-foreground">{t("notConnected")}</span>
            </>
          )}
        </div>

        <p className="mb-4 text-xs text-muted-foreground">{t("intro")}</p>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">{t("apiKeyLabel")}</label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={config?.connected ? t("apiKeyPlaceholderConnected") : t("apiKeyPlaceholder")}
              className="bg-muted font-mono text-xs"
              autoComplete="off"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">{t("envLabel")}</label>
            <Select value={env} onValueChange={(v) => setEnv(v as "sandbox" | "production")}>
              <SelectTrigger className="bg-muted">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sandbox">{t("envSandbox")}</SelectItem>
                <SelectItem value="production">{t("envProduction")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <p className="mt-3 text-[11px] text-muted-foreground">{t("keyHint")}</p>

        <Button onClick={save} disabled={saving || (!apiKey && env === config?.asaas_env)} className="mt-4">
          {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
          {t("save")}
        </Button>
      </div>

      {config?.webhook_token && (
        <div className="mt-4 rounded-lg border border-border bg-card p-4">
          <p className="mb-1 text-sm font-medium text-foreground">{t("webhookTitle")}</p>
          <p className="mb-3 text-xs text-muted-foreground">{t("webhookDesc")}</p>

          <div className="mb-2">
            <label className="mb-1 block text-xs text-muted-foreground">{t("webhookUrlLabel")}</label>
            <div className="flex gap-2">
              <Input readOnly value={webhookUrl} className="bg-muted font-mono text-xs" />
              <Button variant="outline" size="icon" onClick={() => copy(webhookUrl, "webhookUrlCopied")}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">{t("webhookTokenLabel")}</label>
            <div className="flex gap-2">
              <Input readOnly value={config.webhook_token} className="bg-muted font-mono text-xs" />
              <Button
                variant="outline"
                size="icon"
                onClick={() => copy(config.webhook_token!, "webhookTokenCopied")}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      )}

      <p className="mt-4 rounded-lg border border-dashed border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        {t("nfeComingSoon")}
      </p>
    </div>
  );
}
