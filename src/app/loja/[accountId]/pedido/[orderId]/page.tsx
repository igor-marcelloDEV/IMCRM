'use client';

// ============================================================
// /loja/[accountId]/pedido/[orderId] — order confirmation AND, once
// paid, payment receipt. Same page, state-dependent: this is
// deliberate (the user asked for both a "comprovante de pedido" and
// a "recibo de pagamento") rather than two pages, since the only
// thing that changes is which parts are shown.
//
// No PIX auto-polling websocket — a manual "Verificar pagamento"
// refetch is enough here: the customer either has the PIX app open
// right after paying (checks once, immediately sees "paid") or comes
// back to the link later (page already reflects current status on
// load). Matches the scope discipline used through the rest of the
// storefront: real value without new infrastructure.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { CheckCircle2, Clock, Copy, Loader2, RefreshCw, Store, XCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { formatCurrency } from '@/lib/currency';

interface OrderItemRow {
  id: string;
  name_snapshot: string;
  quantity: number;
  unit_price_cents: number;
  total_cents: number;
}
interface OrderData {
  order: {
    id: string;
    status: 'pending_payment' | 'paid' | 'canceled';
    subtotal_cents: number;
    total_cents: number;
    currency: string;
    pix_copy_paste: string | null;
    pix_expires_at: string | null;
    created_at: string;
    paid_at: string | null;
  };
  items: OrderItemRow[];
  account: { name: string; logo_url: string | null } | null;
}

export default function PublicOrderPage() {
  const t = useTranslations('PublicStore.order');
  const params = useParams<{ accountId: string; orderId: string }>();
  const { accountId, orderId } = params ?? {};

  const [data, setData] = useState<OrderData | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!accountId || !orderId) return;
    try {
      const res = await fetch(`/api/public/store/${accountId}/orders/${orderId}`, { cache: 'no-store' });
      if (!res.ok) {
        setNotFound(true);
        return;
      }
      setData(await res.json());
    } catch {
      setNotFound(true);
    }
  }, [accountId, orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const copyPix = useCallback(() => {
    if (!data?.order.pix_copy_paste) return;
    void navigator.clipboard.writeText(data.order.pix_copy_paste).then(() => toast.success(t('pixCopied')));
  }, [data, t]);

  if (notFound) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <p className="text-sm text-muted-foreground">{t('notFound')}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const { order, items, account } = data;
  const statusMeta = {
    paid: { icon: CheckCircle2, color: 'text-emerald-400', label: t('statusPaid') },
    pending_payment: { icon: Clock, color: 'text-amber-400', label: t('statusPending') },
    canceled: { icon: XCircle, color: 'text-red-400', label: t('statusCanceled') },
  }[order.status];
  const StatusIcon = statusMeta.icon;

  return (
    <div className="min-h-screen bg-background px-4 py-8">
      <div className="mx-auto max-w-md space-y-4">
        <div className="flex items-center gap-3">
          {account?.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={account.logo_url} alt={account.name ?? ''} className="h-10 w-10 rounded-lg object-cover" />
          ) : (
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <Store className="h-5 w-5 text-primary" />
            </div>
          )}
          <span className="text-sm font-medium text-foreground">{account?.name}</span>
        </div>

        <div className="rounded-lg border border-border bg-card p-5 text-center">
          <StatusIcon className={`mx-auto h-9 w-9 ${statusMeta.color}`} />
          <p className={`mt-2 text-base font-semibold ${statusMeta.color}`}>{statusMeta.label}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('orderRef', { id: order.id.slice(0, 8).toUpperCase() })}
          </p>
        </div>

        {order.status === 'pending_payment' && order.pix_copy_paste && (
          <div className="space-y-2 rounded-lg border border-border bg-card p-4">
            <p className="text-sm font-medium text-foreground">{t('pixTitle')}</p>
            <p className="text-xs text-muted-foreground">{t('pixHint')}</p>
            <div className="break-all rounded-md border border-dashed border-border bg-muted/50 p-2 font-mono text-[11px] text-foreground">
              {order.pix_copy_paste}
            </div>
            <Button variant="outline" size="sm" onClick={copyPix} className="w-full">
              <Copy className="mr-1 h-3.5 w-3.5" />
              {t('pixCopy')}
            </Button>
          </div>
        )}

        {order.status === 'pending_payment' && !order.pix_copy_paste && (
          <div className="rounded-lg border border-border bg-card p-4 text-center text-sm text-muted-foreground">
            {t('pendingManual')}
          </div>
        )}

        {order.status === 'pending_payment' && (
          <Button variant="outline" onClick={refresh} disabled={refreshing} className="w-full">
            {refreshing ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
            {t('checkPayment')}
          </Button>
        )}

        <div className="rounded-lg border border-border bg-card p-4">
          <p className="mb-2 text-sm font-medium text-foreground">{t('itemsTitle')}</p>
          <ul className="space-y-1.5">
            {items.map((line) => (
              <li key={line.id} className="flex items-center justify-between text-xs">
                <span className="text-foreground">
                  {line.quantity}x {line.name_snapshot}
                </span>
                <span className="text-muted-foreground">{formatCurrency(line.total_cents / 100, order.currency)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex items-center justify-between border-t border-border pt-2 text-sm font-semibold text-foreground">
            <span>{t('total')}</span>
            <span>{formatCurrency(order.total_cents / 100, order.currency)}</span>
          </div>
        </div>

        {order.status === 'paid' && order.paid_at && (
          <p className="text-center text-xs text-muted-foreground">
            {t('paidAt', { date: new Date(order.paid_at).toLocaleString() })}
          </p>
        )}
      </div>
    </div>
  );
}
