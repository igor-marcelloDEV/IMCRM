'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Loader2,
  QrCode,
  CheckCircle2,
  AlertTriangle,
  LogOut,
  RefreshCw,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import type { BaileysConnection as BaileysConnectionType } from '@/types';

/** Fairly tight — a QR code is only valid for ~60s on WhatsApp's side,
 *  so the UI needs to notice a fresh one lands quickly. */
const POLL_INTERVAL_MS = 2500;

/**
 * QR-pairing panel for the WhatsApp Web (Baileys) connection method.
 * The worker owns `baileys_connections` (writes status/QR directly
 * with the service role); this component only ever reads it via the
 * normal RLS-scoped client, polling while a pairing is in flight —
 * same pattern as the Broadcasts list page's send-progress polling.
 */
export function BaileysConnection() {
  const t = useTranslations('Settings.whatsappConnection');
  const supabase = createClient();
  const { accountId } = useAuth();

  const [connection, setConnection] = useState<BaileysConnectionType | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchConnection = useCallback(async () => {
    if (!accountId) return;
    const { data, error } = await supabase
      .from('baileys_connections')
      .select('*')
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) {
      console.error('Failed to load baileys_connections:', error);
    }
    setConnection(data);
    setLoading(false);
  }, [accountId, supabase]);

  useEffect(() => {
    fetchConnection();
  }, [fetchConnection]);

  useEffect(() => {
    function stopPolling() {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    }
    if (connection?.status === 'qr_pending') {
      if (!pollTimer.current) {
        pollTimer.current = setInterval(fetchConnection, POLL_INTERVAL_MS);
      }
    } else {
      stopPolling();
    }
    return stopPolling;
  }, [connection?.status, fetchConnection]);

  async function handleConnect() {
    setConnecting(true);
    try {
      const res = await fetch('/api/whatsapp/baileys/connect', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || t('toastConnectFailed'));
        return;
      }
      toast.success(t('toastConnectStarted'));
      await fetchConnection();
    } catch (err) {
      console.error('Connect error:', err);
      toast.error(t('toastConnectFailed'));
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    if (!confirm(t('confirmDisconnect'))) return;
    setDisconnecting(true);
    try {
      const res = await fetch('/api/whatsapp/baileys/disconnect', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || t('toastDisconnectFailed'));
        return;
      }
      toast.success(t('toastDisconnected'));
      await fetchConnection();
    } catch (err) {
      console.error('Disconnect error:', err);
      toast.error(t('toastDisconnectFailed'));
    } finally {
      setDisconnecting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  const status = connection?.status ?? 'disconnected';

  return (
    <div className="space-y-6">
      <Alert className="bg-amber-950/40 border-amber-600/40">
        <div className="flex items-start gap-3">
          <AlertTriangle className="size-5 text-amber-400 mt-0.5 shrink-0" />
          <div className="flex-1">
            <AlertTitle className="text-amber-200 mb-1">{t('baileysRiskTitle')}</AlertTitle>
            <AlertDescription className="text-amber-100/80 text-sm">
              {t('baileysRiskDesc')}
            </AlertDescription>
          </div>
        </div>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">
            {status === 'connected'
              ? t('statusConnected')
              : status === 'qr_pending'
                ? t('statusQrPending')
                : t('statusDisconnected')}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {status === 'connected'
              ? t('statusConnectedDesc', { phone: connection?.phone_number ?? '' })
              : status === 'qr_pending'
                ? t('qrDesc')
                : t('statusDisconnectedDesc')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {status === 'qr_pending' && connection?.qr_code && (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-muted/30 p-6">
              <img
                src={connection.qr_code}
                alt={t('qrTitle')}
                className="size-56 rounded-lg bg-white p-2"
              />
              <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                {t('qrWaiting')}
              </p>
              <p className="text-xs text-muted-foreground">{t('qrExpiredHint')}</p>
            </div>
          )}

          {status === 'connected' && connection?.phone_number && (
            <div className="flex items-center gap-2 text-emerald-400">
              <CheckCircle2 className="size-4" />
              <span className="text-sm font-medium">{connection.phone_number}</span>
            </div>
          )}

          <div className="flex flex-wrap gap-3">
            {status !== 'connected' ? (
              <Button
                onClick={handleConnect}
                disabled={connecting}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                {connecting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('connecting')}
                  </>
                ) : (
                  <>
                    <QrCode className="size-4" />
                    {t('connectButton')}
                  </>
                )}
              </Button>
            ) : (
              <Button
                variant="outline"
                onClick={handleDisconnect}
                disabled={disconnecting}
                className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
              >
                {disconnecting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('disconnecting')}
                  </>
                ) : (
                  <>
                    <LogOut className="size-4" />
                    {t('disconnectButton')}
                  </>
                )}
              </Button>
            )}
            {status === 'qr_pending' && (
              <Button
                variant="outline"
                onClick={handleConnect}
                disabled={connecting}
                className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
              >
                <RefreshCw className="size-4" />
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
