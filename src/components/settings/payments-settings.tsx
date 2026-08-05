'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Copy,
  ImagePlus,
  KeyRound,
  Loader2,
  Search,
  Trash2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsPanelHead } from './settings-panel-head';
import { uploadAccountMedia, MEDIA_MAX_BYTES_BY_KIND } from '@/lib/storage/upload-media';

const BUSINESS_ASSETS_BUCKET = 'flow-media';

interface PaymentsConfig {
  connected: boolean;
  asaas_env: 'sandbox' | 'production';
  municipal_service_id: string | null;
  municipal_service_name: string | null;
  nfe_enabled: boolean;
  webhook_configured: boolean;
}

interface MunicipalService {
  id: string;
  municipalServiceCode: string;
  municipalServiceName: string;
}

export function PaymentsSettings() {
  const t = useTranslations('Settings.payments');
  const [config, setConfig] = useState<PaymentsConfig | null>(null);
  const [loading, setLoading] = useState(true);

  // Whitelabel identity — shown on documents IMCRM itself generates
  // (receipts today; future reports), never on the official NFS-e PDF
  // (that layout is the municipality's, via Asaas).
  const [businessName, setBusinessName] = useState('');
  const [legalName, setLegalName] = useState('');
  const [businessCnpj, setBusinessCnpj] = useState('');
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [savingBranding, setSavingBranding] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);

  const loadBranding = useCallback(async () => {
    const res = await fetch('/api/account');
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.account) {
      setBusinessName(data.account.name ?? '');
      setLegalName(data.account.legal_name ?? data.account.name ?? '');
      setBusinessCnpj(data.account.cnpj ?? '');
      setLogoUrl(data.account.logo_url ?? null);
    }
  }, []);

  useEffect(() => {
    void loadBranding();
  }, [loadBranding]);

  const saveBranding = useCallback(
    async (patch: { name?: string; logo_url?: string | null; legal_name?: string | null; cnpj?: string | null }) => {
      setSavingBranding(true);
      try {
        const res = await fetch('/api/account', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data.error ?? t('brandingSaveFailed'));
          return;
        }
        toast.success(t('brandingSaved'));
      } finally {
        setSavingBranding(false);
      }
    },
    [t],
  );

  async function handleLogoSelected(file: File) {
    if (file.size > MEDIA_MAX_BYTES_BY_KIND.image) {
      toast.error(t('logoTooLarge'));
      return;
    }
    setUploadingLogo(true);
    try {
      const { url } = await uploadAccountMedia(BUSINESS_ASSETS_BUCKET, file);
      setLogoUrl(url);
      await saveBranding({ logo_url: url });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('logoUploadFailed'));
    } finally {
      setUploadingLogo(false);
    }
  }
  const [apiKey, setApiKey] = useState('');
  const [env, setEnv] = useState<'sandbox' | 'production'>('sandbox');
  const [saving, setSaving] = useState(false);
  const [webhookToken, setWebhookToken] = useState<string | null>(null);

  const [services, setServices] = useState<MunicipalService[] | null>(null);
  const [searchingServices, setSearchingServices] = useState(false);
  const [selectedServiceId, setSelectedServiceId] = useState('');
  const [nfeEnabled, setNfeEnabled] = useState(false);
  const [savingNfe, setSavingNfe] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/account/payments', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.config) {
        setConfig(data.config);
        setEnv(data.config.asaas_env);
        setSelectedServiceId(data.config.municipal_service_id ?? '');
        setNfeEnabled(data.config.nfe_enabled ?? false);
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
      const res = await fetch('/api/account/payments', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey || undefined, asaas_env: env }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('toastSaveFailed'));
        return;
      }
      toast.success(t('toastSaved'));
      setApiKey('');
      await load();
    } catch {
      toast.error(t('toastSaveFailed'));
    } finally {
      setSaving(false);
    }
  }, [apiKey, env, load, t]);

  const searchServices = useCallback(async () => {
    setSearchingServices(true);
    setServices(null);
    try {
      const res = await fetch('/api/account/payments/municipal-services', {
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('toastServicesFailed'));
        return;
      }
      setServices(data.services ?? []);
      if ((data.services ?? []).length === 0) {
        toast.error(t('toastNoServices'));
      }
    } catch {
      toast.error(t('toastServicesFailed'));
    } finally {
      setSearchingServices(false);
    }
  }, [t]);

  const saveNfe = useCallback(
    async (nextEnabled: boolean) => {
      const picked = services?.find((s) => s.id === selectedServiceId);
      const serviceId = picked?.id ?? config?.municipal_service_id ?? '';
      const serviceName =
        picked?.municipalServiceName ?? config?.municipal_service_name ?? '';
      setSavingNfe(true);
      try {
        const res = await fetch('/api/account/payments', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            municipal_service_id: serviceId,
            municipal_service_name: serviceName,
            nfe_enabled: nextEnabled,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data.error ?? t('toastSaveFailed'));
          return;
        }
        toast.success(t('toastSaved'));
        await load();
      } catch {
        toast.error(t('toastSaveFailed'));
      } finally {
        setSavingNfe(false);
      }
    },
    [services, selectedServiceId, config, load, t]
  );

  const copy = useCallback(
    async (value: string, successKey: string) => {
      try {
        await navigator.clipboard.writeText(value);
        toast.success(t(successKey));
      } catch {
        toast.error(t('copyFailed'));
      }
    },
    [t]
  );

  const revealAndCopyWebhookToken = useCallback(async () => {
    if (webhookToken) {
      await copy(webhookToken, 'webhookTokenCopied');
      return;
    }

    try {
      const res = await fetch('/api/account/payments', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reveal_webhook_token: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || typeof data.webhook_token !== 'string') {
        toast.error(data.error ?? t('copyFailed'));
        return;
      }
      setWebhookToken(data.webhook_token);
      await copy(data.webhook_token, 'webhookTokenCopied');
    } catch {
      toast.error(t('copyFailed'));
    }
  }, [copy, t, webhookToken]);

  const webhookUrl =
    (process.env.NEXT_PUBLIC_SITE_URL ?? '') + '/api/orders/webhook';

  if (loading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div>
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <div className="border-border bg-card mb-4 rounded-lg border p-4">
        <div className="mb-1 flex items-center gap-2">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          <p className="text-foreground text-sm font-medium">{t('brandingTitle')}</p>
        </div>
        <p className="text-muted-foreground mb-4 text-xs">{t('brandingDesc')}</p>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <div className="flex flex-col items-center gap-2">
            <button
              type="button"
              onClick={() => logoInputRef.current?.click()}
              disabled={uploadingLogo}
              className="border-border bg-muted flex h-20 w-20 items-center justify-center overflow-hidden rounded-lg border border-dashed disabled:opacity-60"
            >
              {uploadingLogo ? (
                <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
              ) : logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logoUrl} alt={businessName} className="h-full w-full object-contain" />
              ) : (
                <ImagePlus className="text-muted-foreground h-5 w-5" />
              )}
            </button>
            <input
              ref={logoInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleLogoSelected(file);
                e.target.value = '';
              }}
            />
            {logoUrl && (
              <button
                type="button"
                onClick={() => {
                  setLogoUrl(null);
                  void saveBranding({ logo_url: null });
                }}
                className="text-muted-foreground hover:text-destructive flex items-center gap-1 text-[11px]"
              >
                <Trash2 className="h-3 w-3" />
                {t('removeLogo')}
              </button>
            )}
          </div>

          <div className="flex-1 space-y-3">
            <div>
            <label className="text-muted-foreground mb-1 block text-xs">
              {t('businessNameLabel')}
            </label>
            <Input value={businessName} onChange={(e) => setBusinessName(e.target.value)} placeholder={t('businessNamePlaceholder')} className="bg-muted" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div><label className="text-muted-foreground mb-1 block text-xs">{t('legalNameLabel')}</label><Input value={legalName} onChange={(e) => setLegalName(e.target.value)} placeholder={t('legalNamePlaceholder')} className="bg-muted" /></div>
              <div><label className="text-muted-foreground mb-1 block text-xs">{t('cnpjLabel')}</label><Input value={businessCnpj} onChange={(e) => setBusinessCnpj(e.target.value)} placeholder="00.000.000/0000-00" inputMode="numeric" className="bg-muted" /></div>
            </div>
            <Button variant="outline" disabled={savingBranding || !businessName.trim()} onClick={() => saveBranding({ name: businessName.trim(), legal_name: legalName.trim() || null, cnpj: businessCnpj.trim() || null })}>
              {savingBranding && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}{t('saveIdentity')}
            </Button>
            <p className="text-muted-foreground text-[11px]">{t('brandingHint')}</p>
          </div>
        </div>
      </div>

      <div className="border-border bg-card rounded-lg border p-4">
        <div className="mb-4 flex items-center gap-2">
          {config?.connected ? (
            <>
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              <span className="text-foreground text-sm font-medium">
                {t('connected')}
              </span>
            </>
          ) : (
            <>
              <KeyRound className="text-muted-foreground h-4 w-4" />
              <span className="text-muted-foreground text-sm font-medium">
                {t('notConnected')}
              </span>
            </>
          )}
        </div>

        <p className="text-muted-foreground mb-4 text-xs">{t('intro')}</p>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div>
            <label className="text-muted-foreground mb-1 block text-xs">
              {t('apiKeyLabel')}
            </label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                config?.connected
                  ? t('apiKeyPlaceholderConnected')
                  : t('apiKeyPlaceholder')
              }
              className="bg-muted font-mono text-xs"
              autoComplete="off"
            />
          </div>
          <div>
            <label className="text-muted-foreground mb-1 block text-xs">
              {t('envLabel')}
            </label>
            <Select
              value={env}
              onValueChange={(v) => setEnv(v as 'sandbox' | 'production')}
            >
              <SelectTrigger className="bg-muted">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sandbox">{t('envSandbox')}</SelectItem>
                <SelectItem value="production">{t('envProduction')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <p className="text-muted-foreground mt-3 text-[11px]">{t('keyHint')}</p>

        <Button
          onClick={save}
          disabled={saving || (!apiKey && env === config?.asaas_env)}
          className="mt-4"
        >
          {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
          {t('save')}
        </Button>
      </div>

      {config?.webhook_configured && (
        <div className="border-border bg-card mt-4 rounded-lg border p-4">
          <p className="text-foreground mb-1 text-sm font-medium">
            {t('webhookTitle')}
          </p>
          <p className="text-muted-foreground mb-3 text-xs">
            {t('webhookDesc')}
          </p>

          <div className="mb-2">
            <label className="text-muted-foreground mb-1 block text-xs">
              {t('webhookUrlLabel')}
            </label>
            <div className="flex gap-2">
              <Input
                readOnly
                value={webhookUrl}
                className="bg-muted font-mono text-xs"
              />
              <Button
                variant="outline"
                size="icon"
                onClick={() => copy(webhookUrl, 'webhookUrlCopied')}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div>
            <label className="text-muted-foreground mb-1 block text-xs">
              {t('webhookTokenLabel')}
            </label>
            <div className="flex gap-2">
              <Input
                readOnly
                value={webhookToken ?? '••••••••••••••••••••••••'}
                className="bg-muted font-mono text-xs"
              />
              <Button
                variant="outline"
                size="icon"
                onClick={() => void revealAndCopyWebhookToken()}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      )}

      {config?.connected && (
        <div className="border-border bg-card mt-4 rounded-lg border p-4">
          <p className="text-foreground mb-1 text-sm font-medium">
            {t('nfeTitle')}
          </p>
          <p className="text-muted-foreground mb-3 text-xs">{t('nfeIntro')}</p>

          <div className="mb-3 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{t('nfeWarning')}</span>
          </div>

          {config.municipal_service_name && (
            <p className="text-muted-foreground mb-3 text-xs">
              {t('currentService', { service: config.municipal_service_name })}
            </p>
          )}

          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1">
              <label className="text-muted-foreground mb-1 block text-xs">
                {t('municipalServiceLabel')}
              </label>
              {services && services.length > 0 ? (
                <Select
                  value={selectedServiceId}
                  onValueChange={(v) => setSelectedServiceId(v ?? '')}
                >
                  <SelectTrigger className="bg-muted">
                    <SelectValue placeholder={t('pickService')} />
                  </SelectTrigger>
                  <SelectContent>
                    {services.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.municipalServiceName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="border-border bg-muted/40 text-muted-foreground flex h-9 items-center rounded-md border border-dashed px-3 text-xs">
                  {t('noServicesYet')}
                </p>
              )}
            </div>
            <Button
              variant="outline"
              onClick={searchServices}
              disabled={searchingServices}
            >
              {searchingServices ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Search className="mr-1 h-4 w-4" />
              )}
              {t('searchServices')}
            </Button>
            {selectedServiceId &&
              selectedServiceId !== config.municipal_service_id && (
                <Button
                  onClick={() => saveNfe(nfeEnabled)}
                  disabled={savingNfe}
                >
                  {savingNfe && (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  )}
                  {t('saveService')}
                </Button>
              )}
          </div>

          <div className="border-border bg-muted/50 mt-4 flex items-center justify-between rounded-md border px-3 py-2">
            <div>
              <p className="text-foreground text-sm font-medium">
                {t('nfeEnabledLabel')}
              </p>
              <p className="text-muted-foreground text-xs">
                {t('nfeEnabledHint')}
              </p>
            </div>
            <Switch
              checked={nfeEnabled}
              disabled={
                savingNfe ||
                (!config.municipal_service_id && !selectedServiceId)
              }
              onCheckedChange={(v) => {
                setNfeEnabled(v);
                void saveNfe(v);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
