'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Camera, CheckCircle2, Trash2, Eye, EyeOff, Copy } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';
import { useTranslations } from 'next-intl';

const MASKED_TOKEN = '••••••••••••••••';

export function InstagramConfig() {
  const { accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const t = useTranslations('Settings.instagram');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);

  const [configured, setConfigured] = useState(false);
  const [status, setStatus] = useState<'connected' | 'error'>('connected');
  const [username, setUsername] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const [pageId, setPageId] = useState('');
  const [igAccountId, setIgAccountId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [tokenEdited, setTokenEdited] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [hasStoredToken, setHasStoredToken] = useState(false);
  const [verifyToken, setVerifyToken] = useState('');
  const [verifyTokenEdited, setVerifyTokenEdited] = useState(false);

  const loadedAccountIdRef = useRef<string | null>(null);

  const webhookUrl =
    typeof window !== 'undefined' ? `${window.location.origin}/api/instagram/webhook` : '';

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/instagram/config');
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('loadFailed'));
        return;
      }
      if (data.configured) {
        setConfigured(true);
        setPageId(data.page_id ?? '');
        setIgAccountId(data.instagram_business_account_id ?? '');
        setUsername(data.username ?? null);
        setStatus(data.status ?? 'connected');
        setLastError(data.last_error ?? null);
        setHasStoredToken(Boolean(data.has_token));
        setAccessToken(data.has_token ? MASKED_TOKEN : '');
        setTokenEdited(false);
        setVerifyToken(MASKED_TOKEN);
        setVerifyTokenEdited(false);
      } else {
        setConfigured(false);
      }
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchConfig();
  }, [accountId, fetchConfig]);

  const handleCopyWebhook = async () => {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      toast.success(t('webhookCopied'));
    } catch {
      toast.error(t('webhookCopyFailed'));
    }
  };

  const handleSave = async () => {
    if (!pageId.trim() || !igAccountId.trim()) {
      toast.error(t('missingIds'));
      return;
    }
    if (!configured && !tokenEdited) {
      toast.error(t('missingToken'));
      return;
    }
    if (!configured && !verifyTokenEdited) {
      toast.error(t('missingVerifyToken'));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/instagram/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page_id: pageId.trim(),
          instagram_business_account_id: igAccountId.trim(),
          access_token: tokenEdited ? accessToken.trim() : undefined,
          verify_token: verifyTokenEdited ? verifyToken.trim() : undefined,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(t('saveSuccess'));
        await fetchConfig();
      } else {
        toast.error(data.error ?? t('saveFailed'));
      }
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    try {
      const res = await fetch('/api/instagram/config', { method: 'DELETE' });
      if (res.ok) {
        toast.success(t('removeSuccess'));
        setConfigured(false);
        setPageId('');
        setIgAccountId('');
        setAccessToken('');
        setTokenEdited(false);
        setHasStoredToken(false);
        setUsername(null);
      } else {
        const data = await res.json();
        toast.error(data.error ?? t('removeFailed'));
      }
    } catch {
      toast.error(t('removeFailed'));
    } finally {
      setRemoving(false);
    }
  };

  if (loading || profileLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
      </div>
    );
  }

  const disabled = !canEdit || saving;

  return (
    <div>
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {!canEdit && (
        <p className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {t('adminOnlyConfig')}
        </p>
      )}

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Camera className="h-4 w-4 text-primary" /> {t('connection')}
              {configured && (
                <Badge variant={status === 'connected' ? 'default' : 'destructive'}>
                  {status === 'connected' ? t('statusConnected') : t('statusError')}
                </Badge>
              )}
              {configured && username && (
                <span className="text-xs font-normal text-muted-foreground">@{username}</span>
              )}
            </CardTitle>
            <CardDescription>{t('connectionDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {lastError && (
              <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {lastError}
              </p>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="ig-page-id">{t('pageId')}</Label>
                <Input
                  id="ig-page-id"
                  value={pageId}
                  onChange={(e) => setPageId(e.target.value)}
                  placeholder="123456789012345"
                  disabled={disabled}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ig-account-id">{t('igAccountId')}</Label>
                <Input
                  id="ig-account-id"
                  value={igAccountId}
                  onChange={(e) => setIgAccountId(e.target.value)}
                  placeholder="17841400000000000"
                  disabled={disabled}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ig-token">{t('accessToken')}</Label>
              <div className="relative">
                <Input
                  id="ig-token"
                  type={showToken ? 'text' : 'password'}
                  value={accessToken}
                  onChange={(e) => {
                    setAccessToken(e.target.value);
                    setTokenEdited(true);
                  }}
                  onFocus={() => {
                    if (!tokenEdited && hasStoredToken) {
                      setAccessToken('');
                      setTokenEdited(true);
                    }
                  }}
                  placeholder="EAAG..."
                  disabled={disabled}
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => setShowToken((s) => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  tabIndex={-1}
                >
                  {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">{t('accessTokenHint')}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ig-verify-token">{t('verifyToken')}</Label>
              <Input
                id="ig-verify-token"
                value={verifyToken}
                onChange={(e) => {
                  setVerifyToken(e.target.value);
                  setVerifyTokenEdited(true);
                }}
                onFocus={() => {
                  if (!verifyTokenEdited && configured) {
                    setVerifyToken('');
                    setVerifyTokenEdited(true);
                  }
                }}
                placeholder={t('verifyTokenPlaceholder')}
                disabled={disabled}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">{t('verifyTokenHint')}</p>
            </div>

            <div className="space-y-2">
              <Label>{t('webhookUrl')}</Label>
              <div className="flex gap-2">
                <Input value={webhookUrl} readOnly className="flex-1 text-muted-foreground" />
                <Button type="button" variant="outline" onClick={handleCopyWebhook}>
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{t('webhookUrlHint')}</p>
            </div>
          </CardContent>
        </Card>

        <div className="flex items-center justify-between">
          {configured ? (
            <Button
              variant="ghost"
              onClick={handleRemove}
              disabled={!canEdit || removing}
              className="text-destructive hover:text-destructive"
            >
              {removing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
              {t('remove')}
            </Button>
          ) : (
            <span />
          )}
          <Button onClick={handleSave} disabled={disabled}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
            {t('save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
