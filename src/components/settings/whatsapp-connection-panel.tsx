'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { MessageSquareText, QrCode } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { SettingsPanelHead } from './settings-panel-head';
import { WhatsAppConfig } from './whatsapp-config';
import { BaileysConnection } from './baileys-connection';
import type { WhatsAppProviderType } from '@/types';

/**
 * Top-level "WhatsApp connection" settings panel: a two-card chooser
 * between the official Meta Cloud API and the unofficial WhatsApp Web
 * (Baileys) integration, plus the matching config panel for whichever
 * one is active. Replaces the direct `<WhatsAppConfig />` render in
 * the Settings page — that component is unchanged, just nested here
 * alongside its new sibling.
 *
 * Clicking a card calls `/api/whatsapp/provider` to flip
 * `accounts.active_whatsapp_provider` immediately (cheap — it's just
 * which panel is "in front"; actually connecting is a separate step
 * owned by each panel: Meta's Save Configuration button, Baileys'
 * Connect button + QR scan).
 */
export function WhatsAppConnectionPanel() {
  const t = useTranslations('Settings.whatsappConnection');
  const { account, refreshProfile, canEditSettings } = useAuth();
  const [switching, setSwitching] = useState(false);

  const activeProvider: WhatsAppProviderType =
    account?.active_whatsapp_provider ?? 'meta_cloud_api';

  async function switchProvider(provider: WhatsAppProviderType) {
    if (provider === activeProvider || switching) return;
    setSwitching(true);
    try {
      const res = await fetch('/api/whatsapp/provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || t('toastSwitchFailed'));
        return;
      }
      if (provider === 'meta_cloud_api') {
        toast.success(t('toastSwitchedToMeta'));
      }
      await refreshProfile();
    } catch (err) {
      console.error('switchProvider error:', err);
      toast.error(t('toastSwitchFailed'));
    } finally {
      setSwitching(false);
    }
  }

  return (
    <section className="animate-in fade-in-50 duration-200 space-y-8">
      <div>
        <SettingsPanelHead title={t('sectionTitle')} description={t('sectionDesc')} />
        <div className="grid gap-4 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => switchProvider('meta_cloud_api')}
            disabled={switching || !canEditSettings}
            className={`rounded-xl border p-4 text-left transition-colors disabled:cursor-not-allowed ${
              activeProvider === 'meta_cloud_api'
                ? 'border-primary bg-primary/5'
                : 'border-border bg-card hover:bg-muted/50'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <MessageSquareText className="size-4 text-primary" />
                <span className="text-sm font-semibold text-foreground">
                  {t('metaCardTitle')}
                </span>
              </div>
              {activeProvider === 'meta_cloud_api' && <Badge>{t('activeBadge')}</Badge>}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{t('metaCardDesc')}</p>
          </button>

          <button
            type="button"
            onClick={() => switchProvider('baileys')}
            disabled={switching || !canEditSettings}
            className={`rounded-xl border p-4 text-left transition-colors disabled:cursor-not-allowed ${
              activeProvider === 'baileys'
                ? 'border-primary bg-primary/5'
                : 'border-border bg-card hover:bg-muted/50'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <QrCode className="size-4 text-primary" />
                <span className="text-sm font-semibold text-foreground">
                  {t('baileysCardTitle')}
                </span>
              </div>
              {activeProvider === 'baileys' && <Badge>{t('activeBadge')}</Badge>}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{t('baileysCardDesc')}</p>
          </button>
        </div>
      </div>

      {activeProvider === 'baileys' ? <BaileysConnection /> : <WhatsAppConfig />}
    </section>
  );
}
